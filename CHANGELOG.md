# Changelog

Notable changes to the plugin. The version in `package.json` is the source of
truth, and every release is pinned by a commit in `market/index.json`.

## Unreleased

- `comfyui_status` gains `diagnostics`: one row for each layer between the
  model and a run (`upstream`, `frontend`, `panel`, `commandChannel`,
  `storage`, `supervisor`, `workflow`), with a one-sentence `detail` and an
  `action` when that layer is broken. It is built only from facts the status
  call already read, so the report sends no extra request.
- `comfyui_run` with `wait=true` returns a successful run's output images as
  image attachments beside the text result (up to four `type: 'output'` files,
  20 MB each), so the images appear in the conversation. A missing attachment
  service, an unreadable or unsupported image, or a model route that does not
  declare image input falls back to the text result with the file names, so an
  image failure never loses the run.
- `comfyui_run` attaches the session's UI workflow to `/prompt` as
  `extra_data.extra_pnginfo.workflow`, so `SaveImage` writes it into the PNG's
  text metadata and dragging the image back into ComfyUI restores the graph.
  The API prompt is not attached.
- New `comfyui_cancel` tool interrupts the run this session queued, or a given
  prompt id, through `POST /interrupt`; a prompt that already finished is a
  no-op. Copying output files to a chosen path is still missing.
- `comfyui_run` no longer goes dark when the panel closes. The Host polls
  `/queue` and `/history/{id}` for every prompt the tool queued, writes the
  state into the session's run record, and `comfyui_progress` returns it as
  `hostRun` with the output file names. A queue read that fails keeps the last
  status and retries; after 30 minutes the tracker stops and reports `lost`.
  Panel step progress still needs the panel, and the tracker ends with the
  plugin.
- The top bar shows the latest preview from the editor's `b_preview` and
  `b_preview_with_metadata` events as a thumbnail. A new preview replaces the
  old one and revokes its object URL; preview Blobs stay in the page and are
  never posted to the Host.
- `progress_state` reduces to the running node on the bar (`node 12 · 14/20`),
  elapsed seconds tick while a run is active, and `executed` output file names
  appear in the run line's tooltip. Runs without `progress_state` keep the
  existing `progress` readout.
- A running prompt this session queued gets a `Cancel` button. It POSTs
  `/comfyui/interrupt` with that `prompt_id`, disables itself as
  "Cancelling…" until the editor reports the interruption, and reports a
  failed request in the run line instead of throwing.

## 0.7.2

- The panel path is fixed at `/comfyui`. A profile patch that sets another
  `prefix` fails plugin load instead of serving the proxy where the panel
  never opens.
- The proxy strips the DSH session cookie (`dsh-auth-…`) before forwarding a
  request to ComfyUI. Other cookies and `Authorization` are still forwarded;
  point `upstream` at a server you trust. See SECURITY.md.
- A ComfyUI that reports a frontend version other than 1.57.1 shows a panel
  notice. The panel keeps working. A server that omits the field is left alone.
- Adopting an already-running ComfyUI no longer requires Linux `/proc` when
  `lsof` can name the process working directory. The panel looks for
  `.venv/Scripts/python.exe` on Windows.
- `npm test` no longer fails because the current account name or hostname is an
  ordinary word in the tree. Path leaks are still rejected. The pre-commit hook
  keeps the stricter word scan (`DSH_HYGIENE_STRICT=1`).
- The npm package ships `docs/comfyui-bridge.md` and `SECURITY.md`, and no
  longer ships `scripts/dsh-web.sh`. That script stays in the repository for
  maintainers.
- A workflow name that came from a file is dropped when the editor no longer
  holds that file. A name a tool gave the canvas stays. The editor tab is
  renamed with the frontend's own path, so Save stays under `workflows/` and
  the modified dot does not freeze.

## 0.7.1

- Workflows have a name that the panel, the model, and the saved slots agree on.
  The session record carries an optional `name`; the panel bar shows it, the
  runtime-context digest reads `rev … · "name" · …`, `comfyui_status` includes
  it, and `comfyui_workflow_list` marks the slot the session is editing.
  `comfyui_workflow_save` and `comfyui_workflow_load` set it, and the panel
  reports the name the editor would save under when the user opens or saves a
  file in ComfyUI. A name only reaches the editor's tab when ComfyUI already
  holds `<name>.json`, so the panel never points Save at a path that does not
  exist; a reload of a named session no longer looks like a nameless
  "Unsaved Workflow".
