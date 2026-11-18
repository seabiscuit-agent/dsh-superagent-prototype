/** A Ticket's timeline: the Facts one Ticket left behind, each with the one line every reader shows. */
import { UserError, type Fact, type FactData, type Ticket } from '../../core/index.ts'
import type { Store } from '../store.ts'
import { preview } from './text.ts'

/** What a timeline read needs of the Store: the Ticket to check and its Facts to show. */
export interface TimelineStore {
  readonly tickets: Pick<Store['tickets'], 'get'>
  readonly read: Pick<Store['read'], 'facts'>
}
/** A backfill also writes, so it needs the append-only table and the transaction that keeps it with nothing else. */
export interface BackfillStore extends TimelineStore {
  readonly facts: Pick<Store['facts'], 'append'>
  readonly atomic: Store['atomic']
}

/** The most Facts one read returns; when older ones are dropped the reader is told through `truncated`. */
export const TIMELINE_LIMIT = 200

/** One row of a timeline: when it happened (`null` when the record never carried a time), what it was, and what it says. */
export interface TimelineRow { at: string | null; type: Fact['type']; summary: string; origin: Fact['origin'] }

/** The timeline of one Ticket, with the Ticket named so a reader can tell what it read. */
export interface TimelineView { ticket_id: string; facts: TimelineRow[]; truncated: boolean }

/** A field of a Fact's data as text; absent fields read as empty rather than as `undefined`. */
const field = (data: Fact['data'], name: string): string => {
  const value = data[name]
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
}

/**
 * What one Fact says in a line.
 * The summary is derived from the stored data alone, so a backfilled Fact reads like a recorded one.
 */
function summary(fact: Fact): string {
  const data = fact.data
  switch (fact.type) {
    case 'trigger.received': return `trigger received on ${field(data, 'threads') || 'no Thread'}`
    case 'eval.started': return `assessment of ${field(data, 'threadKey')} started (${field(data, 'strength')})`
    case 'decision.recorded': return `decision ${field(data, 'kind')} recorded on ${field(data, 'threadKey')}`
    case 'ticket.created': return `ticket created from decision ${field(data, 'decisionId')}`
    case 'ticket.resumed': return `ticket resumed by trigger ${field(data, 'triggerId')}`
    case 'ticket.ended': return [`ticket ended by ${field(data, 'by')}`, field(data, 'outcome'),
      field(data, 'reason') ? `reason: ${field(data, 'reason')}` : ''].filter(Boolean).join(', ')
    case 'assignment.started': return `assignment ${field(data, 'assignmentId')} started`
    case 'assignment.ended': return `assignment ${field(data, 'assignmentId')} ended: ${field(data, 'reason')}`
    case 'thread.subscribed': return `subscribed to ${field(data, 'threadKey')}`
    case 'thread.unsubscribed': return `unsubscribed from ${field(data, 'threadKey')} by ${field(data, 'by')}`
    case 'trigger.requeued': return `trigger ${field(data, 'triggerId')} queued for assessment again`
    case 'trigger.followup': return `follow-up trigger ${field(data, 'triggerId')} considered`
    case 'agenda.dropped': return `scheduled wake ${field(data, 'key')} dropped: ${field(data, 'reason')}`
    case 'dispatch.fast_path': return `fast path ${field(data, 'result')} for trigger ${field(data, 'triggerId')}`
    case 'question.answer-pending': return `question ${field(data, 'questionId')} answer pending until ${field(data, 'withdrawableUntil')}`
    case 'question.answered': return `question ${field(data, 'questionId')} answered by ${field(data, 'by')}`
    case 'question.corrected': return `question ${field(data, 'questionId')} answer corrected by ${field(data, 'by')}`
    case 'question.answer-ignored': return `question ${field(data, 'questionId')} answer not adopted: ${field(data, 'reason')}`
    case 'question.escalated': return `question ${field(data, 'questionId')} escalated: ${field(data, 'reason')}`
    case 'question.resolved': return `question ${field(data, 'questionId')} resolved`
    case 'question.withdrawn': return `question ${field(data, 'questionId')} withdrawn by ${field(data, 'by')}`
    case 'policy.changed': return `policy changed from ${field(data, 'from')} to ${field(data, 'to')}`
    case 'report.recorded': return `report ${field(data, 'state')}: ${preview(field(data, 'summary'))}`
    case 'receipt.queued': return `${field(data, 'kind')} message queued`
    case 'receipt.sent': return `${field(data, 'kind')} message sent`
    case 'receipt.dropped': return `${field(data, 'kind')} message dropped: ${field(data, 'reason')}`
    default: return JSON.stringify(data)
  }
}

/**
 * The timeline of one Ticket, oldest first.
 * A missing Ticket is a UserError, so every reader (resource, HTTP route and CLI) answers it the same way.
 * Reads one row past the limit to tell a full page from a truncated one, and keeps the newest rows, as the business tables do.
 */
