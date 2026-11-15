import { describe, expect, it } from 'vitest'
import { assignmentSessionId, freshWorkerSessionId, ticketOfSession, workerSessionId } from '../src/core/worker-session.ts'

describe('worker session ids', () => {
  it('keeps one base Session per ticket and mints a fresh one for each Assignment a retry launched', () => {
    expect(workerSessionId('a'.repeat(32))).toBe(`worker-${'a'.repeat(32)}`)
    expect(freshWorkerSessionId('a'.repeat(32), 1)).toBe(`worker-${'a'.repeat(32)}-1`)
    expect(freshWorkerSessionId('a'.repeat(32), 12)).toBe(`worker-${'a'.repeat(32)}-12`)
  })
  it("runs an Assignment in the Session it records, defaulting to the ticket's base one", () => {
    expect(assignmentSessionId('t', undefined)).toBe('worker-t')
    expect(assignmentSessionId('t', {})).toBe('worker-t')
    expect(assignmentSessionId('t', { session: 'worker-t-1' })).toBe('worker-t-1')
  })
  it('maps a worker Session back to its ticket, whatever Assignment ran in it', () => {
    const hex = '0123456789abcdef0123456789abcdef'
    expect(ticketOfSession(`worker-${hex}`)).toBe(hex)
    expect(ticketOfSession(`worker-${hex}-1`)).toBe(hex)
    expect(ticketOfSession(`worker-${hex}-12`)).toBe(hex)
    expect(ticketOfSession('master')).toBeUndefined()
    expect(ticketOfSession('worker-')).toBeUndefined()
  })
})
