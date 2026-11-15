# Worker retries run in a fresh Session; every launch corrects the worker's model

2026-11-15 · ticket `398c52465dba`

## Root cause

Two defects in the harness's role-model handling of worker sessions:

1. One persistent `worker-<ticketId>` Session served every Assignment of a Ticket. A person's retry
   rejoined the same accumulated context — the exact failure mode behind the spawner 0.9.0 blow-up
   (worker session at ~850K tokens → 413 rejections). The owner decision of 2026-11-14 (fresh worker
   session per major batch) was not implemented for retries.
2. `initializeRoleModel` seeded a model only onto a brand-new session: once any `model/selection`
   event or `request/header` existed it returned, so a changed executor model never corrected an
   existing worker session. The local patch adding an `override` flag also read the selection from a
   non-existent top-level `event['selection']` field (the payload lives in `event.data`), which broke
   `tsc` and made the "already matches" check dead code.

## Fix

- `src/core/worker-session.ts` (new): `workerSessionId`, `freshWorkerSessionId(ticketId, index)`,
  `assignmentSessionId`, `ticketOfSession` (strips the `-<index>` suffix; ticket ids are 32-hex from
  `key()`, so the suffix is unambiguous). `src/executor/dsh.ts` re-exports the two it used to define.
- `Assignment.session?` (`src/core/model.ts`): recorded when a retry's Assignment runs in a fresh
  Session. `newAssignment` (`src/core/tickets.ts`) mints `worker-<ticketId>-<n>` (n = the new
  Assignment's index) when the previous Assignment ended `retried`; wake and host-restart copy the
  previous session; the first Assignment keeps the base id (field absent for legacy rows).
- Every consumer derives the session through `assignmentSessionId` (`src/executor/dsh.ts` launch,
  deliver, stop/stopWork, shutdown, running, resume, resumeAfter, workerIdle; `src/app/resources.ts`
  transcript/modelRetry/readResource binding; `src/app/views/*`; `src/app/runtime.ts` shutdown), and
  the executor's idle and error handlers ignore events from a Session the running Assignment no
  longer runs in.
- `src/app/role-models.ts`: read the existing selection from `event.data`, dedupe only the append
  (a matching selection still re-registers the seeding hooks), and `sessions.ensure` passes
  `override = role !== 'orchestrator'`: workers are corrected to the executor model on every launch,
  the orchestrator's manual selection stays untouched.

## Pitfalls

- Two `ModelSelection` declarations exist: the session-event payload's (plain `string` effort) and
  dsh-agent's (branded `ReasoningEffortId`); the read needs a cast to the seeded-selection type.
- `docs/007-architecture.md` has module and test tables that `tests/docs.spec.ts` verifies — new
  files must be added there.
- A replaced Assignment's late idle now drives nothing; tests that idle "the worker" after a retry
  must idle the fresh session (`worker-<id>-<n>`).

## Verification

```sh
pnpm typecheck && pnpm build
npx vitest run tests/worker-session.spec.ts tests/role-models.spec.ts tests/core-engine.spec.ts \
  tests/runtime.spec.ts tests/runtime-concurrency.spec.ts tests/docs.spec.ts
pnpm test   # 1202 passed, 2 failed — pre-existing GIT_CONFIG_GLOBAL env failures, also on clean HEAD
```
