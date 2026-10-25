// dsh-tool-router: retrieval + routing over an unbounded tool catalog.
//
// dsh-tool-manager gives the model a directory and on-demand loading, but the
// model still has to guess the right keywords and spend turns searching. This
// plugin adds the retrieval layer that makes an unbounded catalog usable:
//
//   tools_find(query)   -> ranked matches (BM25, model-free, always available)
//   tools_route(query)  -> ranked matches, then loads them (the router)
//
// Retrieval is BM25 by default: no model, no network, works offline, and scales
// to a large catalog. When a model is configured (config.model {provider,
// model}), tools_route re-ranks the BM25 candidates with the model, so a
// natural-language intent that shares no words with a tool name still finds it.
// That is the RAG-MCP pattern: retrieve a small candidate set, then rank it.
//
// The BM25 index lives in a Rust sidecar process (sidecar/, tantivy over a Unix
// socket) for headroom: the hot path is native and the TypeScript here is a
// thin client. A dependency-free JS BM25 index is kept as the always-available
// fallback, so retrieval never breaks if the sidecar binary is missing or the
// process dies.
//
// It consumes dsh-tool-manager's `toolCatalog` service when present, so it
// reuses the catalog, the load path, and the token accounting. Without it, it
// falls back to the raw tool schemas and its own token estimate; tools_route
// then only retrieves (there is no load path to drive).
//
// Tool definitions are built by hand (no @deepseek-ai/dsh-tools import) so the
// bundle resolves in any profile without that package in its node_modules.

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'tool-router'
export const inject = ['tools', 'toolCatalog']

const pluginDir = dirname(fileURLToPath(import.meta.url))
// The npm package ships a prebuilt binary under sidecar/bin/; a source checkout
// has a dev build under sidecar/target/release/. Prefer the shipped one.
const sidecarBin = [
  join(pluginDir, 'sidecar', 'bin', 'tool-router-sidecar'),
  join(pluginDir, 'sidecar', 'target', 'release', 'tool-router-sidecar'),
].find(existsSync)
const sidecarSocket = join(pluginDir, '.sidecar.sock')

// --- JS BM25 (fallback) ------------------------------------------------------
//
// A small, dependency-free BM25 index. It is the always-available baseline:
// ranked retrieval that needs no model, no network, and no sidecar process.

function tokenize(text) {
  const out = []
  const flat = String(text ?? '').toLowerCase()
  for (const m of flat.matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  for (const ch of flat) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) out.push(ch)
  return out
}

class Bm25 {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = []
    this.df = new Map()
    this.avgLen = 0
    this.n = 0
  }

  build(docs) {
    this.docs = docs.map((d, i) => {
      const tokens = tokenize(d.text)
      const tf = new Map()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      return { id: i, ref: d.ref, tf, len: tokens.length }
    })
    this.df = new Map()
    for (const doc of this.docs) for (const term of doc.tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    this.n = this.docs.length
    this.avgLen = this.n ? this.docs.reduce((s, d) => s + d.len, 0) / this.n : 0
  }

  idf(term) {
    const df = this.df.get(term) ?? 0
    return Math.log((this.n - df + 0.5) / (df + 0.5) + 1)
  }

  search(query, limit = 8) {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length || !this.n) return []
    const scored = []
    for (const doc of this.docs) {
      let score = 0
      for (const term of terms) {
        const tf = doc.tf.get(term) ?? 0
        if (!tf) continue
        score += this.idf(term) * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (doc.len / (this.avgLen || 1))))
      }
      if (score > 0) scored.push({ ref: doc.ref, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }
}

// --- Rust sidecar client -----------------------------------------------------
//
// A thin client over the Rust sidecar. It spawns the binary, pushes the
// catalog on change, and asks for ranked hits. Any failure (missing binary,
// dead process, timeout) resolves to null so the caller falls back to the JS
// BM25 index.

