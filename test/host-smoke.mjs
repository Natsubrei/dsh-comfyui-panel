/**
 * P0 host smoke test. It exercises the proxy, bridge, and tools against a mock
 * ComfyUI upstream. It does not start a browser or a real ComfyUI.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply } from '../index.js'

const UPSTREAM_PORT = 18188
const PROXY_PORT = 18189
const routes = new Map()
const fetches = new Map()
const tools = new Map()

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(factory) { return factory() },
  webServer: {
    register(route) { routes.set(route.path, route); return () => {} },
    registerUpgrade(route) { routes.set(`upgrade:${route.path}`, route); return () => {} },
  },
  connection: {
    admit() { return { peer: {} } },
    fetch: { register(route) { fetches.set(route.path, route); return async () => {} } },
  },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
}

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
apply(ctx, { upstream: `http://127.0.0.1:${UPSTREAM_PORT}`, prefix: '/comfyui' })

const proxyServer = http.createServer((req, res) => {
  routes.get('/comfyui').handler(req, res)
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

const post = await fetches.get('/api/comfyui/state').fetch(new Request(
  'http://127.0.0.1/api/comfyui/state?sessionId=s1',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 's1',
      revision: 1,
      workflow: { nodes: [{ id: 1, type: 'KSampler' }], links: [[1, 1, 0, 2, 0, 'MODEL']] },
      prompt: { 1: { class_type: 'KSampler', inputs: {} } },
    }),
  },
))
assert.equal(post.status, 200)
const saved = await post.json()
assert.equal(saved.nodes, 1)
assert.equal(saved.links, 1)
assert.equal(saved.hasPrompt, true)

const got = await fetches.get('/api/comfyui/state').fetch(
  new Request('http://127.0.0.1/api/comfyui/state?sessionId=s1'),
)
assert.equal(got.status, 200)
assert.equal((await got.json()).revision, 1)

const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal }
const status = await tools.get('comfyui_status').execute({}, exec)
assert.match(status.text, /"connected": true/)
const read = await tools.get('comfyui_graph_read').execute({ full: true }, exec)
assert.match(read.text, /KSampler/)
const run = await tools.get('comfyui_run').execute({}, exec)
assert.match(run.text, /"prompt_id": "p1"/)
const waited = await tools.get('comfyui_run').execute({ wait: true, timeoutMs: 3000 }, exec)
assert.match(waited.text, /"status_str": "success"/)

const sendEvent = event => fetches.get('/api/comfyui/events').fetch(new Request(
  'http://127.0.0.1/api/comfyui/events',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', event }) },
))
assert.equal((await sendEvent({ kind: 'execution_start', promptId: 'p1' })).status, 200)
assert.equal((await sendEvent({ kind: 'executing', promptId: 'p1', node: '7' })).status, 200)
assert.equal((await sendEvent({ kind: 'progress', promptId: 'p1', node: '7', value: 3, max: 8 })).status, 200)
assert.equal((await sendEvent({ kind: 'not-a-real-event' })).status, 400)

const progress = await tools.get('comfyui_progress').execute({}, exec)
assert.match(progress.text, /"status": "running"/)
assert.match(progress.text, /"value": 3/)
assert.match(progress.text, /"max": 8/)
assert.match(progress.text, /"pending": 0/)
assert.match(progress.text, /"hasPanelEvents": true/)

const nodeInfo = await tools.get('comfyui_node_info').execute({ type: 'KSampler' }, exec)
assert.match(nodeInfo.text, /"model"/)
const searched = await tools.get('comfyui_node_info').execute({ search: 'ksam' }, exec)
assert.match(searched.text, /KSampler/)

// Simulate the open panel: keep a long-poll pending, enqueue an edit, answer it.
const pollPromise = fetches.get('/api/comfyui/commands/poll').fetch(new Request(
  'http://127.0.0.1/api/comfyui/commands/poll',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', timeoutMs: 3000 }) },
))
await new Promise(resolve => setTimeout(resolve, 50))
const editPromise = tools.get('comfyui_edit').execute({ operations: [{ op: 'set_widget', id: 7, name: 'steps', value: 8 }] }, exec)
const polled = await (await pollPromise).json()
assert.equal(polled.command.operations[0].op, 'set_widget')
const answered = await fetches.get('/api/comfyui/commands/result').fetch(new Request(
  'http://127.0.0.1/api/comfyui/commands/result',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', id: polled.command.id, ok: true, value: { applied: 1 } }),
  },
))
assert.equal((await answered.json()).accepted, true)
const edited = await editPromise
assert.match(edited.text, /"applied": 1/)

// A session without a connected panel must be refused instead of hanging.
await assert.rejects(
  () => tools.get('comfyui_edit').execute(
    { operations: [{ op: 'remove_node', id: 1 }] },
    { agent: { session: { id: 's2' } }, signal: new AbortController().signal },
  ),
  /not connected/,
)

console.log('P0 host smoke test passed')

await new Promise(resolve => proxyServer.close(resolve))
await new Promise(resolve => upstream.close(resolve))
