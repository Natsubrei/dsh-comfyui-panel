/**
 * Headless check for the ComfyUI panel: open the GUI in a real browser, put the
 * panel in a throwaway session, and assert the behaviour that is easy to break
 * without noticing — the editor boots, counters match the graph, zooming does
 * not look like an edit, a real edit bumps the revision once, and Fit frames
 * the graph.
 *
 * It runs against a live `dsh web` and needs no test-only routes: everything is
 * read from the panel's own DOM (`data-nodes`, `data-revision`, …) and from the
 * embedded editor's public objects. The session it creates is a new draft, so a
 * run never touches a conversation you care about.
 *
 * Usage:
 *   node test/ui/panel.mjs --url 'http://127.0.0.1:3080/?token=…'
 *   DSH_WEB_COOKIE='dsh-auth-…=v1.…' node test/ui/panel.mjs
 *
 * `--url` is the address `dsh web` prints on start; its token is exchanged for
 * the same signed cookie the browser would get. When that URL is gone, paste
 * the cookie from the browser's devtools instead. See test/ui/README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Browser, sleep } from './browser.mjs'

/** Panel elements the check needs. All are stable, locale-free hooks. */
export const DOM = {
  panel: '.dsh-comfyui-panel',
  frame: '.dsh-comfyui-frame',
  stats: '.dsh-comfyui-stats',
  expand: '[data-sidebar-right-expand]',
  session: '[data-conversation-session]',
  guide: '[data-sidebar-right-guide-entry]',
  tab: '[data-dockkit-tab]',
}

/** Answers the app's brand name, which is the same in every locale. */
const TAB_TITLE = 'ComfyUI'

/**
 * JavaScript that resolves to the embedded editor's `app`, or `null` while the
 * ComfyUI frontend is still booting.
 */
const APP = `(() => {
  const frame = document.querySelector('${DOM.frame}')
  const app = frame?.contentWindow?.comfyAPI?.app?.app
  return app && app.rootGraphRef && app.rootGraphRef.value ? app : null
})()`

/**
 * JavaScript that resolves to the live root graph, or `null`.
 */
const GRAPH = `(() => {
  const frame = document.querySelector('${DOM.frame}')
  return frame?.contentWindow?.comfyAPI?.app?.app?.rootGraphRef?.value ?? null
})()`

/**
 * Exchange a printed `dsh web` launch URL for the cookie a browser would keep.
 * The token is a per-process secret, so exchanging it again is expected.
 * @param {string} url - launch URL carrying `?token=…`.
 * @returns {Promise<string>} `name=value` for the `Cookie` header.
 */
export async function cookieFromLaunchUrl(url) {
  // `dsh web` prints the only URL that carries the per-process token; the bare
  // address in DSH_WEB_URL is the one without it, and it always answers 401.
  if (!new URL(url).searchParams.has('token')) {
    throw new Error(
      `${url} carries no ?token=…, so it cannot authenticate; `
      + 'use the address dsh web printed on start, or pass --cookie',
    )
  }
  const response = await fetch(url, { redirect: 'manual' })
  const header = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  if (response.status !== 303 || header === undefined || header === null) {
    throw new Error(
      `${url} answered HTTP ${String(response.status)} without a session cookie; `
      + 'pass the full address printed by dsh web, or use --cookie',
    )
  }
  const pair = header.split(';', 1)[0]
  if (pair === undefined || !pair.includes('=')) throw new Error('the launch URL returned no usable cookie')
  return pair
}

/**
 * Split a `Cookie` header-style string into name and value.
 * @param {string} pair - `name=value`.
 * @returns {{name: string, value: string}} parsed cookie.
 */
export function parseCookiePair(pair) {
  const at = pair.indexOf('=')
  if (at <= 0) throw new Error('--cookie must be name=value')
  return { name: pair.slice(0, at), value: pair.slice(at + 1) }
}

/**
 * Click the button whose visible text is exactly the given label.
 * @param {Browser} browser - driver.
 * @param {RegExp} pattern - text pattern for the button label.
 * @param {string} label - what is being clicked, for errors.
 * @returns {Promise<void>} resolves after the click.
 */
async function clickButtonText(browser, pattern, label) {
  const point = await browser.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(candidate =>
      ${pattern}.test(candidate.textContent.trim()))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
  if (point === null) throw new Error(`could not find the ${label} button`)
  await browser.clickAt(point.x, point.y)
}

