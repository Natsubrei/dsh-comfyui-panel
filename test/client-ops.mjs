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

// The bar offers a fixed pair of commands; only their availability changes.
// That rule used to live inline in JSX and could only be checked by eye.
const { barPlan } = mod.__ops
const text = key => en[key] ?? key
const plan = (service, extra = {}) => barPlan({
  status: 'ready',
  service,
  busy: false,
  dir: '/opt/ComfyUI',
  t: text,
  ...extra,
})
const running = { health: true, owned: true, state: 'running', pid: 2808 }
const stopped = { health: false, owned: false, state: 'stopped', pid: null }
const starting = { health: false, owned: true, state: 'starting', pid: 2808 }
const external = { health: true, owned: false, state: 'running', pid: null }
const failed = { health: false, owned: false, state: 'failed', pid: null }
const matrix = result => result.actions.map(action => [action.action, action.disabled])
const off = [['start', true], ['stop', true]]

// Unknown service: both commands are there, inert, and say why.
{
  const result = plan(null, { status: 'loading' })
  assert.equal(result.label, en.barUnknown)
  assert.deepEqual(matrix(result), off)
  assert.equal(result.actions[0].title, en.barUnknown)
}

// Stopped with a directory: Start is live, Stop has nothing to do.
{
  const result = plan(stopped)
  assert.equal(result.label, en.barStopped)
  assert.equal(result.tone, 'idle')
  assert.deepEqual(matrix(result), [['start', false], ['stop', true]])
  assert.equal(result.actions[1].title, en.serverStopped)
}

// Stopped without a directory: Start explains itself instead of firing.
{
  const result = plan(stopped, { dir: '  ' })
  assert.deepEqual(matrix(result), off)
  assert.equal(result.actions[0].title, en.serverPick)
}

// Starting: Stop is live (it cancels the boot), Start waits for the outcome.
{
  const result = plan(starting, { status: 'loading' })
  assert.equal(result.label, en.barStarting)
  assert.deepEqual(matrix(result), [['start', true], ['stop', false]])
  assert.equal(result.actions[0].title, en.serverStarting)
}

// A failed start leaves Start available for another try and nothing to stop.
{
  const result = plan(failed)
  assert.equal(result.label, en.barFailed)
  assert.equal(result.tone, 'error')
  assert.deepEqual(matrix(result), [['start', false], ['stop', true]])
  assert.equal(result.actions[1].title, en.serverStopped)
}

// Running and owned: Stop is live, Start says it is already up.
{
  const result = plan(running)
  assert.equal(result.label, en.barRunning)
  assert.equal(result.tone, 'ok')
  assert.deepEqual(matrix(result), [['start', true], ['stop', false]])
  assert.equal(result.actions[0].title, en.serverAlreadyRunning)
  assert.equal(result.chipTitle, en.serverRunning.replace('{{pid}}', '2808'))
}

// A request in flight greys both, so a double click cannot race the host.
{
  const result = plan(running, { busy: true })
  assert.deepEqual(matrix(result), off)
  assert.equal(result.actions[0].title, en.serverBusy)
}

// A healthy server the plugin does not own: both stay visible, both inert.
{
  const result = plan(external)
  assert.equal(result.label, en.barExternal)
  assert.deepEqual(matrix(result), off)
  assert.equal(result.actions[0].title, en.serverNotOwned)
  assert.equal(result.actions[1].title, en.serverNotOwned)
}

// A healthy server says so while the editor is still booting: that phase is
// the stage overlay's job, and "running · connecting" read as if the server
// were the thing still connecting.
{
  const loading = plan(running, { status: 'loading' })
  assert.equal(loading.tone, 'ok')
  assert.equal(loading.label, en.barRunning)
}

// A bridge that is actually broken is worth a red label, because every tool
// that needs the editor will fail.
{
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
  assert.equal(result.hint, en.notRunningHint)
}

