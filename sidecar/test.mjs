// Standalone smoke test for the tool-router-sidecar.
// Spawns the binary, pushes a small tool catalog, and checks search results.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bin = process.argv[2] ?? 'target/release/tool-router-sidecar'
const dir = mkdtempSync(join(tmpdir(), 'sidecar-test-'))
const socket = join(dir, 'test.sock')

const child = spawn(bin, ['--socket', socket], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => process.stdout.write(`[sidecar out] ${d}`))
child.stderr.on('data', (d) => process.stdout.write(`[sidecar err] ${d}`))

function connectWithRetry(path, attempts = 50) {
  return new Promise((resolve, reject) => {
    let n = 0
    const tryConnect = () => {
      const s = connect({ path })
      s.once('connect', () => resolve(s))
      s.once('error', () => {
        s.destroy()
        if (++n >= attempts) reject(new Error('connect failed'))
        else setTimeout(tryConnect, 100)
      })
    }
    tryConnect()
  })
}

const sock = await connectWithRetry(socket)
sock.setEncoding('utf8')

let buf = ''
const pending = new Map()
let nextId = 1
sock.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg) }
  }
})

function request(msg, timeoutMs = 3000) {
  const id = nextId++
  msg.id = id
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null) }, timeoutMs)
    pending.set(id, { resolve, timer })
    sock.write(JSON.stringify(msg) + '\n')
  })
}

const pong = await request({ op: 'ping' })
console.log('ping:', JSON.stringify(pong))

const tools = [
  { ref: { name: 'web_search', summary: 'Search the web for current information.' }, text: 'web_search Search the web for current information. search web' },
  { ref: { name: 'send_email', summary: 'Send an email to a recipient.' }, text: 'send_email Send an email to a recipient. email mail' },
  { ref: { name: 'read_pdf', summary: 'Read a PDF file and extract text.' }, text: 'read_pdf Read a PDF file and extract text. pdf document' },
  { ref: { name: 'github_pr', summary: 'Create a pull request on GitHub.' }, text: 'github_pr Create a pull request on GitHub. github pull request pr' },
]
const idx = await request({ op: 'index', name: 'tools', docs: tools })
console.log('index:', JSON.stringify(idx))

const s1 = await request({ op: 'search', index: 'tools', query: 'search the web', limit: 3 })
console.log('search "search the web":', JSON.stringify(s1))

const s2 = await request({ op: 'search', index: 'tools', query: 'send an email', limit: 3 })
console.log('search "send an email":', JSON.stringify(s2))

const s3 = await request({ op: 'search', index: 'tools', query: 'pull request', limit: 3 })
console.log('search "pull request":', JSON.stringify(s3))

const stats = await request({ op: 'stats' })
console.log('stats:', JSON.stringify(stats))

// Assertions
let pass = true
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) pass = false
}
check('ping ok', pong?.ok === true)
check('index count 4', idx?.count === 4)
check('web search top hit is web_search', s1?.hits?.[0]?.id === 0)
check('email top hit is send_email', s2?.hits?.[0]?.id === 1)
check('pr top hit is github_pr', s3?.hits?.[0]?.id === 3)

sock.end()
child.kill()
console.log(pass ? 'ALL PASS' : 'SOME FAILED')
process.exit(pass ? 0 : 1)