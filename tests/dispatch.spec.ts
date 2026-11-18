import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories } from '../src/core/index.ts'
import { policyEffects, policyVersion, SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Settings } from '../src/policy.ts'
import { scheduleTrigger } from '../src/sources/schedule.ts'
import { branchCiTrigger, ciTrigger } from '../src/sources/github-trigger.ts'
import { ciEvent } from '../src/sources/github-read.ts'
import type { DispatchRule, Ticket, Trigger } from '../src/core/index.ts'
import type { Assessor, Candidate, DomainEvent, Executor, OutboundMessage } from '../src/core/index.ts'

const JOB = { key: 'morning', cron: '0 8 * * *', timezone: 'Asia/Shanghai', title: 'Morning', text: 'Write the morning report', enabled: 'true' } as const

function rule(overrides: Partial<DispatchRule> = {}): DispatchRule {
  return { id: 'morning', enabled: true, when: { source: 'schedule', events: ['schedule.fire'] },
    title: 'Morning report', brief: 'Write the morning report and reply in the schedule thread.', maxActive: 2, ...overrides }
}

const scope = { scope: () => ({ listened: true as const, observed: true, row: 'job' }) }

function settings(rules: DispatchRule[], overrides: { mode?: string; paused?: boolean } = {}): Settings {
  return SettingsSchema.parse({
    paused: overrides.paused ?? false,
    eval: { mode: overrides.mode ?? 'auto' },
    policy: { dispatch: { rules }, sources: {
      schedule: { admission: { job: { unlistedUnaddressed: 'inferred' } } },
      github: { admission: { job: { unlistedUnaddressed: 'inferred' } } },
    } },
  })
}

