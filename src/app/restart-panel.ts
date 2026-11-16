/** Restarts this DSH instance through a peer spawner panel: a panel restarts another instance, never itself. */

/** The spawner panel's API path, as `dsh-superagent-spawner` registers it on the same Web server. */
export const SPAWNER_API = '/dsh-superagent-spawner/api'

export interface RestartPanelOptions {
  /** This instance's own Web server port, where its spawner panel lists the instances. */
  port: number
  /** Injected by tests; the global `fetch` otherwise. */
  fetchImpl?: typeof fetch
  /** How long one panel request may take. */
  timeoutMs?: number
}

interface PanelInstance {
  name?: unknown
  port?: unknown
  self?: unknown
}

/** A panel response with its body read as JSON when it is JSON; never throws on a non-2xx status. */
async function panelRequest(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text().catch(() => '')
  let body: unknown
  try { body = text ? JSON.parse(text) as unknown : undefined } catch { body = undefined }
  return { status: response.status, ok: response.ok, body }
}

function row(value: unknown): PanelInstance | undefined {
  return value !== null && typeof value === 'object' ? value as PanelInstance : undefined
}

/**
 * Restarts this instance by asking a peer spawner panel, the same `POST ?action=restart` a person clicks. The panel finds this
 * instance's entry, starts it after a graceful stop, and answers 202 before doing the work, so the caller learns that the
 * restart was accepted. A panel disables restarting its own row and the process dies before it could start itself, so the
 * request goes to the first peer that accepts it; a single-instance deployment has no peer and must be restarted by a person.
 */
export async function restartViaPanel(options: RestartPanelOptions): Promise<{ instance: string; panel: number }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const url = (port: number) => `http://127.0.0.1:${port}${SPAWNER_API}`
  const headers = { 'x-spawner-request': '1' }
  const list = await panelRequest(fetchImpl, `${url(options.port)}?action=list`, { headers }, timeoutMs)
  const instances = (list.body as { instances?: unknown } | undefined)?.instances
  if (!list.ok || !Array.isArray(instances)) throw new Error(`the spawner panel on 127.0.0.1:${options.port} did not list instances`)
  const self = instances.map(row).find(instance => instance?.self === true)
  if (!self || typeof self.name !== 'string' || !self.name) throw new Error(`the spawner panel on 127.0.0.1:${options.port} lists no self instance`)
  const peers = instances.map(row).filter((instance): instance is PanelInstance => instance?.self !== true
    && Number.isInteger(instance?.port) && (instance!.port as number) > 0)
  if (peers.length === 0) throw new Error(`no peer instance can restart ${self.name}: a spawner panel restarts another instance, never itself`)
  const failures: string[] = []
  for (const peer of peers) {
    const port = peer.port as number
    try {
      const restart = await panelRequest(fetchImpl, `${url(port)}?action=restart&name=${encodeURIComponent(self.name)}`,
        { method: 'POST', headers }, timeoutMs)
      if (restart.status === 202) return { instance: self.name, panel: port }
      const detail = restart.body && typeof restart.body === 'object' && 'error' in restart.body ? String((restart.body as { error: unknown }).error) : ''
      failures.push(`127.0.0.1:${port} answered ${restart.status}${detail ? ` (${detail})` : ''}`)
    } catch (error) {
      failures.push(`127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no spawner panel accepted the restart of ${self.name}: ${failures.join('; ')}`)
}
