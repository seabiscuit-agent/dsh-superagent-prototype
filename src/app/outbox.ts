/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { SOURCE } from '../sources/local.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { DropReason, Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'facts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  /** Renders one receipt of the local Source into the main session's own conversation; a throw leaves the receipt waiting for its retry. */
  renderLocal(receipt: OutboundMessage, summary: string): Promise<void>
  /** Called after a message with a `questionId` went out, to record the worker's answer. */
  answered?(receipt: OutboundMessage): void
  paused(): boolean
}

/** The collapsed notice-row summary a local receipt renders under: its kind, ticket and first line, bounded like every notice summary. */
function localSummary(receipt: OutboundMessage): string {
  const label = receipt.kind === 'acknowledgement' ? 'Acknowledgement' : receipt.kind === 'notice' ? 'Notice' : 'Reply'
  const line = receipt.text.trim().split('\n').find(part => part.length > 0) ?? ''
  return boundContextSummary(`${label}${receipt.ticketId ? ` for ticket ${receipt.ticketId}` : ''}${line ? `: ${line}` : ''}`)
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    // The queueing moment is the receipt's own: a timeline row for it must read the same time later.
    const queuedAt = message.queuedAt ?? new Date().toISOString()
    const receipt: OutboundMessage = { ...message, queuedAt }
    store.atomic(() => {
      if (!store.receipts.add(receipt)) return
      effects.enqueue('reply', receipt.id, {})
      store.facts.append({ ticket: receipt.ticketId ?? null, at: queuedAt, type: 'receipt.queued',
        data: { receiptId: receipt.id, kind: receipt.kind }, origin: 'recorded' })
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  /** Settles one receipt and keeps the moment on its Ticket's chain, both in one transaction. */
  private settle(receipt: OutboundMessage, outcome: 'sent' | DropReason): void {
    const { store } = this.host
    const at = new Date().toISOString()
    store.atomic(() => {
      store.receipts.settle(receipt, outcome)
      store.facts.append({ ticket: receipt.ticketId ?? null, at, type: outcome === 'sent' ? 'receipt.sent' : 'receipt.dropped',
        data: { receiptId: receipt.id, kind: receipt.kind, ...outcome === 'sent' ? {} : { reason: outcome } }, origin: 'recorded' })
    })
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { this.settle(receipt, 'channelIgnored'); return }
    // The local Source's conversation is the main session itself: its receipts render there as notice rows instead of going out
    // through a channel, so what the panel shows is exactly what was delivered; a failed render retries like any channel failure.
    if (receipt.channel.source === SOURCE) {
      await this.host.renderLocal(receipt, localSummary(receipt))
      this.settle(receipt, 'sent')
      if (receipt.questionId) this.host.answered?.(receipt)
      return
    }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    this.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
    if (result !== 'gone' && receipt.questionId) this.host.answered?.(receipt)
  }
}
