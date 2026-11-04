/**
 * TradingDraw public gateway.
 *
 * dsh web is a single-user, loopback-first app: one process owns one DSH_HOME,
 * one session list and one model context. Serving it to the public therefore
 * needs a hard boundary in front of it, and this is that boundary:
 *
 *   browser ──cookie──> gateway ──loopback──> one dsh child per visitor
 *
 * - Every visitor gets an opaque cookie, their own DSH_HOME and their own dsh
 *   process. Session lists, workspace files and the agent's memory never cross.
 * - The model key lives only in this process's environment and is inherited by
 *   the child. It is never sent to the browser, logged, or embedded in a page.
 * - Prompt quotas (per visitor / per IP / global per UTC day) are enforced
 *   here, because a public model endpoint without a cap is a wallet leak.
 * - WebSocket upgrades are tunnelled, so the workbench's event stream works
 *   unchanged.
 *
 * Nothing here grants tools: the composed profile ships exactly one preset
 * (Market Analyst), and the web surface's bash/fs/subagent rows stay disabled.
 */
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, symlink, readdir, stat, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const PUBLIC_HOST = process.env.DASH_PUBLIC_HOST ?? 'tradingdraw.celineyu.me'
const PROFILE = process.env.DASH_PROFILE ?? 'dash'
const DSH_BIN = process.env.DASH_DSH_BIN ?? '/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const SHARED_HOME = process.env.DASH_SHARED_HOME ?? '/app/dsh-home'
const VISITOR_ROOT = process.env.DASH_VISITOR_ROOT ?? '/data/visitors'
const MAX_CHILDREN = Number(process.env.DASH_MAX_CHILDREN ?? 4)
const IDLE_MS = Number(process.env.DASH_IDLE_MS ?? 8 * 60_000)
const HOME_TTL_MS = Number(process.env.DASH_HOME_TTL_MS ?? 24 * 60 * 60_000)
const BOOT_TIMEOUT_MS = Number(process.env.DASH_BOOT_TIMEOUT_MS ?? 90_000)
const VISITOR_PROMPTS = Number(process.env.DASH_VISITOR_PROMPTS ?? 20)
const IP_PROMPTS = Number(process.env.DASH_IP_PROMPTS ?? 40)
const DAILY_PROMPTS = Number(process.env.DASH_DAILY_PROMPTS ?? 300)
const GATEWAY_TOKEN = process.env.DASH_GATEWAY_TOKEN ?? ''

/** visitorId -> live child */
const visitors = new Map()
/** ip -> {day, count} */
const ipCounts = new Map()
/** `${visitorId}|${day}` -> count */
const visitorCounts = new Map()

/**
 * Read-only deployment: a visitor may inspect settings and presets but may not
 * rewrite the profile, replace credentials, pick server directories, or open a
 * path in the host. Those RPCs exist in the stock UI; on a public demo they are
 * an attack surface with no legitimate use.
 */
const BLOCKED_METHODS = new Set([
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'settings.openDocument',
  'credentials.set',
  'credentials.unset',
  'host.pickDirectory',
  'host.openPath',
  'agentPreset.copy',
  'agentPreset.remove',
  'agentPreset.openDocument',
])
/** day -> global count */
let globalCount = { day: utcDay(), count: 0 }

