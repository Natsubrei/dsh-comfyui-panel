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

// The service poll is the one place the panel pays for a transition it cannot
// observe: fast while a start is in flight or the probe disagrees, slow once
// the server runs, because a supervisor crash takes 20 s to surface anyway.
{
  const { servicePollMs } = mod.__ops
  assert.equal(servicePollMs(null), 5000, 'an unread status polls at the default pace')
  assert.equal(servicePollMs({ state: 'starting', health: false }), 1000, 'a start is worth watching closely')
  assert.equal(servicePollMs({ state: 'restarting', health: false }), 1000)
  assert.equal(servicePollMs({ state: 'running', health: true }), 30000)
  assert.equal(servicePollMs({ state: 'running', health: false }), 5000, 'a probe that disagrees stays fast')
  assert.equal(servicePollMs({ state: 'stopped', health: false }), 5000)
}

// A frontend whose graph does not exist yet must read as "still booting", not
// as a bridge error: reading `rootGraph` early makes ComfyUI log an error.
{
  const { panelApp } = mod.__ops
  const ready = { isGraphReady: true }
  assert.equal(panelApp({ comfyAPI: { app: { app: ready } } }), ready)
  assert.equal(panelApp({ comfyAPI: { app: { app: { isGraphReady: false } } } }), null)
  const legacy = {}
  assert.equal(panelApp({ comfyAPI: { app: { app: legacy } } }), legacy, 'an older frontend has no readiness flag')
  assert.equal(panelApp(null), null)
  assert.equal(panelApp({}), null)
}

// Loading a saved workflow goes through the frontend's own `loadGraphData`,
// cleaning the old graph and ignoring the camera the saved file may carry.
{
  const { applyWorkflowGraph } = mod.__ops
  const calls = []
  const graph = {
    _nodes: [1, 2, 3],
    links: new Map([[1, {}], [2, {}]]),
    setDirtyCanvas() { calls.push('dirty') },
  }
  const app = {
    isGraphReady: true,
    async loadGraphData(workflow, clean, restore) {
      calls.push({ nodes: workflow.nodes.length, clean, restore })
      app.rootGraphOrUndefined = graph
    },
  }
  const value = await applyWorkflowGraph(app, { nodes: [1, 2, 3], links: [] })
  assert.deepEqual(value, { nodes: 3, links: 2 })
  assert.deepEqual(calls[0], { nodes: 3, clean: true, restore: false })
  assert.equal(calls[1], 'dirty')
  await assert.rejects(applyWorkflowGraph(app, { links: [] }), /not a ComfyUI UI workflow/)
  await assert.rejects(applyWorkflowGraph({}, { nodes: [] }), /cannot load a workflow/)
}

// The load is not done when the editor shows the graph: the Host has to have
// it. `syncNow` reports its own failure and returns, so the load must check the
// result or the tool reports success over a stale mirrored workflow.
{
  const { loadWorkflow } = mod.__ops
  const graph = {
    _nodes: [1, 2],
    links: new Map([[1, {}]]),
    setDirtyCanvas() {},
  }
  /** @type {any} */
  const app = {
    isGraphReady: true,
    async loadGraphData(workflow) {
      app.loadedNodes = workflow.nodes.length
      app.rootGraphOrUndefined = graph
    },
  }
  const fitted = []
  let syncCalls = 0
  const result = await loadWorkflow(app, { nodes: [1, 2], links: [] }, {
    fit: target => {
      fitted.push(target)
      return Promise.resolve(true)
    },
    sync: async () => {
      syncCalls += 1
      return true
    },
  })
  assert.deepEqual(result, { applied: 1, nodes: 2, links: 1, operations: [{ op: 'load_workflow' }] })
  assert.deepEqual(fitted, [app], 'the loaded graph is framed')
  assert.equal(syncCalls, 1)
  assert.equal(app.loadedNodes, 2)

  // The editor accepted the workflow but the Host did not: the load rejects
  // rather than returning counts the Host's mirrored graph does not match.
  await assert.rejects(
    loadWorkflow(app, { nodes: [1, 2], links: [] }, {
      fit: async () => true,
      sync: async () => false,
    }),
    /did not receive it/,
  )
}

