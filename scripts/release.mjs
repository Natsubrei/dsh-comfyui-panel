#!/usr/bin/env node
/**
 * Cut a release without a human running the steps one by one: bump the
 * package and changelog, commit that as the release commit, regenerate the
 * market index pinned to it, commit the index, and tag the index commit.
 *
 * Ordering matters. The index must name the commit that ships, so it can only
 * be generated after the version commit exists; and the tag must name the
 * index commit, or the tag points at a commit whose market-index check fails
 * by design. This script is what `release.yml` calls from GitHub Actions and
 * what a maintainer can run locally.
 *
 * The changelog follows Keep a Changelog. `nameUnreleased` dates the current
 * `## [Unreleased]` section as `## [x.y.z] - YYYY-MM-DD`, leaves a new empty
 * `[Unreleased]` above it, and retargets the compare links. The date is the
 * Asia/Shanghai calendar date, the same zone as the dates already in
 * CHANGELOG.md.
 *
 * Usage:
 *   node scripts/release.mjs --version 0.8.1 [--dry-run] [--notes-file PATH]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const COMPARE = 'https://github.com/Natsubrei/dsh-comfyui-panel/compare/v'

/**
 * Today's calendar date in Asia/Shanghai.
 * @param {Date} [now] - the instant to format. Defaults to the current time.
 * @returns {string} YYYY-MM-DD.
 */
export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const pick = (/** @type {Intl.DateTimeFormatPartTypes} */ type) => parts.find(part => part.type === type)?.value
  const year = pick('year')
  const month = pick('month')
  const day = pick('day')
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('could not format the Asia/Shanghai date')
  }
  return `${year}-${month}-${day}`
}

/**
 * Date the unreleased section, leave a new empty one above it, and point the
 * compare links at the new tag. The previous tag is whatever `[Unreleased]`
 * currently compares against.
 * @param {string} changelog - full changelog text.
 * @param {string} version - release version, x.y.z.
 * @param {string} date - calendar date, YYYY-MM-DD.
 * @returns {string} the changelog with the section named.
 */
export function nameUnreleased(changelog, version, date) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`"${version}" is not a x.y.z version`)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`"${date}" is not a YYYY-MM-DD date`)
  const headings = changelog.match(/^## \[Unreleased\]$/gm)
  if (headings === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section to name')
  if (headings.length !== 1) throw new Error('CHANGELOG.md has more than one "## [Unreleased]" section')
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a "## [${version}]" section`)
  const linkPattern = `^\\[Unreleased\\]: (${COMPARE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})(\\d+\\.\\d+\\.\\d+)\\.\\.\\.HEAD$`
  const found = [...changelog.matchAll(new RegExp(linkPattern, 'gm'))]
  if (found.length !== 1) throw new Error('CHANGELOG.md needs one [Unreleased] compare link')
  const previous = found[0][2]
  if (changelog.includes(`[${version}]:`)) throw new Error(`CHANGELOG.md already links [${version}]`)
  const renamed = changelog.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${version}] - ${date}`)
  return renamed.replace(
    new RegExp(linkPattern, 'm'),
    `[Unreleased]: $1${version}...HEAD\n[${version}]: $1${previous}...v${version}`,
  )
}

/**
 * The body of one version section, without the heading and without the link
 * footer. GitHub release notes are this text.
 * @param {string} changelog - full changelog text.
 * @param {string} version - x.y.z version whose section to read.
 * @returns {string} the section body, trimmed. Empty when the section has none.
 */
export function sectionBody(changelog, version) {
  const start = changelog.indexOf(`## [${version}]`)
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section`)
  const contentStart = changelog.indexOf('\n', start)
  if (contentStart === -1) return ''
  const kept = []
  for (const line of changelog.slice(contentStart + 1).split('\n')) {
    if (line.startsWith('## ')) break
    if (/^\[[^\]]+\]: /u.test(line)) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/**
 * @param {string} name - flag to read.
 * @param {string[]} args - the process arguments after the script name.
 * @returns {string | null} the value after it.
 */
function option(name, args) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

/**
 * @param {string} program - binary.
 * @param {string[]} argv - arguments.
 */
function run(program, argv) {
  process.stdout.write(`$ ${[program, ...argv].join(' ')}\n`)
  execFileSync(program, argv, { cwd: ROOT, stdio: 'inherit' })
}

/**
 * @param {string} program - binary.
 * @param {string[]} argv - arguments.
 * @returns {string} trimmed stdout.
 */
function output(program, argv) {
  return execFileSync(program, argv, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/**
 * @param {string} text - a semver version.
 * @returns {number[]} its numeric parts.
 */
function parts(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text)
  if (match === null) throw new Error(`"${text}" is not a x.y.z version`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * @param {number[]} left - candidate.
 * @param {number[]} right - current.
 * @returns {boolean} left is newer.
 */
function newer(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/** Cut the release described by this process's arguments. */
function main() {
  const args = process.argv.slice(2)
  const requested = option('--version', args)
  if (requested === null) throw new Error('pass --version x.y.z')
  const dryRun = args.includes('--dry-run')
  const notesFile = option('--notes-file', args)
  const version = parts(requested)
  const label = requested
  const date = shanghaiDate()

  const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') throw new Error(`release from main, not "${branch}"`)
  if (output('git', ['status', '--porcelain']) !== '') throw new Error('the working tree must be clean')
  if (output('git', ['tag', '-l', `v${label}`]) !== '') throw new Error(`tag v${label} already exists`)

  const pkgPath = resolve(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (!newer(version, parts(pkg.version))) throw new Error(`v${label} must be newer than v${pkg.version}`)

  const changelogPath = resolve(ROOT, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const renamed = nameUnreleased(changelog, label, date)

  if (dryRun) {
    console.log(`dry run: would release ${pkg.version} -> ${label} from ${branch}, tag v${label}, changelog date ${date}`)
    return
  }

  // The release commit: version and changelog only, so the index can pin it.
  pkg.version = label
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(changelogPath, renamed)
  run('git', ['add', 'package.json', 'CHANGELOG.md'])
  run('git', ['commit', '--no-verify', '-m', `Release ${label}`])
  const releaseCommit = output('git', ['rev-parse', 'HEAD'])

  // The index commit: generated against the release commit, then validated.
  run('node', ['scripts/market-index.mjs'])
  run('node', ['test/market-index.mjs'])
  run('git', ['add', 'market/index.json'])
  run('git', ['commit', '--no-verify', '-m', `Publish the ${label} market index`])
  const indexCommit = output('git', ['rev-parse', 'HEAD'])

  // The tag names the commit that carries both, so its CI can pass.
  run('git', ['tag', `v${label}`])

  if (notesFile !== null) {
    writeFileSync(resolve(ROOT, notesFile), `${sectionBody(renamed, label)}\n`)
  }

  console.log(`\nreleased ${label}: ${releaseCommit.slice(0, 8)} + index ${indexCommit.slice(0, 8)}, tag v${label}`)
  console.log('push with: git push origin main --tags')
}

/**
 * True when this file is the process entry point, so a test can import it.
 * @returns {boolean} whether to cut a release.
 */
function isDirectRun() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
}

if (isDirectRun()) main()
