/** The cron kernel behind the schedule Source: five fields, a wall clock in any IANA timezone, and the due instants they select. */
import { describe, expect, it } from 'vitest'
import { nextDue, parseCron, previousDue } from '../src/sources/schedule-cron.ts'

const due = (expression: string, timezone: string, after: string): string | undefined =>
  nextDue(parseCron(expression), timezone, new Date(after))?.toISOString()
const previous = (expression: string, timezone: string, at: string): string | undefined =>
  previousDue(parseCron(expression), timezone, new Date(at))?.toISOString()

describe('parseCron', () => {
  it('reads the five fields, their ranges, steps, lists and names', () => {
    expect(parseCron('*/15 9-17 * jan-mar 1-5')).toMatchObject({ minutes: [0, 15, 30, 45], hours: [9, 10, 11, 12, 13, 14, 15, 16, 17] })
    expect(parseCron('0 9 1,15 * mon,fri')).toMatchObject({ days: [1, 15], weekdays: [1, 5], daysRestricted: true, weekdaysRestricted: true })
    // Both 0 and 7 name Sunday, and either spelling is one value, so a week cannot fire twice.
    expect(parseCron('0 0 * * 0,7')).toMatchObject({ weekdays: [0] })
    // `a/step` runs from a to the end of its field.
    expect(parseCron('0 5/6 * * *')).toMatchObject({ hours: [5, 11, 17, 23] })
    expect(parseCron('  0   9  *  *  *  ')).toMatchObject({ minutes: [0], hours: [9], daysRestricted: false, weekdaysRestricted: false })
  })
  it('refuses anything but five fields rather than guessing at it', () => {
    expect(() => parseCron('0 0 9 * * *')).toThrow(/has five fields .* has 6/)
    expect(() => parseCron('@daily')).toThrow(/has five fields .* has 1/)
    expect(() => parseCron('0 9 * *')).toThrow(/has five fields/)
  })
  it('refuses the extensions it does not implement', () => {
    expect(() => parseCron('0 9 L * *')).toThrow(/day of month "L" is neither a number nor a name/)
    expect(() => parseCron('0 9 * * 1#2')).toThrow(/weekday "1#2" is neither a number nor a name/)
    expect(() => parseCron('0 9 ? * *')).toThrow(/day of month "\?" is neither a number nor a name/)
  })
  it('refuses values outside the field, empty entries, and steps that cannot run', () => {
    expect(() => parseCron('61 9 * * *')).toThrow(/minute 61 is outside 0-59/)
    expect(() => parseCron('0 24 * * *')).toThrow(/hour 24 is outside 0-23/)
    expect(() => parseCron('0 9 0 * *')).toThrow(/day of month 0 is outside 1-31/)
    expect(() => parseCron('0 9 * 13 *')).toThrow(/month 13 is outside 1-12/)
    expect(() => parseCron('0 9 * * 8')).toThrow(/weekday 8 is outside 0-7/)
    expect(() => parseCron('0,,9 * * * *')).toThrow(/has an empty entry/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/has no positive step/)
    expect(() => parseCron('0 9 15-1 * *')).toThrow(/runs backwards/)
  })
})