function harness(rules: DispatchRule[], overrides: { mode?: string; paused?: boolean } = {}) {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const events: DomainEvent[] = []
  const outbox: OutboundMessage[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  let current = settings(rules, overrides)
  const engine = new Engine({ repo, scope, policy: () => settingsPolicy(current, scope), assessor, executor,
    outbox: { send: message => outbox.push(message), status: () => undefined, withdraw: vi.fn() },
    emit: event => events.push(event), now: () => '2026-11-18T00:00:00.000Z' })
  return { repo, requests, events, engine,
    update: (next: Settings) => { current = next },
    ticket: (id: string) => repo.tickets.get(id)! as Ticket }
}

let clock = 0
function fire(at = `2026-11-18T00:0${clock++ % 10}:00.000Z`): Trigger {
  return scheduleTrigger(JOB, new Date(at))
}

describe('dispatch rules', () => {
  it('takes a Trigger by exactly one matching rule without asking the assessor', async () => {
    const h = harness([rule()])
    const trigger = fire()
    expect(h.engine.receive(trigger)).toBe('stored')
    expect(h.requests).toHaveLength(0)
    const tickets = h.repo.tickets.open()
    expect(tickets).toHaveLength(1)
    const ticket = tickets[0]!
    expect(ticket.title).toBe('Morning report')
    expect(ticket.mandate.scope).toBe('Write the morning report and reply in the schedule thread.')
    expect(ticket.mandate.strength).toBe('inferred')
    expect(ticket.mandate.basis).toMatchObject({ via: 'dispatch', rule: 'morning', event: 'schedule.fire' })
    expect(ticket.mandate.basis.via === 'dispatch' && ticket.mandate.basis.gate).toEqual({ via: 'admission', cell: 'unlistedUnaddressed' })
    const decision = h.repo.decisions.get(ticket.decisionId)!
    expect(decision.kind).toBe('accept')
    expect(decision.reason[0]).toMatchObject({ code: 'dispatchRule' })
    expect(h.repo.triggers.disposition(trigger.id)?.dispatch).toEqual({ result: 'created', rule: 'morning', ticketId: ticket.id })
    expect(h.repo.threads.get('schedule:morning')?.pending).toEqual([])
    expect(h.events.some(event => event.type === 'dispatch.fast_path' && event.data.result === 'accepted')).toBe(true)
  })

  it('leaves a Trigger to the Eval when no rule matches and when several rules match', async () => {
    const none = harness([rule({ when: { source: 'schedule', events: ['schedule.other'] } })])
    const trigger = fire()
    none.engine.receive(trigger)
    expect(none.repo.tickets.open()).toHaveLength(0)
    expect(none.repo.threads.get('schedule:morning')?.pending).toContain(trigger.id)
    none.engine.evaluateDue()
    expect(none.requests).toHaveLength(1)

    const several = harness([rule(), rule({ id: 'report', title: 'Report' })])
    const both = fire()
    several.engine.receive(both)
    expect(several.repo.tickets.open()).toHaveLength(0)
    expect(several.repo.threads.get('schedule:morning')?.pending).toContain(both.id)
    expect(several.repo.triggers.disposition(both.id)?.dispatch).toEqual({ result: 'ambiguous', rules: ['morning', 'report'] })
    several.engine.evaluateDue()
    expect(several.requests).toHaveLength(1)
  })

  it('does not dispatch while paused, in observe mode, for a human Trigger, or without an event', async () => {
    for (const h of [harness([rule()], { paused: true }), harness([rule()], { mode: 'observe' })]) {
      const trigger = fire()
      h.engine.receive(trigger)
      expect(h.repo.tickets.open()).toHaveLength(0)
      expect(h.repo.triggers.disposition(trigger.id)?.dispatch).toBeUndefined()
      expect(h.repo.threads.get('schedule:morning')?.pending).toContain(trigger.id)
    }
    const human = harness([rule()])
    human.engine.receive({ ...fire(), human: true, actor: { source: 'chat', id: 'alice' } })
    expect(human.repo.tickets.open()).toHaveLength(0)
    const noEvent = harness([rule()])
    const plain = { ...fire(), event: undefined }
    noEvent.engine.receive(plain)
    expect(noEvent.repo.tickets.open()).toHaveLength(0)
    expect(noEvent.repo.threads.get('schedule:morning')?.pending).toContain(plain.id)
  })

  it('holds a Trigger when the rule is full and takes it again on requeue once capacity frees up', () => {
    const h = harness([rule({ maxActive: 1 })])
    const first = fire()
    expect(h.engine.receive(first)).toBe('stored')
    const [ticket] = h.repo.tickets.open()
    const second = fire()
    h.engine.receive(second)
    expect(h.repo.tickets.open()).toHaveLength(1)
    expect(h.repo.threads.get('schedule:morning')?.pending).toEqual([])
    expect(h.repo.triggers.disposition(second.id)?.dispatch).toEqual({ result: 'capacity', rule: 'morning', active: 1 })
    expect(h.events.some(event => event.type === 'dispatch.held' && event.data.triggerId === second.id)).toBe(true)
    expect(h.engine.reevaluate(second.id)).toBe(false)
    h.repo.tickets.save({ ...ticket!, ended: { at: '2026-11-18T01:00:00.000Z', by: 'executor', outcome: 'completed' } })
    expect(h.engine.reevaluate(second.id)).toBe(true)
    expect(h.repo.tickets.open()).toHaveLength(1)
    expect(h.repo.triggers.disposition(second.id)?.dispatch).toMatchObject({ result: 'created', rule: 'morning' })
  })

  it('revalidates a dispatch Mandate only while its rule, event and gate still apply', () => {
    const h = harness([rule()])
    h.engine.receive(fire())
    const mandate = h.repo.tickets.open()[0]!.mandate
    const policy = settingsPolicy(settings([rule()]), scope)
    expect(policy.revalidate(mandate)).toBe(true)
    expect(settingsPolicy(settings([rule({ enabled: false })]), scope).revalidate(mandate)).toBe(false)
    expect(settingsPolicy(settings([rule({ when: { source: 'schedule', events: ['schedule.other'] } })]), scope).revalidate(mandate)).toBe(false)
    expect(settingsPolicy(settings([rule()], { mode: 'observe' }), scope).revalidate(mandate)).toBe(false)
    expect(settingsPolicy(settings([rule({ brief: 'Another brief.' })]), scope).revalidate(mandate)).toBe(true)
    const gateLost = settings([rule()])
    gateLost.policy.sources.schedule!.admission.job = { unlistedUnaddressed: 'ignore' }
    expect(settingsPolicy(gateLost, scope).revalidate(mandate)).toBe(false)
  })

  it('reports a disabled rule as a policy change that no longer accepts rule-inferred work', () => {
    const h = harness([rule()])
    h.engine.receive(fire())
    const [ticket] = h.repo.tickets.open()
    const before = settings([rule()])
    const disabled = settings([rule({ enabled: false })])
    const effects = policyEffects([ticket!], before, disabled, () => scope)
    expect(effects.get(ticket!.id)).toMatchObject({ dispatch: { rule: 'morning', title: 'Morning report', change: 'disabled' }, proactive: false })
    const changed = settings([rule({ brief: 'Write it differently.' })])
    const brief = policyEffects([ticket!], before, changed, () => scope)
    expect(brief.get(ticket!.id)).toMatchObject({ dispatch: { rule: 'morning', title: 'Morning report', change: 'changed', brief: 'Write it differently.' } })
    expect(brief.get(ticket!.id)?.proactive).toBeUndefined()
  })

  it('counts dispatch rules in the policy version', () => {
    expect(policyVersion(settings([rule()]))).not.toBe(policyVersion(settings([rule({ title: 'Other' })])))
    expect(policyVersion(settings([rule()]))).not.toBe(policyVersion(settings([rule({ enabled: false })])))
  })
})

describe('source events', () => {
  it('maps CI counts to the declared GitHub events', () => {
    expect(ciEvent({ failed: 1, running: 0 })).toBe('github.ci.failed')
    expect(ciEvent({ failed: 0, running: 2 })).toBe('github.ci.running')
    expect(ciEvent({ failed: 0, running: 0 })).toBe('github.ci.passed')
  })

  it('declares events on the schedule and GitHub CI Triggers', () => {
    expect(scheduleTrigger(JOB, new Date('2026-11-18T00:00:00.000Z')).event).toBe('schedule.fire')
    expect(branchCiTrigger('main', 'abc', 1, 'github.ci.failed', 'CI failed', 'https://example.com').event).toBe('github.ci.failed')
    expect(ciTrigger({ number: 7, html_url: 'https://example.com/7', user: { login: 'a' } }, 1, 'github.ci.passed', 'CI passed').event)
      .toBe('github.ci.passed')
  })

  it('opens a ticket for a GitHub CI failure under a matching rule', () => {
    const h = harness([rule({ id: 'ci', when: { source: 'github', events: ['github.ci.failed'] }, title: 'Fix CI',
      brief: 'Find and fix the failing default-branch checks.' })])
    h.engine.receive(branchCiTrigger('main', 'abc', 1, 'github.ci.failed', 'CI failed', 'https://example.com'))
    const [ticket] = h.repo.tickets.open()
    expect(ticket?.title).toBe('Fix CI')
    expect(ticket?.mandate.basis.via).toBe('dispatch')
    expect(h.requests).toHaveLength(0)
  })
})
