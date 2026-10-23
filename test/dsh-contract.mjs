#!/usr/bin/env node
/**
 * Contract test against the real Harness runtime.
 *
 * `host-smoke.mjs` fakes the Host, so it cannot catch an invalid Fetch route,
 * a tool schema the registry rejects, or a digest registered outside the
 * agent's scope. This test mounts the plugin next to the real Cordis context,
 * `ToolRuntime`, `SystemPrompt`, and `HostConnectionService`, then drives the
 * public routes and tools the panel and model use.
 *
 * The DSH checkout is found at `../deepseek-harness` by default; override it
 * with `DSH_ROOT`. Nothing here writes outside the test's temp directory.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const root = resolve(process.env.DSH_ROOT ?? join(here, '..', '..', 'deepseek-harness'))

const ENTRIES = {
  cordis: 'vendor/cordis/lib/index.js',
  scope: 'packages/core/scope/lib/index.js',
  systemPrompt: 'packages/core/system-prompt/lib/index.js',
  tools: 'packages/core/tools/lib/index.js',
  connection: 'packages/client/connection/lib/index.js',
}

for (const entry of Object.values(ENTRIES)) {
  if (!existsSync(join(root, entry))) {
    console.error(`dsh-contract: missing ${entry} under ${root}`)
    console.error('dsh-contract: set DSH_ROOT to the deepseek-harness checkout.')
    process.exit(1)
  }
}

const load = async entry => import(pathToFileURL(join(root, entry)).href)

const { Context } = await load(ENTRIES.cordis)
const { createScope } = await load(ENTRIES.scope)
const { default: SystemPrompt, renderContextSnapshot } = await load(ENTRIES.systemPrompt)
const { default: ToolRuntime } = await load(ENTRIES.tools)
const { HostConnectionService } = await load(ENTRIES.connection)
const { apply, inject } = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const SESSION_ID = 'contract-session'
const WORKFLOW = {
  last_node_id: 2,
  last_link_id: 1,
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      pos: [0, 0],
      size: [320, 100],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
      properties: {},
      widgets_values: ['model.safetensors'],
    },
    {
      id: 2,
      type: 'KSampler',
      pos: [400, 0],
      size: [320, 250],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [{ name: 'model', type: 'MODEL', link: 1 }],
      outputs: [],
      properties: {},
      widgets_values: [42, 'fixed', 6, 1, 'euler', 'normal', 1],
    },
  ],
  links: [[1, 1, 0, 2, 0, 'MODEL']],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
}

// ── A real Host, with the few facilities a test Host cannot provide ─────────

const ctx = new Context()

await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)

const connectionFiber = ctx.plugin(inner => {
  // The constructor's arguments are a request context list and browser auth;
  // both are irrelevant to exact-Fetch registration and dispatch.
  new HostConnectionService(inner, [], {})
})
await connectionFiber.await()
assert.ok(ctx.connection !== undefined, 'HostConnectionService should provide `connection`')

ctx.provide('webServer', {
  register: () => () => {},
  registerUpgrade: () => () => {},
})

/** sessionId -> tableName -> Map. Mirrors the domain KV surface the store uses. */
const tables = new Map([['sessions', new Map()], ['settings', new Map()]])
/** @type {any} */
let openedSpec
ctx.provide('storageDomain', {
  async open(spec) {
    openedSpec = spec
    return {
      table(name) {
        const table = tables.get(name)
        if (table === undefined) throw new Error(`unknown table ${JSON.stringify(name)}`)
        return {
          get: key => table.get(key),
          entries: () => [...table.entries()],
          get size() { return table.size },
          async put(key, value) { table.set(key, value) },
          async delete(key) { table.delete(key) },
        }
      },
      async close() {},
    }
  },
})

// The agent stand-in carries a real scope: the plugin registers tools through
// `agent.ctx`, and `ToolRuntime` resolves that same key back to the scope.
const agent = { id: SESSION_ID }
/** @type {any} */
let scope
const scopeFiber = ctx.plugin(Object.assign(
  inner => { scope = createScope(inner, agent) },
  { inject: ['tools', 'systemPrompt'] },
))
await scopeFiber.await()
agent.ctx = scope.ctx
ctx.provide('agents', { get: id => (id === SESSION_ID ? agent : undefined) })

const pluginFiber = ctx.plugin(Object.assign(inner => apply(inner, {
  upstream: 'http://127.0.0.1:9',
  prefix: '/comfyui',
}), { inject }))
await pluginFiber.await()

