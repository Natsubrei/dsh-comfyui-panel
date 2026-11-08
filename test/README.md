# Tests

`npm test` is `npm run check`, then `node test/run.mjs`. The runner prints the layer and stops at the first failing file. The file list in `test/run.mjs` is the list; this page is the rule for which layer a test belongs to.

## unit

One function. The inputs are values. No Host, no process, no browser.

- `test/desk.mjs` — which session the page reuses, a blank message, and which events become transcript rows.
- `test/service-plan.mjs` — which interpreter to spawn, whether a pid is this checkout, and whether the reported frontend matches.

## module

One module's public interface. A neighbour is a fake, except where the module is defined to call another: the session store releases through the real command channel, because a fake of that callback would only restate the call.

- `test/commands.mjs` — queue expiry, ask, poll, answer, and a poll released when the session goes away.
- `test/session-store.mjs` — sync, revision, name source, run records, and what `release()` drops.
- `test/run-tracker.mjs` — queue and history reads, with an injected clock.
- `test/service-controller.mjs` — adopt a healthy checkout, report a foreign one, with injected probes.
- `test/client-ops.mjs` — the browser module loaded behind a stub. Editor operations, the stage, and the two dictionaries.

## system

The plugin composed. A failure here that the module layer already covers is a wiring bug, not a reason to retest the rule.

- `test/host-smoke.mjs` — every route and tool against a fake Host and a mock ComfyUI.
- `scripts/contract-if-present.mjs` — the same routes against the real runtime when a Harness checkout is present. Skipped otherwise.
- `npm run ui` — the live page in one headless browser, in three layers: page, editor, desk. It is not part of `npm test`: it needs a running `dsh web` and Chromium. See `test/ui/README.md`.

## release

The package, the docs, and the market index. Not a behaviour layer.

- `test/packaging.mjs`, `test/readme-tools.mjs`, `test/changelog-release.mjs`, `test/repo-hygiene.mjs`, `test/market-index.mjs`.

## Where a new test goes

A decision that can be stated with values goes in unit. A rule of one module's interface goes in module. A route, a tool schema, or a scope goes in `host-smoke.mjs`, and also in `dsh-contract.mjs` when it is an integration point the fake Host cannot reject. Something you can only see in the browser goes in `test/ui/panel.mjs`.

`npm test` does not open the page. `npm run ui` covers the column, including collapse and New. The sidebar glyph, a real model turn, and a second send while the first is still running are still checked by hand.
