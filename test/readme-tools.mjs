/**
 * Check that the README's model-tool list matches the tools index.js registers.
 *
 * A tool can be added without a word in the README, which is how the tab tools
 * once shipped while the list still named the old count and set. Both sides are
 * derived — the tool definitions in `index.js`, the backticked `comfyui_…`
 * names anywhere in `README.md` — so neither list is duplicated here.
 *
 * Part of `npm test`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every name captured by a pattern's first group in one file.
 * @param {string} file - repo-relative file to read.
 * @param {RegExp} pattern - global pattern with the name in group 1.
 * @returns {Set<string>} the names found.
 */
function namesIn(file, pattern) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  return new Set([...text.matchAll(pattern)].map(match => match[1]))
}

const registered = namesIn('index.js', /\bname:\s*'(comfyui_[a-z0-9_]+)'/gu)
const documented = namesIn('README.md', /`(comfyui_[a-z0-9_]+)`/gu)

const missing = [...registered].filter(name => !documented.has(name)).sort()
const stale = [...documented].filter(name => !registered.has(name)).sort()

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error(`readme tools: README does not mention ${missing.join(', ')}`)
  }
  if (stale.length > 0) {
    console.error(`readme tools: README mentions ${stale.join(', ')}, which index.js does not register`)
  }
  process.exit(1)
}
console.log('readme tools test passed')
