# Orchestrator consult: one question model, two targets

## Root cause
A Ticket had a single `attention` slot and only a person could be asked. Every worker question became an IM
attention, the main Session could not answer one itself or escalate with context, and no path wrote a person's
answer back to the worker's Inputs.

## Implementation
- `Ticket.questions: Question[]` (`id, key?, from:'worker', to:'orchestrator'|'person', question, options?,
  recommend?, blocking, context?, triggerId?, assignmentId?, answer?, answeredBy?, answeredAt?, basis?,
  escalation?, resolution?:'answered'|'resolved'|'withdrawn', resolvedAt?, createdAt`). `Ticket.attention` is
  gone; `migrateQuestions` maps a legacy attention on read, keeping its id so `attention-reply:<id>` still matches.
- `assignments.report`: `question_for` defaults to person; `state=blocked` makes the question blocking; an open
  question with the same `key` updates in place; `question:null` withdraws this assignment's open questions; a
  `ready` report withdraws them. Options 2-5, recommend within options, key `[a-z0-9][a-z0-9_-]{0,63}`.
- Answer: `Engine.answerQuestion` validates open/to orchestrator/non-empty answer+basis, marks answered, adds the
  `answer` Input `question-answer:<id>` (not automatic, so it passes the blocking filter), emits
  `question.answered`; no outbox and no IM. `orchestrator_answer` is main-Session only.
- Escalate: `Engine.escalate` flips `to:'person'`, records the reason and emits `question.escalated`; the main
  tool renders the attention (`src/app/render.ts`) and sends it with `orchestrator_reply purpose=attention`.
- Person answer: `replies.answer` selects the open person question, the outbox receipt carries `questionId`, and
  the Outbox `answered` callback (after settle `sent`) calls `Engine.personAnswered` (idempotent) to add the
  answer Input. A failed send leaves the question open.
- Resolve: worker-only `orchestrator_resolve(question_id)`; only the asking assignment; answered cannot resolve.
- Stage: blocking person question -> `person/answer`, blocking orchestrator question -> `orchestrator/answer`,
  person first. Cards, ticket detail, panel and `orchestrator_read` show questions and answers.

## Deliberate deviation
The spec text says the person's answer is written back after a `purpose=attention` send. Attention text is the
question, not the answer, so the host writes back after the person's reply is sent with `purpose=answer`; the
question is resolved only then. Disclose this in the PR.

## Pitfalls found
- A person answering a worker's question is not taking up a question of their own: `replies.answer` must accept
  it without `ticket.answers` (`!!answering`).
- `reportRelay` must relay only the question the current report names; otherwise a progress relay carries a
  stale question and `worker_attention` fires again.
- Only blocking questions change the stage; an advisory progress question stays visible in the panel but the
  ticket keeps working.
- `orchestrator_resolve` belongs in the worker prompt only; adding it to the main prompt fails model-surface.
- Adding tools raised the prompt budget; `tests/model-surface.spec.ts` BUDGET is 66_000/43_000 intentionally.

## Verification
- `env -u GIT_CONFIG_GLOBAL pnpm vitest run tests/core-engine.spec.ts tests/migration.spec.ts tests/runtime.spec.ts`
  (242 tests) and the full suite.
- `pnpm check`, `openspec validate --all --strict`.
- Production smoke on `:3082` (answer, escalate + person answer, legacy attention reply) is not done if the
  change ships without it; record that honestly in the PR.
