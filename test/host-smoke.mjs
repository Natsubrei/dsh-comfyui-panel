/**
 * Host smoke test. It exercises the proxy, the workflow/event bridges, the
 * session-scoped tools, persistence, and the process supervisor against mock
 * upstreams. It does not start a browser or a real ComfyUI.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, applySeedControls, collectOutputImages, outputImageMediaType, redactCookieHeader, redactRawHeaderPairs, takeCommand } from '../index.js'
import { createCommandChannel } from '../commands.js'
import { createSessionStore } from '../session-store.js'
import { createSupervisor } from '../supervisor.js'
import { stopsOnUnload } from '../service.js'

/**
 * Ports come as a contiguous block of five so several checkouts can run the
 * suite at once: `DSH_COMFYUI_TEST_PORT=19188 npm test`. The default block is
 * the historical one.
 */
const PORT_BASE = Number(process.env.DSH_COMFYUI_TEST_PORT ?? 18188)
if (!Number.isSafeInteger(PORT_BASE) || PORT_BASE < 1024 || PORT_BASE > 65531) {
  throw new Error(`DSH_COMFYUI_TEST_PORT must leave five free ports (1024-65531), got ${String(process.env.DSH_COMFYUI_TEST_PORT)}`)
}
const UPSTREAM_PORT = PORT_BASE
const PROXY_PORT = PORT_BASE + 1
const SUPERVISOR_PORT = PORT_BASE + 3

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One Host stand-in: routes, tools, agents, and a shared storage medium. */
function createHost(storage, services = new Map()) {
  const routes = new Map()
  const fetches = new Map()
  const handlers = new Map()
  const agents = new Map()
  const disposers = []
  const host = {
    routes,
    fetches,
    agents,
    services,
    logger: { info() {}, warn() {}, error() {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register(route) { routes.set(route.path, route); return () => {} },
      registerUpgrade(route) { routes.set(`upgrade:${route.path}`, route); return () => {} },
    },
    connection: {
      admit() { return { peer: {} } },
      fetch: { register(route) { fetches.set(route.path, route); return async () => {} } },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id), list: () => [...agents.values()] }
      if (name === 'storageDomain') return storage
      return services.get(name)
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
  return host
}

/** A per-agent context stand-in: scoped tool registry + prompt contexts. */
function agentScope(sessionId) {
  const tools = new Map()
  const contexts = []
  const disposers = []
  const ctx = {
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: {
      context(entry) {
        contexts.push(entry)
        return () => {
          const index = contexts.indexOf(entry)
          if (index !== -1) contexts.splice(index, 1)
        }
      },
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    tools,
    contexts,
    digest: () => contexts.find(entry => entry.name === 'comfyui:workflow')?.text() ?? '',
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function addAgent(host, sessionId) {
  const scope = agentScope(sessionId)
  const agent = { id: sessionId, session: { id: sessionId }, ctx: scope.ctx }
  host.agents.set(sessionId, agent)
  host.emit('agent/created', { agent })
  return scope
}

/** Storage medium shared across Host instances, like the JSON backend file. */
function createStorage(state = { sessions: new Map(), workflows: new Map(), settings: new Map() }) {
  const opened = []
  return {
    state,
    opened,
    async open(spec) {
      opened.push(spec)
      for (const value of state.sessions.values()) spec.tables.sessions.valueSchema.parse(value)
      const tableFor = name => {
        const records = state[name]
        if (records === undefined) throw new Error(`undeclared table ${name}`)
        return {
          get: key => records.get(key),
          entries: () => records.entries(),
          get size() { return records.size },
          async put(key, value) { records.set(key, value) },
          async delete(key) { return records.delete(key) },
        }
      }
      return { table: tableFor, close: async () => {} }
    },
  }
}

const execOf = sessionId => ({
  agent: {
    session: { id: sessionId },
    options: { provider: 'mock-llm', model: 'mock-vision' },
  },
  signal: new AbortController().signal,
})
const parse = value => JSON.parse(value.text)
/** The diagnostics row for one layer, or undefined when the report has no such row. */
const diagnosticRow = (report, layer) => report.diagnostics.find(row => row.layer === layer)

// ── Mock ComfyUI upstream ─────────────────────────────────────────────────

/** Bodies the proxy forwarded to /prompt, newest last. */
const queuedBodies = []
/** Bodies the proxy forwarded to /interrupt, newest last. */
const interruptedBodies = []
/** Cookie headers the proxy forwarded, newest last. */
const upstreamCookies = []
/** What the mock reports from /queue; the tracker test scripts a run here. */
const mockQueue = { queue_running: [], queue_pending: [] }
/** What the mock reports from /history/{id}; the tracker test adds the settled run. */
const mockHistory = {
  p1: { status: { status_str: 'success', completed: true, messages: [] }, outputs: {} },
}
/** The prompt id the next /prompt call returns. */
let promptIdToReturn = 'p1'
/** The frontend version the mock /system_stats reports; one test changes it. */
let frontendVersionToReport = '1.57.1'
/** Query parameters the mock received on /view, newest last. */
const viewRequests = []
/** A real 1x1 PNG, so the attachment stand-in receives decodable bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const upstream = http.createServer((req, res) => {
  upstreamCookies.push(req.headers.cookie ?? '')
  if (req.url === '/system_stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      system: {
        comfyui_version: '0.42.0',
        comfy_package_versions: [
          { name: 'comfyui-frontend-package', installed: frontendVersionToReport, required: '1.57.1' },
        ],
      },
    }))
    return
  }
  if (req.url.startsWith('/view')) {
    const url = new URL(req.url, 'http://127.0.0.1')
    viewRequests.push(Object.fromEntries(url.searchParams))
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length })
    res.end(PNG_BYTES)
    return
  }
  if (req.url === '/prompt' && req.method === 'POST') {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        queuedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        queuedBodies.push(null)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: promptIdToReturn, number: 1, node_errors: {} }))
    })
    return
  }
  if (req.url === '/interrupt' && req.method === 'POST') {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        interruptedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        interruptedBodies.push(null)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    return
  }
  if (req.url === '/assets/app-abc123.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end('console.log("app")')
    return
  }
  if (req.url === '/object_info') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      KSampler: {
        category: 'sampling',
        input: { required: { model: ['MODEL', {}], seed: ['INT', {}], steps: ['INT', {}] } },
        output: ['LATENT'],
        output_name: ['LATENT'],
      },
    }))
    return
  }
  if (req.url === '/queue') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(mockQueue))
    return
  }
  if (req.url.startsWith('/history/')) {
    const promptId = decodeURIComponent(req.url.slice('/history/'.length))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(mockHistory[promptId] === undefined ? {} : { [promptId]: mockHistory[promptId] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>mock comfy</title><div id="ok">mock</div>')
})

await new Promise(resolve => { upstream.listen(UPSTREAM_PORT, '127.0.0.1', () => { resolve(undefined) }) })

// ── Proxy, bridge, and session tools ──────────────────────────────────────

const storage = createStorage()
storage.state.sessions.set('s-restored', {
  sessionId: 's-restored',
  revision: 7,
  updatedAt: Date.now() - 60000,
  workflow: {
    nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'EmptyLatentImage' }],
    links: [[1, 2, 0, 1, 0, 'LATENT']],
  },
  prompt: { 1: { class_type: 'KSampler', inputs: {} }, 2: { class_type: 'EmptyLatentImage', inputs: {} } },
  semantic: {
    nodes: [
      { id: 1, type: 'KSampler', widgets: { steps: 8 }, inputs: { latent_image: '2:0' } },
      { id: 2, type: 'EmptyLatentImage', widgets: { width: 1024 }, inputs: {} },
    ],
    linkCount: 1,
    selection: [],
  },
})

const host = createHost(storage)
const restoredScope = addAgent(host, 's-restored')
apply(host, { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, prefix: '/comfyui' })
await delay(50)

// Restored session gets tools and its projection before the panel ever opens.
assert.ok(restoredScope.tools.has('comfyui_graph_read'), 'restored session should get tools')
const restoredRead = parse(await restoredScope.tools.get('comfyui_graph_read').execute({}, execOf('s-restored')))
assert.equal(restoredRead.revision, 7)
assert.equal(restoredRead.nodes.find(node => node.id === 1).widgets.steps, 8)
assert.equal(restoredRead.nodes.find(node => node.id === 1).inputs.latent_image, '2:0')
const restoredStatus = parse(await restoredScope.tools.get('comfyui_status').execute({}, execOf('s-restored')))
assert.equal(restoredStatus.persistence.backend, 'storage')
assert.equal(restoredStatus.service.state, 'stopped')
assert.equal(restoredStatus.service.settings, null)
assert.equal(restoredStatus.panelConnected, false)

const proxyServer = http.createServer((req, res) => {
  host.routes.get('/comfyui').handler(req, res)
})
await new Promise(resolve => { proxyServer.listen(PROXY_PORT, '127.0.0.1', () => { resolve(undefined) }) })

const page = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/`)
assert.equal(page.status, 200)
assert.match(await page.text(), /mock comfy/)

const redirect = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui`, { redirect: 'manual' })
assert.equal(redirect.status, 308)
assert.equal(redirect.headers.get('location'), '/comfyui/')

const asset = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/assets/app-abc123.js`)
assert.equal(asset.status, 200)
assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')

// DSH admission cookies stay on the DSH origin. ComfyUI's own cookies still cross.
upstreamCookies.length = 0
const forwarded = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/`, {
  headers: { cookie: 'dsh-auth-abc=secret; comfy_session=keep; dsh-auth=also' },
})
assert.equal(forwarded.status, 200)
assert.equal(upstreamCookies.at(-1), 'comfy_session=keep')
upstreamCookies.length = 0
const stripped = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/`, {
  headers: { cookie: 'dsh-auth-abc=secret' },
})
assert.equal(stripped.status, 200)
assert.equal(upstreamCookies.at(-1), '')
assert.equal(redactCookieHeader('dsh-auth-abc=secret; theme=dark'), 'theme=dark')
assert.deepEqual(
  redactRawHeaderPairs(['Cookie', 'dsh-auth-abc=secret', 'Origin', 'http://dsh', 'X-Trace', '1']),
  ['X-Trace', '1'],
)

assert.throws(
  () => apply(createHost(createStorage()), { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, prefix: '/other' }),
  /prefix is fixed/,
)

const workflow = {
  nodes: [
    { id: 7, type: 'KSampler', title: 'Sampler', pos: [420, 40], size: [315, 262], inputs: [{ name: 'model', link: 1 }], outputs: [{ name: 'LATENT' }] },
    { id: 4, type: 'UNETLoader', title: 'UNETLoader', pos: [0, 40], size: [340, 82], inputs: [], outputs: [{ name: 'MODEL' }] },
  ],
  links: [[1, 4, 0, 7, 0, 'MODEL']],
}
const semantic = {
  nodes: [
    { id: 7, type: 'KSampler', title: 'Sampler', widgets: { steps: 12, cfg: 2.5, sampler_name: 'euler' }, inputs: { model: '4:0' } },
    { id: 4, type: 'UNETLoader', widgets: { unet_name: 'qwen.safetensors' }, inputs: {} },
  ],
  linkCount: 1,
  selection: [7],
}
// A sync that carries no socket id leaves runs invisible in the editor, and
// nothing else in the summary would tell the model so.
const bare = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s-bare',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-bare', revision: 1, workflow, prompt: null, semantic }),
  },
))
assert.equal((await bare.json()).clientIdKnown, false, 'a session with no socket id says so')
const post = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 1,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
      clientId: '0f3c2b1a9d8e7f60',
    }),
  },
))
assert.equal(post.status, 200)
const saved = await post.json()
assert.equal(saved.nodes, 2)
assert.equal(saved.links, 1)
assert.equal(saved.hasPrompt, true)
assert.equal(saved.hasProjection, true)
assert.deepEqual(saved.selection, [7])
assert.equal(saved.clientIdKnown, true, 'a sync that names the editor socket is reported as such')

const got = await host.fetches.get('/api/comfyui/state').fetch(
  new Request('http://127.0.0.1/api/comfyui/state?sessionId=s1'),
)
assert.equal(got.status, 200)
assert.equal((await got.json()).revision, 1)

// A forced re-sync of identical content must not invent a new revision.
const resync = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 2,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
    }),
  },
))
assert.equal((await resync.json()).revision, 1)

// Zoom, pan, and window resizes only change `extra.ds`; a scroll must not
// count as an edit or the revision would creep while the user looks around.
const scrolled = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 3,
      workflow: { ...workflow, extra: { ds: { scale: 0.5, offset: [12, 34] } } },
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
    }),
  },
))
assert.equal((await scrolled.json()).revision, 1, 'view-only canvas state must not bump the revision')

// The workflow name rides with the sync but is metadata, not graph content:
// renaming a workflow must not look like an edit to the model.
const named = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 4,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
      name: 'portrait',
    }),
  },
))
const namedBody = await named.json()
assert.equal(namedBody.name, 'portrait')
assert.equal(namedBody.revision, 1, 'naming a workflow is not a graph edit')

// The panel sends a name only when the editor's name changed, so a body
// without one means "keep what the session already has" — the case a tool-set
// name depends on.
const quiet = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 5,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
    }),
  },
))
assert.equal((await quiet.json()).name, 'portrait', 'a quiet re-sync keeps the name')

const cleared = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 6,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
      name: null,
    }),
  },
))
assert.equal((await cleared.json()).name, null, 'a null name means the canvas has no name')

const rejected = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 7,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
      name: 'x'.repeat(81),
    }),
  },
))
assert.equal(rejected.status, 400, 'an unusable name is a client error, not a silent rename')

const renamed = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 8,
      workflow,
      prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
      semantic,
      name: 'portrait',
    }),
  },
))
assert.equal((await renamed.json()).name, 'portrait')


// A session only sees ComfyUI once its own workflow has synced.
const s1 = addAgent(host, 's1')
const s2 = addAgent(host, 's2')
assert.ok(s1.tools.has('comfyui_edit'))
assert.equal(s2.tools.size, 0, 'a session without a synced workflow must not see ComfyUI tools')
assert.ok(s1.digest().includes('rev 1'), 'digest names the current revision')
assert.ok(s1.digest().includes('"portrait"'), 'digest names the workflow')
assert.ok(s1.digest().includes('selected 7'))
assert.equal(s1.digest().includes('panel'), true)

const exec = execOf('s1')
const status = parse(await s1.tools.get('comfyui_status').execute({}, exec))
assert.equal(status.connected, true)
assert.equal(status.panelConnected, false)
assert.equal(status.frontend.status, 'verified')
assert.equal(status.frontend.installed, '1.57.1')

// Not connected is the first-use state: the panel row names it and carries the
// next step, while every other layer is still readable.
assert.equal(status.diagnostics.length, 7)
assert.deepEqual(
  status.diagnostics.map(row => row.layer),
  ['upstream', 'frontend', 'panel', 'commandChannel', 'storage', 'supervisor', 'workflow'],
)
assert.equal(diagnosticRow(status, 'upstream').ok, true)
assert.equal(diagnosticRow(status, 'frontend').ok, true)
assert.equal(diagnosticRow(status, 'panel').ok, false)
assert.ok(diagnosticRow(status, 'panel').action, 'a closed panel carries the next step')
assert.equal(diagnosticRow(status, 'commandChannel').ok, false)
assert.equal(diagnosticRow(status, 'storage').ok, true)
assert.equal(diagnosticRow(status, 'supervisor').ok, true)
assert.equal(diagnosticRow(status, 'workflow').ok, true)

// A different frontend than the one this panel was verified against is a
// frontend fault, not an upstream fault.
frontendVersionToReport = '1.60.0'
try {
  const mismatch = parse(await s1.tools.get('comfyui_status').execute({}, exec))
  const frontend = diagnosticRow(mismatch, 'frontend')
  assert.equal(frontend.ok, false)
  assert.match(frontend.detail, /1\.60\.0/)
  assert.match(frontend.action, /1\.57\.1/)
  assert.equal(diagnosticRow(mismatch, 'upstream').ok, true, 'the upstream still answers')
} finally {
  frontendVersionToReport = '1.57.1'
}

const read = parse(await s1.tools.get('comfyui_graph_read').execute({}, exec))
assert.equal(read.projectedFrom, 'panel')
assert.equal(read.linkCount, 1)
assert.deepEqual(read.selection, [7])
const sampler = read.nodes.find(node => node.id === 7)
assert.equal(sampler.title, 'Sampler')
assert.equal(sampler.widgets.steps, 12)
assert.equal(sampler.inputs.model, '4:0')
const readRaw = parse(await s1.tools.get('comfyui_graph_read').execute({ full: true }, exec))
assert.equal(readRaw.workflow.nodes.length, 2)
assert.equal(readRaw.revision, 1)
assert.equal('ds' in (readRaw.workflow.extra ?? {}), false, 'view state is stripped from the stored workflow')

// The layout read carries the overlap verdict: boxes that share pixels are the
// one layout fault a `pos` list hides.
const layout = parse(await s1.tools.get('comfyui_graph_read').execute({ layout: true }, exec))
assert.equal(layout.nodes.length, 2)
assert.deepEqual(layout.nodes.find(node => node.id === 4).size, [340, 82])
assert.deepEqual(layout.overlaps, [])
assert.deepEqual(layout.tight, [])
assert.equal('missing' in layout, false)
{
  const sOverlap = addAgent(host, 's-overlap')
  await host.fetches.get('/api/comfyui/state').fetch(new Request(
    'http://127.0.0.1/api/comfyui/state?sessionId=s-overlap',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's-overlap',
        revision: 1,
        workflow: {
          nodes: [
            { id: 1, type: 'A', pos: [0, 0], size: [100, 50] },
            { id: 2, type: 'B', pos: [60, 20], size: [100, 50] },
          ],
          links: [],
        },
        prompt: null,
      }),
    },
  ))
  const overlapping = parse(await sOverlap.tools.get('comfyui_graph_read').execute({ layout: true }, execOf('s-overlap')))
  assert.equal(overlapping.overlaps.length, 1)
  assert.deepEqual([overlapping.overlaps[0].a, overlapping.overlaps[0].b].sort(), [1, 2])
  assert.ok(overlapping.overlaps[0].x > 0 && overlapping.overlaps[0].y > 0)
}

const run = parse(await s1.tools.get('comfyui_run').execute({}, exec))
assert.equal(run.prompt_id, 'p1')
// Execution events only reach the client that queued the prompt, so a run the
// model starts has to use the panel's socket or it is invisible in the UI.
assert.equal(queuedBodies.at(-1)?.client_id, '0f3c2b1a9d8e7f60')

// SaveImage writes every extra_pnginfo key into a PNG text chunk, so the run
// carries the UI workflow (not the API prompt) and the output PNG restores the
// graph when dragged back into ComfyUI.
const runBody = queuedBodies.at(-1)
assert.ok(Array.isArray(runBody?.extra_data?.extra_pnginfo?.workflow?.nodes), 'the run carries the UI workflow')
assert.ok(runBody.extra_data.extra_pnginfo.workflow.nodes.length > 0)
assert.equal(runBody.extra_data.dsh_session_id, 's1')
assert.equal('prompt' in runBody.extra_data.extra_pnginfo, false, 'the API prompt stays out of the PNG metadata')

const cancelled = parse(await s1.tools.get('comfyui_cancel').execute({ promptId: run.prompt_id }, exec))
assert.deepEqual(cancelled, { cancelled: true, promptId: run.prompt_id })
assert.equal(interruptedBodies.at(-1)?.prompt_id, run.prompt_id)

// Without a prompt id, cancel targets the run this session's panel last
// reported, which is the one the model just queued.
{
  const sCancel = addAgent(host, 's-cancel')
  const synced = await host.fetches.get('/api/comfyui/state').fetch(new Request(
    'http://127.0.0.1/api/comfyui/state?sessionId=s-cancel',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's-cancel',
        revision: 1,
        workflow,
        prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
        semantic,
      }),
    },
  ))
  assert.equal(synced.status, 200)
  const queued = parse(await sCancel.tools.get('comfyui_run').execute({}, execOf('s-cancel')))
  const evented = await host.fetches.get('/api/comfyui/events').fetch(new Request(
    'http://127.0.0.1/api/comfyui/events',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-cancel', event: { kind: 'execution_start', promptId: queued.prompt_id } }),
    },
  ))
  assert.equal(evented.status, 200)
  const defaulted = parse(await sCancel.tools.get('comfyui_cancel').execute({}, execOf('s-cancel')))
  assert.deepEqual(defaulted, { cancelled: true, promptId: queued.prompt_id })
  assert.equal(interruptedBodies.at(-1)?.prompt_id, queued.prompt_id)
}

// A session that synced a workflow but never ran anything has no run to
// cancel, and must not fall back to a global interrupt.
{
  const sNoRun = addAgent(host, 's-no-run')
  const synced = await host.fetches.get('/api/comfyui/state').fetch(new Request(
    'http://127.0.0.1/api/comfyui/state?sessionId=s-no-run',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-no-run', revision: 1, workflow, prompt: {}, semantic }),
    },
  ))
  assert.equal(synced.status, 200)
  await assert.rejects(
    sNoRun.tools.get('comfyui_cancel').execute({}, execOf('s-no-run')),
    /No ComfyUI run to cancel/,
  )
}

// Without a reported socket the Host falls back to its own client id.
{
  const s3 = addAgent(host, 's3')
  const posted = await host.fetches.get('/api/comfyui/state').fetch(new Request(
    'http://127.0.0.1/api/comfyui/state?sessionId=s3',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's3', revision: 1, workflow, prompt: {}, semantic }),
    },
  ))
  assert.equal(posted.status, 200)
  await s3.tools.get('comfyui_run').execute({}, execOf('s3'))
  assert.match(queuedBodies.at(-1)?.client_id ?? '', /^dsh-comfyui-/)
}
// The output-image collector is pure: only `type: 'output'` entries count, the
// order is ComfyUI's, and no run carries more than four images.
const OUTPUT_IMAGES = [
  { filename: 'dsh-run_0001_.png', subfolder: '', type: 'output' },
  { filename: 'dsh-run_0002_.png', subfolder: 'batch', type: 'output' },
  { filename: 'dsh-run_0003_.png', subfolder: '', type: 'temp' },
  { filename: 'dsh-run_0004_.png', subfolder: '', type: 'output' },
  { filename: 'dsh-run_0005_.png', subfolder: '', type: 'output' },
  { filename: 'dsh-run_0006_.png', subfolder: '', type: 'output' },
]
mockHistory.p1.outputs = { 7: { images: OUTPUT_IMAGES } }
assert.deepEqual(
  collectOutputImages(mockHistory.p1).map(image => image.filename),
  ['dsh-run_0001_.png', 'dsh-run_0002_.png', 'dsh-run_0004_.png', 'dsh-run_0005_.png'],
  'only output images count, capped at four in report order',
)
assert.deepEqual(
  collectOutputImages({ outputs: { 1: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] } } }),
  [],
)
assert.equal(outputImageMediaType('frame.PNG', 'application/octet-stream'), 'image/png')
assert.equal(outputImageMediaType('frame', 'image/jpeg'), 'image/jpeg')
assert.equal(outputImageMediaType('frame', 'image/gif'), undefined)

// The fake attachment store decodes nothing, but it is the same save contract
// the Host uses: bytes + declared media type in, a durable ref out. The fake
// model route declares image input; `comfyui_run` must prove that before it
// puts an image block in a result.
const savedImages = []
const fakeAttachments = {
  imageLimits: {
    maxImageBytes: 20 * 1024 * 1024,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 80 * 1024 * 1024,
    maxImagePixels: 16_777_216,
    maxImageDimension: 16_384,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
  },
  async saveImage(input) {
    if (input.name === 'broken.png') throw new Error('the bytes do not decode as an image')
    savedImages.push(input)
    return {
      attachmentId: `att-${savedImages.length}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }
  },
}
const fakeLlm = {
  inputModalities: ['text', 'image'],
  async resolveModelInfo() { return { inputModalities: fakeLlm.inputModalities } },
}
host.services.set('attachments', fakeAttachments)
host.services.set('llm', fakeLlm)

const runTool = s1.tools.get('comfyui_run')
const waitedValue = await runTool.execute({ wait: true, timeoutMs: 3000 }, exec)
const waited = JSON.parse(waitedValue.text)
assert.equal(waited.history.status.status_str, 'success')
assert.deepEqual(waited.images, ['dsh-run_0001_.png', 'dsh-run_0002_.png', 'dsh-run_0004_.png', 'dsh-run_0005_.png'])
assert.equal(waited.attachments, 'inline')
assert.equal('imageNote' in waited, false)
assert.equal('skippedImages' in waited, false)
assert.equal(waitedValue.images.length, 4)
assert.deepEqual(
  waitedValue.images.map(value => value.attachment.attachmentId),
  ['att-1', 'att-2', 'att-3', 'att-4'],
)
assert.equal(waitedValue.images[0].attachment.mediaType, 'image/png')
assert.deepEqual(savedImages.map(input => input.name), waited.images)
assert.deepEqual(viewRequests.at(-1), { filename: 'dsh-run_0005_.png', subfolder: '', type: 'output' })
const rendered = runTool.output.render({ wait: true }, waitedValue)
assert.equal(rendered.length, 5)
assert.equal(rendered[0].type, 'text')
assert.match(rendered[0].text, /"attachments": "inline"/)
assert.deepEqual(
  rendered.slice(1).map(block => block.attachment.attachmentId),
  ['att-1', 'att-2', 'att-3', 'att-4'],
)

// No attachment service: the run result survives as text, names its images,
// and says the images did not come inline.
{
  const attachments = host.services.get('attachments')
  host.services.delete('attachments')
  try {
    const degradedValue = await runTool.execute({ wait: true, timeoutMs: 3000 }, exec)
    const degraded = JSON.parse(degradedValue.text)
    assert.equal(degraded.attachments, 'unavailable')
    assert.deepEqual(degraded.images, waited.images)
    assert.match(degraded.imageNote, /no attachment service is mounted/)
    assert.equal('images' in degradedValue, false)
  } finally {
    host.services.set('attachments', attachments)
  }
}

// A text-only model route is the same text fallback: attaching an image block
// there would make the next model request fail instead of losing only the image.
{
  fakeLlm.inputModalities = ['text']
  try {
    const refusedValue = await runTool.execute({ wait: true, timeoutMs: 3000 }, exec)
    const refused = JSON.parse(refusedValue.text)
    assert.equal(refused.attachments, 'unavailable')
    assert.match(refused.imageNote, /does not declare image input/)
    assert.equal('images' in refusedValue, false)
  } finally {
    fakeLlm.inputModalities = ['text', 'image']
  }
}

// One image the attachment store refuses is skipped with its reason; the
// others still arrive.
{
  mockHistory.p1.outputs = {
    7: {
      images: [
        { filename: 'dsh-good_0001_.png', subfolder: '', type: 'output' },
        { filename: 'broken.png', subfolder: '', type: 'output' },
      ],
    },
  }
  try {
    const partialValue = await runTool.execute({ wait: true, timeoutMs: 3000 }, exec)
    const partial = JSON.parse(partialValue.text)
    assert.equal(partial.attachments, 'inline')
    assert.deepEqual(partial.images, ['dsh-good_0001_.png', 'broken.png'])
    assert.equal(partialValue.images.length, 1)
    assert.equal(partial.skippedImages.length, 1)
    assert.equal(partial.skippedImages[0].filename, 'broken.png')
    assert.match(partial.skippedImages[0].reason, /refused it/)
  } finally {
    mockHistory.p1.outputs = { 7: { images: OUTPUT_IMAGES } }
  }
}

const sendEvent = event => host.fetches.get('/api/comfyui/events').fetch(new Request(
  'http://127.0.0.1/api/comfyui/events',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', event }) },
))
assert.equal((await sendEvent({ kind: 'execution_start', promptId: 'p1' })).status, 200)
assert.equal((await sendEvent({ kind: 'executing', promptId: 'p1', node: '7' })).status, 200)
assert.equal((await sendEvent({ kind: 'progress', promptId: 'p1', node: '7', value: 3, max: 12 })).status, 200)
assert.equal((await sendEvent({ kind: 'not-a-real-event' })).status, 400)

const progress = parse(await s1.tools.get('comfyui_progress').execute({}, exec))
assert.equal(progress.run.status, 'running')
assert.equal(progress.run.value, 3)
assert.equal(progress.run.max, 12)
assert.equal(progress.queue.pending, 0)
assert.equal(progress.hasPanelEvents, true)

// A panel that attached after `execution_start` still has to show the run as
// running rather than leave it "queued" until the success event lands.
assert.equal((await sendEvent({ kind: 'progress', promptId: 'p2', node: '9', value: 1, max: 4 })).status, 200)
const joined = parse(await s1.tools.get('comfyui_progress').execute({ promptId: 'p2' }, exec))
assert.equal(joined.run.status, 'running', 'a progress event proves the run started')
assert.ok(Number.isFinite(joined.run.startedAt), 'the record counts from the first event it saw')

// A run the Host queued is tracked without the panel. comfyui_progress drives
// the poller, so the answer is immediate; the second call sees the history and
// the output file even though no panel is mounted to relay execution events.
{
  const hostSession = 's-host-run'
  const synced = await host.fetches.get('/api/comfyui/state').fetch(new Request(
    `http://127.0.0.1/api/comfyui/state?sessionId=${hostSession}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: hostSession,
        revision: 1,
        workflow,
        prompt: { 7: { class_type: 'KSampler', inputs: {} } },
        semantic,
      }),
    },
  ))
  assert.equal(synced.status, 200)
  const hostScope = addAgent(host, hostSession)
  promptIdToReturn = 'p-host'
  mockQueue.queue_running = [[1, 'p-host', [], { dsh_session_id: hostSession }, []]]
  try {
    const queued = parse(await hostScope.tools.get('comfyui_run').execute({}, execOf(hostSession)))
    assert.equal(queued.prompt_id, 'p-host')
    const running = parse(await hostScope.tools.get('comfyui_progress').execute({}, execOf(hostSession)))
    assert.equal(running.panelConnected, false)
    assert.equal(running.hostRun.promptId, 'p-host')
    assert.equal(running.hostRun.status, 'running', 'the Host reads the queue when no panel is there')
    assert.equal(running.run.status, 'running', 'the host record is the latest run without panel events')

    mockQueue.queue_running = []
    mockHistory['p-host'] = {
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 7: { images: [{ filename: 'dsh-run_0001_.png', subfolder: '', type: 'output' }] } },
    }
    const finished = parse(await hostScope.tools.get('comfyui_progress').execute({}, execOf(hostSession)))
    assert.equal(finished.hostRun.status, 'completed')
    assert.equal(finished.hostRun.outputs[7].images[0].filename, 'dsh-run_0001_.png')
  } finally {
    promptIdToReturn = 'p1'
    mockQueue.queue_running = []
  }
}

const nodeInfo = parse(await s1.tools.get('comfyui_node_info').execute({ type: 'KSampler' }, exec))
assert.ok(nodeInfo.input.required.model)
const searched = parse(await s1.tools.get('comfyui_node_info').execute({ search: 'ksam' }, exec))
assert.ok(searched.matches.includes('KSampler'))

// The edit needs this session's panel; the restored session has none.
await assert.rejects(
  restoredScope.tools.get('comfyui_edit').execute({ operations: [{ op: 'remove_node', id: 1 }] }, execOf('s-restored')),
  /not connected in this session/,
)

// Simulate the open panel: keep a long-poll pending, enqueue an edit, answer it.
const pollPromise = host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
  'http://127.0.0.1/api/comfyui/commands/poll',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 3000 }) },
))
await delay(30)
assert.equal(parse(await s1.tools.get('comfyui_status').execute({}, exec)).panelConnected, true)

// A parked poll is the healthy first-run state: every layer reports ok.
const healthy = parse(await s1.tools.get('comfyui_status').execute({}, exec))
assert.equal(healthy.diagnostics.length, 7)
for (const row of healthy.diagnostics) assert.equal(row.ok, true, `${row.layer} should be ok`)
assert.equal(diagnosticRow(healthy, 'panel').ok, true)
assert.equal(diagnosticRow(healthy, 'commandChannel').ok, true)
assert.match(diagnosticRow(healthy, 'frontend').detail, /verified frontend 1\.57\.1/)
assert.equal(healthy.diagnostics.some(row => row.warn === true), false, 'a fully healthy report has no warnings')
const editPromise = s1.tools.get('comfyui_edit').execute({ operations: [{ op: 'set_widget', id: 7, name: 'steps', value: 6 }] }, exec)
const polled = await (await pollPromise).json()
assert.equal(polled.command.operations[0].op, 'set_widget')
const answered = await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
  'http://127.0.0.1/api/comfyui/commands/result',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', id: polled.command.id, ok: true, value: { applied: 1, nodes: 2, links: 1 } }),
  },
))
assert.equal((await answered.json()).accepted, true)
const edited = parse(await editPromise)
assert.equal(edited.applied, 1)
assert.equal(edited.sessionId, 's1')
// The panel's end-of-edit counters ride along, so a batch that dropped every
// link shows up in the tool result instead of the next status read.
assert.equal(edited.nodes, 2)
assert.equal(edited.links, 1)

// Both command routes cap the body like the state, event and service bridges
// do. A route without a cap reads whatever a client sends into memory, and the
// poll is the one a panel can hit every few seconds.
{
  const polled = await host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/poll',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', pad: 'x'.repeat(100_000) }) },
  ))
  assert.equal(polled.status, 413)
  assert.equal((await polled.json()).error, 'command payload is too large')
  const answered = await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/result',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', id: 'big', pad: 'x'.repeat(1_000_000) }) },
  ))
  assert.equal(answered.status, 413)
  assert.equal((await answered.json()).error, 'command result is too large')
}

// A screenshot takes the same command channel: the panel serializes its canvas,
// the Host keeps the bytes and hands back a path.
{
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const pollShot = host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/poll',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 3000 }) },
  ))
  await delay(30)
  const shotPromise = s1.tools.get('comfyui_screenshot').execute({}, exec)
  const shotCommand = (await (await pollShot).json()).command
  assert.equal(shotCommand.kind, 'screenshot', 'a screenshot is not an edit: it carries no operations')
  await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/result',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1',
        id: shotCommand.id,
        ok: true,
        value: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 800, height: 600 },
      }),
    },
  ))
  const shot = parse(await shotPromise)
  assert.equal(shot.bytes, png.byteLength)
  assert.equal(shot.width, 800)
  assert.equal(shot.height, 600)
  assert.deepEqual(readFileSync(shot.path), png, 'the written file must be the panel bytes')
  rmSync(shot.path, { force: true })
}

// A panel that answers a screenshot without pixels is an error, not an empty file.
{
  const pollBad = host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/poll',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 3000 }) },
  ))
  await delay(30)
  const badPromise = s1.tools.get('comfyui_screenshot').execute({}, exec)
  const badCommand = (await (await pollBad).json()).command
  await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/result',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: badCommand.id, ok: true, value: { kind: 'screenshot' } }),
    },
  ))
  await assert.rejects(badPromise, /did not return a PNG/)
}

// Named workflows: save, list, export/import, and load through the command
// channel. Only the load needs the panel; the rest read the Host's mirrored
// state, like comfyui_graph_read.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-workflows-'))
  const workflowExec = {
    agent: { session: { id: 's1', header: { cwd: dir } } },
    signal: new AbortController().signal,
  }
  try {
    const saved = parse(await s1.tools.get('comfyui_workflow_save').execute({ name: 'portrait' }, workflowExec))
    assert.equal(saved.saved, 'portrait')
    assert.equal(saved.replaced, false)
    assert.equal(saved.name, 'portrait', 'saving a slot names the session after it')
    assert.equal(saved.nodes, 2)
    assert.equal(saved.persistence.backend, 'storage')
    const stored = storage.state.workflows.get('portrait')
    assert.equal('prompt' in stored, false, 'saved workflows do not carry the session API prompt')
    assert.equal('semantic' in stored, false, 'saved workflows do not carry the session projection')

    const again = parse(await s1.tools.get('comfyui_workflow_save').execute({ name: 'portrait' }, workflowExec))
    assert.equal(again.replaced, true, 'saving the same name replaces that slot')

    const listed = parse(await s1.tools.get('comfyui_workflow_list').execute({}, workflowExec))
    assert.equal(listed.count, 1)
    assert.equal(listed.current, 'portrait', 'the list says which slot the session is editing')
    assert.equal(listed.workflows[0].name, 'portrait')
    assert.equal(listed.workflows[0].current, true)
    assert.equal(listed.workflows[0].nodes, 2)
    assert.ok(Number.isSafeInteger(listed.workflows[0].createdAt), 'the list exposes when the slot was created')

    const exportedPath = join(dir, 'portrait.json')
    const exported = parse(await s1.tools.get('comfyui_workflow_export').execute({ name: 'portrait', path: 'portrait.json' }, workflowExec))
    assert.equal(exported.path, exportedPath)
    assert.equal(JSON.parse(readFileSync(exportedPath, 'utf8')).nodes.length, 2)

    const defaultExport = parse(await s1.tools.get('comfyui_workflow_export').execute({}, workflowExec))
    assert.equal(defaultExport.path, join(dir, 'comfyui-session-s1.json'), 'the default export stays in the workspace')

    const importPath = join(dir, 'imported.json')
    writeFileSync(importPath, JSON.stringify({ nodes: [{ id: 9, type: 'KSampler' }], links: [] }))
    const imported = parse(await s1.tools.get('comfyui_workflow_import').execute({ path: 'imported.json' }, workflowExec))
    assert.equal(imported.imported, 'imported', 'the name defaults to the file stem')
    assert.equal(imported.nodes, 1)
    assert.equal(imported.replaced, false)

    await assert.rejects(
      s1.tools.get('comfyui_workflow_export').execute({ path: '../escape.json' }, workflowExec),
      /inside the session workspace/,
    )
    await assert.rejects(
      s1.tools.get('comfyui_workflow_import').execute({ path: '../escape.json' }, workflowExec),
      /inside the session workspace/,
    )

    const pollLoad = host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
      'http://127.0.0.1/api/comfyui/commands/poll',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 1000 }) },
    ))
    await delay(30)
    const loadPromise = s1.tools.get('comfyui_workflow_load').execute({ name: 'imported' }, exec)
    const loadCommand = (await (await pollLoad).json()).command
    assert.equal(loadCommand.kind, 'workflow')
    assert.equal(loadCommand.workflow.nodes.length, 1)
    await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
      'http://127.0.0.1/api/comfyui/commands/result',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', id: loadCommand.id, ok: true, value: { applied: 1, nodes: 1, links: 0, operations: [{ op: 'load_workflow' }] } }),
      },
    ))
    const loaded = parse(await loadPromise)
    assert.equal(loaded.name, 'imported')
    assert.equal(loaded.nodes, 1)
    assert.ok(s1.digest().includes('"imported"'), 'loading a slot names the session after it')

    // A page with the previous client falls back to "edit with no operations"
    // and answers success; the tool must not accept that as a load.
    const pollOld = host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
      'http://127.0.0.1/api/comfyui/commands/poll',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 1000 }) },
    ))
    await delay(30)
    const oldPromise = s1.tools.get('comfyui_workflow_load').execute({ name: 'imported' }, exec)
    const oldCommand = (await (await pollOld).json()).command
    await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
      'http://127.0.0.1/api/comfyui/commands/result',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', id: oldCommand.id, ok: true, value: { applied: 0, nodes: 1, links: 0 } }),
      },
    ))
    await assert.rejects(oldPromise, /did not confirm/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A disposed agent must not leave its panel waiting: DSH fires this event on
// clear and compaction too, and the same session id comes back with a fresh
// agent. The queued edit and the tool call end together, or a later poll would
// hand the old edit to an editor the model no longer believes it touched.
{
  const quiet = await host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/poll',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 1000 }) },
  ))
  assert.equal((await quiet.json()).command, null)
  // `panelConnected` still holds for its 15 s window, so this edit is queued
  // with no waiter to take it.
  const abandoned = s1.tools.get('comfyui_edit').execute({ operations: [{ op: 'remove_node', id: 7 }] }, exec)
  await delay(50)
  assert.equal(parse(await s1.tools.get('comfyui_status').execute({}, exec)).panelConnected, true)
  host.emit('agent/disposed', { agent: host.agents.get('s1') })
  await assert.rejects(abandoned, /session closed/)
  const after = parse(await s1.tools.get('comfyui_status').execute({}, exec))
  assert.equal(after.panelConnected, false, 'a disposed session has no panel')
  assert.equal(after.progress.run, null, 'its run record went with it')
  await assert.rejects(
    s1.tools.get('comfyui_edit').execute({ operations: [{ op: 'remove_node', id: 7 }] }, exec),
    /not connected in this session/,
  )
  const revived = await host.fetches.get('/api/comfyui/commands/poll').fetch(new Request(
    'http://127.0.0.1/api/comfyui/commands/poll',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 1000 }) },
  ))
  assert.equal((await revived.json()).command, null, 'the abandoned edit must not reach the next agent')
}

// A command whose tool call has already failed must not be replayed when the
// panel comes back later: the graph would change and no tool call would own it.
{
  const now = Date.now()
  const queue = [{ id: 'stale', at: now - 120_000 }, { id: 'fresh', at: now - 5_000 }]
  assert.equal(takeCommand(queue, now).id, 'fresh', 'the expired command is skipped, not returned after it')
  assert.equal(queue.length, 0, 'skipping discards it: a later poll must not revive it')
  assert.equal(takeCommand([{ id: 'stale', at: now - 61_000 }], now), null)
  assert.equal(takeCommand([], now), null)
}

// The session store and the command channel are the two modules behind
// `apply()`; their rules are checkable without a Host. A session's memory ends
// in one release, and sync keeps the revision meaning "a change was synced".
{
  const written = []
  const channels = createCommandChannel()
  const store = createSessionStore({
    logger: { warn() {} },
    releaseCommands: sessionId => channels.release(sessionId),
    persist: (sessionId, state) => { written.push({ sessionId, revision: state.revision }) },
  })
  const graph = { nodes: [{ id: 1, type: 'KSampler' }], links: [] }
  assert.equal(store.get('s-store'), undefined, 'an unknown session has no record')
  const synced = store.sync('s-store', {
    revision: 3,
    name: 'lifecycle',
    workflow: { ...graph, extra: { ds: { scale: 0.5, offset: [12, 34] } } },
    prompt: { 1: { class_type: 'KSampler', inputs: {} } },
    semantic: { nodes: [], linkCount: 0, selection: [] },
    clientId: '0f3c2b1a9d8e7f60',
  })
  assert.equal(synced.ok, true)
  const state = store.get('s-store')
  assert.equal(state.revision, 3)
  assert.equal(state.name, 'lifecycle')
  assert.equal(state.clientId, '0f3c2b1a9d8e7f60')
  assert.equal('ds' in (state.workflow.extra ?? {}), false, 'view state is stripped before the comparison')
  assert.equal(state.semantic, null, 'an empty projection over a non-empty graph is dropped')
  assert.equal(written.length, 0, 'persistence is debounced, not immediate')
  // The same content at a higher counter is not an edit.
  const resync = { revision: 9, workflow: graph, prompt: { 1: { class_type: 'KSampler', inputs: {} } }, semantic: { nodes: [], linkCount: 0, selection: [] } }
  const idle = store.sync('s-store', resync)
  assert.equal(idle.ok && idle.state.revision, 3, 'an idle re-sync keeps the revision')
  const grew = store.sync('s-store', { revision: 9, workflow: { nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'UNETLoader' }], links: [] } })
  assert.equal(grew.ok && grew.state.revision, 9, 'an edit moves the revision forward')
  store.rename('s-store', 'renamed')
  assert.equal(store.get('s-store').name, 'renamed')
  assert.equal(store.get('s-store').revision, 9, 'the name is metadata, not a graph edit')
  // A refused body leaves the record untouched.
  assert.deepEqual(store.sync('s-store', { workflow: null }), { ok: false, error: 'workflow must be an object' })
  assert.deepEqual(
    store.sync('s-store', { workflow: { nodes: [] }, name: '' }),
    { ok: false, error: 'name must be 1-80 characters without control characters' },
  )
  assert.equal(store.get('s-store').name, 'renamed', 'a refused sync does not consume the name')

  store.recordEvent('s-store', {
    kind: 'execution_start', promptId: 'p7', node: null, value: null, max: null, queueRemaining: null, error: null, at: Date.now(),
  })
  assert.equal(store.latestRun('s-store').run.status, 'running')
  assert.equal(store.runFor('s-store', 'p7').status, 'running')
  assert.equal(store.runFor('s-store', 'p-missing'), null)
  // A run the Host tracked lives beside the panel's record for the same
  // session. The panel's run stays the one latestRun reports while it exists;
  // the host record is still addressable and is what latestRun falls back to
  // when no panel event ever arrived.
  store.mergeRun('s-store', {
    promptId: 'p-host', status: 'queued', startedAt: null, updatedAt: Date.now(), node: null, value: null, max: null, error: null, outputs: null,
  })
  assert.equal(store.latestRun('s-store').run.promptId, 'p7', 'a panel-reported run stays the visible one')
  assert.equal(store.runFor('s-store', 'p-host').status, 'queued')
  store.mergeRun('s-store', {
    promptId: 'p-host', status: 'completed', startedAt: null, updatedAt: Date.now(), node: null, value: null, max: null, error: null, outputs: { 7: { images: [{ filename: 'p-host.png' }] } },
  })
  assert.equal(store.latestRun('s-store').run.promptId, 'p7')
  assert.equal(store.runFor('s-store', 'p-host').outputs[7].images[0].filename, 'p-host.png')
  assert.equal(store.runFor('s-store', 'p7').outputs, undefined, 'a panel run is not given host outputs')
  const cursor = store.seedCursor('s-store')
  cursor.set('8', { from: 5, used: 6 })
  store.commitSeedCursor('s-store', cursor)
  assert.equal(store.seedCursor('s-store').get('8').used, 6)
  store.trackTools('s-store', () => {})
  assert.equal(store.hasTools('s-store'), true)

  // A tool call parked on the old agent must not outlive it, and the edit it
  // queued must never reach the next panel.
  const parked = channels.ask('s-store', { id: 'cmd-1', operations: [] }, { timeoutMs: 5000, what: 'edit' })
  assert.equal((await channels.poll('s-store', { timeoutMs: 1000 })).body.command.id, 'cmd-1')
  store.release('s-store')
  await assert.rejects(parked, /session closed/)
  assert.ok(store.get('s-store'), 'the canvas survives: a resumed agent still reads it')
  assert.equal(store.latestRun('s-store').run, null, 'the run record goes with the agent')
  assert.equal(store.runFor('s-store', 'p-host'), null, 'a tracked run goes with the agent too')
  assert.equal(store.seedCursor('s-store').size, 0, 'the seed walk goes with the agent')
  assert.equal(store.hasTools('s-store'), false)
  assert.equal(channels.connected('s-store'), false)

  await delay(1600)
  assert.deepEqual(written.at(-1), { sessionId: 's-store', revision: 9 }, 'the debounced write carries the latest revision')
  store.close()
}

// The command channel on its own: ask, poll, answer; an unanswered command
// expires with its tool call; a poll parked on a session that goes away comes
// back empty so the panel's loop can re-arm under the next agent.
{
  const channels = createCommandChannel()
  const operations = [{ op: 'remove_node', id: 1 }]
  const awaited = channels.ask('s-cmd', { id: 'cmd-2', operations }, { timeoutMs: 5000, what: 'edit' })
  const polled = await channels.poll('s-cmd', { timeoutMs: 1000 })
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body.command, { id: 'cmd-2', operations })
  assert.equal(channels.connected('s-cmd'), true)
  assert.equal(channels.answer('cmd-2', { ok: true, value: { nodes: 2, links: 1 } }), true)
  assert.deepEqual(await awaited, { ok: true, value: { nodes: 2, links: 1 }, error: null })
  assert.equal(channels.answer('cmd-2', { ok: true }), false, 'a command is answered once')

  const expired = channels.ask('s-cmd', { id: 'cmd-3', at: Date.now() }, { timeoutMs: 20, what: 'screenshot' })
  await assert.rejects(expired, /did not answer the screenshot in time/)
  assert.equal(
    (await channels.poll('s-cmd', { timeoutMs: 1000 })).body.command,
    null,
    'an expired command is never handed to a later poll',
  )

  const waiting = channels.poll('s-gone', { timeoutMs: 5000 })
  channels.release('s-gone')
  assert.deepEqual(await waiting, { body: { ok: true, command: null }, status: 200 })
  assert.equal(channels.connected('s-gone'), false)
}

// A name is only as good as the file behind it. The panel reports the file its
// editor holds on every sync, so a name that came from a file is dropped when
// the editor stops holding it — the frontend fell back to a default graph —
// while a name a tool gave the canvas survives the same report.
{
  const store = createSessionStore({
    logger: { warn() {} },
    releaseCommands: () => {},
    persist: () => {},
  })
  const graph = { nodes: [{ id: 1, type: 'KSampler' }], links: [] }
  store.sync('s-file', { revision: 1, file: 'emoji', workflow: graph })
  assert.equal(store.get('s-file').name, 'emoji')
  assert.equal(store.get('s-file').nameSource, 'file')
  store.sync('s-file', { revision: 2, file: null, workflow: { nodes: [{ id: 2, type: 'UNETLoader' }], links: [] } })
  assert.equal(store.get('s-file').name, null, 'the name goes when the editor holds no file')
  store.sync('s-file', { revision: 3, file: null, workflow: graph })
  store.rename('s-file', 'slot')
  store.sync('s-file', { revision: 4, file: null, workflow: graph })
  assert.equal(store.get('s-file').name, 'slot', 'a name a tool gave the canvas survives a file-less editor')
  assert.equal(store.get('s-file').nameSource, 'tool')
  assert.deepEqual(
    store.sync('s-file', { workflow: graph, file: '' }),
    { ok: false, error: 'file must be 1-80 characters without control characters' },
  )
  store.close()
}

// An older panel (or a record persisted before projections) still reads:
// widgets are positional, but links resolve to their source.
const legacyPost = await host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s-legacy',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's-legacy',
      revision: 1,
      workflow: {
        nodes: [
          { id: 1, type: 'KSampler', inputs: [{ name: 'latent_image', link: 5 }], widgets_values: [0, 'randomize', 8] },
          { id: 2, type: 'EmptyLatentImage', inputs: [], widgets_values: [1024, 1024, 1] },
        ],
        links: [[5, 2, 0, 1, 0, 'LATENT']],
      },
      prompt: null,
    }),
  },
))
assert.equal(legacyPost.status, 200)
const legacy = addAgent(host, 's-legacy')
const legacyRead = parse(await legacy.tools.get('comfyui_graph_read').execute({}, execOf('s-legacy')))
assert.equal(legacyRead.projectedFrom, 'workflow')
assert.equal(legacyRead.nodes.find(node => node.id === 1).inputs.latent_image, '2:0')
assert.ok(Array.isArray(legacyRead.nodes.find(node => node.id === 1).widgetsValues))
assert.equal(legacyRead.apiPrompt.available, false)

// A real edit still moves the revision forward, and view state around it
// does not change that.
const postChange = body => host.fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s-change',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
))
const changeBody = semanticNow => ({
  sessionId: 's-change',
  revision: 1,
  workflow: { ...workflow, extra: { ds: { scale: 1, offset: [0, 0] } } },
  prompt: { 7: { class_type: 'KSampler', inputs: {} }, 4: { class_type: 'UNETLoader', inputs: {} } },
  semantic: semanticNow,
})
assert.equal((await (await postChange(changeBody(semantic))).json()).revision, 1)
const editedSemantic = {
  ...semantic,
  nodes: semantic.nodes.map(node => node.id === 7
    ? { ...node, widgets: { ...node.widgets, steps: 20 } }
    : node),
}
assert.equal((await (await postChange({ ...changeBody(editedSemantic), revision: 2 })).json()).revision, 2)

// ── Persistence ───────────────────────────────────────────────────────────

await delay(2000)
const persisted = storage.state.sessions.get('s1')
assert.ok(persisted, 'the synced workflow should be persisted')
assert.equal(persisted.semantic.nodes.find(node => node.id === 7).widgets.steps, 12)
assert.equal(persisted.prompt[7].class_type, 'KSampler')
assert.throws(
  () => storage.opened[0].tables.sessions.valueSchema.parse({ ...persisted, revision: -1 }),
  /revision/,
)

// ── Panel-managed service settings ────────────────────────────────────────

const serviceGet = await host.fetches.get('/api/comfyui/service').fetch(new Request('http://127.0.0.1/api/comfyui/service'))
const initialService = await serviceGet.json()
assert.equal(serviceGet.status, 200)
assert.equal(initialService.ok, true)
assert.equal(initialService.health, true)
assert.equal(initialService.settings, null)
assert.equal(initialService.frontend.status, 'verified')
assert.ok(initialService.detected === null || typeof initialService.detected === 'string')

const comfyRoot = mkdtempSync(join(tmpdir(), 'dsh-comfyui-service-'))
writeFileSync(join(comfyRoot, 'main.py'), '')
const saveService = await host.fetches.get('/api/comfyui/service').fetch(new Request('http://127.0.0.1/api/comfyui/service', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'save', settings: { cwd: comfyRoot, autoStart: false } }),
}))
const savedService = await saveService.json()
assert.equal(saveService.status, 200)
assert.equal(savedService.ok, true)
assert.equal(savedService.settings.cwd, comfyRoot)
assert.equal(savedService.state, 'stopped')
assert.equal(savedService.owned, false)
const storedSettings = storage.state.settings.get('service')
assert.equal(storedSettings.cwd, comfyRoot)
assert.equal(storedSettings.autoStart, false)

// A directory without main.py is rejected with the reason.
const badService = await host.fetches.get('/api/comfyui/service').fetch(new Request('http://127.0.0.1/api/comfyui/service', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'save', settings: { cwd: tmpdir(), autoStart: false } }),
}))
assert.equal(badService.status, 400)
assert.match((await badService.json()).error, /main\.py/)

const stopService = await host.fetches.get('/api/comfyui/service').fetch(new Request('http://127.0.0.1/api/comfyui/service', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'stop' }),
}))
assert.equal((await stopService.json()).ok, true)

// A second Host with the same medium restores the workflow and its tools.
const host2 = createHost(createStorage(storage.state))
const s1Again = addAgent(host2, 's1')
apply(host2, { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, prefix: '/comfyui' })
await delay(50)
assert.ok(s1Again.tools.has('comfyui_graph_read'), 'a restored session should get tools')
const restoredService = await (await host2.fetches.get('/api/comfyui/service').fetch(new Request('http://127.0.0.1/api/comfyui/service'))).json()
assert.equal(restoredService.settings.cwd, comfyRoot)
const restoredAgain = parse(await s1Again.tools.get('comfyui_graph_read').execute({}, exec))
assert.ok(restoredAgain.revision >= 1)
assert.equal(restoredAgain.nodes.find(node => node.id === 7).widgets.steps, 12)
// The persisted API prompt is still runnable without the panel.
const rerun = parse(await s1Again.tools.get('comfyui_run').execute({}, exec))
assert.equal(rerun.prompt_id, 'p1')

// ── Process supervision ───────────────────────────────────────────────────

const healthProbe = async () => {
  const response = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}/`, { signal: AbortSignal.timeout(1000) })
  return response.ok
}
const supervisorLog = `/tmp/dsh-comfyui-supervisor-${process.pid}.log`
const supervisor = createSupervisor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ['-e', `require('node:http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}')}).listen(${SUPERVISOR_PORT},'127.0.0.1')`],
    cwd: process.cwd(),
    env: {},
    restartDelayMs: 200,
    maxRestarts: 1,
    probeIntervalMs: 5000,
    startTimeoutMs: 15000,
    logPath: supervisorLog,
  },
  probe: healthProbe,
  logger: { info() {}, warn() {}, error() {} },
})
await supervisor.start()
const supervisorDeadline = Date.now() + 15000
while (supervisor.snapshot().state !== 'running' && Date.now() < supervisorDeadline) await delay(100)
const supervisionState = supervisor.snapshot()
assert.equal(supervisionState.state, 'running', `supervisor state: ${supervisionState.state}`)
assert.ok(Number.isInteger(supervisionState.pid))
assert.equal(supervisionState.enabled, true)
await supervisor.stop()
assert.equal(supervisor.snapshot().state, 'stopped')
await assert.rejects(healthProbe())

// A healthy upstream is adopted instead of duplicated.
const adopter = createSupervisor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    cwd: process.cwd(),
    env: {},
    restartDelayMs: 200,
    maxRestarts: 0,
    probeIntervalMs: 5000,
    startTimeoutMs: 5000,
    logPath: supervisorLog,
  },
  probe: async () => true,
  logger: { info() {}, warn() {}, error() {} },
})
await adopter.start()
assert.equal(adopter.snapshot().state, 'external')
assert.equal(adopter.snapshot().pid, null)
await adopter.stop()
assert.equal(adopter.snapshot().state, 'stopped')

// A server that was started elsewhere can be adopted by pid: a reloaded plugin
// finds its surviving child again, and Stop keeps working on it.
const ATTACHED_PORT = PORT_BASE + 4
const attachedChild = spawn(process.execPath, [
  '-e',
  `require('node:http').createServer((req,res)=>{res.writeHead(200);res.end('{"ok":true}')}).listen(${ATTACHED_PORT},'127.0.0.1')`,
], { stdio: 'ignore' })
const attachedProbe = async () => {
  const response = await fetch(`http://127.0.0.1:${ATTACHED_PORT}/`, { signal: AbortSignal.timeout(1000) }).catch(() => null)
  return response?.ok === true
}
const attacher = createSupervisor({
  config: {
    enabled: true,
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    cwd: process.cwd(),
    env: {},
    restartDelayMs: 200,
    maxRestarts: 0,
    probeIntervalMs: 5000,
    startTimeoutMs: 5000,
    logPath: supervisorLog,
  },
  probe: attachedProbe,
  logger: { info() {}, warn() {}, error() {} },
})
try {
  const attachDeadline = Date.now() + 10000
  while (!(await attachedProbe()) && Date.now() < attachDeadline) await delay(100)
  const attached = attacher.attach(attachedChild.pid)
  assert.equal(attached.state, 'running')
  assert.equal(attached.attached, true)
  assert.equal(attached.pid, attachedChild.pid)
  // Unloading the plugin must not signal a process it adopted: only a child it
  // spawned is the plugin's to stop.
  assert.equal(stopsOnUnload(attacher.snapshot()), false, 'an adopted server survives unload')
  const exited = new Promise(resolve => attachedChild.once('exit', resolve))
  await attacher.stop()
  await exited
  assert.equal(attacher.snapshot().state, 'stopped')
  assert.equal(attacher.snapshot().pid, null)
  assert.equal(await attachedProbe(), false)
} finally {
  attachedChild.kill('SIGKILL')
}

// Only a spawned child is the plugin's to stop on unload. An adopted pid is
// somebody else's process, and the snapshot has to say so for every state.
assert.equal(stopsOnUnload({ state: 'running', attached: true }), false, 'adopted')
assert.equal(stopsOnUnload({ state: 'running', attached: false }), true, 'spawned child')
assert.equal(stopsOnUnload({ state: 'starting', attached: false }), true, 'child still booting')
assert.equal(stopsOnUnload({ state: 'external', attached: false }), false, 'unmanaged upstream')
assert.equal(stopsOnUnload({ state: 'stopped', attached: false }), false, 'already stopped')
assert.equal(stopsOnUnload({ state: 'failed', attached: false }), false, 'failed to start')
assert.equal(stopsOnUnload(undefined), false, 'no supervisor at all')

// ── Panel-managed start/stop against a throwaway "ComfyUI" ─────────────────

const PANEL_SERVICE_PORT = PORT_BASE + 2
const panelRoot = mkdtempSync(join(tmpdir(), 'dsh-comfyui-panel-'))
writeFileSync(join(panelRoot, 'main.py'), `
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"system": {"comfyui_version": "fake"}}')
    def log_message(self, *args):
        pass
HTTPServer(('127.0.0.1', ${PANEL_SERVICE_PORT}), Handler).serve_forever()
`)

const panelHost = createHost(createStorage())
apply(panelHost, { upstream: `http://127.0.0.1:${PANEL_SERVICE_PORT}`, prefix: '/comfyui' })
const servicePath = '/api/comfyui/service'
const serviceStatus = async () => (await panelHost.fetches.get(servicePath).fetch(new Request(`http://127.0.0.1${servicePath}`))).json()
const servicePost = async body => (await panelHost.fetches.get(servicePath).fetch(new Request(`http://127.0.0.1${servicePath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))).json()
const waitForHealth = async expected => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const status = await serviceStatus()
    const settled = expected
      ? status.health === true && status.state === 'running'
      : status.health === false && (status.state === 'stopped' || status.state === 'failed')
    if (settled) return status
    await delay(250)
  }
  throw new Error(`service did not become ${expected ? 'running' : 'stopped'}`)
}

try {
  const initialPanel = await serviceStatus()
  assert.equal(initialPanel.health, false)
  const started = await servicePost({ action: 'start', settings: { cwd: panelRoot, autoStart: false } })
  assert.equal(started.ok, true)
  assert.equal(started.state, 'starting')
  const running = await waitForHealth(true)
  assert.equal(running.state, 'running')
  assert.equal(running.owned, true)
  assert.ok(Number.isInteger(running.pid))

  const stopped = await servicePost({ action: 'stop' })
  assert.equal(stopped.ok, true)
  const down = await waitForHealth(false)
  assert.equal(down.state, 'stopped')

  // The panel can start it again after a stop.
  const restarted = await servicePost({ action: 'start' })
  assert.equal(restarted.ok, true)
  const runningAgain = await waitForHealth(true)
  assert.notEqual(runningAgain.pid, running.pid)
  await servicePost({ action: 'stop' })
  await waitForHealth(false)
} finally {
  await servicePost({ action: 'stop' }).catch(() => {})
  panelHost.dispose()
}

assert.throws(
  () => apply(createHost(createStorage()), { upstream: 'http://127.0.0.1:8188', supervise: { enabled: true } }),
  /supervise\.cwd is required/,
)

// "Control after generate" is a frontend behaviour, so a Host-queued run has
// to apply it itself — otherwise every tool-driven run repeats the last image.
{
  const workflow = {
    nodes: [
      { id: 7, type: 'KSampler', widgets_values: [42, 'randomize', 8, 1, 'euler', 'simple', 1] },
      { id: 8, type: 'RandomNoise', widgets_values: [5, 'increment'] },
      { id: 9, type: 'KSamplerAdvanced', widgets_values: ['enable', 10, 'decrement', 8] },
      { id: 10, type: 'KSampler', widgets_values: [11, 'fixed', 8, 1, 'euler', 'simple', 1] },
      { id: 11, type: 'EmptyLatentImage', widgets_values: [1024, 1024, 1] },
    ],
  }
  const stored = {
    7: { class_type: 'KSampler', inputs: { seed: 42, steps: 8 } },
    8: { class_type: 'RandomNoise', inputs: { noise_seed: 5 } },
    9: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 10 } },
    10: { class_type: 'KSampler', inputs: { seed: 11 } },
    11: { class_type: 'EmptyLatentImage', inputs: { width: 1024 } },
  }
  const { prompt: queued, seeds } = applySeedControls(workflow, stored, () => 0.5)
  const random = Math.floor(0.5 * 2 ** 48)
  assert.equal(queued[7].inputs.seed, random)
  assert.equal(queued[8].inputs.noise_seed, 6, 'increment adds one')
  assert.equal(queued[9].inputs.noise_seed, 9, 'decrement subtracts one')
  assert.equal(queued[10].inputs.seed, 11, 'fixed leaves the seed alone')
  assert.deepEqual(queued[11], stored[11], 'a node without a seed input is untouched')
  assert.deepEqual(seeds, { 7: { field: 'seed', value: random }, 8: { field: 'noise_seed', value: 6 }, 9: { field: 'noise_seed', value: 9 } })
  assert.equal(stored[7].inputs.seed, 42, 'the stored prompt must not be mutated')
  // Nothing to do when no node asks for a control.
  assert.equal(applySeedControls({ nodes: [{ id: 7, widgets_values: [1, 2] }] }, stored).prompt, stored)

  // The editor keeps showing its own seed, so increment/decrement have to walk
  // from what the previous run used, or every run starts from the same number.
  const cursor = new Map()
  assert.equal(applySeedControls(workflow, stored, () => 0.5, cursor).seeds[8].value, 6)
  assert.equal(applySeedControls(workflow, stored, () => 0.5, cursor).seeds[8].value, 7, 'a second increment continues past the first')
  assert.equal(applySeedControls(workflow, stored, () => 0.5, cursor).seeds[8].value, 8)
  assert.equal(applySeedControls(workflow, stored, () => 0.5, cursor).seeds[9].value, 6, 'decrement walks down the same way')
  // A seed the user edited since is the new base, not the remembered one.
  const edited = { ...stored, 8: { ...stored[8], inputs: { noise_seed: 100 } } }
  assert.equal(applySeedControls(workflow, edited, () => 0.5, cursor).seeds[8].value, 101)
}

// ── Diagnostics: upstream down ────────────────────────────────────────────

// The first-use failure this report exists for: the upstream row names it and
// carries the next step, while an unknown frontend stays a warning, not an
// error.
await new Promise(resolve => upstream.close(resolve))
const offline = parse(await s1Again.tools.get('comfyui_status').execute({}, execOf('s1')))
const offlineUpstream = diagnosticRow(offline, 'upstream')
assert.equal(offlineUpstream.ok, false)
assert.ok(offlineUpstream.detail.length > 0)
assert.ok(offlineUpstream.action, 'a failed upstream carries the next step')
assert.equal(diagnosticRow(offline, 'frontend').ok, true, 'an unknown frontend is not an error')
assert.equal(diagnosticRow(offline, 'supervisor').ok, false, 'nothing is serving and nothing is managed')

host.dispose()
host2.dispose()

console.log('host smoke test passed')

await new Promise(resolve => proxyServer.close(resolve))
