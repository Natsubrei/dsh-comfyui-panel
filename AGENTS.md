# dsh-comfyui-panel

This file is for an agent maintaining this repository. A human contributor starts at [CONTRIBUTING.md](CONTRIBUTING.md).

A zero-intrusion ComfyUI panel for the DSH Web UI. The ComfyUI **UI workflow is
canonical**; plugin state lives in the Host's `dsh_comfyui` storage domain, never
in the profile config. Do not edit DSH core or ComfyUI sources to make this work.

## Where things are

- `index.js` — Host half: authenticated `/comfyui` HTTP + WebSocket proxy, the
  `/api/comfyui/{state,events,commands/poll,commands/result,service,desk,desk/transcript,desk/chat}` bridges,
  per-session tools, and the runtime-context digest. Session facts and the
  command channel live in the two modules below; this file wires them to routes
  and tools.
- `session-store.js` — one session's mirrored workflow, run record, seed walk,
  tool registration and debounced write behind `createSessionStore()`;
  `release()` is the one place a session's memory ends.
- `commands.js` — the tool ↔ panel command channel: per-session queue, parked
  long-polls, pending answers and the 60 s command expiry behind
  `createCommandChannel()`.
- `client.js` — the panel module (iframe, projection, the bottom toolbar). Plain JS
  served as-is; it is not built by tsdown and cannot `import` sibling files at
  runtime.
- `projection.js` — semantic projection and digest line used by the Host.
- `storage.js` — the `dsh_comfyui` domain spec (`sessions`, `workflows`,
  `settings`, `desk`). Adding a table is compatible, and so is an optional field that a
  reader can treat as absent (`sessions.name` is one); changing or dropping an
  existing field needs a version bump and a migration (the domain layer has no
  migrations).
- `service.js` / `supervisor.js` — panel-managed ComfyUI process control.
- `dev/` — maintainer documents: `comfyui-bridge.md` (the frontend surface the
  panel depends on — `comfyAPI`, string ids, `extra.ds`, the camera, command
  ids, `server.client_id` — and how to re-derive it after an upgrade),
  `panel-check.md` (the client check loop), and `release.md` (cutting a
  release). `docs/` holds only what a user reads.
- `docs/supervise.md` — the profile `supervise` block, which overrides the
  panel's Start and Stop at startup. Read it when changing the boot command,
  `cwd`, restart limits, or adoption from `cordis.patch.yml`.
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
  the API `prompt` and the workflow `name` beside it). Read it when you need the
  raw UI JSON while the panel is closed.
- `test/repo-hygiene.mjs` — fails when a home-directory path is in the tree or
  any commit. The default run also rejects this machine's account in an address
  (`name@`). Bare account names and hostnames fail only when
  `DSH_HYGIENE_STRICT=1`.
- `.github/workflows/test.yml` — CI: `npm ci`, `npm run typecheck`, then
  `npm test` on Node 22 and 24. `.github/workflows/release.yml` cuts a release
  from the Actions tab; see [dev/release.md](dev/release.md).
- `tsconfig.json` + `types/globals.d.ts` — `checkJs` over every `.js` and
  `.mjs`. The dev dependencies exist only for this pass.
- `locale/*.json` — the display metadata per language: `meta.title`,
  `meta.description`, and `meta.detail`, the Markdown file the plugin detail
  page shows in that language. `README.md` is Simplified Chinese and the
  package's front page, `README_en.md` the English one.
- `market/index.json` — the plugin market index this repository hosts, the URL
  users add in Settings → Plugins → Discover. `scripts/market-index.mjs`
  regenerates it; `test/market-index.mjs` validates it with the real
  `@deepseek-ai/dsh-plugin-market-index` validator when a Harness checkout is
  next to this one.

## Verify

```bash
npm install       # once: typescript and @types/node for the type check
npm run typecheck # checkJs over index.js, client.js, the tests and the scripts
npm test          # syntax, then unit, module, system, release; see test/README.md
npm run contract  # real DSH runtime; needs checkout at ../deepseek-harness
npm run ui        # live panel in a headless browser; needs a running dsh web
npm run eval -- '<expression>'  # one expression in that live page, as JSON
npm run shot -- workflow.json   # render a workflow file to a PNG
```

