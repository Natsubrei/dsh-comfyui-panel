# Checking the panel in a real browser

`npm run ui` opens a real GUI in a headless Chromium, mounts the ComfyUI panel,
and asserts the behaviour that is easy to break without noticing. It speaks the
DevTools protocol directly, so it needs no dependencies and no browser
download — only a Chromium-family binary that is already installed.

```bash
# while `dsh web` is running, using the address it printed on start
npm run ui -- --url 'http://127.0.0.1:3080/?token=…'

# when that address is gone: the cookie from the browser's devtools
# (Application → Cookies → dsh-auth-…), copied as name=value
DSH_WEB_COOKIE='dsh-auth-…=v1.…' npm run ui
```

`--url` is exchanged for the same signed cookie a browser receives, so the
printed address keeps working for as long as that `dsh web` process lives. If
neither is given, the check exits with usage instead of guessing.

The `DSH_WEB_URL` an agent inherits is the bare, tokenless address — it always
answers 401. Copy the `dsh web:` line from the terminal, or use a cookie; the
check says so when it sees a URL without `?token=…`.

## What it checks

| Check | Why it exists |
| --- | --- |
| panel mounts in the sidebar | the tab is registered and the guide entry opens it |
| editor boots | `/comfyui/` serves a frontend that exposes `comfyAPI.app.app` |
| bar publishes counters | the bar reports nodes, links, revision, and last sync |
| server state is known | the lifecycle chip resolved to a real state |
| workflow reaches the host | a state POST was accepted |
| panel reports the editor client id | the socket id a run is addressed to actually reached the Host |
| counters match the editor | the projection describes the graph on screen |
| zooming does not count as an edit | the viewport must not bump the revision |
| a widget edit bumps the revision once | real edits still do, exactly once |
| editor events reach the bar | execution events relayed from the editor's bus actually arrive |
| Fit frames the graph | the Fit button goes through ComfyUI's own command |
| no errors from the panel | no exception or unnamed console error during the run |

Screenshots of each state land in `.ui-out/` together with `report.txt`; the
exit code is non-zero when a check fails.

## What it touches

The check starts a **new draft session** and mounts the panel there, so it never
edits a conversation you care about. The draft is disposable: the same click in
the GUI is what "New session" does. With `--reuse-session` it stays in whatever
session is already open, which is useful for inspecting a session you prepared
yourself.

The check does not queue a run. `comfyui_run` needs a model tool call, and the
panel's run events follow the socket that queued the prompt, so a run is checked
by asking the model and watching `comfyui_progress`.

## Requirements and quirks

- A running `dsh web` with this plugin enabled and a ComfyUI the panel can
  reach. The panel itself starts ComfyUI when it is stopped, but the boot then
  takes as long as ComfyUI does.
- A Chromium, Chrome, Edge, or Brave binary. Set `CHROME_BIN` when it is not on
  `PATH` (a Playwright-downloaded `chrome-headless-shell` works).
- A minimal Linux image can lack the browser's shared libraries. If the launch
  fails with `libnspr4.so` or `libnss3.so`, point `LD_LIBRARY_PATH` at a
  directory that has them — no root is needed to unpack the packages.
- The viewport defaults to 1440×900; `--size 1024x800` checks the narrow
  layout, where the bar wraps.

## Machines without a browser or a token

The two things this check needs are also the two an agent rarely gets handed
over: the launch address, and a browser that starts.

- **No launch address.** `dsh web` prints it once, on the line starting with
  `dsh web:`, and it dies with the process. Start the server through
  `scripts/dsh-web.sh` and that line is teed to `~/.dsh/dsh.log`, so a lost
  terminal does not lose the address. Otherwise take the cookie a browser is
  already using: DevTools → Application → Cookies → `dsh-auth-<hash>`, then
  `DSH_WEB_COOKIE='name=value'`.
- **No Chromium on `PATH`.** `CHROME_BIN` takes any Chromium-family binary,
  including a Playwright download under `$HOME/.cache/ms-playwright/
  chromium_headless_shell-*/chrome-headless-shell-linux64/`.
- **The browser will not start.** On a minimal image the cause is usually a
  missing `libnspr4.so` / `libnss3.so`. Unpacking the packages is enough and
  needs no root: `apt-get download libnspr4 libnss3`, `dpkg -x <pkg>.deb
  /tmp/nsslibs` for each, then `LD_LIBRARY_PATH=/tmp/nsslibs/usr/lib/x86_64-linux-gnu`.

All of it at once:

```bash
CHROME_BIN="$HOME/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell" \
LD_LIBRARY_PATH=/tmp/nsslibs/usr/lib/x86_64-linux-gnu \
npm run ui -- --url "$(grep -oE 'http://[^ ]*/?token=[^ ]*' "$HOME/.dsh/dsh.log" | tail -1)"
```
