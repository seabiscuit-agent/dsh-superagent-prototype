/** Restarts this DSH instance through a spawner panel: a peer panel normally does it, and a panel that advertises
 * self-restart hands its own restart to a detached helper. */

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
 * Restarts this instance by asking a spawner panel, the same `POST ?action=restart` a person clicks. The panel finds this
 * instance's entry, starts it after a graceful stop, and answers 202 before doing the work, so the caller learns that the
 * restart was accepted. The request goes to the first peer that accepts it. When no peer accepts and the panel advertises
 * `host.selfRestart`, the own panel takes it: it arms a detached helper that restarts this instance after this process exits.
 * An older panel would only stop this instance and never start it again, so self-restart is never attempted without the flag.
 */
export async function restartViaPanel(options: RestartPanelOptions): Promise<{ instance: string; panel: number; self?: boolean }> {
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
  const host = (list.body as { host?: unknown } | undefined)?.host
  const selfRestart = host !== null && typeof host === 'object' && (host as { selfRestart?: unknown }).selfRestart === true
  const target = (port: number) => `${url(port)}?action=restart&name=${encodeURIComponent(self.name as string)}`
  const failure = (port: number, restart: { status: number; body: unknown }, suffix = '') => {
    const detail = restart.body && typeof restart.body === 'object' && 'error' in restart.body ? String((restart.body as { error: unknown }).error) : ''
    return `127.0.0.1:${port}${suffix} answered ${restart.status}${detail ? ` (${detail})` : ''}`
  }
  const failures: string[] = []
  for (const peer of peers) {
    const port = peer.port as number
    try {
      const restart = await panelRequest(fetchImpl, target(port), { method: 'POST', headers }, timeoutMs)
      if (restart.status === 202) return { instance: self.name, panel: port }
      failures.push(failure(port, restart))
    } catch (error) {
      failures.push(`127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (selfRestart) {
    try {
      const restart = await panelRequest(fetchImpl, target(options.port), { method: 'POST', headers }, timeoutMs)
      if (restart.status === 202) return { instance: self.name, panel: options.port, self: true }
      failures.push(failure(options.port, restart, ' (self)'))
    } catch (error) {
      failures.push(`127.0.0.1:${options.port} (self): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length === 0) {
    throw new Error(`no peer instance can restart ${self.name} and this spawner panel does not support restarting its own instance`)
  }
  throw new Error(`no spawner panel accepted the restart of ${self.name}: ${failures.join('; ')}`)
}
