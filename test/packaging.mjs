/**
 * Check that the package ships, and type-checks, everything it imports.
 *
 * `npm publish` ships only `package.json`'s `files`, and `npm run typecheck`
 * only checks `tsconfig.json`'s `include`. A module missing from either breaks
 * the consumer or hides itself from the checker while the whole suite stays
 * green. Both lists are kept by hand, so this checks them against the imports
 * the entry points actually use.
 *
 * Part of `npm test`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/** @param {string} message - what is wrong with the package. */
function fail(message) {
  failures.push(message)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'))
const shipped = new Set((pkg.files ?? []).map(file => file.replace(/^\.\//u, '')))
const included = new Set(tsconfig.include ?? [])

// Entry points: the Host half plus every JavaScript target `exports` names.
// `client.js` is served as-is to the browser and imports nothing, but it is
// checked here because a published tarball needs it.
const entries = [...new Set([
  'index.js',
  ...Object.values(pkg.exports ?? {})
    .filter(target => typeof target === 'string' && target.endsWith('.js'))
    .map(target => target.replace(/^\.\//u, '')),
])]

/**
 * @param {string} file - repo-relative path.
 * @returns {string[]} its relative import targets, repo-relative.
 */
function importsOf(file) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const found = []
  for (const match of text.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu)) {
    found.push(resolve(ROOT, dirname(file), match[1]).slice(ROOT.length + 1))
  }
  return found
}

for (const entry of entries) {
  for (const target of importsOf(entry)) {
    if (!shipped.has(target)) fail(`${entry} imports ${target}, which "files" does not ship`)
    if (!included.has(target)) fail(`${entry} imports ${target}, which tsconfig include does not check`)
  }
}

for (const file of shipped) {
  if (!existsSync(join(ROOT, file))) fail(`"files" lists ${file}, which does not exist`)
}

// A root module that ships but is not in the checker's inputs is unchecked.
for (const file of shipped) {
  if (!file.endsWith('.js') || file.includes('/')) continue
  if (!included.has(file)) fail(`${file} ships but tsconfig include does not check it`)
}

if (failures.length > 0) {
  for (const message of failures) console.error(`packaging: ${message}`)
  process.exit(1)
}
console.log('packaging test passed')
