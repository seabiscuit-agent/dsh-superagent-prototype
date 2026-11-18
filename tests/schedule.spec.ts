import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Thread, type Trigger } from '../src/core/index.ts'
import { apply as applySchedule, scheduleKind, scheduleTrigger, scheduleTriggerId, type JobRow, type ScheduleConfig }
  from '../src/sources/schedule.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = '2026-11-18T00:00:30.000Z'
const job = (overrides: Partial<JobRow> = {}): JobRow => ({ key: 'morning', cron: '* * * * *', timezone: 'UTC',
  title: 'Morning', text: 'Say good morning', enabled: 'true', ...overrides })
const clock = (at: string) => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: Date.parse(at) })
const thread = (): Thread => ({ key: 'schedule:morning', ref: { source: 'schedule', id: 'morning' }, createdAt: '',
  subscriptions: [], correlated: [], pending: [], meta: {} })

/**
 * A Store with this Source configured and the real Engine behind it, so a Trigger reaches intake, the gate and a Decision.
 * Starting runs the plugin's effects the way Cordis does, on a registry of their own, and health is read from that run.
 */
function harness(options: { config?: ScheduleConfig; enabled?: boolean; policy?: Record<string, unknown>; eval?: Record<string, unknown> } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'schedule-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: options.policy ?? {}, eval: options.eval ?? { mode: 'observe' },
    sources: { schedule: { enabled: options.enabled ?? true, config: options.config ?? { jobs: [] } } } }))
  // The Engine judges Triggers against this registry, which answers scope, policy and settings questions.
  const board = new HealthBoard()
  // apply() registers the kind, so a started run owns the registration and disposing it releases the kind again.
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  // The watch loop hands a Trigger over synchronously, so intake and the pass that judges it finish before the cursor moves.
  const receive = (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result }
  let paused = false
  const base: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, paused: () => paused, receive }
  const health = () => board.all['schedule']
  const start = (overrides: Partial<SourceContextDeps> = {}) => {
    const parts: SourceContextDeps = { ...base, ...overrides }
    const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
    const disposers: (() => unknown)[] = []
    applySchedule({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    return async () => { for (const dispose of disposers) await dispose() }
  }
  return { ...base, store, engine, sources, board, assessor, receive, start, health, setPaused: (next: boolean) => { paused = next } }
}
const triggers = (h: ReturnType<typeof harness>) => h.store.read.recentTriggers().filter(trigger => trigger.source === 'schedule')
const cursor = (h: ReturnType<typeof harness>, job: string) => h.store.get(KV.schedule.cursor(job))
const ready = async (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.health()).toMatchObject({ state: 'ready' }))

