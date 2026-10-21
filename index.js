/**
 * Host half of the dsh-comfyui P0 bundle.
 *
 * It owns four things:
 *  - an authenticated same-origin proxy for the ComfyUI frontend (`/comfyui`),
 *  - the WebSocket proxy the frontend uses at `/comfyui/ws`,
 *  - a workflow bridge (`/api/comfyui/state`) and an event bridge
 *    (`/api/comfyui/events`) fed by the panel's ComfyUI event socket,
 *  - four model tools.
 *
 * The ComfyUI frontend treats its pathname as its API base, so serving it below
 * `/comfyui/` keeps `/comfyui/api/*` and `/comfyui/ws` on the DSH origin. That
 * is what lets the panel's parent page reach `window.comfyAPI.app.app`.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { randomUUID } from 'node:crypto'

/** Required Host services: the HTTP carrier, its auth admission, and the Tool registry. */
export const inject = ['webServer', 'connection', 'tools']

/** Host plugin body. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const upstream = config.upstream
  const prefix = config.prefix
  const clientId = `dsh-comfyui-${randomUUID()}`
  /** sessionId -> { workflow, prompt, revision, nodes, links, types, updatedAt } */
  const sessions = new Map()
  /** sessionId -> { latest, runs: Map<promptId, run> } from the panel event socket */
  const progress = new Map()

  ctx.logger?.info(`dsh-comfyui: upstream ${upstream.href}, panel ${prefix}/`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => proxyHttp(req, res),
  }), 'dsh-comfyui: http proxy')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${prefix}/ws`,
    handler: (req, socket, head) => proxyWebSocket(req, socket, head),
  }), 'dsh-comfyui: websocket proxy')

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/comfyui/state',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => bridgeState(request),
    })
    return () => { void dispose() }
  }, 'dsh-comfyui: bridge route')

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/comfyui/events',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => bridgeEvents(request),
    })
    return () => { void dispose() }
  }, 'dsh-comfyui: event route')

  ctx.effect(() => {
    const disposers = [statusTool(), graphReadTool(), runTool(), progressTool()].map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-comfyui: tools')

  // ── HTTP proxy ──────────────────────────────────────────────────────────

  function isAdmitted(request) {
    try {
      const admission = ctx.connection.admit({ headers: request.headers })
      return !('rejection' in admission)
    } catch {
      return false
    }
  }

  function refuse(request, response) {
    if (isAdmitted(request)) return false
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('dsh-comfyui: not authenticated\n')
    return true
  }

  function proxyHttp(req, res) {
    if (refuse(req, res)) return
    const pathname = pathOf(req.url)
    if (pathname === prefix) {
      const query = queryOf(req.url)
      res.writeHead(308, { location: `${prefix}/${query}` })
      res.end()
      return
    }
    const target = targetUrl(req.url)
    const transport = target.protocol === 'https:' ? https : http
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-connection']
    delete headers.connection
    delete headers['keep-alive']
    // ComfyUI rejects POSTs whose Origin netloc differs from Host when the Host
    // is loopback (server.py origin_only_middleware). The browser talks to the
    // DSH origin, so the upstream must not see that Origin at all.
    delete headers.origin
    delete headers.referer
    const upstreamRequest = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      servername: target.hostname,
    }, upstreamResponse => {
      const headersOut = filterResponseHeaders(upstreamResponse.headers)
      rewriteLocation(headersOut, target)
      res.writeHead(upstreamResponse.statusCode ?? 502, headersOut)
      upstreamResponse.pipe(res)
    })
    upstreamRequest.on('error', error => {
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh-comfyui: ComfyUI upstream is not reachable at ${upstream.origin}\n${error.message}\n`)
    })
    res.on('close', () => upstreamRequest.destroy())
    req.pipe(upstreamRequest)
  }

  // ── WebSocket proxy ─────────────────────────────────────────────────────

  function proxyWebSocket(req, socket, head) {
    if (!isAdmitted(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const target = targetUrl(req.url)
    const port = target.port || (target.protocol === 'https:' ? 443 : 80)
    const upstreamSocket = target.protocol === 'https:'
      ? tls.connect({ host: target.hostname, port: Number(port), servername: target.hostname })
      : net.connect({ host: target.hostname, port: Number(port) })

    const fail = (error) => {
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        socket.destroy()
      }
      upstreamSocket.destroy()
      ctx.logger?.warn(`dsh-comfyui: websocket upstream failed: ${error.message}`)
    }
    upstreamSocket.once('error', fail)
    socket.once('error', () => upstreamSocket.destroy())

    upstreamSocket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`]
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index]
        const value = req.rawHeaders[index + 1]
        const lower = name.toLowerCase()
        if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
        lines.push(`${name}: ${value}`)
      }
      lines.push(`Host: ${target.host}`)
      lines.push('', '')
      upstreamSocket.write(lines.join('\r\n'))
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
  }

  // ── Workflow bridge ─────────────────────────────────────────────────────

  async function bridgeState(request) {
    const url = new URL(request.url)
    if (request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const state = sessions.get(sessionId)
      if (state === undefined) {
        return json({ ok: true, found: false, sessionId })
      }
      return json({ ok: true, found: true, ...summary(state) })
    }
    let body
    try {
      const text = await request.text()
      if (text.length > 12_000_000) return json({ ok: false, error: 'workflow payload is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId.length === 0) return json({ ok: false, error: 'sessionId is required' }, 400)
    const workflow = isObject(body.workflow) ? body.workflow : null
    const prompt = isObject(body.prompt) ? body.prompt : null
    if (workflow === null) return json({ ok: false, error: 'workflow must be an object' }, 400)
    const state = {
      workflow,
      prompt,
      revision: Number.isSafeInteger(body.revision) ? body.revision : (sessions.get(sessionId)?.revision ?? 0) + 1,
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      types: Array.isArray(workflow.nodes)
        ? [...new Set(workflow.nodes.map(node => node?.type).filter(type => typeof type === 'string'))].slice(0, 64)
        : [],
      updatedAt: Date.now(),
    }
    sessions.set(sessionId, state)
    return json({ ok: true, ...summary(state) })
  }

  function summary(state) {
    return {
      revision: state.revision,
      nodes: state.nodes,
      links: state.links,
      types: state.types,
      updatedAt: state.updatedAt,
      hasPrompt: state.prompt !== null,
    }
  }

  // ── Event bridge ────────────────────────────────────────────────────────

  async function bridgeEvents(request) {
    let body
    try {
      const text = await request.text()
      if (text.length > 200_000) return json({ ok: false, error: 'event payload is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId.length === 0) return json({ ok: false, error: 'sessionId is required' }, 400)
    const event = normalizeEvent(body?.event)
    if (event === null) return json({ ok: false, error: 'event.kind is not a known ComfyUI event' }, 400)
    recordEvent(sessionId, event)
    const bucket = progress.get(sessionId)
    return json({ ok: true, latest: bucket?.latest ?? null })
  }

  const EVENT_KINDS = new Set([
    'status',
    'execution_start',
    'execution_cached',
    'executing',
    'progress',
    'executed',
    'execution_success',
    'execution_error',
    'execution_interrupted',
  ])

  function normalizeEvent(raw) {
    if (!isObject(raw)) return null
    if (typeof raw.kind !== 'string' || !EVENT_KINDS.has(raw.kind)) return null
    const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)
    return {
      kind: raw.kind,
      promptId: text(raw.promptId, 128),
      node: text(raw.node, 128),
      value: number(raw.value),
      max: number(raw.max),
      queueRemaining: number(raw.queueRemaining),
      error: text(raw.error, 2000),
      at: Date.now(),
    }
  }

  function recordEvent(sessionId, event) {
    let bucket = progress.get(sessionId)
    if (bucket === undefined) {
      bucket = { latest: null, runs: new Map() }
      progress.set(sessionId, bucket)
    }
    bucket.latest = event
    if (event.promptId === null) return
    let run = bucket.runs.get(event.promptId)
    if (run === undefined) {
      run = {
        promptId: event.promptId,
        status: 'queued',
        startedAt: null,
        updatedAt: event.at,
        node: null,
        value: null,
        max: null,
        error: null,
      }
      bucket.runs.set(event.promptId, run)
    }
    run.updatedAt = event.at
    if (event.kind === 'execution_start') {
      run.status = 'running'
      run.startedAt ??= event.at
    } else if (event.kind === 'execution_success') {
      run.status = 'success'
      run.value = null
      run.max = null
    } else if (event.kind === 'execution_error') {
      run.status = 'error'
      run.error = event.error
    } else if (event.kind === 'execution_interrupted') {
      run.status = 'interrupted'
    } else if (event.kind === 'executing') {
      run.node = event.node
    } else if (event.kind === 'progress') {
      run.node = event.node ?? run.node
      run.value = event.value
      run.max = event.max
    }
    while (bucket.runs.size > 20) {
      const oldest = bucket.runs.keys().next().value
      bucket.runs.delete(oldest)
    }
  }

  function latestProgress(sessionId) {
    const bucket = progress.get(sessionId)
    if (bucket === undefined || bucket.latest === null) return { latest: null, run: null }
    const run = bucket.latest.promptId === null ? null : (bucket.runs.get(bucket.latest.promptId) ?? null)
    return { latest: bucket.latest, run }
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  function statusTool() {
    return {
      name: 'comfyui_status',
      description: 'Report whether the ComfyUI server is reachable and what workflow the DSH ComfyUI panel last synced for this session.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      async execute(_args, exec) {
        const sessionId = sessionOf(exec)
        const state = sessions.get(sessionId)
        const health = await fetchJson('/system_stats', 2500).catch(error => ({ ok: false, error: error.message }))
        return {
          text: JSON.stringify({
            sessionId,
            upstream: upstream.href,
            connected: health.ok === true,
            system: health.ok === true ? health.data : null,
            error: health.ok === true ? undefined : (health.error ?? `HTTP ${health.status}`),
            workflow: state === undefined ? null : summary(state),
            progress: latestProgress(sessionId),
          }, null, 2),
        }
      },
    }
  }

  function graphReadTool() {
    return {
      name: 'comfyui_graph_read',
      description: 'Read the ComfyUI UI workflow last synced from the DSH panel for this session. Use full=true to include the complete workflow JSON.',
      parameters: {
        type: 'object',
        properties: { full: { type: 'boolean', description: 'Include the complete UI workflow JSON.' } },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const state = sessions.get(sessionId)
        if (state === undefined) {
          return { text: `No ComfyUI workflow has been synced for this session yet. Open the ComfyUI tab and wait for it to connect.` }
        }
        const payload = { sessionId, ...summary(state) }
        if (args?.full === true) {
          payload.workflow = state.workflow
          payload.prompt = state.prompt
        }
        return { text: JSON.stringify(payload, null, 2) }
      },
    }
  }

  function runTool() {
    return {
      name: 'comfyui_run',
      description: 'Queue the last synced ComfyUI workflow. Returns the prompt id; set wait=true to poll /history until it settles.',
      parameters: {
        type: 'object',
        properties: {
          wait: { type: 'boolean', description: 'Wait for the run to settle before returning.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Wait budget in milliseconds (default 120000).' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const state = sessions.get(sessionId)
        if (state === undefined) throw new Error('No ComfyUI workflow has been synced for this session yet. Open the ComfyUI tab first.')
        if (state.prompt === null) throw new Error('The synced workflow has no API prompt yet. Wait for the ComfyUI panel to finish syncing.')
        const response = await fetchJson('/prompt', 15000, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: state.prompt,
            client_id: clientId,
            extra_data: { dsh_session_id: sessionId, dsh_workflow_revision: state.revision },
          }),
        })
        if (response.ok !== true) {
          throw new Error(`ComfyUI rejected the prompt (HTTP ${response.status}): ${JSON.stringify(response.data)}`)
        }
        const promptId = response.data?.prompt_id
        if (typeof promptId !== 'string') throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(response.data)}`)
        if (args?.wait !== true) {
          return { text: JSON.stringify({ prompt_id: promptId, queued: true, revision: state.revision }, null, 2) }
        }
        const timeout = clamp(args?.timeoutMs ?? 120000, 1000, 300000)
        const deadline = Date.now() + timeout
        for (;;) {
          if (Date.now() > deadline) return { text: JSON.stringify({ prompt_id: promptId, timedOut: true }, null, 2) }
          await delay(1000)
          const history = await fetchJson(`/history/${encodeURIComponent(promptId)}`, 5000).catch(() => undefined)
          if (history?.ok === true && isObject(history.data) && isObject(history.data[promptId])) {
            return { text: JSON.stringify({ prompt_id: promptId, history: history.data[promptId] }, null, 2) }
          }
          if (exec.signal.aborted) throw new Error('comfyui_run was cancelled')
        }
      },
    }
  }

  function progressTool() {
    return {
      name: 'comfyui_progress',
      description: 'Report the latest ComfyUI execution state for this session: the panel event stream (queue, current node, step progress, errors), the run record, and the live queue snapshot.',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'Optional prompt id to inspect; defaults to the latest run.' } },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const bucket = progress.get(sessionId)
        const wanted = typeof args?.promptId === 'string' && args.promptId.length > 0 ? args.promptId : null
        const run = wanted === null ? latestProgress(sessionId).run : (bucket?.runs.get(wanted) ?? null)
        const queue = await fetchJson('/queue', 2500).catch(error => ({ ok: false, error: error.message }))
        let history = null
        if (wanted !== null && (run === null || run.status === 'queued' || run.status === 'running')) {
          const settled = await fetchJson(`/history/${encodeURIComponent(wanted)}`, 2500).catch(() => undefined)
          if (settled?.ok === true && isObject(settled.data) && isObject(settled.data[wanted])) history = settled.data[wanted]
        }
        return {
          text: JSON.stringify({
            sessionId,
            hasPanelEvents: bucket !== undefined && bucket.latest !== null,
            run,
            history,
            queue: queue.ok === true
              ? {
                  running: Array.isArray(queue.data?.queue_running) ? queue.data.queue_running.length : 0,
                  pending: Array.isArray(queue.data?.queue_pending) ? queue.data.queue_pending.length : 0,
                }
              : null,
            queueError: queue.ok === true ? undefined : (queue.error ?? `HTTP ${queue.status}`),
          }, null, 2),
        }
      },
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function textOutput() {
    return {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    }
  }

  function sessionOf(exec) {
    return exec.agent?.session?.id ?? 'unknown'
  }

  function targetUrl(requestUrl) {
    const suffix = requestUrl.startsWith(prefix) ? requestUrl.slice(prefix.length) || '/' : '/'
    const queryIndex = suffix.indexOf('?')
    const pathname = queryIndex === -1 ? suffix : suffix.slice(0, queryIndex)
    const search = queryIndex === -1 ? '' : suffix.slice(queryIndex)
    const target = new URL(upstream.href)
    const basePath = target.pathname.replace(/\/+$/, '')
    target.pathname = `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}` || '/'
    target.search = search
    return target
  }

  function rewriteLocation(headers, target) {
    if (typeof headers.location !== 'string') return
    try {
      const location = new URL(headers.location, target)
      if (location.origin === target.origin) headers.location = `${prefix}${location.pathname}${location.search}${location.hash}`
    } catch {
      // A relative or malformed Location is forwarded as-is.
    }
  }

  async function fetchJson(path, timeoutMs, init = {}) {
    const target = new URL(upstream.href)
    const basePath = target.pathname.replace(/\/+$/, '')
    target.pathname = `${basePath}${path}`
    target.search = ''
    const response = await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    let data
    try {
      data = text.length === 0 ? null : JSON.parse(text)
    } catch {
      data = text
    }
    return { ok: response.ok, status: response.status, data }
  }
}

function normalizeConfig(raw) {
  const upstream = new URL(raw?.upstream ?? 'http://127.0.0.1:8188')
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`dsh-comfyui: upstream must be http(s), got ${upstream.protocol}`)
  }
  let prefix = raw?.prefix ?? '/comfyui'
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '')
  if (prefix.length === 0) throw new Error('dsh-comfyui: prefix must not be empty')
  return { upstream, prefix }
}

function pathOf(requestUrl) {
  const index = requestUrl.indexOf('?')
  return index === -1 ? requestUrl : requestUrl.slice(0, index)
}

function queryOf(requestUrl) {
  const index = requestUrl.indexOf('?')
  return index === -1 ? '' : requestUrl.slice(index + 1)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function filterResponseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
