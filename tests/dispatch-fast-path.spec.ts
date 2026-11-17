/** The local Source's `!dispatch` / `!discussion` fast path: mechanical accept, discussion, and `!!` escape. */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Commands } from '../src/infra/commands.ts'
import { localCommand } from '../src/app/runtime.ts'
import { localKind } from '../src/sources/local.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [], has_more: false }) })

const message = (text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: crypto.randomUUID() } as never })

/** Sends one main-session message and lets the fast path and any effects finish. */
async function say(host: Host, text: string): Promise<void> {
  const agent = host.agents.get(host.runtime.masterId) as unknown as { session: never }
  host.ctx.emit('session/event', agent.session,
    { type: 'user/message', time: Date.parse('2026-11-15T12:00:00.000Z'), surfaceOp: 'append', data: message(text) } as never)
  await host.runtime.idle()
}

async function localHost(language?: 'zh' | 'en'): Promise<Host> {
  const host = await startRuntime()
  host.runtime.sources.register(localKind)
  await new Promise(resolve => setTimeout(resolve, 0))
  if (language) {
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, local: { enabled: true, config: { language } } } })
  }
  return host
}

const triggers = (host: Host) => host.runtime.store.read.threadTriggers(`local:${host.runtime.masterId}`, 10)
const tickets = (host: Host) => host.runtime.store.tickets.list()

it('reads only an exact lowercase prefix on the first line, and lets `!!` escape it', () => {
  expect(localCommand('!dispatch 修复登录')).toEqual({ intent: 'dispatch', body: '修复登录' })
  expect(localCommand('!discussion 先别做\n后面还有话')).toEqual({ intent: 'discussion', body: '先别做\n后面还有话' })
  expect(localCommand('!!dispatch 只是提到这个写法')).toEqual({ intent: 'escape' })
  expect(localCommand('!Dispatch 大写不算')).toBeUndefined()
  expect(localCommand('前言\n!dispatch 不在首行')).toBeUndefined()
  expect(localCommand('!dispatch')).toEqual({ intent: 'dispatch', body: '' })
})

it('turns `!dispatch` into one mechanically accepted ticket and one confirmation, without an assessment', async () => {
  const host = await localHost('zh')
  await say(host, '!dispatch 修复登录')
  const [trigger] = triggers(host)
  expect(trigger).toMatchObject({ intent: 'dispatch', text: '!dispatch 修复登录' })
  expect(tickets(host)).toHaveLength(1)
  expect(tickets(host)[0]!.title).toBe('修复登录')
  const summaries = (host.agents.get(host.runtime.masterId) as unknown as { inject: { mock: { calls: [{ source?: { summary?: string } }][] } } })
    .inject.mock.calls.map(([injected]) => injected.source?.summary ?? '')
  expect(summaries.some(summary => summary.includes('收到，开始处理：修复登录'))).toBe(true)
})

it('keeps `!discussion` ordinary conversation: no ticket, and acceptance is refused', async () => {
  const host = await localHost('zh')
  await say(host, '!discussion 先讨论一下')
  expect(triggers(host)[0]).toMatchObject({ intent: 'discussion', text: '先讨论一下' })
  expect(tickets(host)).toHaveLength(0)
  await expect(host.route({ kind: 'accept', trigger_id: triggers(host)[0]!.id, title: '讨论', worktree_name: 'discuss' }))
    .rejects.toThrow('ordinary conversation')
})

it('falls back to the main session when no confirmation language is configured', async () => {
  const host = await localHost()
  await say(host, '!dispatch 修复登录')
  expect(tickets(host)).toHaveLength(0)
  expect(triggers(host)[0]).toMatchObject({ intent: 'dispatch' })
  const summaries = (host.agents.get(host.runtime.masterId) as unknown as { inject: { mock: { calls: [{ source?: { summary?: string } }][] } } })
    .inject.mock.calls.map(([injected]) => injected.source?.summary ?? '')
  expect(summaries.some(summary => summary.includes('收到，开始处理'))).toBe(false)
})

it('treats `!!dispatch` as ordinary text with one `!` removed', async () => {
  const host = await localHost('zh')
  await say(host, '!!dispatch 只是提到这个写法')
  expect(triggers(host)[0]).toMatchObject({ text: '!dispatch 只是提到这个写法' })
  expect(triggers(host)[0]).not.toHaveProperty('intent')
  expect(tickets(host)).toHaveLength(0)
})
