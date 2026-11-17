/** In-memory repository implementation for testing and ephemeral engine instances. */
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts'
import type { Fact, Repositories } from './ports.ts'

const clone = <T>(value: T): T => structuredClone(value)
/**
 * In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
 * Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
 */
export class MemoryRepositories implements Repositories {
  private readonly triggerRows = new Map<string, Trigger>()
  private readonly dispositions = new Map<string, TriggerDisposition>()
  private readonly threadRows = new Map<string, Thread>()
  private readonly ticketRows = new Map<string, Ticket>()
  private readonly decisionRows = new Map<string, Decision>()
  /** Facts in insertion order, which stands in for the SQLite `rowid` tie-break. */
  private readonly factRows: Fact[] = []
  atomic<T>(work: () => T): T {
    const maps: Map<string, unknown>[] = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows]
    const snapshot = maps.map(map => new Map(map))
    const facts = this.factRows.length
    try { return work() }
    catch (error) {
      maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index]!) map.set(id, value) })
      this.factRows.length = facts
      throw error
    }
  }
  readonly triggers = {
    get: (id: string) => clone(this.triggerRows.get(id)),
    save: (trigger: Trigger) => { this.triggerRows.set(trigger.id, clone(trigger)) },
    disposition: (id: string) => clone(this.dispositions.get(id)),
    saveDisposition: (id: string, value: TriggerDisposition) => { this.dispositions.set(id, clone(value)) },
  }
  readonly threads = {
    get: (key: string) => clone(this.threadRows.get(key)),
    save: (thread: Thread) => { this.threadRows.set(thread.key, clone(thread)) },
    list: () => [...this.threadRows.values()].map(clone),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => clone(this.ticketRows.get(id)),
    save: (ticket: Ticket) => { this.ticketRows.set(ticket.id, clone(ticket)) },
    /** Newest first, matching the SQLite Store's order. */
    list: () => [...this.ticketRows.values()].reverse().map(clone),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => clone(this.decisionRows.get(id)),
    save: (decision: Decision) => { this.decisionRows.set(decision.id, clone(decision)) },
    byThread: (key: string) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
  }
  readonly facts = {
    append: (fact: Fact) => { this.factRows.push(clone(fact)) },
    /** Oldest first, matching the SQLite Store's `(at, id)` order: an untimed row sorts first. */
    of: (ticket: string, limit?: number) => {
      const ordered = this.factRows.map((fact, index) => ({ fact, index }))
        .filter(({ fact }) => fact.ticket === ticket)
        .sort((left, right) => {
          if (left.fact.at !== right.fact.at) {
            if (left.fact.at === null) return -1
            if (right.fact.at === null) return 1
            return left.fact.at < right.fact.at ? -1 : 1
          }
          return left.index - right.index
        })
        .map(({ fact }) => clone(fact))
      return limit === undefined ? ordered : ordered.slice(-limit)
    },
  }
}
