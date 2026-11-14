#!/usr/bin/env node
// Collect the online-effectiveness evidence for the compress-surface fix and the
// 0.9.7 five-item inheritance checklist. Prints a report; no secrets are printed
// (credential values are only ever reported as "resolvable / missing").
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RESTART = '2026-11-15T04:34:48'
const HOST = 3082
const INSTANCES = {
  'superagent-2': 3150,
  'superagent-4': 3151,
  'inherit-e2e': 3152,
  'inherit-nohost': 3153,
}

const home = os.homedir()
const out = []
const say = (s = '') => out.push(s)

const curl = (url) => {
  try {
    return execFileSync('curl', ['-s', '-m', '6', url, '-H', 'x-orchestrator-request: 1'], { encoding: 'utf8' })
  } catch {
    return ''
  }
}
const json = (url) => {
  try {
    return JSON.parse(curl(url))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- compress surface
const logPath = path.join(home, '.local/state/billion-context/bili.log')
const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => /^\d{4}-/.test(l)) : []
const stats = (sel) => ({
  lines: sel.length,
  surfaceOff: sel.filter((l) => l.includes('surface=off')).length,
  surfaceOn: sel.filter((l) => l.includes('surface=on')).length,
  nudgeInject: sel.filter((l) => l.includes('nudge INJECT')).length,
  oversizeRefusal: sel.filter((l) => l.includes('oversize_refusal')).length,
  directUncompressed: sel.filter((l) => l.includes('model request sent DIRECT')).length,
})
say('# compress surface: before vs after the 2026-11-15T04:34:48 host restart')
say(`log: ${logPath}`)
const before = lines.filter((l) => l.slice(0, 19) < RESTART)
const after = lines.filter((l) => l.slice(0, 19) >= RESTART)
say(JSON.stringify({ before: stats(before), after: stats(after) }, null, 1))
say()
say('Note: the plugin only logs the surface line when the surface is OFF and a nudge was due')
say('(surfaceOffDetail(): `if (d.compressSurfaceOn || !shouldInject) return void 0`), so')
say('"after.surfaceOff === 0" means every judged surface was ON, not that no judgement ran.')
say()
// the declared tool list is only printed while the surface is OFF, so the log cannot
// show "compress is now declared"; counting the nudge text would be a false positive.
const declares = (sel) => sel.filter((l) => /top-level=\[[^\]]*\bcompress\b/.test(l)).length
say('## why the log holds no literal "compress is declared" line')
say(`- lines printing top-level=[...] before the restart: ${before.filter((l) => l.includes('top-level=[')).length}`)
say(`- lines printing top-level=[...] after the restart:  ${after.filter((l) => l.includes('top-level=[')).length}`)
say(`- of those, top-level lists naming compress before/after: ${declares(before)} / ${declares(after)}`)
say('  (every such pre-restart line matches the nudge reason text "max compressible N < threshold",')
say('   not the tool list; e.g. 04:08:36 lists 25 tools, none of them compress/decompress/search_context)')
say('  => the usable evidence is behavioural: the nudge FIRES, and this session folded blocks.')
say()

// per-session folded blocks (proof that worker sessions actually fold)
say('## same-origin plugin status per session (blocks folded after the restart)')
const HOSTS = {
  'worker-4716a3f921aff4d9f7b67488bd118f21': 'worker session that hit the T2 emergency nudge',
  'worker-a850c7ffe67914d4e9279ab1885e0941': 'worker session (spawner work)',
  'worker-19628a72d9fe7a8b42066c53540869a4': 'this ticket session',
  'orchestrator-066e68821adf969eb958fa0bc94e1d13': 'orchestrator session',
}
for (const [id, note] of Object.entries(HOSTS)) {
  say(`- ${id} (${note})`)
  const status = json(`http://127.0.0.1:18787/__bili/plugin/status?conversationId=${id}`)
  if (!status) {
    say('    unreachable')
    continue
  }
  const blocks = status.blocks ?? []
  const panel = String(status.panel ?? '').split('\n').filter((l) => /^Blocks:|^Sent to LLM|^Nudge:/.test(l))
  say(`    blocks=${blocks.length} active=${blocks.filter((b) => b.active).length}`)
  for (const line of panel) say(`    ${line}`)
}
say()

// ------------------------------------------------------------- five inherited items
const settings = { host: json(`http://127.0.0.1:${HOST}/orchestrator/api/settings`) }
for (const [name, port] of Object.entries(INSTANCES)) settings[name] = json(`http://127.0.0.1:${port}/orchestrator/api/settings`)
const models = { host: json(`http://127.0.0.1:${HOST}/orchestrator/api/models`) }
for (const [name, port] of Object.entries(INSTANCES)) models[name] = json(`http://127.0.0.1:${port}/orchestrator/api/models`)

const val = (block) => JSON.stringify(block?.value ?? null)
say('## item 4 — eval / executor settings (compared by value, revisions excluded)')
for (const name of Object.keys(INSTANCES)) {
  const child = settings[name]
  if (!child) {
    say(`- ${name}: unreachable`)
    continue
  }
  const evalSame = val(child.blocks.eval) === val(settings.host.blocks.eval)
  const execSame = val(child.blocks.executor) === val(settings.host.blocks.executor)
  say(`- ${name}: eval ${evalSame ? 'SAME' : 'DIFF'}, executor ${execSame ? 'SAME' : 'DIFF'}`)
  if (!execSame) say(`    child executor = ${val(child.blocks.executor)}`)
}
say(`host eval     = ${val(settings.host?.blocks?.eval)}`)
say(`host executor = ${val(settings.host?.blocks?.executor)}`)
say()

say('## item 2 — model catalogue and enablement (orchestrator /models)')
const catalogue = (doc) => (doc?.groups ?? []).map((g) => `${g.id}:${g.models.map((m) => m.id).join('|')}`).sort()
for (const name of ['host', ...Object.keys(INSTANCES)]) {
  const doc = models[name]
  if (!doc) {
    say(`- ${name}: unreachable`)
    continue
  }
  const same = JSON.stringify(catalogue(doc)) === JSON.stringify(catalogue(models.host))
  say(`- ${name}: routable=[${(doc.routableProviders ?? []).join(',')}] catalogue ${same ? 'SAME as host' : 'DIFFERS from host'}`)
  if (!same) {
    const hostGroups = catalogue(models.host)
    for (const group of catalogue(doc)) if (!hostGroups.includes(group)) say(`    only here: ${group}`)
    for (const group of hostGroups) if (!catalogue(doc).includes(group)) say(`    missing: ${group}`)
  }
}
say()

// why item 2 fails on the two older instances: the shared layer manifest degenerated
say('## item 2 root cause — shared layer manifest (the two older instances install from it)')
const hostManifestPath = path.join(home, '.dsh/profiles/superagent/package.json')
const sharedManifestPath = path.join(home, 'dsh-instances/.shared/profile/package.json')
const countOf = (doc) => `${Object.keys(doc?.dependencies ?? {}).length} deps / ${(doc?.dsh?.profile?.bundles ?? []).length} bundles`
if (fs.existsSync(hostManifestPath) && fs.existsSync(sharedManifestPath)) {
  const hostDoc = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'))
  const sharedDoc = JSON.parse(fs.readFileSync(sharedManifestPath, 'utf8'))
  say(`- host profile manifest:   ${countOf(hostDoc)}`)
  say(`- shared layer manifest:   ${countOf(sharedDoc)}  (mtime ${fs.statSync(sharedManifestPath).mtime.toISOString()})`)
  say(`  shared deps = [${Object.keys(sharedDoc.dependencies ?? {}).join(', ')}]`)
}
for (const name of Object.keys(INSTANCES)) {
  const mods = path.join(home, 'dsh-instances', name, 'workspace/profiles', name, 'node_modules')
  if (!fs.existsSync(mods)) {
    say(`- ${name}: node_modules absent`)
    continue
  }
  const stamp = path.join(mods, '.shared-layer-stamp')
  say(
    `- ${name}: node_modules entries=${fs.readdirSync(mods).length}` +
      ` billion-context=${fs.existsSync(path.join(mods, 'billion-context')) ? 'yes' : 'NO'}` +
      ` stamp=${fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim().slice(0, 12) : 'none'}`,
  )
}
say()

say('## item 1 — provider keys (presence only, never values)')
const credentialRefs = (file) => {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^ {2}[A-Z0-9_]+:/.test(l))
    .map((l) => l.trim().split(':')[0])
}
say(`- host refs: [${credentialRefs(path.join(home, '.dsh/.credentials.yaml')).join(', ')}] (values not printed)`)
for (const name of Object.keys(INSTANCES)) {
  const file = path.join(home, 'dsh-instances', name, 'workspace/.credentials.yaml')
  const linked = fs.existsSync(file) ? fs.lstatSync(file).isSymbolicLink() : false
  const refs = credentialRefs(file)
  say(`- ${name}: .credentials.yaml symlink=${linked} refs=[${refs.join(', ')}]`)
}
say()