// No directory configured: the hint says where to choose one, because the
// card itself carries no buttons any more.
{
  const result = stage(stopped, { dir: '   ' })
  assert.equal(result.stage, 'stopped')
  assert.equal(result.canStart, false)
  assert.equal(result.needDir, true)
  assert.equal(result.hint, en.notRunningPick)
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
    t: text,
    onReload() {},
    ...extra,
  }))
  const textOf = node => (Array.isArray(node) ? node.map(textOf).join('') : (node.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join(''))
  const buttons = tree => tree.filter(node => node.type === 'button')

  // Stopped: the title, the reason, and the folder. No buttons — the bar
  // underneath owns Start and Settings, and a second Start here only asked
  // which one was the real one.
  {
    const tree = render(stage(stopped))
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-title').children[0], en.notRunning)
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-hint').children[0], en.notRunningHint)
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-note').children[0], '/opt/ComfyUI')
    assert.equal(buttons(tree).length, 0)
    assert.equal(tree.some(node => node.props.className === 'dsh-comfyui-spinner'), false)
  }

  // Stopped with no directory: the hint names the folder, and there is still
  // nothing to click here.
  {
    const tree = render(stage(stopped, { dir: '' }))
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-hint').children[0], en.notRunningPick)
    assert.equal(tree.some(node => node.props.className === 'dsh-comfyui-empty-note'), false)
    assert.equal(buttons(tree).length, 0)
  }

  // Stalled: the one recovery action, because the editor cannot fix itself.
  {
    const tree = render(stage(running, { bootSeconds: 90 }))
    assert.equal(tree.find(node => node.props.className === 'dsh-comfyui-empty-title').children[0], en.editorStalled)
    assert.equal(textOf(buttons(tree)[0]), en.reload)
    assert.equal(buttons(tree).length, 1)
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
  assert.deepEqual(
    mapApiEvent('progress_state', {
      prompt_id: 'p1',
      nodes: { 9: { value: 4, max: 8, state: 'running' } },
    }),
    { kind: 'progress_state', promptId: 'p1', node: '9', value: 4, max: 8 },
    'the per-node progress state reduces to the running node',
  )
  assert.equal(mapApiEvent('progress_state', { nodes: {} }), null, 'an empty progress state has nothing to show')
  assert.deepEqual(
    mapApiEvent('executed', { prompt_id: 'p1', node: '9', output: { images: [{ filename: 'a.png' }, { filename: 'b.png' }] } }),
    { kind: 'executed', promptId: 'p1', node: '9', files: ['a.png', 'b.png'] },
    'output file names ride along for the bar tooltip',
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
  assert.equal(handlers.get('progress_state')?.length, 1, 'the bar reads progress_state without forwarding it')
  assert.equal(handlers.get('b_preview')?.length, 1, 'the bar reads bare previews')
  assert.equal(handlers.get('b_preview_with_metadata')?.length, 1, 'and previews with metadata')

  handlers.get('progress')[0]({ detail: { prompt_id: 'p1', node: '9', value: 2, max: 8 } })
  assert.deepEqual(applied, [{ kind: 'progress', promptId: 'p1', node: '9', value: 2, max: 8 }], 'the bar sees the event')
  assert.deepEqual(posted, applied, 'the Host sees the same event')

  applied.length = 0
  handlers.get('progress_state')[0]({
    detail: { prompt_id: 'p1', nodes: { 9: { value: 4, max: 8, state: 'running' }, 10: { value: 8, max: 8, state: 'finished' } } },
  })
  assert.deepEqual(applied, [{ kind: 'progress_state', promptId: 'p1', node: '9', value: 4, max: 8 }], 'the bar sees the running node')
  assert.equal(posted.some(event => event.kind === 'progress_state'), false, 'progress_state is not a Host event')

  const previewBlob = new Blob(['preview'], { type: 'image/png' })
  applied.length = 0
  handlers.get('b_preview')[0]({ detail: previewBlob })
  assert.equal(applied.length, 1)
  assert.equal(applied[0].kind, 'preview')
  assert.equal(applied[0].preview.blob, previewBlob)
  assert.equal(posted.some(event => event.kind === 'preview'), false, 'a preview Blob never reaches the Host')

  applied.length = 0
  handlers.get('status')[0]({ detail: { exec_info: { queue_remaining: 0 } } })
  assert.deepEqual(applied, [{ kind: 'status', queueRemaining: 0 }])

  dispose()
  assert.equal(handlers.get('progress').length, 0, 'disposing removes every listener')
  assert.equal(handlers.get('b_preview').length, 0, 'including the preview listeners')
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

// LiteGraph 0.4x keeps live node ids and link origins as strings. The Host
// accepts the canonical spelling too, but the contract is numeric: a
// non-canonical id ("09") would be dropped and the model would fall back to
// positional widgets, so the projection still normalizes to numbers.
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
    async loadGraphData(workflow, clean, restore, owner) {
      calls.push({ nodes: workflow.nodes.length, clean, restore, owner })
      app.rootGraphOrUndefined = graph
    },
  }
  const value = await applyWorkflowGraph(app, { nodes: [1, 2, 3], links: [] })
  assert.deepEqual(value, { nodes: 3, links: 2 })
  assert.deepEqual(calls[0], { nodes: 3, clean: true, restore: false, owner: null })
  assert.equal(calls[1], 'dirty')
  // The fourth argument is the tab the graph belongs to. Passing the store's
  // workflow keeps the graph in that file's tab; null asks the frontend for a
  // temporary one, the tab that then reports itself as "Unsaved Workflow".
  const owner = { path: 'workflows/portrait.json' }
  await applyWorkflowGraph(app, { nodes: [1], links: [] }, owner)
  assert.equal(calls[2].owner, owner, 'the workflow the caller named owns the loaded graph')
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

  // The name the Host loaded decides which tab owns the graph. A file the
  // editor's store knows keeps its own tab — one tab, its own name — while a
  // slot with no file behind it has to open temporarily, because there is no
  // file whose name it could carry.
  {
    const owners = []
    const store = {
      isGraphReady: true,
      extensionManager: {
        workflow: {
          getWorkflowByPath: path => (path === 'workflows/portrait.json' ? { path } : undefined),
        },
      },
      async loadGraphData(workflow, clean, restore, owner) {
        owners.push(owner)
        store.rootGraphOrUndefined = graph
      },
    }
    const hooks = { fit: async () => true, sync: async () => true }
    await loadWorkflow(store, { nodes: [1], links: [] }, { ...hooks, name: 'portrait' })
    assert.equal(owners[0]?.path, 'workflows/portrait.json', 'the file tab owns the loaded graph')
    await loadWorkflow(store, { nodes: [1], links: [] }, { ...hooks, name: 'slot-only' })
    assert.equal(owners[1], null, 'a slot with no file behind it opens as a temporary workflow')
    await loadWorkflow(store, { nodes: [1], links: [] }, hooks)
    assert.equal(owners[2], null, 'a load without a name has no file to look up')
  }

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

// Every tab the editor has open is page state the Host cannot see for itself:
// the Host mirrors one graph, so the tab list is the only way a reply can say
// which tab the user is looking at and what else is open beside it.
{
  const { readTabs, tabLabel } = mod.__ops
  const open = [
    { path: 'workflows/deepseek-chan-emoji.json', filename: 'deepseek-chan-emoji', isTemporary: false, isModified: false },
    { path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow', isTemporary: true, isModified: true },
    { path: '' },
  ]
  const app = {
    extensionManager: { workflow: { openWorkflows: open, isActive: workflow => workflow === open[0] } },
  }
  assert.deepEqual(readTabs(app), [
    { name: 'deepseek-chan-emoji', path: 'workflows/deepseek-chan-emoji.json', temporary: false, modified: false, active: true },
    { name: 'Unsaved Workflow', path: 'workflows/Unsaved Workflow.json', temporary: true, modified: true, active: false },
  ], 'the active flag is the store\'s own answer, not a guess')
  assert.equal(tabLabel(open[1]), 'Unsaved Workflow', 'a tab label is the label, even when no file has it')
  assert.equal(tabLabel({ filename: 'sub/folder/pack.json' }), 'pack')
  assert.equal(tabLabel({}), null)
  assert.deepEqual(readTabs({}), [], 'a frontend without the store reports no tabs rather than failing')
}

// Switching a tab loads that tab's own state. Reading the file instead would
// throw away the edits the tab is holding, which is exactly what the user is
// coming back to.
{
  const { switchTab } = mod.__ops
  const target = {
    path: 'workflows/portrait.json', filename: 'portrait', isLoaded: true,
    activeState: { nodes: [{ id: 1 }], links: [] },
  }
  const calls = []
  const graph = { _nodes: [1], links: new Map(), setDirtyCanvas() {} }
  const app = {
    extensionManager: { workflow: { openWorkflows: [target], isActive: () => true } },
    async loadGraphData(workflow, clean, restore, owner) {
      calls.push({ workflow, owner })
      app.rootGraphOrUndefined = graph
    },
  }
  const hooks = { fit: async () => true, sync: async () => true }
  const result = await switchTab(app, { name: 'portrait' }, hooks)
  assert.equal(result.switched, 'portrait')
  assert.equal(result.nodes, 1)
  assert.equal(calls[0].owner, target, 'the tab owns the graph it loads')
  assert.notEqual(calls[0].workflow, target.activeState, 'the tab state is cloned, so the store keeps its own copy')
  assert.deepEqual(calls[0].workflow, target.activeState)
  await assert.rejects(switchTab(app, { name: 'missing' }, hooks), /No open tab is named/)
  await assert.rejects(switchTab(app, { name: 'portrait' }, { ...hooks, sync: async () => false }), /did not receive it/)
}

// Closing: a clean tab moves off first, a tab with unsaved work asks the user
// through ComfyUI's own dialog, and the command answers before they do.
{
  const { closeTab } = mod.__ops
  const makeApp = ({ modified = false, temporary = false, dialog = null, save = async () => {}, single = false } = {}) => {
    const other = { path: 'workflows/other.json', filename: 'other', isLoaded: true, activeState: { nodes: [], links: [] } }
    const target = {
      path: 'workflows/portrait.json', filename: 'portrait', isLoaded: true,
      isModified: modified, isTemporary: temporary, activeState: { nodes: [], links: [] },
    }
    const closed = []
    const loaded = []
    const manager = {
      openWorkflows: single ? [target] : [target, other],
      isActive: workflow => workflow === target,
      saveWorkflow: save,
      closeWorkflow(workflow) {
        closed.push(workflow)
        manager.openWorkflows = manager.openWorkflows.filter(entry => entry !== workflow)
      },
    }
    const app = {
      extensionManager: { dialog, workflow: manager },
      async loadGraphData(workflow, clean, restore, owner) {
        loaded.push(owner)
        app.rootGraphOrUndefined = { _nodes: [], links: new Map(), setDirtyCanvas() {} }
      },
    }
    return { app, target, closed, loaded }
  }

  {
    const { app, target, closed, loaded } = makeApp()
    let syncs = 0
    const result = await closeTab(app, { name: 'portrait' }, { sync: async () => { syncs += 1; return true } })
    assert.equal(result.status, 'closed')
    assert.deepEqual(result.remaining, ['other'])
    assert.deepEqual(closed, [target])
    assert.deepEqual(loaded, [{ path: 'workflows/other.json', filename: 'other', isLoaded: true, activeState: { nodes: [], links: [] } }], 'the editor moves off the tab before it closes')
    assert.equal(syncs, 1)
  }

  {
    /** @type {any} */
    let asked = null
    const { app, closed } = makeApp({ modified: true, dialog: { confirm: input => { asked = input; return new Promise(() => {}) } } })
    const result = await closeTab(app, { name: 'portrait' }, { sync: async () => true })
    assert.equal(result.status, 'awaiting-confirmation', 'the command does not wait for the user')
    assert.equal(asked.type, 'dirtyClose')
    assert.deepEqual(asked.itemList, ['workflows/portrait.json'])
    assert.equal(asked.denyLabel, 'Close without saving')
    assert.equal(closed.length, 0, 'nothing closes before the user answers')
  }

  {
    const saved = []
    const { app, target, closed } = makeApp({
      modified: true,
      dialog: { confirm: async () => true },
      save: async workflow => { saved.push(workflow) },
    })
    assert.equal((await closeTab(app, { name: 'portrait' }, { sync: async () => true })).status, 'awaiting-confirmation')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(saved, [target], 'confirming saves first')
    assert.deepEqual(closed, [target], 'and only then closes')
  }

  {
    const { app, closed } = makeApp({ modified: true, dialog: { confirm: async () => false } })
    await closeTab(app, { name: 'portrait' }, { sync: async () => true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(closed.map(workflow => workflow.filename), ['portrait'], 'closing without saving closes')
  }

  {
    const { app, closed } = makeApp({ modified: true, dialog: { confirm: async () => null } })
    await closeTab(app, { name: 'portrait' }, { sync: async () => true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(closed.length, 0, 'cancelling keeps the tab')
  }

  {
    const { app } = makeApp({ modified: true, temporary: true })
    await assert.rejects(closeTab(app, { name: 'portrait' }, { sync: async () => true }), /no file to save/)
  }

  // A frontend without a dialog cannot ask whether to save. Saying "awaiting
  // the user" there would be a lie: nobody was asked.
  {
    const { app, closed } = makeApp({ modified: true, dialog: null })
    await assert.rejects(
      closeTab(app, { name: 'portrait' }, { sync: async () => true }),
      /cannot ask whether to save/,
    )
    assert.equal(closed.length, 0)
  }

  // A save that fails must leave the tab open, not close over the work.
  {
    const { app, closed } = makeApp({
      modified: true,
      dialog: { confirm: async () => true },
      save: async () => { throw new Error('disk full') },
    })
    const quiet = console.error
    console.error = () => {}
    try {
      await closeTab(app, { name: 'portrait' }, { sync: async () => true })
      await new Promise(resolve => setTimeout(resolve, 0))
    } finally {
      console.error = quiet
    }
    assert.equal(closed.length, 0, 'a failed save leaves the tab open')
  }

  // The last tab: the editor loads its default workflow instead of keeping a
  // graph no tab owns.
  {
    const { app, target, closed } = makeApp({ single: true })
    let defaults = 0
    app.loadGraphData = async (...args) => {
      if (args.length === 0) defaults += 1
      app.rootGraphOrUndefined = { _nodes: [], links: new Map(), setDirtyCanvas() {} }
    }
    await closeTab(app, { name: 'portrait' }, { sync: async () => true })
    assert.equal(defaults, 1, 'closing the only tab falls back to the default workflow')
    assert.deepEqual(closed, [target])
  }
}

// A path addresses exactly one tab; a label two files share names the
// candidates instead of leaving the caller stuck.
{
  const { switchTab } = mod.__ops
  const first = { path: 'workflows/a/portrait.json', filename: 'portrait', isLoaded: true, activeState: { nodes: [], links: [] } }
  const second = { path: 'workflows/b/portrait.json', filename: 'portrait', isLoaded: true, activeState: { nodes: [], links: [] } }
  const app = {
    extensionManager: { workflow: { openWorkflows: [first, second], isActive: () => true } },
    async loadGraphData(workflow, clean, restore, owner) {
      app.owner = owner
      app.rootGraphOrUndefined = { _nodes: [], links: new Map(), setDirtyCanvas() {} }
    },
  }
  const hooks = { fit: async () => true, sync: async () => true }
  const byPath = await switchTab(app, { path: 'workflows/b/portrait.json' }, hooks)
  assert.equal(byPath.path, 'workflows/b/portrait.json')
  assert.equal(app.owner, second, 'a path picks the exact tab, not the first label match')
  await assert.rejects(
    switchTab(app, { name: 'portrait' }, hooks),
    /address one by its path instead: workflows\/a\/portrait\.json, workflows\/b\/portrait\.json/,
  )
  await assert.rejects(switchTab(app, { path: 'workflows/c/portrait.json' }, hooks), /No open tab has the path/)
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
  // 1.57 writes ComfyUI's own "Unsaved Workflow" label into `filename` instead
  // of leaving it empty. It is a label, not a file: reporting it renamed the
  // session's workflow after every load made into a temporary tab.
  assert.equal(workflowNameFromEditor(editor('Unsaved Workflow')), null)
  assert.equal(workflowNameFromEditor(editor('workflows/Unsaved Workflow.json')), null)
  assert.equal(workflowNameFromEditor(editor('Unsaved Workflow (2)')), null, 'a duplicated draft keeps the label')
  assert.equal(workflowNameFromEditor(editor('Unsaved')), 'Unsaved', 'only the whole label is the placeholder')
  assert.equal(workflowNameFromEditor({}), null, 'a frontend without a workflow service has no name')
  assert.equal(workflowNameFromEditor(null), null)

  const unsaved = editor(null)
  assert.equal(bindWorkflowLabel(unsaved, 'portrait'), true)
  assert.equal(workflowNameFromEditor(unsaved), 'portrait', 'the tab now names the workflow')
  assert.equal(unsaved.extensionManager.workflow.activeWorkflow.path, 'workflows/portrait.json', 'Save keeps writing under workflows/')

  // A tool load replaces the canvas, so the tab has to move with it: leaving
  // the old file name would make Save write the loaded graph over the old file.
  const saved = editor('other.json')
  assert.equal(bindWorkflowLabel(saved, 'portrait'), true)
  assert.equal(workflowNameFromEditor(saved), 'portrait')

  assert.equal(bindWorkflowLabel(editor(null), ''), false)
  assert.equal(bindWorkflowLabel({}, 'portrait'), false, 'no workflow service means nothing to rename')

  // The tab takes the frontend's own convention: `filename` without the
  // extension, `path` under `workflows/`. Anything else makes the store miss
  // the workflow and can send Save somewhere the tab does not name.
  {
    const draft = { filename: 'Unsaved Workflow', path: 'workflows/Unsaved Workflow.json' }
    assert.equal(bindWorkflowLabel({ extensionManager: { workflow: { activeWorkflow: draft } } }, 'portrait'), true)
    assert.equal(draft.filename, 'portrait', 'the tab shows the name, not the file name')
    assert.equal(draft.path, 'workflows/portrait.json')
  }
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
    tabs: [],
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
        tabs: () => state.tabs ?? [],
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

  // The tab can also lose its file — a load into a temporary workflow, or the
  // user opening a new canvas. That is reported as `file: null` and no `name`:
  // the Host drops a name it took from a file and keeps one a tool gave the
  // session, which is the distinction the two fields exist for.
  {
    const state = makeState()
    const { sync, calls } = makeSync(state, [
      { revision: 1, name: 'portrait' },
      { revision: 2, name: 'portrait' },
    ])
    state.name = 'portrait'
    await sync.push(true)
    state.name = null
    const dropped = await sync.push(false)
    assert.equal(dropped.posted, true, 'losing the file is a change worth reporting')
    assert.equal(calls[1].file, null)
    assert.equal('name' in calls[1], false, 'no name travels for a canvas that has none')
  }

  // The tab list travels beside the graph, so a tab switch changes no node and
  // still has to post — otherwise the Host keeps a list from before the switch.
  {
    const state = makeState()
    state.tabs = [{ name: 'portrait', path: 'workflows/portrait.json', temporary: false, modified: false, active: true }]
    const { sync, calls } = makeSync(state)
    await sync.push(true)
    assert.equal(calls[0].tabs.length, 1)
    state.tabs = [
      { name: 'portrait', path: 'workflows/portrait.json', temporary: false, modified: false, active: false },
      { name: 'Unsaved Workflow', path: 'workflows/Unsaved Workflow.json', temporary: true, modified: false, active: true },
    ]
    const moved = await sync.push(false)
    assert.equal(moved.posted, true, 'a tab switch is worth a sync even when the graph is unchanged')
    assert.deepEqual(calls[1].tabs.map(tab => tab.name), ['portrait', 'Unsaved Workflow'])
    assert.deepEqual(calls[1].workflow, calls[0].workflow, 'the graph is still the same graph')
    assert.equal((await sync.push(false)).posted, false, 'an unchanged tab list is quiet again')
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
      ['clientId', 'file', 'prompt', 'revision', 'semantic', 'sessionId', 'tabs', 'workflow'],
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
        tabs: () => [],
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

// A preview event arrives as binary in two shapes, and the panel has to reduce
// both to the same record without ever handing the Blob to the Host. The URL
// itself stays in the component: nothing here mocks a browser.
{
  const { readPreview, progressSummary, applyRunEvent, runLabel, cancelLabel } = mod.__ops
  const blob = new Blob(['png'], { type: 'image/png' })

  assert.deepEqual(readPreview(blob), { blob, nodeId: null, promptId: null }, 'b_preview carries the Blob itself')
  assert.deepEqual(
    readPreview({ blob, nodeId: 12, promptId: 'p1' }),
    { blob, nodeId: '12', promptId: 'p1' },
    'b_preview_with_metadata names the node and the prompt',
  )
  assert.deepEqual(
    readPreview({ blob, node_id: '9', prompt_id: 'p2' }),
    { blob, nodeId: '9', promptId: 'p2' },
    'the ComfyUI spelling with underscores is understood too',
  )
  for (const bad of [null, undefined, {}, { blob: 'not a blob' }, { blob: null }, 7, 'preview']) {
    assert.equal(readPreview(bad), null, `bad preview payload ${String(bad)} is ignored`)
  }

  // `progress_state` maps every node in the prompt; the bar has one line.
  assert.deepEqual(
    progressSummary({
      nodes: {
        12: { value: 14, max: 20, state: 'running' },
        13: { value: 20, max: 20, state: 'finished' },
      },
    }),
    { node: '12', value: 14, max: 20 },
    'the running node wins over a finished one',
  )
  assert.deepEqual(
    progressSummary({
      nodes: {
        12: { value: 1, max: 10, state: 'running' },
        9: { value: 2, max: 10, state: 'running' },
      },
    }),
    { node: '9', value: 2, max: 10 },
    'the lowest id breaks a tie, so the bar does not flicker between nodes',
  )
  assert.deepEqual(
    progressSummary({ nodes: { 4: { value: 10, max: 10, state: 'finished' } } }),
    { node: '4', value: 10, max: 10 },
    'without a running node a finished node still has a number to show',
  )
  assert.equal(progressSummary({ nodes: { 4: { value: 1, max: 0, state: 'running' } } }), null)
  assert.equal(progressSummary({}), null)
  assert.equal(progressSummary(null), null)

  for (const key of ['runNode', 'runSeconds', 'runCancel', 'runCancelling', 'runCancelFailed']) {
    assert.equal(typeof en[key], 'string', `${key} exists in en`)
    assert.equal(typeof zh[key], 'string', `${key} exists in zh`)
  }

  const now = 1_700_000_010_000
  const active = {
    status: 'running',
    node: '12',
    value: 14,
    max: 20,
    startedAt: now - 5_000,
    files: [],
    preview: null,
    cancel: 'none',
  }
  assert.equal(
    runLabel(active, text, now),
    `${en.runNode.replace('{{node}}', '12')} · 14/20 · ${en.runSeconds.replace('{{seconds}}', '5')}`,
    'the line carries the node, the step count and the elapsed seconds',
  )
  assert.equal(
    runLabel({ ...active, node: null, value: null, max: null }, text, now),
    en.runSeconds.replace('{{seconds}}', '5'),
    'a started run with no node progress still shows its clock',
  )
  assert.equal(runLabel({ ...active, status: 'error' }, text, now), en.runFailed)
  assert.equal(runLabel({ ...active, status: 'interrupted' }, text, now), en.runInterrupted)
  assert.equal(runLabel({ ...active, cancel: 'failed' }, text, now), en.runCancelFailed, 'a failed cancel replaces the line')
  assert.equal(runLabel({ ...active, status: 'success' }, text, now), '')
  assert.equal(runLabel(null, text), '')
  assert.equal(cancelLabel({ cancel: 'busy' }, text), en.runCancelling)
  assert.equal(cancelLabel({ cancel: 'none' }, text), en.runCancel)

  // The transition, not the component, decides what a finished run leaves
  // behind: no thumbnail state, no cancel phase, and an empty bar line.
  const started = applyRunEvent(null, { kind: 'execution_start', promptId: 'p1' }, 1_000)
  assert.equal(started.status, 'running')
  assert.equal(started.promptId, 'p1')
  assert.equal(started.startedAt, 1_000, 'execution_start records when the run began')

  const previewed = applyRunEvent(started, { kind: 'preview', preview: { blob, nodeId: '12', promptId: 'p1' } }, 2_000)
  assert.equal(previewed.preview.blob, blob)
  assert.equal(previewed.promptId, 'p1')

  const stepped = applyRunEvent(previewed, { kind: 'progress_state', promptId: 'p1', node: '12', value: 14, max: 20 }, 3_000)
  assert.equal(stepped.node, '12')
  assert.equal(stepped.value, 14)

  const withFiles = applyRunEvent(stepped, { kind: 'executed', promptId: 'p1', node: '12', files: ['a.png'] }, 3_500)
  assert.deepEqual(withFiles.files, ['a.png'], 'executed output names are kept for the tooltip')
  const moreFiles = applyRunEvent(withFiles, { kind: 'executed', promptId: 'p1', node: '12', files: ['a.png', 'b.png'] }, 3_600)
  assert.deepEqual(moreFiles.files, ['a.png', 'b.png'], 'repeated names are not duplicated')

  const done = applyRunEvent(moreFiles, { kind: 'execution_success', promptId: 'p1' }, 5_000)
  assert.equal(done.status, 'success')
  assert.equal(done.preview, null, 'a finished run leaves no preview behind')
  assert.equal(runLabel(done, text, 5_000), '')

  assert.equal(applyRunEvent(previewed, { kind: 'execution_error', promptId: 'p1' }, 5_000).preview, null)
  const interrupted = applyRunEvent(previewed, { kind: 'execution_interrupted', promptId: 'p1' }, 5_000)
  assert.equal(interrupted.preview, null)
  assert.equal(runLabel(interrupted, text, 5_000), en.runInterrupted)

  const busy = applyRunEvent(started, { kind: 'cancel', state: 'busy' }, 3_000)
  assert.equal(cancelLabel(busy, text), en.runCancelling)
  assert.equal(
    runLabel(busy, text, 3_000),
    en.runSeconds.replace('{{seconds}}', '2'),
    'the button says Cancelling…; the progress line keeps its numbers',
  )
  const failed = applyRunEvent(busy, { kind: 'cancel', state: 'failed' }, 4_000)
  assert.equal(failed.cancel, 'failed')
  assert.equal(runLabel(failed, text, 4_000), en.runCancelFailed)
  const cancelled = applyRunEvent(busy, { kind: 'execution_interrupted', promptId: 'p1' }, 5_000)
  assert.equal(cancelled.cancel, 'none')
  assert.equal(cancelled.preview, null)

  // The component arms a 10 s fallback after a successful request; its release
  // is the same Cancel transition with no state, which must leave the run and
  // its progress exactly as they were.
  const released = applyRunEvent(busy, { kind: 'cancel', state: 'none' }, 13_000)
  assert.equal(released.cancel, 'none')
  assert.equal(released.status, 'running')
  assert.equal(released.node, busy.node)
  assert.equal(released.value, busy.value)
  assert.equal(released.max, busy.max)
  assert.equal(runLabel(released, text, 13_000), runLabel(busy, text, 13_000), 'the progress line does not move')
  assert.equal(cancelLabel(released, text), en.runCancel, 'the button is usable again')
}

// The bar is the only place Cancel and the thumbnail exist, and its tree is
// pure, so it renders without a browser: the button belongs to a running
// prompt, says what the request is doing, and goes away with the run.
{
  const { TopBar, barPlan, runLabel } = mod.__ops
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(walk)
    return [node, ...(node.children ?? []).flatMap(walk)]
  }
  const render = (run, extra = {}) => walk(TopBar({
    stats: { nodes: 2, links: 1, revision: 3, name: null },
    syncLabel: '',
    syncAt: 0,
    runText: runLabel(run, text, 1_700_000_010_000),
    previewUrl: '',
    previewTitle: '',
    filesTitle: '',
    run,
    plan: barPlan({
      status: 'ready',
      service: { health: true, owned: true, state: 'running', pid: 1 },
      dir: '/opt/ComfyUI',
      t: text,
    }),
    serviceOpen: false,
    t: text,
    onSync() {},
    onReload() {},
    onFit() {},
    onOpen() {},
    onService() {},
    onAction() {},
    onCancel() {},
    ...extra,
  }))
  const buttons = tree => tree.filter(node => node.type === 'button')
  const cancel = tree => buttons(tree).find(button => button.props['data-action'] === 'cancel')
  const running = {
    status: 'running',
    promptId: 'p1',
    node: '12',
    value: 14,
    max: 20,
    startedAt: 1_700_000_005_000,
    files: [],
    preview: null,
    cancel: 'none',
  }

  // The popover is the same three buttons in every state, and Settings is a
  // word rather than a glyph.
  {
    const body = buttons(render(running))
      .filter(button => typeof button.props.className === 'string'
        && button.props.className.includes('dsh-comfyui-button')
        && button.props['data-action'] !== 'cancel')
    assert.deepEqual(body.map(button => button.children[0]), [en.serverStart, en.serverStop, en.settings])
    assert.equal(body.some(button => button.props['aria-label'] === 'settings'), false, 'no icon-only Settings')
  }
  {
    const tree = render(running)
    assert.equal(cancel(tree)?.children[0], en.runCancel)
    assert.equal(cancel(tree)?.props.disabled, false)
    assert.equal(
      tree.find(node => node.props.className === 'dsh-comfyui-run')?.children[0],
      `${en.runNode.replace('{{node}}', '12')} · 14/20 · ${en.runSeconds.replace('{{seconds}}', '5')}`,
      'the bar line shows the node, the steps and the elapsed seconds',
    )
  }
  {
    const tree = render({ ...running, cancel: 'busy' })
    assert.equal(cancel(tree)?.children[0], en.runCancelling, 'the button names the request in flight')
    assert.equal(cancel(tree)?.props.disabled, true, 'and cannot be clicked twice')
  }
  {
    assert.equal(cancel(render({ ...running, status: 'success' })), undefined, 'a finished run has no Cancel')
    assert.equal(cancel(render(null)), undefined, 'and neither has no run at all')
  }
  {
    const tree = render(running, { previewUrl: 'blob:preview', previewTitle: 'a.png' })
    const image = tree.find(node => node.type === 'img')
    assert.equal(image?.props.src, 'blob:preview')
    assert.equal(image?.props.title, 'a.png')
    assert.equal(render(running).some(node => node.type === 'img'), false, 'no preview URL, no thumbnail')
  }
}

console.log('client ops test passed')
