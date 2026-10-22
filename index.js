/**
 * Host half of the dsh-comfyui bundle.
 *
 * It owns five things:
 *  - an authenticated same-origin proxy for the ComfyUI frontend (`/comfyui`),
 *  - the WebSocket proxy the frontend uses at `/comfyui/ws`,
 *  - a workflow bridge (`/api/comfyui/state`), an event bridge
 *    (`/api/comfyui/events`), and the edit command channel fed by the panel,
 *  - per-session model tools plus one runtime-context digest line,
 *  - optional durability (workflow store) and process supervision (ComfyUI).
 *
 * The ComfyUI frontend treats its pathname as its API base, so serving it below
 * `/comfyui/` keeps `/comfyui/api/*` and `/comfyui/ws` on the DSH origin. That
 * is what lets the panel's parent page reach `window.comfyAPI.app.app`.
 *
 * Tools and the digest are registered through each Agent's own context, so a
 * session only sees them once a ComfyUI workflow has synced for that session.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { digestLine, projectFromWorkflow, sanitizeSemantic, stripViewState } from './projection.js'
import { createWorkflowStore } from './storage.js'
import { createServiceController } from './service.js'

/** Required Host services: the HTTP carrier, its auth admission, and the Tool registry. */
export const inject = ['webServer', 'connection', 'tools']

