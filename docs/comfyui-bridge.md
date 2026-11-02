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
| `app.isGraphReady` | `true` once the editor graph exists; reading `rootGraph` earlier logs an error |
| `app.loadGraphData(workflow, clean = true, restoreView = true)` | replace the editor graph from a serialized workflow; `clean` drops the old graph, `restoreView` restores the saved camera |
| `app.canvas.canvas` | the 2D canvas element behind the editor; `toDataURL('image/png')` is the screenshot `comfyui_screenshot` returns |
| `app.canvasInternal` / `app.rootGraphRef` | Vue-level members; `canvasInternal` is the same canvas, `rootGraphRef.value` the same graph |
| `app.extensionManager.workflow.activeWorkflow` | the open `ComfyWorkflow`; its `filename` drives the tab label and Save target, and the panel reads it as the session's workflow name (see §5) |

`rootGraph`, `graph`, `canvas`, and `extensionManager` are `undefined` until
the Vue app has finished setting up, so wait for `comfyAPI.app.app` **and** for
`app.isGraphReady` before touching the graph. Reading `rootGraph` too early logs
`ComfyApp graph accessed before initialization`; the panel asks
`app.isGraphReady` first (older frontends without it fall back to the previous
check) and only reads the graph once it answers true. `comfyui_workflow_load`
calls `app.loadGraphData(workflow, true, false)` — clean the old graph, ignore
the saved camera because synced workflows strip view state — and waits for it
before syncing.

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

## 5. The workflow's name

The tab label, and the path Ctrl+S writes to, come from the active workflow's
`filename`:

```js
app.extensionManager.workflow.activeWorkflow.filename // 'deepseek-chan-emoji.json' or null
```

A canvas that was never saved has none, which is why every restored graph reads
"Unsaved Workflow (2)": the frontend autosaves the unsaved workflow in the
browser and restores it without a file identity. The Host mirrors the name as
the session's workflow name, so the panel bar, the digest, `comfyui_status`, and
the saved-slot list all use one word for one graph.

Two rules keep the two sides from fighting:

- the panel reports the name only when it changed, and a quiet re-sync omits it,
  so a name a workflow tool set is not cleared by the next idle tick;
- the Host never invents a file. Before renaming the tab the panel asks the
  editor's own `api.fetchApi('/userdata?dir=workflows')` and skips any name
  without `<name>.json`, and it only follows a name the Host *changed* — a
  steady name cannot overwrite the file the user opened in the meantime;
- the tab is renamed with the frontend's own convention: `filename = <name>`
  (no extension) and `path = workflows/<name>.json`. The store indexes a
  workflow by that path, so any other shape makes `getWorkflowByPath` miss it —
  which freezes its modified dot — and can send Save to a different file than
  the tab names;
- the panel reports `file` — the workflow file its editor holds, `null` when it
  holds none — on every sync. A name that came from a file is dropped when the
  editor stops holding it, so a frontend that fell back to its default graph
  cannot keep calling itself by the old workflow's name. A name a workflow tool
  gave the canvas is kept, because it names the canvas, not a file.

Verify after an upgrade: open the editor, read the `filename` above, and set it
to `'probe.json'`; the tab label must follow immediately.

## 6. Execution events follow `server.client_id`

ComfyUI sends `execution_start`, `executing`, `progress`, `executed`, and the
terminal events to the WebSocket that queued the prompt (`server.client_id`),
not to every client. The panel therefore reports the id the embedded editor's
socket registered with — `app.api.clientId`, else the iframe's `window.name` or
`sessionStorage` — with every state sync, and `comfyui_run` queues with that id.

Queue a prompt without it and everything looks fine except the user's editor:
no queue entry, no node progress, no preview, and nothing in the history — the
image exists on disk and nowhere in the UI.

The panel does not open a socket of its own. The editor's `api` is an
`EventTarget` that dispatches every message its own WebSocket receives — `status`,
`executing`, `progress`, `executed`, and the terminal events — so the parent page
subscribes to it and forwards what it hears to the Host. A socket of the panel's
own would receive nothing but `status` broadcasts, because no prompt ever queues
under its id; and it cannot borrow the editor's id either, since ComfyUI keys
`server.sockets` by client id and a second connection would replace the editor's.

The bus payload is not uniform, which is why `mapApiEvent` in `client.js` exists:
`executing` arrives as the node id alone, `status` as the queue state, everything
else as the raw message body. The iframe replaces its `api` on every reload, so
that subscription is re-established whenever the identity changes.

## Re-deriving this after an upgrade

1. Load the editor, then read `__COMFYUI_FRONTEND_VERSION__` and
   `Object.keys(comfyAPI.app.app)` in the iframe console.
2. Confirm `app.rootGraph`, `app.canvas.ds`, `app.graphToPrompt`, and
   `app.extensionManager.command.execute` still exist with the same shapes.
3. `npm run ui` — the panel check fails loudly when the surface moved.
4. Serialize a graph with a pan applied and confirm `extra.ds` still appears;
   if that setting changed, the revision check is the thing that regresses.
