/**
 * Keep machine-specific details out of the published repository.
 *
 * The working tree is checked with `git ls-files`, so build output and local
 * scratch directories are ignored, and the whole history is checked with one
 * `git grep` over every commit — a home directory that only survives in an old
 * commit would otherwise ship with a `git clone`.
 *
 * Run as part of `npm test`; run it on its own while preparing a release.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'

/** Paths that only exist on one machine. Each rule carries a text pattern for
 * the working tree and an ERE pattern for `git grep` over the history. */
const PATH_RULES = [
  {
    name: 'absolute home directory',
    pattern: /(?:^|[^\w/])\/(?:home|Users)\/[A-Za-z0-9._-]+\//u,
    grep: '(^|[^A-Za-z0-9_/])/(home|Users)/[A-Za-z0-9._-]+/',
    example: 'use a neutral path such as /opt/ComfyUI',
  },
  {
    name: 'Windows user profile',
    pattern: /[A-Za-z]:\\+Users\\+/u,
    grep: '[A-Za-z]:\\\\+Users\\\\+',
    example: 'use a neutral path such as C:\\ComfyUI',
  },
]

/** The current account and host, which must not appear in a public tree. */
function localNames() {
  const rules = []
  try {
    const { username } = userInfo()
    if (typeof username === 'string' && username.length >= 3 && !/^(user|admin|root|runner|node)$/iu.test(username)) {
      const escaped = username.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      rules.push({
        name: 'this machine account',
        pattern: new RegExp(`\\b${escaped}\\b`, 'u'),
        grep: `\\b${escaped}\\b`,
        example: 'replace it with a placeholder',
      })
    }
  } catch {
    // A container without a user database is fine.
  }
  const host = hostname()
  if (host.length >= 4) {
    const escaped = host.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    rules.push({
      name: 'this machine hostname',
      pattern: new RegExp(`\\b${escaped}\\b`, 'u'),
      grep: `\\b${escaped}\\b`,
      example: 'replace it with a placeholder',
    })
  }
  return rules
}

/**
 * Run one git command and return its stdout.
 * @param {string[]} args - git arguments.
 * @returns {string} stdout, or `''` when git refuses (not a repository).
 */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/**
 * Scan the working tree.
 * @param {Array<{name: string, pattern: RegExp, example: string}>} rules - patterns to look for.
 * @returns {string[]} one `file:line: rule: text` line per hit.
 */
function scanTree(rules) {
  const files = git(['ls-files']).split('\n').filter(file => file !== '')
  const hits = []
  for (const file of files) {
    if (file === 'test/repo-hygiene.mjs') continue
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (const rule of rules) {
      for (const [index, line] of lines.entries()) {
        if (rule.pattern.test(line)) hits.push(`${file}:${String(index + 1)}: ${rule.name}: ${line.trim().slice(0, 120)}`)
      }
    }
  }
  return hits
}

/**
 * Scan every commit's tree.
 * @param {Array<{name: string, pattern: RegExp, example: string}>} rules - patterns to look for.
 * @returns {string[]} one line per hit, with the introducing commit.
 */
function scanHistory(rules) {
  const commits = git(['rev-list', '--all']).split('\n').filter(commit => commit !== '')
  if (commits.length === 0) return []
  const hits = []
  for (const rule of rules) {
    // `git grep` over every revision prints `<commit>:<file>:<line>:<text>`.
    const found = git(['grep', '-nIE', rule.grep, ...commits])
    for (const line of found.split('\n')) {
      if (line === '') continue
      const [commit, file, number, ...rest] = line.split(':')
      if (file === 'test/repo-hygiene.mjs') continue
      hits.push(`${commit.slice(0, 7)} ${file}:${number}: ${rule.name}: ${rest.join(':').trim().slice(0, 120)}`)
    }
  }
  return hits
}

const rules = [...PATH_RULES, ...localNames()]
const treeHits = scanTree(rules)
const historyHits = scanHistory(rules)

if (treeHits.length === 0 && historyHits.length === 0) {
  console.log('repo hygiene test passed')
  process.exitCode = 0
} else {
  if (treeHits.length > 0) {
    console.error(`machine-specific content in the working tree (${String(treeHits.length)}):`)
    for (const hit of treeHits.slice(0, 20)) console.error(`  ${hit}`)
  }
  if (historyHits.length > 0) {
    console.error(`machine-specific content in the history (${String(historyHits.length)}):`)
    for (const hit of historyHits.slice(0, 20)) console.error(`  ${hit}`)
    console.error('  rewrite the affected commits before publishing; see AGENTS.md')
  }
  process.exitCode = 1
}
