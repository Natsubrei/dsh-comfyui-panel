/**
 * Host smoke test. It exercises the proxy, the workflow/event bridges, the
 * session-scoped tools, persistence, and the process supervisor against mock
 * upstreams. It does not start a browser or a real ComfyUI.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { createSupervisor } from '../supervisor.js'

const UPSTREAM_PORT = 18188
const PROXY_PORT = 18189
const SUPERVISOR_PORT = 18191

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One Host stand-in: routes, tools, agents, and a shared storage medium. */
function createHost(storage) {
  const routes = new Map()
  const fetches = new Map()
  const handlers = new Map()
  const agents = new Map()
  const disposers = []
  const host = {
    routes,
    fetches,
    agents,
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
      return undefined
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
function createStorage(state = { sessions: new Map(), settings: new Map() }) {
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

const execOf = sessionId => ({ agent: { session: { id: sessionId } }, signal: new AbortController().signal })
const parse = value => JSON.parse(value.text)

// ── Mock ComfyUI upstream ─────────────────────────────────────────────────

const upstream = http.createServer((req, res) => {
  if (req.url === '/system_stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ system: { comfyui_version: '0.42.0' } }))
    return
  }
  if (req.url === '/prompt' && req.method === 'POST') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: 'p1', number: 1, node_errors: {} }))
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
    res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
    return
  }
  if (req.url === '/history/p1') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ p1: { status: { status_str: 'success', completed: true }, outputs: {} } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>mock comfy</title><div id="ok">mock</div>')
})

await new Promise(resolve => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve))

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
await new Promise(resolve => proxyServer.listen(PROXY_PORT, '127.0.0.1', resolve))

const page = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/`)
assert.equal(page.status, 200)
assert.match(await page.text(), /mock comfy/)

const redirect = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui`, { redirect: 'manual' })
assert.equal(redirect.status, 308)
assert.equal(redirect.headers.get('location'), '/comfyui/')

const asset = await fetch(`http://127.0.0.1:${PROXY_PORT}/comfyui/assets/app-abc123.js`)
assert.equal(asset.status, 200)
assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')

const workflow = {
  nodes: [
    { id: 7, type: 'KSampler', title: 'Sampler', inputs: [{ name: 'model', link: 1 }], outputs: [{ name: 'LATENT' }] },
    { id: 4, type: 'UNETLoader', title: 'UNETLoader', inputs: [], outputs: [{ name: 'MODEL' }] },
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

// A session only sees ComfyUI once its own workflow has synced.
const s1 = addAgent(host, 's1')
const s2 = addAgent(host, 's2')
assert.ok(s1.tools.has('comfyui_edit'))
assert.equal(s2.tools.size, 0, 'a session without a synced workflow must not see ComfyUI tools')
assert.ok(s1.digest().includes('rev 1'), 'digest names the current revision')
assert.ok(s1.digest().includes('selected 7'))
assert.equal(s1.digest().includes('panel'), true)

const exec = execOf('s1')
const status = parse(await s1.tools.get('comfyui_status').execute({}, exec))
assert.equal(status.connected, true)
assert.equal(status.panelConnected, false)

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

const run = parse(await s1.tools.get('comfyui_run').execute({}, exec))
assert.equal(run.prompt_id, 'p1')
const waited = parse(await s1.tools.get('comfyui_run').execute({ wait: true, timeoutMs: 3000 }, exec))
assert.equal(waited.history.status.status_str, 'success')

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
const editPromise = s1.tools.get('comfyui_edit').execute({ operations: [{ op: 'set_widget', id: 7, name: 'steps', value: 6 }] }, exec)
const polled = await (await pollPromise).json()
assert.equal(polled.command.operations[0].op, 'set_widget')
const answered = await host.fetches.get('/api/comfyui/commands/result').fetch(new Request(
  'http://127.0.0.1/api/comfyui/commands/result',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', id: polled.command.id, ok: true, value: { applied: 1 } }),
  },
))
assert.equal((await answered.json()).accepted, true)
const edited = parse(await editPromise)
assert.equal(edited.applied, 1)
assert.equal(edited.sessionId, 's1')

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
const ATTACHED_PORT = 18192
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
  const exited = new Promise(resolve => attachedChild.once('exit', resolve))
  await attacher.stop()
  await exited
  assert.equal(attacher.snapshot().state, 'stopped')
  assert.equal(attacher.snapshot().pid, null)
  assert.equal(await attachedProbe(), false)
} finally {
  attachedChild.kill('SIGKILL')
}

// ── Panel-managed start/stop against a throwaway "ComfyUI" ─────────────────

const PANEL_SERVICE_PORT = 18190
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

host.dispose()
host2.dispose()

console.log('host smoke test passed')

await new Promise(resolve => proxyServer.close(resolve))
await new Promise(resolve => upstream.close(resolve))
