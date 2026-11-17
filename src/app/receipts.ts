/**
 * Host-owned reply receipts: the visible body of an `orchestrator_reply` is composed and checked here, not written freely by
 * the model. A result comes from the ticket's own report, attention from its stored Question, and only an answer keeps text
 * the model wrote, after the checks below. Deterministic receipt ids make a repeated call a no-op.
 */
import { createHash } from 'node:crypto'
import type { Question, Ticket, Trigger, WorkerReport } from '../core/index.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { INTERNAL, SILENT } from './turn-guard.ts'

/** Why the host refuses to send a receipt body; the tool returns it as a correctable error and queues nothing. */
export type Rejection = 'emptyBody' | 'silentBody' | 'internalPayload' | 'tooLong' | 'missingQuestion' | 'duplicate' | 'notReady'
/** The hidden markers the panel drops and no visible message may carry. */
const LEAK = [...INTERNAL, /\bdsh-superagent:local-receipt:/u]
/** Readable labels for a report state; the summary and PR link follow. */
const LABELS: Record<WorkerReport['state'], string> = { progress: 'In progress', waiting: 'Waiting', ready: 'Ready for review',
  blocked: 'Blocked', failed: 'Failed', dropped: 'Dropped' }
/** The one-sentence result of a completed ticket. */
const OUTCOME_LABELS: Record<string, string> = { completed: 'Completed', merged: 'Merged', dropped: 'Dropped' }

/** Whether a body is one the panel would drop or that leaks an internal payload. */
export function rejectedBody(text: string): Rejection | undefined {
  const body = text.trim()
  if (!body) return 'emptyBody'
  if (SILENT.test(body)) return 'silentBody'
  if (LEAK.some(pattern => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`).test(body))) return 'internalPayload'
  return undefined
}

/** Removes internal markers from a summary the host reuses, rather than refusing to deliver the report at all. */
export function clean(text: string): string {
  // Drop a whole small JSON object that leaked a ticket id, not only its opening marker.
  let body = text.replace(/\{\s*"ticket_id"\s*:[^{}]*\}/gu, '')
  for (const pattern of LEAK) body = body.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '')
  return body.replace(/\s+/gu, ' ').trim()
}

/** Trims text to a character budget at a word boundary, with an ellipsis when it was cut. */
function limit(text: string, chars: number): string {
  if (text.length <= chars) return text
  const cut = text.slice(0, chars)
  return `${cut.replace(/\s+\S*$/u, '')}…`
}

/** The last at most two sentences of a note, which is all a result note may add. */
export function noteText(note: string): string {
  const sentences = clean(note).split(/(?<=[.!?。！？])\s*/u).filter(Boolean).slice(0, 2).join(' ')
  return limit(sentences, 240)
}

/**
 * Composes the visible result of a ticket from its latest report, an optional short note and the PR link; model text is never
 * needed for the body itself. The whole message respects the IM word limit by trimming the summary first.
 */
export function renderResult(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary'>, note?: string, pull?: string): string {
  const label = OUTCOME_LABELS[ticket.ended?.outcome ?? ''] ?? LABELS[report.state]
  const cleanNote = note ? noteText(note) : ''
  const summary = clean(report.summary)
  const tail = [pull ? `PR: ${pull}` : '', cleanNote].filter(Boolean).join('\n')
  const compose = (body: string) => [`**${label}**`, body, tail].filter(Boolean).join('\n')
  let body = limit(summary, 500)
  let text = compose(body)
  // Trim the summary, not the state or the PR link, until the message fits one IM delivery.
  while (wordCount(text) > IM_WORDS && body.length > 40) {
    body = limit(body, Math.max(40, Math.floor(body.length * 0.75)))
    text = compose(body)
  }
  if (wordCount(text) > IM_WORDS) text = compose('')
  return text
}

/** The deterministic id of each receipt purpose; a repeated call with the same payload reuses the first receipt. */
export function receiptId(purpose: 'result' | 'attention' | 'answer', payload: { ticketId?: string; reportAt?: string
  questionId?: string; triggerId?: string; text?: string }): string {
  if (purpose === 'result') return `result:${payload.ticketId ?? ''}:${payload.reportAt ?? ''}`
  if (purpose === 'attention') return `attention-reply:${payload.questionId ?? ''}`
  return `reply:${payload.triggerId ?? ''}:${createHash('sha1').update(payload.text ?? '').digest('hex')}`
}

/** Checks the free text of an answer: non-empty, not a hidden closer, no internal payload, within the IM limit, and about a person's question. */
export function validateAnswer(text: string, trigger: Trigger | undefined): Rejection | undefined {
  const body = rejectedBody(text)
  if (body) return body
  if (typeof trigger === 'undefined' || !trigger.human) return 'missingQuestion'
  if (wordCount(text) > IM_WORDS) return 'tooLong'
  return undefined
}

/** Whether a question is still open and addressed to a person. */
export const openPerson = (question: Question): boolean => question.to === 'person' && question.resolution === undefined
