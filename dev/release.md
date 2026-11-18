# Publishing

This repository is meant to be published. `npm test` rejects home-directory
paths in the working tree and in every commit (`test/repo-hygiene.mjs`). The
pre-commit hook also sets `DSH_HYGIENE_STRICT=1`, which rejects this machine's
account name and hostname as bare words; CI does not, because the runner's
name is not the leak. A hit in history means a history rewrite, not a new
commit: fix the file, then rewrite the affected commits before publishing, and
re-run the same check until it is quiet.

A release is a commit plus an index entry that pins it, and the tag names the
commit that carries both:

1. Bump `package.json`. In `CHANGELOG.md`, date the `## [Unreleased]` section
   as `## [<version>] - YYYY-MM-DD` (Asia/Shanghai), leave a new empty
   `[Unreleased]` above it, and retarget the compare links: `[Unreleased]`
   points at `v<version>...HEAD`, and a new `[<version>]` link compares the
   previous tag to `v<version>`. Do that by hand only when cutting the release
   yourself. `scripts/release.mjs` does the same rename; do not rename the
   section and then run the script.
2. Commit it with `--no-verify`. This commit cannot pass the pre-commit hook or
   CI: the index still pins the previous release and `npm test` says so. That is
   expected — the next step supplies the index, and step 5 gives the release a
   green commit to point at.
3. `npm run market` — writes `market/index.json` with `version` pinned to that
   release commit and its commit time as `publishTimestamp`, keeping older
   versions.
4. `npm test` (validates the index against the real validator), then commit
   `market/index.json`.
5. Tag this second commit, not the version bump: `git tag v<version>`, then
   `git push origin main --tags`. The tag points at a commit whose CI is green,
   while the index still installs the release commit it pins.

GitHub can run the same sequence for you: **Actions -> release -> Run
workflow**, with the version and `dry_run` unchecked. It runs the suite, then
`scripts/release.mjs` creates the two commits and the tag, pushes, and creates
the GitHub Release. Its body is chosen from the section, not copied: up to
eight bullets, one per category per round, then a link to the full section,
because a release page is read at a glance. npm publishing stays manual: after the workflow finishes,
run `npm publish --access public` from the released tag. Add a `RELEASE_TOKEN`
secret (fine-grained, contents: write) if the pushed commits should also
trigger the test workflow; pushes made with the default `GITHUB_TOKEN` do not.
The workflow pushes straight to `main`, so any branch protection must allow it.
Leaving `dry_run` checked runs the checks and prints the plan without writing
anything.

Do not move a published tag to fix a red run; cut the next patch release
instead. The exception is a tag that was moved within the same release before
anyone installed it.

Do not edit `market/index.json` by hand: the commit SHA, the timestamp, and
`engines.dsh` must agree with the commit and the package, and the test says so.
Publishing to npm is optional and separate (`npm publish`); npm-based community
indexes discover packages through the `keywords: ["dsh-plugin"]` keyword and the
`dsh.bundle` field, so a publish there needs no index change here.
