/**
 * Evaluate one expression in the live GUI and print its result.
 *
 * The browser check answers a fixed checklist; this answers a single question
 * about the running page — what a remote returned, which classes the dock has,
 * whether the editor still holds a graph — without a new throwaway script and
 * without leaving a debug global in `client.js`. It is the dry run for a new
 * assertion in `test/ui/panel.mjs`.
 *
 * Usage:
 *   node scripts/panel-eval.mjs --url 'http://127.0.0.1:3080/?token=…' 'document.title'
 *   DSH_WEB_COOKIE='dsh-auth-…=v1.…' node scripts/panel-eval.mjs --panel '…'
 *
 * See dev/panel-check.md for the address and `test/ui/README.md` for what to
 * do when there is no address or no browser.
 */
import { pathToFileURL } from 'node:url'
import { Browser } from '../test/ui/browser.mjs'
import { cookieFromLaunchUrl, DOM, openPanel, parseCookiePair } from '../test/ui/panel.mjs'

const USAGE = `Evaluate one expression in the live DSH page.

  node scripts/panel-eval.mjs --url 'http://127.0.0.1:3080/?token=…' 'expression'
  node scripts/panel-eval.mjs --cookie 'dsh-auth-…=v1.…' 'expression'

Flags
  --url URL      the address dsh web prints on start (exchanged for a cookie)
  --cookie PAIR  name=value copied from the browser's devtools instead
  --panel        mount the ComfyUI panel in a scratch session, then evaluate
  --reuse-session  with --panel, use the session the GUI has open instead; its
                 editor syncs that session's workflow, so prefer a scratch one
  --help         print this

Environment: DSH_WEB_URL, DSH_WEB_COOKIE, CHROME_BIN. The expression may return
a promise; its value is printed as JSON.`

/**
 * Read the command line.
 * @param {string[]} argv - process arguments.
 * @returns {{url?: string, cookie?: string, panel: boolean, reuse: boolean, help: boolean, expression: string}} the options.
 */
function parseArguments(argv) {
  const options = {
    url: process.env.DSH_WEB_URL,
    cookie: process.env.DSH_WEB_COOKIE,
    panel: false,
    reuse: false,
    help: false,
    expression: '',
  }
  /** @type {string[]} */
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--panel') options.panel = true
    else if (arg === '--reuse-session') options.reuse = true
    else if (arg === '--url') options.url = argv[++index]
    else if (arg === '--cookie') options.cookie = argv[++index]
    else rest.push(arg)
  }
  options.expression = rest.join(' ')
  return options
}

/**
 * CLI entry point.
 * @param {string[]} argv - process arguments.
 * @returns {Promise<number>} exit code.
 */
async function main(argv) {
  const options = parseArguments(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.expression.trim() === '') {
    console.error('need an expression to evaluate; see --help')
    return 2
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
    browser = await Browser.launch({})
  } catch (error) {
    console.error(`browser: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  try {
    await browser.setCookie({ name: cookie.name, value: cookie.value, url })
    await browser.goto(url)
    if (options.panel) await openPanel(browser, { scratch: !options.reuse })
    else await browser.waitFor(`document.querySelector('${DOM.session}') !== null`, {
      label: 'the DSH shell to open a session', timeout: 60_000,
    })
    const value = await browser.evaluate(options.expression, { awaitPromise: true })
    console.log(JSON.stringify(value, null, 2) ?? 'undefined')
    return 0
  } catch (error) {
    console.error(`panel-eval: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await browser.close()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
