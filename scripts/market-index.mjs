/**
 * Regenerate `market/index.json`, the plugin market index this repository hosts.
 *
 * DSH reads a market index from an http(s) URL; this file is the one users add
 * in Settings → Plugins → Discover. The index pins one exact commit per
 * version, so it must be regenerated *after* the release commit exists — the
 * installed code is then whatever that commit contains, not whatever `main`
 * happens to be later.
 *
 * Usage:
 *   node scripts/market-index.mjs                 # index the current HEAD
 *   node scripts/market-index.mjs --commit <sha>  # index an earlier release
 *   node scripts/market-index.mjs --dry-run       # print instead of writing
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(ROOT, 'market/index.json')
const BRANCH = 'main'

/** Read one command's stdout. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** Parse `--name value` arguments. */
function argumentsOf(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--commit') options.commit = argv[++index]
    else if (argument === '--time') options.time = argv[++index]
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`unknown argument ${argument}`)
  }
  return options
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const repositoryUrl = packageJson.repository.url
  .replace(/^git\+/u, '')
  .replace(/\.git$/u, '')
const [owner, repository] = new URL(repositoryUrl).pathname.split('/').filter(part => part !== '')

const INDEX = {
  format: 1,
  title: {
    en: 'Natsubrei DSH plugins',
    zh: 'Natsubrei 的 DSH 插件',
  },
  description: {
    en: 'Bundles published by Natsubrei for the DeepSeek Harness.',
    zh: 'Natsubrei 为 DeepSeek Harness 发布的插件。',
  },
  metadata: {
    categories: {
      ui: { title: { en: 'Interface', zh: '界面' } },
    },
    labels: {
      comfyui: { title: { en: 'ComfyUI', zh: 'ComfyUI' } },
      'image-generation': { title: { en: 'Image generation', zh: '图像生成' } },
    },
    sortKeys: {},
  },
  plugins: [],
}

/** The one plugin this repository publishes. Static parts live here; versions are generated. */
function pluginEntry(versions) {
  return {
    name: packageJson.name,
    title: { en: 'ComfyUI Panel', zh: 'ComfyUI 面板' },
    description: {
      en: 'The real ComfyUI editor in the DSH right sidebar, with per-session workflow tools and panel-managed ComfyUI.',
      zh: '在 DSH 右侧边栏里运行真正的 ComfyUI 编辑器，按会话向模型暴露工作流工具，并可在面板中管理 ComfyUI 进程。',
    },
    icon: `https://raw.githubusercontent.com/${owner}/${repository}/${BRANCH}/icon.svg`,
    author: packageJson.author,
    homepage: packageJson.homepage,
    repository: { url: repositoryUrl },
    metadata: {
      category: 'ui',
      labels: ['comfyui', 'image-generation'],
      keywords: packageJson.keywords.filter(keyword => keyword !== 'dsh-plugin'),
    },
    versions,
  }
}

/** Numeric segment comparison, so 0.10.0 sorts above 0.9.0; a release sorts above its prereleases. */
function compareVersions(left, right) {
  const parse = (version) => {
    const [core, prerelease] = version.split('-', 2)
    const numbers = core.split('.').map(Number)
    return { numbers, prerelease: prerelease === undefined ? null : prerelease }
  }
  const [a, b] = [parse(left), parse(right)]
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

/**
 * Merge one version into the index, keeping every version already listed.
 * @param {string} commit - 40-hex release commit.
 * @param {number} time - Unix seconds.
 * @returns {Array<object>} versions, newest first.
 */
function versionsWith(commit, time) {
  const existing = (() => {
    try {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf8')).plugins?.[0]?.versions ?? []
    } catch {
      return []
    }
  })()
  const kept = existing.filter(version => version.version !== packageJson.version)
  const added = {
    version: packageJson.version,
    publishTimestamp: time,
    source: { type: 'git', url: repositoryUrl, commit },
    engines: { dsh: packageJson.engines.dsh },
  }
  return [added, ...kept].sort((left, right) => compareVersions(right.version, left.version))
}

/**
 * CLI entry point.
 * @param {string[]} argv - process arguments.
 * @returns {number} exit code.
 */
function main(argv) {
  let options
  try {
    options = argumentsOf(argv)
  } catch (error) {
    console.error(String(error.message))
    return 2
  }
  if (options.help === true) {
    console.log('usage: node scripts/market-index.mjs [--commit <sha>] [--time <unix-seconds>] [--dry-run]')
    return 0
  }
  const commit = options.commit ?? git(['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    console.error(`not a full commit SHA: ${commit}`)
    return 2
  }
  const time = options.time === undefined ? Number(git(['show', '-s', '--format=%ct', commit])) : Number(options.time)
  if (!Number.isInteger(time) || time <= 0) {
    console.error(`not a Unix timestamp in seconds: ${String(time)}`)
    return 2
  }
  const index = { ...INDEX, plugins: [pluginEntry(versionsWith(commit, time))] }
  const text = `${JSON.stringify(index, null, 2)}\n`
  if (options.dryRun === true) {
    console.log(text)
    return 0
  }
  mkdirSync(dirname(INDEX_FILE), { recursive: true })
  writeFileSync(INDEX_FILE, text)
  console.log(`market/index.json: ${packageJson.name}@${packageJson.version} at ${commit.slice(0, 7)}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
