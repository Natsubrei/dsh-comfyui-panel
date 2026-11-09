/**
 * Headless check for the ComfyUI panel: open the GUI in a real browser, put the
 * panel in a throwaway session, and assert the behaviour that is easy to break
 * without noticing — the editor boots, counters match the graph, zooming does
 * not look like an edit, a real edit bumps the revision once, and the graph is
 * framed when the editor loads.
 *
 * It runs against a live `dsh web` and needs no test-only routes: everything is
 * read from the panel's own DOM (`data-nodes`, `data-revision`, …) and from the
 * embedded editor's public objects. It uses a blank draft — created when none is
 * open — so a run never touches a conversation that has content.
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

/** Shell and panel elements the check needs. All are stable, locale-free hooks. */
export const DOM = {
  panel: '.dsh-comfyui-panel',
  hero: '[data-slot^="conversation.hero"]',
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
 * Poll an expression until it answers with a point.
 *
 * `Browser.waitFor` turns any object into `true` on purpose: a live object
 * cannot cross the DevTools protocol. A freshly built `{ x, y }` can, and the
 * click needs the numbers, so coordinate waits go through here instead.
 * @param browser - the driver.
 * @param expression - an expression evaluating to `{x, y}`, or null while there is nothing to click.
 * @param options - `label` for the timeout message, `timeout` in milliseconds.
 * @returns the point that was found.
 */
async function waitForPoint(browser, expression, { label, timeout = 15_000 }) {
  const deadline = Date.now() + timeout
  for (;;) {
    const point = await browser.evaluate(expression)
    if (point !== null && point !== undefined) return point
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeout)} ms waiting for ${label}`)
    await sleep(150)
  }
}

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

/** The plugin's own service route, relative to the GUI origin. */
const SERVICE_ROUTE = '/api/comfyui/service'

/**
 * Ask the plugin's service route whether ComfyUI answers, before the browser
 * starts waiting for an editor that cannot boot. A stopped server leaves the
 * iframe on a plain error page, so the editor wait would only delay the cause.
 * @param {string} url - any URL on the GUI's origin.
 * @param {{name: string, value: string}} cookie - the session cookie already parsed.
 * @returns {Promise<{state: string, health: boolean, lastError: string | null} | {error: string}>} the service report, or why it could not be read.
 */
async function readServiceHealth(url, cookie) {
  try {
    const response = await fetch(new URL(SERVICE_ROUTE, url), {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    if (!response.ok) return { error: `HTTP ${String(response.status)}` }
    const body = await response.json()
    return {
      state: typeof body?.state === 'string' ? body.state : 'unknown',
      health: body?.health === true,
      lastError: typeof body?.lastError === 'string' && body.lastError.trim() !== ''
        ? body.lastError.replace(/\s+/gu, ' ').trim()
        : null,
    }
  } catch (error) {
    return { error: `could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Read the service report from the page itself, where the session cookie is
 * already installed. Used only when the editor fails to boot.
 * @param {Browser} browser - driver attached to the GUI page.
 * @returns {Promise<string | null>} one line describing the service, or null when unreadable.
 */
async function readServiceLine(browser) {
  const line = await browser.evaluate(`(async () => {
    try {
      const response = await fetch('${SERVICE_ROUTE}')
      if (!response.ok) return 'HTTP ' + String(response.status)
      const service = await response.json()
      const state = typeof service?.state === 'string' ? service.state : 'unknown'
      const health = service?.health === true ? 'health true' : 'health false'
      const lastError = typeof service?.lastError === 'string' && service.lastError.trim() !== ''
        ? '; last error: ' + service.lastError.replace(/\\s+/gu, ' ').trim()
        : ''
      return state + ' (' + health + lastError + ')'
    } catch (error) {
      return 'unreadable: ' + (error instanceof Error ? error.message : String(error))
    }
  })()`, { awaitPromise: true }).catch(() => null)
  return typeof line === 'string' ? line : null
}

/**
 * What the embedded iframe shows right now. The frame may be mid-navigation or
 * on a foreign origin, so every read is guarded inside the page.
 * @param {Browser} browser - driver attached to the GUI page.
 * @returns {Promise<{href: string | null, text: string | null}>} the frame's address and visible text.
 */
async function readFrameState(browser) {
  return await browser.evaluate(`(() => {
    const frame = document.querySelector('${DOM.frame}')
    if (frame === null) return { href: null, text: null }
    try {
      const href = frame.contentWindow?.location?.href ?? null
      const body = frame.contentDocument?.body
      const text = ((body?.innerText ?? body?.textContent ?? '').replace(/\\s+/gu, ' ').trim()).slice(0, 300)
      return { href, text: text === '' ? null : text }
    } catch {
      return { href: null, text: null }
    }
  })()`)
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
    // The GUI reuses a blank draft that is already open instead of creating a
    // session, so clicking "New session" can leave the id alone. A conversation
    // rendered in its empty state — the hero slots, no turns — is that draft:
    // it carries a real id and nothing to disturb, so it serves as the scratch
    // session. Let the shell restore a real conversation's turns before asking.
    await sleep(1500)
    const blank = await browser.evaluate(`document.querySelector('${DOM.hero}') !== null`)
    if (blank === true) {
      console.error('panel check: using the blank draft the GUI already had open')
    } else {
      // A click on "New session" may reopen the blank draft the GUI was already
      // showing; a second click starts a fresh one. Never proceed in a session
      // that might hold someone's conversation.
      let opened = false
      for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
        await clickButtonText(browser, /^(new session|新建会话)$/iu, 'New session')
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
  }
  const sessionId = await browser.attribute(DOM.session, 'data-conversation-session')
  if (await browser.evaluate(`document.querySelector('${DOM.panel}') !== null`)) {
    return { sessionId, bootMs: 0 }
  }
  // The page is a left-sidebar panel. The button's accessible name is the
  // title, in every locale, including when the column is collapsed to icons.
  const entry = await waitForPoint(browser, `(() => {
    const found = document.querySelector('button[aria-label=${JSON.stringify(TAB_TITLE)}]')
    if (!found) return null
    const rect = found.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`, { label: `the ${TAB_TITLE} sidebar button`, timeout: 15_000 })
  const clickedEntry = await browser.evaluate(`(() => {
    const found = document.querySelector('button[aria-label=${JSON.stringify(TAB_TITLE)}]')
    if (!found) return false
    found.click()
    return true
  })()`)
  if (clickedEntry !== true) throw new Error(`could not click the ${TAB_TITLE} sidebar button at ${String(entry.x)},${String(entry.y)}`)
  await browser.waitFor(`document.querySelector('${DOM.panel}') !== null`, { label: 'the ComfyUI panel', timeout: 15_000 })
  const started = Date.now()
  try {
    await browser.waitFor(`(() => { const app = ${APP}; return app !== null })()`, { label: 'the ComfyUI editor API', timeout })
  } catch (error) {
    // The timeout alone says nothing about why: the iframe usually shows the
    // answer (an unreachable upstream, a 404, a crash page). Read it while the
    // browser is still open, and the service route while the Host can answer.
    const frame = await readFrameState(browser).catch(() => ({ href: null, text: null }))
    const service = await readServiceLine(browser)
    const shown = frame.text === null ? 'no readable text' : JSON.stringify(frame.text)
    const suffix = service === null ? '' : `; ${SERVICE_ROUTE} reports ${service}`
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; `
      + `the iframe at ${frame.href ?? '(no address)'} shows ${shown}${suffix}`,
    )
  }
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
 * @param {string} [options.sessionId] - the session the panel is open in, for Host-side assertions.
 * @param {number} [options.errorsSince] - console index to start counting from.
 * @param {number} [options.exceptionsSince] - exception index to start counting from.
 * @returns {Promise<{results: Array<{name: string, ok: boolean, detail: string}>, shots: string[]}>} outcome.
 */
export async function runChecks(browser, { out, bootMs = 0, errorsSince = 0, exceptionsSince = 0, sessionId = null }) {
  mkdirSync(out, { recursive: true })
  /** @type {Array<{layer: string, name: string, ok: boolean, detail: string}>} */
  const results = []
  /** @type {string[]} */
  const shots = []
  let layer = 'page'
  const record = (name, ok, detail = '') => { results.push({ layer, name, ok, detail }) }
  const shoot = async name => {
    const path = join(out, name)
    await browser.screenshot(path)
    shots.push(path)
    return path
  }

  await shoot('01-panel.png')
  record('panel mounts in the sidebar', true, 'ComfyUI tab rendered')

  // Page: the column, and the tab that brings it back. These do not touch the graph.
  const dockOpen = await browser.evaluate(`(() => {
    const aside = document.querySelector('.dsh-comfyui-dock:not(.is-closed)')
    const composer = document.querySelector('.dsh-comfyui-dock-input')
    return aside !== null && composer !== null
  })()`)
  record('the right column is open', dockOpen === true, dockOpen === true ? '' : 'the composer is not in the page')

  // The empty field and the send button share one line. A content-box height
  // plus padding makes the field taller than the button and parks the text
  // above it, while both elements still look centred in a screenshot.
  const composer = await browser.evaluate(`(() => {
    const field = document.querySelector('.dsh-comfyui-dock-input')
    const send = document.querySelector('.dsh-comfyui-send')
    if (field === null || send === null) return null
    const line = field.getBoundingClientRect()
    const button = send.getBoundingClientRect()
    return {
      empty: field.value === '',
      top: Math.abs(line.top - button.top),
      height: Math.abs(line.height - button.height),
    }
  })()`)
  record('the empty composer centres the field on the button',
    composer !== null && composer.empty === true && composer.top <= 1 && composer.height <= 1,
    composer === null ? 'no composer'
      : !composer.empty ? 'the field was not empty'
        : `${composer.top.toFixed(1)} px apart, ${composer.height.toFixed(1)} px taller`)

  await browser.click('.dsh-comfyui-dock-toggle')
  await sleep(300)
  const tab = await browser.evaluate(`(() => {
    const button = document.querySelector('.dsh-comfyui-dock.is-closed .dsh-comfyui-dock-toggle')
    if (button === null) return null
    const rect = button.getBoundingClientRect()
    const stage = document.querySelector('.dsh-comfyui-stage')
    return {
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height,
      text: (button.textContent ?? '').trim(),
      // The glass has to sample the canvas. A backdrop-filter left on the
      // zero-width dock makes the tab paint the dock's own dark layer while
      // its background-color still reads as the glass.
      filter: getComputedStyle(button.closest('.dsh-comfyui-dock')).backdropFilter,
      bg: getComputedStyle(button).backgroundColor,
      canvas: stage === null ? '' : getComputedStyle(stage).backgroundColor,
    }
  })()`)
  record('collapsing leaves a reopen tab',
    tab !== null && tab.w >= 16 && tab.h >= 48 && tab.text.length > 0,
    tab === null ? 'no tab' : `${tab.text} ${String(Math.round(tab.w))}×${String(Math.round(tab.h))}`)
  record('the reopen tab is glass, not the canvas',
    tab !== null && tab.filter === 'none' && tab.bg !== '' && tab.bg !== tab.canvas,
    tab === null ? 'no tab' : `filter ${tab.filter}; tab ${tab.bg}; canvas ${tab.canvas}`)
  if (tab !== null) {
    await browser.move(tab.x, tab.y)
    await sleep(200)
    const hovered = await browser.evaluate(`(() => {
      const button = document.querySelector('.dsh-comfyui-dock.is-closed .dsh-comfyui-dock-toggle')
      if (button === null) return null
      const rect = button.getBoundingClientRect()
      const bg = getComputedStyle(button).backgroundColor
      return { w: rect.width, h: rect.height, bg }
    })()`)
    const opaque = hovered !== null && hovered.bg !== 'transparent' && !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/u.test(hovered.bg)
    record('the reopen tab stays visible on hover',
      hovered !== null && hovered.w >= 16 && hovered.h >= 48 && opaque,
      hovered === null ? 'the tab disappeared' : hovered.bg)
    await shoot('02-collapsed.png')
    await browser.clickAt(tab.x, tab.y)
    await sleep(300)
  }
  const reopened = await browser.evaluate(`document.querySelector('.dsh-comfyui-dock:not(.is-closed) .dsh-comfyui-dock-input') !== null`)
  record('the tab opens the column', reopened === true, '')

  // The toolbar must not sit in a ComfyUI corner, and Settings must open as a
  // sheet attached to it rather than take a row from the canvas.
  const geometry = await browser.evaluate(`(() => {
    const bar = document.querySelector('.dsh-comfyui-bar')
    const stage = document.querySelector('.dsh-comfyui-stage')
    if (bar === null || stage === null) return null
    const pill = bar.getBoundingClientRect()
    const canvas = stage.getBoundingClientRect()
    return { dx: Math.abs((pill.x + pill.width / 2) - (canvas.x + canvas.width / 2)), stage: canvas.height }
  })()`)
  record('the toolbar sits in the bottom centre', geometry !== null && geometry.dx <= 8,
    geometry === null ? 'no bar' : `${(geometry.dx).toFixed(0)} px off centre`)

  // Three buttons, no more, and no click needed to reach them.
  const buttons = await browser.evaluate(`(() => {
    const bar = document.querySelector('.dsh-comfyui-bar')
    if (bar === null) return null
    return [...bar.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled }))
  })()`)
  record('the toolbar offers the same three buttons',
    Array.isArray(buttons) && buttons.length === 3
      && buttons[0].text === 'Start' && buttons[0].disabled === true
      && buttons[1].text === 'Stop' && buttons[1].disabled === false
      && buttons[2].text === 'Settings' && buttons[2].disabled === false,
    Array.isArray(buttons) ? buttons.map(button => `${button.text}${button.disabled ? ' (off)' : ''}`).join(' · ') : 'no bar')
  await shoot('01c-toolbar.png')

  await browser.click('[data-tool="server"]')
  await sleep(250)
  const sheet = await browser.evaluate(`(() => {
    const card = document.querySelector('.dsh-comfyui-sheet')
    const stage = document.querySelector('.dsh-comfyui-stage')
    if (card === null || stage === null) return null
    const box = card.getBoundingClientRect()
    return { w: box.width, h: box.height, stage: stage.getBoundingClientRect().height }
  })()`)
  await shoot('01b-settings.png')
  record('settings opens as a sheet over the canvas',
    sheet !== null && sheet.w > 200 && Math.abs(sheet.stage - (geometry?.stage ?? 0)) < 1,
    sheet === null ? 'no sheet' : `${(sheet.w).toFixed(0)}×${(sheet.h).toFixed(0)}, canvas ${(sheet.stage).toFixed(0)}`)
  await browser.click('.dsh-comfyui-sheet-head .dsh-comfyui-icon')
  await sleep(200)
  const sheetGone = await browser.evaluate(`document.querySelector('.dsh-comfyui-sheet') === null`)
  record('the sheet closes', sheetGone === true, '')

  layer = 'editor'
  const editor = await browser.waitFor(`(() => { const app = ${APP}; return app ? true : null })()`, {
    label: 'the editor', timeout: 5_000,
  }).catch(() => false)
  record('editor boots', editor === true, bootMs > 0 ? `${(bootMs / 1000).toFixed(1)} s to the editor API` : '')
  if (editor !== true) return { results, shots }

  // The panel frames the graph itself on load; the Fit button is gone, so
  // this is the only place the framing can be observed.
  const framing = `(() => {
    const graph = ${GRAPH}
    const app = ${APP}
    const view = app?.canvasInternal ?? app?.canvas
    if (!graph || !view || !view.ds) return null
    const ds = view.ds
    const element = view.canvas ?? view.canvasEl
    if (!element || typeof element.getBoundingClientRect !== 'function') return null
    const box = element.getBoundingClientRect()
    if (box.width < 40 || box.height < 40) return null
    const project = (x, y) => typeof ds.convertOffsetToCanvas === 'function'
      ? ds.convertOffsetToCanvas([x, y])
      : [(x + ds.offset[0]) * ds.scale, (y + ds.offset[1]) * ds.scale]
    const nodes = graph._nodes ?? []
    if (nodes.length === 0) return { scale: ds.scale, inside: false, nodes: 0 }
    const inside = nodes.every(node => {
      const [left, top] = project(node.pos[0], node.pos[1])
      const [right, bottom] = project(node.pos[0] + node.size[0], node.pos[1] + node.size[1])
      return left >= -1 && top >= -1 && right <= box.width + 1 && bottom <= box.height + 1
    })
    return { scale: ds.scale, inside, nodes: nodes.length }
  })()`
  await browser.waitFor(framing, { label: 'the camera', timeout: 5_000 }).catch(() => null)
  const framed = await browser.evaluate(framing).catch(() => null)
  record('the panel frames the graph on load',
    framed !== null && framed.inside === true && framed.nodes > 0,
    framed === null ? 'no camera' : `${framed.nodes} nodes, scale ${Number(framed.scale).toFixed(3)}, ${framed.inside ? 'inside' : 'outside'} the canvas`)

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

  // The canvas belongs to the desk session, not to the conversation this check
  // started in. Every state query below must use the id the page actually syncs.
  const deskSessionId = await browser.evaluate(`(async () => {
    const response = await fetch('/api/comfyui/desk')
    const body = await response.json().catch(() => null)
    return body?.ok === true && typeof body.sessionId === 'string' ? body.sessionId : null
  })()`, { awaitPromise: true })
  let graph = await readGraph(browser)
  const synced = await browser.waitFor(`Number(document.querySelector('${DOM.stats}')?.getAttribute('data-synced') ?? 0) > 0`, {
    label: 'the first accepted sync', timeout: 20_000,
  }).catch(() => false)
  record('workflow reaches the host', synced === true, synced === true ? 'state POST accepted' : 'data-synced stayed 0')

  // A run is addressed to the socket id the panel last reported. Without it,
  // the Host queues under an id no socket owns: the image lands on disk and
  // the editor stays blank. The summary the model reads must say so, and this
  // is the only check that sees the id the browser actually sent.
  const stateSessionId = typeof deskSessionId === 'string' ? deskSessionId : sessionId
  const identity = stateSessionId === null ? 'no session id' : await (async () => {
    const deadline = Date.now() + 10_000
    let answer = 'unqueried'
    for (;;) {
      answer = await browser.evaluate(`(async () => {
        const response = await fetch('/api/comfyui/state?sessionId=' + encodeURIComponent(${JSON.stringify(stateSessionId)}))
        if (!response.ok) return 'HTTP ' + String(response.status)
        const body = await response.json()
        if (body.found !== true) return 'no record'
        return body.clientIdKnown === true ? 'known' : (body.clientIdKnown === false ? 'missing' : 'field absent')
      })()`, { awaitPromise: true })
      if (answer === 'known' || Date.now() > deadline) return answer
      await sleep(250)
    }
  })()
  record('panel reports the editor client id', identity === 'known', identity === 'known' ? '' : identity)

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

  // The tab list is page state the Host cannot derive from the graph. The bar
  // carries its size, so a panel that stops reporting tabs shows up here
  // rather than only in a status read.
  const tabsCheck = await browser.evaluate(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const win = document.querySelector('${DOM.frame}')?.contentWindow
    const app = win?.comfyAPI?.app?.app
    const manager = app?.extensionManager?.workflow
    const bar = document.querySelector('${DOM.stats}')
    if (!manager || !bar) return { ok: false, why: 'no workflow store' }
    const list = () => {
      const value = manager.openWorkflows
      return Array.isArray(value) ? value : (value?.value ?? [])
    }
    const shown = () => Number(bar.getAttribute('data-tabs'))
    const waitFor = async wanted => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (shown() === wanted) return true
        await sleep(250)
      }
      return false
    }
    const open = list().length
    if (shown() !== open) return { ok: false, why: 'the bar shows ' + String(shown()) + ' of ' + String(open) + ' tabs' }
    const probe = manager.createNewTemporary()
    await manager.openWorkflow(probe)
    const grew = await waitFor(open + 1)
    await manager.closeWorkflow(probe)
    const shrank = await waitFor(open)
    if (!grew) return { ok: false, why: 'the bar missed the new tab' }
    if (!shrank) return { ok: false, why: 'the bar kept the closed tab' }
    return { ok: true, why: String(open) + ' tab(s)' }
  })()`, { awaitPromise: true })
  record('the bar reports the editor tabs', tabsCheck.ok === true, tabsCheck.why ?? '')
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

  // The panel reads execution events from the editor's own event bus, not from
  // a socket of its own, and nothing else exercises that relay: a real run
  // needs a prompt and a GPU. Dispatching on the editor's api is exactly what
  // its socket handler does with a message from ComfyUI.
  const dispatched = await browser.evaluate(`(() => {
    const win = document.querySelector('${DOM.frame}')?.contentWindow
    const api = win?.comfyAPI?.app?.app?.api
    if (typeof api?.dispatchCustomEvent !== 'function') return false
    api.dispatchCustomEvent('progress', { prompt_id: 'ui-check-probe', node: '1', value: 3, max: 7 })
    return true
  })()`)
  await sleep(700)
  const runText = await browser.evaluate(`document.querySelector('.dsh-comfyui-run')?.textContent ?? ''`)
  record('editor events reach the bar', dispatched && runText.includes('3/7'),
    runText === '' ? 'the bar never showed the dispatched run' : runText)

  // Preview, per-node progress, and Cancel are panel-local: they never reach
  // the Host, so the browser is the only place they can be proved. Dispatch
  // the same bus events the editor's socket handler would.
  const previewDispatched = await browser.evaluate(`(() => {
    const win = document.querySelector('${DOM.frame}')?.contentWindow
    const api = win?.comfyAPI?.app?.app?.api
    if (typeof api?.dispatchCustomEvent !== 'function') return false
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
    api.dispatchCustomEvent('b_preview', new Blob([bytes], { type: 'image/png' }))
    return true
  })()`)
  await sleep(500)
  const previewSrc = await browser.evaluate(`(() => {
    const img = document.querySelector('.dsh-comfyui-preview')
    return img === null ? null : (img.getAttribute('src') ?? '')
  })()`)
  record('preview reaches the bar', previewDispatched === true && typeof previewSrc === 'string' && previewSrc.startsWith('blob:'),
    previewSrc === null ? 'no thumbnail appeared' : String(previewSrc).slice(0, 24))

  await browser.evaluate(`(() => {
    const win = document.querySelector('${DOM.frame}')?.contentWindow
    const api = win?.comfyAPI?.app?.app?.api
    if (typeof api?.dispatchCustomEvent !== 'function') return false
    api.dispatchCustomEvent('progress_state', { prompt_id: 'ui-check-probe', nodes: { 9: { value: 4, max: 8, state: 'running' } } })
    return true
  })()`)
  await sleep(400)
  const nodeText = await browser.evaluate(`document.querySelector('.dsh-comfyui-run')?.textContent ?? ''`)
  record('per-node progress reaches the bar', nodeText.includes('4/8') && nodeText.includes('9'), nodeText)

  const cancelReady = await browser.evaluate(`(() => {
    const win = document.querySelector('${DOM.frame}')?.contentWindow
    const api = win?.comfyAPI?.app?.app?.api
    if (typeof api?.dispatchCustomEvent !== 'function') return false
    window.__dshUiCheckFetch = window.fetch
    window.fetch = (input, init) => String(input).includes('/interrupt')
      ? Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      : window.__dshUiCheckFetch(input, init)
    api.dispatchCustomEvent('execution_start', { prompt_id: 'ui-check-cancel' })
    return true
  })()`)
  await sleep(400)
  const cancelLabelBefore = await browser.evaluate(`(() => {
    const button = document.querySelector('[data-action="cancel"]')
    return button === null ? null : button.textContent
  })()`)
  await browser.evaluate(`document.querySelector('[data-action="cancel"]')?.click()`)
  await sleep(400)
  const cancelLabelBusy = await browser.evaluate(`document.querySelector('[data-action="cancel"]')?.textContent ?? ''`)
  // The fallback timer is 10 s; this wait proves the button re-enables even
  // though no interruption event ever arrives.
  await sleep(10_500)
  const cancelLabelAfter = await browser.evaluate(`(() => {
    const button = document.querySelector('[data-action="cancel"]')
    return button === null ? null : { text: button.textContent, disabled: button.disabled }
  })()`)
  record('Cancel shows progress and recovers',
    cancelReady === true && cancelLabelBefore !== null && cancelLabelBusy.includes('…') && cancelLabelAfter?.text === 'Cancel' && cancelLabelAfter?.disabled === false,
    cancelLabelAfter === null ? 'the Cancel button disappeared' : `${String(cancelLabelBefore)} → ${String(cancelLabelBusy)} → ${String(cancelLabelAfter.text)}`)

  layer = 'desk'
  record('the page owns one desk session', typeof deskSessionId === 'string' && deskSessionId.length > 0,
    typeof deskSessionId === 'string' ? deskSessionId : 'no session id')
  const transcript = await browser.evaluate(`(async () => {
    const response = await fetch('/api/comfyui/desk/transcript')
    const body = await response.json().catch(() => null)
    return JSON.stringify({ status: response.status, ok: body?.ok === true, rows: Array.isArray(body?.rows), sessionId: body?.sessionId ?? null })
  })()`, { awaitPromise: true })
  const transcriptFacts = JSON.parse(transcript)
  record('the column reads the transcript',
    transcriptFacts.status === 200 && transcriptFacts.ok && transcriptFacts.rows,
    `status ${String(transcriptFacts.status)}`)

  // Last, because it points the page at a new session and remounts the editor.
  await browser.click('.dsh-comfyui-dock-new')
  let replaced = ''
  {
    const deadline = Date.now() + 15_000
    for (;;) {
      const id = await browser.evaluate(`(async () => {
        const response = await fetch('/api/comfyui/desk')
        const body = await response.json().catch(() => null)
        return typeof body?.sessionId === 'string' ? body.sessionId : ''
      })()`, { awaitPromise: true })
      if (typeof id === 'string' && id.length > 0 && id !== deskSessionId) { replaced = id; break }
      if (Date.now() > deadline) break
      await sleep(250)
    }
  }
  const composerBack = await browser.evaluate(`document.querySelector('.dsh-comfyui-dock-input') !== null`)
  record('New starts another session', replaced.length > 0 && composerBack === true,
    replaced.length > 0 ? replaced : 'the page kept the same session')

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
 * @param {Array<{layer?: string, name: string, ok: boolean, detail: string}>} results - outcomes.
 * @param {object} meta - run metadata.
 * @param {string} meta.sessionId - session the panel ran in.
 * @param {number} meta.width - viewport width.
 * @param {number} meta.height - viewport height.
 * @param {string[]} meta.shots - screenshot files.
 * @returns {string} the report.
 */
