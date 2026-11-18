/** Schedule source kind: task rows whose cron expression comes due in a timezone become Triggers, and the Cordis plugin entry that runs it. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { AllowedSchema } from '../policy.ts'
import type { SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { nextDue, parseCron, previousDue } from './schedule-cron.ts'
import { pause } from './poll.ts'
import { z } from 'zod'

export const SOURCE = 'schedule'
/** Longest a row may sleep before the loop looks at the clock again; short enough that a clock jump or a settings change is noticed soon. */
const MAX_WAIT_MS = 60_000
/** Shortest sleep, so an idle loop never spins. */
const MIN_WAIT_MS = 1_000
/** How long the loop waits while the orchestrator is paused or this Source is off. */
const IDLE_WAIT_MS = 60_000

/**
 * One task row. `cron`, `timezone`, `title` and `text` are only required to be non-empty here: whether the expression and the
 * timezone work is decided when the row is evaluated, so one mistyped row cannot disable the whole Source (see `scheduleJob`).
 */
const JobRowSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes, starting with a letter or digit'),
  cron: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  title: z.string().trim().min(1),
  text: z.string().trim().min(1),
  enabled: z.enum(['true', 'false']).default('true'),
}).strict()
export type JobRow = z.infer<typeof JobRowSchema>

const ScheduleConfigSchema = z.object({
  jobs: z.array(JobRowSchema).refine(jobs => new Set(jobs.map(job => job.key)).size === jobs.length, 'Duplicate job keys').default([]),
}).strict()
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

/** Deterministic Trigger ID for one task row at one due instant, so no restart or second instance can produce a second one. */
export const scheduleTriggerId = (job: string, due: string): string => key(SOURCE, job, due)

/** The Trigger one due instant of a task row produces: no sender, a Thread per job key, and the row's text. */
export function scheduleTrigger(job: JobRow, due: Date): Trigger {
  const at = due.toISOString()
  return {
    id: scheduleTriggerId(job.key, at), source: SOURCE, threads: [{ source: SOURCE, id: job.key }],
    actor: { source: SOURCE, id: '' }, human: false, at, text: job.text,
    meta: { job: job.key, due: at, cron: job.cron, timezone: job.timezone },
  }
}

export const scheduleKind: SourceKind<ScheduleConfig> = {
  kind: SOURCE,
  title: { zh: '定时来源', en: 'Schedule' },
  description: {
    zh: '按任务行里的 cron 表达式与 IANA 时区定时产生事件：每个到期时刻产生一条 Trigger，交给既有的准入与评估流程，自己不建工单、不派工。',
    en: 'Produces timed events from the cron expression and IANA timezone of each task row: every due instant becomes one Trigger, handed to the '
      + 'existing admission and evaluation flow. It opens no ticket and starts no work by itself.',
  },
  schema: ScheduleConfigSchema,
  fields: [{ key: 'jobs', type: 'rows', label: { zh: '任务行', en: 'Task rows' },
    hint: { zh: '每行一个 cron 表达式（五段：分 时 日 月 周）与时区，例如 `0 9 * * 1-5` 与 `Asia/Shanghai`。某个到期时刻的第一条 Trigger 需要策略面板把该行的「未列入发送者、未点名」一格改成推断，才会进入评估。',
      en: 'Each row pairs a five-field cron expression (minute hour day month weekday) with a timezone, such as `0 9 * * 1-5` and `Asia/Shanghai`. '
        + 'A due Trigger only reaches an assessment once the Policy panel marks that row\'s unlisted, unaddressed cell as inferred.' },
    columns: [
      { key: 'key', type: 'text', label: { zh: '任务 key', en: 'Job key' }, pattern: '[a-z0-9][a-z0-9\\-]*' },
      { key: 'title', type: 'text', label: { zh: '标题', en: 'Title' } },
      { key: 'cron', type: 'text', label: { zh: 'cron 表达式', en: 'Cron expression' } },
      { key: 'timezone', type: 'text', label: { zh: '时区', en: 'Timezone' } },
      { key: 'text', type: 'text', label: { zh: '任务文本', en: 'Task text' } },
      { key: 'enabled', type: 'select', label: { zh: '启用', en: 'Enabled' },
        options: [{ value: 'true', label: { zh: '是', en: 'Yes' } }, { value: 'false', label: { zh: '否', en: 'No' } }] },
    ] }],
  // A due row is the whole of what this Source receives, and only while that row is still configured and enabled: a Trigger whose
  // job is gone or turned off is stored but never observed, so the gate refuses it. There is no sender to address anyone.
  scope: ({ meta }, config) => {
    const job = String(meta.job)
    return config.jobs.some(row => row.key === job && row.enabled === 'true')
      ? { listened: true, observed: true, row: job }
      : { listened: true, observed: false }
  },
  health: [SOURCE],
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([]), bots: z.array(AllowedSchema).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders that may originate work' },
      hint: { zh: '定时来源没有发送者，这里通常留空。', en: 'A scheduled Source has no sender, so this is usually left empty.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' }, pattern: '[A-Za-z0-9\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '可以成为候选的机器人', en: 'Bots whose events may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] }],
    explicit: { zh: '定时来源没有发送者，没有任何任务行算作点名智能体。', en: 'A scheduled Source has no sender: no task row addresses the agent.' },
    rows(stored) {
      // A row that is gone or disabled has no scopes left; only what is still configured can ever become a candidate.
      return ScheduleConfigSchema.parse(stored).jobs.filter(job => job.enabled === 'true').map(job => ({
        id: job.key, label: job.title,
        // The row's schedule is what the panel shows beside its name; the next due instant itself has no channel to a row.
        note: { zh: `${job.cron}（${job.timezone}）`, en: `${job.cron} (${job.timezone})` },
        // A due row has no sender, so only the cell of a sender off the list who does not address the agent applies.
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true },
      }))
    },
  },
}

