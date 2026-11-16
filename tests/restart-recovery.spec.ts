import { describe, expect, it } from 'vitest'
import { cutTurn, markShutdownTurn, recoveryNote, RESTART_RECOVERY_NOTE, type RestartRecoveryStore } from '../src/app/restart-recovery.ts'
import { KV } from '../src/kv.ts'

/** A DSH session event as the classifier sees it: only the type and the data fields it reads. */
const turn = (type: 'turn/start' | 'turn/end', number: number, reason?: unknown) => ({ type, data: reason === undefined ? { turn: number } : { turn: number, reason } })
const interrupted = (number: number) => turn('turn/end', number, { kind: 'interrupted' })
const completed = (number: number) => turn('turn/end', number, { kind: 'completed' })
const aborted = (number: number, kind = 'user') => turn('turn/end', number, { kind: 'aborted', reason: { kind } })
/** In-memory stand-in for the `Store` KV surface. */
function memory(): RestartRecoveryStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return { values, get: <V>(name: string) => values.get(name) as V | undefined, set: <V>(name: string, value: V) => { values.set(name, value) },
    delete: (name: string) => { values.delete(name) } }
}
const shutdown = (number: number) => ({ session: 'orchestrator-test', turn: number })

describe('cutTurn', () => {
  it('resumes the turn a crash interrupted, with or without a stale shutdown marker', () => {
    expect(cutTurn([turn('turn/start', 7), interrupted(7)])).toBe(7)
    expect(cutTurn([turn('turn/start', 7), interrupted(7)], shutdown(3))).toBe(7)
  })
  it('resumes an aborted turn only when the graceful shutdown recorded that same turn', () => {
    expect(cutTurn([turn('turn/start', 9), aborted(9)], shutdown(9))).toBe(9)
    expect(cutTurn([turn('turn/start', 9), aborted(9)])).toBeUndefined()
    expect(cutTurn([turn('turn/start', 9), aborted(9)], shutdown(8))).toBeUndefined()
  })
  it('resumes a turn left open only when the graceful shutdown recorded that same turn', () => {
    expect(cutTurn([turn('turn/start', 12)], shutdown(12))).toBe(12)
    expect(cutTurn([turn('turn/start', 12)])).toBeUndefined()
  })
  it('never resumes a turn that completed, errored, or was never opened', () => {
    expect(cutTurn([turn('turn/start', 4), completed(4)], shutdown(4))).toBeUndefined()
    expect(cutTurn([turn('turn/start', 4), turn('turn/end', 4, { kind: 'error', error: { message: 'boom' } })])).toBeUndefined()
    expect(cutTurn([])).toBeUndefined()
    expect(cutTurn([{ type: 'user/message', data: { text: 'hello' } }])).toBeUndefined()
  })
  it('reads only the last closed turn, so an old interruption is not resumed after later work', () => {
    expect(cutTurn([turn('turn/start', 2), interrupted(2), turn('turn/start', 3), completed(3)])).toBeUndefined()
  })
})

describe('markShutdownTurn', () => {
  it('records the turn a graceful shutdown is about to abort', () => {
    const store = memory()
    markShutdownTurn(store, 'orchestrator-test', [turn('turn/start', 3), completed(3), turn('turn/start', 4)])
    expect(store.values.get(KV.runtime.shutdownTurn)).toEqual(shutdown(4))
  })
  it('writes nothing when the main Session is idle, so a person\'s stop is never resumed', () => {
    const store = memory()
    markShutdownTurn(store, 'orchestrator-test', [turn('turn/start', 3), aborted(3)])
    expect(store.values.has(KV.runtime.shutdownTurn)).toBe(false)
  })
})

describe('recoveryNote', () => {
  it('tells the main Session not to repeat outside actions and to tell the person what resumed', () => {
    expect(recoveryNote()).toBe(RESTART_RECOVERY_NOTE)
    expect(RESTART_RECOVERY_NOTE).toMatch(/host restarted during your previous turn/)
    expect(RESTART_RECOVERY_NOTE).toMatch(/Do not repeat an outside action/)
    expect(RESTART_RECOVERY_NOTE).toMatch(/tell the person/)
  })
})
