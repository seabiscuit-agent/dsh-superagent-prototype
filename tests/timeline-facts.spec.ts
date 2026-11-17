/** Facts: the append-only chain a ticket's timeline reads, recorded in the transaction of the write it describes. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, runningAssignment, type Assessor, type Assignment, type Candidate,
  type EngineOptions, type Executor, type Fact, type OutboundMessage, type Outcome, type Policy, type Repositories,
  type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { ticketTimeline, backfillTimeline } from '../src/app/views/timeline.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void
  prepareTicket?: EngineOptions['prepareTicket']
  repo?: Repositories
}
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket, repo = new MemoryRepositories() }: Hooks = {}) {
  const outbox: OutboundMessage[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn(),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  }
  let clock = 0
  const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } }
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: () => {},
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) engine.inputsDelivered(ticketId, assignment.id, [inputId])
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, outbox, requests, assessor, executor, settle, pump, decide,
    setVersion: (value: string) => { version = value }, tick: (seconds: number) => { clock += seconds } }
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1'): string {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); h.pump()
  const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  h.settle()
  return decision.ticketId!
}
const types = (facts: Fact[]): string[] => facts.map(fact => fact.type)
const times = (facts: Fact[]): (string | null)[] => facts.map(fact => fact.at)

let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
  vi.useRealTimers()
})
function sqlite(): Store {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-timeline-'))
  return new Store(join(directory, 'orchestrator.sqlite'))
}
function storedTicket(id: string): Ticket {
  return { id, title: 'Fix', decisionId: 'd1', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:05.000Z', origin: { triggerId: '1', triggerIds: ['1'] },
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' } }
}

describe('facts land in the transaction of the write they describe', () => {
  it('appends exactly one assignment.started Fact for one dispatch, at the time the write used', () => {
    const h = harness()
    const ticketId = accepted(h)
    const started = h.repo.facts.of(ticketId).filter(fact => fact.type === 'assignment.started')
    expect(started).toHaveLength(1)
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!
    expect(started[0]).toMatchObject({ ticket: ticketId, origin: 'recorded',
      data: { ticketId, assignmentId: assignment.id } })
    expect(started[0]!.at).toBe(assignment.startedAt)
  })
  it('leaves no Fact behind when the business write in the same transaction fails', () => {
    const h = harness()
    const ticketId = accepted(h)
    const before = h.repo.facts.of(ticketId).length
    const save = h.repo.tickets.save.bind(h.repo.tickets)
    let armed = true
    h.repo.tickets.save = ticket => {
      if (armed && ticket.ended) { armed = false; throw new Error('the database refused the write') }
      save(ticket)
    }
    expect(() => h.engine.stopTicket(ticketId, 'not needed')).toThrow('the database refused the write')
    expect(h.repo.facts.of(ticketId)).toHaveLength(before)
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('records one Fact for every moment the domain names, whether or not it also emits an event', () => {
    const events: string[] = []
    const h = harness({}, { emit: event => { events.push(event.type) } })
    const ticketId = accepted(h)
    // A follow-up a live ticket decides, a report with a question, and the answers to it.
    h.engine.receive(trigger('2')); h.pump()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision', question: 'Which layout?', questionFor: 'orchestrator', options: ['a', 'b'], recommend: 'a' })
    const asked = h.repo.tickets.get(ticketId)!.questions![0]!
    h.engine.answerQuestion(asked.id, 'a', 'the smaller one')
    // A question the orchestrator passes to a person, who answers it in the chat.
    h.engine.report(ticketId, { state: 'progress', summary: 'asking a person', question: 'Merge it?', questionFor: 'orchestrator' })
    const escalated = h.repo.tickets.get(ticketId)!.questions!.at(-1)!
    h.engine.escalate(escalated.id, 'the layout is a person\'s call')
    h.engine.personAnswered(ticketId, escalated.id, 'yes')
    // A question asked of a person outright, which the assignment resolves once the person answers.
    h.engine.report(ticketId, { state: 'progress', summary: 'confirming', question: 'Ship it?' })
    const resolved = h.repo.tickets.get(ticketId)!.questions!.at(-1)!
    h.engine.resolveQuestion(ticketId, resolved.id, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id)
    // The one the worker still holds is withdrawn when the next report settles it.
    h.engine.report(ticketId, { state: 'progress', summary: 'asking once more', question: 'Wait for CI?' })
    h.engine.report(ticketId, { state: 'progress', summary: 'no longer asking', question: null })
    h.engine.report(ticketId, { state: 'blocked', summary: 'stuck on the build' })
    h.engine.retryTicket(ticketId); h.settle()
    h.engine.signalFastPath('1', 'accepted', ticketId)
    h.engine.agenda('missing', 'check', 'Look again', '2026-09-23T00:00:09Z')
    h.engine.policyChanged('v1', 'v2')
    h.engine.receive(trigger('3')); h.engine.reevaluate('3'); h.pump()
    h.engine.stopTicket(ticketId, 'not needed')
    h.engine.unsubscribe('chat:t1')
    const recorded = new Set(types(h.repo.facts.of(ticketId)))
    const named = new Set(events)
    // Moments that concern no Ticket, such as an Eval starting, are recorded too but belong to no chain.
    const ticketless = new Set(['eval.started', 'decision.recorded', 'agenda.dropped', 'policy.changed', 'trigger.requeued',
      'trigger.followup', 'dispatch.fast_path'])
    // Everything the events announced is either on this chain or on no Ticket's chain...
    expect([...named].filter(type => !recorded.has(type) && !ticketless.has(type))).toEqual([])
    // ...and the moments no event names are recorded too.
    for (const type of ['report.recorded', 'question.withdrawn'] as const) expect(recorded.has(type)).toBe(true)
  })
})

describe('timeline order', () => {
  it('reads the chain of one ticket oldest first, from the Trigger that opened it to the end', () => {
    const h = harness()
    // The clock starts before the Trigger's own time, as it does in production.
    h.tick(10)
    const ticketId = accepted(h)
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision', question: 'Which layout?', questionFor: 'orchestrator', options: ['a', 'b'], recommend: 'a' })
    const asked = h.repo.tickets.get(ticketId)!.questions![0]!
    h.engine.answerQuestion(asked.id, 'a', 'the smaller one')
    h.engine.report(ticketId, { state: 'ready', summary: 'Done.' })
    const chain = types(h.repo.facts.of(ticketId))
    const inOrder = ['trigger.received', 'ticket.created', 'assignment.started', 'report.recorded']
      .map(type => chain.indexOf(type))
    expect(inOrder).toEqual([...inOrder].sort((left, right) => left - right))
    expect(inOrder).not.toContain(-1)
    expect(chain).toContain('report.recorded')
    expect(chain).toContain('question.answered')
    expect(chain.at(-1)).toBe('ticket.ended')
    expect(chain.filter(type => type === 'report.recorded')).toHaveLength(2)
    const order = times(h.repo.facts.of(ticketId)).filter((at): at is string => at !== null)
    expect(order).toEqual([...order].sort())
  })
  it('keeps both reports when one replaces the other, while the ticket holds only the latest', () => {
    const h = harness()
    const ticketId = accepted(h)
    h.tick(10)
    h.engine.report(ticketId, { state: 'progress', summary: 'first pass' })
    h.tick(10)
    h.engine.report(ticketId, { state: 'progress', summary: 'second pass' })
    const reports = h.repo.facts.of(ticketId).filter(fact => fact.type === 'report.recorded')
    expect(reports.map(fact => fact.data.summary)).toEqual(['first pass', 'second pass'])
    expect(h.repo.tickets.get(ticketId)!.assignments[0]!.report!.summary).toBe('second pass')
  })
})

describe('the timeline never drives the engine', () => {
  it('keeps running when the Facts are gone, and reads an empty chain', async () => {
    const h: Host = await startRuntime()
    try {
      const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
      await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
      await h.runtime.idle()
      expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
      // The chain is a record of what happened, never an input: losing it changes no business row.
      h.runtime.store.db.exec('DELETE FROM fact')
      const page = await h.api('GET', `tickets/${ticket.id}/timeline`)
      expect(page).toEqual({ status: 200, body: { ticket_id: ticket.id, facts: [], truncated: false } })
    } finally { await h.stop() }
  })
})

describe('receipts', () => {
  it('records a queued message with its own time and its delivery, and a dropped one with its reason', async () => {
    const h = await startRuntime()
    try {
      const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
      const receipts = h.runtime.store.read.facts(ticket.id, 200).facts.filter(fact => fact.type.startsWith('receipt.'))
      // The acknowledgement of the acceptance was queued when it was written, and sent once the runtime pumped the queue.
      expect(receipts.map(fact => fact.type)).toEqual(['receipt.queued', 'receipt.sent'])
      const receipt = h.runtime.store.receipts.get(receipts[0]!.data.receiptId as string)!
      // The queued moment is the receipt's own `queuedAt`, and the sent moment comes after it.
      expect(receipts[0]!.at).toBe(receipt.queuedAt)
      expect(receipts[1]!.at! >= receipts[0]!.at!).toBe(true)
      // A message to a conversation the Source does not listen to is dropped, and the Fact says why.
      h.runtime.outbox.send({ id: 'ignored', channel: { ...feishu('1', 'x').channel!, address: { chatId: 'oc_elsewhere' } },
        text: 'Done', kind: 'notice', ticketId: ticket.id })
      await h.runtime.sendReplies()
      const dropped = h.runtime.store.read.facts(ticket.id, 200).facts.filter(fact => fact.type === 'receipt.dropped')
      expect(dropped).toHaveLength(1)
      expect(dropped[0]!.data).toMatchObject({ receiptId: 'ignored', reason: 'channelIgnored' })
    } finally { await h.stop() }
  })
})

describe('the three entry points read one chain', () => {
  it('returns the same Facts, oldest first, to HTTP, the resource and the view', async () => {
    const h = await startRuntime()
    try {
      const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
      await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
      await h.runtime.idle()
      const http = await h.api('GET', `tickets/${ticket.id}/timeline`)
      const view = ticketTimeline({ store: h.runtime.store }, ticket.id)
      const read = await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticket.id}/timeline` }) as { text: string }
      const resource = read.text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Fact)
      expect(http.status).toBe(200)
      expect((http.body as { facts: unknown }).facts).toEqual(view.facts)
      expect(resource.map(({ at, type, origin }) => ({ at, type, origin })))
        .toEqual(view.facts.map(({ at, type, origin }) => ({ at, type, origin })))
      const order = view.facts.map(fact => fact.at).filter((at): at is string => at !== null)
      expect(order).toEqual([...order].sort())
    } finally { await h.stop() }
  })
  it('answers a Ticket that does not exist with a missing-error, and writes no Fact', async () => {
    const h = await startRuntime()
    try {
      const rows = h.runtime.store.db.prepare('SELECT count(*) AS count FROM fact').get() as { count: number }
      expect(() => ticketTimeline({ store: h.runtime.store }, 'nope')).toThrow(new UserError('unknownTicket'))
      expect((await h.api('GET', 'tickets/nope/timeline'))).toEqual({ status: 404, body: { error: 'Ticket not found' } })
      await expect(h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'ticket/nope/timeline' }))
        .rejects.toThrow('Ticket not found')
      expect((h.runtime.store.db.prepare('SELECT count(*) AS count FROM fact').get() as { count: number }).count).toBe(rows.count)
    } finally { await h.stop() }
  })
  it('shows the newest Facts and says it truncated the older ones', () => {
    const store = sqlite()
    try {
      store.tickets.save(storedTicket('t1'))
      for (let index = 0; index < 205; index++) {
        store.facts.append({ ticket: 't1', at: `2026-09-23T00:00:${String(index).padStart(3, '0')}Z`, type: 'report.recorded',
          data: { state: 'progress', summary: `pass ${index}` }, origin: 'recorded' })
      }
      const view = ticketTimeline({ store }, 't1')
      expect(view.truncated).toBe(true)
      expect(view.facts).toHaveLength(200)
      expect(view.facts.at(-1)!.summary).toContain('pass 204')
      expect(view.facts[0]!.summary).toContain('pass 5')
      expect(ticketTimeline({ store }, 't1').facts.map(fact => fact.at))
        .toEqual([...ticketTimeline({ store }, 't1').facts.map(fact => fact.at)].sort())
    } finally { store.close() }
  })
})

describe('backfill', () => {
  it('derives what the business rows still hold, once, and never over what the Engine recorded', () => {
    const store = sqlite()
    try {
      const ticket: Ticket = { ...storedTicket('t1'), assignments: [{ id: 'a0', state: 'ended', createdAt: '2026-09-23T00:00:01.000Z', startedAt: '2026-09-23T00:00:01.000Z',
        endedAt: '2026-09-23T00:00:04.000Z', endedReason: 'completed', report: { state: 'ready', summary: 'Done.', at: '2026-09-23T00:00:04.000Z' } }],
        ended: { at: '2026-09-23T00:00:05.000Z', by: 'executor', outcome: 'completed' } }
      store.tickets.save(ticket)
      store.facts.append({ ticket: 't1', at: '2026-09-23T00:00:00.000Z', type: 'ticket.created', data: { ticketId: 't1' }, origin: 'recorded' })
      const first = backfillTimeline({ store }, 't1')
      const derived = first.facts.filter(fact => fact.origin === 'derived')
      expect(derived.map(fact => fact.type)).toEqual(['trigger.received', 'assignment.started', 'report.recorded', 'assignment.ended', 'ticket.ended'])
      // The recorded row stayed as it was, and its type got no derived twin.
      expect(first.facts.filter(fact => fact.type === 'ticket.created').map(fact => fact.origin)).toEqual(['recorded'])
      const count = store.read.facts('t1', 1000).facts.length
      const again = backfillTimeline({ store }, 't1')
      expect(store.read.facts('t1', 1000).facts.length).toBe(count)
      expect(again.facts.map(fact => fact.at)).toEqual(first.facts.map(fact => fact.at))
      expect(() => backfillTimeline({ store }, 'nope')).toThrow(new UserError('unknownTicket'))
      expect(store.read.facts('nope', 10).facts).toEqual([])
    } finally { store.close() }
  })
})
