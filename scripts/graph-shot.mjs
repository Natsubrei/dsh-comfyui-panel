#!/usr/bin/env node
/**
 * Render a ComfyUI workflow file to a PNG, without the panel.
 *
 * A `pos` list says nothing about whether a layout reads well: boxes overlap,
 * links disappear behind nodes, and the canvas is framed off screen. This loads
 * the workflow into a real ComfyUI frontend in a headless browser, frames it the
 * way the editor does, and writes what the user would see.
 *
 * It talks to a running ComfyUI (the panel's, or any other), so it needs no DSH
 * session and no panel. Use `comfyui_screenshot` instead when the graph you care
 * about is the one already open in a panel.
 *
 * Usage:
 *   node scripts/graph-shot.mjs workflow.json [--out shot.png] [--url URL]
 *                                             [--size 1600x900] [--chrome PATH]
 *
 * The JSON is a ComfyUI *UI* workflow (what `comfyui_graph_read full=true`
 * returns under `workflow`), not the API prompt.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Browser, findBrowser, sleep } from '../test/ui/browser.mjs'
import { layoutReport } from '../projection.js'

const USAGE = `usage: node scripts/graph-shot.mjs <workflow.json> [--out shot.png] [--url http://127.0.0.1:8188/] [--size 1600x900] [--chrome PATH]`

/** @param {string[]} argv - process arguments after the script name. */
function parseArgs(argv) {
  const options = { file: '', out: '', url: 'http://127.0.0.1:8188/', size: [1600, 900], chrome: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`)
      i += 1
      return value
    }
    if (arg === '--out') options.out = take()
    else if (arg === '--url') options.url = take()
    else if (arg === '--chrome') options.chrome = take()
    else if (arg === '--size') {
      const [w, h] = take().split('x').map(Number)
      if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`--size wants WIDTHxHEIGHT\n${USAGE}`)
      options.size = [w, h]
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`)
    else if (options.file === '') options.file = arg
    else throw new Error(`unexpected argument ${arg}\n${USAGE}`)
  }
  if (options.file === '') throw new Error(USAGE)
  if (options.out === '') options.out = resolve(`${basename(options.file, '.json')}.png`)
  return options
}

/**
 * Frame every node inside the canvas, the way the editor's Fit command does.
 *
 * LiteGraph maps a graph point to the screen as `(pos + ds.offset) * ds.scale`,
 * so the offset is divided back out; multiplying it instead is the mistake that
 * pushes the graph half off the canvas.
 */
const FIT = `(() => {
  const canvas = window.app.canvas
  const graph = window.app.graph
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const node of graph._nodes) {
    minX = Math.min(minX, node.pos[0]); minY = Math.min(minY, node.pos[1])
    maxX = Math.max(maxX, node.pos[0] + node.size[0]); maxY = Math.max(maxY, node.pos[1] + node.size[1])
  }
  const width = canvas.canvas.width, height = canvas.canvas.height
  const bw = maxX - minX, bh = maxY - minY
  const scale = Math.min((width - 120) / bw, (height - 120) / bh, 1)
  canvas.ds.scale = scale
  canvas.ds.offset = [(width - bw * scale) / (2 * scale) - minX, (height - bh * scale) / (2 * scale) - minY]
  canvas.setDirty(true, true)
  return { scale, bbox: [bw, bh], canvas: [width, height] }
})()`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const workflow = JSON.parse(await readFile(options.file, 'utf8'))
  if (!Array.isArray(workflow?.nodes)) throw new Error(`${options.file} has no "nodes": pass a UI workflow, not an API prompt`)

  const browser = await Browser.launch({ chrome: findBrowser(options.chrome), width: options.size[0], height: options.size[1] })
  try {
    await browser.goto(options.url, { timeout: 45_000 })
    await browser.waitFor('Boolean(window.app && window.app.graph && window.app.canvas)', { timeout: 45_000, label: 'the ComfyUI frontend' })
    await sleep(500)
    await browser.evaluate(
      `(async () => { await window.app.loadGraphData(${JSON.stringify(workflow)}); return window.app.graph._nodes.length })()`,
      { awaitPromise: true },
    )
    await sleep(800)
    const fitted = await browser.evaluate(FIT)
    await sleep(600)
    await browser.screenshot(options.out)
    const layout = layoutReport(workflow.nodes)
    console.log(JSON.stringify({
      out: options.out,
      url: options.url,
      nodes: workflow.nodes.length,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      ...fitted,
      overlaps: layout.overlaps,
      tight: layout.tight,
    }, null, 2))
    if (layout.overlaps.length > 0) process.exitCode = 2
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
