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
 * Usage:
 *   node scripts/release.mjs --version 0.8.1 [--dry-run] [--notes-file PATH]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

/** @param {string} name - flag to read. @returns {string | null} the value after it. */
function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

/** @param {string} program - binary. @param {string[]} argv - arguments. @param {string[]} [extra] - options. */
function run(program, argv, extra = []) {
  process.stdout.write(`$ ${[program, ...argv].join(' ')}\n`)
  execFileSync(program, argv, { cwd: ROOT, stdio: 'inherit', ...extra })
}

/** @param {string} program - binary. @param {string[]} argv - arguments. @returns {string} trimmed stdout. */
function output(program, argv) {
  return execFileSync(program, argv, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** @param {string} text - a semver version. @returns {number[]} its numeric parts. */
function parts(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text)
  if (match === null) throw new Error(`"${text}" is not a x.y.z version`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** @param {number[]} left - candidate. @param {number[]} right - current. @returns {boolean} left is newer. */
function newer(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

const requested = option('--version')
if (requested === null) throw new Error('pass --version x.y.z')
const dryRun = args.includes('--dry-run')
const notesFile = option('--notes-file')
const version = parts(requested)
const label = requested

const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') throw new Error(`release from main, not "${branch}"`)
if (output('git', ['status', '--porcelain']) !== '') throw new Error('the working tree must be clean')
if (output('git', ['tag', '-l', `v${label}`]) !== '') throw new Error(`tag v${label} already exists`)

const pkgPath = resolve(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
if (!newer(version, parts(pkg.version))) throw new Error(`v${label} must be newer than v${pkg.version}`)

const changelogPath = resolve(ROOT, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
if (!changelog.includes('## Unreleased')) throw new Error('CHANGELOG.md has no "## Unreleased" section to name')

if (dryRun) {
  console.log(`dry run: would release ${pkg.version} -> ${label} from ${branch}, tag v${label}`)
  process.exit(0)
}

// The release commit: version and changelog only, so the index can pin it.
pkg.version = label
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
const renamed = changelog.replace('## Unreleased', `## ${label}`)
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
  const start = renamed.indexOf(`## ${label}`)
  const next = renamed.indexOf('\n## ', start + 1)
  const body = (next === -1 ? renamed.slice(start) : renamed.slice(start, next)).replace(`## ${label}\n`, '').trim()
  writeFileSync(resolve(ROOT, notesFile), `${body}\n`)
}

console.log(`\nreleased ${label}: ${releaseCommit.slice(0, 8)} + index ${indexCommit.slice(0, 8)}, tag v${label}`)
console.log(`push with: git push origin main --tags`)
