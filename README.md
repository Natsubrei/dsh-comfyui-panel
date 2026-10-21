# dsh-comfyui

P0 of a zero-install ComfyUI integration for the DeepSeek Harness Web UI.

## What this P0 does

- Serves the real ComfyUI frontend under the DSH origin at `/comfyui/`
  through an authenticated reverse proxy (HTTP + WebSocket).
- Adds a **ComfyUI** tab to the right sidebar. The tab is session-scoped and
  can be used full-screen; it loads `/comfyui/` in a same-origin iframe.
- Bridges the iframe editor to the Host: once `window.comfyAPI.app.app` is
  available, the panel periodically serializes the UI workflow, asks
  `app.graphToPrompt()` for the API prompt, and POSTs both to
  `/api/comfyui/state`.
- Opens a second ComfyUI WebSocket from the panel and forwards a compact event
  stream (queue status, `execution_start`, `executing`, `progress`, `executed`,
  `execution_success` / `execution_error` / `execution_interrupted`) to
  `/api/comfyui/events`, so the Host sees runs without polling.
- Registers six model tools:
  - `comfyui_status` — upstream reachability, the last synced workflow, and the
    latest run state.
  - `comfyui_graph_read` — read the last synced UI workflow (summary or full).
  - `comfyui_run` — submit the last synced API prompt to ComfyUI and return
    the `prompt_id`; optionally wait for history.
  - `comfyui_progress` — the latest panel events (current node, step progress,
    errors), the run record, and a live `/queue` snapshot.
- Adds a Host → panel command channel. `comfyui_edit` queues an edit for the
  session; the panel long-polls `/api/comfyui/commands/poll`, applies the edit
  inside the iframe (add/remove node, set widget, connect/disconnect), re-syncs
  the workflow, and posts the outcome to `/api/comfyui/commands/result`.
  `comfyui_node_info` reads a cached `/object_info` so the model can look up
  class types and input names before editing.

## Configuration

`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-comfyui
      name: '@local/dsh-comfyui'
      config:
        upstream: http://127.0.0.1:8188
        prefix: /comfyui
```

`prefix` is the same-origin path the panel is served from; `upstream` is the
ComfyUI server. Both must agree with the panel's hard-coded `/comfyui/` for
P0.

## Requirements

- A running ComfyUI whose frontend is the standard `comfyui-frontend-package`
  build (relative `./assets/...`, `api_base` derived from the path).
- The DSH Web profile. The panel relies on the same-origin iframe and on
  `window.comfyAPI.app.app`, which is a legacy compatibility shim exposed by
  the ComfyUI frontend, not a stable public API. Pin the ComfyUI frontend
  version for anything beyond P0.

## Try it without ComfyUI

A mock upstream is included so the proxy/iframe/bridge can be tested without
torch:

```bash
node test/mock-comfyui.mjs
```

Then open the **ComfyUI** action in a session header (or the right-sidebar
guide), and the panel should show **Connected**, `1 nodes · 0 links`, and the
mock page. `comfyui_run` should return `p1`. Stop the mock before starting a
real ComfyUI on port 8188.

Run the host smoke test with:

```bash
node test/host-smoke.mjs
```

## Current limits

- Edits require the ComfyUI panel to be open in the same session; the command
  channel is a long-poll and the panel applies operations inside the iframe.
- `comfyui_edit` does not validate the graph semantics; a bad edit is rejected
  by ComfyUI when it converts the graph to a prompt.
- Sync is polling-based (about once per second while the tab is open).
- Verified against a live ComfyUI 0.42.0 (CUDA) with
  Qwen-Image 2.1 Turbo int8: the panel loads the real frontend through the
  proxy, `graphToPrompt()` reaches `/api/comfyui/state`, and Run queues a
  prompt. ComfyUI's `origin_only_middleware` rejects a POST whose `Origin`
  netloc differs from `Host`, so the proxy strips `Origin`/`Referer` for both
  HTTP and WebSocket upstream requests.
- Host state is in memory only; a DSH restart clears it. Persistence comes in
  the next milestone.
- The panel is an iframe, so it does not inherit DSH theme tokens; this is a
  deliberate exception for UI-workflow fidelity and all third-party node UIs.
- Execution events are pushed over the panel's own ComfyUI WebSocket, so
  progress and errors are near real-time, but they only exist while the panel
  is mounted.

## Next

1. Derive a semantic projection of the UI workflow for the model (ids, types,
   widget values, links) instead of raw JSON, and expose it through
   `comfyui_graph_read`.
2. Scope tools per session and add a one-line `systemPrompt.context` digest.
3. Persist workflows with `storageDomain`.
4. Keep the ComfyUI process alive (or start it from the panel) so reopening the
   tab does not wait for a cold boot.
