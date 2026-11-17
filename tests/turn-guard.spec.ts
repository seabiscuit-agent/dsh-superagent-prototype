/** Verifies the main-Session turn guard: a turn that owes the owner a word after a worker report must not close silently. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { messageId } from '../src/app/delivery.ts'
import { inspectTurn, TURN_CHECK_TEXT, TurnGuard } from '../src/app/turn-guard.ts'

/** The source of this plugin's relay and receipt messages, as DSH records them in a Session's history. */
const relaySource = { kind: 'dsh-superagent', form: 'relay' } as UserMessage['source']
const noticeSource = { kind: 'dsh-superagent', form: 'notice', summary: 'Reply' } as UserMessage['source']

/** Builds the turn events the guard reads, with the fields DSH appends in a live Session. */
function fixture(id = 'master') {
  const ctx = new Context()
  const events: SessionEvent[] = []
  let seq = 0
  const event = (type: string, data: unknown) => events.push({ type, seq: SessionSeq(seq++), time: 0, data } as SessionEvent)
  const user = (body: string, source: UserMessage['source'], messageIdValue = `test:${seq}`): UserMessage =>
    ({ id: MessageId(messageIdValue), role: 'user', content: [{ type: 'text', text: body }], source } as UserMessage)
  const start = (turn: number) => event('turn/start', { turn })
  const text = (turn: number, body: string) => event('assistant/message',
    { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: body }],
      source: { provider: 'test', model: 'test' } as never }) })
  const relay = (payload: unknown, requestId: string) => event('user/message', user(JSON.stringify(payload), relaySource, messageId(requestId)))
  const receipt = (receiptId: string) => event('user/message', user('Reply for ticket t1', noticeSource, `dsh-superagent:local-receipt:${receiptId}`))
  const nudge = (turn: number) => event('user/message', user(TURN_CHECK_TEXT, relaySource, messageId(`turn-check:${turn}`)))
  const steer = vi.fn()
  const agent = { id: SessionId(id), session: { snapshotEvents: () => events }, steer } as unknown as Agent
  new TurnGuard({ context: ctx, masterId: id }).install()
  const stop = (turn: number, target = agent) => ctx.emit('agent/turn-stopping', { agent: target, turn, signal: new AbortController().signal })
  return { ctx, events, start, text, relay, receipt, nudge, steer, stop, agent, user }
}

const report = { kind: 'worker_report', ticket: { id: 't1' }, state: 'ready', summary: 'done' }
const question = { kind: 'worker_attention', ticket: { id: 't1' }, state: 'ready' }

it('nudges a turn that ends silently after a worker report reached it', () => {
  const f = fixture()
  f.start(3)
  f.relay(report, 'report:abc')
  f.stop(3)
  expect(f.steer).toHaveBeenCalledOnce()
  const message = f.steer.mock.calls[0]![0] as UserMessage
  expect(message.id).toBe(messageId('turn-check:3'))
  expect(message.content).toEqual([{ type: 'text', text: TURN_CHECK_TEXT }])
})

it.each([
  ['visible assistant text', (f: ReturnType<typeof fixture>) => f.text(3, '结论：问题在 DSH 本体，已开 PR #23，等合并。')],
  ['a rendered receipt', (f: ReturnType<typeof fixture>) => f.receipt('r1')],
])('leaves a turn alone when the owner got %s', (_name, show) => {
  const f = fixture()
  f.start(3)
  f.relay(report, 'report:abc')
  show(f)
  f.stop(3)
  expect(f.steer).not.toHaveBeenCalled()
})

it('nudges when the only assistant text is a hidden closer the panel drops', () => {
  const f = fixture()
  f.start(3)
  f.relay(report, 'report:abc')
  f.text(3, 'NO_REPLY')
  f.stop(3)
  expect(f.steer).toHaveBeenCalledOnce()
})

it('does not nudge for a follow_up or a candidate, which need no owner-visible answer', () => {
  const f = fixture()
  f.start(3)
  f.relay({ kind: 'follow_up', trigger_id: 'x', text: '再看一下日志' }, 'followup:x')
  f.relay({ kind: 'candidate', trigger_id: 'y' }, 'candidate:e1')
  f.stop(3)
  expect(f.steer).not.toHaveBeenCalled()
})

it('nudges once per turn, even when the model stays silent after the nudge', () => {
  const f = fixture()
  f.start(3)
  f.relay(question, 'attention:t1:a1')
  f.nudge(3)
  f.stop(3)
  expect(f.steer).not.toHaveBeenCalled()
})

it('ignores turns of Sessions other than the main Session', () => {
  const f = fixture()
  const worker = { id: SessionId('worker-t1'), session: { snapshotEvents: () => f.events }, steer: f.steer } as unknown as Agent
  f.start(2)
  f.relay(report, 'report:abc')
  f.stop(2, worker)
  expect(f.steer).not.toHaveBeenCalled()
})

it('reads only the asked turn, not earlier ones', () => {
  const f = fixture()
  f.start(1)
  f.relay(report, 'report:old')
  f.start(2)
  f.text(2, '先确认一下容器里能否复现。')
  expect(inspectTurn(f.events, 2)).toEqual({ owed: false, addressed: true, nudged: false })
  expect(inspectTurn(f.events, 1)).toEqual({ owed: true, addressed: false, nudged: false })
})

it('treats an internal payload written as assistant text as invisible', () => {
  const f = fixture()
  f.start(4)
  f.relay(question, 'attention:t1:a1')
  f.text(4, '{"kind":"worker_attention","ticket_id":"t1"}')
  expect(inspectTurn(f.events, 4).addressed).toBe(false)
  f.stop(4)
  expect(f.steer).toHaveBeenCalledOnce()
})
