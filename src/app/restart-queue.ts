/** The delayed instance restart the main Session asks for: it waits until no worker runs or is queued, then restarts once. */
import type { ExecutorLoad } from './views/tickets.ts'

/** A restart request waiting for the workers to become idle. */
export interface RestartPending {
  /** Why the main Session asked for the restart; recorded for the log and the status. */
  reason: string
  /** When the request was made (epoch milliseconds). */
  at: number
}

export interface RestartRequestResult {
  /** True only when `apply` ran for this request. */
  restarting: boolean
  /** True when the request waits for the workers, or an earlier one already waits. */
  deferred: boolean
  running: number
  queued: number
  /** True when this call found the request an earlier call made, and changed nothing. */
  already?: boolean
  pending_since?: number
}

export interface RestartQueueHost {
  /** The load a restart waits on: worker turns that a restart would interrupt, and tickets queued for a slot. */
  load(): ExecutorLoad
  /** Performs the restart once. The queue forgets the pending request before calling it, so a process death cannot repeat the restart. */
  apply(pending: RestartPending): Promise<void>
  /** Runs `run` after `ms`, returning a cancel. Injected so tests drive the clock. */
  schedule(run: () => void, ms: number): () => void
  now(): number
  log(message: string): void
}

/** How often a pending restart re-reads the worker load. */
export const RESTART_CHECK_MS = 5_000

/**
 * Holds at most one delayed restart. Workers run inside this process, so a restart that starts while one works cuts its turn;
 * the queue therefore applies only after `load()` reports no running worker and no ticket waiting for a slot, and keeps polling
 * until then. It is in memory on purpose: a DSH process start satisfies the request, and a plugin restart drops it (the main
 * Session asks again rather than being restarted a second time for one request).
 */
export class RestartQueue {
  private pending?: RestartPending
  private timer?: () => void
  private applying = false
  constructor(private readonly host: RestartQueueHost) {}

  /** Asks for a restart: applies it now when no worker is busy, else waits for the last one to finish. */
  async request(input: { reason?: string } = {}): Promise<RestartRequestResult> {
    const load = this.host.load()
    const pending = this.pending
    if (pending) return { restarting: false, deferred: true, already: true, ...load, pending_since: pending.at }
    // A restart already in flight serves this request too; asking again must not start a second one.
    if (this.applying) return { restarting: false, deferred: false, already: true, ...load }
    if (load.running === 0 && load.queued === 0) {
      const request = { reason: input.reason ?? '', at: this.host.now() }
      this.applying = true
      try { await this.host.apply(request) } finally { this.applying = false }
      return { restarting: true, deferred: false, ...load }
    }
    this.pending = { reason: input.reason ?? '', at: this.host.now() }
    this.arm()
    return { restarting: false, deferred: true, ...load, pending_since: this.pending.at }
  }

  /** Withdraws the pending restart; `cancelled` is false when none waits. */
  cancel(): { cancelled: boolean } {
    if (!this.pending) return { cancelled: false }
    this.pending = undefined
    this.timer?.()
    this.timer = undefined
    return { cancelled: true }
  }

  /** The pending request and the load, without asking for anything. */
  status(): { pending?: RestartPending; applying: boolean; load: ExecutorLoad } {
    return { ...this.pending ? { pending: this.pending } : {}, applying: this.applying, load: this.host.load() }
  }

  /** Stops the polling and forgets the request; the DSH process is stopping, so a restart is no longer meaningful. */
  dispose(): void {
    this.pending = undefined
    this.timer?.()
    this.timer = undefined
  }

  private arm(): void {
    this.timer = this.host.schedule(() => {
      this.timer = undefined
      this.check()
    }, RESTART_CHECK_MS)
  }

  private check(): void {
    // A request made while `apply` runs is served by the next poll, never by a second concurrent restart.
    if (!this.pending || this.applying) return
    const load = this.host.load()
    if (load.running > 0 || load.queued > 0) {
      this.arm()
      return
    }
    const pending = this.pending
    this.pending = undefined
    this.applying = true
    void this.host.apply(pending).catch(error => {
      this.host.log(`delayed restart failed, retrying while idle: ${String(error)}`)
      // A request cancelled or replaced meanwhile owns the queue; only restore this one when nothing newer waits.
      if (this.pending) return
      this.pending = pending
      this.arm()
    }).finally(() => { this.applying = false })
  }
}
