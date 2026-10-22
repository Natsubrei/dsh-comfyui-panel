/**
 * Editor-operation test for the browser half.
 *
 * client.js cannot be imported as an ordinary module (it registers itself on
 * `window.__ModuleLoader__`), so this loads it behind a stub loader and drives
 * the operations the Host's `comfyui_edit` tool forwards. The regression it
 * guards: connect/disconnect used to require `id` even though the tool schema
 * documented only add/remove/set_widget, so a caller passing `to.id` got
 * "Node undefined not found".
 */
import assert from 'node:assert/strict'

let registered = null
globalThis.window = { __ModuleLoader__: { load: module => { registered = module } } }
await import('../client.js')
assert.equal(registered.id, '@local/dsh-comfyui')

const fakeReact = {
  createElement: () => null,
  useCallback: fn => fn,
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
}
const mod = registered.factory(dependency => {
  if (dependency === 'react') return fakeReact
  throw new Error(`unexpected dependency "${dependency}"`)
})
const { applyOperation, coerceWidgetValue, en, zh } = mod.__ops

function makeGraph() {
  const nodes = new Map()
  const links = []
  const graph = {
    links,
    setDirtyCanvas() {},
    getNodeById: id => nodes.get(id),
    add: node => { nodes.set(node.id, node) },
    remove: node => { nodes.delete(node.id) },
  }
  return { graph, nodes, links }
}

function makeNode(graph, id, inputNames = [], widgets = []) {
  return {
    id,
    type: 'Test',
    inputs: inputNames.map(name => ({ name, link: null })),
    widgets,
    connect(fromSlot, target, toSlot) {
      target.inputs[toSlot].link = 1
      graph.links.push([id, fromSlot, target.id, toSlot])
      return true
    },
  }
}

const run = (graph, operation, LiteGraph = { createNode: () => null }) => applyOperation({ graph, LiteGraph, app: {}, operation })

// connect names the target either way.
{
  const { graph, nodes, links } = makeGraph()
  nodes.set(5, makeNode(graph, 5))
  nodes.set(7, makeNode(graph, 7, ['positive', 'negative']))
  const byTo = run(graph, { op: 'connect', from: { id: 5, output: 0 }, to: { id: 7, input: 'positive' } })
  assert.equal(byTo.slot, 0)
  assert.deepEqual(links, [[5, 0, 7, 0]])
  const byId = run(graph, { op: 'connect', id: 7, from: { id: 5, output: 1 }, to: { id: 7, input: 'negative' } })
  assert.equal(byId.slot, 1)
  assert.deepEqual(links.at(-1), [5, 1, 7, 1])
}

// A missing target explains which field it wanted.
{
  const { graph } = makeGraph()
  assert.throws(
    () => run(graph, { op: 'connect', from: { id: 5, output: 0 }, to: { input: 'positive' } }),
    /needs "id" or "to\.id"/,
  )
}

// disconnect resolves the same target, and an unknown input still names it.
{
  const { graph, nodes } = makeGraph()
  const target = makeNode(graph, 7, ['positive'])
  target.disconnectInput = slot => { target.disconnected = slot }
  nodes.set(7, target)
  run(graph, { op: 'disconnect', to: { id: 7, input: 'positive' } })
  assert.equal(target.disconnected, 0)
  assert.throws(
    () => run(graph, { op: 'disconnect', id: 7, to: { id: 7, input: 'nope' } }),
    /has no input "nope"/,
  )
}

// set_widget coerces to the existing widget's type.
{
  const { graph, nodes } = makeGraph()
  nodes.set(7, makeNode(graph, 7, [], [
    { name: 'steps', value: 12 },
    { name: 'cfg', value: 1 },
    { name: 'enabled', value: true },
    { name: 'label', value: 'x' },
  ]))
  const node = nodes.get(7)
  run(graph, { op: 'set_widget', id: 7, name: 'steps', value: '6' })
  run(graph, { op: 'set_widget', id: 7, name: 'cfg', value: 2.5 })
  run(graph, { op: 'set_widget', id: 7, name: 'enabled', value: 'true' })
  assert.deepEqual(node.widgets.map(widget => widget.value), [6, 2.5, true, 'x'])
  assert.equal(coerceWidgetValue({ value: 1 }, 'nope'), 'nope')
  assert.throws(() => run(graph, { op: 'set_widget', id: 7, name: 'absent', value: 1 }), /has no widget "absent"/)
}

