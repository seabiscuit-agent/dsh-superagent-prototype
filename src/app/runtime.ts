/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, latestAssignment, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage } from '../executor/dsh.ts'
import { assignmentSessionId } from '../core/worker-session.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { executorLoad } from './views/tickets.ts'
import { RestartQueue } from './restart-queue.ts'
import { restartViaPanel } from './restart-panel.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { agendaHandler } from './agenda.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { pullOf } from '../sources/github-pull.ts'
import { WorktreeNameSchema } from './assessment.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { openPerson, renderResult } from './receipts.ts'
import { attentionText } from './render.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { OWNER, ownerTrigger, SOURCE } from '../sources/local.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { cutTurn, markShutdownTurn, recoveryNote, type RestartTurnEvent, type ShutdownTurn } from './restart-recovery.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
/** A local command prefix: `!dispatch` starts a ticket mechanically, `!discussion` stays conversation. `!!` escapes. */
export function localCommand(text: string): { intent: 'dispatch' | 'discussion'; body: string } | { intent: 'escape' } | undefined {
  const first = text.split('\n', 1)[0] ?? ''
  // `!!` escapes the syntax: the message is ordinary text, with one `!` removed so the person can talk about `!dispatch`.
  if (/^!!(?:dispatch|discussion)\s+\S/u.test(first)) return { intent: 'escape' }
  const match = /^!(dispatch|discussion)\s+(\S.*)$/u.exec(first)
  if (!match) return undefined
  const consumed = first.length
  const body = `${match[2]}\n${text.slice(consumed + 1)}`.trim()
  return { intent: match[1] as 'dispatch' | 'discussion', body }
}
/** A deterministic kebab-case worktree name from a title plus the trigger hash, valid for the executor's name schema. */
function worktreeName(title: string, triggerId: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 3)
  const slug = (words.length ? words.join('-') : 'task').slice(0, 22)
  const hash = createHash('sha1').update(triggerId).digest('hex').slice(0, 7)
  return WorktreeNameSchema.parse(`${slug}-${hash}`)
}

