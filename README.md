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

**With the agent or the CLI.** Copy the install spec from the market card. It
has the form `git+https://github.com/Natsubrei/dsh-comfyui-panel.git#<commit>`.
An unpinned URL installs the default branch, which can be ahead of the indexed
release:

```sh
dsh plugin --profile <name> add 'git+https://github.com/Natsubrei/dsh-comfyui-panel.git#<commit>'
```

`dsh plugin` links or installs the package and appends it to the profile's
bundle list. Restart DSH if the profile was already running; clients need a hard
refresh after a bundle change.

**From npm.** The package is published. npm does not carry every indexed
release; use the market when the version matters:

```sh
dsh plugin --profile <name> add dsh-comfyui-panel
```

Then [configure](#configuration) the upstream if it is not `127.0.0.1:8188`, and
read on for the panel itself.

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
- Subscribes to the embedded editor's own event bus (`app.api`, a DOM
  `EventTarget`) and forwards a compact event stream (queue status,
  `execution_start`, `executing`, `progress`, `executed`, `execution_success` /
  `execution_error` / `execution_interrupted`) to `/api/comfyui/events`, so the
  Host sees runs without polling. ComfyUI addresses those events to the socket
  that queued the prompt, so the panel relays the editor's connection instead of
  opening one of its own.
