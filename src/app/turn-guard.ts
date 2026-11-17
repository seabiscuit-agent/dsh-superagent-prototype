/**
 * Keeps a main-Session turn from closing with nothing the owner can see when a worker report or question reached it.
 * A delivered receipt counts as the owner-facing message; visible text written by the model counts too.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { messageId } from './delivery.ts'

/** The hidden closers the panel's chat view drops: a step made only of one gives the owner nothing. */
const SILENT = /^(?:NO[_-]?REPLY|END[_-]?OF[_-]?TURN|END[_-]?OF[_-]?RESPONSE|SILENT)$/i
/** The internal payloads the panel's chat view drops, which likewise give the owner nothing. */
const INTERNAL = [/[|｜]{2}\s*DSML\s*[|｜]{2}/u,
  /"kind"\s*:\s*"(?:worker_report|worker\.report|follow_up|follow\.up|candidate|worker_attention|worker\.attention)"/u,
  /\{\s*"ticket_id"\s*:/u]
/** The message id of the receipt the host renders for a delivered reply; it is the owner-facing message of that reply. */
const RECEIPT = 'dsh-superagent:local-receipt:'
/** What the guard tells a main Session whose turn would end silently after a worker report or question reached it. */
export const TURN_CHECK_TEXT = 'Turn check, from the host: a worker report or question reached you in this turn and you are about to close it '
  + 'with nothing the owner can see. Tell the owner now, in one short line, where things stand and who does what next, or ask the question '
  + 'they must answer (orchestrator_reply purpose=attention when it belongs to a ticket). If the report needs no owner-visible answer, say '
  + 'in one line what you did with it. Never close such a turn silently, and never write NO_REPLY.'
/** What a turn's events show the owner got, and whether it owed them anything. */
export interface TurnView {
  /** A worker report or worker question reached the Session during the turn, so the owner is owed a word. */
  readonly owed: boolean
  /** The owner got something: visible assistant text or a rendered receipt. */
  readonly addressed: boolean
  /** The turn was already nudged once, so a still-silent turn is left alone instead of looping. */
  readonly nudged: boolean
}
/** Host dependencies used by `TurnGuard`. */
export interface TurnGuardHost {
  /** DSH Cordis context whose `agent/turn-stopping` the guard watches. */
  readonly context: Context
  /** The main Session whose turns must not end silently after a report. */
  readonly masterId: string
}
/** A message's content blocks, which is all a user or assistant message exposes here. */
type Content = UserMessage['content']
/** The text of a message's text blocks, joined so the panel's own step filter can be applied. */
function textOf(content: Content): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
/** Whether a message shows the owner readable text, that is, text the panel's chat view does not drop as an internal payload. */
function visible(content: Content): boolean {
  const text = textOf(content).trim()
  return text.length > 0 && !SILENT.test(text) && !INTERNAL.some(pattern => pattern.test(text))
}
/** The relay kind a message carries, when it is one of this plugin's relay messages. */
function relayKind(message: UserMessage): string | undefined {
  if (message.source.kind !== 'dsh-superagent' || message.source.form !== 'relay') return undefined
  try {
    const payload: unknown = JSON.parse(textOf(message.content))
    return payload && typeof payload === 'object' && 'kind' in payload && typeof payload.kind === 'string' ? payload.kind : undefined
  } catch { return undefined }
}

/**
 * Reads the turn's own events, from its `turn/start` to the next turn boundary: whether a worker report or question reached it,
 * whether the owner got visible text or a receipt, and whether the guard already nudged it.
 */
export function inspectTurn(events: readonly SessionEvent[], turn: number): TurnView {
  const view = { owed: false, addressed: false, nudged: false }
  let start = -1
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start' && (event.data as { turn: number }).turn === turn) { start = index; break }
  }
  if (start < 0) return view
  const nudgeId = messageId(`turn-check:${turn}`)
  let end = events.length
  for (let index = start + 1; index < events.length; index++) {
    if (events[index]!.type === 'turn/end' || events[index]!.type === 'turn/start') { end = index; break }
  }
  for (const event of events.slice(start, end)) {
    if (event.type === 'assistant/message') {
      if (visible((event.data as { message: { content: Content } }).message.content)) view.addressed = true
    } else if (event.type === 'user/message') {
      const message = event.data as UserMessage
      if (message.id.startsWith(RECEIPT)) view.addressed = true
      else if (message.id === nudgeId) view.nudged = true
      else {
        const kind = relayKind(message)
        if (kind === 'worker_report' || kind === 'worker_attention') view.owed = true
      }
    }
  }
  return view
}

/** Nudges a main-Session turn that would end with nothing the owner can see after a worker report or question reached it. */
export class TurnGuard {
  constructor(private readonly host: TurnGuardHost) {}
  /** Starts watching `agent/turn-stopping`; call once at startup. */
  install(): void {
    this.host.context.on('agent/turn-stopping', ({ agent, turn }) => { this.check(agent, turn) })
  }
  /** Steers the guard's one message into `agent`'s turn when that turn owes the owner a word and shows them nothing. */
  private check(agent: Agent, turn: number): void {
    if (agent.id !== this.host.masterId) return
    const view = inspectTurn(agent.session.snapshotEvents(), turn)
    if (!view.owed || view.addressed || view.nudged) return
    agent.steer(freezeMessage({ id: messageId(`turn-check:${turn}`), role: 'user',
      content: [{ type: 'text', text: TURN_CHECK_TEXT }], source: { kind: 'dsh-superagent', form: 'relay' } }))
  }
}
