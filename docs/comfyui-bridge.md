# The ComfyUI integration surface

The panel reaches into the ComfyUI frontend in three places: the same-origin
iframe's `window.comfyAPI` shim, the editor's own serialization, and ComfyUI's
command registry. All three are frontend internals, not a published API, so this
file records what the plugin relies on, why, and how to re-derive it after a
frontend upgrade.

Verified against **comfyui-frontend 1.57.1** (ComfyUI serving
`.venv/lib/python3.*/site-packages/comfyui_frontend_package/static/assets/`).

## 1. The shim: `window.comfyAPI.app.app`

The frontend exposes a compatibility object on `window.comfyAPI`. From a
same-origin parent frame (our panel is served under `/comfyui/`), the editor is:

```js
const app = frame.contentWindow.comfyAPI.app.app
```

It is a partial view of the real `ComfyApp`; what the plugin uses:

| Member | Use |
| --- | --- |
| `app.rootGraph` / `app.graph` | the live `LGraph`; `rootGraph` is the top-level graph, `graph` the one the canvas shows |
| `app.canvas` | the `LGraphCanvas`; `app.canvas.ds` is the camera |
| `app.canvas.selected_nodes` | `{ [nodeId]: node }` for the current selection |
| `app.graphToPrompt()` | `{ output }`, the API prompt keyed by node id |
| `app.extensionManager.command.execute(id)` | run a registered command (see §3) |
| `app.api.clientId` | the socket id ComfyUI will address execution events to |
| `app.loadGraphData(workflow)` | replace the editor graph from a serialized workflow |
| `app.canvasInternal` / `app.rootGraphRef` | Vue-level members; `canvasInternal` is the same canvas, `rootGraphRef.value` the same graph |

`rootGraph`, `graph`, `canvas`, and `extensionManager` are `undefined` until
the Vue app has finished setting up, so wait for `comfyAPI.app.app` **and** for
those members before touching the graph. The panel treats the API appearing as
"booting" and only reads the graph after `app.rootGraph` exists.

The shim itself is a legacy compatibility layer; it is why the plugin pins the
frontend version for anything beyond this milestone.

## 2. The graph and its serialization

`app.rootGraph.serialize()` returns the **UI workflow** — the same JSON ComfyUI
saves to a `.json` file and restores on load. Two properties matter:

- **Node and link ids are strings in the live graph and numbers in the
  serialized form.** `node.id` and `link.origin_id` / `link.target_id` are
  strings such as `'9'` while you walk `graph._nodes`, and integers after
  `serialize()`. `projection.js` and the panel's `projectGraph` normalize with
  `Number()`; comparing with `Number.isInteger` directly drops every node and
  the model silently sees an empty graph.
- **`extra.ds` is written on every serialization.** The frontend's
  `saveViewportWithGraph` setting (on by default) stamps `{ scale, offset }` of
  the camera into `extra.ds`, so zooming, panning, or resizing the panel changes
  the JSON without changing the workflow. The panel and the Host strip
  `extra.ds` (and then an empty `extra`) before comparing or storing, which is
  what keeps `rev` an edit counter rather than a viewport counter.

Positions and sizes on live nodes are `Float64Array`s (`node.pos`, `node.size`),
not arrays; they serialize back to `[x, y]`.

`graphToPrompt()` converts the graph to the **API prompt** — the format
`/prompt` accepts. It returns `{ output: { [nodeId]: { class_type, inputs } } }`
and throws on a graph that cannot be converted (missing links, an output node
with no input); the panel syncs the workflow without a prompt in that case.

## 3. The camera

`app.canvas.ds` is the pan/zoom state: `{ scale, offset: [x, y] }`. The mapping
is **not** the intuitive one:

```
screen = (graph + ds.offset) * ds.scale
```

so the visible graph rectangle is:

```
left = -offsetX                 right  = width  / scale - offsetX
top  = -offsetY                 bottom = height / scale - offsetY
```

Getting this backwards was a real bug: the first Fit implementation produced a
centered-looking result that was pinned off-screen, and drawing overlays
(selection outlines, node flashes) landed in the wrong place.

## 4. Commands, not internals

ComfyUI's toolbar and menus are commands registered on `app.extensionManager.command`.
Running the command is the supported way to perform an editor gesture, because
the command owns the context rules:

```js
await app.extensionManager.command.execute('Comfy.Canvas.FitView')
```

`Comfy.Canvas.FitView` frames the **selection** when there is one and the whole
graph otherwise, and toasts `Empty canvas` when the graph has no nodes. The
panel's Fit button calls exactly this and does not reimplement the math; a
reimplementation will disagree with the button next to the canvas. Check the
empty graph before calling it, or the user sees a toast they did not ask for.

Command ids live in the frontend bundle; search the assets for the id to find
its definition and behaviour:

```bash
cd <ComfyUI>/.venv/lib/python3.*/site-packages/comfyui_frontend_package/static/assets
grep -l 'Comfy.Canvas.FitView' *.js
```

## 5. Execution events follow `server.client_id`

ComfyUI sends `execution_start`, `executing`, `progress`, `executed`, and the
terminal events to the WebSocket that queued the prompt (`server.client_id`),
not to every client. The panel therefore opens its own ComfyUI WebSocket from
inside the iframe and reports `app.api.clientId` with every state sync, and
`comfyui_run` queues with that id.

Queue a prompt without it and everything looks fine except the user's editor:
no queue entry, no node progress, no preview, and nothing in the history — the
image exists on disk and nowhere in the UI.

## Re-deriving this after an upgrade

1. Load the editor, then read `__COMFYUI_FRONTEND_VERSION__` and
   `Object.keys(comfyAPI.app.app)` in the iframe console.
2. Confirm `app.rootGraph`, `app.canvas.ds`, `app.graphToPrompt`, and
   `app.extensionManager.command.execute` still exist with the same shapes.
3. `npm run ui` — the panel check fails loudly when the surface moved.
4. Serialize a graph with a pan applied and confirm `extra.ds` still appears;
   if that setting changed, the revision check is the thing that regresses.
