# dsh-comfyui

ComfyUI inside the DeepSeek Harness Web UI: the real editor in a right-side
panel, a workflow the model can read and edit, and runs the model can start.

## What it does

- Serves the real ComfyUI frontend under the DSH origin at `/comfyui/`
  through an authenticated reverse proxy (HTTP + WebSocket).
- Adds a **ComfyUI** tab to the right sidebar. The tab is session-scoped and
  can be used full-screen; it loads `/comfyui/` in a same-origin iframe, so
  third-party nodes keep their own UI.
- Bridges the iframe editor to the Host: once `window.comfyAPI.app.app` is
  available, the panel periodically serializes the UI workflow, builds a
  semantic projection from the live nodes (ids, class types, widget names and
  values, input sources, selection), asks `app.graphToPrompt()` for the API
  prompt, and POSTs all three to `/api/comfyui/state`.
- Opens a second ComfyUI WebSocket from the panel and forwards a compact event
  stream (queue status, `execution_start`, `executing`, `progress`, `executed`,
  `execution_success` / `execution_error` / `execution_interrupted`) to
  `/api/comfyui/events`, so the Host sees runs without polling.
- Registers six model tools **on the Agent context of each session that has a
  synced workflow**. Other sessions see no ComfyUI tools:
  - `comfyui_status` — upstream reachability, panel connection, workflow
    summary, persistence backend, supervisor state, and the latest run.
  - `comfyui_graph_read` — the semantic projection: per node `id`, `type`,
    `title`, `mode`, `widgets` (`name -> value`), and `inputs`
    (`name -> "<sourceNodeId>:<slot>"`). `full=true` returns the raw UI
    workflow and API prompt.
  - `comfyui_run` — submit the synced API prompt and return the `prompt_id`;
    optionally wait for history.
  - `comfyui_progress` — panel events (current node, step progress, errors),
    the run record, and a live `/queue` snapshot.
  - `comfyui_edit` — add/remove nodes, set widget values, connect/disconnect
    inside the open panel through a Host → panel command channel.
  - `comfyui_node_info` — cached `/object_info` lookup for class types and
    input names.
- Adds one runtime-context digest line to those sessions, e.g.
  `ComfyUI: rev 14 · 9 nodes · 9 links · selected 7 · panel open.`
- Persists each session's workflow, API prompt, and projection through
  `ctx.storageDomain` (domain `dsh_comfyui`), so a Host restart does not lose
  the graph. Storage failures degrade to memory without blocking the bridge.
- Manages the ComfyUI process from the panel. The **Server** section starts,
  stops, and restarts ComfyUI, remembers the checkout directory, and can start
  it together with DSH. It adopts an already-running server instead of
  launching a duplicate. No profile configuration is required.

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
ComfyUI server. Both must agree with the panel's hard-coded `/comfyui/`.

Process management needs no configuration: open the panel's **Server** section,
point it at the ComfyUI directory (the folder with `main.py`; a common location
is detected automatically), and press **Start**. The command is derived from
that directory (`<dir>/.venv/bin/python`, else `python3`) and the arguments from
the configured upstream port, so the panel cannot run arbitrary commands. The
directory and the **Start with DSH** flag are stored in the plugin's own
`dsh_comfyui` domain, not in the DSH profile.

For advanced setups, the plugin row still accepts a `supervise` block that
takes precedence at start-up:

```yaml
        supervise:
          enabled: true
          command: /opt/ComfyUI/.venv/bin/python
          args: [main.py, --listen, 127.0.0.1, --port, '8188']
          cwd: /opt/ComfyUI
          restartDelayMs: 5000
          maxRestarts: 5
          probeIntervalMs: 20000
          startTimeoutMs: 120000
          logPath: /var/log/comfyui/comfyui.log
```

`cwd` is required when that block is enabled; a missing value fails the plugin
load instead of silently never starting ComfyUI. `command` defaults to
`python3`, `args` to `main.py --listen 127.0.0.1`. An upstream that already
answers `/system_stats` is adopted (`state: external`) rather than duplicated.
Stopping the plugin stops only a process it started.

## Requirements

- A running ComfyUI whose frontend is the standard `comfyui-frontend-package`
  build (relative `./assets/...`, `api_base` derived from the path).
- The DSH Web profile with `storage` + `storage-json` + `storage-domain`
  mounted (the default profile has them). Without them, workflows stay in
  memory.
- The panel relies on the same-origin iframe and on
  `window.comfyAPI.app.app`, a legacy compatibility shim exposed by the
  ComfyUI frontend, not a stable public API. Pin the ComfyUI frontend version
  for anything beyond this milestone.

## Try it without ComfyUI

A mock upstream is included so the proxy/iframe/bridge can be tested without
torch:

```bash
node test/mock-comfyui.mjs
```

Then open the **ComfyUI** tab in a session and wait for **Connected**. The
mock page exposes a one-node workflow. `comfyui_run` should return `p1`. Stop
the mock before starting a real ComfyUI on port 8188.

Run the checks with:

```bash
npm test          # syntax checks + host smoke test
npm run contract  # real DSH runtime, needs ../deepseek-harness
```

`npm test` covers the proxy, redirect, asset caching, the workflow and event
bridges, session-scoped tools and digest, the projection fallback, persistence
across two Host instances, the edit round-trip, the panel-managed
start/stop/restart of a real child process, and the supervisor's adoption path.
It prints `host smoke test passed`. `npm run contract` mounts the plugin next to
the real Cordis context, `ToolRuntime`, `SystemPrompt`, and
`HostConnectionService`, so an invalid Fetch path or a tool schema the registry
rejects fails locally instead of at install time. Both are run by the
pre-commit hook; see [AGENTS.md](AGENTS.md) for reload and logging steps.

## Current limits

- Edits require the ComfyUI panel to be open in the same session; the command
  channel is a long-poll and the panel applies operations inside the iframe.
- `comfyui_edit` does not validate graph semantics; a bad edit is rejected
  when ComfyUI converts the graph to a prompt.
- Sync is polling-based (about once per second while the tab is visible).
- A session that never opened the panel shows no ComfyUI tools. After a Host
  restart a persisted session gets them back; a brand-new session gets them on
  its first panel sync.
- `save`/`cancel` of a run are not exposed yet; `comfyui_run` only queues.
- The panel is an iframe, so it does not inherit DSH theme tokens; this is a
  deliberate exception for UI-workflow fidelity and third-party node UIs.
- Execution events arrive over the panel's own ComfyUI WebSocket, so progress
  and errors exist only while the panel is mounted.
- The process manager cannot distinguish a hung ComfyUI from one doing a long
  generation that stops answering `/system_stats`; health restarts should be
  tuned per workload.
- A process started outside the plugin is adopted but never stopped by it: the
  panel hides Stop/Restart for that case.

## Design notes

- **The UI workflow stays canonical.** The API prompt is derived by the real
  `graphToPrompt()`; the projection is a read-only view built from the same
  nodes, so the model never sees a second, lossy graph representation as truth.
- **State lives in the plugin.** Workflows survive restarts through a domain KV
  record (`sessionId -> { workflow, prompt, semantic, revision }`), capped at
  the 20 most recently updated sessions. The model only sees the projection and
  its own edit results.
- **Tools follow the session.** Registration happens on `agent.ctx`, so an
  agent-scoped tool list and prompt context decide visibility; unregistering
  happens through the same effect chain when the plugin unloads.
- **No core or ComfyUI changes.** The proxy, the iframe reach into
  `comfyAPI.app.app`, and the command channel are the whole integration.
