/** The local Source: the main session's GUI as a dispatch origin, its intake filters, and its receipts rendering into that session. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import { apply as applyLocal, localChannel, localKind, localTriggerId, ownerTrigger, OWNER, SOURCE } from '../src/sources/local.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [], has_more: false }) })

/** Advances time past the reply effect's retry delay and drains delivery, as outbox.spec does. */
async function at(host: Host, ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await host.runtime.pump(); await host.runtime.sendReplies() } finally { vi.useRealTimers() }
}

/** A person's message as the main-session GUI persists it. */
const guiMessage = (text: string): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: crypto.randomUUID() } as never })
/** Replays one message as the host's session event for `sessionId`'s session. */
const emitMessage = (host: Host, sessionId: string, message: UserMessage) => {
  const agent = host.agents.get(sessionId) as unknown as { session: unknown } | undefined
  host.ctx.emit('session/event', agent!.session as never,
    { type: 'user/message', time: Date.parse('2026-11-15T12:00:00.000Z'), surfaceOp: 'append', data: message } as never)
}
/** A message dsh-superagent itself delivered (a relay or a notice), which the intake must not dispatch. */
const pluginMessage = (text: string): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'relay' } as never })

async function localHost() {
  const host = await startRuntime()
  // Source kinds are normally registered by plugins that are not loaded in unit tests; the fixture's settings rewrite
  // ran first, so registering now also exercises the owner preset for a never-configured policy section.
  host.runtime.sources.register(localKind)
  await new Promise(resolve => setTimeout(resolve, 0))
  return host
}

it('declares the local kind, an empty config, and a settling channel', async () => {
  expect(localKind.kind).toBe('local')
  expect(localKind.schema.parse({ })).toEqual({})
  expect(localKind.health).toEqual(['local'])
  expect(localKind.policy!.schema.parse({})).toEqual({ allowed: [] })
  await expect(localKind.channel!.send({} as never, {} as never)).resolves.toBe('sent')
})

it('registers the kind as a Cordis plugin on the orchestrator service', () => {
  const registered: unknown[] = []
  const disposers: (() => void)[] = []
  applyLocal({ orchestrator: { sources: { register: (kind: unknown) => { registered.push(kind); return () => {} } } },
    effect: (make: () => () => void) => { disposers.push(make()) } } as never)
  expect(registered).toEqual([localKind])
  disposers.forEach(dispose => dispose())
})

it('presets the owner as the local allowed sender and reports the source ready', async () => {
  const host = await localHost()
  try {
    const settings = (await host.api('GET', 'settings')).body as { blocks: { policy: { value: { sources: Record<string, { allowed: { id: string; name?: string }[] }> } } } }
    expect(settings.blocks.policy.value.sources[SOURCE]?.allowed).toEqual([OWNER])
    const sources = (await host.api('GET', 'sources')).body as unknown as { id: string; state: string }[]
    expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: SOURCE, state: 'ready' })]))
  } finally { await host.stop() }
})

it('turns a no-@ person message in the main-session GUI into an explicit candidate without opening a ticket', async () => {
  const host = await localHost()
  try {
    const message = guiMessage('Add a dark mode toggle to the settings page')
    emitMessage(host, host.runtime.masterId, message)
    await host.runtime.idle()
    expect(host.candidates()).toContain(localTriggerId(message.id))
    const card = host.relays(host.runtime.masterId).find(item => item.kind === 'candidate')!
    expect(card).toMatchObject({ strength: 'explicit', trigger_id: localTriggerId(message.id) })
    const stored = host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 10)
    expect(stored.map(trigger => trigger.id)).toEqual([localTriggerId(message.id)])
    expect(stored[0]).toMatchObject({ source: 'local', human: true, addressed: 'direct', actor: { source: 'local', id: 'owner' } })
    expect(host.runtime.store.threads.get(`local:${host.runtime.masterId}`)?.meta.label).toBe('Main session')
    expect(host.runtime.store.tickets.open()).toHaveLength(0)
  } finally { await host.stop() }
})

it('deduplicates a replayed message by its deterministic trigger id', async () => {
  const host = await localHost()
  try {
    const message = guiMessage('Fix the footer link')
    emitMessage(host, host.runtime.masterId, message)
    emitMessage(host, host.runtime.masterId, message)
    await host.runtime.idle()
    expect(host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 10)).toHaveLength(1)
    // The same trigger received directly is a duplicate as well, and never re-queues work.
    expect(host.runtime.receive(ownerTrigger(message, host.runtime.masterId, 0))).toBe('duplicate')
  } finally { await host.stop() }
})

