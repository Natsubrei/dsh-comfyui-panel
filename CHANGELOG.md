# Changelog

Notable changes to the plugin. The version in `package.json` is the source of
truth, and every release is pinned by a commit in `market/index.json`.

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
