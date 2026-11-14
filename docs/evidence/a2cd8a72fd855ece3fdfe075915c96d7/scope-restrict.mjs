const DSH = '/Users/seabiscuit/.nvm/versions/node/v24.17.0/lib/node_modules/@deepseek-ai/dsh/node_modules'
const { Context } = await import(`${DSH}/@deepseek-ai/cordis/lib/index.js`)
const { createScope, scopeOf, scopeChainOf } = await import(`${DSH}/@deepseek-ai/dsh-scope/lib/index.js`)
const { ToolsService } = await import(`${DSH}/@deepseek-ai/dsh-tools/lib/index.js`)
const def = n => ({ name: n, description: 'x', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' })
const root = new Context(); root.reflect.provide('systemPrompt', { tools: () => () => {} })
await root.plugin(ToolsService, {})
await root.plugin({ name: 'bili', inject: ['tools'], apply: c => { for (const n of ['compress','decompress','search_context']) c.tools.register(def(n)) } })
const presetKey = {}
createScope(root, presetKey).ctx.plugin({ name: 'preset', inject: ['tools'], apply: c => { for (const n of ['bash','read','grep','skill']) c.tools.register(def(n)) } })
const agentScope = createScope(root, {}, { parent: presetKey })
await agentScope.ctx.plugin({ name: 'agent', inject: ['tools'], apply: c => {
  console.log('scopeOf(agent) defined     :', scopeOf(c) !== undefined, ' chain:', scopeChainOf(scopeOf(c)).length)
  console.log('global view                :', [...c.tools.view(undefined).visible.keys()].sort().join(',') || '(none)')
  console.log('agent view before restrict :', [...c.tools.view(scopeOf(c)).visible.keys()].sort().join(','))
  c.tools.restrict({ allow: ['bash','read','grep','skill'] })
  console.log('agent view after restrict  :', [...c.tools.view(scopeOf(c)).visible.keys()].sort().join(','))
  console.log('agent view, undo           :', (() => { return 'restriction is permanent in this scope' })())
} })
