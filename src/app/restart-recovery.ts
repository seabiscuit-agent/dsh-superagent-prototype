/**
 * Recognizes the main-Session turn a host restart cut off, and builds the note that resumes it.
 * A crash leaves DSH's `turn/end` `{kind: "interrupted"}` behind; a graceful shutdown records the turn it is about to abort in
 * KV first, so a turn a person stopped on purpose is never resumed as if the restart had cut it.
 */
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'

/** Structural subset of a DSH session event: the restart recovery reads turn opening, closing and abort reasons. */
export interface RestartTurnEvent {
  readonly type: string
  readonly data?: unknown
}

/** The main-Session turn a graceful shutdown is about to abort, written before the cancel so the next boot can tell it from a person's stop. */
export interface ShutdownTurn {
  readonly session: string
  readonly turn: number
}

/** KV surface the restart recovery needs; `Store` implements it. */
export interface RestartRecoveryStore {
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  delete(name: string): void
}

/** What the main Session is told when its previous turn was cut off by a restart. */
export const RESTART_RECOVERY_NOTE = 'The host restarted during your previous turn, so that turn stopped mid-step and the result of its last step is unknown. '
  + 'Before acting, check the current state: open Tickets with their latest Reports, pending Replies, and what already reached a person or a repository. '
  + 'Do not repeat an outside action that may already have happened. Then continue that turn, and tell the person it was for, in one line, what resumed.'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The non-negative integer turn a `turn/start` or `turn/end` event belongs to, if the event names one. */
const turnOf = (event: RestartTurnEvent): number | undefined => {
  const turn = record(event.data)?.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

/** The last turn a session closed, or undefined when no `turn/end` names a turn. */
function lastTurnEnd(events: readonly RestartTurnEvent[]): { turn: number; reason: Record<string, unknown> } | undefined {
  let ended: { turn: number; reason: Record<string, unknown> } | undefined
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const turn = turnOf(event)
    if (turn !== undefined) ended = { turn, reason: record(record(event.data)?.reason) ?? {} }
  }
  return ended
}

/** The turn a session opened without closing, or undefined when every opened turn was closed (or none was opened). */
function openTurn(events: readonly RestartTurnEvent[]): number | undefined {
  let open: number | undefined
  for (const event of events) {
    const turn = turnOf(event)
    if (turn === undefined) continue
    if (event.type === 'turn/start') open = turn
    else if (event.type === 'turn/end' && open === turn) open = undefined
  }
  return open
}

/**
 * Returns the turn a restart cut off, or undefined when the session ended cleanly or the turn was abandoned on purpose.
 * `interrupted` is only produced by a crash or hard kill; `aborted` also happens when a person presses stop, so it counts
 * only when the same turn is the one a graceful shutdown recorded just before cancelling it, and an unclosed turn counts
 * only under the same record because DSH normally closes it while loading.
 */
export function cutTurn(events: readonly RestartTurnEvent[], shutdown?: ShutdownTurn): number | undefined {
  const open = openTurn(events)
  if (open !== undefined && shutdown?.turn === open) return open
  const ended = lastTurnEnd(events)
  if (!ended) return undefined
  if (ended.reason.kind === 'interrupted') return ended.turn
  if (ended.reason.kind === 'aborted' && shutdown?.turn === ended.turn) return ended.turn
  return undefined
}

/**
 * Records the main-Session turn a graceful shutdown is about to abort, so the next boot resumes it exactly once.
 * An idle main Session writes nothing: its turn already ended, normally or by a person's stop, and neither is resumed.
 */
export function markShutdownTurn(store: RestartRecoveryStore, session: string, events: readonly RestartTurnEvent[]): void {
  const open = openTurn(events)
  if (open === undefined) return
  store.set(KV.runtime.shutdownTurn, { session, turn: open })
}

/** The note that resumes the cut-off turn. */
export const recoveryNote = (): string => RESTART_RECOVERY_NOTE
