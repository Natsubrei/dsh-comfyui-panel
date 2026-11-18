/**
 * Check that the package ships, and type-checks, everything it imports.
 *
 * `npm publish` ships only `package.json`'s `files`, and `npm run typecheck`
 * only checks `tsconfig.json`'s `include`. A module missing from either breaks
 * the consumer or hides itself from the checker while the whole suite stays
 * green. Both lists are kept by hand, so this checks them against the imports
 * the entry points actually use.
 *
 * The same files decide the plugin's detail page: a locale file names the
 * Markdown document for its language, and a document that does not ship turns
 * that page into a failed read instead of the README fallback.
 *
 * Part of `npm test`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
const included = new Set(tsconfig.include ?? [])

/**
 * Expand one `files` entry: npm accepts a `*` in the last segment, so a pattern
 * has to be read as the files it names before anything can be checked.
 * @param {string} entry - a `files` entry, repo-relative.
 * @returns {string[]} the files it names.
 */
function shippedFiles(entry) {
  const slash = entry.lastIndexOf('/')
  const dir = slash < 0 ? '.' : entry.slice(0, slash)
  const segment = entry.slice(slash + 1)
  if (!segment.includes('*')) return [entry]
  const [prefix, suffix] = segment.split('*')
  if (!existsSync(join(ROOT, dir))) return []
  const names = readdirSync(join(ROOT, dir)).filter(name => name.startsWith(prefix) && name.endsWith(suffix))
  if (names.length === 0) fail(`"files" lists ${entry}, which matches nothing`)
  return names.map(name => join(dir, name).replace(/^\.\//u, ''))
}

const shipped = new Set((pkg.files ?? []).flatMap(shippedFiles))

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

// The detail page reads `meta.detail` out of the locale file for the UI
// language, and names a document by its path in the package. A document that
// does not ship fails that page; the Host does not fall back to the README.
const locales = existsSync(join(ROOT, 'locale'))
  ? readdirSync(join(ROOT, 'locale')).filter(name => name.endsWith('.json')).sort()
  : []
if (locales.length === 0) fail('no locale/*.json: the detail page has no document for any language')
for (const name of locales) {
  const path = join('locale', name)
  let meta
  try {
    meta = JSON.parse(readFileSync(join(ROOT, path), 'utf8'))?.meta
  } catch (error) {
    fail(`${path}: ${error.message}`)
    continue
  }
  for (const field of ['title', 'description', 'detail']) {
    const value = meta?.[field]
    if (typeof value !== 'string' || value.trim() === '') fail(`${path}: meta.${field} is not a non-empty string`)
  }
  const detail = typeof meta?.detail === 'string' ? meta.detail : null
  if (detail === null) continue
  if (!existsSync(join(ROOT, detail))) fail(`${path}: meta.detail ${detail} does not exist`)
  else if (!shipped.has(detail)) fail(`${path}: meta.detail ${detail} does not ship`)
}
// Chinese is the default document, so the README a language without a locale
// file falls back to has to be the one `zh.json` names.
if (!locales.includes('zh.json')) fail('locale/zh.json is the Chinese document the package README also serves')
else {
  const defaultDetail = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))?.meta?.detail
  if (defaultDetail !== 'README.md') fail(`locale/zh.json names ${String(defaultDetail)}; the package README is README.md`)
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
