/**
 * Run the real-runtime contract when a Harness checkout is next to this repo.
 *
 * The contract needs the built Harness packages, so CI (which has no checkout)
 * cannot run it. A machine that does have one gets it as part of `npm test`,
 * and a DSH API drift then fails the next ordinary test run instead of waiting
 * for a release. A missing checkout is a skip, not a failure; `npm run contract`
 * stays the explicit command that does fail.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dsh = resolve(process.env.DSH_ROOT ?? join(root, '..', 'deepseek-harness'))
const built = join(dsh, 'packages', 'core', 'tools', 'lib', 'index.js')

if (!existsSync(built)) {
  console.log(`contract skipped: no built DSH checkout at ${dsh}`)
  process.exit(0)
}

const result = spawnSync(process.execPath, [join(root, 'test', 'dsh-contract.mjs')], {
  cwd: root,
  env: { ...process.env, DSH_ROOT: dsh },
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