- Registers thirteen model tools **on the Agent context of each session that has a
  synced workflow**. Other sessions see no ComfyUI tools:
  - `comfyui_status` — upstream reachability, panel connection, workflow
    summary, persistence backend, supervisor state, and the latest run. Its
    `diagnostics` array has one row per layer (`upstream`, `frontend`, `panel`,
    `commandChannel`, `storage`, `supervisor`, `workflow`) with `ok`, a
    one-sentence `detail`, and an `action` when that layer needs a next step;
    `warn: true` with `ok: true` marks a working but degraded layer, such as an
    unreported frontend version.
  - `comfyui_graph_read` — the semantic projection: per node `id`, `type`,
    `title`, `mode`, `widgets` (`name -> value`), and `inputs`
    (`name -> "<sourceNodeId>:<slot>"`). `layout=true` returns the canvas boxes
    plus an overlap verdict, `full=true` the raw UI workflow and API prompt.
  - `comfyui_run` — submit the synced API prompt and return the `prompt_id`;
    optionally wait for history. The Host keeps tracking the run after the
    call returns, with or without the panel, and the output PNG carries the UI
    workflow, so dragging it back into ComfyUI restores the graph. With
    `wait=true`, a successful run's output images (up to four) come back as
    image attachments beside the text, so they appear in the conversation;
    without an attachment service, or when the calling model route does not
    accept images, the result falls back to text and names the files.
  - `comfyui_cancel` — cancel the run this session queued, or a given prompt
    id: a prompt still waiting in the queue is removed from it, a running one
    is interrupted. The result names which happened (`action: "deleted"` or
    `"interrupted"`); a prompt that already finished is a no-op.
  - `comfyui_progress` — panel events (current node, step progress, errors),
    the run record, the live `/queue` snapshot, and `hostRun`: the Host's own
    tracking of a run started by `comfyui_run` or by the panel's Queue button,
    including the terminal status and output file names. `hostRun` keeps
    working after the panel closes, while step progress still needs the panel.
  - `comfyui_edit` — add, remove, move, and reconnect nodes and set widget
    values inside the open panel through a Host → panel command channel. One
    batch is applied in order and answers with the node and link counts it left
    behind, so a half-applied edit is visible in the result.
  - `comfyui_screenshot` — serialize the panel's editor canvas to a PNG on
    disk and return the path; open it with `read_image` to see the graph the
    user sees.
  - `comfyui_node_info` — cached `/object_info` lookup for class types and
    input names.
  - `comfyui_workflow_save` — store the synced workflow under a name; reusing a
    name replaces that slot.
  - `comfyui_workflow_list` — every workflow this session can load: the saved
    slots with node/link counts and when each was written, plus the `.json`
    files in ComfyUI's own user `workflows/` directory with their size and
    modification time. Every entry carries `source: "slot" | "comfyui"`, the
    slot this session is editing is marked current, and a ComfyUI read that
    fails leaves the slots in place with a `warning`.
  - `comfyui_workflow_load` — replace the open panel's graph with a saved slot
    or a ComfyUI user workflow file and sync it; needs the panel, like
    `comfyui_edit`. A slot wins over a ComfyUI file with the same name unless
    `source` says which one to load.
  - `comfyui_workflow_export` / `comfyui_workflow_import` — write a UI workflow
    JSON file from a saved slot (or the session's graph) and read one back into
    a slot. Paths resolve against the session workspace, and a path outside it
    is rejected.
- Adds one runtime-context digest line to those sessions, e.g.
  `ComfyUI: rev 14 · "deepseek-chan-emoji" · 9 nodes · 9 links · selected 7 ·
  panel open.` The quoted part is the workflow's name, and appears only when the
  graph has one.
- Keeps one name for one graph. Saving or loading a named workflow names the
  session, the panel bar shows it, and when `<name>.json` exists in ComfyUI's
  user data the editor's own tab is renamed too, so the panel and the embedded
  editor stop disagreeing about which workflow is open.
- Persists each session's workflow, API prompt, projection, and name through
  `ctx.storageDomain` (domain `dsh_comfyui`), so a Host restart does not lose
  the graph. Storage failures degrade to memory without blocking the bridge.
  Named workflows live in the same domain's `workflows` table.
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
`upstream`. A patch replaces the row's whole `config`, so repeat `prefix` as
well. `prefix` is fixed at `/comfyui`: the panel and the ComfyUI frontend both
derive their API base from that path, and any other value fails the plugin load.

`upstream` is the ComfyUI server. Prefer a loopback address. The proxy strips
the DSH session cookie (`dsh-auth-…`) before forwarding, and still forwards
every other cookie and `Authorization`. Point it only at a server you trust.
See [SECURITY.md](SECURITY.md).

Process management needs no configuration: open the panel's **Server** section,
point it at the ComfyUI directory (the folder with `main.py`; a common location
is detected automatically), and press **Start**. The command is derived from
that directory (`.venv/bin/python` on Unix, `.venv/Scripts/python.exe` on
Windows, otherwise `python3` or `python`) and the arguments from the configured
upstream port, so the panel cannot run arbitrary commands. The directory and
the **Start with DSH** flag are stored in the plugin's own `dsh_comfyui` domain,
not in the DSH profile.

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
Unloading the plugin stops only a process it started.

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
  against frontend 1.57.1. When ComfyUI reports a different frontend version,
  the panel shows a notice and keeps working. A server that omits the field
  is left alone.
- Adopting an already-running ComfyUI (so Stop and Restart keep working after
  a reload) needs Linux `/proc` or `lsof`. Without either, that server stays
  external. Starting one from the panel does not need either tool. Adoption is
  retried whenever the panel or `comfyui_status` sees a healthy upstream, so a
  ComfyUI that starts after the plugin is still taken over; a listener whose
  working directory is not the configured checkout stays external, with its
  pid reported and Stop/Restart unavailable.

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
npm install       # once: typescript and @types/node for the type check
npm run typecheck # checkJs over the plugin, the tests and the scripts
npm test          # checks, host smoke, editor ops, hygiene, market index
npm run contract  # real DSH runtime, needs ../deepseek-harness
npm run ui        # live panel in a headless browser, needs a running dsh web
npm run shot -- workflow.json   # render a workflow file to a PNG
```

`npm test` covers the proxy, redirect, asset caching, the workflow and event
bridges, session-scoped tools and digest, the projection fallback, persistence
across two Host instances, the edit and saved-workflow round-trips, the
panel-managed start/stop/restart of a real child process, and the supervisor's
adoption path.
It prints `host smoke test passed`. The contract also runs as part of
`npm test` when a built DeepSeek Harness checkout sits at `../deepseek-harness`
(or `DSH_ROOT`); it misses that checkout in CI, which is why CI skips it. The
contract mounts the plugin next to the real Cordis context, `ToolRuntime`, the
native tool executor, `SystemPrompt`, and `HostConnectionService`, so an invalid
Fetch path or a tool schema the registry rejects fails locally instead of at
install time. `npm test` and `npm run typecheck` are what the pre-commit hook
runs; see [AGENTS.md](AGENTS.md) for reload and logging steps. What a pull request can run without this machine is in [CONTRIBUTING.md](CONTRIBUTING.md). Host smoke binds
five consecutive ports; set `DSH_COMFYUI_TEST_PORT` to shift that block so two
checkouts can run the suite at once.

`npm run ui` is the browser check: it opens the GUI in a headless Chromium, puts
the panel in a throwaway session, and asserts the panel's observable behaviour —
the editor boots, the counters describe the graph on screen, zooming is not an
edit, a widget edit bumps the revision once, editor events reach the bar, the
Host learned the editor's socket id, and Fit frames the graph. It needs an
installed Chromium-family browser but installs nothing; see
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
  `comfyui_workflow_load` has the same requirement; `save`, `list`, `export`,
  and `import` work with the panel closed only in a session that has already
  synced or restored a workflow. Export and import resolve paths against that
  session's workspace and reject a path outside it.
- A saved workflow replaces the whole graph; there is no merge, undo, or
  per-slot revision history. Saving a name overwrites its previous content.
- ComfyUI user workflows are read from `workflows/` through `/userdata`, one
  JSON per load. A name is the file's path below `workflows/` without `.json`,
  so it is case-sensitive and a file in a subfolder keeps that folder in its
  name. Only `.json` files are listed; the plugin never writes or moves them,
  and loading one changes the panel's canvas only.
- `comfyui_edit` does not validate graph semantics; a bad edit is rejected
  when ComfyUI converts the graph to a prompt.
- Sync is polling-based (about once per second while the tab is visible).
- A session that never opened the panel shows no ComfyUI tools. After a Host
  restart a persisted session gets them back; a brand-new session gets them on
  its first panel sync.
- Output images ride the `comfyui_run` result only for `wait=true`; a
  non-waiting call still just queues the prompt and returns its `prompt_id`.
  A run returns at most four `type: 'output'` images, 20 MB each, and only
  when the attachment service and the calling model route both accept images.
  Otherwise the result stays plain text and names the output files.
- Saving a run's output is not exposed yet. `comfyui_cancel` removes a queued
  prompt or interrupts a running one, and the bar's Cancel stops a running
  prompt; `comfyui_run` only queues it.
- The panel is an iframe, so it does not inherit DSH theme tokens; this is a
  deliberate exception for UI-workflow fidelity and third-party node UIs.
- Execution events are relayed from the editor's own bus, so previews,
  per-node progress, elapsed time, and the bar's Cancel exist only while the
  panel is mounted. The Host starts its own watch for a run `comfyui_run`
  queued, and for a run the panel's Queue button started when that run's first
  execution event arrives, so `hostRun` keeps moving to its terminal status and
  output file names after the panel closes. A run that started before this
  panel attached has no `hostRun` and no step progress. The Host stops watching
  after 30 minutes and reports `lost`, which means the run's end was not
  observed, not that it failed.
- A ComfyUI the plugin only adopted stays running when the plugin unloads: it did
  not start that process, and after a reload it cannot tell its own survivor from
  a server you launched by hand. Stop it from the panel first if you want it
  gone; a child the plugin spawned is stopped on unload.
- The process manager cannot distinguish a hung ComfyUI from one doing a long
  generation that stops answering `/system_stats`; health restarts should be
  tuned per workload.
- An upstream the plugin cannot adopt — a pid it cannot name, or one running
  from a different directory — stays `external`: the plugin never stops it and
  the panel hides Stop/Restart. One it can adopt gets those buttons, but keeps
  running when the plugin unloads (previous bullet). Naming that pid needs
  Linux `/proc` or `lsof`; Windows can start a checkout from the panel, and an
  already-running server there stays external.
- The iframe is same-origin with DSH and is not sandboxed, so a custom node UI
  runs as the DSH page. See [SECURITY.md](SECURITY.md).

## Design notes

- **The UI workflow stays canonical.** The API prompt is derived by the real
  `graphToPrompt()`; the projection is a read-only view built from the same
  nodes, so the model never sees a second, lossy graph representation as truth.
- **State lives in the plugin.** Workflows survive restarts through a domain KV
  record (`sessionId -> { workflow, prompt, semantic, revision, name, nameSource }`,
  where `nameSource` says whether the name came from the editor's workflow file
  or from a tool), capped at the 20 most recently updated sessions. The model only sees the projection and
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
