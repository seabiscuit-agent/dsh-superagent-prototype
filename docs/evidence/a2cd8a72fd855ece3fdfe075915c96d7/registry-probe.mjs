// Decisive probe, one agent scope per trial (a scope key can be bound to a parent only once).
// Structure mirrors the real system: the host compression plugin registers its tools from its own
// context; the agent preset scope owns the work tools; each agent is a scope under the preset.
const DSH = '/Users/seabiscuit/.nvm/versions/node/v24.17.0/lib/node_modules/@deepseek-ai/dsh/node_modules'
const { Context } = await import(`${DSH}/@deepseek-ai/cordis/lib/index.js`)
const { createScope, scopeOf, scopeParentOf } = await import(`${DSH}/@deepseek-ai/dsh-scope/lib/index.js`)
const { ToolsService } = await import(`${DSH}/@deepseek-ai/dsh-tools/lib/index.js`)
const def = n => ({ name: n, description: 'x', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' })
const WORK = ['bash', 'read', 'grep', 'skill'], COMPRESSION = ['compress', 'decompress', 'search_context']

async function setup(compression) {
  const root = new Context()
  root.reflect.provide('systemPrompt', { tools: () => () => {} })
  await root.plugin(ToolsService, {})
  if (compression) await root.plugin({ name: 'bili', inject: ['tools'], apply: c => { for (const n of COMPRESSION) c.tools.register(def(n)) } })
  const presetKey = {}
  await createScope(root, presetKey).ctx.plugin({ name: 'preset', inject: ['tools'], apply: c => { for (const n of WORK) c.tools.register(def(n)) } })
  return { root, presetKey }
}

async function trial(label, { root, presetKey }, allowFn) {
  const agent = createScope(root, {}, { parent: presetKey })
  await agent.ctx.plugin({ name: 'agent', inject: ['tools'], apply: c => {
    const parent = scopeParentOf(scopeOf(c))
    const before = [...c.tools.view(scopeOf(c)).visible.keys()].sort()
    const allow = allowFn(n => !!c.tools.get(n, parent))
    try {
      c.tools.restrict({ allow })
      const after = [...c.tools.view(scopeOf(c)).visible.keys()].sort()
      console.log(`${label}\n  before: ${before.join(',')}\n  allow : [${allow.join(',')}]\n  after : ${after.join(',')}`)
    } catch (e) { console.log(`${label}\n  before: ${before.join(',')}\n  allow : [${allow.join(',')}]\n  REFUSED: ${String(e.message).slice(0, 100)}`) }
  } })
}

const hosted = await setup(true)
await trial('A host WITH plugin, allow = work only', hosted, () => WORK)
await trial('B host WITH plugin, allow = work + registered compression', hosted, reg => [...WORK, ...COMPRESSION.filter(reg)])
const bare = await setup(false)
await trial('C host WITHOUT plugin, allow = work + compression names unconditionally', bare, () => [...WORK, ...COMPRESSION])
await trial('D host WITHOUT plugin, allow = work + registered compression', bare, reg => [...WORK, ...COMPRESSION.filter(reg)])
