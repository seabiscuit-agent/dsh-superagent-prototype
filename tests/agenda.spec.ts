/** Scheduled wakes: a ticket gets one automatic agenda Input at its time, never before, and never a second one. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effects, agendaKey } from '../src/app/effects.ts'
import { agendaHandler } from '../src/app/agenda.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'

let directory: string
let store: Store
let effects: Effects
let clock: number
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agenda-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-11-17T00:00:00Z')
  effects = new Effects(store, new HealthBoard(), () => clock)
  effects.start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const wake = (key: string, at: string, ticketId = 't1', reason = 'look again') =>
  ({ ticketId, key, reason, at })
const schedule = (key: string, at: string, ticketId = 't1', reason = 'look again'): void => {
  effects.enqueue('agenda', agendaKey(ticketId, key), wake(key, at, ticketId, reason), at)
}
/** The handler's own contract: it hands the wake to the Engine, which records an Input; this fake counts the calls. */
const engine = () => {
  const calls: string[] = []
  const agenda = vi.fn((ticketId: string): 'delivered' | 'waiting' | 'ended' | 'missing' => { calls.push(ticketId); return 'delivered' })
  return { calls, agenda }
}
describe('scheduled wakes', () => {
  it('does not run before its time, runs exactly once at it, and leaves no row for a second scan', async () => {
    const h = engine()
    effects.handle('agenda', agendaHandler(h))
    schedule('ci', new Date(clock + 60_000).toISOString())
    await effects.idle()
    expect(h.agenda).not.toHaveBeenCalled()
    clock += 60_000
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
    await effects.idle()
    expect(effects.agendaRows('t1')).toEqual([])
    effects.kick(); await effects.idle()
    expect(h.agenda).toHaveBeenCalledTimes(1)
  })
  it('keeps one row when the same ticket and key are scheduled again, and the old time never fires', async () => {
    const h = engine()
    effects.handle('agenda', agendaHandler(h))
    schedule('ci', new Date(clock + 60_000).toISOString(), 't1', 'first')
    schedule('ci', new Date(clock + 120_000).toISOString(), 't1', 'second')
    expect(effects.agendaRows('t1')).toEqual([{ key: 'ci', at: new Date(clock + 120_000).toISOString(), reason: 'second' }])
    clock += 60_000
    effects.kick(); await effects.idle()
    expect(h.agenda).not.toHaveBeenCalled()
    clock += 60_000
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
  })
  it('fires once after the store is closed and reopened past its due time', async () => {
    const due = new Date(clock + 60_000).toISOString()
    schedule('ci', due)
    await effects.drain()
    store.close()
    store = new Store(join(directory, 'db.sqlite'))
    clock += 60_000
    effects = new Effects(store, new HealthBoard(), () => clock)
    effects.start()
    const h = engine()
    effects.handle('agenda', agendaHandler(h))
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
    await effects.idle()
    expect(effects.agendaRows('t1')).toEqual([])
  })
  it('delivers nothing while paused and only once after the pause lifts', async () => {
    let paused = true
    const h = engine()
    effects.handle('agenda', agendaHandler(h), { limit: () => paused ? 0 : 4 })
    schedule('ci', new Date(clock + 1_000).toISOString())
    clock += 1_000
    effects.kick(); await effects.idle()
    expect(h.agenda).not.toHaveBeenCalled()
    paused = false
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
    await effects.idle()
    expect(effects.agendaRows('t1')).toEqual([])
  })
  it('waits while the ticket waits for a person, then delivers once their message arrives', async () => {
    let waiting = true
    const h = engine()
    h.agenda.mockImplementation(() => waiting ? 'waiting' : 'delivered')
    effects.handle('agenda', agendaHandler(h))
    schedule('ci', new Date(clock + 1_000).toISOString())
    clock += 1_000
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
    // The ticket's answer arrives and the retry after `Later` delivers the wake.
    waiting = false
    clock += 2_000
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(2))
    await effects.idle()
    expect(effects.agendaRows('t1')).toEqual([])
  })
  it('cancels a wake, and drops one whose ticket no longer exists without retrying it', async () => {
    const h = engine()
    h.agenda.mockReturnValue('missing')
    effects.handle('agenda', agendaHandler(h))
    schedule('cancelled', new Date(clock + 1_000).toISOString())
    effects.cancel('agenda', agendaKey('t1', 'cancelled'))
    schedule('gone', new Date(clock + 1_000).toISOString())
    clock += 1_000
    effects.kick()
    await vi.waitFor(() => expect(h.agenda).toHaveBeenCalledTimes(1))
    await effects.idle()
    expect(effects.agendaRows('t1')).toEqual([])
  })
})
