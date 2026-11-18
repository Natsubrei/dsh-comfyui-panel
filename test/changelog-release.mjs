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
import { flowNotes, nameUnreleased, releaseNotes, sectionBody, shanghaiDate } from '../scripts/release.mjs'

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

const latest = /^## \[(\d+)\.(\d+)\.(\d+)\] - /mu.exec(changelog)
if (latest === null) throw new Error('CHANGELOG.md has no version to release past')
const next = `${latest[1]}.${latest[2]}.${Number(latest[3]) + 1}`
const previous = /^\[Unreleased\]: https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/mu.exec(changelog)
if (previous === null) throw new Error('CHANGELOG.md needs one [Unreleased] compare link')
const named = nameUnreleased(changelog, next, '2026-11-05')
assert.equal(named.match(/^## \[Unreleased\]$/gm)?.length, 1)
assert.match(named, new RegExp(`^## \\[Unreleased\\]\\n\\n## \\[${next}\\] - 2026-11-05$`, 'mu'))
assert.match(named, new RegExp(`^\\[Unreleased\\]: https://github\\.com/Natsubrei/dsh-comfyui-panel/compare/v${next}\\.\\.\\.HEAD$`, 'mu'))
assert.match(named, new RegExp(`^\\[${next}\\]: https://github\\.com/Natsubrei/dsh-comfyui-panel/compare/v${previous[1]}\\.\\.\\.v${next}$`, 'mu'))
assertChangelog(named)
const notes = sectionBody(named, next)
assert.equal(/^## /mu.test(notes), false)
assert.equal(notes.includes(`[${previous[1]}]:`), false)
assert.equal(sectionBody(named, 'Unreleased'), '')

assert.throws(() => nameUnreleased(changelog, `${latest[1]}.${latest[2]}.${latest[3]}`, '2026-11-05'), /already has/)
assert.throws(() => nameUnreleased('## Unreleased\n', '0.9.1', '2026-11-05'), /no "## \[Unreleased\]"/)
assert.throws(() => nameUnreleased('## [Unreleased]\n', '0.9.1', '2026-11-05'), /compare link/)
assert.throws(() => nameUnreleased(changelog, '1.0', '2026-11-05'), /x\.y\.z/)
assert.throws(() => sectionBody(changelog, '9.9.9'), /no "## \[9\.9\.9\]"/)

// A release body renders every source line as a line break, so the column the
// changelog wraps to would break its own bullets. The notes file is unwrapped.
const wrapped = [
  '### Fixed',
  '',
  '- A run that stopped being tracked is reported',
  '  as lost, not as a failure.',
  '',
  '### Added',
  '',
  '- One more.',
  '',
  '| Tool | Does |',
  '| --- | --- |',
  '| `a` | One |',
].join('\n')
const flowed = flowNotes(wrapped)
assert.match(flowed, /^- A run that stopped being tracked is reported as lost, not as a failure\.$/mu)
assert.match(flowed, /^### Fixed\n\n/mu)
assert.match(flowed, /^### Added\n\n- One more\.$/mu)
assert.match(flowed, /^\| Tool \| Does \|$/mu)
assert.equal(flowed.split('\n').some(line => /^\s+\S/u.test(line)), false)

// The release body is a glance, not the section: one bullet per category per
// round, eight at most, and a link to the part of the changelog that holds the
// rest. The anchor is GitHub's own slug for the section heading.
const many = [
  '### Added', '', ...Array.from({ length: 5 }, (_, i) => `- Added ${i}.`),
  '', '### Changed', '', '- Changed 0.', '', '### Fixed', '', ...Array.from({ length: 5 }, (_, i) => `- Fixed ${i}.`),
].join('\n')
const body = releaseNotes(many, '9.9.9', '2026-01-02')
assert.match(body, /^### Highlights\n\n/u)
assert.equal(body.split('\n').filter(line => line.startsWith('- ')).length, 8)
assert.match(body, /^- Added 0\.$/mu)
assert.match(body, /^- Changed 0\.$/mu)
assert.match(body, /^- Fixed 0\.$/mu)
assert.match(body, /- Added 1\.$/mu)
assert.match(body, /\[CHANGELOG\.md\]\(https:\/\/github\.com\/Natsubrei\/dsh-comfyui-panel\/blob\/main\/CHANGELOG\.md#999---2026-01-02\)$/mu)
assert.equal(releaseNotes('', '9.9.9', '2026-01-02'), '\n')

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
