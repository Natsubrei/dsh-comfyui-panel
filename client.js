/**
 * Browser half of the dsh-comfyui P0 bundle.
 *
 * The right-sidebar tab hosts the real ComfyUI frontend in a same-origin
 * iframe. Because the Host proxies ComfyUI under `/comfyui/`, the parent page
 * can reach `iframe.contentWindow.comfyAPI.app.app`, serialize the UI
 * workflow, ask the editor for its API prompt, and POST both to the Host.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-comfyui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dshComfyUI'
    const TAB_ID = '@local/dsh-comfyui/workflow'
    const TAB_KIND = 'comfyui'
    const PANEL_URL = '/comfyui/'
    const STATE_URL = '/api/comfyui/state'
    const EVENT_URL = '/api/comfyui/events'
    const COMMAND_POLL_URL = '/api/comfyui/commands/poll'
    const COMMAND_RESULT_URL = '/api/comfyui/commands/result'

    const en = {
      title: 'ComfyUI',
      description: 'Open the real ComfyUI editor in a DSH panel. Edits sync to the Host and are available to the model.',
      loading: 'Starting ComfyUI…',
      ready: 'Connected',
      syncing: 'Syncing…',
      error: 'Bridge error',
      sync: 'Sync',
      reload: 'Reload',
      open: 'Open in new tab',
      noSession: 'No session',
      stats: '{{nodes}} nodes · {{links}} links · rev {{revision}}',
      bridgeUnavailable: 'ComfyUI did not expose its editor API. Check that the panel is served from /comfyui/.',
      syncFailed: 'Could not send the workflow to the Host.',
      running: 'Running {{value}}/{{max}}',
      queued: 'Queued',
      runFailed: 'Run failed',
      runInterrupted: 'Run interrupted',
    }
    const zh = {
      title: 'ComfyUI',
      description: '在 DSH 面板中打开真实的 ComfyUI 编辑器；改动会同步到 Host，模型可以直接读取和修改。',
      loading: '正在启动 ComfyUI…',
      ready: '已连接',
      syncing: '同步中…',
      error: '桥接错误',
      sync: '同步',
      reload: '重载',
      open: '新标签打开',
      noSession: '无会话',
      stats: '{{nodes}} 个节点 · {{links}} 条连线 · rev {{revision}}',
      bridgeUnavailable: 'ComfyUI 没有暴露编辑器 API。请确认面板是通过 /comfyui/ 同源加载的。',
      syncFailed: '工作流未能发送到 Host。',
      running: '运行中 {{value}}/{{max}}',
      queued: '排队中',
      runFailed: '运行失败',
      runInterrupted: '运行已中断',
    }

    const CSS = `
      .dsh-comfyui-panel {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font: 12px/1.4 var(--dsw-font-family, system-ui, sans-serif);
      }
      .dsh-comfyui-bar {
        display: flex; align-items: center; gap: 8px;
        min-height: 34px; padding: 0 10px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        flex: 0 0 auto;
      }
      .dsh-comfyui-title { font-weight: 600; letter-spacing: .01em; }
      .dsh-comfyui-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--dsw-alias-state-idle-primary);
        flex: 0 0 auto;
      }
      .dsh-comfyui-dot[data-status="ready"] { background: var(--dsw-alias-state-success-primary); }
      .dsh-comfyui-dot[data-status="syncing"] { background: var(--dsw-alias-state-warn-primary); }
      .dsh-comfyui-dot[data-status="error"] { background: var(--dsw-alias-state-error-primary); }
      .dsh-comfyui-status { color: var(--dsw-alias-label-secondary); }
      .dsh-comfyui-run {
        color: var(--dsw-alias-state-warn-primary);
        white-space: nowrap;
      }
      .dsh-comfyui-stats {
        color: var(--dsw-alias-label-secondary);
        margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .dsh-comfyui-button {
        height: 24px; padding: 0 8px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit;
      }
      .dsh-comfyui-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dsh-comfyui-button:focus-visible {
        outline: 1px solid var(--dsw-alias-brand-primary);
        outline-offset: 2px;
      }
      .dsh-comfyui-frame { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; background: #111; }
      .dsh-comfyui-notice {
        margin: 8px 10px; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1);
      }
      .dsh-comfyui-notice[data-tone="error"] {
        color: var(--dsw-alias-state-error-primary);
        border-color: var(--dsw-alias-state-error-primary);
      }
    `

    function StatBar({ status, stats, message, runText, bootSeconds, onSync, onReload, onOpen, t }) {
      const statText = t('stats')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
        .replace('{{revision}}', String(stats.revision))
      const statusText = status === 'loading' && bootSeconds > 0 ? `${t('loading')} ${bootSeconds}s` : t(status)
      return h('div', { className: 'dsh-comfyui-bar' },
        h('span', { className: 'dsh-comfyui-dot', 'data-status': status }),
        h('span', { className: 'dsh-comfyui-title' }, t('title')),
        h('span', { className: 'dsh-comfyui-status' }, statusText),
        runText === '' ? null : h('span', { className: 'dsh-comfyui-run' }, runText),
        h('span', { className: 'dsh-comfyui-stats', title: statText }, statText),
        h('button', { className: 'dsh-comfyui-button', type: 'button', onClick: onSync }, t('sync')),
        h('button', { className: 'dsh-comfyui-button', type: 'button', onClick: onReload }, t('reload')),
        h('button', { className: 'dsh-comfyui-button', type: 'button', onClick: onOpen }, t('open')),
        message === '' ? null : h('span', { className: 'dsh-comfyui-status', title: message }, ''),
      )
    }

    /**
     * Reduce a ComfyUI WebSocket message to the small event shape the Host
     * stores. Messages the Host does not need (binary previews, node-specific
     * payloads) return null.
     */
    function mapComfyEvent(message) {
      const type = message?.type
      const data = message?.data !== null && typeof message?.data === 'object' ? message.data : {}
      const promptId = typeof data.prompt_id === 'string' ? data.prompt_id : null
      const node = typeof data.node === 'string' ? data.node : null
      switch (type) {
        case 'status':
          return { kind: 'status', queueRemaining: data?.status?.exec_info?.queue_remaining ?? null }
        case 'execution_start':
        case 'execution_cached':
        case 'execution_success':
          return { kind: type, promptId }
        case 'executing':
          return { kind: type, promptId, node }
        case 'progress':
          return { kind: type, promptId, node, value: data.value ?? null, max: data.max ?? null }
        case 'executed':
          return { kind: type, promptId, node }
        case 'execution_error':
          return {
            kind: type,
            promptId,
            error: typeof data.exception_message === 'string'
              ? data.exception_message
              : (typeof data.exception_type === 'string' ? data.exception_type : 'execution error'),
          }
        case 'execution_interrupted':
          return { kind: type, promptId }
        default:
          return null
      }
    }

    function findNode(graph, id) {
      if (typeof graph.getNodeById === 'function') return graph.getNodeById(id)
      return graph._nodes_by_id?.[id] ?? (Array.isArray(graph._nodes) ? graph._nodes.find(node => node.id === id) : undefined)
    }

    function coerceWidgetValue(widget, value) {
      if (widget === undefined) return value
      if (typeof widget.value === 'number') {
        const number = typeof value === 'number' ? value : Number(value)
        if (Number.isFinite(number)) return number
      }
      if (typeof widget.value === 'boolean') return value === true || value === 'true'
      if (typeof widget.value === 'string') return String(value)
      return value
    }

    const MAX_VALUE_STRING = 240
    const MAX_PROJECTED_ENTRIES = 64

    /** Bound one widget value to JSON-safe data the Host can store and a model can read. */
    function projectValue(value, depth = 0) {
      if (value === null || typeof value === 'boolean') return value
      if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
      if (typeof value === 'string') return value.length > MAX_VALUE_STRING ? `${value.slice(0, MAX_VALUE_STRING)}…` : value
      if (depth >= 2) return '…'
      if (Array.isArray(value)) return value.slice(0, MAX_PROJECTED_ENTRIES).map(item => projectValue(item, depth + 1))
      if (typeof value === 'object') {
        const out = Object.create(null)
        for (const [key, item] of Object.entries(value).slice(0, MAX_PROJECTED_ENTRIES)) {
          if (key === '__proto__') continue
          out[key] = projectValue(item, depth + 1)
        }
        return out
      }
      return String(value)
    }

    /**
     * Build the semantic projection from the live LiteGraph nodes, where widget
     * and input names are known. An input becomes `"<sourceNodeId>:<slot>"`,
     * matching what comfyui_edit's connect.from expects.
     */
    function projectGraph(app) {
      const graph = app.rootGraph ?? app.graph
      const nodes = Array.isArray(graph?._nodes) ? graph._nodes : []
      const links = graph?.links instanceof Map ? graph.links : new Map(Object.entries(graph?.links ?? {}))
      const linkOf = id => links.get(id) ?? links.get(String(id))
      const projected = []
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (!Number.isInteger(node.id) || typeof node.type !== 'string') continue
        const widgets = Object.create(null)
        for (const widget of Array.isArray(node.widgets) ? node.widgets : []) {
          if (widget === null || typeof widget !== 'object' || widget.value === undefined) continue
          const name = typeof widget.name === 'string' && widget.name.length > 0 ? widget.name : null
          if (name === null || name === '__proto__') continue
          widgets[name] = projectValue(widget.value)
        }
        const inputs = Object.create(null)
        for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
          if (input === null || typeof input !== 'object') continue
          if (input.link === null || input.link === undefined) continue
          const link = linkOf(input.link)
          if (link === null || typeof link !== 'object') continue
          if (!Number.isInteger(link.origin_id) || !Number.isInteger(link.origin_slot)) continue
          inputs[String(input.name)] = `${link.origin_id}:${link.origin_slot}`
        }
        const entry = { id: node.id, type: node.type, widgets, inputs }
        if (typeof node.title === 'string' && node.title.length > 0 && node.title !== node.type) entry.title = node.title
        if (node.mode === 2) entry.mode = 'mute'
        else if (node.mode === 4) entry.mode = 'bypass'
        projected.push(entry)
      }
      projected.sort((left, right) => left.id - right.id)
      const selected = Object.keys(app.canvas?.selected_nodes ?? {})
        .map(Number)
        .filter(Number.isInteger)
      return {
        nodes: projected,
        linkCount: links.size,
        selection: selected,
      }
    }

    /** Apply one host edit inside the iframe's LiteGraph editor. */
    function applyOperation({ graph, LiteGraph, app, operation }) {
      const op = operation?.op
      if (op === 'add_node') {
        const node = LiteGraph.createNode(operation.type)
        if (node === undefined || node === null) throw new Error(`Unknown node type "${operation.type}"`)
        if (Array.isArray(operation.pos)) node.pos = operation.pos
        if (Number.isInteger(operation.id)) node.id = operation.id
        graph.add(node)
        for (const [name, value] of Object.entries(operation.widgets ?? {})) {
          const widget = node.widgets?.find(candidate => candidate.name === name)
          if (widget === undefined) throw new Error(`Node ${node.id} (${operation.type}) has no widget "${name}"`)
          widget.value = coerceWidgetValue(widget, value)
          widget.callback?.(widget.value, app?.canvas, node)
        }
        graph.setDirtyCanvas?.(true, true)
        return { op, id: node.id, type: node.type }
      }
      const node = findNode(graph, operation.id)
      if (node === undefined || node === null) throw new Error(`Node ${operation.id} not found`)
      if (op === 'remove_node') {
        graph.remove(node)
        graph.setDirtyCanvas?.(true, true)
        return { op, id: operation.id }
      }
      if (op === 'set_widget') {
        const widget = node.widgets?.find(candidate => candidate.name === operation.name)
        if (widget === undefined) throw new Error(`Node ${operation.id} has no widget "${operation.name}"`)
        widget.value = coerceWidgetValue(widget, operation.value)
        widget.callback?.(widget.value, app?.canvas, node)
        return { op, id: operation.id, name: operation.name, value: widget.value }
      }
      if (op === 'connect' || op === 'disconnect') {
        const inputs = node.inputs ?? []
        const slot = inputs.findIndex(input => input.name === operation.to?.input)
        if (slot === -1) throw new Error(`Node ${node.id} has no input "${operation.to?.input}"`)
        if (op === 'connect') {
          const source = findNode(graph, operation.from?.id)
          if (source === undefined || source === null) throw new Error(`Source node ${operation.from?.id} not found`)
          source.connect(operation.from?.output ?? 0, node, slot)
          return { op, from: operation.from, to: { id: node.id, input: operation.to?.input }, slot }
        }
        if (typeof node.disconnectInput === 'function') node.disconnectInput(slot)
        else if (inputs[slot]?.link !== null && inputs[slot]?.link !== undefined) graph.removeLink(inputs[slot].link)
        graph.setDirtyCanvas?.(true, true)
        return { op, id: node.id, input: operation.to?.input }
      }
      throw new Error(`Unknown operation "${op}"`)
    }

    function ComfyPanel({ sessionId, t }) {
      const iframeRef = useRef(null)
      const appRef = useRef(null)
      const lastJsonRef = useRef('')
      const lastForcedAtRef = useRef(0)
      const revisionRef = useRef(0)
      const [status, setStatus] = useState('loading')
      const [bootSeconds, setBootSeconds] = useState(0)
      const [stats, setStats] = useState({ nodes: 0, links: 0, revision: 0 })
      const [message, setMessage] = useState('')
      const [run, setRun] = useState(null)
      const eventRef = useRef({ pending: null, timer: null, sentAt: 0 })
      const syncRef = useRef(null)

      const readApp = useCallback(() => {
        const win = iframeRef.current?.contentWindow
        const app = win?.comfyAPI?.app?.app
        if (app === undefined || app === null) return null
        appRef.current = app
        return app
      }, [])

      const push = useCallback(async (app, force = false) => {
        if (sessionId === undefined || sessionId === null) return
        const graph = app.rootGraph ?? app.graph
        if (graph === undefined || graph === null || typeof graph.serialize !== 'function') {
          throw new Error(t('bridgeUnavailable'))
        }
        const workflow = JSON.parse(JSON.stringify(graph.serialize()))
        const selection = Object.keys(app.canvas?.selected_nodes ?? {})
          .map(Number)
          .filter(Number.isInteger)
        const json = `${JSON.stringify(workflow)}|${selection.join(',')}`
        if (!force && json === lastJsonRef.current) return
        lastJsonRef.current = json
        setStatus('syncing')
        setMessage('')
        let semantic = null
        try {
          semantic = projectGraph(app)
        } catch {
          // A projection failure must not block the raw workflow sync.
        }
        let prompt = null
        try {
          const converted = await app.graphToPrompt()
          prompt = converted?.output ?? null
        } catch {
          // A graph that cannot be converted yet (missing links, empty graph)
          // still syncs; the run tool will report the missing prompt.
        }
        revisionRef.current += 1
        const revision = revisionRef.current
        const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
        const links = Array.isArray(workflow.links) ? workflow.links.length : 0
        const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, workflow, prompt, semantic, revision }),
        })
        if (!response.ok) throw new Error(`${t('syncFailed')} HTTP ${response.status}`)
        setStats({ nodes, links, revision })
        setStatus('ready')
      }, [sessionId, t])

      const syncNow = useCallback(async (force = true) => {
        const app = readApp()
        if (app === null) {
          setStatus('loading')
          setMessage(t('bridgeUnavailable'))
          return
        }
        try {
          await push(app, force)
        } catch (error) {
          lastJsonRef.current = ''
          setStatus('error')
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [push, readApp, t])
      syncRef.current = syncNow

      const applyOperations = useCallback(async (app, operations) => {
        const win = iframeRef.current?.contentWindow
        const LiteGraph = win?.LiteGraph
        const graph = app.rootGraph ?? app.graph
        if (graph === undefined || graph === null || LiteGraph === undefined) throw new Error('ComfyUI graph is not ready')
        const applied = []
        for (const operation of operations) {
          applied.push(applyOperation({ graph, LiteGraph, app, operation }))
        }
        graph.setDirtyCanvas?.(true, true)
        await syncNow(true)
        return { applied: applied.length, operations: applied }
      }, [syncNow])

      const commandRef = useRef(null)
      commandRef.current = applyOperations

      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let disposed = false
        const loop = async () => {
          while (!disposed) {
            try {
              const response = await fetch(COMMAND_POLL_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, timeoutMs: 20000 }),
              })
              if (!response.ok) throw new Error(`command poll HTTP ${response.status}`)
              const data = await response.json()
              const command = data?.command
              if (command === undefined || command === null) continue
              let payload
              try {
                const app = readApp()
                if (app === null) throw new Error('The ComfyUI panel is still loading')
                const value = await commandRef.current(app, command.operations ?? [])
                payload = { sessionId, id: command.id, ok: true, value }
              } catch (error) {
                payload = { sessionId, id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }
              }
              await fetch(COMMAND_RESULT_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              }).catch(() => {})
            } catch {
              if (disposed) break
              await new Promise(resolve => setTimeout(resolve, 3000))
            }
          }
        }
        void loop()
        return () => { disposed = true }
      }, [readApp, sessionId])

      const postEvent = useCallback((event) => {
        if (sessionId === undefined || sessionId === null) return
        const box = eventRef.current
        box.pending = event
        if (box.timer !== null) return
        const wait = Math.max(0, 200 - (Date.now() - box.sentAt))
        box.timer = setTimeout(() => {
          box.timer = null
          const payload = box.pending
          box.pending = null
          box.sentAt = Date.now()
          void fetch(EVENT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, event: payload }),
          }).catch(() => {})
        }, wait)
      }, [sessionId])

      const applyEvent = useCallback((event) => {
        setRun(current => {
          switch (event.kind) {
            case 'status':
              return current
            case 'execution_start':
              return { status: 'running', promptId: event.promptId, value: null, max: null }
            case 'progress':
              return {
                status: 'running',
                promptId: event.promptId ?? current?.promptId ?? null,
                value: event.value,
                max: event.max,
              }
            case 'execution_success':
              return { status: 'success', promptId: event.promptId, value: null, max: null }
            case 'execution_error':
              return { status: 'error', promptId: event.promptId, error: event.error }
            case 'execution_interrupted':
              return { status: 'interrupted', promptId: event.promptId }
            default:
              return current
          }
        })
      }, [])

      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let disposed = false
        let socket = null
        let retry = null
        let lastMessageAt = Date.now()
        const watchdog = setInterval(() => {
          if (disposed) return
          if (Date.now() - lastMessageAt > 120000) {
            try { socket.close() } catch { /* already closed */ }
          }
        }, 15000)
        const connect = () => {
          if (disposed) return
          const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
          const url = `${scheme}://${location.host}/comfyui/ws?clientId=dsh-${encodeURIComponent(sessionId)}`
          try {
            socket = new WebSocket(url)
          } catch {
            retry = setTimeout(connect, 3000)
            return
          }
          socket.onmessage = message => {
            lastMessageAt = Date.now()
            if (typeof message.data !== 'string') return
            let parsed
            try {
              parsed = JSON.parse(message.data)
            } catch {
              return
            }
            const event = mapComfyEvent(parsed)
            if (event === null) return
            applyEvent(event)
            postEvent(event)
          }
          socket.onclose = () => {
            if (!disposed) retry = setTimeout(connect, 3000)
          }
          socket.onerror = () => {
            try { socket.close() } catch { /* already closed */ }
          }
        }
        connect()
        return () => {
          disposed = true
          clearInterval(watchdog)
          if (retry !== null) clearTimeout(retry)
          if (socket !== null) {
            socket.onclose = null
            socket.onmessage = null
            try { socket.close() } catch { /* already closed */ }
          }
        }
      }, [applyEvent, postEvent, sessionId])

      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let disposed = false
        let timer
        const tick = async () => {
          if (disposed) return
          if (document.visibilityState !== 'visible') return
          const app = readApp()
          if (app === null) {
            setStatus(current => current === 'ready' ? 'loading' : current)
            return
          }
          try {
            const force = Date.now() - lastForcedAtRef.current > 30000
            if (force) lastForcedAtRef.current = Date.now()
            await push(app, force)
          } catch (error) {
            lastJsonRef.current = ''
            setStatus('error')
            setMessage(error instanceof Error ? error.message : String(error))
          }
        }
        timer = setInterval(() => { void tick() }, 1200)
        void tick()
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [push, readApp, sessionId])

      const reload = useCallback(() => {
        const frame = iframeRef.current
        if (frame === null) return
        lastJsonRef.current = ''
        appRef.current = null
        setRun(null)
        setStatus('loading')
        setMessage('')
        frame.src = PANEL_URL
      }, [])

      const open = useCallback(() => {
        window.open(PANEL_URL, '_blank', 'noopener')
      }, [])

      useEffect(() => {
        if (status !== 'loading') {
          setBootSeconds(0)
          return undefined
        }
        const started = Date.now()
        const timer = setInterval(() => {
          setBootSeconds(Math.round((Date.now() - started) / 1000))
        }, 1000)
        return () => clearInterval(timer)
      }, [status])

      let runText = ''
      if (run !== null) {
        if (run.status === 'queued') runText = t('queued')
        else if (run.status === 'running' && typeof run.value === 'number' && typeof run.max === 'number' && run.max > 0) {
          runText = t('running').replace('{{value}}', String(run.value)).replace('{{max}}', String(run.max))
        } else if (run.status === 'error') runText = t('runFailed')
        else if (run.status === 'interrupted') runText = t('runInterrupted')
      }

      if (sessionId === undefined || sessionId === null) {
        return h('div', { className: 'dsh-comfyui-panel' },
          h('style', null, CSS),
          h('div', { className: 'dsh-comfyui-notice' }, t('noSession')),
        )
      }

      return h('div', { className: 'dsh-comfyui-panel' },
        h('style', null, CSS),
        h(StatBar, {
          status,
          stats,
          message,
          runText,
          bootSeconds,
          t,
          onSync: () => { void syncRef.current?.(true) },
          onReload: reload,
          onOpen: open,
        }),
        message === '' ? null : h('div', { className: 'dsh-comfyui-notice', 'data-tone': status === 'error' ? 'error' : 'info' }, message),
        h('iframe', {
          ref: iframeRef,
          className: 'dsh-comfyui-frame',
          title: t('title'),
          src: PANEL_URL,
          allow: 'clipboard-read; clipboard-write; fullscreen',
          onLoad: () => {
            lastJsonRef.current = ''
            appRef.current = null
            setStatus('loading')
          },
        }),
      )
    }

    function OpenButton({ open, t }) {
      return h('button', {
        type: 'button',
        onClick: open,
        title: t('description'),
        style: {
          height: '24px',
          padding: '0 8px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          cursor: 'pointer',
        },
      }, t('title'))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-comfyui: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'workflow',
            order: 20,
            title: () => t('title'),
            description: () => t('description'),
          }],
        }), 'dsh-comfyui: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: sessionId => ({ sessionId }),
        }, ComfyPanel)), 'dsh-comfyui: tab body')
        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-comfyui-open',
          order: 25,
          locale: NS,
          inject: () => ({ open: () => ctx.sidebarRight.openTab(TAB_KIND) }),
        }, OpenButton)), 'dsh-comfyui: header action')
      },
    }
  },
})