/** Host plugin body. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const upstream = config.upstream
  const prefix = config.prefix
  const clientId = `dsh-comfyui-${randomUUID()}`
  /** sessionId -> { workflow, prompt, semantic, revision, nodes, links, types, updatedAt } */
  const sessions = new Map()
  /** sessionId -> { latest, runs: Map<promptId, run> } from the panel event socket */
  const progress = new Map()
  /** sessionId -> { queue: command[], waiters: waiter[], lastPollAt } */
  const commandQueues = new Map()
  /** command id -> { resolve, timer } while comfyui_edit waits for the panel */
  const pendingCommands = new Map()
  /** sessionId -> disposer of the tools + digest registered on that session's Agent */
  const sessionTools = new Map()
  /** sessionId -> pending debounce timer for the workflow store */
  const persistTimers = new Map()
  /** cached /object_info for comfyui_node_info */
  let objectInfoCache = { at: 0, data: null }

  const store = createWorkflowStore(ctx, ctx.logger)
  const service = createServiceController({
    upstream,
    config: config.supervise,
    probe: async () => (await fetchJson('/system_stats', 2500)).ok === true,
    logger: ctx.logger,
  })

  ctx.logger?.info(`dsh-comfyui: upstream ${upstream.href}, panel ${prefix}/`)

  // A `supervise` config, when present, starts ComfyUI at boot; otherwise the
  // panel decides. Unloading the plugin stops only a process it started.
  ctx.effect(() => {
    if (config.supervise.enabled) {
      void service.start().catch(error => ctx.logger?.warn(`dsh-comfyui: could not start ComfyUI: ${String(error)}`))
    }
    return () => { void service.shutdown() }
  }, 'dsh-comfyui: process supervision')

  // Load persisted workflows, then give already-open sessions their tools.
  // The panel re-syncs within 30 s anyway; this covers a Host restart with the
  // tab closed, where the workflow must still be readable and runnable.
  ctx.effect(() => {
    let disposed = false
    void store.ready.then(({ sessions: records, settings: serviceSettings }) => {
      if (disposed) return
      for (const record of records) {
        if (sessions.has(record.sessionId)) continue
        sessions.set(record.sessionId, stateFromRecord(record))
        registerSessionTools(record.sessionId)
      }
      if (records.length > 0) ctx.logger?.info(`dsh-comfyui: restored ${records.length} workflow(s) from storage`)
      if (serviceSettings !== null && !config.supervise.enabled) {
        service.restore(serviceSettings)
        if (serviceSettings.autoStart === true) {
          void service.start().catch(error => ctx.logger?.warn(`dsh-comfyui: could not auto-start ComfyUI: ${String(error)}`))
        }
      }
      // A ComfyUI left running by a previous Host (or started by hand in the
      // configured checkout) is taken back by pid, so Stop and Restart keep
      // working instead of pointing at a server no button can reach.
      void service.adopt().catch(error => ctx.logger?.warn(`dsh-comfyui: could not adopt ComfyUI: ${String(error)}`))
    }).catch(error => ctx.logger?.warn(`dsh-comfyui: could not restore workflows: ${String(error)}`))
    return () => {
      disposed = true
      for (const timer of persistTimers.values()) clearTimeout(timer)
      persistTimers.clear()
      for (const dispose of sessionTools.values()) dispose()
      sessionTools.clear()
      void store.close()
    }
  }, 'dsh-comfyui: workflow persistence')

  // A session's Agent can appear after its panel has already synced (the tab is
  // open while the first message is being sent) or long after (resume).
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessions.has(sessionId)) registerSessionTools(sessionId)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string') sessionTools.delete(sessionId)
  })

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
    const dispose = ctx.connection.fetch.register({
      path: '/api/comfyui/commands/poll',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => bridgeCommandPoll(request),
    })
    return () => { void dispose() }
  }, 'dsh-comfyui: command poll route')

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/comfyui/commands/result',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => bridgeCommandResult(request),
    })
    return () => { void dispose() }
  }, 'dsh-comfyui: command result route')

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/comfyui/service',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => bridgeService(request),
    })
    return () => { void dispose() }
  }, 'dsh-comfyui: service route')

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
      allowAssetCaching(headersOut, target)
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
    // View-only canvas state (zoom/pan) is not an edit; drop it before the
    // content comparison so a scroll or resize cannot bump the revision.
    const workflow = isObject(body.workflow) ? stripViewState(body.workflow) : null
    const prompt = isObject(body.prompt) ? body.prompt : null
    if (workflow === null) return json({ ok: false, error: 'workflow must be an object' }, 400)
    const previous = sessions.get(sessionId)
    const incoming = Number.isSafeInteger(body.revision) ? body.revision : 0
    let semantic = sanitizeSemantic(body.semantic)
    // A projection that sees no nodes while the raw workflow has some comes
    // from a frontend whose live-node layout this client does not recognize;
    // prefer the raw fallback over claiming the graph is empty.
    if (semantic !== null && semantic.nodes.length === 0
      && Array.isArray(workflow.nodes) && workflow.nodes.length > 0) {
      semantic = null
    }
    // The panel re-syncs on a timer even when nothing changed. Compare content
    // so `revision` means "a change was synced" and idle re-syncs stay cheap.
    const signature = JSON.stringify([workflow, prompt, semantic])
    const changed = previous === undefined || previous.signature !== signature
    const state = {
      workflow,
      prompt,
      semantic,
      signature,
      // The panel's counter restarts with the page while the Host may hold a
      // higher persisted revision; keep the descriptive revision monotonic.
      revision: changed
        ? Math.max(incoming, (previous?.revision ?? 0) + 1)
        : (previous?.revision ?? incoming),
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      types: Array.isArray(workflow.nodes)
        ? [...new Set(workflow.nodes.map(node => node?.type).filter(type => typeof type === 'string'))].slice(0, 64)
        : [],
      updatedAt: changed ? Date.now() : (previous?.updatedAt ?? Date.now()),
    }
    sessions.set(sessionId, state)
    registerSessionTools(sessionId)
    if (changed) schedulePersist(sessionId)
    return json({ ok: true, ...summary(state) })
  }

  function stateFromRecord(record) {
    const workflow = record.workflow
    const prompt = record.prompt ?? null
    const semantic = sanitizeSemantic(record.semantic)
    return {
      workflow,
      prompt,
      semantic,
      signature: JSON.stringify([workflow, prompt, semantic]),
      revision: record.revision,
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      types: Array.isArray(workflow.nodes)
        ? [...new Set(workflow.nodes.map(node => node?.type).filter(type => typeof type === 'string'))].slice(0, 64)
        : [],
      updatedAt: record.updatedAt,
    }
  }

  /** Debounced persistence: the panel syncs about once per second while editing. */
  function schedulePersist(sessionId) {
    if (persistTimers.has(sessionId)) return
    persistTimers.set(sessionId, setTimeout(() => {
      persistTimers.delete(sessionId)
      const state = sessions.get(sessionId)
      if (state === undefined) return
      void store.save({
        sessionId,
        revision: state.revision,
        updatedAt: state.updatedAt,
        workflow: state.workflow,
        prompt: state.prompt,
        semantic: state.semantic,
      }).catch(error => ctx.logger?.warn(`dsh-comfyui: could not persist ${sessionId}: ${String(error)}`))
    }, 1500))
  }

  function summary(state) {
    return {
      revision: state.revision,
      nodes: state.nodes,
      links: state.links,
      types: state.types,
      updatedAt: state.updatedAt,
      hasPrompt: state.prompt !== null,
      hasProjection: state.semantic !== null,
      selection: state.semantic?.selection ?? [],
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

  // ── Command channel ─────────────────────────────────────────────────────
  // `comfyui_edit` queues an edit for the session. The panel's long-poll picks
  // it up, applies it inside the iframe, and posts the result back, because the
  // editor can only be mutated in the browser.

  function commandState(sessionId) {
    let state = commandQueues.get(sessionId)
    if (state === undefined) {
      state = { queue: [], waiters: [], lastPollAt: 0 }
      commandQueues.set(sessionId, state)
    }
    return state
  }

  function enqueueCommand(sessionId, command) {
    const state = commandState(sessionId)
    const waiter = state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(command)
    else state.queue.push(command)
  }

  async function bridgeCommandPoll(request) {
    let body
    try {
      body = JSON.parse(await request.text())
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId.length === 0) return json({ ok: false, error: 'sessionId is required' }, 400)
    const timeoutMs = clamp(Number.isFinite(body?.timeoutMs) ? body.timeoutMs : 20000, 1000, 25000)
    const state = commandState(sessionId)
    state.lastPollAt = Date.now()
    if (state.queue.length > 0) return json({ ok: true, command: state.queue.shift() })
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const index = state.waiters.indexOf(waiter)
        if (index !== -1) state.waiters.splice(index, 1)
        resolve(value)
      }
      const timer = setTimeout(() => finish(json({ ok: true, command: null })), timeoutMs)
      const waiter = { resolve: command => finish(json({ ok: true, command })) }
      state.waiters.push(waiter)
      request.signal?.addEventListener('abort', () => finish(json({ ok: false, error: 'poll aborted' }, 499)))
    })
  }

  async function bridgeCommandResult(request) {
    let body
    try {
      body = JSON.parse(await request.text())
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    const pending = pendingCommands.get(id)
    if (pending === undefined) return json({ ok: true, accepted: false })
    pendingCommands.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({
      ok: body?.ok !== false,
      value: body?.value ?? null,
      error: typeof body?.error === 'string' ? body.error.slice(0, 2000) : null,
    })
    return json({ ok: true, accepted: true })
  }

  // ── Service bridge ──────────────────────────────────────────────────────
  // The panel manages the ComfyUI process here; no profile configuration is
  // involved. Settings are limited to the checkout directory and auto-start,
  // and the host derives the command and arguments from them.

  async function bridgeService(request) {
    if (request.method === 'GET') {
      return json({ ok: true, ...(await service.status()) })
    }
    let body
    try {
      const text = await request.text()
      if (text.length > 100_000) return json({ ok: false, error: 'settings payload is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const action = typeof body?.action === 'string' ? body.action : ''
    try {
      if (action === 'save' || action === 'start') {
        if (body?.settings !== undefined) service.save(body.settings)
        const record = service.record()
        if (record !== null) await store.saveSettings(record)
      }
      if (action === 'start') await service.start()
      else if (action === 'stop') await service.stop()
      else if (action === 'restart') await service.restart()
      else if (action !== 'save') return json({ ok: false, error: `unknown action "${action}"` }, 400)
      return json({ ok: true, ...(await service.status()) })
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }

  // ── Session tools ───────────────────────────────────────────────────────
  // Tools and the digest live on each Agent's context. A session gets them
  // once a workflow has synced for it (or was restored from storage), so
  // unrelated sessions never see ComfyUI capabilities.

  function registerSessionTools(sessionId) {
    if (sessionTools.has(sessionId)) return
    let agent
    try {
      agent = ctx.get('agents')?.get(sessionId)
    } catch {
      agent = undefined
    }
    if (agent === undefined || agent === null) return
    const sessionCtx = agent.ctx
    const undo = []
    try {
      const add = register => { undo.push(register()) }
      add(() => sessionCtx.tools.register(statusTool(sessionId)))
      add(() => sessionCtx.tools.register(graphReadTool(sessionId)))
      add(() => sessionCtx.tools.register(runTool(sessionId)))
      add(() => sessionCtx.tools.register(progressTool(sessionId)))
      add(() => sessionCtx.tools.register(editTool(sessionId)))
      add(() => sessionCtx.tools.register(nodeInfoTool()))
      add(() => sessionCtx.systemPrompt.context({
        name: 'comfyui:workflow',
        order: 220,
        text: () => digestLine(sessions.get(sessionId), {
          connected: panelConnected(sessionId),
          run: latestProgress(sessionId).run,
        }),
      }))
    } catch (error) {
      for (const dispose of undo.reverse()) dispose()
      ctx.logger?.warn(`dsh-comfyui: cannot register tools for session ${sessionId}: ${String(error)}`)
      return
    }
    let dispose
    try {
      dispose = sessionCtx.effect(() => () => {
        for (const undoOne of undo.reverse()) undoOne()
      }, 'dsh-comfyui: session tools')
    } catch (error) {
      for (const undoOne of undo.reverse()) undoOne()
      ctx.logger?.warn(`dsh-comfyui: cannot own tools for session ${sessionId}: ${String(error)}`)
      return
    }
    sessionTools.set(sessionId, dispose)
  }

  function statusTool(sessionId) {
    return {
      name: 'comfyui_status',
      description: 'Report ComfyUI server health, this session\'s synced workflow summary, and the latest run.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      async execute() {
        const state = sessions.get(sessionId)
        const health = await fetchJson('/system_stats', 2500).catch(error => ({ ok: false, error: error.message }))
        return {
          text: JSON.stringify({
            sessionId,
            upstream: upstream.href,
            connected: health.ok === true,
            system: health.ok === true ? health.data : null,
            error: health.ok === true ? undefined : (health.error ?? `HTTP ${health.status}`),
            panelConnected: panelConnected(sessionId),
            workflow: state === undefined ? null : summary(state),
            progress: latestProgress(sessionId),
            persistence: {
              backend: store.backend,
              ...(store.reason === null ? {} : { reason: store.reason }),
            },
            service: service.snapshot(),
          }, null, 2),
        }
      },
    }
  }

  function graphReadTool(sessionId) {
    return {
      name: 'comfyui_graph_read',
      description: 'Read the ComfyUI workflow synced in this session: each node\'s id, class type, widget values, and inputs. An input maps to "<sourceNodeId>:<outputSlot>". Pass layout=true for node ids and canvas boxes only, or full=true for the raw UI workflow and API prompt.',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'Return the raw UI workflow and API prompt instead of the projection.' },
          layout: { type: 'boolean', description: 'Return only node ids, types, and canvas pos/size — the cheap read before placing a node.' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const state = sessions.get(sessionId)
        if (state === undefined) {
          throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session and wait for Connected.')
        }
        if (args?.layout === true) {
          const nodes = Array.isArray(state.workflow?.nodes) ? state.workflow.nodes : []
          return {
            text: JSON.stringify({
              sessionId,
              revision: state.revision,
              nodes: nodes.map(node => ({
                id: node?.id,
                type: node?.type,
                pos: node?.pos,
                size: node?.size,
              })),
            }),
          }
        }
        if (args?.full === true) {
          return {
            text: JSON.stringify({
              sessionId,
              revision: state.revision,
              updatedAt: state.updatedAt,
              workflow: state.workflow,
              prompt: state.prompt,
            }, null, 2),
          }
        }
        const semantic = state.semantic ?? projectFromWorkflow(state.workflow)
        return {
          text: JSON.stringify({
            sessionId,
            revision: state.revision,
            updatedAt: state.updatedAt,
            projectedFrom: state.semantic === null ? 'workflow' : 'panel',
            ...(state.semantic === null
              ? { note: 'Widget names are unavailable without the panel; widgetsValues is positional.' }
              : {}),
            nodes: semantic.nodes,
            linkCount: semantic.linkCount ?? state.links,
            selection: semantic.selection ?? [],
            apiPrompt: {
              available: state.prompt !== null,
              nodes: isObject(state.prompt) ? Object.keys(state.prompt).length : 0,
            },
          }, null, 2),
        }
      },
    }
  }

  function runTool(sessionId) {
    return {
      name: 'comfyui_run',
      description: 'Queue the workflow synced in this session. Returns the prompt id; set wait=true to poll /history until it settles.',
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
        const state = sessions.get(sessionId)
        if (state === undefined) throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session first.')
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
          return { text: JSON.stringify({ prompt_id: promptId, queued: true, sessionId, revision: state.revision }, null, 2) }
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

  function progressTool(sessionId) {
    return {
      name: 'comfyui_progress',
      description: 'Report the latest ComfyUI execution state for this session: panel events (current node, step progress, errors), the run record, and the live queue snapshot.',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'Optional prompt id to inspect; defaults to the latest run.' } },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
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
            panelConnected: panelConnected(sessionId),
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

  function editTool(sessionId) {
    return {
      name: 'comfyui_edit',
      description: 'Edit the workflow open in this session\'s ComfyUI panel: add or remove nodes, set widget values, and connect or disconnect inputs. Requires the panel to be open in this session. Call comfyui_graph_read first to see node ids and widget names, and comfyui_node_info to check class types and input names. Operations run in order; the panel re-syncs the workflow afterwards.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            description: 'Ordered edits to apply inside the ComfyUI editor.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add_node', 'remove_node', 'set_widget', 'connect', 'disconnect'] },
                type: { type: 'string', description: 'Node class for add_node, e.g. KSampler.' },
                id: { type: 'integer', description: 'Node id: the target of remove_node, set_widget, connect and disconnect (connect/disconnect also accept to.id), and the id to assign on add_node.' },
                pos: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Canvas position for add_node.' },
                widgets: { type: 'object', additionalProperties: { description: 'Initial widget value.' }, description: 'Widget values for add_node, keyed by widget name.' },
                name: { type: 'string', description: 'Widget name for set_widget.' },
                value: { description: 'New widget value for set_widget; coerced to the widget type.' },
                from: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    output: { type: 'integer', description: 'Output slot index on the source node.' },
                  },
                  required: ['id', 'output'],
                  additionalProperties: false,
                },
                to: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    input: { type: 'string', description: 'Input name on the target node.' },
                  },
                  required: ['id', 'input'],
                  additionalProperties: false,
                },
              },
              required: ['op'],
              additionalProperties: false,
            },
          },
        },
        required: ['operations'],
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const operations = Array.isArray(args?.operations) ? args.operations : []
        if (operations.length === 0) throw new Error('operations must contain at least one edit')
        if (!panelConnected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingCommands.delete(id)
            reject(new Error('The ComfyUI panel did not answer the edit in time. It may be reloading.'))
          }, 45000)
          pendingCommands.set(id, { resolve, timer })
          enqueueCommand(sessionId, { id, operations, at: Date.now() })
        })
        if (answer.ok !== true) throw new Error(`ComfyUI rejected the edit: ${answer.error ?? 'unknown error'}`)
        return {
          text: JSON.stringify({
            id,
            sessionId,
            applied: operations.length,
            result: answer.value,
          }, null, 2),
        }
      },
    }
  }

  async function objectInfo() {
    if (objectInfoCache.data !== null && Date.now() - objectInfoCache.at < 600_000) return objectInfoCache.data
    const response = await fetchJson('/object_info', 30000)
    if (response.ok !== true) throw new Error(`Could not load /object_info: ${response.error ?? `HTTP ${response.status}`}`)
    objectInfoCache = { at: Date.now(), data: response.data }
    return objectInfoCache.data
  }

  function nodeInfoTool() {
    return {
      name: 'comfyui_node_info',
      description: 'Look up ComfyUI node classes: pass `type` for the exact class input/output schema, or `search` for matching class names. Use it before comfyui_edit add_node to get the class_type and input names right.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Exact class_type, e.g. KSampler.' },
          search: { type: 'string', description: 'Case-insensitive substring to match class names.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matches for search (default 20).' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const data = await objectInfo()
        const wanted = typeof args?.type === 'string' ? args.type : ''
        if (wanted !== '') {
          const entry = data[wanted]
          if (entry === undefined) throw new Error(`Unknown node type "${wanted}". Use search to find the right class_type.`)
          return {
            text: JSON.stringify({
              type: wanted,
              category: entry.category,
              description: entry.description,
              input: entry.input,
              output: entry.output,
              output_name: entry.output_name,
            }, null, 2),
          }
        }
        const needle = typeof args?.search === 'string' ? args.search.toLowerCase() : ''
        const names = Object.keys(data)
          .filter(name => needle === '' || name.toLowerCase().includes(needle))
          .slice(0, clamp(args?.limit ?? 20, 1, 100))
        return { text: JSON.stringify({ total: Object.keys(data).length, matches: names }, null, 2) }
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

  /**
   * Whether this session's panel is listening for commands. A long-poll stays
   * open for up to 20 s, so an idle waiter counts as connected even when the
   * last request started earlier than the freshness window.
   */
  function panelConnected(sessionId) {
    const state = commandQueues.get(sessionId)
    if (state === undefined) return false
    if (state.waiters.length > 0) return true
    return Date.now() - state.lastPollAt <= 15000
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

  /**
   * The ComfyUI frontend serves hashed bundles under /assets/ with
   * `Cache-Control: no-store`, which makes every panel open re-download them.
   * Hashed names are safe to cache forever; everything else keeps the upstream
   * policy.
   */
  function allowAssetCaching(headers, target) {
    if (!target.pathname.includes('/assets/')) return
    headers['cache-control'] = 'public, max-age=31536000, immutable'
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
  return { upstream, prefix, supervise: normalizeSupervise(raw?.supervise) }
}

/**
 * Validate the optional process-supervision block. A misconfiguration fails
 * loud at load: silently not supervising would look like a working setup that
 * simply never starts ComfyUI.
 */
function normalizeSupervise(raw) {
  const enabled = raw?.enabled === true
  if (!enabled) return { enabled: false }
  const command = typeof raw?.command === 'string' && raw.command.length > 0 ? raw.command : 'python3'
  const args = Array.isArray(raw?.args) ? raw.args.map(String) : ['main.py', '--listen', '127.0.0.1']
  const cwd = typeof raw?.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : null
  if (cwd === null) throw new Error('dsh-comfyui: supervise.cwd is required when supervise.enabled is true')
  return {
    enabled: true,
    command,
    args,
    cwd,
    env: isObject(raw?.env) ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, String(value)])) : {},
    restartDelayMs: clamp(Number(raw?.restartDelayMs ?? 5000), 500, 120000),
    maxRestarts: clamp(Number(raw?.maxRestarts ?? 5), 0, 50),
    probeIntervalMs: clamp(Number(raw?.probeIntervalMs ?? 20000), 5000, 300000),
    startTimeoutMs: clamp(Number(raw?.startTimeoutMs ?? 120000), 5000, 600000),
    logPath: typeof raw?.logPath === 'string' && raw.logPath.length > 0 ? raw.logPath : null,
  }
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
