/**
 * Run the suite one layer at a time. A layer stops the run when one of its
 * files fails, so a unit failure is not buried under a system log.
 *
 * Unit: one function, values in, values out.
 * Module: one module's interface. Neighbours are fakes, or the one module it
 * is defined to call.
 * System: the plugin composed — fake Host, then the real runtime when present.
 * Release: the package, the docs, and the market index. Not a product layer.
 */
import { spawnSync } from 'node:child_process'

/** @type {readonly [string, readonly string[]][]} */
const LAYERS = [
  ['unit', [
    'test/desk.mjs',
    'test/service-plan.mjs',
  ]],
  ['module', [
    'test/commands.mjs',
    'test/session-store.mjs',
    'test/run-tracker.mjs',
    'test/service-controller.mjs',
    'test/client-ops.mjs',
  ]],
  ['system', [
    'test/host-smoke.mjs',
    'scripts/contract-if-present.mjs',
  ]],
  ['release', [
    'test/packaging.mjs',
    'test/readme-tools.mjs',
    'test/changelog-release.mjs',
    'test/repo-hygiene.mjs',
    'test/market-index.mjs',
  ]],
]

for (const [name, files] of LAYERS) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`)
  for (const file of files) {
    const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`\n${name} failed: ${file}`)
      process.exit(result.status === null ? 1 : result.status)
    }
  }
}

console.log('\nall layers passed')