// add_node rejects a class the editor does not know.
assert.throws(() => run(makeGraph().graph, { op: 'add_node', type: 'NoSuchNode' }), /Unknown node type/)

// Both dictionaries carry the same keys, so a missing translation cannot ship.
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())

// The top bar decides which lifecycle button is offered; these are the rules
// that used to live inline in JSX and could only be checked by eye.
const { barPlan } = mod.__ops
const text = key => en[key] ?? key
const plan = (service, extra = {}) => barPlan({
  status: 'ready',
  service,
  busy: false,
  dir: '/opt/ComfyUI',
  bootSeconds: 0,
  t: text,
  ...extra,
})
const running = { health: true, owned: true, state: 'running', pid: 2808 }
const stopped = { health: false, owned: false, state: 'stopped', pid: null }

// Unknown service: no button can be trusted yet.
{
  const result = plan(null, { status: 'loading' })
  assert.equal(result.label, en.barUnknown)
  assert.deepEqual(result.actions.map(action => [action.action, action.disabled]), [['start', true]])
}

// Stopped with a directory: one primary Start, nothing else competing for it.
{
  const result = plan(stopped)
  assert.equal(result.label, en.barStopped)
  assert.equal(result.tone, 'idle')
  assert.deepEqual(result.actions.map(action => action.action), ['start'])
  assert.equal(result.actions[0].variant, 'primary')
  assert.equal(result.actions[0].disabled, false)
}

// Stopped without a directory: Start stays visible but explains itself.
{
  const result = plan(stopped, { dir: '  ' })
  assert.equal(result.actions[0].disabled, true)
  assert.equal(result.actions[0].title, en.serverPick)
}

// While starting, the same slot reports progress instead of inviting a click.
{
  const result = plan({ ...stopped, state: 'starting' }, { status: 'loading' })
  assert.equal(result.label, en.barStarting)
  assert.equal(result.tone, 'warn')
  assert.equal(result.actions[0].disabled, true)
}

// A failed start is an error tone and Start becomes Retry.
{
  const result = plan({ ...stopped, state: 'failed' })
  assert.equal(result.label, en.barFailed)
  assert.equal(result.tone, 'error')
  assert.equal(result.actions[0].disabled, false)
  assert.equal(result.actions[0].title, en.serverStartFailed)
}

// Running and owned: Stop plus Restart, both quiet next to the primary style.
{
  const result = plan(running)
  assert.equal(result.label, en.barRunning)
  assert.equal(result.tone, 'ok')
  assert.deepEqual(result.actions.map(action => action.action), ['stop', 'restart'])
  assert.ok(result.actions.every(action => action.variant === 'quiet' && action.disabled === false))
  assert.equal(result.chipTitle, en.serverRunning.replace('{{pid}}', '2808'))
}

// A request in flight disables both, so a double click cannot race the host.
{
  const result = plan(running, { busy: true })
  assert.deepEqual(result.actions.map(action => action.disabled), [true, true])
}

// A healthy server the plugin does not own: Restart stays visible but inert.
{
  const result = plan({ health: true, owned: false, state: 'external', pid: null })
  assert.equal(result.label, en.barExternal)
  assert.deepEqual(result.actions.map(action => [action.action, action.disabled]), [['restart', true]])
  assert.equal(result.actions[0].title, en.serverExternalHint)
}

// The bridge lags the backend, so the label says both instead of "Connected".
{
  const loading = plan(running, { status: 'loading', bootSeconds: 12 })
  assert.equal(loading.tone, 'warn')
  assert.equal(loading.label, `${en.barRunning} · ${en.barConnecting} 12s`)
  const failedBridge = plan(running, { status: 'error' })
  assert.equal(failedBridge.tone, 'error')
  assert.equal(failedBridge.label, `${en.barRunning} · ${en.error}`)
}

console.log('client ops test passed')
