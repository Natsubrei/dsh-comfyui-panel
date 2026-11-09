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
learned the socket id, and the panel frames the graph when the editor loads. It needs a running `dsh web`
and an installed Chromium (`test/ui/README.md` has the address, cookie and
library it wants), and it uses a **blank draft session** — created, or the one
already open — so it never touches a conversation that has content.

The check needs the address `dsh web` prints on start — its `?token=…` is the
only one that authenticates — or a cookie from the browser; `test/ui/README.md`
covers both.

## The manual pass

What the headless check cannot see, in order:

1. Hard-refresh the GUI, open **ComfyUI** in the left sidebar, and wait until the bar says **Running**.
2. The header digest should read `ComfyUI: rev … · "name" · N nodes · … ·
   panel open.` (the quoted part appears only when the workflow has a name).
3. The bar sits over the bottom centre of the canvas — the one strip ComfyUI
   leaves free — and it must not cover the frontend's own bottom-left settings
   or its frame-rate readout. It is one flat row with no menu behind it: the
   status dot and label (`Running` / `Stopped` / `External` / `Starting`), the
   running prompt's node and steps, the preview thumbnail, then **Start**,
   **Stop**, **Settings**, and **Cancel** while a run is active. Every command
   is one click away; nothing appears or disappears with the state, and a
   command that does not apply is grey and says why on hover (already running,
   nothing running, started outside the plugin, waiting for the previous
   request). There is no Fit — ComfyUI's zoom menu has one and the panel frames
   the graph on load — no manual Sync (it syncs every second), and no Reload or
   Open at all: Stop then Start is the recovery, and it replaces the editor.
4. **Settings** opens as a sheet over the canvas, attached above the bar, and
   holds configuration only: the directory, **Start with DSH**, Save. The state
   is on the bar, not repeated here. Opening or closing it must not move or
   resize the editor, and Escape or a click outside closes it. Stop then Start
   must swap the iframe element rather than navigate it: no browser "leave this
   page?" prompt, because a prompt means the panel navigated the frame and
   ComfyUI's unsaved-changes guard fired.
5. Zoom, pan, and resize the panel; `rev` must not change. Edit a widget in
   the editor or let the model do it; the revision goes up by exactly one and a
   short toast names what changed.
6. Queue one run; `comfyui_progress` should go `queued` → `running` → success.
   This one needs the model: the check does not queue runs.
7. Stop the server and look at the stage: a card with the mark, `ComfyUI is
   not running`, the reason, and the folder — no buttons, because the bar owns
   Start and Settings. Starting shows `Starting ComfyUI Ns`; a frontend that
   never hands over `comfyAPI.app` within 45 s shows `The editor did not load`
   with Reload.
8. If the bar reads `Running · Bridge error`, the state POST is failing: check
   the Host log and `fetch('/api/comfyui/state?sessionId=…')` from the page
   before touching panel code.

When no browser can run (no `dsh web`, no Chromium), ask the user for a
confirmation or a screenshot instead of guessing; say which of the steps above
you could not run.