export function ticketTimeline(host: { readonly store: TimelineStore }, ticketId: string): TimelineView {
  if (!host.store.tickets.get(ticketId)) throw new UserError('unknownTicket')
  const rows = host.store.read.facts(ticketId, TIMELINE_LIMIT)
  return { ticket_id: ticketId, facts: rows.facts
    .map(fact => ({ at: fact.at, type: fact.type, summary: summary(fact), origin: fact.origin })), truncated: rows.truncated }
}

/** The key a derived Fact is deduplicated by: its type plus the step of the Ticket it comes from. */
const derivedKey = (fact: Fact): string => `${fact.type}\u0000${String(fact.data.key ?? '')}`

/**
 * The Facts a Ticket's stored rows still imply, each named by the row it comes from.
 * Only what a business row still holds can be derived: a report that was overwritten, or a second subscription, is gone.
 */
function derived(ticket: Ticket): Fact[] {
  const facts: Fact[] = []
  const add = (type: Fact['type'], at: string | null, data: FactData): void => {
    facts.push({ ticket: ticket.id, at, type, data: { ...data, key: data.key ?? type }, origin: 'derived' })
  }
  add('ticket.created', ticket.createdAt, { decisionId: ticket.decisionId, strength: ticket.mandate.strength })
  for (const triggerId of ticket.origin.triggerIds) add('trigger.received', null, { triggerId, key: `trigger.received:${triggerId}` })
  for (const assignment of ticket.assignments) {
    add('assignment.started', assignment.startedAt ?? assignment.createdAt ?? null, { assignmentId: assignment.id,
      key: `assignment.started:${assignment.id}` })
    if (assignment.report) add('report.recorded', assignment.report.at ?? null, { state: assignment.report.state,
      summary: assignment.report.summary, key: `report.recorded:${assignment.id}` })
    if (assignment.endedAt) add('assignment.ended', assignment.endedAt, { assignmentId: assignment.id,
      reason: assignment.endedReason ?? '', key: `assignment.ended:${assignment.id}` })
  }
  for (const question of ticket.questions ?? []) {
    if (question.correctedAt) add('question.corrected', question.correctedAt, { questionId: question.id, by: 'person',
      key: `question.corrected:${question.id}` })
    if (question.committedAt) add('question.answered', question.committedAt, { questionId: question.id, by: question.answeredBy ?? '',
      key: `question.answered:${question.id}` })
    else if (question.answer !== undefined && question.withdrawableUntil)
      add('question.answer-pending', question.answeredAt ?? null, { questionId: question.id,
        withdrawableUntil: question.withdrawableUntil, key: `question.answer-pending:${question.id}` })
    else if (question.answeredAt && question.resolution === 'answered') add('question.answered', question.answeredAt, {
      questionId: question.id, by: question.answeredBy ?? '', key: `question.answered:${question.id}` })
    if (question.withdrawnAt && question.resolution !== 'withdrawn') add('question.withdrawn', question.withdrawnAt, {
      questionId: question.id, by: 'person', key: `question.withdrawn:${question.id}` })
    else if (question.resolution === 'withdrawn') add('question.withdrawn', question.resolvedAt ?? null, { questionId: question.id,
      by: 'ticket', key: `question.withdrawn:${question.id}` })
    else if (question.resolvedAt) add('question.resolved', question.resolvedAt, { questionId: question.id,
      key: `question.resolved:${question.id}` })
  }
  if (ticket.ended) add('ticket.ended', ticket.ended.at, { by: ticket.ended.by, outcome: ticket.ended.outcome,
    ...ticket.ended.reason ? { reason: ticket.ended.reason } : {} })
  return facts.sort((left, right) => (left.at ?? '').localeCompare(right.at ?? ''))
}

/**
 * Records the Facts a Ticket's stored rows still imply, once: a second backfill finds every key present and writes nothing.
 * A kind the Engine already recorded for the Ticket is never derived again, so a recorded chain gains no derived twin.
 * Facts already recorded are never overwritten or deleted, and a moment whose row carries no time keeps `at: null`.
 */
export function backfillTimeline(host: { readonly store: BackfillStore }, ticketId: string): TimelineView {
  const ticket = host.store.tickets.get(ticketId)
  if (!ticket) throw new UserError('unknownTicket')
  host.store.atomic(() => {
    const existing = host.store.read.facts(ticketId, Number.MAX_SAFE_INTEGER).facts
    const seen = new Set(existing.map(derivedKey))
    const recorded = new Set(existing.filter(fact => fact.origin === 'recorded').map(fact => fact.type))
    for (const fact of derived(ticket)) if (!recorded.has(fact.type) && !seen.has(derivedKey(fact))) host.store.facts.append(fact)
  })
  return ticketTimeline(host, ticketId)
}
