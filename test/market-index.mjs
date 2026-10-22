/**
 * Validate `market/index.json` before it is published.
 *
 * DSH rejects a whole index on the first rule it breaks, so a typo here means
 * users see "could not read the index" and nothing else. This check runs the
 * *real* validator from `@deepseek-ai/dsh-plugin-market-index` when a Harness
 * checkout is next to this one, and otherwise keeps its own structural checks
 * (the index name, version, commit, and timestamp still have to agree with the
 * repository).
 *
 * Part of `npm test`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_URL = 'https://raw.githubusercontent.com/Natsubrei/dsh-comfyui-panel/main/market/index.json'
const DSH_VALIDATOR = join(ROOT, '..', 'deepseek-harness/packages/util/plugin-market-index/lib/index.js')

const failures = []

/** @param {string} message - why the index is not publishable. */
function fail(message) {
  failures.push(message)
}

/** @param {string[]} args - one git command. @returns {string} trimmed stdout, or `''` when git cannot answer. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

if (!existsSync(join(ROOT, 'market/index.json'))) {
  // A release commit that has not been indexed yet must not masquerade as a
  // passing repository: the index is the install entry point.
  console.error('market/index.json is missing; run `npm run market` after the release commit')
  process.exitCode = 1
} else {
  const index = JSON.parse(readFileSync(join(ROOT, 'market/index.json'), 'utf8'))

  if (index.format !== 1) fail('$.format must be 1')
  const plugin = Array.isArray(index.plugins) ? index.plugins[0] : undefined
  if (typeof plugin !== 'object' || plugin === null) fail('$.plugins[0] is missing')
  else {
    if (plugin.name !== packageJson.name) fail(`$.plugins[0].name must be ${packageJson.name}`)
    const versions = Array.isArray(plugin.versions) ? plugin.versions : []
    const current = versions.find(version => version.version === packageJson.version)
    if (current === undefined) fail(`$.plugins[0].versions must list ${packageJson.version}; run \`npm run market\``)
    if (versions.length === 0) fail('$.plugins[0].versions must not be empty')
    for (const version of versions) {
      const at = `$.plugins[0].versions[${String(versions.indexOf(version))}]`
      if (typeof version.publishTimestamp !== 'number' || !Number.isInteger(version.publishTimestamp)) {
        fail(`${at}.publishTimestamp must be integer Unix seconds`)
      }
      if (version.engines?.dsh !== packageJson.engines.dsh) fail(`${at}.engines.dsh must match package.json`)
      if (version.source?.type !== 'git') fail(`${at}.source.type must be "git"`)
      if (!/^[0-9a-f]{40}$/u.test(String(version.source?.commit))) fail(`${at}.source.commit must be a full SHA`)
      // The pinned commit must exist here: an index that names a commit nobody
      // has is an index whose install fails for every user.
      if (git(['rev-parse', '--verify', '--quiet', `${String(version.source?.commit)}^{commit}`]) === '') {
        fail(`${at}.source.commit ${String(version.source?.commit).slice(0, 7)} is not in this repository`)
      }
    }
  }

  if (failures.length === 0 && existsSync(DSH_VALIDATOR)) {
    const { parseMarketIndex } = await import(pathToFileURL(DSH_VALIDATOR).href)
    try {
      parseMarketIndex(index, INDEX_URL)
    } catch (error) {
      fail(`DSH validator: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`)
    console.error('market index check failed')
    process.exitCode = 1
  } else {
    const validated = existsSync(DSH_VALIDATOR) ? 'DSH validator' : 'structure only; DSH validator skipped (no ../deepseek-harness)'
    console.log(`market index test passed (${validated})`)
    process.exitCode = 0
  }
}
