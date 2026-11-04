# Coding standards

For the reviewer of a change, this file records the two judgement rules the
suite, the type check and the pre-commit hook cannot enforce.

## 1. A new frontend dependency is documented in the same change

When a change starts using a ComfyUI frontend object or method the panel did
not use before, `docs/comfyui-bridge.md` gains that dependency and a way to
verify it after a frontend upgrade, in that same change.

Why: an undocumented dependency is found when an upgrade breaks it, and
nothing on file says what to re-check.

Lands in: `docs/comfyui-bridge.md`.

## 2. A command that reports editor state proves it first

A command whose answer describes the editor — a dialog is open, a tab moved —
checks that the frontend can perform the action before it answers, and answers
only from what it observed. Its tests cover the path where the capability is
missing.

Why: a swallowed capability error reports a dialog nobody opened, and the
model acts on a state the editor is not in.

Lands in: `client.js` for the check; `test/client-ops.mjs` for the
missing-capability case.
