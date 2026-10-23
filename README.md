# dsh-comfyui-panel

[![test](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml/badge.svg)](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

ComfyUI inside the DeepSeek Harness Web UI: the real editor in a right-side
panel, a workflow the model can read and edit, and runs the model can start.

## Install

**From the plugin market** (recommended). In DSH, open **Settings → Plugins →
Discover → Add index source** and paste:

```text
https://raw.githubusercontent.com/Natsubrei/dsh-comfyui-panel/main/market/index.json
```

The **ComfyUI Panel** card installs the bundle; the index pins one exact commit
per version, so an install always matches a tested release. The same index is
what the `plugin_market` tool reads, so an agent can list it, show versions, and
install without a browser.

**With the agent or the CLI.** The market hands `install_bundle` an install spec
of the form `git+https://github.com/Natsubrei/dsh-comfyui-panel.git#<commit>`;
that is also the spec to paste yourself:

```sh
dsh plugin --profile <name> add 'git+https://github.com/Natsubrei/dsh-comfyui-panel.git'
```

`dsh plugin` links or installs the package and appends it to the profile's
bundle list. Restart DSH if the profile was already running; clients need a hard
refresh after a bundle change.

**From npm** once the package is published:

```sh
dsh plugin --profile <name> add dsh-comfyui-panel
```

Then [configure](#configuration) the upstream if it is not `127.0.0.1:8188`, and
read on for the panel itself.

## 中文快速开始

在 DSH 里打开**设置 → 插件 → 发现 → 添加索引源**，粘贴：

```text
https://raw.githubusercontent.com/Natsubrei/dsh-comfyui-panel/main/market/index.json
```

安装 **ComfyUI 面板** 后，在会话右侧边栏的引导页点 **ComfyUI**，编辑器就会在同一
个页面里启动。面板顶部一行是服务器状态（运行/停止）和启停按钮，中间是节点/连线
计数与最近同步时间，右边是缩放适应、同步、重载、新标签打开和服务器设置。

插件会把当前工作流投影给模型：模型能读节点和连线、改控件值、增删节点、发起
生成，并通过 `comfyui_progress` 看到进度。ComfyUI 进程可以在面板里启动、停止和
重启，工作流保存在插件自己的存储域里，重启 DSH 不会丢。

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
- Registers seven model tools **on the Agent context of each session that has a
  synced workflow**. Other sessions see no ComfyUI tools:
  - `comfyui_status` — upstream reachability, panel connection, workflow
    summary, persistence backend, supervisor state, and the latest run.
  - `comfyui_graph_read` — the semantic projection: per node `id`, `type`,
    `title`, `mode`, `widgets` (`name -> value`), and `inputs`
    (`name -> "<sourceNodeId>:<slot>"`). `layout=true` returns the canvas boxes
    plus an overlap verdict, `full=true` the raw UI workflow and API prompt.
  - `comfyui_run` — submit the synced API prompt and return the `prompt_id`;
    optionally wait for history.
  - `comfyui_progress` — panel events (current node, step progress, errors),
    the run record, and a live `/queue` snapshot.
  - `comfyui_edit` — add, remove, move, and reconnect nodes and set widget
    values inside the open panel through a Host → panel command channel. One
    batch is applied in order and answers with the node and link counts it left
    behind, so a half-applied edit is visible in the result.
  - `comfyui_screenshot` — serialize the panel's editor canvas to a PNG on
    disk and return the path; open it with `read_image` to see the graph the
    user sees.
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

The bundle's own patch, `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-comfyui-panel
      name: dsh-comfyui-panel
      config:
        upstream: http://127.0.0.1:8188
        prefix: /comfyui
```

Override the row in your profile's `cordis.patch.yml` by the same `id` to change
`upstream` or `prefix`; a patch replaces the row's whole `config`, so repeat
every key you keep.

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
  for anything beyond this milestone. What the plugin actually uses — and how
  to re-derive it after an upgrade — is in
  [docs/comfyui-bridge.md](docs/comfyui-bridge.md); the panel was last verified
  against frontend 1.57.1.

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
npm test          # checks, host smoke, editor ops, repository hygiene
npm run contract  # real DSH runtime, needs ../deepseek-harness
npm run ui        # live panel in a headless browser, needs a running dsh web
npm run shot -- workflow.json   # render a workflow file to a PNG
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

`npm run ui` is the browser check: it opens the GUI in a headless Chromium, puts
the panel in a throwaway session, and asserts that the editor boots, the
counters match the graph, zooming is not counted as an edit, a widget edit bumps
the revision once, and Fit frames the graph. It needs an installed
Chromium-family browser but installs nothing; see
[test/ui/README.md](test/ui/README.md). `npm test` also scans the tree and the
whole history for machine-specific paths, so a stray home directory fails
before it ships.

`npm run shot -- workflow.json` renders a workflow file to a PNG without a DSH
session: it loads the graph into a real ComfyUI frontend, frames it the way the
editor does, writes the image, and prints the boxes that overlap or sit closer
than 16 pixels (exit code 2 when any do). Use it to judge a layout file, or
`comfyui_screenshot` for the graph already open in a panel.

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
- **`revision` tracks edits, not the viewport.** The frontend serializes
  `extra.ds` (zoom/pan) into every workflow, so the Host strips it before
  comparing and storing: scrolling, zooming, or resizing the panel does not
  change `rev`, while real edits still advance it.
- **Tools follow the session.** Registration happens on `agent.ctx`, so an
  agent-scoped tool list and prompt context decide visibility; unregistering
  happens through the same effect chain when the plugin unloads.
- **No core or ComfyUI changes.** The proxy, the iframe reach into
  `comfyAPI.app.app`, and the command channel are the whole integration.