/**
 * Open the ComfyUI tab and wait until the embedded editor is usable.
 * @param {Browser} browser - driver attached to an authenticated GUI page.
 * @param {object} [options] - opening options.
 * @param {number} [options.timeout] - editor boot budget in milliseconds.
 * @param {boolean} [options.scratch] - start a new draft session first, so no real conversation is touched.
 * @returns {Promise<{sessionId: string | null, bootMs: number}>} what was opened.
 */
export async function openPanel(browser, { timeout = 90_000, scratch = true } = {}) {
  // Wait for the shell to settle on a session before recording which one it
  // is: comparing against a not-yet-rendered `null` would let a "new session"
  // click that never happened pass as a fresh draft.
  await browser.waitFor(`document.querySelector('${DOM.session}') !== null`, {
    label: 'the DSH shell to open a session', timeout: 60_000,
  })
  const before = await browser.evaluate(`document.querySelector('${DOM.session}')?.getAttribute('data-conversation-session') ?? null`)
  if (scratch) {
    // A click on "New session" may reopen the blank draft the GUI was already
    // showing; a second click always starts a fresh one. Never proceed in a
    // session that might hold someone's conversation.
    let opened = false
    for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
      await clickButtonText(browser, '/^(new session|新建会话)$/i', 'New session')
      opened = await browser.waitFor(
        `(() => {
          const id = document.querySelector('${DOM.session}')?.getAttribute('data-conversation-session') ?? null
          return id !== null && id !== ${JSON.stringify(before)} ? id : null
        })()`,
        { label: 'the new draft session', timeout: 10_000 },
      ).catch(() => false) !== false
    }
    if (!opened) throw new Error('could not start a scratch session; pass --reuse-session to run in the current one')
  }
  const sessionId = await browser.attribute(DOM.session, 'data-conversation-session')
  if (await browser.evaluate(`document.querySelector('${DOM.panel}') !== null`)) {
    return { sessionId, bootMs: 0 }
  }
  // The panel is a sidebar tab. With no tab open the sidebar shows guide
  // entries, and ours is one of them; that entry is the only stable,
  // locale-free way in.
  if (await browser.evaluate(`document.querySelector('${DOM.expand}') !== null`)) {
    await browser.click(DOM.expand)
  }
  const entry = await browser.waitFor(`(() => {
    const found = [...document.querySelectorAll('${DOM.guide}, ${DOM.tab}')]
      .find(element => element.textContent.includes(${JSON.stringify(TAB_TITLE)}))
    if (!found) return null
    const rect = found.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`, { label: `a ${TAB_TITLE} sidebar entry`, timeout: 15_000 })
  await browser.clickAt(entry.x, entry.y)
  await browser.waitFor(`document.querySelector('${DOM.panel}') !== null`, { label: 'the ComfyUI panel', timeout: 15_000 })
  const started = Date.now()
  await browser.waitFor(`(() => { const app = ${APP}; return app !== null })()`, { label: 'the ComfyUI editor API', timeout })
  const bootMs = Date.now() - started
  await browser.waitFor(`document.querySelector('.dsh-comfyui-overlay') === null`, {
    label: 'the editor to leave its loading overlay',
    timeout: 30_000,
  })
  return { sessionId, bootMs }
}

/**
 * Read the counters the panel publishes.
 * @param {Browser} browser - driver.
 * @returns {Promise<{nodes: number, links: number, revision: number, synced: number, status: string | null}>} parsed state.
 */
export async function readPanel(browser) {
  const raw = await browser.evaluate(`(() => {
    const stats = document.querySelector('${DOM.stats}')
    const dot = document.querySelector('.dsh-comfyui-dot')
    if (stats === null) return null
    return {
      nodes: stats.getAttribute('data-nodes'),
      links: stats.getAttribute('data-links'),
      revision: stats.getAttribute('data-revision'),
      synced: stats.getAttribute('data-synced'),
      status: dot?.getAttribute('data-status') ?? null,
    }
  })()`)
  if (raw === null) throw new Error('the panel has not rendered its counters yet')
  return {
    nodes: Number(raw.nodes),
    links: Number(raw.links),
    revision: Number(raw.revision),
    synced: Number(raw.synced),
    status: raw.status,
  }
}

