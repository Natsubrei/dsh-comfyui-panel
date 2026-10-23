# dsh-comfyui-panel

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
- `docs/comfyui-bridge.md` — the frontend surface the panel depends on
  (`comfyAPI`, string ids, `extra.ds`, the camera, command ids,
  `server.client_id`) and how to re-derive it after a ComfyUI upgrade.
- `test/host-smoke.mjs` — self-contained executable contract for every route
  and tool.
- `test/dsh-contract.mjs` — the same routes and tools against the **real**
  Cordis/`ToolRuntime`/`SystemPrompt`/`HostConnectionService`, which catches
  invalid Fetch paths and schema/scope mistakes the mocks cannot.
- `test/ui/` — `npm run ui`: a headless browser check of the live panel, one
  dependency-free DevTools-protocol driver plus the DSH/ComfyUI-specific
  checklist. See `test/ui/README.md`.
- `scripts/graph-shot.mjs` — `npm run shot -- workflow.json`: render a workflow
  file to a PNG in a headless browser and report overlapping boxes. The way to
  see a layout without a panel, and the correct Fit framing lives there.
- Live workflow record — the panel is canonical; the Host mirrors the graph to
  the `dsh_comfyui` storage domain (`tables.sessions.<sessionId>.workflow`, with
  the API `prompt` beside it). Read it when you need the raw UI JSON while the
  panel is closed.
- `test/repo-hygiene.mjs` — fails when this machine's paths, account, or
  hostname appear in the tree or in any commit.
- `.github/workflows/test.yml` — CI: `npm ci`, `npm run typecheck`, then
  `npm test` on Node 22 and 24.
- `tsconfig.json` + `types/globals.d.ts` — `checkJs` over every `.js` and
  `.mjs`. The dev dependencies exist only for this pass.
- `market/index.json` — the plugin market index this repository hosts, the URL
  users add in Settings → Plugins → Discover. `scripts/market-index.mjs`
  regenerates it; `test/market-index.mjs` validates it with the real
  `@deepseek-ai/dsh-plugin-market-index` validator when a Harness checkout is
  next to this one.

## Verify

```bash
npm install       # once: typescript and @types/node for the type check
npm run typecheck # checkJs over index.js, client.js, the tests and the scripts
npm test          # checks, host smoke, editor ops, hygiene, market index
npm run contract  # real DSH runtime; needs checkout at ../deepseek-harness
npm run ui        # live panel in a headless browser; needs a running dsh web
npm run shot -- workflow.json   # render a workflow file to a PNG
```

A layout change is verified by looking, not by arithmetic: `comfyui_screenshot`
for the panel's own canvas, `npm run shot` for a workflow file. Both print or
return a path to open with `read_image`; `comfyui_graph_read layout=true` adds
the overlapping pairs when only the numbers are in question.

A new route or tool needs a case in `host-smoke.mjs`; a new integration point
(path, service, scope, tool schema) additionally needs a case in
`dsh-contract.mjs`. The pre-commit hook runs `npm test`, plus `npm run
typecheck` when `node_modules` exists; it is enabled with `git config
core.hooksPath .githooks` (already set in this checkout, and not inherited by a
fresh clone). `npm run contract` needs the sibling checkout, so CI runs only
`npm test` and the type check.

The type check is only as good as the annotations it reads. A function with no
`@param` types has `any` parameters, so a call with the wrong number of
arguments still passes — that is exactly how a sync once shipped calling
`frontendClientId()` with no arguments and queued every run under an id no
socket owned. Give a function whose signature carries meaning `@param` and
`@returns` tags, and the call sites get checked.

## Reload the live plugin

Host code reloads without restarting DSH: toggle the bundle off and on. HMR
reconciles the profile and re-imports the changed module.

```text
plugin_manager set_bundle dsh-comfyui-panel enabled:false
plugin_manager set_bundle dsh-comfyui-panel enabled:true
```

Then check `plugin_manager list_plugins` for `enabled` and the version. Client
changes still need a full page refresh (hard reload); `pnpm run dev:web` does
not rebuild profile bundles by default. `package.json` is the source of truth
for the version.

