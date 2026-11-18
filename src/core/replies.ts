/** The Engine's messages to Channels, each by the rule that allows it. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, openQuestions, pendingAnswer, ticketOutcome } from './model.ts'
import type { ChannelRef, Question, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string
    /** The open person question this attention answers or points at; without it the text must match the question exactly. */
    questionId?: string; text: string
    /** The receipt id a host-composed message must keep; without it the id is derived from the request's payload. */
    id?: string
    /** The answer corrects one the worker already received, rather than filling an open answer slot. */
    correction?: true }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** Queue a person's corrected answer where their question came from, once per correction, and report its receipt. */
  sendCorrection(ticket: Ticket, question: Question, text: string, id?: string): Reply {
    const trigger = question.triggerId ? this.repo.triggers.get(question.triggerId) : undefined
    const channel = trigger?.channel ?? this.sourceChannel(ticket)
    if (!channel) throw new UserError('noChannel')
    const receipt = id ?? `question-correction-reply:${question.id}:${question.corrections?.length ?? 0}`
    const existing = this.options.outbox.status(receipt)
    if (!existing) this.options.outbox.send({ id: receipt, channel, text, kind: 'reply', ticketId: ticket.id })
    return { id: receipt, status: this.options.outbox.status(receipt) ?? 'pending', reused: existing !== undefined }
  }
  /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
  withdrawAttention(attentionId: string): void {
    // Receipts use the spec's stable id; the hashed id keeps a question queued by an earlier version withdrawable.
    this.options.outbox.withdraw(`attention-reply:${attentionId}`)
    this.options.outbox.withdraw(key('attention-reply', attentionId))
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const open = ticket ? openQuestions(ticket) : []
    // Every answer entry shares one slot: a committed answer, or a panel answer still in its withdraw window, refuses it.
    if (request.purpose === 'answer' && ticket) {
      const questions = ticket.questions ?? []
      const asked = questions.filter(question => question.triggerId !== undefined && question.triggerId === trigger?.id)
      const target = request.questionId
        ? questions.find(question => question.id === request.questionId)
        : asked.find(question => question.resolution === undefined) ?? asked.at(-1)
          ?? (open.filter(question => question.to === 'person').length === 1 ? open.filter(question => question.to === 'person')[0] : undefined)
      if (target) {
        if (target.to !== 'person') throw new UserError('notPersonQuestion')
        if (target.resolution === 'answered') throw new UserError('alreadyAnswered')
        if (pendingAnswer(target)) throw new UserError('answerPending')
      }
    }
    const attention = request.purpose === 'attention'
      ? request.questionId ? open.find(question => question.id === request.questionId && question.to === 'person')
        : open.find(question => question.to === 'person' && question.question === request.question)
      : undefined
    // Attention replies must match a currently open question for a person, by id or exactly by text.
    if (request.purpose === 'attention' && (!attention || (request.question !== undefined && attention.question !== request.question))) {
      throw new UserError('notAttention')
    }
    // An answer goes back to the open person question it answers: by id, by the human message that asked it, or the only one.
    const people = open.filter(question => question.to === 'person')
    const answering = request.purpose === 'answer'
      ? request.questionId ? people.find(question => question.id === request.questionId)
        : people.find(question => question.triggerId === trigger?.id) ?? (people.length === 1 ? people[0] : undefined)
      : undefined
    if (request.purpose === 'answer' && request.questionId && !answering) throw new UserError('notOpen')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = request.id ?? (attention ? `attention-reply:${attention.id}` : key('reply', trigger?.id ?? ticket?.id ?? '', request.text))
    const existing = this.options.outbox.status(id)
    // A person answering the worker's question is not answering a question of their own, so it needs no take-up.
    const ready = !ticket || !trigger || !!answering || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {},
      ...answering ? { questionId: answering.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