export function formatReport(results, { sessionId, width, height, shots }) {
  const lines = [`ComfyUI panel check · session ${sessionId ?? '(unknown)'} · ${String(width)}×${String(height)}`]
  let current = ''
  for (const result of results) {
    const group = result.layer ?? 'page'
    if (group !== current) {
      current = group
      lines.push(`── ${group}`)
    }
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
 * @returns {{url: string | undefined, cookie: string | undefined, out: string, chrome: string | undefined, width: number, height: number, scratch: boolean, help?: boolean}} options.
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
  // A stopped ComfyUI never boots the editor, and its iframe error page is
  // invisible to the driver. Ask the plugin's own view of the upstream before
  // launching a browser for a page that cannot get there: the answer costs a
  // second, while the browser and its 90 s editor budget cost a minute.
  const service = await readServiceHealth(url, cookie)
  if ('error' in service || !service.health) {
    const state = 'error' in service ? 'unknown' : service.state
    const detail = 'error' in service
      ? ` (${service.error})`
      : (service.lastError === null ? '' : `, last error: ${service.lastError}`)
    console.error(`ComfyUI is not reachable: ${SERVICE_ROUTE} reports state ${state}${detail}; start ComfyUI from the panel's Settings, then run this check again`)
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
      sessionId: opened.sessionId,
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
