# Checking the panel after a client change

ComfyUI's frontend is a third-party surface: most mistakes here show up only in
a browser. This is the whole loop — reload the plugin, run the headless check,
then the manual pass for what that check cannot see.

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

## Run the headless check

`npm run ui` automates what a headless browser can see: the panel mounts, the
editor boots, counters match the graph on screen, zooming is not an edit, a
widget edit bumps the revision once, editor events reach the bar, the Host
learned the socket id, and Fit frames the graph. It needs a running `dsh web`
and an installed Chromium (`test/ui/README.md` has the address, cookie and
library it wants), and it uses a **blank draft session** — created, or the one
already open — so it never touches a conversation that has content.

The check needs the address `dsh web` prints on start — its `?token=…` is the
only one that authenticates — or a cookie from the browser; `test/ui/README.md`
covers both.

## The manual pass

What the headless check cannot see, in order:

1. Hard-refresh the GUI, open the **ComfyUI** tab, wait for **Connected**.
2. The header digest should read `ComfyUI: rev … · "name" · N nodes · … ·
   panel open.` (the quoted part appears only when the workflow has a name).
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
