/** Host-owned receipts: result and attention bodies are composed here, and only an answer keeps model text. */
import type { Ticket, Trigger } from '../src/core/index.ts'
import { clean, noteText, receiptId, rejectedBody, renderResult, validateAnswer } from '../src/app/receipts.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import { expect, it } from 'vitest'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix the margin', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'addressed', addressed: 'direct' } as never, actor: { source: 'local', id: 'owner' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
  origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides,
})

it('composes a result from the report and the PR link, with no model-written body needed', () => {
  expect(renderResult(ticket(), { state: 'ready', summary: 'All checks pass.' }, undefined, 'https://github.com/acme/widgets/pull/7'))
    .toBe('**Ready for review**\nAll checks pass.\nPR: https://github.com/acme/widgets/pull/7')
  expect(renderResult(ticket({ ended: { at: '2026-11-17T01:00:00Z', by: 'executor', reason: 'completed', outcome: 'completed' } }),
    { state: 'ready', summary: 'Done.' })).toBe('**Completed**\nDone.')
})

it('removes internal payloads from a summary instead of refusing the report, and trims to one IM message', () => {
  expect(clean('before {"ticket_id":"t1"} after ||DSML||')).toBe('before after')
  const long = renderResult(ticket(), { state: 'progress', summary: Array.from({ length: IM_WORDS * 3 }, () => 'word').join(' ') })
  expect(long.split(/\s+/u).length).toBeLessThanOrEqual(IM_WORDS)
})

it('keeps a result note to two sentences and a small budget', () => {
  expect(noteText('第一句。第二句！第三句？')).toBe('第一句。 第二句！')
  expect(noteText('x '.repeat(400)).length).toBeLessThanOrEqual(241)
})

it('rejects empty, hidden, internal and off-question answer bodies', () => {
  const trigger = { id: 'q', human: true } as Trigger
  expect(validateAnswer('', trigger)).toBe('emptyBody')
  expect(validateAnswer('NO_REPLY', trigger)).toBe('silentBody')
  expect(validateAnswer('{"ticket_id":"t1"}', trigger)).toBe('internalPayload')
  expect(validateAnswer('Sure.', undefined)).toBe('missingQuestion')
  expect(validateAnswer('Sure.', { id: 'q', human: false } as Trigger)).toBe('missingQuestion')
  expect(validateAnswer('word '.repeat(IM_WORDS + 1), trigger)).toBe('tooLong')
  expect(validateAnswer('Sure.', trigger)).toBeUndefined()
})

it('gives each receipt purpose a deterministic id, so a repeated call reuses its receipt', () => {
  expect(receiptId('result', { ticketId: 't1', reportAt: '2026-11-17T01:00:00Z' })).toBe('result:t1:2026-11-17T01:00:00Z')
  expect(receiptId('attention', { questionId: 'q1' })).toBe('attention-reply:q1')
  expect(receiptId('answer', { triggerId: 'x', text: 'yes' })).toBe(receiptId('answer', { triggerId: 'x', text: 'yes' }))
  expect(receiptId('answer', { triggerId: 'x', text: 'yes' })).not.toBe(receiptId('answer', { triggerId: 'x', text: 'no' }))
  expect(rejectedBody('dsh-superagent:local-receipt:1')).toBe('internalPayload')
})