`npm test` runs the contract too when a built Harness checkout sits at
`../deepseek-harness` (or `DSH_ROOT`); without one it skips the contract, which
is why CI runs only `npm test` and the type check. A contract failure on a clean
checkout means the DSH runtime drifted, not that the change under test broke
something. `host-smoke` binds a contiguous block of five ports; set
`DSH_COMFYUI_TEST_PORT=19188 npm test` to shift the block so several checkouts
(worktrees, a second clone) can run the suite at the same time.

A layout change is verified by looking, not by arithmetic: `comfyui_screenshot`
for the panel's own canvas, `npm run shot` for a workflow file. Both print or
return a path to open with `read_image`; `comfyui_graph_read layout=true` adds
the overlapping pairs when only the numbers are in question.

Adding or moving a test: read [test/README.md](test/README.md) and put the file in that layer's list in `test/run.mjs`. A new route or tool needs a case in `host-smoke.mjs`; a new integration point (path, service, scope, tool schema) additionally needs a case in `dsh-contract.mjs`. The pre-commit hook runs `npm test`, plus `npm run
typecheck` when `node_modules` exists; it is enabled with `git config
core.hooksPath .githooks` (already set in this checkout, and not inherited by a
fresh clone).

The type check is only as good as the annotations it reads. A function with no
`@param` types has `any` parameters, so a call with the wrong number of
arguments still passes — that is exactly how a sync once shipped calling
`frontendClientId()` with no arguments and queued every run under an id no
socket owned. Give a function whose signature carries meaning `@param` and
`@returns` tags, and the call sites get checked.

Reviewing a change: open `CODING_STANDARDS.md` for the judgement rules the
checks cannot enforce.

## After a client change

`dev/panel-check.md` is the whole loop: reload the live plugin, run `npm run
ui`, then the manual pass for what the headless check cannot see (the digest
line, the bar's labels, the stopped stage, a queued run). For a single fact
about the running page, `npm run eval -- '<expression>'` prints it. When the
check cannot run at all — no launch address, no browser — `test/ui/README.md` →
"Machines without a browser or a token" has both, in the order to try them.

## Docs

`README.md` is Simplified Chinese and the package's front page; `README_en.md`
is English. The line at the top of each links both by absolute URL, so it works
on npm and on GitHub. A change a user can see updates both.

`docs/` holds what a user reads: `supervise.md`, and the README's pictures
(`panel.png`, `commands.png`, `settings.png`, and the 1280×640
`social-preview.png`). README images are absolute `raw.githubusercontent.com`
URLs, so the detail page, GitHub and npm all render them. The maintainer's
documents live in `dev/`: the ComfyUI surface, the client check loop, and the
release sequence. `test/packaging.mjs` keeps `locale/*.json`, the document each
language names, and `files` in agreement.

## Parallel work

Writes outside this checkout are denied, so a worktree lives inside it. The
directory is ignored, and the dependency link lets the check run without a
second install:

```bash
git worktree add -b <branch> .worktrees/<name> main
ln -s ../../node_modules .worktrees/<name>/node_modules
```

Give each worktree its own port block (`DSH_COMFYUI_TEST_PORT=19188 npm test`)
so two suites can run at once.

## Publishing

This repository is meant to be published, and the release details are kept
apart so they load only when a release is being cut. Sequence, tag rules and
the `market/index.json` constraints: [dev/release.md](dev/release.md).
`npm test` already rejects home-directory paths in the tree and in every
commit; the pre-commit hook also rejects this machine's account name and
hostname as bare words.

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
  normalizes them with `Number()`, and the Host coerces the canonical spelling
  itself, so a payload that still carries `'9'` is not dropped. A non-canonical
  id (`'09'`, `'9.0'`) drops that node only. The model falls back to positional
  widget values only when every node was dropped.
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
- `prefix` is fixed at `/comfyui`. `normalizeConfig` throws on any other value;
  the client hardcodes `PANEL_URL`. The proxy strips `dsh-auth-…` cookies
  before they reach ComfyUI and still forwards other cookies and
  `Authorization`. See SECURITY.md before changing that filter.