/**
 * Wires the orchestrator together: the store, Sources, Sessions, effects, the Engine and the Passes, and turns a
 * person's local message into a Trigger the rest of the system can route.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** The main Session's delayed restart; a restart waits while workers run or wait for a slot. */
  private restartQueue?: RestartQueue
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        // The local Source starts listening as soon as it registers: report its intake and preset the owner once setup allows.
        if (kind.kind === SOURCE) void this.ready?.then(() => this.presetLocalOwner()).catch(error => {
          ctx.logger.warn('dsh-superagent could not preset the local Source owner: %s', String(error))
        })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        agenda: id => effects.agendaRows(id),
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        fallback: (ticketId, questionId) => this.fallback(ticketId, questionId),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused(),
        // The local Source's conversation is the main session itself: render each of its receipts there as a notice row, deduplicated per receipt id.
        renderLocal: (receipt, summary) => sessions.renderReceipt(receipt.id, receipt.text, summary),
        // A person's answer that went out closes the worker's question and reaches the worker as an Input.
        answered: receipt => { if (receipt.questionId && receipt.ticketId) this.engine.personAnswered(receipt.ticketId, receipt.questionId, receipt.text) } })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        routing: source => sources.routing(source),
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // A scheduled wake is one-shot: the row is deleted once its Input is written; a ticket waiting for a person keeps it queued.
      effects.handle('agenda', agendaHandler(engine), { limit: () => this.paused() ? 0 : 4 })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: (trigger, options) => engine.receive(trigger, options), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      const restartQueue = this.restartQueue = new RestartQueue({
        load: () => executorLoad(store, this.executor.activeCount()),
        // 主会话自己也在这一轮里：重启等它的回合结束再执行，避免把它正在写/读的这一轮切断。
        mainBusy: () => this.ctx.agents.get(this.masterId as SessionId)?.status === 'running',
        apply: async () => { await restartViaPanel({ port: ctx.webServer.port }) },
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms)
          timer.unref()
          return () => clearTimeout(timer)
        },
        now: () => Date.now(),
        log: message => ctx.logger.warn('dsh-superagent %s', message),
      })
      this.toolHost = { context: ctx, engine, store, effects, prompts, sessions, settings: this.settings, assessor, resources, restart: restartQueue,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        pullLink: ticket => this.pullLink(ticket),
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      // The local Source's intake: a person's message in the main session's own GUI enters the domain as an explicit Trigger.
      // Subscribed here, before anything else, so no message of the main Session is ever missed; plugin deliveries and the
      // orchestrator's own tool traffic are counted as filtered instead of dispatched (echoes never create candidates).
      this.ctx.on('session/event', (session, event) => {
        if (event.type === 'user/message') this.ingestLocal(session, event.data, event.time)
      })
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger, options: { assess?: boolean } = {}): ReceiveResult { return this.passes.receive(trigger, options) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Counted intake of the local Source, reported on its `local` health entry; zero until the kind registers. */
  private readonly localIntake = { ingested: 0, filtered: 0 }
  /**
   * Feeds one message of the main session's GUI to the local Source. Only a message authored by a person (`source.kind === 'user'`)
   * outside a main-Session tool run becomes a Trigger; dsh-superagent's own deliveries and the orchestrator's tool traffic are the
   * session's echoes, counted as filtered and never dispatched. Receiving is synchronous recording plus a scheduled pass, so this
   * never waits on an async delivery inside the host's event.
   */
  /** The GitHub page of a ticket's latest pull request, when the deployment knows its repository. */
  private pullLink(ticket: Ticket): string | undefined {
    const number = pullOf(ticket)
    const repository = this.setup.configured() ? this.setup.deployment.repository : ''
    return number && repository ? `https://github.com/${repository}/pull/${number}` : undefined
  }
  /**
   * The receipt a main-Session turn owes when the model closed without one: a ready report becomes its host-composed result, and
   * a person question still open becomes attention. It never invents an answer to an orchestrator question.
   */
  private fallback(ticketId: string, questionId?: string): void {
    try {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket) return
      if (questionId) {
        const question = ticket.questions?.find(item => item.id === questionId && openPerson(item))
        if (!question) return
        const id = `attention-reply:${question.id}`
        if (this.store.receipts.get(id)) return
        this.engine.reply({ purpose: 'attention', ticketId, questionId: question.id, text: attentionText(question), id })
        return
      }
      const report = latestAssignment(ticket)?.report
      if (report?.state !== 'ready') return
      const id = `result:${ticket.id}:${report.at}`
      if (this.store.receipts.get(id)) return
      this.engine.reply({ purpose: 'result', ticketId, text: renderResult(ticket, report, undefined, this.pullLink(ticket)), id })
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent: fallback receipt failed: %s', String(error))
    }
  }
  private ingestLocal(session: { id: string }, message: UserMessage, at: number): void {
    if (session.id !== this.masterId || !this.sources.kind(SOURCE)) return
    if (message.source.kind !== 'user' || this.quiet) { this.localIntake.filtered++; this.noteLocal(); return }
    const trigger = ownerTrigger(message, this.masterId, at)
    if (!trigger.text) return
    const command = localCommand(trigger.text)
    if (command?.intent === 'escape') trigger.text = trigger.text.slice(1)
    else if (command) trigger.intent = command.intent
    this.localIntake.ingested++
    this.noteLocal()
    try {
      if (command?.intent === 'discussion') {
        // Discussion is never a ticket: store the message, queue no assessment, and let the conversation answer it.
        this.receive(trigger, { assess: false })
        this.engine.signalFastPath(trigger.id, 'discussion')
      } else if (command?.intent === 'dispatch') {
        this.dispatchFast(trigger, command.body)
      } else this.receive(trigger)
      // The thread exists once the Trigger is stored; a display label makes the main session recognizable in ticket views.
      this.store.threads.describe(`local:${this.masterId}`, { label: 'Main session' })
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not receive a main-session message as a local Trigger: %s', String(error))
    }
  }
  /**
   * Mechanically accepts a `!dispatch` request without an assessment turn: one ticket, the first line as title, a name derived
   * from the title and trigger, and one host-written confirmation in the local Source's configured language. Anything that
   * cannot be accepted cleanly falls back to ordinary assessment routing instead of a partial ticket.
   */
  private dispatchFast(trigger: Trigger, body: string): void {
    const language = this.sources.instance<{ language?: 'zh' | 'en' }>(SOURCE)?.config.language
    const title = body.split('\n', 1)[0]?.trim() ?? ''
    const request = body.trim()
    const fallback = () => {
      this.receive(trigger)
      this.engine.signalFastPath(trigger.id, 'fallback')
    }
    if (!language || !request || !title || title.length > 200) return fallback()
    let name: string
    try { name = worktreeName(title, trigger.id) } catch { return fallback() }
    const quoted = title.slice(0, 60)
    const acknowledgement = language === 'zh' ? `收到，开始处理：${quoted}` : `On it: starting "${quoted}".`
    if (wordCount(acknowledgement) > IM_WORDS) return fallback()
    const stored = this.receive(trigger, { assess: false })
    if (stored === 'filtered') return
    try {
      const decision = this.engine.decide(trigger.id, { kind: 'accept', title, scope: request.slice(0, 1500),
        reason: { code: 'explicitRouted' }, acknowledgement, name })
      if (decision.kind !== 'accept' || !decision.ticketId) throw new Error(`Not accepted: ${reasonText(decision.reason)}`)
      this.passes.request()
      this.engine.signalFastPath(trigger.id, 'accepted', decision.ticketId)
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not dispatch %s mechanically: %s', trigger.id, String(error))
      // Assessment is the fallback, not a half-created ticket: the stored trigger is queued for a fresh Eval.
      try { this.engine.reevaluate(trigger.id) } catch { /* already accepted or held */ }
      this.engine.signalFastPath(trigger.id, 'fallback')
    }
  }
  /** Reports the local Source's intake on its health entry; no entry exists while the kind is not registered. */
  private noteLocal(): void {
    this.sources.healthEntries([SOURCE]).get(SOURCE)?.set({ state: 'ready',
      detail: `Main-session intake: ${this.localIntake.ingested} ingested, ${this.localIntake.filtered} filtered`, at: now() })
  }
  /**
   * Presets the main-session owner as the local Source's allowed sender once, when that Source's policy section was never
   * configured, so the owner's GUI messages are explicit with nothing to set up; a later deliberate edit is never overwritten.
   */
  private presetLocalOwner(): void {
    const { store } = this
    this.noteLocal()
    if (store.settings().policy.sources[SOURCE] !== undefined) return
    const policy = store.settings().policy
    void this.settings.save('policy', { ...policy, sources: { ...policy.sources, [SOURCE]: { allowed: [OWNER] } } },
      store.blockRevision('policy'), 'sync')
      .catch(error => { this.ctx.logger.warn('dsh-superagent could not preset the local Source owner: %s', String(error)) })
  }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.resumeMaster()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /**
   * Resumes the main-Session turn a restart cut off, so the person whose request was running does not have to send it again.
   * A paused instance keeps the shutdown marker and resumes on the next start; a delivery failure is logged and leaves
   * the marker (a crash-cut turn is detected again anyway) so readiness never depends on the recovery.
   */
  private resumeMaster(): void {
    const agent = this.ctx.agents.get(this.masterId as SessionId)
    if (!agent) return
    const marker = this.store.get(KV.runtime.shutdownTurn)
    const shutdown = marker?.session === this.masterId ? marker : undefined
    const turn = cutTurn(agent.session.snapshotEvents() as readonly RestartTurnEvent[], shutdown)
    if (this.paused() || agent.status !== 'idle') return
    if (turn === undefined) {
      if (marker) this.store.delete(KV.runtime.shutdownTurn)
      return
    }
    void this.sessions.prompt(this.masterId, `restart-recovery:${turn}`, recoveryNote(), 'steer').then(
      () => this.store.delete(KV.runtime.shutdownTurn),
      error => this.ctx.logger.warn('dsh-superagent could not resume main-session turn %s after a restart: %s', turn, String(error)))
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, effects: this.effects, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    // The DSH process is stopping: a restart that still waits for workers is no longer meaningful.
    this.restartQueue?.dispose()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...new Set(this.store.tickets.list()
        .flatMap(ticket => ticket.assignments.map(assignment => assignmentSessionId(ticket.id, assignment))))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      // Record the main-Session turn this stop is about to cut, before cancelling it, so the next start resumes exactly that turn and never a turn a person stopped.
      const master = this.ctx.agents.get(this.masterId as SessionId)
      if (master) markShutdownTurn(this.store, this.masterId, master.session.snapshotEvents() as readonly RestartTurnEvent[])
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