describe('nextDue', () => {
  it('reads the moment on the row\'s wall clock, not on UTC', () => {
    // 09:00 in Shanghai is 01:00Z; 08:30Z is already past 16:30 there, so the next one is the following morning.
    expect(due('0 9 * * *', 'Asia/Shanghai', '2026-11-18T00:30:00Z')).toBe('2026-11-18T01:00:00.000Z')
    expect(due('0 9 * * *', 'Asia/Shanghai', '2026-11-18T01:00:00Z')).toBe('2026-11-19T01:00:00.000Z')
    expect(due('0 9 * * *', 'UTC', '2026-11-18T00:30:00Z')).toBe('2026-11-18T09:00:00.000Z')
  })
  it('fires every quarter hour, one after another', () => {
    const first = due('*/15 * * * *', 'UTC', '2026-11-18T01:00:00Z')!
    const second = nextDue(parseCron('*/15 * * * *'), 'UTC', new Date(first))!.toISOString()
    const third = nextDue(parseCron('*/15 * * * *'), 'UTC', new Date(second))!.toISOString()
    expect([first, second, third]).toEqual(['2026-11-18T01:15:00.000Z', '2026-11-18T01:30:00.000Z', '2026-11-18T01:45:00.000Z'])
  })
  it('keeps the wall-clock time across a DST change, so the offset moves instead', () => {
    // New York springs forward on 8 March 2026 and falls back on 1 November 2026; 09:00 local stays 09:00 local.
    expect(due('0 9 * * *', 'America/New_York', '2026-03-07T00:00:00Z')).toBe('2026-03-07T14:00:00.000Z')
    expect(due('0 9 * * *', 'America/New_York', '2026-03-07T14:00:00Z')).toBe('2026-03-08T13:00:00.000Z')
    expect(due('0 9 * * *', 'America/New_York', '2026-10-31T13:00:00Z')).toBe('2026-11-01T14:00:00.000Z')
  })
  it('takes the union of a restricted day of month and a restricted weekday, as Vixie cron does', () => {
    // The first of the month and every Monday, not only Mondays that are the first.
    expect(due('0 9 1 * mon', 'UTC', '2026-11-20T00:00:00Z')).toBe('2026-11-23T09:00:00.000Z')
    expect(due('0 9 1 * mon', 'UTC', '2026-11-23T09:00:00Z')).toBe('2026-11-30T09:00:00.000Z')
    expect(due('0 9 1 * mon', 'UTC', '2026-11-30T09:00:00Z')).toBe('2026-12-01T09:00:00.000Z')
  })
  it('does not skip midnight when an earlier day was ruled out', () => {
    // Stepping a whole hour from 23:30 would land on 00:30 and miss the 00:00 due on the day that just started.
    expect(due('0 0 1 * *', 'UTC', '2026-11-30T23:30:00Z')).toBe('2026-12-01T00:00:00.000Z')
    expect(due('0 0 * * mon', 'UTC', '2026-11-22T23:30:00Z')).toBe('2026-11-23T00:00:00.000Z')
  })
  it('returns nothing for a moment that never comes, and does not search past its horizon', () => {
    expect(nextDue(parseCron('0 0 30 2 *'), 'UTC', new Date('2026-11-18T00:00:00Z'))).toBeUndefined()
    expect(nextDue(parseCron('* * * * *'), 'UTC', new Date('2026-11-18T00:00:30Z'))!.toISOString()).toBe('2026-11-18T00:01:00.000Z')
  })
  it('refuses a timezone the runtime does not know', () => {
    expect(() => nextDue(parseCron('0 9 * * *'), 'Mars/Olympus', new Date('2026-11-18T00:00:00Z'))).toThrow(/not a time zone/)
  })
})

describe('previousDue', () => {
  it('finds the most recent due instant, which is where a new row starts', () => {
    expect(previous('*/1 * * * *', 'UTC', '2026-11-18T02:33:10Z')).toBe('2026-11-18T02:33:00.000Z')
    expect(previous('0 9 * * *', 'Asia/Shanghai', '2026-11-18T00:30:00Z')).toBe('2026-11-17T01:00:00.000Z')
    expect(previous('0 9 * * *', 'Asia/Shanghai', '2026-11-18T01:00:00Z')).toBe('2026-11-18T01:00:00.000Z')
  })
  it('lands before the moment it was asked about, and never after it', () => {
    const at = new Date('2026-11-18T02:33:00Z')
    expect(previousDue(parseCron('*/1 * * * *'), 'UTC', at)!.getTime()).toBeLessThanOrEqual(at.getTime())
    expect(previousDue(parseCron('0 0 30 2 *'), 'UTC', at)).toBeUndefined()
  })
})