it('filters twenty plugin injections as echoes without creating triggers or tickets', async () => {
  const host = await localHost()
  try {
    for (let index = 0; index < 20; index++) emitMessage(host, host.runtime.masterId, pluginMessage(`{"kind":"candidate","trigger_id":"t${index}"}`))
    emitMessage(host, host.runtime.masterId, guiMessage('A real request that must survive the echoes'))
    await host.runtime.idle()
    const stored = host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 100)
    expect(stored).toHaveLength(1)
    expect(host.candidates()).toHaveLength(1)
    expect(host.runtime.store.tickets.open()).toHaveLength(0)
    const detail = host.runtime.health[SOURCE]!.detail
    expect(host.runtime.health[SOURCE]).toMatchObject({ state: 'ready' })
    expect(detail).toContain('1 ingested')
    // At least the twenty injected echoes were filtered; cards the session claimed count as filtered too.
    expect(Number(detail.match(/(\d+) filtered/)?.[1])).toBeGreaterThanOrEqual(20)
  } finally { await host.stop() }
})

it('ignores messages of other sessions and messages while a main-Session tool runs', async () => {
  const host = await localHost()
  try {
    host.ctx.emit('session/event', { id: 'worker-elsewhere' } as never,
      { type: 'user/message', time: 0, surfaceOp: 'append', data: guiMessage('A worker session should not dispatch') } as never)
    const quiet = host.runtime as unknown as { quiet: number }
    quiet.quiet = 1
    try { emitMessage(host, host.runtime.masterId, guiMessage('Echoed from a tool run')) } finally { quiet.quiet = 0 }
    await host.runtime.idle()
    expect(host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 100)).toHaveLength(0)
    expect(host.runtime.health[SOURCE]).toMatchObject({ detail: 'Main-session intake: 0 ingested, 1 filtered' })
  } finally { await host.stop() }
})

it('accepts a local candidate and renders the acknowledgement into the main session as a notice row, idempotently', async () => {
  const host = await localHost()
  try {
    const message = guiMessage('Rename the Save button to Submit')
    emitMessage(host, host.runtime.masterId, message)
    await host.runtime.idle()
    const triggerId = localTriggerId(message.id)
    const result = await host.route({ kind: 'accept', trigger_id: triggerId, title: 'Rename the save button',
      worktree_name: 'rename-save', acknowledgement: 'On it: renaming the Save button to Submit.' })
    await host.runtime.idle()
    const ticket = host.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket).toMatchObject({ title: 'Rename the save button',
      mandate: { strength: 'explicit', basis: expect.objectContaining({ via: 'addressed', source: 'local', sender: 'Owner', addressed: 'direct' }) },
      origin: { triggerId: triggerId } })
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running' })])
    // The local channel renders the accept-time acknowledgement into the main session itself, with no outbound CLI call (startup member sync excluded).
    expect(host.runtime.store.replyStatus(key('ack', triggerId))).toBe('sent')
    expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args[1] === '+messages-reply')).toEqual([])
    const master = host.agents.get(host.runtime.masterId)!
    const ack = master.inject.mock.calls.map(([injected]) => injected)
      .find((injected) => injected.id === host.runtime.sessions.promptedId(`local-receipt:${key('ack', triggerId)}`))
    expect(ack).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice' } })
    expect(ack!.source).toMatchObject({ summary: `Acknowledgement for ticket ${ticket.id}: On it: renaming the Save button to Submit.` })
    // Repeating the confirmation is idempotent: the same ticket, and no second one.
    const again = await host.route({ kind: 'accept', trigger_id: triggerId, title: 'Rename the save button',
      worktree_name: 'rename-save', acknowledgement: 'On it: renaming the Save button to Submit.' })
    expect((again.ticket as { ticket_id: string }).ticket_id).toBe(ticket.id)
    expect(host.runtime.store.tickets.open()).toHaveLength(1)
  } finally { await host.stop() }
})

