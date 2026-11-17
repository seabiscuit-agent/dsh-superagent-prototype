/** The delayed instance restart: it waits for the workers, applies once when they are idle, and can be withdrawn. */
import { expect, it } from 'vitest'
import { RESTART_CHECK_MS, RestartQueue, type RestartQueueHost } from '../src/app/restart-queue.ts'

function harness(input: { running?: number; queued?: number; fail?: boolean } = {}) {
  let running = input.running ?? 0
  let queued = input.queued ?? 0
  let fail = input.fail ?? false
  const applied: string[] = []
  const logged: string[] = []
  const timers = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 1
  const queue = new RestartQueue({
    load: () => ({ running, queued }),
    apply: async pending => {
      if (fail) throw new Error('panel unavailable')
      applied.push(pending.reason)
    },
    schedule: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { run, ms })
      return () => { timers.delete(id) }
    },
    now: () => 1_000,
    log: message => { logged.push(message) },
  } satisfies RestartQueueHost)
  /** Runs every armed timer once and lets the apply promise settle. */
  const tick = async () => {
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.run() }
    await Promise.resolve()
    await Promise.resolve()
  }
  return { queue, applied, logged, timers, tick,
    load: (load: { running?: number; queued?: number }) => { running = load.running ?? running; queued = load.queued ?? queued },
    failing: (value: boolean) => { fail = value } }
}

it('restarts at once when no worker runs or waits', async () => {
  const h = harness()
  expect(await h.queue.request({ reason: 'settings change' })).toEqual({ restarting: true, deferred: false, running: 0, queued: 0 })
  expect(h.applied).toEqual(['settings change'])
  expect(h.timers.size).toBe(0)
})

it('waits while a worker runs, keeps its reason, and restarts once the worker finishes', async () => {
  const h = harness({ running: 1 })
  expect(await h.queue.request({ reason: 'after the fix lands' })).toEqual({ restarting: false, deferred: true, running: 1, queued: 0, pending_since: 1_000 })
  expect(h.applied).toEqual([])
  expect([...h.timers.values()].map(timer => timer.ms)).toEqual([RESTART_CHECK_MS])
  await h.tick()
  expect(h.applied).toEqual([])
  expect(h.queue.status()).toMatchObject({ pending: { reason: 'after the fix lands' }, applying: false })
  h.load({ running: 0 })
  await h.tick()
  expect(h.applied).toEqual(['after the fix lands'])
  expect(h.queue.status().pending).toBeUndefined()
})

it('waits while a ticket waits for a worker slot', async () => {
  const h = harness({ queued: 1 })
  expect(await h.queue.request()).toMatchObject({ deferred: true, queued: 1 })
  h.load({ queued: 0 })
  await h.tick()
  expect(h.applied).toEqual([''])
})

it('keeps one pending request: a second ask changes nothing, and cancel withdraws it', async () => {
  const h = harness({ running: 1 })
  await h.queue.request({ reason: 'first' })
  expect(await h.queue.request({ reason: 'second' })).toMatchObject({ deferred: true, already: true, running: 1 })
  expect(h.timers.size).toBe(1)
  expect(h.queue.cancel()).toEqual({ cancelled: true })
  expect(h.timers.size).toBe(0)
  expect(h.queue.cancel()).toEqual({ cancelled: false })
  h.load({ running: 0 })
  expect(h.applied).toEqual([])
})

it('retries a failed apply while idle instead of losing the request', async () => {
  const h = harness({ running: 1, fail: true })
  await h.queue.request({ reason: 'panel down' })
  h.load({ running: 0 })
  await h.tick()
  expect(h.applied).toEqual([])
  expect(h.logged).toHaveLength(1)
  expect(h.logged[0]).toContain('panel unavailable')
  expect(h.queue.status().pending).toBeDefined()
  expect(h.timers.size).toBe(1)
  h.failing(false)
  await h.tick()
  expect(h.applied).toEqual(['panel down'])
})

it('does not start a second restart while one is in flight', async () => {
  let release!: () => void
  const applied: string[] = []
  const queue = new RestartQueue({
    load: () => ({ running: 0, queued: 0 }),
    apply: async pending => { applied.push(pending.reason); await new Promise<void>(resolve => { release = resolve }) },
    schedule: () => () => {},
    now: () => 1,
    log: () => {},
  } satisfies RestartQueueHost)
  const first = queue.request({ reason: 'first' })
  expect(await queue.request({ reason: 'second' })).toEqual({ restarting: false, deferred: false, already: true, running: 0, queued: 0 })
  release()
  expect(await first).toEqual({ restarting: true, deferred: false, running: 0, queued: 0 })
  expect(applied).toEqual(['first'])
})