const shared = ctx.connection.createSharedFetchHandler('/api')
const post = (path, body) => shared.fetch(new Request(`http://host${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), ctx.connection.browserPeer)

let tempDir
try {
  // ── Routes are accepted by the real Connection service ───────────────────
  // Reaching this point means every `connection.fetch.register` path is a
  // valid exact route under `/api`; the previous ad-hoc invalid path failed
  // exactly here, at install time.

  // ── Panel → Host workflow sync ───────────────────────────────────────────
  const synced = await post('/api/comfyui/state', {
    sessionId: SESSION_ID,
    revision: 7,
    workflow: WORKFLOW,
    prompt: { '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } },
  })
  assert.equal(synced.status, 200, 'state POST should be routed')
  const syncBody = await synced.json()
  assert.equal(syncBody.ok, true)
  assert.equal(syncBody.nodes, 2)
  assert.equal(syncBody.links, 1)

  const readBack = await shared.fetch(new Request(
    `http://host/api/comfyui/state?sessionId=${SESSION_ID}`,
  ), ctx.connection.browserPeer)
  const readBody = await readBack.json()
  assert.equal(readBody.found, true)
  assert.equal(readBody.nodes, 2)

  // ── Tools are accepted by the real registry and scoped to the session ────
  const expected = [
    'comfyui_edit',
    'comfyui_graph_read',
    'comfyui_node_info',
    'comfyui_progress',
    'comfyui_run',
    'comfyui_screenshot',
    'comfyui_status',
  ]
  assert.deepEqual(ctx.tools.schemas(agent).map(tool => tool.name).sort(), expected)
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [],
    'ComfyUI tools must not leak into the global registry')
  const outsider = { id: 'someone-else' }
  assert.deepEqual(ctx.tools.schemas(outsider).map(tool => tool.name), [],
    'ComfyUI tools must not leak into another session')

  const graphResult = await ctx.tools.execute({
    signal: AbortSignal.timeout(5000),
    callId: 'contract-graph-read',
    name: 'comfyui_graph_read',
    arguments: {},
    agent,
  })
  const graphText = graphResult.content.find(part => part.type === 'text')?.text
  assert.equal(typeof graphText, 'string', 'comfyui_graph_read should return text')
  const graph = JSON.parse(graphText)
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.projectedFrom, 'workflow')
  assert.deepEqual(graph.nodes.map(node => node.type), ['CheckpointLoaderSimple', 'KSampler'])

  // ── The digest lands in the agent's runtime context, not the global one ──
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const snapshot = renderContextSnapshot(assembly)
  assert.match(snapshot, /ComfyUI: rev \d+ · 2 nodes · 1 link/)
  const globalSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble())
  assert.doesNotMatch(globalSnapshot, /ComfyUI: rev/)

  // ── Panel-managed service settings persist through the real domain spec ──
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-contract-'))
  await writeFile(join(tempDir, 'main.py'), '# test fixture\n')
  const saved = await post('/api/comfyui/service', {
    action: 'save',
    settings: { cwd: tempDir, autoStart: false },
  })
  const savedBody = await saved.json()
  assert.equal(saved.status, 200)
  assert.equal(savedBody.ok, true)
  assert.equal(savedBody.settings.cwd, tempDir)
  assert.equal(savedBody.health, false, 'the unreachable upstream should report unhealthy')

  assert.equal(openedSpec?.name, 'dsh_comfyui')
  assert.equal(openedSpec?.version, 1)
  const stored = tables.get('settings').get('service')
  assert.equal(stored.cwd, tempDir)
  assert.equal(stored.autoStart, false)
  assert.ok(Number.isSafeInteger(stored.updatedAt) && stored.updatedAt > 0)

  const statusResponse = await shared.fetch(new Request(
    'http://host/api/comfyui/service',
  ), ctx.connection.browserPeer)
  const statusBody = await statusResponse.json()
  assert.equal(statusBody.ok, true)
  assert.equal(statusBody.settings.cwd, tempDir)
  assert.equal(statusBody.health, false)

  // The temp fixture must not be handed to a real supervisor by accident.
  assert.ok(tempDir.startsWith(resolve(tmpdir()) + sep))
  console.log('dsh contract test passed')
} finally {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  await pluginFiber.dispose().catch(() => {})
  await scopeFiber.dispose().catch(() => {})
  await connectionFiber.dispose().catch(() => {})
}
