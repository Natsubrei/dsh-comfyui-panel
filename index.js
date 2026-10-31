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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digestLine, layoutReport, projectFromWorkflow, sanitizeSemantic, stripViewState } from './projection.js'
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
  /** sessionId -> Map<nodeId, { from, used }>: how far increment/decrement walked past the seed the editor shows */
  const seedCursors = new Map()
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
    if (typeof sessionId !== 'string') return
    sessionTools.delete(sessionId)
    releaseSession(sessionId)
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
    // The panel reports the name its editor would save under, but only when
    // that name changed: a canvas whose frontend has no file yet sends no
    // `name`, and the Host must keep the name a tool gave the session rather
    // than clear it on every quiet re-sync.
    let name = previous?.name ?? null
    if (body.name !== undefined) {
      if (body.name === null) {
        name = null
      } else {
        const requested = validWorkflowName(body.name)
        if (requested === null) return json({ ok: false, error: 'name must be 1-80 characters without control characters' }, 400)
        name = requested
      }
    }
    const renamed = name !== (previous?.name ?? null)
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
      // The name is metadata, not graph content: it never bumps the revision,
      // because renaming a workflow does not change what the model reads.
      name,
      // Which socket the embedded frontend is listening on. Execution events
      // only reach the client that queued the prompt, so a run the model
      // starts has to use the panel's id or it never shows up in the UI.
      // Kept in memory only: it changes with the page, not with the workflow.
      clientId: sanitizeClientId(body.clientId) ?? previous?.clientId ?? null,
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
    if (changed || renamed) schedulePersist(sessionId)
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
      name: typeof record.name === 'string' ? record.name : null,
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
        name: state.name ?? null,
      }).catch(error => ctx.logger?.warn(`dsh-comfyui: could not persist ${sessionId}: ${String(error)}`))
    }, 1500))
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
      // A run can be joined after `execution_start` went out: the panel was
      // reloading, or the editor's socket reconnected mid-run. Anything that
      // only happens during a run proves it is running, so the record does not
      // keep claiming "queued" until the success event arrives.
      if (run.status === 'queued') {
        run.status = 'running'
        run.startedAt ??= event.at
      }
      run.node = event.node
    } else if (event.kind === 'progress' || event.kind === 'executed') {
      if (run.status === 'queued') {
        run.status = 'running'
        run.startedAt ??= event.at
      }
      run.node = event.node ?? run.node
      if (event.kind === 'progress') {
        run.value = event.value
        run.max = event.max
      }
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

  /**
   * Drop a command the panel never picked up.
   *
   * A tool that has already failed must not reach the editor later: the panel
   * can reconnect minutes after `comfyui_edit` reported that it never answered,
   * and applying the edit then would change a graph the model no longer
   * believes it touched — with the result discarded, because the waiter is
   * gone. The queue and the tool call have to expire together.
   */
  function dropCommand(sessionId, id) {
    const state = commandQueues.get(sessionId)
    if (state === undefined) return
    const index = state.queue.findIndex(command => command.id === id)
    if (index !== -1) state.queue.splice(index, 1)
  }

  /**
   * End everything the Host is still holding for a session whose agent went
   * away.
   *
   * DSH disposes an agent on clear and compaction too, and the same session id
   * comes back with a fresh agent; the canvas survives in `sessions` (and in
   * storage), but a long-poll or a tool call parked on the old panel must not
   * wait out its timeout against an editor nobody owns any more. A queued edit
   * is dropped with its tool call: handing it to the next panel would change a
   * graph the model no longer believes it touched.
   *
   * @param {string} sessionId - the session whose agent was disposed.
   */
  function releaseSession(sessionId) {
    const state = commandQueues.get(sessionId)
    if (state !== undefined) {
      // Resolving a waiter with no command releases the open HTTP request so
      // the panel's loop can re-arm under the new agent.
      for (const waiter of [...state.waiters]) waiter.resolve(null)
      commandQueues.delete(sessionId)
    }
    progress.delete(sessionId)
    seedCursors.delete(sessionId)
    for (const [id, pending] of [...pendingCommands]) {
      if (pending.sessionId !== sessionId) continue
      pendingCommands.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error('The ComfyUI session closed before the panel answered; open the tab again and retry.'))
    }
  }

  /**
   * Queue one command for a session's panel and wait for its result.
   *
   * The panel answers through `commands/result`; a panel that disappears after
   * claiming the command is bounded by the timeout, and `releaseSession`
   * rejects the wait when the owning agent goes away. `dropCommand` runs with
   * the timeout so a panel reconnecting later cannot apply an expired command.
   *
   * @param {string} sessionId - the session whose panel should answer.
   * @param {object} command - command body; its `id` correlates the result.
   * @param {number} timeoutMs - how long to wait before giving up.
   * @param {string} what - short noun for the timeout message.
   * @returns {Promise<{ ok: boolean, value?: any, error?: string | null }>} the panel's answer.
   */
  function askPanel(sessionId, command, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(command.id)
        dropCommand(sessionId, command.id)
        reject(new Error(`The ComfyUI panel did not answer the ${what} in time. It may be reloading.`))
      }, timeoutMs)
      pendingCommands.set(command.id, { resolve, reject, timer, sessionId })
      enqueueCommand(sessionId, command)
    })
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
    // `takeCommand` skips anything the tool has given up on, so a panel that
    // polls after a timeout gets nothing instead of a stale edit.
    const live = takeCommand(state.queue)
    if (live !== null) return json({ ok: true, command: live })
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
        const health = await fetchJson('/system_stats', 2500).catch(error => ({
          ok: false, status: 0, data: null, error: error.message,
        }))
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
            persistence: persistence(),
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
      description: 'Queue the workflow synced in this session, honouring each seed widget\'s control-after-generate (randomize/increment/decrement). Returns the prompt id and the seed values used; increment and decrement continue from the previous run even though the editor keeps showing its own seed. Set wait=true to poll /history until it settles.',
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
        // The panel keeps showing the seed it had, so an `increment` would walk
        // from the same number on every run and reproduce the image. The cursor
        // carries where the previous runs left off; compute on a copy so a
        // prompt ComfyUI rejects does not advance it.
        const cursor = new Map(seedCursors.get(sessionId) ?? [])
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
            extra_data: { dsh_session_id: sessionId, dsh_workflow_revision: state.revision },
          }),
        })
        if (response.ok !== true) {
          throw new Error(`ComfyUI rejected the prompt (HTTP ${response.status}): ${JSON.stringify(response.data)}`)
        }
        const promptId = response.data?.prompt_id
        if (typeof promptId !== 'string') throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(response.data)}`)
        // Only a queued prompt moves the seed walk forward.
        if (cursor.size > 0) seedCursors.set(sessionId, cursor)
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
            return { text: JSON.stringify({ prompt_id: promptId, seeds, history: history.data[promptId] }, null, 2) }
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
        if (!panelConnected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await askPanel(sessionId, { id, operations, at: Date.now() }, 20000, 'edit')
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
        if (!panelConnected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await askPanel(sessionId, { id, kind: 'screenshot', at: Date.now() }, 15000, 'screenshot')
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
   * Validate a workflow name without throwing.
   *
   * The bridge accepts one from the panel on every sync, where an unusable
   * value is a client bug rather than a tool-call error, so the check is
   * shared with `workflowName` instead of duplicated.
   * @param {unknown} value - the requested name.
   * @returns {string | null} the trimmed name, or null when it is not usable.
   */
  function validWorkflowName(value) {
    if (typeof value !== 'string') return null
    const name = value.trim()
    if (name.length === 0 || name.length > 80) return null
    if (/[\u0000-\u001f\u007f]/u.test(name)) return null
    return name
  }

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
        const state = sessions.get(sessionId)
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
        state.name = name
        schedulePersist(sessionId)
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
        const current = sessions.get(sessionId)?.name ?? null
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
        if (!panelConnected(sessionId)) {
          throw new Error('The ComfyUI panel is not connected in this session. Open the ComfyUI tab in this session and wait for Connected, then retry.')
        }
        const id = randomUUID()
        const answer = await askPanel(
          sessionId,
          { id, kind: 'workflow', workflow: record.workflow, at: Date.now() },
          20000,
          'workflow load',
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
        const state = sessions.get(sessionId)
        if (state !== undefined) {
          state.name = name
          schedulePersist(sessionId)
        }
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
          const state = sessions.get(sessionId)
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
}

/** How long a queued command may wait for a panel before it is dropped. */
const COMMAND_TTL_MS = 60_000

/**
 * Take the next command a panel can still act on.
 *
 * The queue is read through this rather than shifted directly because a command
 * whose tool call has already failed must not be applied later: a panel that
 * reconnects minutes afterwards would change the user's graph for an edit the
 * model reported as never delivered, and the result would be discarded.
 *
 * @param queue - commands in arrival order, each stamped with `at`.
 * @param now - current time; injectable so the expiry is testable.
 * @returns the oldest live command, or `null` when every one has expired.
 */
export function takeCommand(queue, now = Date.now()) {
  while (queue.length > 0) {
    const command = queue.shift()
    const at = Number.isFinite(command?.at) ? command.at : now
    if (now - at <= COMMAND_TTL_MS) return command
  }
  return null
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

/** A ComfyUI socket id (hex uuid, or the panel's own), when it looks like one. */
function sanitizeClientId(value) {
  return typeof value === 'string' && /^[0-9a-z]{8,64}$/i.test(value) ? value : null
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