say('## item 3 — login state links')
const LINKED = ['workbuddy-vault', '.credentials.yaml', '.qoder-accounts.cn.json', '.qoder-accounts.global.json', '.qoder-pool.cn.json', '.workbuddy-roster-seen.cn.json']
const PER_INSTANCE = ['.qoder-pool.global.json', '.workbuddy-device.json']
for (const name of Object.keys(INSTANCES)) {
  const ws = path.join(home, 'dsh-instances', name, 'workspace')
  const describe = (entry) => {
    const p = path.join(ws, entry)
    if (!fs.existsSync(p)) return 'absent'
    return fs.lstatSync(p).isSymbolicLink() ? 'symlink' : 'plain'
  }
  say(`- ${name}: ${LINKED.map((e) => `${e}=${describe(e)}`).join(' ')}`)
  say(`  per-instance: ${PER_INSTANCE.map((e) => `${e}=${describe(e)}`).join(' ')}`)
}
say()

say('## item 5 — agent CLI and github source')
for (const name of ['host', ...Object.keys(INSTANCES)]) {
  const doc = settings[name]
  if (!doc) {
    say(`- ${name}: unreachable`)
    continue
  }
  const github = (doc.sources ?? []).find((s) => s.id === 'github')?.value ?? {}
  const cfg = github.config ?? {}
  say(`- ${name}: cli=${JSON.stringify(cfg.cli)} repository=${JSON.stringify(cfg.repository)} enabled=${github.enabled}`)
}
say()

say('## spawner inherit warnings (logs/<instance>/inherit.log, last 2 lines)')
const logsDir = path.join(home, '.dsh/spawner/logs')
for (const name of fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []) {
  const file = path.join(logsDir, name, 'inherit.log')
  if (!fs.existsSync(file)) continue
  const body = fs.readFileSync(file, 'utf8').trim()
  say(`- ${name}: ${body === '' ? '(empty)' : body.split('\n').slice(-2).join(' ⏎ ')}`)
}

process.stdout.write(out.join('\n') + '\n')
