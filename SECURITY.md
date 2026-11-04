# Security

Report a vulnerability through [GitHub Security Advisories](https://github.com/Natsubrei/dsh-comfyui-panel/security/advisories/new) for this repository. A public issue is fine only when the report cannot be used against someone who has the plugin installed.

## What an install trusts

The panel serves ComfyUI on the DSH origin, in an iframe without a `sandbox`. That is what lets the parent page read `window.comfyAPI`. It also means JavaScript shipped by ComfyUI — including a third-party custom node UI — runs as the DSH page and can call DSH routes with the logged-in browser. Install node packs you trust.

Anyone the Host has already admitted can:

- start, stop, and restart ComfyUI, and set its directory, through `/api/comfyui/service` (the directory must contain `main.py`; the panel does not accept an arbitrary command)
- name a `sessionId` on the workflow bridge and sync a graph onto that session

A `supervise` block in the profile's `cordis.patch.yml` can name any command. That file is trusted configuration, not a panel field.

## Upstream

Prefer a loopback `upstream`. The proxy removes the DSH admission cookie (`dsh-auth` and `dsh-auth-…`) before forwarding HTTP and WebSocket requests. Other cookies and `Authorization` are still forwarded, because ComfyUI may be using them. Point `upstream` only at a server you trust.

## Supported versions

A fix goes to `main` and ships in the next release. Older tags are not patched. Install the current release to pick up a fix.