The toggle also reconciles the client-module graph, which keys each package by
the path the loader resolved when the plugin started. Move or rename the
checkout and the client half drops out of the boot manifest: the Host tools keep
working while the sidebar entry is gone. Toggle once more and reload; there is
no full rescan, so a Host restart is the fallback.

## Panel check (after client changes)

`npm run ui` automates what a headless browser can see: the panel mounts, the
editor boots, counters match the graph on screen, zooming is not an edit, a
widget edit bumps the revision once, editor events reach the bar, the Host
learned the socket id, and Fit frames the graph. It needs a running `dsh web`
and an installed Chromium (`test/ui/README.md` has the address, cookie and
library it wants), and it opens a **new draft session**, so it never touches the
conversation you are working in. What it cannot see — the digest line, the bar's
labels and buttons, the stopped stage — is the manual pass below.

1. Hard-refresh the GUI, open the **ComfyUI** tab, wait for **Connected**.
2. The header digest should read `ComfyUI: rev … · N nodes · … · panel open.`
3. The bar reads left to right: status label (`Running` / `Stopped` /
   `External` / `Starting…`), the lifecycle buttons that fit it (Start when
   stopped, Stop + Restart when running and owned), the counters with the
   last sync time, then the panel tools (fit, `Sync`, `Reload`, open, gear).
   The gear opens settings only; settings hold configuration, not lifecycle
   buttons.
4. On first open the graph is framed in the canvas and the counter shows
   `synced HH:MM`. The stage has three faces and never spins forever: a stopped
   server shows `ComfyUI is not running` with Start (plus Server settings), a
   starting one shows `Starting ComfyUI… Ns`, and a frontend that never hands
   over `comfyAPI.app` within 45 s shows `The editor did not load` with Reload.
   (The stopped state needs a manual run: stop the server from the bar and look.)
5. Zoom, pan, and resize the panel; `rev` must not change. Edit a widget in
   the editor or let the model do it; the revision goes up by exactly one and a
   short toast names what changed.
6. Queue one run; `comfyui_progress` should go `queued` → `running` → success.
   This one needs the model: the check does not queue runs.
7. If the chip reads `Running · Bridge error`, the state POST is failing: check
   the Host log and `fetch('/api/comfyui/state?sessionId=…')` from the page
   before touching panel code.

When no browser can run (no `dsh web`, no Chromium), ask the user for a
confirmation or a screenshot instead of guessing; say which of the steps above
you could not run.

## Publishing

This repository is meant to be published; `npm test` scans both the working tree
and every commit for home directories, the local account name, and the hostname
(`test/repo-hygiene.mjs`). A hit in history means a history rewrite, not a new
commit: fix the file, then rewrite the affected commits before publishing, and
re-run `npm test` until the hygiene test is quiet.

A release is a commit plus an index entry that pins it:

1. Bump `package.json` and add the CHANGELOG section.
2. Commit, then tag: `git tag v<version> && git push origin main --tags`.
   This commit cannot pass the pre-commit hook: the index still pins the
   previous release and `npm test` says so. Commit it with `--no-verify`; step 4
   turns the suite green again before anything is pushed.
3. `npm run market` — writes `market/index.json` with `version` pinned to that
   commit and its commit time as `publishTimestamp`, keeping older versions.
4. `npm test` (validates the index against the real validator), then commit
   `market/index.json` and push.

Do not edit `market/index.json` by hand: the commit SHA, the timestamp, and
`engines.dsh` must agree with the commit and the package, and the test says so.
Publishing to npm is optional and separate (`npm publish`); npm-based community
indexes discover packages through the `keywords: ["dsh-plugin"]` keyword and the
`dsh.bundle` field, so a publish there needs no index change here.

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
- The panel is stateful across browsers: opening the tab in a second browser
  profile means that editor's (possibly empty) workflow is what the session
  syncs. Run the UI check in a draft session, not in a conversation whose
  graph you care about, and expect a briefly stale `rev` if the owner's panel
  pushes afterwards.
- `/tmp` can be a small tmpfs (a few GB) on some machines. Multi-GB model
  downloads belong in the workspace (`.dl_parts/`) or `~/workspace/.tmp`; check
  `df` first.
- Commit with a quoted heredoc (`git commit -F - <<'MSG'`) so backticks in the
  message are not executed by the shell.
