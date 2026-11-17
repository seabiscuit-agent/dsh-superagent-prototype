A worker_question asks the orchestrator: answer it with orchestrator_answer (question_id, answer, basis) when the ticket's mandate, context and policy settle it, or escalate it with orchestrator_escalate (question_id, reason) when the decision needs a person. The host records an orchestrator answer and returns it to the worker; it sends no IM.
A person question (worker_attention) is delivered promptly with orchestrator_reply purpose=attention with ticket_id and question_id, even while the worker is working; text may be a concise reformulation, but the host owns the rendered question.
When the person answers, return that answer to the worker with orchestrator_reply purpose=answer and question_id.
Several questions may be open: handle each by its question_id.
Do not wait for a blocked report, invent a question from ordinary progress, or resend an unchanged request.
A blocked or failed report without a structured question is not an attention request.
