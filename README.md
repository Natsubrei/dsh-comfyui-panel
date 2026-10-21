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
- Registers four model tools:
  - `comfyui_status` — upstream reachability, the last synced workflow, and the
    latest run state.
  - `comfyui_graph_read` — read the last synced UI workflow (summary or full).
  - `comfyui_run` — submit the last synced API prompt to ComfyUI and return
    the `prompt_id`; optionally wait for history.
  - `comfyui_progress` — the latest panel events (current node, step progress,
    errors), the run record, and a live `/queue` snapshot.

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

## Current limits (P0)

- Model graph **edits** are not implemented yet; the model can read the last
  synced graph and run it.
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
- Graph sync is still polling-based (~1.2 s). Execution events are pushed over
  the panel's own ComfyUI WebSocket, so progress and errors are near real-time,
  but they only exist while the panel is mounted.
- There is no Host → panel command channel yet; the model can observe a run but
  cannot edit the graph.

## Next

1. Add a Host → panel command channel (SSE or long-poll) and use it to apply
   edits: add/remove node, set widget value, connect/disconnect.
2. Derive a semantic projection of the UI workflow for the model (ids, types,
   widget values, links) instead of raw JSON.
3. Scope tools per session and add a one-line `systemPrompt.context` digest.
4. Persist workflows with `storageDomain`.
