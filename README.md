# dsh-comfyui-panel

[![test](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml/badge.svg)](https://github.com/Natsubrei/dsh-comfyui-panel/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

ComfyUI inside the DeepSeek Harness Web UI: the real editor as its own page. The column on the right talks to the session that owns the canvas.

## Contents

- [Install](#install)
- [Use](#use)
- [Capabilities](#capabilities)
- [Configuration](#configuration)
- [Requirements](#requirements)
- [Limits](#limits)

## Install

In DSH, open **Settings → Plugins → Discover → Add index source** and paste:

```text
https://raw.githubusercontent.com/Natsubrei/dsh-comfyui-panel/main/market/index.json
```

Install the **ComfyUI Panel** card. The index pins one commit per version, so the install matches a tested release. The `plugin_market` tool reads this same index.

From the command line:

```bash
dsh plugin --profile web add dsh-comfyui-panel
```

Restart DSH if it was already running. Hard-refresh the browser after a bundle change.

The panel uses the ComfyUI already on this machine. If there is none, install
one first — [docs.comfy.org/installation](https://docs.comfy.org/installation)
covers the official options.

Starting ComfyUI yourself is enough: the panel uses a server that answers on
`upstream`. A portable build launched from its own `.bat` listens there already.
A desktop install listens on its own port, so point `upstream` at that port
first. When the panel cannot prove it may manage the process — always the case
on Windows — the server stays `external`, and Stop is unavailable because the
panel did not start it.

To let the panel start it instead, name a checkout in **Settings**: a manual
install whose folder holds `main.py` with a `.venv` beside it (`.venv/bin/python`
on Unix, `.venv/Scripts/python.exe` on Windows), or the folder a portable Windows
build was unzipped into, where the panel uses the `ComfyUI` and `python_embeded`
inside.

## Use

1. Click **ComfyUI** in the left sidebar. The editor fills the main column. An assistant sits on the right.
2. The column on the right sends into that page's session. The model then uses the tools in the table below on the open canvas.
3. Leave the server at `http://127.0.0.1:8188`, or set another address under [Configuration](#configuration).
4. While the server is down, the canvas is a card that says so and names the folder. The bottom toolbar always shows the same three buttons — **Start**, **Stop**, and **Settings** — and the first two grey out when they do not apply. **Settings** is where the folder that contains `main.py` is chosen. If [comfy-cli](https://docs.comfy.org/comfy-cli/getting-started) has recorded a workspace, that folder is filled in; otherwise the field stays empty until you choose it. **Start with DSH** is remembered. A server that is already running is picked up, not started twice.
5. Wait until the bar says **Running**. Ask in the right column. The model uses this page's tools, including a run. A tool that needs the editor fails when you leave the page. **New** starts another session for this page; the previous one keeps its history. Collapsing the column leaves a tab on the right edge that opens it again.

No ComfyUI yet: `node test/mock-comfyui.mjs`, open **ComfyUI** in the sidebar, and wait until the bar says **Running**. The mock is a one-node graph, and `comfyui_run` returns `p1`. Stop the mock before a real ComfyUI uses port 8188.

Contributors run `npm test` and `npm run typecheck`. What those cover is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Capabilities

Tools exist only on a session that has synced a workflow. After a Host restart, a persisted session gets them back. A new session gets them on its first sync.

**Open** in the Panel column means the panel has to be open in that session. **No** means it can be closed.

### Panel

| Capability | What you get |
| --- | --- |
| Editor | The real ComfyUI frontend at `/comfyui/`, over authenticated HTTP and WebSocket. The same-origin iframe keeps third-party node UIs. It does not use DSH theme tokens. A custom node UI runs as the DSH page. See [SECURITY.md](SECURITY.md). |
| Bridge | Once `window.comfyAPI.app.app` exists, the panel syncs about once a second while the page is open. It sends the UI workflow, a read-only projection, and the API prompt from `graphToPrompt()`. The UI workflow is canonical. Editor events (`execution_start`, `executing`, `progress`, `executed`, success, error, interrupted, and queue status) are relayed on the editor's own socket. That socket is the one a run is addressed to. The panel does not open a second ComfyUI socket. |
| Digest | One line, for example `ComfyUI: rev 14 · "deepseek-chan-emoji" · 9 nodes · 9 links · selected 7 · panel open.` The name appears only when the graph has one. More than one open tab adds the count and the active tab. Zoom, pan, and resize do not advance `rev`. |
| Name | Saving or loading a named workflow names the session, and the digest line includes that name. When `<name>.json` exists in ComfyUI's user data, the editor tab is renamed to match. |
| Storage | Domain `dsh_comfyui`. A Host restart keeps the graph. The record is `sessionId -> { workflow, prompt, semantic, revision, name, nameSource }` for the 20 most recently updated sessions. `nameSource` is `file` or `tool`. The model sees the projection and its own edit results. A storage failure stays in memory and does not block the bridge. Named workflows live in the `workflows` table. |
| Process | **Start** and **Stop** run ComfyUI. The command comes from the checkout (`.venv/bin/python` on Unix, `.venv/Scripts/python.exe` on Windows, `python_embeded/python.exe` beside a portable bundle, otherwise `python3` or `python`) and the upstream port. It is not an arbitrary command. The directory and **Start with DSH** are stored in `dsh_comfyui`, not in the DSH profile. |

### Model tools

| Tool | Does | Panel |
| --- | --- | --- |
| `comfyui_status` | Upstream, panel, workflow summary, storage, supervisor, and the latest run. `diagnostics` has one row per layer (`upstream`, `frontend`, `panel`, `commandChannel`, `storage`, `supervisor`, `workflow`) with `ok`, a one-sentence `detail`, and an `action` when a next step exists. `warn: true` with `ok: true` means working but degraded, such as an unreported frontend version. | No |
| `comfyui_graph_read` | Per node: `id`, `type`, `title`, `mode`, `widgets` (`name -> value`), and `inputs` (`name -> "<sourceNodeId>:<slot>"`). `layout=true` adds canvas boxes and an overlap verdict. `full=true` adds the raw UI workflow and API prompt. | No |
| `comfyui_run` | Submits the synced API prompt and returns `prompt_id`. The Host keeps tracking the run after the call returns, with or without the panel. The output PNG carries the UI workflow, so dragging it back into ComfyUI restores the graph. `wait=true` returns up to four `type: 'output'` images, 20 MB each. Without an attachment service, or when the model route does not accept images, the result names the files instead. | No |
| `comfyui_cancel` | Removes a queued prompt (`action: "deleted"`) or interrupts a running one (`action: "interrupted"`). A prompt that already finished is a no-op. Copying output files to a chosen path is not a tool yet. | No |
| `comfyui_progress` | Panel events (current node, step progress, errors), the run record, the live `/queue`, and `hostRun` (terminal status and output file names). `hostRun` continues after the panel closes. Step progress does not. | No |
| `comfyui_edit` | Adds, removes, moves, and reconnects nodes, and sets widget values, in one ordered batch. The result includes the node and link counts left behind, so a half-applied edit is visible. It does not validate graph semantics. ComfyUI rejects a bad edit when it converts the graph to a prompt. | Open |
| `comfyui_screenshot` | Writes the editor canvas to a PNG and returns the path. Open it with `read_image`. | Open |
| `comfyui_node_info` | Cached `/object_info` lookup for class types and input names. | No |
| `comfyui_workflow_save` | Stores the synced workflow under a name. The same name replaces that slot. There is no merge, undo, or per-slot history. | No |
| `comfyui_workflow_list` | Saved slots (node and link counts, write time) plus `.json` files in ComfyUI's user `workflows/` directory (size, modification time). `source` is `slot` or `comfyui`. The slot this session is editing is marked current. A failed ComfyUI read leaves the slots and sets `warning`. | No |
| `comfyui_workflow_load` | Replaces the open graph with a saved slot or a ComfyUI user workflow, then syncs. A slot wins over a ComfyUI file of the same name unless `source` says which. | Open |
| `comfyui_workflow_export` | Writes a UI workflow JSON from a saved slot or the session graph. The path stays inside the session workspace. | No |
| `comfyui_workflow_import` | Reads a UI workflow JSON into a slot. The path stays inside the session workspace. | No |
| `comfyui_workflow_switch` | Switches to another open tab by `name`, or by `path` when two tabs share a label, and keeps that tab's unsaved edits. | Open |
| `comfyui_workflow_close` | Closes one open tab. It requires `confirm: true` and expects the user to have asked. An unsaved file tab opens ComfyUI's own save dialog. A temporary tab with unsaved changes is refused. | Open |

`comfyui_workflow_save`, `comfyui_workflow_list`, `comfyui_workflow_export`, and `comfyui_workflow_import` work with the panel closed only after this session has already synced or restored a workflow.

## Configuration

Default upstream is `http://127.0.0.1:8188`. Prefer a loopback address. To change it, override this plugin's row in the profile `cordis.patch.yml` by the same `id`. A patch replaces the whole `config`, so repeat `prefix`. `prefix` is fixed at `/comfyui`. Any other value fails the plugin load.

```yaml
- insert:
    - id: dsh-comfyui-panel
      name: dsh-comfyui-panel
      config:
        upstream: http://127.0.0.1:8188
        prefix: /comfyui
```

The proxy strips the DSH session cookie (`dsh-auth-…`) and still forwards every other cookie and `Authorization`. Point `upstream` only at a server you trust. See [SECURITY.md](SECURITY.md).

Starting ComfyUI from the panel needs no profile configuration. A `supervise` block on the plugin row overrides that setup at startup. Its fields, the required `cwd`, and the defaults are in [docs/supervise.md](docs/supervise.md).

## Requirements

- A ComfyUI whose frontend is the standard `comfyui-frontend-package` build (relative `./assets/...`, `api_base` derived from the path). The panel was last verified against frontend 1.57.1. Another reported version shows a notice and still loads. A server that omits the version is left alone.
- The panel uses `window.comfyAPI.app.app`, a legacy shim, not a stable API. What it actually touches, and how to re-check it after an upgrade, is in [docs/comfyui-bridge.md](docs/comfyui-bridge.md).
- The DSH Web profile has `storage`, `storage-json`, and `storage-domain` mounted. The default profile does. Without them, workflows stay in memory.
- Adopting an already-running ComfyUI, so Stop still works after a reload, needs Linux `/proc` or `lsof`. Without either, that server stays external. Starting one from the panel needs neither. Adoption is retried when the panel or `comfyui_status` sees a healthy upstream. A listener whose working directory is not the configured checkout stays external, with its pid reported and Stop unavailable. Windows can start a checkout or a portable build from the panel. An already-running server there stays external.

## Limits

- ComfyUI user workflows are read from `workflows/` through `/userdata`, one JSON file per load. A name is the path below `workflows/` without `.json`, so it is case-sensitive and a subfolder stays in the name. Only `.json` files are listed. The plugin never writes or moves those files. Loading one changes the panel canvas only.
- Previews, per-node progress, elapsed time, and the bar's Cancel exist only while the panel is mounted. A run the Queue button started gets a `hostRun` watch from its first execution event. A run that started before this panel attached has no `hostRun` and no step progress. The Host stops watching after 30 minutes and reports `lost`, which means the end was not observed, not that the run failed.
- A ComfyUI the plugin only adopted keeps running when the plugin unloads. The plugin did not start that process, and after a reload it cannot tell that process from one you started by hand. Stop it from the panel first if you want it gone. A child the plugin spawned is stopped on unload.
- The process manager cannot tell a hung ComfyUI from a long generation that stops answering `/system_stats`. Tune health restarts per workload.

## License

[MIT](LICENSE).
