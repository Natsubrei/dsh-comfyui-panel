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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  executor: 'packages/core/tool-executor-native/lib/index.js',
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

/** A one-node UI workflow, distinct from the two-node session graph. */
const IMPORT_WORKFLOW = {
  last_node_id: 1,
  last_link_id: 0,
  nodes: [
    {
      id: 1,
      type: 'KSampler',
      pos: [0, 0],
      size: [320, 250],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: {},
      widgets_values: [42, 'fixed', 6, 1, 'euler', 'normal', 1],
    },
  ],
  links: [],
  groups: [],
  config: {},
  extra: {},
  version: 0.4,
}

// ── A real Host, with the few facilities a test Host cannot provide ─────────

const ctx = new Context()

await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)

// `ToolRuntime` only dispatches; a composition that calls `ctx.tools.execute`
// needs an executor, and the shipped Web app loads the native one.
const executorModule = await load(ENTRIES.executor)
const executorFiber = ctx.plugin(Object.assign(
  inner => { executorModule.apply(inner) },
  { inject: executorModule.inject },
))
await executorFiber.await()

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
const tables = new Map([['sessions', new Map()], ['workflows', new Map()], ['settings', new Map()]])
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

/**
 * Run one tool through the real native executor.
 * @param {string} name - registered tool name.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {string} callId - correlation id for the batch.
 * @returns {Promise<any>} the canonical execution result.
 */
async function callTool(name, args, callId) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
    signal: AbortSignal.timeout(5000),
    agent,
  })
  const outcome = batch.results[0]
  assert.ok(outcome !== undefined, `${name} should settle`)
  if (outcome.result.isError) {
    const text = outcome.result.content.map(part => part.text ?? '').join('')
    throw new Error(`${name} failed: ${text}`)
  }
  return outcome.result
}

let tempDir
let workflowDir
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
    'comfyui_workflow_export',
    'comfyui_workflow_import',
    'comfyui_workflow_list',
    'comfyui_workflow_load',
    'comfyui_workflow_save',
  ]
  assert.deepEqual(ctx.tools.schemas(agent).map(tool => tool.name).sort(), expected)
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [],
    'ComfyUI tools must not leak into the global registry')
  const outsider = { id: 'someone-else' }
  assert.deepEqual(ctx.tools.schemas(outsider).map(tool => tool.name), [],
    'ComfyUI tools must not leak into another session')

  const graphResult = await callTool('comfyui_graph_read', {}, 'contract-graph-read')
  const graphText = graphResult.content.find(part => part.type === 'text')?.text
  assert.equal(typeof graphText, 'string', 'comfyui_graph_read should return text')
  const graph = JSON.parse(graphText)
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.projectedFrom, 'workflow')
  assert.deepEqual(graph.nodes.map(node => node.type), ['CheckpointLoaderSimple', 'KSampler'])

  // The workflow file tools resolve paths against the session workspace. The
  // agent object is mutable and the tool executor reads
  // `exec.agent.session.header.cwd`, so the test can give it a temp one.
  workflowDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-workflows-'))
  agent.session = { id: SESSION_ID, header: { cwd: workflowDir } }

  // A named workflow writes the real domain table, not only the session slot.
  const savedResult = await callTool('comfyui_workflow_save', { name: 'contract' }, 'contract-workflow-save')
  const savedWorkflow = JSON.parse(savedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(savedWorkflow.saved, 'contract')
  assert.equal(savedWorkflow.nodes, 2)
  assert.equal(tables.get('workflows').get('contract').nodes, 2)

  const listedResult = await callTool('comfyui_workflow_list', {}, 'contract-workflow-list')
  const listedWorkflows = JSON.parse(listedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(listedWorkflows.count, 1)
  assert.equal(listedWorkflows.workflows[0].name, 'contract')

  // ── Workflow files: export and import write real files in the workspace ──
  const exportPath = join(workflowDir, 'contract.json')
  const exportedResult = await callTool(
    'comfyui_workflow_export',
    { name: 'contract', path: exportPath },
    'contract-workflow-export',
  )
  const exported = JSON.parse(exportedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(exported.path, exportPath)
  const exportedFile = JSON.parse(await readFile(exported.path, 'utf8'))
  assert.equal(exportedFile.nodes.length, 2)

  const importPath = join(workflowDir, 'imported.json')
  await writeFile(importPath, `${JSON.stringify(IMPORT_WORKFLOW, null, 2)}\n`)
  const importedResult = await callTool(
    'comfyui_workflow_import',
    { path: importPath, name: 'imported' },
    'contract-workflow-import',
  )
  const imported = JSON.parse(importedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(imported.imported, 'imported')
  assert.equal(imported.nodes, 1)

  const relistedResult = await callTool('comfyui_workflow_list', {}, 'contract-workflow-list-imported')
  const relistedWorkflows = JSON.parse(relistedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(relistedWorkflows.count, 2)
  assert.deepEqual(
    relistedWorkflows.workflows.map(workflow => workflow.name).sort(),
    ['contract', 'imported'],
  )

  // ── Load: the panel's long-poll takes the command and answers it ─────────
  // Start the poll first so `panelConnected` sees a waiter; the load tool then
  // queues the command for that same poll. The result route releases it. The
  // yielded turn lets the poll's body parse settle before the tool checks.
  const pollPending = post('/api/comfyui/commands/poll', { sessionId: SESSION_ID, timeoutMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const loadPending = callTool('comfyui_workflow_load', { name: 'imported' }, 'contract-workflow-load')
  const polled = await pollPending
  assert.equal(polled.status, 200, 'command poll should be routed')
  const polledBody = await polled.json()
  assert.equal(polledBody.ok, true)
  const command = polledBody.command
  assert.ok(command !== null && typeof command === 'object', 'the poll should take the load command')
  assert.equal(command.kind, 'workflow')
  assert.equal(command.workflow.nodes.length, 1)

  const answered = await post('/api/comfyui/commands/result', {
    sessionId: SESSION_ID,
    id: command.id,
    ok: true,
    value: { applied: 1, nodes: 1, links: 0, operations: [{ op: 'load_workflow' }] },
  })
  assert.equal(answered.status, 200, 'command result should be routed')
  assert.equal((await answered.json()).accepted, true)

  const loadedResult = await loadPending
  const loaded = JSON.parse(loadedResult.content.find(part => part.type === 'text')?.text)
  assert.equal(loaded.name, 'imported')
  assert.equal(loaded.nodes, 1)

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
  if (workflowDir !== undefined) await rm(workflowDir, { recursive: true, force: true })
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  await pluginFiber.dispose().catch(() => {})
  await scopeFiber.dispose().catch(() => {})
  await connectionFiber.dispose().catch(() => {})
  await executorFiber.dispose().catch(() => {})
}