class Sidecar {
  constructor({ bin = sidecarBin, socket = sidecarSocket, timeoutMs = 2000, logger } = {}) {
    this.bin = bin
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.child = null
    this.sock = null
    this.buf = ''
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
  }

  async start() {
    if (!existsSync(this.bin)) {
      this.logger?.warn?.(`tool-router: sidecar binary not found at ${this.bin}; using JS BM25`)
      return false
    }
    try {
      this.child = spawn(this.bin, ['--socket', this.socket], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.child.stderr.on('data', (d) => this.logger?.debug?.(`tool-router sidecar: ${String(d).trim()}`))
      this.child.on('exit', (code) => {
        this.logger?.warn?.(`tool-router: sidecar exited (code ${code}); falling back to JS BM25`)
        this.ready = false
        this.sock?.destroy()
        this.sock = null
      })
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await this._connect()
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      if (!this.sock) { this.logger?.warn?.('tool-router: sidecar start: no socket after connect loop'); return false }
      const pong = await this._request({ op: 'ping' })
      if (!pong?.ok) { this.logger?.warn?.(`tool-router: sidecar start: ping failed: ${JSON.stringify(pong)}`); return false }
      this.ready = true
      this.logger?.info?.('tool-router: Rust sidecar active (tantivy BM25)')
      return true
    } catch (caught) {
      this.logger?.warn?.(`tool-router: sidecar start failed: ${caught?.message ?? caught}`)
      return false
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const s = connect({ path: this.socket })
      s.once('connect', () => {
        this.sock = s
        s.setEncoding('utf8')
        s.on('data', (chunk) => this._onData(chunk))
        s.on('close', () => { this.ready = false; this.sock = null })
        s.on('error', () => {})
        resolve()
      })
      s.once('error', reject)
    })
  }

  _onData(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const id = msg.id
      if (id === undefined) continue
      const p = this.pending.get(id)
      if (!p) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.resolve(msg)
    }
  }

  _request(msg, timeoutMs = this.timeoutMs) {
    // Only gate on the socket, not on this.ready: the ping is what sets ready,
    // so gating on ready would make the ping itself unreachable. this.sock is
    // kept in sync with the connection lifecycle (set on connect, nulled on
    // close/exit/stop), so it is the correct liveness check.
    if (!this.sock) return Promise.resolve(null)
    const id = this.nextId++
    msg.id = id
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.sock.write(JSON.stringify(msg) + '\n')
    })
  }

  async index(name, docs) {
    if (!this.ready) return false
    const res = await this._request({ op: 'index', name, docs })
    if (res?.ok) return true
    this.logger?.warn?.(`tool-router: sidecar index ${name} failed: ${res?.error ?? 'no response'}`)
    return false
  }

  async search(index, query, limit) {
    if (!this.ready) return null
    const res = await this._request({ op: 'search', index, query, limit })
    if (!res?.ok) return null
    return res.hits
  }

  stop() {
    try { this.sock?.destroy() } catch { /* ignore */ }
    this.sock = null
    try { this.child?.kill() } catch { /* ignore */ }
    this.child = null
    this.ready = false
  }
}

// --- helpers -----------------------------------------------------------------

function estimateTokens(schema) {
  const text = JSON.stringify(schema)
  let wide = 0
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) wide += 1
  return Math.ceil((text.length - wide) / 4 + wide)
}