/**
 * Read the embedded editor's workflow and camera.
 * @param {Browser} browser - driver.
 * @returns {Promise<{nodes: number, links: number, scale: number, offset: [number, number]}>} graph state.
 */
export async function readGraph(browser) {
  return await browser.evaluate(`(() => {
    const graph = ${GRAPH}
    if (graph === null) return null
    const app = ${APP}
    const workflow = graph.serialize()
    const camera = (app.canvasInternal ?? app.canvas)?.ds ?? { scale: 0, offset: [0, 0] }
    return {
      nodes: (workflow.nodes ?? []).length,
      links: (workflow.links ?? []).length,
      scale: camera.scale,
      offset: [camera.offset?.[0] ?? 0, camera.offset?.[1] ?? 0],
    }
  })()`)
}

/**
 * Bump one numeric widget in the live graph, the gesture a user makes by
 * dragging a slider or typing a number.
 * @param {Browser} browser - driver.
 * @returns {Promise<{id: string, name: string, from: number} | null>} the edit, or `null` when no numeric widget exists.
 */
export async function bumpWidget(browser) {
  return await browser.evaluate(`(() => {
    const graph = ${GRAPH}
    if (graph === null) return null
    for (const node of graph._nodes ?? []) {
      const widgets = node.widgets ?? []
      for (const widget of widgets) {
        if (typeof widget.value !== 'number' || !Number.isFinite(widget.value)) continue
        const from = widget.value
        widget.value = from + 1
        const app = ${APP}
        app.canvasInternal?.setDirty?.(true, true)
        graph.setDirtyCanvas?.(true, true)
        return { id: String(node.id), name: String(widget.name ?? ''), from }
      }
    }
    return null
  })()`)
}

/**
 * Run the whole checklist and collect one result per assertion.
 * @param {Browser} browser - driver with the panel already open.
 * @param {object} options - check options.
 * @param {string} options.out - directory for screenshots, created when missing.
 * @param {number} [options.bootMs] - editor boot time reported by {@link openPanel}.
 * @returns {Promise<{results: Array<{name: string, ok: boolean, detail: string}>, shots: string[]}>} outcome.
 */
