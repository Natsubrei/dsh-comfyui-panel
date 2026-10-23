/**
 * Minimal Chrome DevTools Protocol driver, so the panel can be checked in a
 * real browser without adding Playwright (or downloading its browsers) to a
 * plugin that otherwise has no dependencies.
 *
 * It speaks the protocol directly over the DevTools WebSocket: launch a local
 * Chromium in headless mode, attach to its page target, and offer the few
 * gestures a UI check needs — navigate, evaluate, wait, click, screenshot.
 * Anything the harness learns about DSH or ComfyUI lives in `panel.mjs`; this
 * file knows nothing about either.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const HOSTS = ['127.0.0.1', 'localhost']
const LAUNCH_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 20_000

/** Binaries to try when `CHROME_BIN` is unset, in the order most systems have them. */
const BINARIES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'microsoft-edge',
  'brave-browser',
]

/** Absolute install locations for systems that keep the binary off PATH. */
const INSTALLS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/** @param {string} path - candidate binary. @returns {boolean} whether it is executable. */
function executable(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Resolve the browser binary: `CHROME_BIN` wins, then PATH, then common
 * install locations. Playwright's downloaded builds also work through
 * `CHROME_BIN`, which is how CI-less machines can point at one.
 * @param {string | undefined} explicit - `--chrome` value.
 * @returns {string} absolute or PATH-resolved binary.
 */
export function findBrowser(explicit) {
  const wanted = explicit ?? process.env.CHROME_BIN
  if (wanted !== undefined && wanted !== '') {
    if (executable(wanted)) return wanted
    // Name the neighbours that do exist: the Playwright download names its
    // binary `chrome-linux64/chrome` or `chrome-headless-shell-linux64/
    // chrome-headless-shell`, which is easy to guess wrong from the directory.
    const nearby = INSTALLS.filter(executable)
    const hint = nearby.length > 0 ? `; found instead: ${nearby.join(', ')}` : `; known locations: ${INSTALLS.join(', ')}`
    throw new Error(`browser binary not executable: ${wanted}${hint}`)
  }
  const path = process.env.PATH ?? ''
  for (const name of BINARIES) {
    for (const directory of path.split(delimiter)) {
      if (directory === '') continue
      const candidate = join(directory, name)
      if (executable(candidate)) return candidate
    }
  }
  for (const candidate of INSTALLS) {
    if (executable(candidate)) return candidate
  }
  throw new Error(`no Chrome/Chromium found; set CHROME_BIN to a browser binary (looked on PATH and at: ${INSTALLS.join(', ')})`)
}

/** @param {number} ms - delay. @returns {Promise<void>} resolves after the delay. */
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One headless browser process and its page target.
 *
 * Commands are sent by the protocol's own `id`/`method`/`params` shape; the
 * driver tracks pending ids and rejects a command that never answers instead
 * of hanging the check forever.
 */
export class Browser {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closing = false

  /**
   * @param {string} binary - browser executable.
   * @param {object} options - launch options.
   * @param {number} options.width - initial viewport width.
   * @param {number} options.height - initial viewport height.
   * @param {string | undefined} options.profile - user-data directory; a temp one is created when omitted.
   * @param {string[]} options.args - extra browser flags.
   */
  constructor(binary, { width, height, profile, args }) {
    this.binary = binary
    this.width = width
    this.height = height
    this.profile = profile ?? mkdtempSync(join(tmpdir(), 'dsh-comfyui-ui-'))
    this.ownedProfile = profile === undefined
    this.args = args
    this.console = []
    this.exceptions = []
    this.failedRequests = []
  }

  /**
   * Launch a browser and attach a driver to its first page target.
   * @param {object} [options] - launch options.
   * @param {string} [options.chrome] - explicit binary; see {@link findBrowser}.
   * @param {number} [options.width] - viewport width, default 1440.
   * @param {number} [options.height] - viewport height, default 900.
   * @param {string} [options.profile] - reuse a user-data directory.
   * @param {string[]} [options.args] - extra browser flags.
   * @returns {Promise<Browser>} attached driver.
   */
  static async launch({ chrome, width = 1440, height = 900, profile, args = [] } = {}) {
    const browser = new Browser(findBrowser(chrome), { width, height, profile, args })
    await browser.#start()
    return browser
  }

  async #start() {
    const flags = [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profile}`,
      `--window-size=${String(this.width)},${String(this.height)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      ...this.args,
      'about:blank',
    ]
    this.process = spawn(this.binary, flags, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.stderr = ''
    this.process.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000)
    })
    this.exit = new Promise(resolve => {
      this.process.once('exit', code => { resolve(code) })
    })
    const portFile = join(this.profile, 'DevToolsActivePort')
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (!existsSync(portFile)) {
      if (this.process.exitCode !== null) {
        throw new Error(`browser exited before opening DevTools (${String(this.process.exitCode)}): ${this.stderr.trim()}`)
      }
      if (Date.now() > deadline) throw new Error(`browser did not open DevTools within ${String(LAUNCH_TIMEOUT_MS)} ms: ${this.stderr.trim()}`)
      await sleep(50)
    }
    const [port] = readFileSync(portFile, 'utf8').split('\n')
    this.port = Number(port)
    this.target = await this.#pageTarget()
    this.#socket = new WebSocket(this.target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.#socket.onopen = resolve
      this.#socket.onerror = () => { reject(new Error(`DevTools WebSocket refused on port ${String(this.port)}`)) }
    })
    this.#socket.onmessage = event => { this.#dispatch(String(event.data)) }
    this.#socket.onclose = () => {
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer)
        reject(new Error('browser connection closed'))
      }
      this.#pending.clear()
    }
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.viewport(this.width, this.height)
  }

  /** @returns {Promise<{type: string, webSocketDebuggerUrl: string}>} the page target, waiting for it to appear. */
  async #pageTarget() {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    for (;;) {
      for (const host of HOSTS) {
        try {
          const response = await fetch(`http://${host}:${String(this.port)}/json/list`)
          /** @type {Array<{type: string, webSocketDebuggerUrl: string}>} */
          const targets = await response.json()
          const page = targets.find(target => target.type === 'page')
          if (page !== undefined) return page
        } catch {
          // The HTTP endpoint starts a moment after the port file appears.
        }
      }
      if (Date.now() > deadline) throw new Error('no page target appeared in the browser')
      await sleep(50)
    }
  }

  /** @param {string} raw - one WebSocket frame. */
  #dispatch(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${String(message.error.message)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      this.console.push(message.params.args.map(argument => String(argument.value ?? argument.description ?? '')).join(' '))
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      this.exceptions.push(String(details.exception?.description ?? details.text))
    }
    if (message.method === 'Network.loadingFailed' && message.params.canceled !== true) {
      this.failedRequests.push(`${String(message.params.errorText)} ${String(message.params.requestId)}`)
    }
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params)
  }

  /**
   * Send one protocol command.
   * @param {string} method - CDP method name.
   * @param {object} [params] - method parameters.
   * @param {number} [timeout] - milliseconds before the command fails.
   * @returns {Promise<any>} the command result.
   */
  send(method, params = {}, timeout = COMMAND_TIMEOUT_MS) {
    if (this.#socket === undefined || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${method}: browser connection is not open`))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method}: no answer within ${String(timeout)} ms`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, method, timer })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Subscribe to one protocol event.
   * @param {string} method - CDP event name.
   * @param {(params: any) => void} listener - callback.
   * @returns {() => void} unsubscribe.
   */
  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? []
    listeners.push(listener)
    this.#listeners.set(method, listeners)
    return () => {
      this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter(entry => entry !== listener))
    }
  }

  /**
   * Evaluate an expression in the page and return its value.
   * @param {string} expression - JavaScript source.
   * @param {object} [options] - evaluation options.
   * @param {boolean} [options.awaitPromise] - wait for a returned promise.
   * @returns {Promise<any>} the JSON-serializable result.
   */
  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails
      throw new Error(`page threw: ${String(details.exception?.description ?? details.text)}`)
    }
    return result.result.value
  }

  /**
   * Poll an expression until it returns something truthy.
   * @param {string} expression - JavaScript source.
   * @param {object} [options] - wait options.
   * @param {number} [options.timeout] - milliseconds before failing, default 15000.
   * @param {string} [options.label] - what is being awaited, for the error.
   * @param {number} [options.interval] - poll interval, default 150.
   * @returns {Promise<any>} the first truthy value.
   */
  async waitFor(expression, { timeout = 15_000, label = expression, interval = 150 } = {}) {
    const deadline = Date.now() + timeout
    let lastError
    // Objects cannot cross CDP: `window.app && window.app.graph` fails with
    // "Object reference chain is too long", which surfaced as a bare timeout
    // instead of the condition being met. Primitives still come back as they
    // are, because callers read numbers and strings out of the first hit.
    const probe = `(() => {
      const value = ( ${expression} );
      if (value === null || value === undefined) return value;
      if (typeof value === 'object' || typeof value === 'function') return true;
      return value;
    })()`
    for (;;) {
      try {
        const value = await this.evaluate(probe)
        if (value !== null && value !== undefined && value !== false && value !== '') return value
      } catch (error) {
        lastError = error
      }
      if (Date.now() > deadline) {
        const suffix = lastError === undefined ? '' : ` (last error: ${String(lastError.message)})`
        throw new Error(`timed out after ${String(timeout)} ms waiting for ${label}${suffix}`)
      }
      await sleep(interval)
    }
  }

  /**
   * Navigate and wait for the document to finish loading.
   * @param {string} url - destination.
   * @param {object} [options] - navigation options.
   * @param {number} [options.timeout] - milliseconds before failing.
   * @returns {Promise<void>} resolves when `readyState` is `complete`.
   */
  async goto(url, { timeout = 30_000 } = {}) {
    const loaded = new Promise(resolve => {
      const off = this.on('Page.loadEventFired', () => { off(); resolve() })
    })
    await this.send('Page.navigate', { url })
    await Promise.race([loaded, sleep(timeout)]).then(() => undefined)
    await this.waitFor('document.readyState === "complete"', { timeout, label: `${url} to finish loading` })
  }

  /**
   * Set the viewport size.
   * @param {number} width - CSS pixels.
   * @param {number} height - CSS pixels.
   * @returns {Promise<void>} resolves after the override is applied.
   */
  async viewport(width, height) {
    this.width = width
    this.height = height
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    })
  }

  /**
   * Install an authenticated cookie for one origin before navigating.
   * @param {object} cookie - cookie fields.
   * @param {string} cookie.name - cookie name.
   * @param {string} cookie.value - cookie value.
   * @param {string} cookie.url - origin the cookie belongs to.
   * @returns {Promise<void>} resolves after the cookie is set.
   */
  async setCookie({ name, value, url }) {
    const result = await this.send('Network.setCookie', { name, value, url, path: '/' })
    if (result.success !== true) throw new Error(`browser refused cookie ${name}`)
  }

  /**
   * Center of an element's box, in viewport coordinates.
   * @param {string} selector - CSS selector.
   * @returns {Promise<{x: number, y: number}>} click point.
   */
  async pointOf(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (element === null) return null
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    if (point === null) throw new Error(`no visible element for ${selector}`)
    return point
  }

  /**
   * Click one element with real mouse events.
   * @param {string} selector - CSS selector.
   * @returns {Promise<void>} resolves after the release.
   */
  async click(selector) {
    const { x, y } = await this.pointOf(selector)
    await this.clickAt(x, y)
  }

  /**
   * Click at a viewport point with real mouse events.
   * @param {number} x - CSS pixels.
   * @param {number} y - CSS pixels.
   * @returns {Promise<void>} resolves after the release.
   */
  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  }

  /**
   * Turn the wheel at a viewport point, the gesture that zooms the ComfyUI canvas.
   * @param {number} x - CSS pixels.
   * @param {number} y - CSS pixels.
   * @param {number} deltaY - wheel delta; negative zooms in.
   * @returns {Promise<void>} resolves after the wheel event.
   */
  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', buttons: 0,
    })
  }

  /**
   * Save a PNG of the viewport.
   * @param {string} path - destination file.
   * @returns {Promise<void>} resolves after the file is written.
   */
  async screenshot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
  }

  /**
   * Text content of one element, or `null` when it is absent.
   * @param {string} selector - CSS selector.
   * @returns {Promise<string | null>} trimmed text.
   */
  async text(selector) {
    return await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`)
  }

  /**
   * Read one attribute of one element, or `null` when either is absent.
   * @param {string} selector - CSS selector.
   * @param {string} attribute - attribute name.
   * @returns {Promise<string | null>} attribute value.
   */
  async attribute(selector, attribute) {
    return await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(attribute)}) ?? null`,
    )
  }

  /**
   * Close the page and stop the browser process.
   * @returns {Promise<void>} resolves once the process is gone.
   */
  async close() {
    if (this.#closing) return
    this.#closing = true
    try {
      await this.send('Browser.close', {}, 3000)
    } catch {
      // The process may already be gone; the kill below is the fallback.
    }
    const exited = await Promise.race([this.exit, sleep(3000).then(() => 'timeout')])
    if (exited === 'timeout' && this.process.exitCode === null) {
      this.process.kill('SIGKILL')
      await this.exit
    }
    if (this.ownedProfile) {
      try {
        rmSync(this.profile, { recursive: true, force: true })
      } catch {
        // A leftover profile directory is harmless.
      }
    }
  }
}