// The editor's name is its file identity: the label ComfyUI shows and the path
// Save writes to. The panel reports it to the Host, and shows a Host-side name
// back once the file it names is known to exist (that check lives in
// `adoptWorkflowName`, which needs a page).
{
  const { workflowNameFromEditor, bindWorkflowLabel } = mod.__ops
  const editor = filename => ({
    extensionManager: { workflow: { activeWorkflow: { filename } } },
  })

  assert.equal(workflowNameFromEditor(editor('deepseek-chan-emoji.json')), 'deepseek-chan-emoji')
  assert.equal(workflowNameFromEditor(editor('sub/folder/pack.v2.json')), 'pack.v2')
  assert.equal(workflowNameFromEditor(editor(null)), null, 'an unsaved canvas has no name')
  assert.equal(workflowNameFromEditor(editor('')), null)
  assert.equal(workflowNameFromEditor({}), null, 'a frontend without a workflow service has no name')
  assert.equal(workflowNameFromEditor(null), null)

  const unsaved = editor(null)
  assert.equal(bindWorkflowLabel(unsaved, 'portrait'), true)
  assert.equal(workflowNameFromEditor(unsaved), 'portrait', 'the tab now names the workflow')
  assert.equal(unsaved.extensionManager.workflow.activeWorkflow.path, 'portrait.json')

  // A tool load replaces the canvas, so the tab has to move with it: leaving
  // the old file name would make Save write the loaded graph over the old file.
  const saved = editor('other.json')
  assert.equal(bindWorkflowLabel(saved, 'portrait'), true)
  assert.equal(workflowNameFromEditor(saved), 'portrait')

  assert.equal(bindWorkflowLabel(editor(null), ''), false)
  assert.equal(bindWorkflowLabel({}, 'portrait'), false, 'no workflow service means nothing to rename')
}