export async function runChecks(browser, { out, bootMs = 0, errorsSince = 0, exceptionsSince = 0 }) {
  mkdirSync(out, { recursive: true })
  /** @type {Array<{name: string, ok: boolean, detail: string}>} */
  const results = []
  /** @type {string[]} */
  const shots = []
  const record = (name, ok, detail = '') => { results.push({ name, ok, detail }) }
  const shoot = async name => {
    const path = join(out, name)
    await browser.screenshot(path)
    shots.push(path)
    return path
  }

  await shoot('01-panel.png')
  record('panel mounts in the sidebar', true, 'ComfyUI tab rendered')

  const editor = await browser.waitFor(`(() => { const app = ${APP}; return app ? true : null })()`, {
    label: 'the editor', timeout: 5_000,
  }).catch(() => false)
  record('editor boots', editor === true, bootMs > 0 ? `${(bootMs / 1000).toFixed(1)} s to the editor API` : '')
  if (editor !== true) return { results, shots }

  const panel = await browser.waitFor(`(() => {
    const stats = document.querySelector('${DOM.stats}')
    return stats?.getAttribute('data-nodes') !== null ? true : null
  })()`, { label: 'panel counters', timeout: 20_000 }).catch(() => false)
  record('bar publishes counters', panel === true, panel === true ? '' : 'data-nodes never appeared')
  if (panel !== true) return { results, shots }

  // The panel syncs on a one-second tick, so the first counters may still be
  // the empty state while the frontend finishes restoring its workflow.
  const state = await readPanel(browser)
  record('server state is known', state.status === 'ok' || state.status === 'warn', `tone ${String(state.status)}`)

  let graph = await readGraph(browser)
  const synced = await browser.waitFor(`Number(document.querySelector('${DOM.stats}')?.getAttribute('data-synced') ?? 0) > 0`, {
    label: 'the first accepted sync', timeout: 20_000,
  }).catch(() => false)
  record('workflow reaches the host', synced === true, synced === true ? 'state POST accepted' : 'data-synced stayed 0')

  // Counters must describe the graph the editor actually holds, not a stale
  // snapshot: that mismatch is what a broken projection looks like.
  const settled = await browser.waitFor(`(() => {
    const stats = document.querySelector('${DOM.stats}')
    const graph = ${GRAPH}
    if (stats === null || graph === null) return null
    const nodes = Number(stats.getAttribute('data-nodes'))
    return nodes === (graph.serialize().nodes ?? []).length ? nodes : null
  })()`, { label: 'counters to match the editor graph', timeout: 15_000 }).catch(() => null)
  graph = await readGraph(browser)
  record('counters match the editor', settled !== null, `${String(graph.nodes)} nodes, ${String(graph.links)} links`)
  if (settled === null) await shoot('02-stale-counters.png')
  else await shoot('02-ready.png')

  // Zoom is a camera gesture. If it advances the revision, every model read
  // reports an edit the user never made.
  const before = await readPanel(browser)
  const center = await browser.evaluate(`(() => {
    const rect = document.querySelector('${DOM.frame}').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
  await browser.wheel(center.x, center.y, -240)
  await sleep(2500)
  const afterZoom = await readPanel(browser)
  const zoomed = await readGraph(browser)
  const cameraMoved = zoomed.scale !== graph.scale || zoomed.offset[0] !== graph.offset[0]
  record('zooming does not count as an edit', cameraMoved && afterZoom.revision === before.revision,
    cameraMoved
      ? `rev ${String(before.revision)} → ${String(afterZoom.revision)}`
      : 'the wheel gesture did not move the camera')
  await shoot('03-zoomed.png')

  // A real edit must advance the revision by exactly one and no more.
  const edit = await bumpWidget(browser)
  if (edit === null) {
    record('a widget edit bumps the revision once', true, 'skipped: the graph has no numeric widget')
  } else {
    const bumped = await browser.waitFor(
      `Number(document.querySelector('${DOM.stats}').getAttribute('data-revision')) === ${String(afterZoom.revision + 1)}`,
      { label: 'the revision to advance by one', timeout: 10_000 },
    ).catch(() => false)
    const afterEdit = await readPanel(browser)
    record('a widget edit bumps the revision once', bumped === true,
      `${edit.name || 'widget'} on #${edit.id} ${String(edit.from)} → ${String(edit.from + 1)}, rev ${String(afterZoom.revision)} → ${String(afterEdit.revision)}`)
    await shoot('04-edited.png')
  }

  // Fit goes through ComfyUI's own command, which frames the selection when
  // one exists and the whole graph otherwise; either way the camera changes.
  if (graph.nodes === 0) {
    record('Fit frames the graph', true, 'skipped: empty graph')
  } else {
    await browser.wheel(center.x, center.y, 480)
    await sleep(500)
    const zoomedOut = await readGraph(browser)
    await browser.click('[data-tool="fit"]')
    await sleep(1200)
    const fitted = await readGraph(browser)
    record('Fit frames the graph', fitted.scale !== zoomedOut.scale,
      `scale ${zoomedOut.scale.toFixed(3)} → ${fitted.scale.toFixed(3)}`)
    await shoot('05-fitted.png')
  }

  // Only what the panel's own open/close cycle logs counts: the host and its
  // other plugins may have been complaining before this check ever started,
  // and a namespaced `[other-plugin]` error is that plugin's own report.
  const errors = [...browser.exceptions.slice(exceptionsSince), ...browser.console.slice(errorsSince)]
    .filter(message => !/favicon/i.test(message))
    .filter(message => !/^\[[^\]]+\]/u.test(message) || /^\[dsh-comfyui\]/u.test(message))
  record('no errors from the panel', errors.length === 0, errors.slice(0, 2).join(' | '))
  return { results, shots }
}

/**
 * Format results as a plain-text report.
 * @param {Array<{name: string, ok: boolean, detail: string}>} results - outcomes.
 * @param {object} meta - run metadata.
 * @param {string} meta.sessionId - session the panel ran in.
 * @param {number} meta.width - viewport width.
 * @param {number} meta.height - viewport height.
 * @param {string[]} meta.shots - screenshot files.
 * @returns {string} the report.
 */