describe('schedule source', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('fires one Trigger per due instant of every enabled row, with the shape the gate and the Thread expect', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job(), job({ key: 'evening', title: 'Evening', text: 'Say good evening' })] } })
    const stop = h.start()
    try {
      // The first look at a new row records the instant it just passed instead of replaying it.
      await ready(h)
      expect(cursor(h, 'morning')).toEqual({ due: '2026-11-18T00:00:00.000Z', triggerId: '' })
      expect(triggers(h)).toEqual([])
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(4))
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(6))
      expect(triggers(h).map(trigger => trigger.at).sort()).toEqual(['2026-11-18T00:01:00.000Z', '2026-11-18T00:01:00.000Z',
        '2026-11-18T00:02:00.000Z', '2026-11-18T00:02:00.000Z', '2026-11-18T00:03:00.000Z', '2026-11-18T00:03:00.000Z'])
      const morning = triggers(h).find(trigger => trigger.meta.job === 'morning' && trigger.at === '2026-11-18T00:02:00.000Z')!
      expect(morning).toEqual({
        id: scheduleTriggerId('morning', '2026-11-18T00:02:00.000Z'), source: 'schedule',
        threads: [{ source: 'schedule', id: 'morning' }], actor: { source: 'schedule', id: '' }, human: false,
        event: 'schedule.fire', at: '2026-11-18T00:02:00.000Z', text: 'Say good morning',
        meta: { job: 'morning', due: '2026-11-18T00:02:00.000Z', cron: '* * * * *', timezone: 'UTC' },
      })
      // Two rows due in the same minute are two Triggers, and each row advances its own cursor.
      expect(new Set(triggers(h).map(trigger => trigger.id)).size).toBe(6)
      expect(cursor(h, 'morning')).toEqual({ due: '2026-11-18T00:03:00.000Z', triggerId: scheduleTriggerId('morning', '2026-11-18T00:03:00.000Z') })
      // A sender off the list who addresses no one is ignored by default, so no ticket opens and each Trigger records an ignore.
      expect(h.store.decisions.byThread('schedule:morning').map(decision => decision.kind)).toEqual(['ignore', 'ignore', 'ignore'])
      expect(h.store.decisions.byThread('schedule:morning')[0]!.reason).toEqual([{ code: 'admission_ignored', triggerId: expect.any(String) }])
      expect(h.store.tickets.open()).toEqual([])
      expect(h.health()).toMatchObject({ state: 'ready', detail: expect.stringContaining('2 jobs; next 2026-11-18T00:04:00.000Z') })
    } finally { await stop(); h.store.close() }
  })

  it('never takes the same due instant twice, across a restart as within one', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job()] } })
    let stop = h.start()
    try {
      await ready(h)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(1))
      // Handing the same instant in again is a duplicate, whatever produced it.
      expect(h.receive(scheduleTrigger(job(), new Date('2026-11-18T00:01:00.000Z')))).toBe('duplicate')
      await stop()
      stop = h.start()
      // A restart resumes from the cursor: the instant that fired is not fired again, and the next one is.
      await ready(h)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(2))
      expect(triggers(h).map(trigger => trigger.at).sort()).toEqual(['2026-11-18T00:01:00.000Z', '2026-11-18T00:02:00.000Z'])
    } finally { await stop(); h.store.close() }
  })

  it('catches up once after downtime, firing the most recent missed instant only', async () => {
    clock('2026-11-18T02:33:10.000Z')
    const h = harness({ config: { jobs: [job({ cron: '*/1 * * * *' })] } })
    let stop = h.start()
    try {
      await ready(h)
      // A row added now does not replay its history: it starts at the instant it just passed.
      expect(cursor(h, 'morning')).toEqual({ due: '2026-11-18T02:33:00.000Z', triggerId: '' })
      await stop()
      vi.setSystemTime(new Date('2026-11-21T09:00:30.000Z'))
      stop = h.start()
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(1))
      // Three days of missed instants fold into the last one, alone.
      expect(triggers(h)[0]).toMatchObject({ at: '2026-11-21T09:00:00.000Z', meta: { due: '2026-11-21T09:00:00.000Z' } })
      expect(cursor(h, 'morning')).toEqual({ due: '2026-11-21T09:00:00.000Z', triggerId: scheduleTriggerId('morning', '2026-11-21T09:00:00.000Z') })
    } finally { await stop(); h.store.close() }
  })

  it('fires nothing while the orchestrator is paused and leaves the cursor alone, so the pause folds into one catch-up', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job()] } })
    const stop = h.start()
    try {
      await ready(h)
      h.setPaused(true)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(triggers(h)).toEqual([])
      expect(cursor(h, 'morning')).toEqual({ due: '2026-11-18T00:00:00.000Z', triggerId: '' })
      h.setPaused(false)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(1))
      // The pause covered 00:01 and 00:02; resuming fires only the most recent of them.
      expect(triggers(h)[0]).toMatchObject({ at: '2026-11-18T00:03:00.000Z' })
    } finally { await stop(); h.store.close() }
  })

  it('fires nothing from a row that is turned off, and nothing while the Source itself is off', async () => {
    clock(NOW)
    const off = harness({ config: { jobs: [job({ enabled: 'false' })] } })
    const stopOff = off.start()
    try {
      await vi.waitFor(() => expect(off.health()).toMatchObject({ state: 'ready', detail: expect.stringContaining('0 jobs; next none') }))
      await vi.advanceTimersByTimeAsync(180_000)
      expect(triggers(off)).toEqual([])
    } finally { await stopOff(); off.store.close() }
    const disabled = harness({ enabled: false, config: { jobs: [job()] } })
    const stopDisabled = disabled.start()
    try {
      await vi.waitFor(() => expect(disabled.health()).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await vi.advanceTimersByTimeAsync(180_000)
      expect(triggers(disabled)).toEqual([])
    } finally { await stopDisabled(); disabled.store.close() }
  })

  it('names the row whose cron expression or timezone does not work, and keeps the other rows firing', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job({ key: 'broken', cron: '@daily' }), job()] } })
    const stop = h.start()
    try {
      await vi.waitFor(() => expect(h.health()).toMatchObject({ state: 'error', code: 'scheduleJobInvalid', values: { job: 'broken' } }))
      expect(h.health()!.detail).toContain('broken')
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(triggers(h)).toHaveLength(1))
      expect(triggers(h)[0]).toMatchObject({ meta: { job: 'morning' } })
      // A timezone the runtime does not know fails the same way, naming its own row rather than disabling the Source.
      h.store.saveSettings({ ...h.store.settings(), sources: { schedule: { enabled: true, config: { jobs: [job({ key: 'nowhere', timezone: 'Mars/Olympus' })] } } } })
      // The loop rereads the rows after its sleep, then names the row it cannot schedule.
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(h.health()).toMatchObject({ values: { job: 'nowhere' } }))
    } finally { await stop(); h.store.close() }
  })

  it('becomes a candidate only once the admission table observes the row, and then an inferred accept opens the ticket', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job()] }, eval: { mode: 'auto' },
      policy: { sources: { schedule: { admission: { morning: { unlistedUnaddressed: 'inferred' } } } } } })
    const stop = h.start()
    try {
      await ready(h)
      await vi.advanceTimersByTimeAsync(30_000)
      const trigger = scheduleTrigger(job(), new Date('2026-11-18T00:01:00.000Z'))
      await vi.waitFor(() => expect(h.store.triggers.get(trigger.id)).toBeDefined())
      // The gate admits it as an inference, its basis naming the row and the cell the table observed.
      expect(h.engine.candidate(trigger.id)).toMatchObject({ strength: 'inferred', triggers: [{ id: trigger.id }] })
      const decision = h.engine.decide(trigger.id, { kind: 'accept', title: 'Morning', scope: 'small', reason: 'rule', rules: ['copy'] })
      expect(decision).toMatchObject({ kind: 'accept', strength: 'inferred',
        mandate: { basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'morning', observation: { mode: 'auto' } } } })
      expect(h.store.tickets.get(decision.ticketId!)).toMatchObject({ title: 'Morning' })
    } finally { await stop(); h.store.close() }
  })

  it('listens to every due row but observes only the one still configured and enabled', () => {
    const h = harness({ config: { jobs: [job(), job({ key: 'off', enabled: 'false' })] } })
    const unregister = h.sources.register(scheduleKind)
    try {
      const at = new Date('2026-11-18T00:01:00.000Z')
      expect(h.sources.scope(scheduleTrigger(job(), at))).toEqual({ listened: true, observed: true, row: 'morning' })
      // A row turned off or gone is still listened to, yet unobserved, so the gate refuses it as no person's message.
      expect(h.sources.scope(scheduleTrigger(job({ key: 'off' }), at))).toEqual({ listened: true, observed: false })
      expect(h.sources.scope(scheduleTrigger(job({ key: 'gone' }), at))).toEqual({ listened: true, observed: false })
      expect(settingsPolicy(h.store.settings(), h.sources).gate(scheduleTrigger(job({ key: 'gone' }), at), thread(), []))
        .toEqual({ admissible: false, reason: 'not_human' })
      // Every enabled row gets one scope in the Policy panel: a sender off the list who addresses no one.
      expect(h.sources.policyPart('schedule')).toEqual({ allowed: [], bots: [], admission: {} })
      expect(h.sources.kind('schedule')!.policy!.rows!({ jobs: [job(), job({ key: 'off', enabled: 'false' })] })).toEqual([
        { id: 'morning', label: 'Morning', note: { zh: '* * * * *（UTC）', en: '* * * * * (UTC)' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } },
      ])
    } finally { unregister(); h.store.close() }
    const disabled = harness({ enabled: false, config: { jobs: [job()] } })
    const unregisterDisabled = disabled.sources.register(scheduleKind)
    try {
      expect(disabled.sources.scope(scheduleTrigger(job(), new Date()))).toEqual({ listened: false, reason: 'source_disabled' })
    } finally { unregisterDisabled(); disabled.store.close() }
  })

  it('reports a failure that escapes the watch loop as its health instead of an unhandled rejection', async () => {
    clock(NOW)
    const h = harness({ config: { jobs: [job()] } })
    const stop = h.start({ ready: Promise.reject(new Error('lock held')) })
    try {
      await vi.waitFor(() => expect(h.health()).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    } finally { await stop(); h.store.close() }
  })

  it('keys a Trigger by its row and due instant, so one row never yields the same ID twice', () => {
    const morning = scheduleTrigger(job(), new Date('2026-11-18T00:01:00.000Z'))
    expect(morning.id).toBe(key('schedule', 'morning', '2026-11-18T00:01:00.000Z'))
    expect(scheduleTrigger(job({ key: 'evening' }), new Date('2026-11-18T00:01:00.000Z')).id).not.toBe(morning.id)
    expect(scheduleTrigger(job(), new Date('2026-11-18T00:02:00.000Z')).id).not.toBe(morning.id)
  })
})