function utcDay() {
  return new Date().toISOString().slice(0, 10)
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function cookieValue(header, name) {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function secure(request) {
  return (request.headers['x-forwarded-proto'] ?? 'https') === 'https'
}

/**
 * Deterministic fallback identity for a request that arrived without the
 * cookie. Browsers fetch a page's scripts and styles in parallel, and the
 * document's Set-Cookie is not guaranteed to be committed before the first
 * subresource leaves; minting a fresh UUID per request turned one page load
 * into a spawn storm. Hashing the network identity keeps that burst on one
 * visitor until the cookie lands.
 */
function stableId(request) {
  const ip = clientIp(request)
  const ua = request.headers['user-agent'] ?? ''
  const digest = createHash('sha256').update(`${ip}\n${ua}`).digest('hex').slice(0, 32)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim()
  return request.socket.remoteAddress ?? 'unknown'
}

function json(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  response.end(payload)
}

function rpcError(response, rpcId, code, message) {
  json(response, 200, {
    type: 'server-response',
    rpcId: rpcId ?? randomUUID(),
    result: { ok: false, error: { code, message } },
  })
}

function html(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

async function readJson(request, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

async function prepareHome(id) {
  const home = join(VISITOR_ROOT, id)
  const work = join(home, 'work')
  await mkdir(work, { recursive: true })
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) await symlink(join(SHARED_HOME, 'profiles'), profiles, 'dir')
  await seedWorkspace(home, work)
  await seedSettings(home)
  return { home, work }
}

/**
 * Pre-acknowledge the stock internal-testing notice.
 *
 * Its acknowledgement is a durable settings write, and the gateway blocks
 * settings writes so a visitor cannot reconfigure the deployment. Seeding the
 * acknowledged version keeps that lock-down and still gives the visitor a
 * usable composer on the first paint.
 */
async function seedSettings(home) {
  const file = join(home, 'settings.yaml')
  const seed = 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n'
  const current = existsSync(file) ? await readFile(file, 'utf8') : ''
  // A home created by an earlier revision already has a settings document.
  // Overwrite only when the acknowledgement is absent: the demo blocks settings
  // writes, so no visitor setting is worth preserving.
  if (current.includes('welcomeNoticeVersion')) return
  await writeFile(file, seed)
}

/**
 * Give the visitor one ready workspace before the app boots.
 *
 * The stock new-session flow asks the host to browse server directories, which
 * is both a filesystem-disclosure surface and useless here — the only sensible
 * workspace is the visitor's own scratch directory. Seeding the durable
 * registry makes the picker offer "TradingDraw" instead of a server browser.
 */
async function seedWorkspace(home, work) {
  const dir = join(home, 'storages')
  const file = join(dir, 'workspace.json')
  if (existsSync(file)) {
    try {
      const state = JSON.parse(await readFile(file, 'utf8'))
      const ids = state?.global?.workspaceIds ?? []
      if (ids.length > 0) {
        // Drop the previous deployment name from returning visitors' pickers.
        for (const id of ids) {
          const record = state?.tables?.workspaces?.[id]
          if (record?.title === 'DASH Trading' || record?.title === 'Proofline') {
            record.title = 'TradingDraw'
            await writeFile(file, JSON.stringify(state, null, 2))
          }
        }
        return
      }
    } catch {
      /* a corrupt seed is replaced below */
    }
  }
  await mkdir(dir, { recursive: true })
  const now = new Date().toISOString()
  const workspaceId = `ws-${randomUUID()}`
  const record = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: work,
          title: 'TradingDraw',
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }
  await writeFile(file, JSON.stringify(record, null, 2))
}

async function waitForPort(port, deadline, alive = () => true) {
  while (Date.now() < deadline) {
    if (!alive()) return false
    const ok = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.setTimeout(500, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}

let spawnLock = Promise.resolve()
function serialize(run) {
  const next = spawnLock.then(run, run)
  spawnLock = next.then(() => undefined, () => undefined)
  return next
}

async function startVisitor(id) {
  return serialize(() => startVisitorLocked(id))
}

async function startVisitorLocked(id) {
  const existing = visitors.get(id)
  if (existing !== undefined && existing.process.exitCode === null) return existing
  if (visitors.size >= MAX_CHILDREN) {
    // At capacity, evict the least recently used analyst. Its home survives, so
    // a returning visitor gets the same history after a ~4s respawn. Refusing
    // the new visitor instead would let four idle tabs lock the demo for the
    // whole idle window.
    const oldest = [...visitors.entries()]
      .filter(([, entry]) => (entry.active ?? 0) === 0)
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
    if (oldest === undefined) return undefined
    log('evict', oldest[0], 'for', id)
    oldest[1].process.kill('SIGTERM')
    visitors.delete(oldest[0])
  }
  const { home, work } = await prepareHome(id)
  const port = 3200 + Math.floor(Math.random() * 1800)
  const child = spawn(
    process.execPath,
    [DSH_BIN, '--profile', PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open', '--trusted-host', PUBLIC_HOST],
    {
      cwd: work,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        BROWSER: 'true',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const entry = { id, port, home, work, process: child, lastSeen: Date.now(), startedAt: Date.now(), active: 0 }
  visitors.set(id, entry)
  child.stdout.on('data', chunk => log(`[${id}] ${chunk.toString().trimEnd()}`))
  child.stderr.on('data', chunk => log(`[${id}!] ${chunk.toString().trimEnd()}`))
  child.on('exit', (code, signal) => {
    log('child exit', id, code, signal)
    if (visitors.get(id) === entry) visitors.delete(id)
  })
  const ready = await waitForPort(port, Date.now() + BOOT_TIMEOUT_MS, () => child.exitCode === null)
  if (!ready) {
    log('child boot timeout', id)
    child.kill('SIGTERM')
    visitors.delete(id)
    return undefined
  }
  log('child ready', id, port)
  return entry
}

function consumeQuota(request, id) {
  const day = utcDay()
  if (globalCount.day !== day) globalCount = { day, count: 0 }
  const ip = clientIp(request)
  const ipEntry = ipCounts.get(ip)
  const ipCount = ipEntry !== undefined && ipEntry.day === day ? ipEntry.count : 0
  const visitorKey = `${id}|${day}`
  const visitorCount = visitorCounts.get(visitorKey) ?? 0
  if (visitorCount >= VISITOR_PROMPTS) return `This browser has used its ${VISITOR_PROMPTS} prompts for today. Come back tomorrow.`
  if (ipCount >= IP_PROMPTS) return `This network has used its ${IP_PROMPTS} prompts for today. Come back tomorrow.`
  if (globalCount.count >= DAILY_PROMPTS) return 'The public demo has used its model budget for today. Come back tomorrow.'
  ipCounts.set(ip, { day, count: ipCount + 1 })
  visitorCounts.set(visitorKey, visitorCount + 1)
  globalCount.count += 1
  return undefined
}

function upstreamHeaders(request, entry) {
  // The gateway IS the trust boundary: it has already checked the shared
  // front-door header and owns the cookie. Present the request to the child as
  // what it is — a loopback call — and strip the browser markers that would
  // otherwise make dsh's DNS-rebinding fence reject a proxied POST.
  const headers = { ...request.headers, host: `127.0.0.1:${entry.port}` }
  delete headers.connection
  delete headers.origin
  delete headers.referer
  delete headers['sec-fetch-site']
  delete headers['sec-fetch-mode']
  delete headers['sec-fetch-dest']
  return headers
}

function proxy(entry, request, response) {
  entry.lastSeen = Date.now()
  entry.active += 1
  const done = () => {
    entry.active = Math.max(0, entry.active - 1)
  }
  response.once('finish', done)
  response.once('close', done)
  const headers = upstreamHeaders(request, entry)
  const upstream = http.request(
    { hostname: '127.0.0.1', port: entry.port, method: request.method, path: request.url, headers },
    upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders.connection
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.pipe(response)
    },
  )
  upstream.on('error', error => {
    log('proxy error', entry.id, error.message)
    if (!response.headersSent) html(response, 502, '<h1>Temporarily unavailable</h1><p>The workbench process did not answer. Reload to retry.</p>')
    else response.destroy()
  })
  request.pipe(upstream)
}

function upgrade(entry, request, socket, head) {
  entry.lastSeen = Date.now()
  entry.active += 1
  socket.once('close', () => {
    entry.active = Math.max(0, entry.active - 1)
  })
  // A raw TCP tunnel, not http.request: once the gateway has authorized the
  // upgrade there is nothing HTTP left to interpret, and hand-rolling the
  // handshake avoids Node's upgrade path dropping Connection/Upgrade headers.
  const upstream = net.connect(entry.port, '127.0.0.1', () => {
    const lines = [`GET ${request.url} HTTP/1.1`]
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i].toLowerCase()
      if (key === 'host' || key === 'origin' || key === 'connection' || key === 'upgrade') continue
      lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
    }
    lines.push(`Host: 127.0.0.1:${entry.port}`)
    lines.push('Connection: Upgrade')
    lines.push('Upgrade: websocket')
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${PUBLIC_HOST}`)

  if (url.pathname === '/__health') {
    return json(response, 200, { ok: true, visitors: visitors.size, day: globalCount.day, prompts: globalCount.count })
  }

  if (GATEWAY_TOKEN.length > 0 && request.headers['x-dash-gateway'] !== GATEWAY_TOKEN) {
    return html(response, 403, '<h1>Forbidden</h1><p>This endpoint is served through the TradingDraw front door.</p>')
  }

  let id = cookieValue(request.headers.cookie, 'dash_vid')
  const fresh = id === undefined || !/^[a-f0-9-]{36}$/.test(id)
  if (fresh) id = stableId(request)

  let entry = await startVisitor(id)
  if (entry === undefined) {
    return html(response, 503, '<h1>The demo is at capacity</h1><p>Four analysts are already running. Try again in a minute.</p>')
  }

  const method = url.pathname.startsWith('/api/') ? url.pathname.slice('/api/'.length) : ''
  if (BLOCKED_METHODS.has(method)) {
    let body
    try {
      body = await readJson(request)
    } catch {
      body = undefined
    }
    // The stock onboarding notice acknowledges itself through this namespace;
    // refusing it would leave every first-time visitor behind a modal. Nothing
    // else in the settings document is writable.
    const onboardingAck = method === 'settings.mutate' && body?.payload?.ns === 'ui-onboarding'
    if (!onboardingAck) {
      return rpcError(response, body?.rpcId, 'forbidden', 'This is a read-only public demo; that setting is fixed.')
    }
    return proxyJson(entry, request, response, body)
  }

  if (url.pathname === '/api/session.prompt' && request.method === 'POST') {
    // Read the body once so we can both count the prompt and forward it.
    let body
    try {
      body = await readJson(request)
    } catch {
      return rpcError(response, undefined, 'bad-request', 'Request body too large.')
    }
    const refused = consumeQuota(request, id)
    if (refused !== undefined) return rpcError(response, body?.rpcId, 'rate-limited', refused)
    response.setHeader('set-cookie', `dash_vid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure(request) ? '; Secure' : ''}`)
    return proxyJson(entry, request, response, body)
  }

  response.setHeader('set-cookie', `dash_vid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure(request) ? '; Secure' : ''}`)
  proxy(entry, request, response)
})

function proxyJson(entry, request, response, body) {
  entry.lastSeen = Date.now()
  entry.active += 1
  const done = () => {
    entry.active = Math.max(0, entry.active - 1)
  }
  response.once('finish', done)
  response.once('close', done)
  const payload = JSON.stringify(body ?? {})
  const headers = {
    ...upstreamHeaders(request, entry),
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  }
  const upstream = http.request(
    { hostname: '127.0.0.1', port: entry.port, method: 'POST', path: request.url, headers },
    upstreamResponse => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders.connection
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
      upstreamResponse.pipe(response)
    },
  )
  upstream.on('error', error => {
    log('proxy error', entry.id, error.message)
    if (!response.headersSent) rpcError(response, body?.rpcId, 'unavailable', 'The workbench process did not answer. Reload to retry.')
    else response.destroy()
  })
  upstream.end(payload)
}

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${PUBLIC_HOST}`)
  if (GATEWAY_TOKEN.length > 0 && request.headers['x-dash-gateway'] !== GATEWAY_TOKEN) {
    socket.destroy()
    return
  }
  let id = cookieValue(request.headers.cookie, 'dash_vid')
  if (id === undefined || !/^[a-f0-9-]{36}$/.test(id)) id = stableId(request)
  const entry = await startVisitor(id)
  if (entry === undefined) {
    socket.destroy()
    return
  }
  upgrade(entry, request, socket, head)
})

// Idle reaping keeps the container inside its memory budget: a dsh child is
// ~200MB, and four idle ones are not worth paying for.
setInterval(() => {
  for (const [id, entry] of visitors) {
    if (Date.now() - entry.lastSeen > IDLE_MS) {
      log('idle reap', id)
      entry.process.kill('SIGTERM')
      visitors.delete(id)
    }
  }
}, 60_000).unref()

// Visitor homes survive a process reap so a returning cookie keeps its chat.
setInterval(async () => {
  try {
    for (const name of await readdir(VISITOR_ROOT)) {
      const info = await stat(join(VISITOR_ROOT, name))
      if (Date.now() - info.mtimeMs > HOME_TTL_MS && !visitors.has(name)) {
        await rm(join(VISITOR_ROOT, name), { recursive: true, force: true })
      }
    }
  } catch {
    /* root may not exist yet */
  }
}, 30 * 60_000).unref()

server.listen(PORT, '0.0.0.0', () => {
  log(`gateway listening on ${PORT}; public host ${PUBLIC_HOST}; max ${MAX_CHILDREN} analysts`)
})
