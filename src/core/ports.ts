/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
import type { AcceptMode, Assignment, ChannelRef, Decision, DecisionKind, DispatchRule, Mandate, MandateBasis, Strength, Thread, Ticket,
  TicketEndBy, TicketOutcome, Trigger } from './model.ts'
import type { Reason } from './reasons.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean
  /** The accept mode and the enabled dispatch rules matching the Trigger's source and declared event. */
  dispatch(trigger: Trigger): { mode: AcceptMode; rules: DispatchRule[] }
  /** The Mandate basis of an event a dispatch rule takes, keeping the gate path that admitted it so `revalidate` can re-check it. */
  dispatchBasis(trigger: Trigger, rule: DispatchRule, basis: MandateBasis): MandateBasis
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** An accept: `rules` the assessment matched, `name` the ticket's requested short name, and `note` a routing note for its worker. */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string
  /** The worker's question this message answers: a successful send records the answer and returns it as an Input. */
  questionId?: string
  /** When the message was queued; messages queued before this existed keep it absent, and their timeline row has no time. */
  queuedAt?: string }
/** A queued message waits (`pending`), went out (`sent`), or was dropped because its conversation can never receive it (`dropped`). */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void
}

/** What the Engine reports after a change, by event type. */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, a ticket's Executor its own, or an ended ticket its Subscription on an on-demand Thread. */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor' | 'ticket'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A matching event the dispatch rule's capacity held instead of creating a ticket; requeue retries it. */
  'dispatch.held': { triggerId: string; rule: string; reason: 'capacity' }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': { triggerId: string }
  /** A scheduled wake came due for a ticket that had ended or no longer exists, so it was dropped without resuming it. */
  'agenda.dropped': { ticketId: string; key: string; reason: string; at: string }
  /** A local command prefix was dispatched: mechanically accepted, fell back to assessment, or kept as discussion. */
  'dispatch.fast_path': { triggerId: string; ticketId?: string; result: 'accepted' | 'fallback' | 'discussion' }
  'question.answered': { ticketId: string; questionId: string; by: 'orchestrator' | 'person' }
  'question.escalated': { ticketId: string; questionId: string; reason: string }
  'question.resolved': { ticketId: string; questionId: string }
  /** A Question closed without an answer: withdrawn by the worker that asked it, or by the Ticket ending. */
  'question.withdrawn': { ticketId: string; questionId: string; by: 'worker' | 'ticket' }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** What a Fact records: every Domain event, plus the three moments the domain holds no event for. */
export type FactType = keyof DomainEvents | 'report.recorded' | 'receipt.queued' | 'receipt.sent' | 'receipt.dropped'
/** Whether the Engine saw the moment happen (`recorded`) or a later backfill derived it from stored state (`derived`). */
export type FactOrigin = 'recorded' | 'derived'
/** The structured payload of a Fact; it is the event's own data, or the fields the three eventless moments carry. */
export type FactData = Record<string, unknown>

/** One moment in a Ticket's history, kept so the timeline can be read after the business row has moved on. */
export interface Fact {
  /** The Ticket it belongs to, or `null` for a moment that concerns no Ticket, such as an Eval starting. */
  ticket: string | null
  /** When it happened, or `null` when the record it came from never carried a time. */
  at: string | null
  type: FactType
  data: FactData
  origin: FactOrigin
}

/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
  facts: {
    /** Appends one Fact; Facts are only ever inserted, never updated or deleted. */
    append(fact: Fact): void
    /**
     * Facts of `ticket` in time order, oldest first, limited to `limit` when given.
     * Rows without a time sort before the timed ones so a backfilled row keeps a stable place.
     */
    of(ticket: string, limit?: number): Fact[]
  }
}