- `npm test` now runs the real-runtime contract when a built DeepSeek Harness
  checkout is next to this repository, so a DSH API drift fails the next
  ordinary test run instead of sitting unnoticed until a release. A machine
  without the checkout skips it, as CI does.
- Host smoke takes its five ports from `DSH_COMFYUI_TEST_PORT` (default 18188),
  so several checkouts, such as parallel worktrees, can run the full suite
  without colliding.

## 0.7.0

- Saved workflows are now a first-class feature. `comfyui_workflow_save` stores
  the session's synced graph under a name in a new `workflows` table of the
  `dsh_comfyui` domain, `comfyui_workflow_list` reads the slots back,
  `comfyui_workflow_load` replaces the open panel's graph through the command
  channel, and `comfyui_workflow_export` / `comfyui_workflow_import` move UI
  workflow JSON to and from files. Only `load` needs the panel open, and the
  file tools work in a session that has already synced or restored a workflow.
- Export and import paths must stay inside the session workspace; a relative
  path resolves against it and a path that escapes it is rejected instead of
  letting the tool read or overwrite arbitrary files.
- `comfyui_workflow_load` waits for the frontend's own `loadGraphData` and the
  following sync, so the Host's mirrored workflow is the loaded one when the
  tool returns. A failed state POST rejects the load instead of reporting
  success over a stale mirror, and a page still running the previous client
  answers the command as an empty edit, which the tool also reports.
- `npm run contract` mounts the native tool executor the current DSH composition
  requires and drives tools through the batch API, so the real-runtime check
  runs again; it now covers saving, listing, exporting, importing, and loading a
  named workflow.

## 0.6.11

- Disposing a session now ends everything its panel was still holding. DSH
  emits `agent/disposed` on clear and compaction too, and the same session id
  comes back with a new agent; a queued edit used to wait out its timeout and
  could be handed to the next panel, changing a graph the model no longer
  believed it touched. The queued command, the parked long-poll, the run
  record, and the seed cursors go with the agent; the canvas stays in
  `sessions` and in storage.
- A panel edit or screenshot gives up after 20 s / 15 s instead of 45 s / 30 s.
  The panel answers in milliseconds when it is there, and the old budget only
  made a closed tab feel like a hang.
- The bar polls the server status at the pace the state deserves: 1 s while a
  start is in flight, 30 s once the server runs healthy, 5 s otherwise. A start
  is the one transition the panel cannot see any other way, and polling for it
  every five seconds left `Starting ComfyUI…` on screen after the editor was
  already usable.
- The first sync tick no longer reads the editor's graph before ComfyUI
  initializes it. The frontend logs `ComfyApp graph accessed before
  initialization` and the bar showed a `Bridge error` chip until the next tick;
  the panel now asks `isGraphReady` first, and an older frontend without that
  flag behaves as before.
- `npm run ui` clicks the sidebar tab entry itself instead of a coordinate
  sampled while the right sidebar was still sliding open, which missed the
  entry and reported a timeout.

## 0.6.10

- Unloading the plugin no longer stops a ComfyUI it *adopted* — a server that
  was already running when the plugin loaded, or the plugin's own child from
  before a Host crash. Only a child spawned in this plugin lifetime is stopped.
  The previous code killed any process it had attached to, including one the
  user started by hand, which contradicted the comment above the unload hook.
- A supervisor that spawns a replacement for an adopted pid marks it owned
  again, so the next unload does stop that child.
- The README's limits now say what happens to an adopted server instead of
  leaving the unload behaviour to be discovered.

## 0.6.9

- The state summary — and with it `comfyui_status` — now says whether the panel
  has reported the editor's socket id (`clientIdKnown`). That id is what a run
  is addressed to, and when it is missing the editor shows nothing about the
  run while the image still lands on disk; the model could not tell the two
  apart from the summary before.
