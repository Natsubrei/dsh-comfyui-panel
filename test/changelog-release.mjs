/**
 * Keep a Changelog shape, and the rename the release script applies to it.
 *
 * The release script reads `## [Unreleased]` and the compare link under it.
 * A hand-edited heading that the script cannot rename fails here, before a
 * release workflow does.
 *
 * Part of `npm test`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nameUnreleased, sectionBody, shanghaiDate } from '../scripts/release.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']

/**
 * @param {string} text - one version section, without the heading.
 * @param {string} label - heading text, for the error.
 */
function assertSection(text, label) {
  /** @type {string | null} */
  let category = null
  /** @type {Map<string, boolean>} */
  const used = new Map()
  for (const line of text.split('\n')) {
    const heading = /^### ([A-Za-z]+)$/u.exec(line)
    if (heading !== null) {
      const name = heading[1]
      if (!CATEGORIES.includes(name)) throw new Error(`${label} has an unknown category "${name}"`)
      if (used.has(name)) throw new Error(`${label} repeats ### ${name}`)
      if (category !== null && used.get(category) !== true) {
        throw new Error(`${label} has an empty ### ${category}`)
      }
      category = name
      used.set(name, false)
      continue
    }
    if (line.startsWith('- ')) {
      if (category === null) throw new Error(`${label} has a bullet outside a category`)
      used.set(category, true)
    }
  }
  if (category !== null && used.get(category) !== true) {
    throw new Error(`${label} has an empty ### ${category}`)
  }
  if (label !== 'Unreleased' && used.size === 0 && text.trim() !== '') {
    throw new Error(`${label} has text but no category`)
  }
}

/**
 * @param {string} changelog - full changelog text.
 */
function assertChangelog(changelog) {
  if (!changelog.includes('https://keepachangelog.com/en/1.1.0/')) {
    throw new Error('CHANGELOG.md does not name Keep a Changelog 1.1.0')
  }
  if (!changelog.includes('https://semver.org/spec/v2.0.0.html')) {
    throw new Error('CHANGELOG.md does not name Semantic Versioning')
  }
  const unreleased = changelog.match(/^## \[Unreleased\]$/gm)
  if (unreleased === null || unreleased.length !== 1) {
    throw new Error('CHANGELOG.md needs exactly one "## [Unreleased]" section')
  }
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)]
  if (versions.length === 0) throw new Error('CHANGELOG.md has no dated version section')
  const link = changelog.match(/^\[Unreleased\]: https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/m)
  if (link === null) throw new Error('CHANGELOG.md needs one [Unreleased] compare link')
  if (link[1] !== versions[0][1]) {
    throw new Error(`[Unreleased] compares against v${link[1]}, but the first section is ${versions[0][1]}`)
  }
  const body = changelog.split(/^## /m).slice(1)
  const unreleasedBody = body[0].replace(/^\[Unreleased\]\n/u, '')
  assertSection(unreleasedBody.split(/^\[/m)[0], 'Unreleased')
  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index][1]
    if (!changelog.includes(`[${version}]: https://github.com/Natsubrei/dsh-comfyui-panel/`)) {
      throw new Error(`CHANGELOG.md does not link [${version}]`)
    }
    const section = body[index + 1]
    if (section === undefined || !section.startsWith(`[${version}] - `)) {
      throw new Error(`version section ${version} is not in order`)
    }
    assertSection(section.replace(/^\[[^\]]+\] - \d{4}-\d{2}-\d{2}\n/u, '').split(/^\[/m)[0], version)
  }
}

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
assertChangelog(changelog)

const named = nameUnreleased(changelog, '0.9.1', '2026-11-05')
assert.equal(named.match(/^## \[Unreleased\]$/gm)?.length, 1)
assert.match(named, /^## \[Unreleased\]\n\n## \[0\.9\.1\] - 2026-11-05$/m)
assert.match(named, /^\[Unreleased\]: https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/compare\/v0\.9\.1\.\.\.HEAD$/m)
assert.match(named, /^\[0\.9\.1\]: https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/compare\/v0\.9\.0\.\.\.v0\.9\.1$/m)
assert.match(named, /^\[0\.9\.0\]: https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/compare\/v0\.8\.1\.\.\.v0\.9\.0$/m)
assertChangelog(named)
const notes = sectionBody(named, '0.9.1')
assert.equal(/^## /mu.test(notes), false)
assert.equal(notes.includes('[0.9.0]:'), false)
assert.equal(sectionBody(named, 'Unreleased'), '')

assert.throws(() => nameUnreleased(changelog, '0.9.0', '2026-11-05'), /already has/)
assert.throws(() => nameUnreleased('## Unreleased\n', '0.9.1', '2026-11-05'), /no "## \[Unreleased\]"/)
assert.throws(() => nameUnreleased('## [Unreleased]\n', '0.9.1', '2026-11-05'), /compare link/)
assert.throws(() => nameUnreleased(changelog, '1.0', '2026-11-05'), /x\.y\.z/)
assert.throws(() => sectionBody(changelog, '9.9.9'), /no "## \[9\.9\.9\]"/)

const carried = [
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- The panel keeps the graph.',
  '',
  '## [0.9.0] - 2026-11-04',
  '',
  '### Added',
  '',
  '- Old.',
  '',
  '[Unreleased]: https://github.com/Natsubrei/dsh-comfyui-panel/compare/v0.9.0...HEAD',
  '[0.9.0]: https://github.com/Natsubrei/dsh-comfyui-panel/compare/v0.8.1...v0.9.0',
  '',
].join('\n')
const moved = nameUnreleased(carried, '0.9.1', '2026-11-05')
assert.equal(sectionBody(moved, '0.9.1'), '### Fixed\n\n- The panel keeps the graph.')
assert.equal(sectionBody(moved, '0.9.0'), '### Added\n\n- Old.')

assert.equal(shanghaiDate(new Date('2026-11-04T15:30:00Z')), '2026-11-04')
assert.equal(shanghaiDate(new Date('2026-11-04T16:30:00Z')), '2026-11-05')

console.log('changelog release test passed')