function fmtTokens(n) {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`
}

function firstLine(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const first = flat.split(/(?<=[.!?。！？])\s/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

function toolText(t) {
  return `${t.name} ${t.summary} ${t.description} ${t.group} ${t.category}`
}

function skillText(s) {
  return `${s.name} ${s.summary} ${s.whenToUse ?? ''}`
}

function formatFind(hits) {
  if (!hits.length) return 'No tools matched. Try different words, or tools_ls("/") to browse the directory.'
  const lines = hits.map((h, i) => {
    const t = h.ref
    const risk = t.highRisk ? ' [high risk]' : ''
    return `${i + 1}. ${t.name}\n   ${t.path} · ${fmtTokens(t.tokens)}${risk}\n   ${t.summary}`
  })
  return `Best matches (load with tools_route, or tools_load by path):\n${lines.join('\n')}`
}

function formatSkillFind(hits) {
  if (!hits.length) return 'No skills matched. Try different words.'
  const lines = hits.map((h, i) => {
    const s = h.ref
    const extra = s.whenToUse ? ` — ${s.whenToUse}` : ''
    return `${i + 1}. ${s.name}\n   ${s.summary}${extra}`
  })
  return `Best matching skills (load one with skills_route):\n${lines.join('\n')}`
}

/** Build a tool definition by hand (no @deepseek-ai/dsh-tools dependency). */
function makeTool({ name, description, parameters, execute, isConcurrencySafe }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute,
    isConcurrencySafe,
  }
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-router') : ctx.logger) ?? console
  const catalog = ctx.toolCatalog ?? (typeof ctx.get === 'function' ? ctx.get('toolCatalog') : undefined)
  const bm25 = new Bm25({ k1: config.k1, b: config.b })
  const skillBm25 = new Bm25({ k1: config.k1, b: config.b })
  const topK = config.topK ?? 8
  const maxBudget = config.maxBudget ?? 20000
  const model = config.model ?? {}
  const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined)
  const sidecar = new Sidecar({ logger, ...config.sidecar })

  // Refs aligned to index doc ids (the sidecar returns doc ids; we map them
  // back to these refs). Kept in sync with the JS BM25 fallback.
  let toolRefs = []
  let skillRefs = []

  /** The default working directory, used to scope the skill catalog view. */
  function cwdOf() {
    try {
      const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      return wd?.defaultDirectory
    } catch {
      return undefined
    }
  }

  /** Rebuild the tool index (JS fallback + sidecar) from the catalog. */
  function rebuild() {
    let tools
    if (catalog && typeof catalog.get === 'function') {
      const cat = catalog.get()
      tools = [...cat.tools.values()].map((t) => ({
        name: t.name,
        path: `/${t.category}/${t.group}/${t.short}`,
        summary: t.summary,
        description: t.description,
        group: t.group,
        category: t.category,
        tokens: t.tokens,
        highRisk: t.highRisk === true,
      }))
    } else {
      tools = ctx.tools.schemas().map((s) => ({
        name: s.name,
        path: s.name,
        summary: firstLine(s.description),
        description: s.description ?? '',
        group: '',
        category: '',
        tokens: estimateTokens(s),
        highRisk: false,
      }))
    }
    toolRefs = tools
    bm25.build(tools.map((t) => ({ ref: t, text: toolText(t) })))
    void sidecar.index('tools', tools.map((t) => ({ ref: t, text: toolText(t) })))
  }
  rebuild()

  if (catalog) {
    ctx.effect(() => ctx.on('tool-catalog/after-rebuild', () => rebuild()), 'tool-router.rebuild()')
  }

  // Tools register after this plugin's apply() runs (plugin load order), so the
  // catalog is often empty on the first rebuild. Rebuild again, debounced, when
  // the tool set changes so the index catches up without rebuilding per tool.
  let rebuildTimer = null
  function scheduleRebuild() {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      rebuild()
    }, 200)
    rebuildTimer.unref?.()
  }
  try {
    ctx.effect(() => ctx.on('tools/change', () => { scheduleRebuild() }), 'tool-router.tools-change()')
  } catch (caught) {
    logger?.warn?.(`tool-router: tools/change hook skipped: ${caught?.message ?? caught}`)
  }

  /**
   * Rebuild the skill index from the skill registry. Skills have the same
   * progressive-disclosure shape as tools: a cheap summary (name + description)
   * here, the full body loaded on demand by skills_route.
   */
  async function rebuildSkills() {
    // The skill registry is the cordis `skills` service, looked up via ctx.get
    // (ctx.skills throws when the service is not injected into this plugin).
    // list() takes {cwd, scope}; scope is left undefined for the global layer.
    try {
      const skillsApi = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
      if (!skillsApi || typeof skillsApi.list !== 'function') return
      const cwd = cwdOf()
      const skills = await skillsApi.list({ cwd })
      const refs = skills
        .filter((s) => s.invocation?.modelInvocable !== false)
        .map((s) => ({
          name: s.name,
          summary: s.description,
          whenToUse: s.whenToUse ?? '',
          source: s.source,
          provider: s.provider,
        }))
      skillRefs = refs
      skillBm25.build(refs.map((s) => ({ ref: s, text: skillText(s) })))
      void sidecar.index('skills', refs.map((s) => ({ ref: s, text: skillText(s) })))
    } catch (caught) {
      logger?.warn?.(`tool-router: skill index rebuild failed: ${caught?.message ?? caught}`)
    }
  }

  // Start the sidecar, then rebuild the indexes. The initial rebuild() and
  // rebuildSkills() runs fire before the sidecar is ready (and the catalog may
  // still be empty at apply() time); rebuilding after start() re-reads the
  // catalog and pushes a fresh index now that the sidecar is up.
  void (async () => {
    const ok = await sidecar.start()
    if (!ok) return
    rebuild()
    void rebuildSkills()
  })()

  void rebuildSkills()
  try {
    ctx.effect(() => ctx.on('skills/change', () => { void rebuildSkills() }), 'tool-router.skills-rebuild()')
  } catch (caught) {
    logger?.warn?.(`tool-router: skills change hook skipped: ${caught?.message ?? caught}`)
  }

  // Kill the sidecar child and clear the pending rebuild on disposal.
  ctx.effect(() => () => {
    if (rebuildTimer) clearTimeout(rebuildTimer)
    sidecar.stop()
  }, 'tool-router.sidecar-stop()')

  /** Search the tool index: sidecar first, JS BM25 fallback. */
  async function searchTools(query, limit) {
    const hits = await sidecar.search('tools', query, limit)
    if (hits) return hits.map((h) => ({ ref: toolRefs[h.id], score: h.score }))
    return bm25.search(query, limit)
  }

  /** Search the skill index: sidecar first, JS BM25 fallback. */
  async function searchSkills(query, limit) {
    const hits = await sidecar.search('skills', query, limit)
    if (hits) return hits.map((h) => ({ ref: skillRefs[h.id], score: h.score }))
    return skillBm25.search(query, limit)
  }

  /**
   * Optional model re-rank of the BM25 candidates. Returns the top-k refs.
   * Any failure falls back to the BM25 order, so the router never breaks on a
   * model hiccup.
   */
  async function rerank(query, candidates, k) {
    if (!llm || !model.provider || !model.model || candidates.length <= k) return candidates.slice(0, k)
    const list = candidates.map((c, i) => `${i + 1}. ${c.ref.name}: ${c.ref.summary}`).join('\n')
    const prompt = [
      'You are a tool router. Pick the tools that best fit the task.',
      '',
      `Task: ${query}`,
      '',
      'Candidates:',
      list,
      '',
      `Return the numbers of the best tools, comma-separated, at most ${k}. If none fit, return "none".`,
    ].join('\n')
    try {
      let text = ''
      let finished = false
      const options = {
        provider: model.provider,
        model: model.model,
        system: 'You are a strict tool router. You answer with numbers only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: config.maxTokens ?? 24,
        temperature: 0,
      }
      for await (const chunk of llm.stream(options)) {
        if (finished) break
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk.type === 'finish') finished = true
      }
      const picks = String(text).split(/[,\s]+/).map((s) => Number.parseInt(s, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
      const unique = [...new Set(picks)].slice(0, k).map((n) => candidates[n - 1])
      return unique.length ? unique : candidates.slice(0, k)
    } catch (caught) {
      logger?.warn?.(`tool-router: re-rank failed, using BM25 order: ${caught?.message ?? caught}`)
      return candidates.slice(0, k)
    }
  }

  function budgetReport(agent) {
    if (!catalog || typeof catalog.wireTokens !== 'function') return ''
    const tokens = catalog.wireTokens(agent)
    const pct = Math.round((tokens / maxBudget) * 100)
    return `Context budget: ${tokens} tokens of loaded tool schemas (${pct}% of the ${maxBudget} budget)${tokens > maxBudget ? ' — OVER budget; unload tools you no longer need' : ''}`
  }

  // --- tools_find --------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'tools_find',
    description:
      'Search the whole tool catalog by intent. Describe what you want to do in plain words (e.g. "send an email", "search the web", "read a PDF"); it returns the best-matching tools ranked by relevance, each with its path, one-line summary, and schema size. Use this before loading when you are not sure which tool fits. It retrieves only; it does not load anything.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in plain words.' },
        limit: { type: 'number', description: `How many matches to return (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return formatFind(await searchTools(args.query, args.limit ?? topK))
    },
  }))

  // --- tools_route -------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'tools_route',
    description:
      'Find the tools that fit a task and load them in one step. Describe the task in plain words; it retrieves the best matches, re-ranks them with the model when one is configured, and loads them so they are callable from your next step. Use this to get set up for a task without browsing the directory. Pass load=false to only retrieve, without loading.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task, in plain words.' },
        limit: { type: 'number', description: `How many tools to load (default ${topK}).` },
        load: { type: 'boolean', description: 'Load the matches (default true). Set false to only retrieve.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const want = args.limit ?? topK
      const candidates = await searchTools(args.query, Math.max(want, 10))
      const ranked = await rerank(args.query, candidates, want)
      if (args.load === false || !catalog) return formatFind(ranked)
      if (!agent) return formatFind(ranked)
      const targets = ranked.map((h) => h.ref.name)
      const result = await catalog.load(agent, targets)
      const budget = budgetReport(agent)
      return budget ? `${result}\n${budget}` : result
    },
  }))

  // --- skills_find -------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'skills_find',
    description:
      'Search the whole skill catalog by intent. Describe the kind of task you are doing (e.g. "write a pull request", "develop a DSH plugin", "add a badge"); it returns the best-matching skills ranked by relevance, each with its name and one-line description. Use this before loading when you are not sure which skill fits. It retrieves only; it does not load anything.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The kind of task you are doing, in plain words.' },
        limit: { type: 'number', description: `How many matches to return (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return formatSkillFind(await searchSkills(args.query, args.limit ?? topK))
    },
  }))

  // --- skills_route ------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'skills_route',
    description:
      'Find the best skill for a task and load its full instructions in one step. Describe the task in plain words; it retrieves the best matches, re-ranks them with the model when one is configured, and returns the top skill\'s complete body so you can act on it immediately. Use this to get the right instructions without browsing the skill catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task, in plain words.' },
        limit: { type: 'number', description: `How many candidates to consider (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const want = args.limit ?? topK
      const candidates = await searchSkills(args.query, Math.max(want, 5))
      if (!candidates.length) return 'No skills matched. Try different words.'
      const ranked = await rerank(args.query, candidates, want)
      const top = ranked[0]
      let body = ''
      try {
        const skillsApi = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
        const def = skillsApi ? await skillsApi.get(top.ref.name, { cwd: cwdOf() }) : undefined
        if (def?.content) body = def.content
      } catch {
        // fall through to the summary
      }
      const others = ranked.slice(1).map((r) => r.ref.name)
      const header = `Loaded skill "${top.ref.name}"${top.ref.source ? ` (source: ${top.ref.source})` : ''}:`
      const rest = body ? `\n\n${body}` : `\n\n${top.ref.summary}${top.ref.whenToUse ? ` — ${top.ref.whenToUse}` : ''}`
      return others.length ? `${header}${rest}\n\nOther candidates: ${others.join(', ')}` : `${header}${rest}`
    },
  }))

  if (!catalog) logger?.info?.('tool-router: no toolCatalog service; tools_route retrieves only (install dsh-tool-manager to enable loading)')
}

export default { name, inject, apply }