export function formatReport(results, { sessionId, width, height, shots }) {
  const lines = [`ComfyUI panel check · session ${sessionId ?? '(unknown)'} · ${String(width)}×${String(height)}`]
  for (const result of results) {
    const detail = result.detail === '' ? '' : `  (${result.detail})`
    lines.push(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${detail}`)
  }
  const passed = results.filter(result => result.ok).length
  lines.push(`${String(passed)}/${String(results.length)} checks passed`)
  if (shots.length > 0) lines.push(`screenshots: ${shots.map(path => path.split(/[\\/]/u).slice(-2).join('/')).join(', ')}`)
  return lines.join('\n')
}

/**
 * Parse the command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{url: string | undefined, cookie: string | undefined, out: string, chrome: string | undefined, width: number, height: number, scratch: boolean}} options.
 */
export function parseArguments(argv) {
  const options = {
    url: process.env.DSH_WEB_URL,
    cookie: process.env.DSH_WEB_COOKIE,
    out: '.ui-out',
    chrome: process.env.CHROME_BIN,
    width: 1440,
    height: 900,
    scratch: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--url') { options.url = value; index += 1 } else if (argument === '--cookie') { options.cookie = value; index += 1 } else if (argument === '--out') { options.out = value; index += 1 } else if (argument === '--chrome') { options.chrome = value; index += 1 } else if (argument === '--size') {
      const match = /^(\d+)x(\d+)$/u.exec(value ?? '')
      if (match === null) throw new Error('--size must look like 1440x900')
      options.width = Number(match[1])
      options.height = Number(match[2])
      index += 1
    } else if (argument === '--reuse-session') {
      options.scratch = false
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument ${argument}`)
    }
  }
  return options
}

const USAGE = `Run the ComfyUI panel check against a live dsh web.

  node test/ui/panel.mjs --url 'http://127.0.0.1:3080/?token=…'
  node test/ui/panel.mjs --cookie 'dsh-auth-…=v1.…'

Flags
  --url URL        the address dsh web prints on start (exchanged for a cookie)
  --cookie PAIR    name=value copied from the browser's devtools instead
  --out DIR        screenshot directory (default .ui-out)
  --chrome PATH    browser binary (default CHROME_BIN, then PATH)
  --size WxH       viewport (default 1440x900)
  --reuse-session  run in the session the GUI opens instead of a new draft

Environment: DSH_WEB_URL, DSH_WEB_COOKIE, CHROME_BIN. The browser needs no
dependencies, but it must already be installed; see test/ui/README.md.`

/**
 * CLI entry point.
 * @param {string[]} argv - process arguments.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    console.error(String(error.message))
    console.error(USAGE)
    return 2
  }
  if (options.help === true) {
    console.log(USAGE)
    return 0
  }
  if (options.url === undefined && options.cookie === undefined) {
    console.error('need a launch URL or a cookie; see --help')
    return 2
  }
  const url = options.url ?? 'http://127.0.0.1:3080/'
  let cookie
  try {
    cookie = options.cookie === undefined
      ? parseCookiePair(await cookieFromLaunchUrl(url))
      : parseCookiePair(options.cookie)
  } catch (error) {
    console.error(`authentication: ${String(error.message)}`)
    return 2
  }
  let browser
  try {
    browser = await Browser.launch({ chrome: options.chrome, width: options.width, height: options.height })
  } catch (error) {
    console.error(`browser: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  try {
    await browser.setCookie({ name: cookie.name, value: cookie.value, url })
    await browser.goto(url)
    // Anything the host and its other plugins logged while booting is not this
    // check's business; only errors from here on belong to the panel.
    const errorsSince = browser.console.length
    const exceptionsSince = browser.exceptions.length
    const opened = await openPanel(browser, { scratch: options.scratch })
    const { results, shots } = await runChecks(browser, {
      out: options.out,
      bootMs: opened.bootMs,
      errorsSince,
      exceptionsSince,
    })
    const report = formatReport(results, {
      sessionId: opened.sessionId, width: options.width, height: options.height, shots,
    })
    console.log(report)
    writeFileSync(join(options.out, 'report.txt'), `${report}\n`)
    return results.every(result => result.ok) ? 0 : 1
  } catch (error) {
    console.error(`panel check failed: ${error instanceof Error ? error.message : String(error)}`)
    if (browser.console.length > 0) console.error(`page errors:\n  ${browser.console.slice(0, 5).join('\n  ')}`)
    if (browser.exceptions.length > 0) console.error(`page exceptions:\n  ${browser.exceptions.slice(0, 5).join('\n  ')}`)
    await browser.screenshot(join(options.out, 'failure.png')).catch(() => {})
    return 1
  } finally {
    await browser.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
