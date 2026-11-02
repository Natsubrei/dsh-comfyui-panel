/**
 * Keep machine-specific details out of the published repository.
 *
 * The working tree is checked with `git ls-files`, so build output and local
 * scratch directories are ignored, and the whole history is checked with one
 * `git grep` over every commit — a home directory that only survives in an old
 * commit would otherwise ship with a `git clone`.
 *
 * Path leaks fail for everyone. This machine's account name and hostname fail
 * as bare words only when `DSH_HYGIENE_STRICT=1` (the pre-commit hook). A
 * contributor whose name is an ordinary word in the tree can still run
 * `npm test`.
 *
 * Run as part of `npm test`; run it with `DSH_HYGIENE_STRICT=1` before publishing.
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

/** Bare-word identity scan. The pre-commit hook sets this; CI does not. */
const STRICT = process.env.DSH_HYGIENE_STRICT === '1'

/**
 * Escape a string for both a JavaScript RegExp and a POSIX extended regex.
 * @param {string} value - literal text.
 * @returns {string} the escaped text.
 */
function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * One hygiene rule, shared by the word scan and the address scan.
 * @param {string} name - what a hit is called in the report.
 * @param {RegExp} pattern - working-tree match.
 * @param {string} grep - POSIX extended regex for `git grep`.
 * @param {string} example - the hint printed with a hit.
 * @returns {{name: string, pattern: RegExp, grep: string, example: string}}
 */
function rule(name, pattern, grep, example) {
  return { name, pattern, grep, example }
}

/**
 * A word-boundary rule. Used for the strict identity scan, not the portable one.
 * @param {string} name - what a hit is called in the report.
 * @param {string} text - the account or host to reject.
 * @param {string} example - the hint printed with a hit.
 * @returns {{name: string, pattern: RegExp, grep: string, example: string}}
 */
function wordRule(name, text, example) {
  const escaped = escapeRegExp(text)
  return rule(name, new RegExp(`\\b${escaped}\\b`, 'u'), `\\b${escaped}\\b`, example)
}

/**
 * An address-shaped account leak (`name@`), which is not an ordinary word.
 * @param {string} username - the current account.
 * @returns {{name: string, pattern: RegExp, grep: string, example: string}}
 */
function emailRule(username) {
  const escaped = escapeRegExp(username)
  return rule(
    'this machine account in an address',
    new RegExp(`(?:^|[^A-Za-z0-9._-])${escaped}@`, 'u'),
    `(^|[^A-Za-z0-9._-])${escaped}@`,
    'use a placeholder address',
  )
}

/** Whether this account name is too generic to scan for. */
function skipAccount(username) {
  return typeof username !== 'string' || username.length < 3 || /^(user|admin|root|runner|node)$/iu.test(username)
}

/** The current account and host. Bare words are strict-only. */
function localNames() {
  /** @type {Array<{name: string, pattern: RegExp, grep: string, example: string}>} */
  const rules = []
  try {
    const { username } = userInfo()
    if (!skipAccount(username)) {
      rules.push(emailRule(username))
      if (STRICT) rules.push(wordRule('this machine account', username, 'replace it with a placeholder'))
    }
  } catch {
    // A container without a user database is fine.
  }
  const host = hostname()
  if (STRICT && host.length >= 4) {
    rules.push(wordRule('this machine hostname', host, 'replace it with a placeholder'))
  }
  return rules
}

/** Lock the portable/strict split. A contributor named `python` must not fail on ordinary source. */
function selfCheck() {
  const email = emailRule('python')
  if (!email.pattern.test('reach python@example.com')) throw new Error('hygiene self-check: address leak not matched')
  if (email.pattern.test('use python here')) throw new Error('hygiene self-check: ordinary word matched the address rule')
  const bare = wordRule('account', 'python', 'replace it')
  if (!bare.pattern.test('use python here')) throw new Error('hygiene self-check: strict word rule missed')
  if (bare.pattern.test('use python3 here')) throw new Error('hygiene self-check: word rule matched a longer identifier')
  const home = PATH_RULES.find(item => item.name === 'absolute home directory')
  if (home === undefined) throw new Error('hygiene self-check: home rule missing')
  if (!home.pattern.test('see /home/python/ComfyUI')) throw new Error('hygiene self-check: home path not matched')
  if (home.pattern.test('use python here')) throw new Error('hygiene self-check: home rule matched an ordinary word')
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
 * @param {Array<{name: string, pattern: RegExp, grep: string, example: string}>} rules - patterns to look for.
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
 * @param {Array<{name: string, pattern: RegExp, grep: string, example: string}>} rules - patterns to look for.
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

selfCheck()

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
  if (STRICT) console.error('  DSH_HYGIENE_STRICT=1 also rejects this machine account and hostname as bare words. Unset it for the portable path check.')
  process.exitCode = 1
}
