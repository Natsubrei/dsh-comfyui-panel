# Contributing

Issues and pull requests are welcome. The maintainer notes in [AGENTS.md](AGENTS.md) cover reloading a live plugin and publishing a release; this file is the path that does not need that machine.

## Checks

```bash
npm install
npm test
npm run typecheck
```

`npm test` covers the proxy, the bridges, editor operations, packaging, and repository hygiene. It does not need ComfyUI or a running DSH.

Two checks stay local, and continuous integration skips both:

- `npm run contract` needs a built DeepSeek Harness checkout at `../deepseek-harness` (or `DSH_ROOT`).
- `npm run ui` needs a running `dsh web` and a Chromium-family browser. See [test/ui/README.md](test/ui/README.md).

A green pull request therefore does not prove the plugin still mounts on the current DSH or the current ComfyUI frontend. Say which frontend you ran against when the change touches the editor bridge ([docs/comfyui-bridge.md](docs/comfyui-bridge.md)).

A change a user can see gets one bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`. Leave out an empty category. The file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

A new ComfyUI frontend object or method is recorded in [docs/comfyui-bridge.md](docs/comfyui-bridge.md) in the same change. That rule, and the one about editor-state commands, is in [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Hooks and hygiene

A fresh clone does not install the pre-commit hook. Enable it with `git config core.hooksPath .githooks` if you want the same gate as this checkout.

`npm test` rejects home-directory paths in the tree and in every commit. The hook also sets `DSH_HYGIENE_STRICT=1`, which rejects this machine's account name and hostname as bare words. Continuous integration does not set that variable. If the strict check fails because your account name is an ordinary word already in the source, that is the hook, not your change; `npm test` without the variable is the portable run.

## Panel path

`prefix` is fixed at `/comfyui`. The client hardcodes that path, and a different value fails plugin load. Changing it means changing the client and the Host together.
