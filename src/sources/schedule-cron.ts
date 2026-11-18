/**
 * A cron expression and a wall clock, without a dependency.
 *
 * The `schedule` Source fires a row when its five-field cron expression comes due in the row's timezone. `parseCron` reads the
 * expression once; `nextDue` turns it into the first due instant after a moment, stepping the wall clock of an IANA timezone
 * through whole minutes. Everything here is pure and takes a `Date`, so the Source can be tested against a fixed clock.
 */

const MINUTE_MS = 60_000
/** Give up rather than step the clock forever: no five-field expression takes longer than this to come due again. */
const HORIZON_MS = 5 * 366 * 24 * 60 * MINUTE_MS

/** Which minutes, hours, days of the month, months and weekdays of a five-field cron expression may fire. */
export type CronSpec = {
  minutes: readonly number[]
  hours: readonly number[]
  days: readonly number[]
  months: readonly number[]
  /** Sunday is 0, as in a cron expression; `7` is read as Sunday too. */
  weekdays: readonly number[]
  /** Whether the day-of-month field restricts the day, rather than being `*`. */
  daysRestricted: boolean
  /** Whether the weekday field restricts the day, rather than being `*`. */
  weekdaysRestricted: boolean
}

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const WEEKDAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

type FieldSpec = { field: string; min: number; max: number; names?: Record<string, number> }

/** One field: `*`, a value, `a-b`, `a/step`, `a-b/step`, any of those joined by commas, and a name where the field has them. */
function field(text: string, spec: FieldSpec): number[] {
  const { field: name, min, max, names = {} } = spec
  const value = (item: string): number => {
    const named = names[item.toLowerCase()]
    if (named !== undefined) return named
    if (!/^\d+$/.test(item)) throw new Error(`schedule: ${name} "${item}" is neither a number nor a name it knows`)
    const number = Number(item)
    if (number < min || number > max) throw new Error(`schedule: ${name} ${number} is outside ${min}-${max}`)
    return number
  }
  const values = new Set<number>()
  for (const item of text.split(',')) {
    if (item === '') throw new Error(`schedule: the ${name} field has an empty entry`)
    const [range, stepText, ...extra] = item.split('/')
    if (extra.length > 0) throw new Error(`schedule: the ${name} entry "${item}" has more than one step`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`schedule: the ${name} entry "${item}" has no positive step`)
    let from = min
    let to = max
    if (range !== '*') {
      const [start, end, ...more] = range!.split('-')
      if (more.length > 0) throw new Error(`schedule: the ${name} entry "${item}" has more than one range`)
      from = value(start!)
      // `a/step` runs from `a` to the end of the field, as cron does; `a` alone is one value.
      to = end !== undefined ? value(end) : stepText === undefined ? from : max
      if (from > to) throw new Error(`schedule: the ${name} range "${range}" runs backwards`)
    }
    for (let current = from; current <= to; current += step) values.add(current)
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Read a five-field cron expression — minute, hour, day of month, month, weekday. Six fields with seconds, `@daily`, `L`, `#` and
 * `?` are refused rather than guessed at; they fail with an Error naming the field.
 */
export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/).filter(part => part !== '')
  if (parts.length !== 5) {
    throw new Error(`schedule: a cron expression has five fields (minute hour day month weekday), and "${expression}" has ${parts.length}`)
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string]
  const weekdays = field(weekday, { field: 'weekday', min: 0, max: 7, names: WEEKDAY_NAMES })
    // Both 0 and 7 are Sunday in a cron expression; one value keeps a week from firing twice.
    .map(value => (value === 7 ? 0 : value))
  return {
    minutes: field(minute, { field: 'minute', min: 0, max: 59 }),
    hours: field(hour, { field: 'hour', min: 0, max: 23 }),
    days: field(day, { field: 'day of month', min: 1, max: 31 }),
    months: field(month, { field: 'month', min: 1, max: 12, names: MONTH_NAMES }),
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    daysRestricted: day !== '*',
    weekdaysRestricted: weekday !== '*'
  }
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterOf(timezone: string): Intl.DateTimeFormat {
  const known = formatters.get(timezone)
  if (known) return known
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    })
  } catch (error) {
    throw new Error(`schedule: "${timezone}" is not a time zone the runtime knows`, { cause: error })
  }
  formatters.set(timezone, formatter)
  return formatter
}

/** The wall clock a moment reads as in a timezone. */
function wallClockOf(moment: number, formatter: Intl.DateTimeFormat): WallClock {
  const parts = formatter.formatToParts(moment)
  const at = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value)
  const year = at('year')
  const month = at('month')
  const day = at('day')
  return { year, month, day, hour: at('hour'), minute: at('minute'), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() }
}

/**
 * Day-of-month and weekday together follow Vixie cron: each field on its own selects days, but a day matches when *either* the
 * restricted field matches — `0 9 1 * mon` fires on the first of the month and on every Monday, not only on Mondays that are the
 * first. A field left as `*` does not vote.
 */
function dayMatches(spec: CronSpec, clock: WallClock): boolean {
  if (!spec.daysRestricted && !spec.weekdaysRestricted) return true
  const day = spec.daysRestricted && spec.days.includes(clock.day)
  const weekday = spec.weekdaysRestricted && spec.weekdays.includes(clock.weekday)
  return day || weekday
}

/**
 * How far the walk may step at once when a field above the minute already rules the moment out. A step always lands on the next
 * hour boundary, so even crossing midnight or a timezone offset change cannot carry the walk past a due minute.
 */
function stepOver(spec: CronSpec, clock: WallClock): number {
  if (!spec.months.includes(clock.month) || !dayMatches(spec, clock) || !spec.hours.includes(clock.hour)) return 60 - clock.minute
  return 1
}

/**
 * The first instant after `after` at which the expression comes due in `timezone`, or `undefined` when it comes due nowhere within
 * the horizon. Minutes that the wall clock repeats when a timezone falls back come due once per offset, as the clock shows them
 * twice; minutes that it skips when a timezone springs forward are never due that day.
 */
export function nextDue(spec: CronSpec, timezone: string, after: Date): Date | undefined {
  const formatter = formatterOf(timezone)
  const horizon = after.getTime() + HORIZON_MS
  // Due instants are whole minutes; start at the next one strictly after `after`.
  let cursor = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  while (cursor <= horizon) {
    const clock = wallClockOf(cursor, formatter)
    if (spec.months.includes(clock.month) && dayMatches(spec, clock) && spec.hours.includes(clock.hour) && spec.minutes.includes(clock.minute)) {
      return new Date(cursor)
    }
    cursor += stepOver(spec, clock) * MINUTE_MS
  }
  return undefined
}

/** The most recent instant at or before `at` at which the expression came due, for a row that has never fired. */
export function previousDue(spec: CronSpec, timezone: string, at: Date): Date | undefined {
  const formatter = formatterOf(timezone)
  const horizon = at.getTime() - HORIZON_MS
  let cursor = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS
  while (cursor >= horizon) {
    const clock = wallClockOf(cursor, formatter)
    if (spec.months.includes(clock.month) && dayMatches(spec, clock) && spec.hours.includes(clock.hour) && spec.minutes.includes(clock.minute)) {
      return new Date(cursor)
    }
    cursor -= stepOver(spec, clock) * MINUTE_MS
  }
  return undefined
}
