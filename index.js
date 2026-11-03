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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digestLine, layoutReport, projectFromWorkflow } from './projection.js'
import { createWorkflowStore } from './storage.js'
import { createServiceController, frontendReport } from './service.js'
import { createCommandChannel } from './commands.js'
import { createSessionStore, validWorkflowName } from './session-store.js'
import { createRunTracker, TERMINAL_RUN_STATUSES } from './run-tracker.js'

export { takeCommand } from './commands.js'

/** Required Host services: the HTTP carrier, its auth admission, and the Tool registry. */
export const inject = ['webServer', 'connection', 'tools']

/** Host plugin body. */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const upstream = config.upstream
  const prefix = config.prefix
  const clientId = `dsh-comfyui-${randomUUID()}`
  /** cached /object_info for comfyui_node_info */
  let objectInfoCache = { at: 0, data: null }

  const store = createWorkflowStore(ctx, ctx.logger)
  const commands = createCommandChannel()
  const sessionStore = createSessionStore({
    logger: ctx.logger,
    releaseCommands: sessionId => commands.release(sessionId),
    persist: (sessionId, state) => store.save({
      sessionId,
      revision: state.revision,
      updatedAt: state.updatedAt,
      workflow: state.workflow,
      prompt: state.prompt,
      semantic: state.semantic,
      name: state.name ?? null,
      nameSource: state.nameSource ?? null,
    }),
  })
  const service = createServiceController({
    upstream,
    config: config.supervise,
    probe: async () => (await readSystemStats()).ok === true,
    logger: ctx.logger,
  })
  // A queued prompt's execution events only reach the panel's socket, so the
  // Host follows the runs it started itself. `trackedRuns` maps a prompt back
  // to its session because the tracker reports records, not sessions.
  /** @type {Map<string, string>} */
  const trackedRuns = new Map()
  const tracker = createRunTracker({
    fetchJson,
    onChange: record => {
      const sessionId = trackedRuns.get(record.promptId)
      if (sessionId === undefined) return
      if (sessionStore.hasTools(sessionId)) sessionStore.mergeRun(sessionId, record)
      if (TERMINAL_RUN_STATUSES.has(record.status)) trackedRuns.delete(record.promptId)
    },
  })

  ctx.logger?.info(`dsh-comfyui: upstream ${upstream.href}, panel ${prefix}/`)

  // A `supervise` config, when present, starts ComfyUI at boot; otherwise the
  // panel decides. Unloading stops a child this plugin spawned; a ComfyUI it
  // only adopted is left running.
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
        if (sessionStore.get(record.sessionId) !== undefined) continue
        sessionStore.restore(record)
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
      tracker.stop()
      sessionStore.close()
      void store.close()
    }
  }, 'dsh-comfyui: workflow persistence')

  // A session's Agent can appear after its panel has already synced (the tab is
  // open while the first message is being sent) or long after (resume).
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionStore.get(sessionId) !== undefined) registerSessionTools(sessionId)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    // The tracker keeps polling to its own budget, but a disposed agent's run
    // record must not come back: `release` is the end of the session's memory.
    for (const [promptId, owner] of trackedRuns) {
      if (owner === sessionId) trackedRuns.delete(promptId)
    }
    sessionStore.release(sessionId)
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
    const headers = redactUpstreamHeaders(req.headers)
    headers.host = target.host
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
      const pairs = redactRawHeaderPairs(req.rawHeaders)
      for (let index = 0; index < pairs.length; index += 2) {
        lines.push(`${pairs[index]}: ${pairs[index + 1]}`)
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
      const state = sessionStore.get(sessionId)
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
    const synced = sessionStore.sync(sessionId, body)
    if (synced.ok === false) return json({ ok: false, error: synced.error }, 400)
    registerSessionTools(sessionId)
    return json({ ok: true, ...summary(synced.state) })
  }

  function summary(state) {
    return {
      revision: state.revision,
      name: state.name ?? null,
      nodes: state.nodes,
      links: state.links,
      types: state.types,
      updatedAt: state.updatedAt,
      hasPrompt: state.prompt !== null,
      hasProjection: state.semantic !== null,
      selection: state.semantic?.selection ?? [],
      // Without it, a panel whose socket id never arrived looks exactly like a
      // working one until a run's events go somewhere else. The id stays out
      // of the summary; only whether the panel reported one is public.
      clientIdKnown: typeof state.clientId === 'string' && state.clientId.length > 0,
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
    sessionStore.recordEvent(sessionId, event)
    return json({ ok: true, latest: sessionStore.latestRun(sessionId).latest })
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

  // ── Command channel ─────────────────────────────────────────────────────
  // `comfyui_edit` queues an edit for the session. The panel's long-poll picks
  // it up, applies it inside the iframe, and posts the result back, because the
  // editor can only be mutated in the browser. The queue itself lives in
  // `commands.js`; these routes only decode the HTTP bodies.

  async function bridgeCommandPoll(request) {
    let body
    try {
      const text = await request.text()
      if (text.length > 100_000) return json({ ok: false, error: 'command payload is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId.length === 0) return json({ ok: false, error: 'sessionId is required' }, 400)
    const polled = await commands.poll(sessionId, { timeoutMs: body?.timeoutMs, signal: request.signal })
    return json(polled.body, polled.status)
  }

  async function bridgeCommandResult(request) {
    let body
    try {
      const text = await request.text()
      if (text.length > 1_000_000) return json({ ok: false, error: 'command result is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    const accepted = commands.answer(id, { ok: body?.ok, value: body?.value, error: body?.error })
    return json({ ok: true, accepted })
  }

  // ── Service bridge ──────────────────────────────────────────────────────
  // The panel manages the ComfyUI process here; no profile configuration is
  // involved. Settings are limited to the checkout directory and auto-start,
  // and the host derives the command and arguments from them.

  /**
   * Read `/system_stats` once. Transport failures are a result, not a throw, so every caller shares one shape.
   * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>} the probe outcome.
   */
  async function readSystemStats() {
    return fetchJson('/system_stats', 2500).catch(error => ({
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    }))
  }

  /**
   * Health and the frontend report from one `/system_stats` read.
   * `service.status()` probes on its own; this does not call it, or the route would hit the upstream twice.
   * @returns {Promise<object>} the supervisor snapshot plus `health` and `frontend`.
   */
  async function serviceView() {
    const stats = await readSystemStats()
    return {
      ...service.snapshot(),
      health: stats.ok === true,
      frontend: frontendReport(stats.ok === true ? stats.data : null),
    }
  }

  async function bridgeService(request) {
    if (request.method === 'GET') {
      return json({ ok: true, ...(await serviceView()) })
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
      return json({ ok: true, ...(await serviceView()) })
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  }

  // ── Session tools ───────────────────────────────────────────────────────
  // Tools and the digest live on each Agent's context. A session gets them
  // once a workflow has synced for it (or was restored from storage), so
  // unrelated sessions never see ComfyUI capabilities.

  /**
   * Start the Host's own poll for a prompt this session queued.
   * @param {string} sessionId - the session that queued it.
   * @param {string} promptId - the id ComfyUI returned.
   */
  function trackRun(sessionId, promptId) {
    trackedRuns.set(promptId, sessionId)
    tracker.watch(sessionId, promptId)
  }

  function registerSessionTools(sessionId) {
    if (sessionStore.hasTools(sessionId)) return
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
      add(() => sessionCtx.tools.register(cancelTool(sessionId)))
      add(() => sessionCtx.tools.register(progressTool(sessionId)))
      add(() => sessionCtx.tools.register(editTool(sessionId)))
      add(() => sessionCtx.tools.register(screenshotTool(sessionId)))
      add(() => sessionCtx.tools.register(nodeInfoTool()))
      add(() => sessionCtx.tools.register(workflowSaveTool(sessionId)))
      add(() => sessionCtx.tools.register(workflowListTool(sessionId)))
      add(() => sessionCtx.tools.register(workflowLoadTool(sessionId)))
      add(() => sessionCtx.tools.register(workflowExportTool(sessionId)))
      add(() => sessionCtx.tools.register(workflowImportTool(sessionId)))
      add(() => sessionCtx.systemPrompt.context({
        name: 'comfyui:workflow',
        order: 220,
        text: () => digestLine(sessionStore.get(sessionId), {
          connected: commands.connected(sessionId),
          run: sessionStore.latestRun(sessionId).run,
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
    sessionStore.trackTools(sessionId, dispose)
  }

  function statusTool(sessionId) {
    return {
      name: 'comfyui_status',
      description: 'Report ComfyUI server health, this session\'s synced workflow summary, and the latest run.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      async execute() {
        const state = sessionStore.get(sessionId)
        const health = await readSystemStats()
        return {
          text: JSON.stringify({
            sessionId,
            upstream: upstream.href,
            connected: health.ok === true,
            system: health.ok === true ? health.data : null,
            error: health.ok === true ? undefined : (health.error ?? `HTTP ${health.status}`),
            panelConnected: commands.connected(sessionId),
            workflow: state === undefined ? null : summary(state),
            progress: sessionStore.latestRun(sessionId),
            persistence: persistence(),
            service: service.snapshot(),
            frontend: frontendReport(health.ok === true ? health.data : null),
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
        const state = sessionStore.get(sessionId)
        if (state === undefined) {
          throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session and wait for Connected.')
        }
        if (args?.layout === true) {
          const nodes = Array.isArray(state.workflow?.nodes) ? state.workflow.nodes : []
          const projected = nodes.map(node => ({
            id: node?.id,
            type: node?.type,
            pos: node?.pos,
            size: node?.size,
          }))
          // Boxes that share pixels are the one layout fault nobody can see in a
          // `pos` list, so the verdict travels with the boxes.
          const { overlaps, tight, missing } = layoutReport(projected)
          return {
            text: JSON.stringify({
              sessionId,
              revision: state.revision,
              name: state.name ?? null,
              nodes: projected,
              overlaps,
              tight,
              ...(missing.length > 0 ? { missing } : {}),
            }, null, 2),
          }
        }
        if (args?.full === true) {
          return {
            text: JSON.stringify({
              sessionId,
              revision: state.revision,
              name: state.name ?? null,
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
            name: state.name ?? null,
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
      description: 'Queue the workflow synced in this session, honouring each seed widget\'s control-after-generate (randomize/increment/decrement). Returns the prompt id and the seed values used; increment and decrement continue from the previous run even though the editor keeps showing its own seed. The Host keeps tracking the run after this call returns, so comfyui_progress still works when the panel is closed. Set wait=true to poll /history until it settles and return the output images as image attachments beside the text.',
      parameters: {
        type: 'object',
        properties: {
          wait: { type: 'boolean', description: 'Wait for the run to settle before returning.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Wait budget in milliseconds (default 120000).' },
        },
        additionalProperties: false,
      },
      output: runOutput(),
      async execute(args, exec) {
        const state = sessionStore.get(sessionId)
        if (state === undefined) throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session first.')
        if (state.prompt === null) throw new Error('The synced workflow has no API prompt yet. Wait for the ComfyUI panel to finish syncing.')
        // The panel keeps showing the seed it had, so an `increment` would walk
        // from the same number on every run and reproduce the image. The cursor
        // carries where the previous runs left off; compute on a copy so a
        // prompt ComfyUI rejects does not advance it.
        const cursor = sessionStore.seedCursor(sessionId)
        const { prompt, seeds } = applySeedControls(state.workflow, state.prompt, Math.random, cursor)
        const response = await fetchJson('/prompt', 15000, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt,
            // Queue as the panel's socket when it reported one: ComfyUI sends
            // execution events only to that client, and without it the run
            // never appears in the queue, preview, or history of the UI.
            client_id: state.clientId ?? clientId,
            extra_data: {
              dsh_session_id: sessionId,
              dsh_workflow_revision: state.revision,
              // SaveImage writes each extra_pnginfo key as a PNG text chunk, so
              // the UI workflow travels with the image and a PNG dragged back
              // into ComfyUI restores it. The API prompt is not attached.
              extra_pnginfo: { workflow: state.workflow },
            },
          }),
        })
        if (response.ok !== true) {
          throw new Error(`ComfyUI rejected the prompt (HTTP ${response.status}): ${JSON.stringify(response.data)}`)
        }
        const promptId = response.data?.prompt_id
        if (typeof promptId !== 'string') throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(response.data)}`)
        trackRun(sessionId, promptId)
        // Only a queued prompt moves the seed walk forward.
        if (cursor.size > 0) sessionStore.commitSeedCursor(sessionId, cursor)
        if (args?.wait !== true) {
          return { text: JSON.stringify({ prompt_id: promptId, queued: true, sessionId, revision: state.revision, seeds }, null, 2) }
        }
        const timeout = clamp(args?.timeoutMs ?? 120000, 1000, 300000)
        const deadline = Date.now() + timeout
        for (;;) {
          if (Date.now() > deadline) return { text: JSON.stringify({ prompt_id: promptId, timedOut: true, seeds }, null, 2) }
          await delay(1000)
          const history = await fetchJson(`/history/${encodeURIComponent(promptId)}`, 5000).catch(() => undefined)
          if (history?.ok === true && isObject(history.data) && isObject(history.data[promptId])) {
            const settled = history.data[promptId]
            const collected = collectOutputImages(settled)
            const attached = await attachOutputImages(collected, exec)
            const text = JSON.stringify({
              prompt_id: promptId,
              seeds,
              history: settled,
              images: collected.map(image => image.filename),
              attachments: attached.images.length > 0 ? 'inline' : 'unavailable',
              ...attached.note === null ? {} : { imageNote: attached.note },
              ...attached.skipped.length > 0 ? { skippedImages: attached.skipped } : {},
            }, null, 2)
            return {
              text,
              ...attached.images.length > 0 ? { images: attached.images } : {},
            }
          }
          if (exec.signal.aborted) throw new Error('comfyui_run was cancelled')
        }
      },
    }
  }

  function cancelTool(sessionId) {
    return {
      name: 'comfyui_cancel',
      description: 'Cancel the run this session queued, or the given prompt id, by asking ComfyUI to interrupt it. Defaults to the latest run reported for this session. Cancelling a prompt that already finished is a no-op.',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'Optional prompt id to cancel; defaults to the latest run in this session.' } },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const wanted = typeof args?.promptId === 'string' && args.promptId.length > 0 ? args.promptId : null
        const promptId = wanted ?? sessionStore.latestRun(sessionId).run?.promptId ?? null
        if (promptId === null || promptId.length === 0) throw new Error('No ComfyUI run to cancel in this session.')
        const response = await fetchJson('/interrupt', 10000, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt_id: promptId }),
        })
        if (response.ok !== true) {
          throw new Error(`ComfyUI did not accept the interrupt (HTTP ${response.status}): ${JSON.stringify(response.data)}`)
        }
        return { text: JSON.stringify({ cancelled: true, promptId }, null, 2) }
      },
    }
  }

  function progressTool(sessionId) {
    return {
      name: 'comfyui_progress',
      description: 'Report the latest ComfyUI execution state for this session: panel events (current node, step progress, errors), the run record, the live queue snapshot, and `hostRun` — the Host\'s own tracking of a run started by comfyui_run, which keeps working after the panel closes and carries the output files.',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'Optional prompt id to inspect; defaults to the latest run.' } },
        additionalProperties: false,
      },
      output: textOutput(),
      async execute(args) {
        const latest = sessionStore.latestRun(sessionId)
        const wanted = typeof args?.promptId === 'string' && args.promptId.length > 0 ? args.promptId : null
        const before = wanted === null ? latest.run : sessionStore.runFor(sessionId, wanted)
        // Poll now rather than waiting for the tracker's timer: the tool answer
        // must describe the run at the moment it was called.
        const hostRun = before === null
          ? null
          : await tracker.refresh(before.promptId).catch(() => null)
        const run = wanted === null ? sessionStore.latestRun(sessionId).run : sessionStore.runFor(sessionId, wanted)
        const queue = await fetchJson('/queue', 2500).catch(error => ({
          ok: false, status: 0, data: null, error: error.message,
        }))
        let history = null
        if (wanted !== null && (run === null || run.status === 'queued' || run.status === 'running')) {
          const settled = await fetchJson(`/history/${encodeURIComponent(wanted)}`, 2500).catch(() => undefined)
          if (settled?.ok === true && isObject(settled.data) && isObject(settled.data[wanted])) history = settled.data[wanted]
        }
        return {
          text: JSON.stringify({
            sessionId,
            panelConnected: commands.connected(sessionId),
            hasPanelEvents: latest.latest !== null,
            run,
            hostRun,
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
      description: 'Edit the workflow open in this session\'s ComfyUI panel: add or remove nodes, move them, set widget values, and connect or disconnect inputs. Requires the panel to be open in this session. Call comfyui_graph_read first to see node ids and widget names (layout=true adds canvas boxes plus an overlap verdict), and comfyui_node_info to check class types and input names. Operations run in order, in one batch; the panel re-syncs the workflow afterwards and the result reports the node and link counts it ended with.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            description: 'Ordered edits to apply inside the ComfyUI editor. Up to 128 fit in one batch, so a whole relayout or rebuild stays atomic.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add_node', 'remove_node', 'move_node', 'set_widget', 'connect', 'disconnect'] },
                type: { type: 'string', description: 'Node class for add_node, e.g. KSampler.' },
                id: { type: 'integer', description: 'Node id: the target of remove_node, move_node, set_widget, connect and disconnect (connect/disconnect also accept to.id), and the id to assign on add_node.' },
                pos: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Canvas position: the new placement for move_node, or the initial one for add_node. Positions come from comfyui_graph_read layout=true.' },
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
        if (!commands.connected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await commands.ask(sessionId, { id, operations, at: Date.now() }, { timeoutMs: 20000, what: 'edit' })
        if (answer.ok !== true) throw new Error(`ComfyUI rejected the edit: ${answer.error ?? 'unknown error'}`)
        const value = answer.value ?? null
        return {
          text: JSON.stringify({
            id,
            sessionId,
            applied: operations.length,
            // The panel reports the size of the graph it ended with: a batch
            // that half-applied (a rebuild that lost its links) is visible here
            // rather than only in the next status read.
            nodes: value?.nodes ?? null,
            links: value?.links ?? null,
            result: value,
          }, null, 2),
        }
      },
    }
  }

  /**
   * Ask the panel for a picture of its canvas and keep the bytes.
   *
   * Coordinates describe a layout; only the pixels show one. The panel holds the
   * editor canvas, so it serializes that canvas and the Host writes the result
   * next to the other temporary files; the model then opens it with
   * `read_image`. Requires the panel to be open, like every other editor tool.
   */
  function screenshotTool(sessionId) {
    return {
      name: 'comfyui_screenshot',
      description: 'Capture the ComfyUI panel exactly as it looks right now — nodes, links, zoom and pan — into a PNG on disk, and return its path. Open that path with read_image to see the graph. Use it after a layout edit instead of judging positions from coordinates. Requires the panel to be open in this session.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      output: textOutput(),
      async execute() {
        if (!commands.connected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await commands.ask(sessionId, { id, kind: 'screenshot', at: Date.now() }, { timeoutMs: 15000, what: 'screenshot' })
        if (answer.ok !== true) throw new Error(`ComfyUI rejected the screenshot: ${answer.error ?? 'unknown error'}`)
        const value = answer.value ?? {}
        const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : ''
        const comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith('data:image/png;base64,') || comma === -1) {
          throw new Error('The panel did not return a PNG. Update the plugin and reload the page so the panel learns the screenshot command.')
        }
        const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
        if (bytes.byteLength === 0) throw new Error('The panel returned an empty image')
        const directory = join(tmpdir(), 'dsh-comfyui')
        await mkdir(directory, { recursive: true })
        const file = join(directory, `panel-${sessionId.slice(0, 8)}-${Date.now()}.png`)
        await writeFile(file, bytes)
        return {
          text: JSON.stringify({
            path: file,
            bytes: bytes.byteLength,
            width: value.width ?? null,
            height: value.height ?? null,
            hint: 'read_image on this path shows the graph as the panel renders it.',
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

  // ── Saved workflows ─────────────────────────────────────────────────────
  // The mirrored session workflow is the canvas the panel last synced; these
  // tools add named snapshots, a file export/import path, and a way to put a
  // saved graph back into the editor. Only `load` needs the panel: it edits
  // the browser's LiteGraph through the same command channel as comfyui_edit.

  /**
   * Validate a saved-workflow slot name.
   * @param {unknown} value - the requested name.
   * @returns {string} the trimmed name.
   */
  function workflowName(value) {
    if (typeof value !== 'string') throw new Error('name is required')
    const name = validWorkflowName(value)
    if (name === null) throw new Error('name must be 1-80 characters without control characters')
    return name
  }

  /**
   * Directory that export/import paths resolve against.
   * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} [exec] - tool execution context.
   * @returns {string} the session working directory, or the Host's cwd.
   */
  function sessionDirectory(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  }

  /**
   * Resolve a path against the session workspace and reject escapes from it.
   * @param {string} value - the requested path, or a file name for the default.
   * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - tool execution context.
   * @returns {string} an absolute path inside the session workspace.
   */
  function workspaceFile(value, exec) {
    const root = resolve(sessionDirectory(exec))
    const target = resolve(root, value)
    const edge = relative(root, target)
    if (edge.startsWith('..') || isAbsolute(edge)) {
      throw new Error(`path must stay inside the session workspace (${root})`)
    }
    return target
  }

  /**
   * Resolve where an export should be written, defaulting inside the workspace.
   * @param {unknown} value - the requested `path`, if any.
   * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - tool execution context.
   * @param {string} label - fallback name for the default file.
   * @returns {string} an absolute path inside the session workspace.
   */
  function workflowFile(value, exec, label) {
    if (typeof value === 'string' && value.trim().length > 0) return workspaceFile(value.trim(), exec)
    const safe = String(label).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'workflow'
    return workspaceFile(`comfyui-${safe}.json`, exec)
  }

  /**
   * Write one named workflow slot, preserving its creation time when replaced.
   * @param {string} name - the validated slot name.
   * @param {{ workflow: object, revision: number, nodes: number, links: number, sourceSessionId: string }} fields - the workflow facts to store.
   * @returns {Promise<{ replaced: boolean, record: object }>} whether the slot existed and the record written.
   */
  async function saveNamedWorkflow(name, fields) {
    const existing = await store.workflow(name)
    const now = Date.now()
    const record = { name, ...fields, createdAt: existing?.createdAt ?? now, updatedAt: now }
    await store.saveWorkflow(record)
    return { replaced: existing !== null, record }
  }

  /**
   * Persistence facts shared by the workflow tools.
   * @returns {{ backend: string, reason?: string | null }} the backend and, when persistence is off, why.
   */
  function persistence() {
    return { backend: store.backend, ...(store.reason === null ? {} : { reason: store.reason }) }
  }

  /**
   * Build the tool that saves this session's workflow under a name.
   * @param {string} sessionId - the session whose workflow is saved.
   * @returns {object} the tool definition.
   */
  function workflowSaveTool(sessionId) {
    return {
      name: 'comfyui_workflow_save',
      description: 'Save the workflow synced in this session under a name, so it can be loaded later or in another session. Saving an existing name replaces it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Slot name, 1-80 characters.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: textOutput(),
      /**
       * @param {{ name?: unknown }} args - the slot name.
       * @returns {Promise<{ text: string }>} the saved slot facts.
       */
      async execute(args) {
        const name = workflowName(args?.name)
        const state = sessionStore.get(sessionId)
        if (state === undefined) {
          throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session and wait for Connected.')
        }
        const { replaced } = await saveNamedWorkflow(name, {
          workflow: state.workflow,
          revision: state.revision,
          nodes: state.nodes,
          links: state.links,
          sourceSessionId: sessionId,
        })
        // The session's canvas is now that slot: adopt the name so the panel
        // bar, the digest and `comfyui_status` agree with what was saved.
        sessionStore.rename(sessionId, name)
        return {
          text: JSON.stringify({
            saved: name,
            replaced,
            name,
            nodes: state.nodes,
            links: state.links,
            revision: state.revision,
            persistence: persistence(),
          }, null, 2),
        }
      },
    }
  }

  /**
   * Build the tool that lists saved workflows.
   * @param {string} sessionId - the session whose current workflow is flagged.
   * @returns {object} the tool definition.
   */
  function workflowListTool(sessionId) {
    return {
      name: 'comfyui_workflow_list',
      description: 'List the workflows saved with comfyui_workflow_save, most recently saved first. The workflow open in this session is marked current.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput(),
      /**
       * @returns {Promise<{ text: string }>} the saved slots.
       */
      async execute() {
        const saved = await store.workflows()
        const shown = saved.slice(0, 100)
        const current = sessionStore.get(sessionId)?.name ?? null
        return {
          text: JSON.stringify({
            current,
            persistence: persistence(),
            count: saved.length,
            truncated: saved.length > shown.length,
            workflows: shown.map(record => ({
              name: record.name,
              current: record.name === current,
              nodes: record.nodes,
              links: record.links,
              revision: record.revision,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              sourceSessionId: record.sourceSessionId,
            })),
          }, null, 2),
        }
      },
    }
  }

  /**
   * Build the tool that loads a saved workflow into this session's panel.
   * @param {string} sessionId - the session whose panel applies the load.
   * @returns {object} the tool definition.
   */
  function workflowLoadTool(sessionId) {
    return {
      name: 'comfyui_workflow_load',
      description: 'Replace the graph in this session\'s ComfyUI panel with a saved workflow and sync it, discarding unsaved canvas changes. Requires the panel to be open.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A name from comfyui_workflow_list.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: textOutput(),
      /**
       * @param {{ name?: unknown }} args - the saved slot to load.
       * @returns {Promise<{ text: string }>} the loaded workflow facts.
       */
      async execute(args) {
        const name = workflowName(args?.name)
        const record = await store.workflow(name)
        if (record === null) {
          throw new Error(`No saved workflow named "${name}". Call comfyui_workflow_list to see the saved names.`)
        }
        if (!commands.connected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await commands.ask(
          sessionId,
          { id, kind: 'workflow', workflow: record.workflow, at: Date.now() },
          { timeoutMs: 20000, what: 'workflow load' },
        )
        if (answer.ok !== true) throw new Error(`ComfyUI rejected the workflow load: ${answer.error ?? 'unknown error'}`)
        const value = answer.value ?? {}
        // A page holding the previous client treats an unknown kind as an edit
        // with no operations and returns success; only a panel that ran the
        // load reports it.
        const loaded = Array.isArray(value.operations) && value.operations.some(operation => operation?.op === 'load_workflow')
        if (!loaded) {
          throw new Error('The panel did not confirm the workflow load. Hard-refresh the page so the panel learns the command, then retry.')
        }
        // The canvas now holds that slot; the name follows it so a later
        // `comfyui_workflow_save` does not silently rename the session.
        const state = sessionStore.get(sessionId)
        if (state !== undefined) sessionStore.rename(sessionId, name)
        return {
          text: JSON.stringify({
            id,
            sessionId,
            name,
            nodes: value.nodes ?? record.nodes,
            links: value.links ?? record.links,
            revision: state?.revision ?? null,
          }, null, 2),
        }
      },
    }
  }

  /**
   * Build the tool that exports a workflow to a file in the session workspace.
   * @param {string} sessionId - the session whose workflow may be exported.
   * @returns {object} the tool definition.
   */
  function workflowExportTool(sessionId) {
    return {
      name: 'comfyui_workflow_export',
      description: 'Write a ComfyUI UI workflow JSON file: the named saved workflow, or this session\'s workflow when no name is given. Returns the absolute path.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Saved workflow to write; omit for this session\'s workflow.' },
          path: { type: 'string', description: 'Path inside the session workspace; relative paths resolve there and paths outside it are rejected.' },
        },
        additionalProperties: false,
      },
      output: textOutput(),
      /**
       * @param {{ name?: unknown, path?: unknown }} args - the saved slot and output path.
       * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - tool execution context.
       * @returns {Promise<{ text: string }>} the written path and counts.
       */
      async execute(args, exec) {
        const name = args?.name === undefined ? null : workflowName(args.name)
        let workflow
        let label
        let nodes
        let links
        if (name === null) {
          const state = sessionStore.get(sessionId)
          if (state === undefined) {
            throw new Error('No ComfyUI workflow has synced in this session. Open the ComfyUI tab in this session and wait for Connected.')
          }
          workflow = state.workflow
          label = `session-${sessionId.slice(0, 8)}`
          nodes = state.nodes
          links = state.links
        } else {
          const record = await store.workflow(name)
          if (record === null) {
            throw new Error(`No saved workflow named "${name}". Call comfyui_workflow_list to see the saved names.`)
          }
          workflow = record.workflow
          label = name
          nodes = record.nodes
          links = record.links
        }
        const target = workflowFile(args?.path, exec, label)
        const text = `${JSON.stringify(workflow, null, 2)}\n`
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, text)
        return {
          text: JSON.stringify({
            path: target,
            bytes: Buffer.byteLength(text),
            nodes,
            links,
          }, null, 2),
        }
      },
    }
  }

  /**
   * Build the tool that imports a workflow file into a named slot.
   * @param {string} sessionId - the session whose workspace holds the file.
   * @returns {object} the tool definition.
   */
  function workflowImportTool(sessionId) {
    return {
      name: 'comfyui_workflow_import',
      description: 'Save a ComfyUI UI workflow JSON file under a name, replacing an existing workflow with that name. Open it with comfyui_workflow_load.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path inside the session workspace; relative paths resolve there and paths outside it are rejected.' },
          name: { type: 'string', description: 'Slot name, 1-80 characters; defaults to the file name without its extension.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: textOutput(),
      /**
       * @param {{ path?: unknown, name?: unknown }} args - the input file and optional slot name.
       * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - tool execution context.
       * @returns {Promise<{ text: string }>} the imported slot facts.
       */
      async execute(args, exec) {
        const requested = typeof args?.path === 'string' ? args.path.trim() : ''
        if (requested.length === 0) throw new Error('path is required')
        const target = workspaceFile(requested, exec)
        const info = await stat(target).catch(() => null)
        if (info === null || !info.isFile()) throw new Error(`No file at ${target}`)
        if (info.size > 12_000_000) throw new Error(`Workflow file is larger than 12 MB: ${target}`)
        const text = await readFile(target, 'utf8')
        let workflow
        try {
          workflow = JSON.parse(text)
        } catch {
          throw new Error(`Not JSON: ${target}`)
        }
        if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow) || !Array.isArray(workflow.nodes)) {
          throw new Error('Expected a ComfyUI UI workflow (an object with a nodes array), not an API prompt.')
        }
        const name = workflowName(args?.name ?? basename(target).replace(/\.[^.]+$/u, ''))
        const nodes = workflow.nodes.length
        const links = Array.isArray(workflow.links) ? workflow.links.length : 0
        const { replaced } = await saveNamedWorkflow(name, {
          workflow,
          revision: 0,
          nodes,
          links,
          sourceSessionId: sessionId,
        })
        return {
          text: JSON.stringify({
            imported: name,
            path: target,
            nodes,
            links,
            replaced,
            persistence: persistence(),
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

  /**
   * The run tools' output: text, plus the images a settled wait=true run
   * returned as durable attachment references.
   * @returns {{schema: any, render: (args: unknown, value: {text: string, images?: Array<{attachment: any}>}) => any[]}} the output contract.
   */
  function runOutput() {
    return {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                // Loose on purpose: the attachment service owns the reference
                // shape, and this plugin only forwards what it returned.
                attachment: { type: 'object', additionalProperties: true },
              },
              required: ['attachment'],
              additionalProperties: false,
            },
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        /** @type {any[]} */
        const blocks = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image.attachment })
        return blocks
      },
    }
  }

  /**
   * Fetch and store a settled run's output images. Every image failure is
   * reported in the text and never fails the run; a missing attachment
   * service or an image-incapable model route skips the whole batch.
   * @param {Array<{filename: string, subfolder: string}>} images - output files in history order.
   * @param {any} exec - the tool execution, used to resolve the calling model route.
   * @returns {Promise<{images: Array<{attachment: any}>, skipped: Array<{filename: string, reason: string}>, note: string | null}>} what was stored, what was skipped, and why the batch was skipped.
   */
  async function attachOutputImages(images, exec) {
    if (images.length === 0) return { images: [], skipped: [], note: null }
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      return {
        images: [],
        skipped: [],
        note: 'no attachment service is mounted, so the images stay in ComfyUI and only their file names are returned',
      }
    }
    const refusal = await imageRouteRefusal(exec)
    if (refusal !== null) return { images: [], skipped: [], note: refusal }
    /** @type {Array<{attachment: any}>} */
    const stored = []
    /** @type {Array<{filename: string, reason: string}>} */
    const skipped = []
    for (const image of images) {
      const result = await attachOutputImage(image, attachments)
      if ('attachment' in result) stored.push(result)
      else skipped.push({ filename: image.filename, reason: result.reason })
    }
    return { images: stored, skipped, note: null }
  }

  /**
   * Fetch one output image through `/view` and commit it to the attachment store.
   * @param {{filename: string, subfolder: string}} image - one history output entry.
   * @param {{saveImage: (input: {data: Uint8Array, mediaType: string, name: string}) => Promise<any>}} attachments - the mounted attachment service.
   * @returns {Promise<{attachment: any} | {reason: string}>} the stored reference, or why this image was skipped.
   */
  async function attachOutputImage(image, attachments) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: 'output' })
    /** @type {{ok: boolean, status: number, bytes?: Uint8Array, mediaType?: string, error?: string}} */
    const fetched = await fetchBytes(`/view?${query.toString()}`, OUTPUT_IMAGE_TIMEOUT_MS).catch(error => ({
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (fetched.ok !== true) {
      return { reason: `could not read the image: ${fetched.error ?? `HTTP ${fetched.status}`}` }
    }
    const mediaType = outputImageMediaType(image.filename, fetched.mediaType)
    if (mediaType === undefined) return { reason: 'the image is not PNG, JPEG, or WebP' }
    try {
      return { attachment: await attachments.saveImage({ data: fetched.bytes, mediaType, name: image.filename }) }
    } catch (error) {
      return { reason: `the attachment service refused it: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Require the calling model route to declare image input, like `read_image`
   * does. An image block that a text-only adapter cannot serialize would fail
   * the next model request and take the run's text result down with it, so an
   * unknown route counts as negative and only the text is returned.
   * @param {any} exec - the tool execution carrying the calling agent.
   * @returns {Promise<string | null>} why images cannot be attached, or null when they can.
   */
  async function imageRouteRefusal(exec) {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) {
      return 'the current model route could not be resolved for image input, so only the file names are returned'
    }
    let info
    try {
      info = await llm.resolveModelInfo(provider, model, exec.signal)
    } catch {
      return 'the current model route could not be verified for image input, so only the file names are returned'
    }
    if (info?.inputModalities === undefined || !info.inputModalities.includes('image')) {
      return `model "${model}" does not declare image input, so only the file names are returned`
    }
    return null
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

  /**
   * Request one path on the ComfyUI upstream and decode its JSON body.
   * @param path - path below the upstream root, e.g. `/system_stats`.
   * @param timeoutMs - abort budget in milliseconds.
   * @param init - extra fetch options.
   * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>} the outcome; `error` is set only on a transport failure.
   */
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

  /**
   * Request one binary path (with its query) from the ComfyUI upstream.
   * @param path - path and query below the upstream root, e.g. `/view?filename=a.png`.
   * @param timeoutMs - abort budget in milliseconds.
   * @param maxBytes - body cap; a longer response is abandoned instead of buffered.
   * @returns {Promise<{ok: boolean, status: number, bytes?: Uint8Array, mediaType?: string, error?: string}>} the outcome; `error` is set when the body was refused.
   */
  async function fetchBytes(path, timeoutMs, maxBytes = MAX_OUTPUT_IMAGE_BYTES) {
    const target = new URL(upstream.href)
    const basePath = target.pathname.replace(/\/+$/, '')
    const queryIndex = path.indexOf('?')
    target.pathname = `${basePath}${queryIndex === -1 ? path : path.slice(0, queryIndex)}`
    target.search = queryIndex === -1 ? '' : path.slice(queryIndex)
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, status: response.status, error: `the image is larger than the ${maxBytes / (1024 * 1024)} MB cap` }
    }
    const reader = response.body?.getReader()
    if (reader === undefined) return { ok: false, status: response.status, error: 'the image response had no body' }
    /** @type {Uint8Array[]} */
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, status: response.status, error: `the image is larger than the ${maxBytes / (1024 * 1024)} MB cap` }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    return { ok: true, status: response.status, bytes, mediaType }
  }
}

/** The panel and the ComfyUI frontend both derive their API base from this path. */
const PANEL_PREFIX = '/comfyui'

/** Most output images one run result carries; a longer list would bloat the message. */
const MAX_OUTPUT_IMAGES = 4

/** Per-image byte cap for an output returned as an attachment. */
const MAX_OUTPUT_IMAGE_BYTES = 20 * 1024 * 1024

/** How long one output image fetch may take. */
const OUTPUT_IMAGE_TIMEOUT_MS = 20000

/** Media types the attachment service accepts from a ComfyUI output. */
const OUTPUT_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Extension fallback when `/view` does not declare a supported content type. */
const OUTPUT_IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * Collect the output images a settled history entry reports.
 * @param {any} history - one `/history/{id}` entry.
 * @returns {Array<{filename: string, subfolder: string}>} up to four `type: 'output'` files in report order.
 */
export function collectOutputImages(history) {
  /** @type {Array<{filename: string, subfolder: string}>} */
  const images = []
  if (!isObject(history) || !isObject(history.outputs)) return images
  for (const output of Object.values(history.outputs)) {
    if (images.length >= MAX_OUTPUT_IMAGES) break
    if (!isObject(output) || !Array.isArray(output.images)) continue
    for (const image of output.images) {
      if (images.length >= MAX_OUTPUT_IMAGES) break
      if (!isObject(image) || image.type !== 'output') continue
      if (typeof image.filename !== 'string' || image.filename.length === 0) continue
      images.push({
        filename: image.filename,
        subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
      })
    }
  }
  return images
}

/**
 * Resolve the media type of a ComfyUI output image.
 * @param {string} filename - the output file name from history.
 * @param {string} [contentType] - the `/view` Content-Type, already stripped of parameters.
 * @returns {string | undefined} the supported media type, or undefined when neither source declares one.
 */
export function outputImageMediaType(filename, contentType) {
  if (typeof contentType === 'string' && OUTPUT_IMAGE_MEDIA_TYPES.has(contentType)) return contentType
  if (typeof filename !== 'string') return undefined
  return OUTPUT_IMAGE_EXTENSIONS.get(extname(filename).toLowerCase())
}

/** Cookie names the DSH web UI uses for admission. They must not reach ComfyUI. */
const DSH_AUTH_COOKIE = /^dsh-auth(?:-|$)/iu

/**
 * Remove DSH admission cookies from one Cookie header value.
 * @param {string | undefined} value - the raw Cookie header.
 * @returns {string} the header with those cookies removed; empty when none remain.
 */
export function redactCookieHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value.split(';').map(part => part.trim()).filter(part => {
    if (part.length === 0) return false
    const name = part.split('=')[0].trim()
    return !DSH_AUTH_COOKIE.test(name)
  }).join('; ')
}

/**
 * Copy request headers for the upstream, without DSH admission cookies.
 * @param {import('node:http').IncomingHttpHeaders} headers - the browser's headers.
 * @returns {import('node:http').OutgoingHttpHeaders} headers safe to forward.
 */
function redactUpstreamHeaders(headers) {
  /** @type {import('node:http').OutgoingHttpHeaders} */
  const out = { ...headers }
  const cookie = out.cookie
  if (typeof cookie === 'string') {
    const next = redactCookieHeader(cookie)
    if (next.length === 0) delete out.cookie
    else out.cookie = next
  } else if (Array.isArray(cookie)) {
    const next = cookie.map(part => redactCookieHeader(part)).filter(part => part.length > 0)
    if (next.length === 0) delete out.cookie
    else out.cookie = next
  }
  return out
}

/**
 * Copy a WebSocket handshake's raw headers, without DSH admission cookies.
 * Host, Origin, and Referer are dropped here; the caller sets Host itself.
 * @param {string[]} rawHeaders - Node's `rawHeaders` pairs.
 * @returns {string[]} pairs safe to forward.
 */
export function redactRawHeaderPairs(rawHeaders) {
  /** @type {string[]} */
  const pairs = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
    if (lower === 'cookie') {
      const next = redactCookieHeader(value)
      if (next.length === 0) continue
      pairs.push(name, next)
      continue
    }
    pairs.push(name, value)
  }
  return pairs
}

function normalizeConfig(raw) {
  const upstream = new URL(raw?.upstream ?? 'http://127.0.0.1:8188')
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`dsh-comfyui: upstream must be http(s), got ${upstream.protocol}`)
  }
  let prefix = raw?.prefix ?? PANEL_PREFIX
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '')
  if (prefix !== PANEL_PREFIX) {
    throw new Error(`dsh-comfyui: prefix is fixed at ${PANEL_PREFIX} (the panel and the ComfyUI frontend both derive their API base from it); got ${prefix}`)
  }
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

const SEED_CONTROLS = new Set(['fixed', 'randomize', 'increment', 'decrement'])

/**
 * Honour a node's "control after generate" when the Host queues the prompt.
 *
 * The control is a frontend behaviour: the editor rewrites the seed *after*
 * queueing, so the API prompt the panel hands us still carries one fixed seed.
 * Without this, a run driven by `comfyui_run` would quietly reproduce the last
 * image even though the workflow says "randomize".
 *
 * `increment` and `decrement` need one more thing the editor cannot give us:
 * after its own run the frontend advances the widget, so the next value is one
 * past the last seed *used*. The panel is canonical and keeps showing the old
 * number, so `cursor` remembers how far this session has walked past it; a seed
 * the user has edited since (the widget no longer matches what the walk started
 * from) becomes the new base.
 *
 * Returns a fresh prompt (the stored state is shared) plus the seeds used, so
 * the run result stays reproducible. A `cursor` is updated in place: pass a
 * copy when the run may still be rejected.
 */
export function applySeedControls(workflow, prompt, random = Math.random, cursor = null) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const controlOf = new Map()
  for (const node of nodes) {
    if (!isObject(node) || !Array.isArray(node.widgets_values)) continue
    const control = node.widgets_values.find(value => typeof value === 'string' && SEED_CONTROLS.has(value))
    if (control !== undefined) controlOf.set(String(node.id), control)
  }
  if (controlOf.size === 0) return { prompt, seeds: {} }

  const next = {}
  const seeds = {}
  for (const [id, node] of Object.entries(isObject(prompt) ? prompt : {})) {
    const control = controlOf.get(id)
    if (control === undefined || control === 'fixed' || !isObject(node) || !isObject(node.inputs)) {
      next[id] = node
      continue
    }
    const field = ['noise_seed', 'seed'].find(name => Number.isInteger(node.inputs[name]))
    if (field === undefined) {
      next[id] = node
      continue
    }
    const current = node.inputs[field]
    let value
    if (control === 'randomize') value = Math.floor(random() * 2 ** 48)
    else {
      const previous = cursor?.get(id)
      const base = previous !== undefined && previous.from === current ? previous.used : current
      value = control === 'increment' ? base + 1 : Math.max(0, base - 1)
    }
    cursor?.set(id, { from: current, used: value })
    next[id] = { ...node, inputs: { ...node.inputs, [field]: value } }
    seeds[id] = { field, value }
  }
  return { prompt: next, seeds }
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