// The sync loop used to be a 127-line callback reachable only through a
// browser: the request body, the name rule, the generation guard and the
// Host's revision all met there and nothing covered them. `createSync` takes
// the editor adapter and the POST transport, so a fake editor and a fake
// `post` drive the same decisions here.
{
  const { createSync } = mod.__ops

  const makeState = (workflow = {
    nodes: [{ id: 1, type: 'Test' }],
    links: [],
    extra: { ds: { scale: 1, offset: [0, 0] } },
  }) => ({
    workflow,
    selection: [],
    name: null,
    clientId: '0123456789abcdef',
    prompt: { output: { 1: { class_type: 'Test' } } },
  })

  const makeSync = (state, responses = []) => {
    const calls = []
    const sync = createSync({
      sessionId: 'session-1',
      editor: () => ({
        graph: () => ({ serialize: () => state.workflow }),
        serialize: () => state.workflow,
        selection: () => state.selection,
        name: () => state.name,
        clientId: () => state.clientId,
        project: () => ({ nodes: [], linkCount: 0, selection: state.selection }),
        toPrompt: () => Promise.resolve(state.prompt),
      }),
      post: async payload => {
        calls.push(payload)
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next ?? { revision: payload.revision, name: state.name }
      },
      now: () => 1700000000000,
    })
    return { sync, calls }
  }

  // A quiet tick posts nothing. An unchanged graph and name must not bump the
  // revision, and the zoom/pan the frontend stamps into `extra.ds` is not an
  // edit: that is the difference between a panel that sits still and one that
  // grows the rev every 1.2 s.
  {
    const state = makeState()
    const { sync, calls } = makeSync(state)
    assert.equal((await sync.push(true)).posted, true)
    assert.equal(calls.length, 1)
    assert.equal((await sync.push(false)).posted, false)
    state.workflow.extra.ds.scale = 3
    assert.equal((await sync.push(false)).posted, false)
    assert.equal(calls.length, 1, 'an unchanged graph and name post nothing')
    state.selection = [1]
    assert.equal((await sync.push(false)).posted, true, 'a selection change is still a sync')
  }

  // A rename lives outside the graph JSON, so it needs its own post: this is
  // the regression where saving a workflow under a new name never reached the
  // Host. Only the change travels, and only once.
  {
    const state = makeState()
    const { sync, calls } = makeSync(state)
    await sync.push(true)
    state.name = 'portrait'
    const renamed = await sync.push(false)
    assert.equal(renamed.posted, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].name, 'portrait')
    assert.equal(calls[1].file, 'portrait', 'every body names the file the editor holds')
    assert.equal(calls[0].file, null, 'a file-less editor reports null, which lets the Host drop a stale name')
    assert.deepEqual(calls[1].workflow, calls[0].workflow, 'the workflow itself did not change')
    assert.equal((await sync.push(false)).posted, false, 'a steady name is not sent again')
    assert.equal(calls.length, 2)
  }

  // `extra.ds` is the camera. It must never reach the Host or every zoom and
  // pan would look like a graph edit, and an `extra` it leaves empty must be
  // dropped rather than posted as `{}`.
  {
    const posted = async workflow => {
      const { sync, calls } = makeSync(makeState(workflow))
      await sync.push(true)
      return calls[0]
    }
    const kept = await posted({ nodes: [], links: [], extra: { ds: { scale: 2 }, marker: 'keep' } })
    assert.deepEqual(kept.workflow.extra, { marker: 'keep' })
    const onlyCamera = await posted({ nodes: [], links: [], extra: { ds: { scale: 2 } } })
    assert.equal('extra' in onlyCamera.workflow, false, 'an extra with only the camera is dropped')
    assert.deepEqual(
      Object.keys(kept).sort(),
      ['clientId', 'file', 'prompt', 'revision', 'semantic', 'sessionId', 'workflow'],
      'the state body keeps its exact fields; no name is added when it did not change',
    )
  }

  // Two pushes overlap while the first is still converting the graph. The
  // older snapshot must not post once a newer one started, or the Host would
  // store an older workflow under a higher revision and nothing would correct
  // it: the next tick already holds the newer json and sees no change.
  {
    /** @type {((value: any) => void) | undefined} */
    let release
    let blocked = true
    let calls = 0
    const state = makeState()
    const sync = createSync({
      sessionId: 'session-1',
      editor: () => ({
        graph: () => ({ serialize: () => state.workflow }),
        serialize: () => state.workflow,
        selection: () => state.selection,
        name: () => state.name,
        clientId: () => state.clientId,
        project: () => ({}),
        toPrompt: () => {
          if (!blocked) return Promise.resolve(state.prompt)
          blocked = false
          return new Promise(resolve => { release = resolve })
        },
      }),
      post: async payload => {
        calls += 1
        return { revision: payload.revision, name: null }
      },
      now: () => 1,
    })
    const older = sync.push(true)
    const newer = sync.push(true)
    release?.(state.prompt)
    assert.equal((await older).posted, false, 'the stale push posts nothing')
    assert.equal((await newer).posted, true)
    assert.equal(calls, 1)
  }

  // The Host keeps the revision monotonic across page reloads, and the panel
  // has to adopt it: a page-local counter once showed rev 14 while the same
  // workflow read rev 49 from the model side.
  {
    const state = makeState()
    const { sync, calls } = makeSync(state, [
      { revision: 49, name: null },
      { revision: 49, name: null },
    ])
    const first = await sync.push(true)
    assert.equal(first.revision, 49)
    assert.equal(sync.snapshot().revision, 49)
    await sync.push(true)
    assert.equal(calls[1].revision, 50, 'the next body grows from the adopted number')
    assert.equal(sync.snapshot().revision, 50)
  }

  // A rejected POST is not a successful sync: it reports no sync time or
  // name, and the signature is forgotten so the next tick retries the same
  // graph instead of skipping it as unchanged.
  {
    const state = makeState()
    const { sync, calls } = makeSync(state, [
      new Error('Could not send the workflow to the Host. HTTP 500'),
      { revision: 3, name: null },
    ])
    await assert.rejects(sync.push(true), /HTTP 500/)
    assert.equal(sync.snapshot().at, 0, 'a rejected post claims no sync time')
    assert.equal(sync.snapshot().name, null, 'or a name it never got back')
    assert.equal(sync.snapshot().revision, 1, 'the local counter still advances before the POST, as before')
    assert.equal((await sync.push(false)).posted, true, 'the forgotten signature makes the next tick retry')
    assert.equal(calls.length, 2)
  }
}

console.log('client ops test passed')
