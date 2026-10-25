// End-to-end test of the tool-router plugin with a mock ctx.
// Simulates the real scenario: the catalog is EMPTY at apply() time, then tools
// register later (tools/change fires) and the index must catch up.

import { apply, name } from './index.js'

// --- mock catalog service (mirrors dsh-tool-manager's toolCatalog) ---
// Starts empty; tools are added after apply() runs.
const toolMap = new Map()
const catalog = {
  get: () => ({ tools: new Map(toolMap) }),
  wireTokens: () => 470,
  load: async (agent, targets) => `Loaded: ${targets.join(', ')}`,
}

// --- mock skills service ---
const fakeSkills = [
  { name: 'dsh-badge', description: 'Add the official dsh badge to documents.', whenToUse: 'When creating a PR.', invocation: { modelInvocable: true, userInvocable: true }, provider: 'test', source: 'builtin' },
  { name: 'plugin-dev', description: 'Develop a DSH plugin.', whenToUse: 'When building a plugin.', invocation: { modelInvocable: true, userInvocable: true }, provider: 'test', source: 'builtin' },
]
const skillsApi = {
  list: async ({ cwd } = {}) => fakeSkills,
  get: async (n) => ({ content: `Body of skill ${n}` }),
}

// --- mock ctx ---
const registered = []
const listeners = {}
const ctx = {
  logger: (scope) => ({ info: (m) => console.log(`[info:${scope}] ${m}`), warn: (m) => console.log(`[warn:${scope}] ${m}`), debug: (m) => console.log(`[debug:${scope}] ${m}`) }),
  toolCatalog: catalog,
  tools: {
    register: (t) => registered.push(t),
    schemas: () => [...toolMap.values()].map((t) => ({ name: t.name, description: t.description })),
  },
  get: (k) => (k === 'skills' ? skillsApi : k === 'workingDirectory' ? { defaultDirectory: '/tmp' } : undefined),
  effect: (fn) => { try { fn() } catch {} },
  on: (ev, cb) => { (listeners[ev] ??= []).push(cb) },
  emit: (ev, payload) => { for (const cb of listeners[ev] ?? []) cb(payload) },
}

console.log(`plugin name: ${name}`)
console.log('catalog at apply() time: EMPTY (simulating plugin load order)')
apply(ctx, {})

// Give the sidecar time to start (it will rebuild an empty index).
await new Promise((r) => setTimeout(r, 1200))

// Now simulate tools registering after apply() (the real scenario).
const lateTools = [
  { name: 'web_search', summary: 'Search the web for current information.', description: 'Search the web.', group: 'search', category: 'search', tokens: 120, highRisk: false },
  { name: 'send_email', summary: 'Send an email to a recipient.', description: 'Send mail.', group: 'email', category: 'mail', tokens: 90, highRisk: false },
  { name: 'github_pr', summary: 'Create a pull request on GitHub.', description: 'Open a PR.', group: 'github', category: 'code', tokens: 200, highRisk: true },
  { name: 'read_file', summary: 'Read a file from disk.', description: 'Read files.', group: 'fs', category: 'files', tokens: 60, highRisk: false },
]
for (const t of lateTools) {
  toolMap.set(t.name, t)
  ctx.emit('tools/change')
}
console.log(`\nregistered ${lateTools.length} tools after apply(); fired tools/change`)

// Wait for the debounced rebuild (200ms) plus margin.
await new Promise((r) => setTimeout(r, 800))

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
console.log(`\nregistered router tools: ${registered.map((t) => t.name).join(', ')}`)

let pass = 0, fail = 0
async function check(label, tool, args, expectName) {
  const out = await tool.execute(args, { agent: { id: 'test' } })
  const ok = out.includes(expectName)
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} (expect "${expectName}")`)
  console.log('  ' + out.split('\n').slice(0, 4).join('\n  '))
  ok ? pass++ : fail++
}

await check('tools_find "search the web"', byName.tools_find, { query: 'search the web' }, 'web_search')
await check('tools_find "send an email"', byName.tools_find, { query: 'send an email' }, 'send_email')
await check('tools_route "create a pull request"', byName.tools_route, { query: 'create a pull request', load: false }, 'github_pr')
await check('skills_find "add a badge"', byName.skills_find, { query: 'add a badge' }, 'dsh-badge')
await check('skills_route "develop a DSH plugin"', byName.skills_route, { query: 'develop a DSH plugin' }, 'plugin-dev')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)