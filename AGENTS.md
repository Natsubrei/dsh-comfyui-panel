# dsh-comfyui

A zero-intrusion ComfyUI panel for the DSH Web UI. The ComfyUI **UI workflow is
canonical**; plugin state lives in the Host's `dsh_comfyui` storage domain, never
in the profile config. Do not edit DSH core or ComfyUI sources to make this work.

## Where things are

- `index.js` — Host half: authenticated `/comfyui` HTTP + WebSocket proxy, the
  `/api/comfyui/{state,events,commands/poll,commands/result,service}` bridges,
  per-session tools, and the runtime-context digest.
- `client.js` — the panel module (iframe, projection, Server controls). Plain JS
  served as-is; it is not built by tsdown and cannot `import` sibling files at
  runtime.
- `projection.js` — semantic projection and digest line used by the Host.
- `storage.js` — the `dsh_comfyui` domain spec (`sessions`, `settings`). Adding
  a table is compatible; changing a record field needs a version bump and a
  migration (the domain layer has no migrations).
- `service.js` / `supervisor.js` — panel-managed ComfyUI process control.
- `test/host-smoke.mjs` — self-contained executable contract for every route
  and tool.
- `test/dsh-contract.mjs` — the same routes and tools against the **real**
  Cordis/`ToolRuntime`/`SystemPrompt`/`HostConnectionService`, which catches
  invalid Fetch paths and schema/scope mistakes the mocks cannot.

## Verify

```bash
npm test          # syntax checks + host smoke + client editor ops
npm run contract  # real DSH runtime; needs checkout at ../deepseek-harness
```

A new route or tool needs a case in `host-smoke.mjs`; a new integration point
(path, service, scope, tool schema) additionally needs a case in
`dsh-contract.mjs`. The pre-commit hook runs `npm test`; it is enabled with
`git config core.hooksPath .githooks` (already set in this checkout).

## Reload the live plugin

Host code reloads without restarting DSH: toggle the bundle off and on. HMR
reconciles the profile and re-imports the changed module.

```text
plugin_manager set_bundle @local/dsh-comfyui enabled:false
plugin_manager set_bundle @local/dsh-comfyui enabled:true
```

Then check `plugin_manager list_plugins` for `enabled` and the version. Client
changes still need a full page refresh (hard reload); `pnpm run dev:web` does
not rebuild profile bundles by default. `package.json` is the source of truth
for the version.

## Panel check (manual, after client changes)

1. Hard-refresh the GUI, open the **ComfyUI** tab, wait for **Connected**.
2. The header digest should read `ComfyUI: rev … · N nodes · … · panel open.`
3. The bar reads left to right: status label (`Running` / `Stopped` /
   `External` / `Starting…`), the lifecycle buttons that fit it (Start when
   stopped, Stop + Restart when running and owned), the counters, then the
   panel tools (`Sync`, `Reload`, open, gear). The gear opens settings only,
   and settings hold configuration, not lifecycle buttons.
4. Zoom, pan, and resize the panel; `rev` must not change. Edit a widget; it
   must go up by exactly one.
5. Queue one run; `comfyui_progress` should go `queued` → `running` → success.
6. If the tab says "panel is not connected", the Host↔panel WebSocket did not
   re-admit. Reload the page before investigating plugin code.

There is no browser tool in this profile, so ask the user to confirm the panel
or supply a screenshot when a change is UI-only. When a browser tool is
available, screenshot and click through the checklist instead.

## Logs

- ComfyUI child: `~/.dsh/comfyui/comfyui.log` (panel-managed start).
- Plugin diagnostics: `~/.dsh/profiles/<profile>/.plugin-manager/logs/`.
- Host stdout: run `scripts/dsh-web.sh` instead of `dsh web` to tee it to
  `~/.dsh/dsh.log`.

## Gotchas

- ComfyUI sends execution events only to the client that queued the prompt
  (`server.client_id`). The panel reports the iframe's socket id with every
  state sync and `comfyui_run` queues as that id; drop it and runs happen with
  no queue entry, no node progress, no preview, and nothing in the history —
  the image exists on disk and nowhere in the UI.
- The embedded frontend keeps live LiteGraph node ids and link origin ids as
  strings (`'9'`), while serialized workflows write numbers. `projectGraph`
  normalizes them with `Number()`; without that the Host rejects every node
  and the model silently falls back to positional widget values.
- `/tmp` can be a small tmpfs (a few GB) on some machines. Multi-GB model
  downloads belong in the workspace (`.dl_parts/`) or `~/workspace/.tmp`; check
  `df` first.
- Read a file with the `read` tool immediately before editing it. Shell reads
  (`sed`, `cat`) and Python rewrites do not populate the edit cache, which
  produces "file has not been read" and "file changed since it was read".
- Commit with a quoted heredoc (`git commit -F - <<'MSG'`) so backticks in the
  message are not executed by the shell.
