/** Worker Session identity: the Session a Ticket's worker runs in, fresh for each of a person's retries. */

/** The worker Session a Ticket's Assignments run in (`worker-<ticketId>`) unless a retry launched a fresh one. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`

/**
 * The fresh worker Session a person's retry launches the Assignment with `index` into, so the retry works from the
 * workspace instead of the worker's accumulated Session context. Ticket ids are 32-hex (see `key`), so the `-index`
 * suffix cannot collide with another Ticket's id.
 */
export const freshWorkerSessionId = (ticketId: string, index: number): string => `${workerSessionId(ticketId)}-${index}`

/**
 * The worker Session an Assignment runs in: the fresh Session a person's retry launched it into, recorded when it
 * differs from the Ticket's base worker Session, or else that base Session. Assignments from before the field existed
 * have none and ran in the base Session.
 */
export const assignmentSessionId = (ticketId: string, assignment: { session?: string } | undefined): string =>
  assignment?.session ?? workerSessionId(ticketId)

/** Returns the ticket ID for a worker Session ID, base or retry-fresh, or undefined for non-worker Sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => {
  if (!sessionId.startsWith('worker-')) return undefined
  const rest = sessionId.slice('worker-'.length).replace(/-\d+$/, '')
  return rest.length > 0 ? rest : undefined
}
