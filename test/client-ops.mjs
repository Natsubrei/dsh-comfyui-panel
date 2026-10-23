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

// The panel registers itself on a global the browser runtime installs; the
// node-side double only has to carry the one method `client.js` calls.
let registered = /** @type {any} */ (undefined)
globalThis.window = /** @type {any} */ ({ __ModuleLoader__: { load: module => { registered = module } } })
await import('../client.js')
if (registered === undefined) throw new Error('client.js did not register a module')
assert.equal(registered.id, 'dsh-comfyui-panel')

const fakeReact = {
  // A tree instead of `null`: the stage overlay is asserted by rendering it,
  // since "shows a Start button" is the thing a spinner bug hides.
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
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

// move_node changes `pos` and nothing else. Repositioning used to mean
// remove+add, which silently dropped every link and widget value on the node.
{
  const { graph, nodes } = makeGraph()
  const node = makeNode(graph, 7, ['positive'], [{ name: 'steps', value: 12 }])
  node.pos = [0, 0]
  nodes.set(7, node)
  const moved = run(graph, { op: 'move_node', id: 7, pos: [300, '120'] })
  assert.deepEqual(node.pos, [300, 120])
  assert.deepEqual(moved.pos, [300, 120])
  assert.equal(node.inputs[0].link, null, 'moving must not touch links')
  assert.equal(node.widgets[0].value, 12, 'moving must not touch widgets')
  assert.throws(() => run(graph, { op: 'move_node', id: 7, pos: [1] }), /needs "pos"/)
  assert.throws(() => run(graph, { op: 'move_node', id: 7, pos: ['a', 2] }), /needs "pos"/)
  assert.throws(() => run(graph, { op: 'move_node', id: 99, pos: [1, 2] }), /Node 99 not found/)
}

// A screenshot serializes the editor canvas; a canvas that cannot produce PNG
// bytes is an error rather than an empty picture.
{
  const { captureGraph } = mod.__ops
  const canvas = { width: 800, height: 600, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }
  const shot = captureGraph({ canvas: { canvas } })
  assert.equal(shot.kind, 'screenshot')
  assert.equal(shot.width, 800)
  assert.equal(shot.height, 600)
  assert.match(shot.dataUrl, /^data:image\/png;base64,/)
  assert.throws(() => captureGraph({}), /canvas is not ready/)
  assert.throws(() => captureGraph({ canvas: { canvas: { width: 1, height: 1, toDataURL: () => '' } } }), /refused to serialize/)
}

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

// The stage overlay. The regression: with ComfyUI stopped, the embedded
// frontend never exposes `comfyAPI.app`, so the bridge stays `loading` and the
// panel spun forever over a dead server. The server snapshot has to lead.
const { overlayPlan } = mod.__ops
const stage = (service, extra = {}) => overlayPlan({
  status: 'loading',
  service,
  bootSeconds: 0,
  dir: '/opt/ComfyUI',
  t: text,
  ...extra,
})

// Stopped + still "loading" is the bug: not a spinner, a way to start it.
{
  const result = stage(stopped)
  assert.equal(result.stage, 'stopped')
  assert.equal(result.title, en.notRunning)
  assert.equal(result.canStart, true)
  assert.equal(result.hint, '')
}

// No directory configured: Start is inert and the reason is on screen, not
// only in a hover title a touch user never sees.
{
  const result = stage(stopped, { dir: '   ' })
  assert.equal(result.stage, 'stopped')
  assert.equal(result.canStart, false)
  assert.equal(result.needDir, true)
  assert.equal(result.hint, en.serverPick)
}

// Starting is a progress report, not a clickable Start.
{
  const result = stage({ ...stopped, state: 'starting' }, { bootSeconds: 7 })
  assert.equal(result.stage, 'starting')
  assert.equal(result.title, en.serverStarting)
  assert.equal(result.seconds, 7)
  assert.equal(result.canStart, false)
}

// Healthy and booting: spinner with elapsed seconds.
{
  const result = stage(running, { bootSeconds: 3 })
  assert.equal(result.stage, 'loading')
  assert.equal(result.title, en.editorLoading)
  assert.equal(result.seconds, 3)
}

// Healthy but the frontend never hands over the editor: say so and offer a way
// out instead of an unbounded spinner.
{
  const result = stage(running, { bootSeconds: 45 })
  assert.equal(result.stage, 'stalled')
  assert.equal(result.title, en.editorStalled)
  assert.equal(result.hint, en.editorStalledHint)
}

// A ready editor owns the stage; syncing is still the editor.
{
  assert.equal(stage(running, { status: 'ready' }).stage, 'none')
  assert.equal(stage(running, { status: 'syncing' }).stage, 'none')
  assert.equal(stage(null, { status: 'ready' }).stage, 'none')
}

// Unknown service (the snapshot has not arrived yet) may still be booting.
{
  const result = stage(null)
  assert.equal(result.stage, 'loading')
  assert.equal(result.seconds, 0)
}

// A bridge error with a live server is not an overlay: the editor stays usable
// and the notice above it explains the failed sync.
{
  assert.equal(stage(running, { status: 'error' }).stage, 'none')
}

// What the user actually sees, rendered: no browser, no hooks, just the tree.
{
  const { StageOverlay } = mod.__ops
  const nodes = node => {
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(nodes)
    return [node, ...(node.children ?? []).flatMap(nodes)]
  }
  const render = (result, extra = {}) => nodes(StageOverlay({
    stage: result,
    busy: false,
    t: text,
    onStart() {},
    onReload() {},
    onService() {},
    ...extra,
  }))
  const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : (node.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join(''))
  const buttons = tree => tree.filter(node => node.type === 'button')

  // Stopped: the title, the reason, Start, and a way into the settings.
  {
    const tree = render(stage(stopped))
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-title').children[0], en.notRunning)
    const [start, settings] = buttons(tree)
    assert.equal(textOf(start), en.serverStart)
    assert.equal(start.props['data-variant'], 'primary')
    assert.equal(start.props.disabled, false)
    assert.equal(textOf(settings), en.serverPanel)
    assert.equal(tree.some(node => node.props.className === 'dsh-comfyui-spinner'), false)
  }

  // Stopped with no directory: Start is inert, and the hint is visible text.
  {
    const tree = render(stage(stopped, { dir: '' }))
    const start = buttons(tree)[0]
    assert.equal(start.props.disabled, true)
    assert.equal(start.props.title, en.serverPick)
    assert.ok(tree.some(node => node.props.className === 'dsh-comfyui-empty-hint' && node.children[0] === en.serverPick))
  }

  // A start in flight must not be clickable twice.
  {
    const tree = render(stage(stopped), { busy: true })
    assert.equal(buttons(tree)[0].props.disabled, true)
  }

  // Stalled: the recovery action is Reload, not Start.
  {
    const tree = render(stage(running, { bootSeconds: 90 }))
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-title').children[0], en.editorStalled)
    assert.equal(textOf(buttons(tree)[0]), en.reload)
    assert.equal(buttons(tree).length, 2)
  }

  // Loading and starting keep the spinner, with the elapsed time in the text.
  {
    const loading = render(stage(running, { bootSeconds: 3 }))
    assert.equal(loading.some(node => node.props.className === 'dsh-comfyui-spinner'), true)
    assert.equal(loading.find(node => node.type === 'span' && node.props.className === undefined).children[0], `${en.editorLoading} 3s`)
    assert.equal(buttons(loading).length, 0)
    const starting = render(stage({ ...stopped, state: 'starting' }, { bootSeconds: 7 }))
    assert.equal(starting.some(node => node.props.className === 'dsh-comfyui-spinner'), true)
    assert.ok(textOf(starting).includes(`${en.serverStarting} 7s`))
  }

  // Ready: nothing covers the canvas.
  assert.equal(render(stage(running, { status: 'ready' })).length, 0)
}

// The panel reads execution events from the editor's own event bus, so the
// mapping from that bus's payloads (which differ per kind) to the Host's event
// shape lives here and nowhere else.
{
  const { mapApiEvent } = mod.__ops
  assert.deepEqual(
    mapApiEvent('status', { exec_info: { queue_remaining: 3 } }),
    { kind: 'status', queueRemaining: 3 },
  )
  assert.deepEqual(
    mapApiEvent('executing', '9'),
    { kind: 'executing', promptId: null, node: '9' },
    'executing carries only the node id, not the message body',
  )
  assert.deepEqual(
    mapApiEvent('progress', { prompt_id: 'p1', node: '9', value: 3, max: 20 }),
    { kind: 'progress', promptId: 'p1', node: '9', value: 3, max: 20 },
  )
  assert.deepEqual(
    mapApiEvent('execution_error', { prompt_id: 'p1', exception_message: 'out of memory' }),
    { kind: 'execution_error', promptId: 'p1', error: 'out of memory' },
  )
  assert.deepEqual(
    mapApiEvent('execution_error', { prompt_id: 'p1', exception_type: 'OOM' }),
    { kind: 'execution_error', promptId: 'p1', error: 'OOM' },
    'an error without a message still says what kind it was',
  )
  assert.deepEqual(
    mapApiEvent('execution_start', { prompt_id: 'p1' }),
    { kind: 'execution_start', promptId: 'p1' },
  )
  assert.equal(mapApiEvent('logs', { message: 'x' }), null, 'kinds the Host does not record are dropped')
  assert.equal(mapApiEvent('b_preview', null), null)
}

// The relay is the only path a run's events take into the Host, so it has to
// subscribe to each recorded kind, feed both sinks, and detach cleanly when the
// iframe reloads.
{
  const { relayEditorEvents } = mod.__ops
  const handlers = new Map()
  const api = {
    addEventListener(kind, listener) {
      const list = handlers.get(kind)
      if (list === undefined) handlers.set(kind, [listener])
      else list.push(listener)
    },
    removeEventListener(kind, listener) {
      const list = handlers.get(kind) ?? []
      const index = list.indexOf(listener)
      if (index !== -1) list.splice(index, 1)
    },
  }
  const applied = []
  const posted = []
  const dispose = relayEditorEvents(api, {
    applyEvent: event => applied.push(event),
    postEvent: event => posted.push(event),
  })

  for (const kind of [
    'status', 'execution_start', 'execution_cached', 'executing', 'progress',
    'executed', 'execution_success', 'execution_error', 'execution_interrupted',
  ]) {
    assert.equal(handlers.get(kind)?.length, 1, `subscribed to ${kind}`)
  }
  assert.equal(handlers.has('logs'), false, 'kinds the Host does not record are not subscribed')

  handlers.get('progress')[0]({ detail: { prompt_id: 'p1', node: '9', value: 2, max: 8 } })
  assert.deepEqual(applied, [{ kind: 'progress', promptId: 'p1', node: '9', value: 2, max: 8 }], 'the bar sees the event')
  assert.deepEqual(posted, applied, 'the Host sees the same event')

  applied.length = 0
  handlers.get('status')[0]({ detail: { exec_info: { queue_remaining: 0 } } })
  assert.deepEqual(applied, [{ kind: 'status', queueRemaining: 0 }])

  dispose()
  assert.equal(handlers.get('progress').length, 0, 'disposing removes every listener')
}

// The Host has to queue as the iframe's socket, or ComfyUI sends the run's
// events to nobody the UI is listening to.
{
  const { frontendClientId } = mod.__ops
  assert.equal(frontendClientId({ name: '0f3c2b1a9d8e7f60' }), '0f3c2b1a9d8e7f60')
  assert.equal(
    frontendClientId({ name: '', sessionStorage: { getItem: () => 'abcdef0123456789' } }),
    'abcdef0123456789',
    "falls back to the id ComfyUI's api kept in sessionStorage",
  )
  assert.equal(
    frontendClientId(null, { api: { clientId: 'abcdef0123456789' } }),
    'abcdef0123456789',
    "the editor's own api is the authoritative source",
  )
  assert.equal(
    frontendClientId({ name: '0f3c2b1a9d8e7f60' }, { api: { clientId: 'not a socket id' } }),
    '0f3c2b1a9d8e7f60',
    'an unusable api id falls through to the window rather than winning',
  )
  assert.equal(frontendClientId({ name: 'not a socket id' }), null)
  assert.equal(frontendClientId(null), null)
  assert.equal(
    frontendClientId({ name: '', sessionStorage: { getItem() { throw new Error('blocked') } } }),
    null,
    'a blocked storage must not throw into the sync loop',
  )
}

// LiteGraph 0.4x keeps live node ids and link origins as strings. If the
// projection keeps them, the Host rejects every node and the model falls back
// to positional widgets, so the ids must be normalized to numbers.
{
  const { projectGraph } = mod.__ops
  const app = {
    rootGraph: {
      _nodes: [
        { id: '9', type: 'SaveImage', widgets: [{ name: 'filename_prefix', value: 'ComfyUI' }], inputs: [{ name: 'images', link: 7 }] },
        { id: '65', type: 'VAEDecode', widgets: [], inputs: [] },
      ],
      links: new Map([[7, { origin_id: '65', origin_slot: 0 }]]),
    },
    canvas: { selected_nodes: { 9: {} } },
  }
  const projection = projectGraph(app)
  assert.deepEqual(projection.nodes.map(node => node.id), [9, 65])
  assert.equal(projection.nodes[0].inputs.images, '65:0')
  assert.deepEqual(projection.selection, [9])
  assert.equal(projection.linkCount, 1)
}

// Framing goes through ComfyUI's own FitView command, because that is the
// code path behind the editor's zoom-to-fit button; the bounding-box fallback
// must at least center the node under the real camera semantics
// (`screen = (graph + offset) * scale`).
{
  const { fitCanvas, viewShowsAll } = mod.__ops
  const makeApp = (ds, size = { clientWidth: 719, clientHeight: 869 }) => ({
    canvas: { ds, canvas: size, setDirty() {} },
    rootGraph: { _nodes: [{ pos: Float64Array.from([1000, 1200]), size: Float64Array.from([300, 400]) }] },
  })

  let executed = null
  const commandApp = makeApp({ scale: 1, offset: Float64Array.from([0, 0]), min_scale: 0.1, max_scale: 10 })
  commandApp.extensionManager = { command: { execute: async id => { executed = id } } }
  assert.equal(await fitCanvas(commandApp), true)
  assert.equal(executed, 'Comfy.Canvas.FitView', 'the official command is preferred')

  const ds = { scale: 1, offset: Float64Array.from([0, 0]), min_scale: 0.1, max_scale: 10 }
  const app = makeApp(ds)
  assert.equal(await fitCanvas(app), true)
  const screenX = (1000 + ds.offset[0]) * ds.scale
  const screenY = (1200 + ds.offset[1]) * ds.scale
  assert.ok(screenX > 0 && screenX < 719, 'node lands inside the viewport horizontally')
  assert.ok(screenY > 0 && screenY < 869, 'and vertically')
  assert.equal(viewShowsAll(app), true, 'after fitting, the view contains every node')

  commandApp.extensionManager.command.execute = async () => { throw new Error('command unavailable') }
  assert.equal(await fitCanvas(commandApp), true, 'a failing command falls back instead of throwing')

  const unlaid = { scale: 1, offset: Float64Array.from([0, 0]), min_scale: 0.1, max_scale: 10 }
  assert.equal(await fitCanvas(makeApp(unlaid, { clientWidth: 0, clientHeight: 0 })), false, 'retry until laid out')
}

// The edit toast is the only place a user learns what the model changed, so
// each operation has to render as a concrete, short sentence.
{
  const { describeOperation } = mod.__ops
  assert.equal(describeOperation({ op: 'set_widget', id: 7, name: 'steps', value: 6 }), '#7.steps=6')
  assert.equal(describeOperation({ op: 'add_node', type: 'KSampler' }, { id: 13, type: 'KSampler' }), '+KSampler #13')
  assert.equal(describeOperation({ op: 'remove_node', id: 9 }), '-9')
  assert.equal(describeOperation({ op: 'move_node', id: 7 }, { pos: [300, 120] }), '#7 @300,120')
  assert.equal(
    describeOperation({ op: 'connect', from: { id: 4, output: 0 }, to: { id: 7, input: 'model' } }),
    '#4:0→#7.model',
  )
  assert.equal(describeOperation({ op: 'disconnect', to: { id: 7, input: 'model' } }), '#7.model ×')
}

console.log('client ops test passed')
