// Extract the SHIPPED gate functions from bili's dist bundle and run them on the tool lists
// observed in bili.log — reproduces "surface=off" without any model traffic.
import { readFileSync } from 'node:fs'
const src = readFileSync('/Users/seabiscuit/.dsh/profiles/superagent/node_modules/billion-context/dist/index.js', 'utf8')
function pluck(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`not found: ${name}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced: ${name}`)
}
const profSlice = src.slice(src.indexOf('var PROFILES='), src.indexOf('function hostProfileFor('))
const code = [
  profSlice,
  pluck('hostProfileFor'), pluck('observeDeclaredTools'), pluck('resolveLaneDecisions'),
].join('\n')
export const gate = new Function(`
  ${code}
  // Faithful stand-ins for the two wire helpers (they only decide "is this name declared?").
  const declaredToolEntries = (parsed, protocol) => parsed.tools ?? []
  const biliToolsDeclaredOnWire = (_body, _protocol, name) => typeof name === 'string' && name.length > 0
  const mcpBiliToolName = (n) => 'mcp__bili__' + n
  const CODE_MODE_OMNIBUS_TOOL_NAMES = ['run_code']
  const extractBillingAttributionBlock = () => undefined
  const systemOf = (p) => p?.system
  return { resolveLaneDecisions, PROFILES, observeDeclaredTools }
`)()
export function decide(toolNames) {
  return gate.resolveLaneDecisions({
    protocol: 'openai',
    pluginMode: true,
    pluginAgent: 'dsh',
    parsed: { tools: toolNames.map(n => ({ type: 'function', function: { name: n } })) },
    shouldInject: true,
    pluginHeaderPresent: true,
  })
}