- `npm run typecheck` runs the TypeScript checker over every `.js` and `.mjs`
  file (`allowJs` + `checkJs`), and CI and the pre-commit hook run it next to
  `npm test`. A mocked test cannot see a call site that drops an argument; the
  checker can, and the sync that queued every run under an id no socket owned
  was exactly that.
- `npm run ui` now asserts that the socket id reached the Host: it asks
  `/api/comfyui/state` from the page for the session it opened and requires
  `clientIdKnown`, so the same break is caught at the browser level and not
  only in the type annotations.
- The sidebar entry reads `ComfyUI, shared with the model` /
  `与模型共用的 ComfyUI`: one line, no full stop, like the other sidebar tabs.
- The README and the npm description are English only. The Chinese quick start
  sat between two English sections, and npm metadata cannot carry two languages;
  the market index keeps `description.en` and `.zh` for the card.
- `test/ui/README.md` explains how to run the check on a machine that hands
  over neither the launch address nor a working browser, and `AGENTS.md` lost
  the one paragraph the tools already enforce and gained the client-bundle
  caveat a directory rename runs into.
- The docs describe the plugin that exists: the README no longer claims a
  ComfyUI WebSocket of the panel's own, the pre-commit hook is not credited with
  `npm run contract`, `AGENTS.md` marks only what `npm run ui` actually asserts,
  and `test/ui/README.md` stops promising that the panel starts a stopped
  ComfyUI by itself.

## 0.6.8

- Read execution events from the editor's own event bus instead of opening a
  ComfyUI WebSocket of the panel's own. That socket never received anything but
  `status` broadcasts — no prompt queues under its id — so the run record, the
  digest's run segment, `comfyui_progress` and the completion shown in the bar
  all stayed empty while the editor itself ran fine.
- A run that was joined after its `execution_start` — a reload, or the editor's
  socket reconnecting mid-generation — now reads as running instead of staying
  `queued` until the image is already on disk.
- An edit whose tool call timed out is no longer replayed: `comfyui_edit`
  removes it from the queue when it gives up, and a poll discards any command
  older than 60 s. A panel that reconnected later used to apply the edit with
  no tool call left to own the result.
- `increment` and `decrement` now continue from the seed the previous run used.
  The panel keeps showing its own seed, so every tool-driven run started from
  the same number and quietly reproduced the image.
- A sync that a newer one has superseded is dropped before it is posted, so two
  overlapping pushes cannot leave the Host holding the older graph under the
  higher revision until the next forced sync 30 s later.
- `npm run ui` can open the panel again: its coordinate waits returned `true`
  instead of a point, so the click went out with no position. It also asserts
  that an execution event dispatched on the editor's bus reaches the bar.

## 0.6.7