export const name = 'dsh-superagent-schedule'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(scheduleKind), 'schedule: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, scheduleKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the watch loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** One due instant of a task row that is ready to fire, with the Trigger it produces. */
type Due = { job: JobRow; due: Date; trigger: Trigger }
/** A task row whose cron expression or timezone does not work, and why. */
type Invalid = { job: JobRow; error: Error }

/**
 * Runs every enabled task row: sleeps until the nearest due instant, then fires the most recent one it has not handled yet.
 * Nothing fires while the orchestrator is paused or this Source is off, and the cursor of each row then stays where it is, so the
 * due instants of that time fold into the single catch-up the row fires once it resumes.
 */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the deployment; until then nothing is due.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    if (ctx.paused()) { await pause(IDLE_WAIT_MS, signal); continue }
    const config = ctx.config<ScheduleConfig>(SOURCE)
    if (!config) { ctx.report(SOURCE, health('paused', 'sourceOff')); await pause(IDLE_WAIT_MS, signal); continue }
    const now = new Date()
    const jobs = config.jobs.filter(job => job.enabled === 'true')
    const due: Due[] = []
    const invalid: Invalid[] = []
    let next: number | undefined
    for (const job of jobs) {
      try {
        const spec = parseCron(job.cron)
        const upcoming = nextDue(spec, job.timezone, now)
        if (!upcoming) throw new Error(`schedule: "${job.cron}" comes due nowhere near ${job.timezone}`)
        next = Math.min(next ?? Infinity, upcoming.getTime())
        const latest = previousDue(spec, job.timezone, now)
        if (!latest) throw new Error(`schedule: "${job.cron}" comes due nowhere near ${job.timezone}`)
        const cursor = ctx.state.get(KV.schedule.cursor(job.key))
        // A row never seen before starts at the most recent due instant, so adding it does not replay its history.
        if (cursor === undefined) ctx.state.set(KV.schedule.cursor(job.key), { due: latest.toISOString(), triggerId: '' })
        // The most recent due instant is the one catch-up a row fires, so days of downtime fold into a single Trigger.
        else if (latest.getTime() > Date.parse(cursor.due)) due.push({ job, due: latest, trigger: scheduleTrigger(job, latest) })
      } catch (error) {
        invalid.push({ job, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    let failure: unknown
    for (const { job, due: instant, trigger } of due) {
      if (signal.aborted) break
      try {
        // The Trigger and the cursor advance together: a failed hand-off leaves the cursor behind, and the same ID makes the retry a duplicate.
        ctx.atomic(() => {
          const result = ctx.receive(trigger)
          if (typeof result !== 'string') throw new Error('schedule: the Engine accepted a Trigger asynchronously')
          ctx.state.set(KV.schedule.cursor(job.key), { due: instant.toISOString(), triggerId: trigger.id })
        })
      } catch (error) { failure = error; break }
    }
    if (failure !== undefined && !signal.aborted) { ctx.report(SOURCE, { state: 'error', detail: String(failure) }); await pause(IDLE_WAIT_MS, signal); continue }
    if (due.length > 0) continue
    const first = invalid[0]
    if (first) ctx.report(SOURCE, health('error', 'scheduleJobInvalid', { job: first.job.key, error: first.error.message }))
    else ctx.report(SOURCE, { state: 'ready', detail: `${jobs.length} jobs; next ${next === undefined ? 'none' : new Date(next).toISOString()}`, at: now.toISOString() })
    // Sleep until the nearest due instant, but never so long that a clock jump or an edited row goes unnoticed.
    const wait = next === undefined ? MAX_WAIT_MS : next - Date.now()
    await pause(Math.min(Math.max(wait, MIN_WAIT_MS), MAX_WAIT_MS), signal)
  }
}
