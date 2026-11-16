/** Restart through a peer spawner panel: the own row is never asked, a peer that accepts gets the restart request. */
import { expect, it } from 'vitest'
import { restartViaPanel } from '../src/app/restart-panel.ts'

type Call = { url: string; method: string; headers: Record<string, string> }

/** A fake panel network: `list` answers the given instances (plus an optional host block), a restart answers the given
 * statuses by port. */
function panel(options: { instances: unknown[]; host?: unknown; statuses?: Record<number, number>; body?: string }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>
    calls.push({ url, method: init.method ?? 'GET', headers })
    if (url.includes('action=list')) return new Response(JSON.stringify({ ok: true, instances: options.instances, host: options.host }), { status: 200 })
    const port = Number(new URL(url).port)
    const status = options.statuses?.[port] ?? 202
    return new Response(options.body ?? (status === 202 ? JSON.stringify({ ok: true, accepted: true }) : JSON.stringify({ ok: false, error: 'busy' })), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

it('asks a peer panel to restart this instance, never its own row', async () => {
  const h = panel({ instances: [
    { name: 'superagent', port: 3082, self: true },
    { name: 'superagent-spawner', port: 3150, self: false },
  ] })
  expect(await restartViaPanel({ port: 3082, fetchImpl: h.fetchImpl })).toEqual({ instance: 'superagent', panel: 3150 })
  expect(h.calls.map(call => call.url)).toEqual([
    'http://127.0.0.1:3082/dsh-superagent-spawner/api?action=list',
    'http://127.0.0.1:3150/dsh-superagent-spawner/api?action=restart&name=superagent',
  ])
  expect(h.calls[1]).toMatchObject({ method: 'POST', headers: { 'x-spawner-request': '1' } })
})

it('falls through to another peer when the first refuses, and reports every failure when none accepts', async () => {
  const instances = [
    { name: 'child', port: 3150, self: true },
    { name: 'host', port: 3082, self: false },
    { name: 'other', port: 4999, self: false },
  ]
  const h = panel({ instances, statuses: { 3082: 409, 4999: 202 } })
  expect(await restartViaPanel({ port: 3150, fetchImpl: h.fetchImpl })).toEqual({ instance: 'child', panel: 4999 })
  const none = panel({ instances, statuses: { 3082: 409, 4999: 500 } })
  await expect(restartViaPanel({ port: 3150, fetchImpl: none.fetchImpl })).rejects.toThrow('no spawner panel accepted the restart of child: 127.0.0.1:3082 answered 409 (busy); 127.0.0.1:4999 answered 500 (busy)')
})

it('restarts itself through the own panel when the spawner advertises self-restart', async () => {
  const h = panel({
    instances: [{ name: 'only', port: 3082, self: true }],
    host: { selfRestart: true },
  })
  expect(await restartViaPanel({ port: 3082, fetchImpl: h.fetchImpl })).toEqual({ instance: 'only', panel: 3082, self: true })
  expect(h.calls.map(call => call.url)).toEqual([
    'http://127.0.0.1:3082/dsh-superagent-spawner/api?action=list',
    'http://127.0.0.1:3082/dsh-superagent-spawner/api?action=restart&name=only',
  ])
})

it('tries its own panel after every peer refused, when self-restart is advertised', async () => {
  const h = panel({
    instances: [{ name: 'child', port: 3150, self: true }, { name: 'host', port: 3082, self: false }],
    host: { selfRestart: true },
    statuses: { 3082: 409 },
  })
  expect(await restartViaPanel({ port: 3150, fetchImpl: h.fetchImpl })).toEqual({ instance: 'child', panel: 3150, self: true })
  expect(h.calls.map(call => call.url)).toEqual([
    'http://127.0.0.1:3150/dsh-superagent-spawner/api?action=list',
    'http://127.0.0.1:3082/dsh-superagent-spawner/api?action=restart&name=child',
    'http://127.0.0.1:3150/dsh-superagent-spawner/api?action=restart&name=child',
  ])
})

it('explains a deployment with no peer and no self-restart capability, and one whose own row is missing', async () => {
  const single = panel({ instances: [{ name: 'only', port: 3082, self: true }] })
  await expect(restartViaPanel({ port: 3082, fetchImpl: single.fetchImpl }))
    .rejects.toThrow('no peer instance can restart only and this spawner panel does not support restarting its own instance')
  const lost = panel({ instances: [{ name: 'host', port: 3082, self: false }] })
  await expect(restartViaPanel({ port: 3150, fetchImpl: lost.fetchImpl })).rejects.toThrow('lists no self instance')
})