- Fix `comfyui_run` queueing with a client id no socket owned, which put a
  tool-driven run's image on disk and nowhere in the panel: the sync now
  reports the id the embedded editor connected with (its `api`, else the
  iframe's `window.name` / `sessionStorage`), so the queue entry, node
  progress, preview and history all show up in the editor again.
- Fix the panel spinning forever on `Loading the editor…` while ComfyUI is
  stopped: the stage now follows the server snapshot, so a stopped server shows
  `ComfyUI is not running` with Start and Server settings, a starting one shows
  elapsed seconds, and a frontend that never exposes `comfyAPI.app` after 45 s
  offers Reload instead of an endless spinner.
- Add `comfyui_edit` op `move_node`: repositioning a node no longer means
  removing and re-adding it, so a relayout keeps every link and widget value.
  A batch now takes up to 128 operations, so a whole rebuild fits in one call
  instead of a remove/add batch followed by a link batch.
- `comfyui_edit` answers with the graph's `nodes` and `links` counts, so a batch
  that half-applied is visible in the result instead of in the next status read.
- Add `comfyui_screenshot`: the panel serializes its editor canvas to a PNG, the
  Host writes it to the temporary directory, and the tool returns the path.
- `comfyui_graph_read layout=true` reports `overlaps` and `tight` pairs computed
  from the boxes, and `missing` nodes without a `pos`/`size`.
- Add `npm run shot -- workflow.json`: render a workflow file to a PNG in a
  headless browser, framed the way the editor frames it, with the same overlap
  verdict (exit code 2 when boxes overlap).
- `test/ui/browser.mjs`: `waitFor` no longer times out when the expression
  evaluates to an object (the answer is coerced before it crosses the DevTools
  protocol), and `findBrowser` names the paths it looked at.
- Drop the session-header `ComfyUI` shortcut. The panel stays reachable from
  the right sidebar: its guide lists every registered tab type, and the tab
  is restored once opened. The header row keeps only DSH's own controls, so
  the plugin no longer injects a button into a conversation's title bar.

## 0.6.6

- Publish as **`dsh-comfyui-panel`** (MIT). The package was `@local/dsh-comfyui`,
  a local-only name; every id that names the plugin moved with it.
- Host a plugin market index at `market/index.json` (`npm run market`) and
  document installation through Settings → Plugins → Discover.
- Add `npm run ui`: a dependency-free headless check of the panel in a real
  browser. It starts a scratch session, mounts the tab, and asserts that the
  editor boots, counters match the graph, zooming does not count as an edit, a
  widget edit bumps the revision once, and Fit frames the graph. See
  `test/ui/README.md`.
- Add `test/repo-hygiene.mjs` to `npm test`: it fails when the tree or any
  commit contains a home directory, the local account, or the hostname.
- Add a GitHub Actions workflow that runs `npm test` on Node 22 and 24.
- Document the ComfyUI integration surface in `docs/comfyui-bridge.md`: the
  `comfyAPI` shim, string ids, `extra.ds`, the camera math, command ids, and
  `server.client_id`.
- Publish counters, revision, and sync time as `data-*` attributes so the UI
  check does not parse localized bar text.
- Add `test/market-index.mjs`: validates the index with the real DSH
  validator and pins every version to a commit that exists here.
- Drop a machine-specific path from the client-ops test fixtures.

## 0.6.5

- Fit uses ComfyUI's own `Comfy.Canvas.FitView` command instead of a local
  reimplementation, so it frames the selection when there is one and matches
  the button in the editor's corner.
- The fit button is named after that action ("Zoom to fit" / "缩放以适应").

## 0.6.4

- Trim the panel bar so it does not compete with the editor: 26 px, smaller
  buttons, counters before tools.

## 0.6.3

- Show the sync clock and a toast naming what changed, instead of internal
  wiring details.
- Format the sync time without a locale guess.

## 0.6.2

- Explain the panel while it boots: a spinner with elapsed seconds, a
  "ComfyUI is not running" state with a Start button, and an explicit loading
  message instead of a white rectangle.

## 0.6.1

- Normalize LiteGraph string ids so the model-facing projection survives every
  sync.

## 0.6.0

- Queue tool-driven runs as the panel's own socket (`server.client_id`), so the
  run appears in the panel's queue, previews, and history.

## 0.5.2

- Randomize the seed a tool-driven run queues.

## 0.5.1

- Order the bar by what each click does.

## 0.5.0

- Move the server lifecycle (start/stop/restart) into the panel's top bar and
  keep configuration in the settings section.

## 0.4.3

- Stop counting zoom, pan, and panel resize as workflow edits: `extra.ds` is
  stripped before comparing revisions.
- Adopt a ComfyUI that was started outside the plugin instead of launching a
  duplicate, and hide Stop/Restart for it.

## 0.4.2

- Open the Server settings section only when the user asks; an unhealthy
  upstream no longer expands it.

## 0.4.1

- Add the pre-commit hook, the executable host smoke test, and the real-runtime
  contract test.

## 0.4.0

- Manage the ComfyUI process from the panel: start, stop, restart, remember the
  checkout directory, and start with DSH.

## 0.3.0

- Project the workflow for the model, register tools per session, persist state
  in the `dsh_comfyui` domain, and supervise the process.

## 0.2.0

- Add the Host-to-panel command channel and the graph edit tools.
- Fall back to the most recent panel when a session has none.
- Reconnect the panel event socket and resync periodically.

## 0.1.0

- First working panel: `/comfyui` HTTP + WebSocket proxy, same-origin iframe,
  workflow and event bridges, run tools, and hashed asset caching.
