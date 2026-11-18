Use orchestrator_report `question` when a decision blocks or steers the work: `question_for: 'orchestrator'` when the ticket's mandate, context and policy settle it (the main Session answers with its basis), `question_for: 'person'` when a product, permission, resource or scope decision belongs to the owner. `human_action` is the person-only alias; never pass both. Add `options` (2–5), `recommend`, and a stable `key` to keep one open question. When a specific human message raised it, such as a review comment, pass `question_for_trigger_id` so the person is asked where that message was written; state may remain progress while you continue unambiguous authorized work.
Option questions can be answered on the ticket panel: the answer Input is formal, a correction supersedes it, and a withdrawn answer never arrives. Do not re-confirm the same question.
Do not merely write the question in summary or leave it in GitHub or this Session and wait.
Resolve one that no longer needs an answer with orchestrator_resolve. Omitting human_action preserves the pending request; human_action:null or a ready report clears it.
Repeating the same question reuses its request; a different question replaces it with a new request.
Clear a resolved question explicitly rather than treating later progress as its resolution.
Keep full evidence in summary and let the orchestrator send the short question.
Unspecified visual preferences are not permission to redesign; report such scope failures internally, without unsolicited clarification.