it('renders a local result reply into the main session as a notice row', async () => {
  const host = await localHost()
  try {
    const message = guiMessage('Ship the dark-mode toggle')
    emitMessage(host, host.runtime.masterId, message)
    await host.runtime.idle()
    const triggerId = localTriggerId(message.id)
    const result = await host.route({ kind: 'accept', trigger_id: triggerId, title: 'Ship the dark mode toggle',
      worktree_name: 'dark-mode', acknowledgement: 'On it: shipping the dark-mode toggle.' })
    await host.runtime.idle()
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    const sent = await host.runTool(host.runtime.masterId, 'orchestrator_reply',
      { purpose: 'result', ticket_id: ticketId, text: 'Submitted PR #9, ready for review.' }) as { status: string }
    expect(sent.status).toBe('sent')
    const master = host.agents.get(host.runtime.masterId)!
    const summaries = master.inject.mock.calls.map(([injected]) => (injected.source as { summary?: string } | undefined)?.summary ?? '')
    expect(summaries).toContain(`Reply for ticket ${ticketId}: Submitted PR #9, ready for review.`)
  } finally { await host.stop() }
})

it('waits with a local receipt while the main session is away, and renders it once the session returns', async () => {
  const host = await localHost()
  try {
    host.agents.delete(host.runtime.masterId)
    host.runtime.outbox.send({ id: 'away-1', channel: localChannel(host.runtime.masterId),
      text: 'Back online with the result.', kind: 'reply', ticketId: 't-away' })
    await host.runtime.sendReplies()
    expect(host.runtime.outbox.status('away-1')).toBe('pending')
    await host.controller.create({ sessionId: host.runtime.masterId })
    // The failed render retries after the reply effect's five-second delay.
    await at(host, 5000)
    expect(host.runtime.outbox.status('away-1')).toBe('sent')
    const master = host.agents.get(host.runtime.masterId)!
    const notice = master.inject.mock.calls.map(([injected]) => injected)
      .find((injected) => (injected.source as { summary?: string } | undefined)?.summary?.includes('Back online with the result.'))
    expect(notice).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice' } })
  } finally { await host.stop() }
})

it('keeps the worker acknowledgement satisfiable on a local ticket', async () => {
  const host = await localHost()
  try {
    const message = guiMessage('Add the export menu entry')
    emitMessage(host, host.runtime.masterId, message)
    await host.runtime.idle()
    const result = await host.route({ kind: 'accept', trigger_id: localTriggerId(message.id), title: 'Add the export entry',
      worktree_name: 'export-entry', acknowledgement: 'On it: adding the export menu entry.' })
    await host.runtime.idle()
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    const ack = await host.runTool(`worker-${ticketId}`, 'orchestrator_ack', { trigger_id: localTriggerId(message.id),
      text: 'On it: adding the export menu entry.' }) as { acknowledgement: string; reused: boolean }
    expect(ack).toMatchObject({ acknowledgement: 'sent', reused: true })
    expect(vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args[1] === '+messages-reply')).toEqual([])
  } finally { await host.stop() }
})

it('leaves chit-chat and holds unaccepted: no route, no ticket', async () => {
  const host = await localHost()
  try {
    const first = guiMessage('先别做，等我确认设计稿'), second = guiMessage('现在状态怎么样？')
    emitMessage(host, host.runtime.masterId, first)
    emitMessage(host, host.runtime.masterId, second)
    await host.runtime.idle()
    // The thread's open Eval holds the first candidate; the second message waits as pending until that one is decided.
    const cards = host.relays(host.runtime.masterId).filter(item => item.kind === 'candidate')
    expect(cards).toHaveLength(1)
    expect([localTriggerId(first.id), localTriggerId(second.id)]).toContain(cards[0]!.trigger_id)
    const stored = host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 100).map(trigger => trigger.id)
    expect(stored).toEqual(expect.arrayContaining([localTriggerId(first.id), localTriggerId(second.id)]))
    expect(host.runtime.store.tickets.open()).toHaveLength(0)
  } finally { await host.stop() }
})

it('exposes the Apply-to-accept guidance on the prompts view', async () => {
  const host = await localHost()
  try {
    const prompts = (await host.api('GET', 'prompts')).body as { parts: { key: string; text: string }[] }
    const dispatch = prompts.parts.find(part => part.key === 'runtime/dispatch')!
    expect(dispatch.text).toContain('落盘')
    expect(dispatch.text).toContain('never expanding its scope')
  } finally { await host.stop() }
})
