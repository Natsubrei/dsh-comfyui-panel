/**
 * P0 mock ComfyUI upstream.
 *
 * It serves a tiny page that exposes the same `window.comfyAPI.app.app` shape
 * the real frontend exposes, plus the handful of API routes `comfyui_run`
 * uses. Use it to verify the DSH proxy, the iframe bridge, and the three
 * tools on a machine without torch/ComfyUI. It is not a real ComfyUI.
 *
 *   node test/mock-comfyui.mjs
 *
 * Then open the ComfyUI tab in DSH; the panel should show Connected and a
 * one-node workflow. `comfyui_run` should return prompt_id `p1`.
 */
import http from 'node:http'

const PORT = Number(process.env.COMFYUI_MOCK_PORT ?? 8188)

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock ComfyUI</title>
<style>
  body { margin: 0; background: #171718; color: #ddd; font: 14px/1.5 system-ui, sans-serif; }
  main { padding: 28px; }
  code { color: #7dd3fc; }
</style></head>
<body><main>
  <h1>Mock ComfyUI</h1>
  <p>This is a P0 bridge fixture, not the real ComfyUI frontend.</p>
  <p>It exposes <code>window.comfyAPI.app.app</code> so the DSH panel can test
  <code>graph.serialize()</code> and <code>graphToPrompt()</code>.</p>
  <p id="state">graph: one KSampler node; no real execution.</p>
</main>
<script>
  window.comfyAPI = window.comfyAPI || {};
  window.comfyAPI.app = window.comfyAPI.app || {};
  window.comfyAPI.app.app = {
    rootGraph: {
      serialize: () => ({
        last_node_id: 1,
        last_link_id: 0,
        nodes: [{ id: 1, type: 'KSampler', pos: [80, 80], size: [240, 120], widgets_values: [0, 'fixed'] }],
        links: [],
        groups: [],
        config: {},
        extra: { mock: true },
        version: 1
      })
    },
    async graphToPrompt() {
      return { output: { 1: { class_type: 'KSampler', inputs: { seed: 0 } } } };
    }
  };
</script>
</body></html>`

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (req.url === '/system_stats') {
    json(res, { system: { comfyui_version: 'mock' }, devices: [] })
    return
  }
  if (req.url === '/prompt' && req.method === 'POST') {
    await drain(req)
    json(res, { prompt_id: 'p1', number: 1, node_errors: {} })
    return
  }
  if (req.url === '/history/p1') {
    json(res, { p1: { status: { status_str: 'success', completed: true }, outputs: {} } })
    return
  }
  if (req.url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  json(res, { error: 'mock route not found', url: req.url }, 404)
})

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function drain(req) {
  return new Promise(resolve => {
    req.resume()
    req.on('end', resolve)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock ComfyUI listening on http://127.0.0.1:${PORT}`)
})
