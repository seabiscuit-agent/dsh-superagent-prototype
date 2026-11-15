/** Local source kind: the main session's own GUI is a Source, and the Cordis plugin entry that registers it. */
import type { Context } from '@deepseek-ai/cordis'
import type { TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { AllowedSchema } from '../policy.ts'
import type { ChannelLink, SourceKind } from './kind.ts'
import { z } from 'zod'

export const SOURCE = 'local'
/**
 * The fixed actor every person's message in the main-session GUI is attributed to: whoever operates this deployment is its owner,
 * and the GUI authenticates the conversation it renders. Stored as the `owner` entry preset in `policy.sources.local.allowed`.
 */
export const OWNER_ID = 'owner'
/** The allowed-sender entry the runtime presets for the owner; the panel may rename or extend it afterwards. */
export const OWNER = { id: OWNER_ID, name: 'Owner' } as const
/** The local Source has no configuration of its own: its identity is the main session itself. */
const LocalConfigSchema = z.object({}).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>

/** Deterministic trigger ID for one main-session message; every replay of that message produces the same ID. */
export const localTriggerId = (messageId: string): string => key('local', messageId)
/** Constructs the local reply channel: the main session's own conversation, which needs no outbound delivery. */
export const localChannel = (sessionId: string): ChannelRef =>
  ({ source: SOURCE, thread: `local:${sessionId}`, address: { session: sessionId } })

/**
 * Builds the local Source's Trigger for one person's message in the main session's GUI. The message id makes the trigger ID, so the
 * Engine's own duplicate check rejects a replayed message; `text` is empty when the message carried no text, in which case the
 * caller drops it rather than dispatch a contentless request.
 */
export function ownerTrigger(message: UserMessage, masterId: string, at: number): Trigger {
  const text = message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text).join('\n').trim()
  // Hosts that replay a session event without its timestamp fall back to now rather than reject the message.
  const when = new Date(at)
  return {
    id: localTriggerId(message.id), source: SOURCE, threads: [{ source: SOURCE, id: masterId }],
    actor: { source: SOURCE, id: OWNER_ID }, human: true, addressed: 'direct',
    at: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
    text, channel: localChannel(masterId), meta: { message: message.id },
  }
}

/**
 * The local Source. The runtime's `session/event` listener feeds it (see `Runtime`): a person's message in the main session's GUI
 * is already addressed to the orchestrator, so it enters as an explicit candidate once the owner is in `allowed` — no @ and no
 * button. Its channel is a no-op: replies, acknowledgements and answers reach the person as the main session's own conversation,
 * while receipts settle so the mandated worker acknowledgement stays satisfiable.
 */
export const localKind: SourceKind<LocalConfig> = {
  kind: SOURCE,
  title: { zh: '主会话', en: 'Main session' },
  description: {
    zh: '主会话 GUI 本身作为来源：所有者在这个会话里发的消息直接成为派单候选，无需 @ 或按钮。回复和确认也在同一会话里。',
    en: "The main-session GUI itself as a Source: the owner's messages in that conversation become dispatch candidates directly, "
      + 'with no @ and no button. Replies and confirmations live in the same conversation.',
  },
  schema: LocalConfigSchema,
  fields: [],
  health: ['local'],
  channel: {
    send: async () => 'sent',
    link: (): ChannelLink => ({ url: '', label: { zh: '主会话', en: 'Main session' } }),
  },
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders that may originate work' },
      hint: { zh: '主会话 GUI 的每个用户都是这台部署的所有者，预置为 owner；通常不需要改动。', en: 'Every user of the main-session GUI is this deployment\'s owner, preset as owner; usually left alone.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' }, pattern: '[A-Za-z0-9\\-]+' }] }],
    explicit: { zh: '主会话 GUI 里的每条用户消息都直接面向编排者（免 @）。', en: 'Every user message in the main-session GUI addresses the orchestrator directly.' },
  },
}

export const name = 'dsh-superagent-local'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localKind), 'local: source kind')
}
