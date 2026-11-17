/** The `agenda` effect handler: hands a due scheduled wake to its ticket, or keeps waiting while the ticket waits for a person. */
import type { EngineForMainSession } from '../core/index.ts'
import { Later, type EffectPayloads } from './effects.ts'

/**
 * Delivers a scheduled wake through `Engine.agenda` and turns the ticket's state into the queue's next step: a ticket
 * waiting for a person throws `Later` (retrying without counting a failure), while one that ended or vanished drops the row.
 */
export function agendaHandler(engine: Pick<EngineForMainSession, 'agenda'>) {
  return async ({ ticketId, key, reason, at }: EffectPayloads['agenda']): Promise<void> => {
    if (engine.agenda(ticketId, key, reason, at) === 'waiting') throw new Later()
  }
}
