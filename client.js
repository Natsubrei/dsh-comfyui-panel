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
    const SERVICE_URL = '/api/comfyui/service'

    const en = {
      title: 'ComfyUI',
      description: 'Open the real ComfyUI editor in the right sidebar. Edits sync to the Host and are available to the model.',
      loading: 'Starting ComfyUI…',
      ready: 'Connected',
      syncing: 'Syncing…',
      error: 'Bridge error',
      sync: 'Sync',
      syncHint: 'Push the current graph to the model now',
      reload: 'Reload',
      reloadHint: 'Reload the embedded editor',
      fitView: 'Zoom to fit',
      modelEdited: 'Model edit',
      syncedAt: 'synced {{time}}',
      syncPending: 'syncing…',
      notRunning: 'ComfyUI is not running',
      open: 'Open in new tab',
      noSession: 'No session',
      stats: '{{nodes}} nodes · {{links}} links',
      statsTitle: '{{nodes}} nodes · {{links}} links · rev {{revision}}',
      editorLoading: 'Loading the editor…',
      bridgeUnavailable: 'ComfyUI did not expose its editor API. Check that the panel is served from /comfyui/.',
      syncFailed: 'Could not send the workflow to the Host.',
      // Not "Running": the server state already says that, and two "Running"
      // labels in one bar read as one contradictory sentence.
      running: 'Progress {{value}}/{{max}}',
      queued: 'Queued',
      runFailed: 'Run failed',
      runInterrupted: 'Run interrupted',
      serverRunning: 'ComfyUI running (pid {{pid}})',
      serverExternal: 'ComfyUI running (started outside the plugin)',
      serverStopped: 'ComfyUI is not running',
      serverStarting: 'Starting ComfyUI…',
      serverDir: 'ComfyUI directory',
      serverDirHint: 'The folder that contains main.py',
      serverAutoStart: 'Start with DSH',
      serverStart: 'Start',
      serverStop: 'Stop',
      serverRestart: 'Restart',
      serverSave: 'Save settings',
      serverFailed: 'Could not control ComfyUI',
      serverStartFailed: 'ComfyUI did not start',
      serverExternalHint: 'This ComfyUI was not started by the plugin, so Stop and Restart are unavailable. Restart it where it was launched.',
      serverNotOwned: 'Not managed by this plugin',
      serverPick: 'Pick the ComfyUI folder, then start it here.',
      serverPanel: 'Server settings',
      close: 'Close',
      barRunning: 'Running',
      barExternal: 'External',
      barStopped: 'Stopped',
      barStarting: 'Starting…',
      barFailed: 'Start failed',
      barUnknown: 'Checking…',
      barConnecting: 'connecting…',
    }
    const zh = {
      title: 'ComfyUI',
      description: '在右侧栏打开真实的 ComfyUI 编辑器；改动会同步到 Host，模型可以直接读取和修改。',
      loading: '正在启动 ComfyUI…',
      ready: '已连接',
      syncing: '同步中…',
      error: '桥接错误',
      sync: '同步',
      syncHint: '立即把当前工作流推给模型',
      reload: '重载',
      reloadHint: '重新加载内嵌编辑器',
      fitView: '缩放以适应',
      modelEdited: '模型修改',
      syncedAt: '已同步 {{time}}',
      syncPending: '同步中…',
      notRunning: 'ComfyUI 未运行',
      open: '新标签打开',
      noSession: '无会话',
      stats: '{{nodes}} 个节点 · {{links}} 条连线',
      statsTitle: '{{nodes}} 个节点 · {{links}} 条连线 · rev {{revision}}',
      editorLoading: '正在加载编辑器…',
      bridgeUnavailable: 'ComfyUI 没有暴露编辑器 API。请确认面板是通过 /comfyui/ 同源加载的。',
      syncFailed: '工作流未能发送到 Host。',
      running: '进度 {{value}}/{{max}}',
      queued: '排队中',
      runFailed: '运行失败',
      runInterrupted: '运行已中断',
      serverRunning: 'ComfyUI 运行中（pid {{pid}}）',
      serverExternal: 'ComfyUI 在运行（外部启动）',
      serverStopped: 'ComfyUI 未运行',
      serverStarting: '正在启动 ComfyUI…',
      serverDir: 'ComfyUI 目录',
      serverDirHint: '包含 main.py 的那个目录',
      serverAutoStart: '随 DSH 启动',
      serverStart: '启动',
      serverStop: '停止',
      serverRestart: '重启',
      serverSave: '保存设置',
      serverFailed: '无法控制 ComfyUI',
      serverStartFailed: '启动失败',
      serverExternalHint: '这个 ComfyUI 不是插件启动的，停止和重启不可用；请到启动它的地方重启。',
      serverNotOwned: '不归本插件管理',
      serverPick: '选好 ComfyUI 目录后，在这里启动它。',
      serverPanel: '服务设置',
      close: '关闭',
      barRunning: '运行中',
      barExternal: '外部运行',
      barStopped: '未启动',
      barStarting: '启动中…',
      barFailed: '启动失败',
      barUnknown: '检查中…',
      barConnecting: '连接中…',
    }

    const CSS = `
      .dsh-comfyui-panel {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font: 12px/1.4 var(--dsw-font-family, system-ui, sans-serif);
      }
      .dsh-comfyui-bar {
        /* The ComfyUI editor brings its own 40 px toolbar right below this
           one; keeping ours to one 26 px line leaves the graph the space. */
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
        min-height: 26px; padding: 1px 8px;
        font-size: 11px; line-height: 18px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        flex: 0 0 auto;
      }
      .dsh-comfyui-bar .dsh-comfyui-button { height: 20px; padding: 0 6px; }
      .dsh-comfyui-bar .dsh-comfyui-icon { width: 22px; }
      .dsh-comfyui-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--dsw-alias-state-idle-primary);
        flex: 0 0 auto;
      }
      .dsh-comfyui-dot[data-status="ok"] { background: var(--dsw-alias-state-success-primary); }
      .dsh-comfyui-dot[data-status="warn"] { background: var(--dsw-alias-state-warn-primary); }
      .dsh-comfyui-dot[data-status="error"] { background: var(--dsw-alias-state-error-primary); }
      .dsh-comfyui-state { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dsh-comfyui-state[data-tone="ok"] { color: var(--dsw-alias-label-primary); }
      .dsh-comfyui-state[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
      .dsh-comfyui-state[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
      .dsh-comfyui-run {
        color: var(--dsw-alias-state-warn-primary);
        white-space: nowrap;
      }
      .dsh-comfyui-stats {
        /* basis 0, not auto: the line only wraps when the buttons themselves
           stop fitting, otherwise the counters truncate instead. */
        flex: 1 1 0; min-width: 0; text-align: right;
        color: var(--dsw-alias-label-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      /* The lifecycle controls sit next to the state they act on, so the bar
         reads "Running [Stop] [Restart]   counters │ sync reload open gear".
         Order inside a bar is not decoration: the most-clicked control stays
         on the first line even when the bar wraps, and the panel utilities
         keep the corner because they are the least-used and the least
         dangerous to hit by accident. */
      .dsh-comfyui-actions, .dsh-comfyui-tools {
        display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
      }
      .dsh-comfyui-actions { margin-left: 2px; }
      .dsh-comfyui-tools {
        margin-left: auto; padding-left: 8px;
        border-left: 1px solid var(--dsw-alias-border-l1);
      }
      .dsh-comfyui-button {
        height: 22px; padding: 0 7px; border-radius: 5px; cursor: pointer;
        flex: 0 0 auto;
        border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit;
      }
      .dsh-comfyui-button:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .dsh-comfyui-button:disabled { opacity: .45; cursor: default; }
      .dsh-comfyui-button[data-variant="primary"] {
        border-color: transparent;
        background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .dsh-comfyui-button[data-variant="primary"]:hover:not(:disabled) {
        background: var(--dsw-alias-button-primary-hover);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .dsh-comfyui-icon {
        width: 24px; padding: 0;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .dsh-comfyui-icon[data-active="true"] {
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      }
      .dsh-comfyui-button:focus-visible {
        outline: 1px solid var(--dsw-alias-brand-primary);
        outline-offset: 2px;
      }
      .dsh-comfyui-stage { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
      .dsh-comfyui-frame { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 0; background: #111; }
      .dsh-comfyui-overlay {
        position: absolute; inset: 0; z-index: 1;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-base);
        font-size: 13px;
      }
      .dsh-comfyui-toast {
        position: absolute; left: 50%; top: 10px; transform: translateX(-50%);
        z-index: 2; max-width: calc(100% - 24px);
        padding: 6px 12px; border-radius: 999px;
        background: rgba(37, 99, 235, .94); color: #fff;
        font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        box-shadow: 0 2px 10px rgba(0, 0, 0, .28);
        pointer-events: none;
      }
      .dsh-comfyui-empty { flex-direction: column; gap: 10px; }
      .dsh-comfyui-empty-title { color: var(--dsw-alias-label-primary); font-size: 13px; }
      .dsh-comfyui-spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l1);
        border-top-color: var(--dsw-alias-brand-primary);
        animation: dsh-comfyui-spin .8s linear infinite;
      }
      @keyframes dsh-comfyui-spin { to { transform: rotate(360deg); } }
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
      .dsh-comfyui-service {
        display: flex; flex-direction: column; gap: 6px;
        margin: 8px 10px 0; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-comfyui-service-head {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .dsh-comfyui-service-state { margin-right: auto; color: var(--dsw-alias-label-primary); }
      .dsh-comfyui-service-field {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .dsh-comfyui-service-field > span { min-width: 90px; }
      .dsh-comfyui-service-input {
        flex: 1 1 220px; min-width: 0; height: 24px;
        padding: 0 8px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font: inherit;
      }
      .dsh-comfyui-service-input:focus-visible {
        outline: 1px solid var(--dsw-alias-brand-primary);
        outline-offset: 1px;
      }
      .dsh-comfyui-service-check {
        display: flex; align-items: center; gap: 6px; cursor: pointer;
      }
      .dsh-comfyui-service-action { width: fit-content; }
      .dsh-comfyui-service-message { color: var(--dsw-alias-state-error-primary); }
      .dsh-comfyui-service-hint { color: var(--dsw-alias-label-secondary); }
    `

    /**
     * Turn the bridge status plus the service snapshot into what the top bar
     * shows: one status label, one tone, and the lifecycle buttons that fit it.
     *
     * Start/Stop/Restart live here because they are the clicks this panel
     * exists for; the Server form is configuration only. Keeping the rule in a
     * pure function means the interesting part (which button, enabled or not,
     * and why) is covered by test/client-ops.mjs instead of only by eye.
     */
    function barPlan({ status, service, busy = false, dir = '', bootSeconds = 0, t }) {
      const known = service !== null && service !== undefined
      const healthy = known && service.health === true
      const owned = known && service.owned === true
      const state = known ? service.state : null
      const pid = known && service.pid !== null && service.pid !== undefined ? String(service.pid) : ''
      const starting = state === 'starting' || state === 'restarting'
      const failed = state === 'failed'
      const canWrite = known && busy !== true
      const needDir = String(dir).trim() === ''

      // A dead ComfyUI keeps its last bridge state until the iframe reloads, so
      // the backend leads: the bridge is only appended when the two disagree.
      let tone = 'idle'
      let label = t('barUnknown')
      let chipTitle = ''
      if (known && starting) {
        tone = 'warn'
        label = t('barStarting')
        chipTitle = t('serverStarting')
      } else if (known && failed) {
        tone = 'error'
        label = t('barFailed')
        chipTitle = t('serverStartFailed')
      } else if (healthy) {
        tone = status === 'ready' ? 'ok' : status === 'error' ? 'error' : 'warn'
        label = owned ? t('barRunning') : t('barExternal')
        chipTitle = owned
          ? t('serverRunning').replace('{{pid}}', pid === '' ? '?' : pid)
          : t('serverExternal')
        if (status !== 'ready') {
          const bridge = status === 'error'
            ? t('error')
            : bootSeconds > 0 ? `${t('barConnecting')} ${bootSeconds}s` : t('barConnecting')
          label = `${label} · ${bridge}`
        }
      } else if (known) {
        label = t('barStopped')
        chipTitle = needDir ? t('serverPick') : t('serverStopped')
      }

      const actions = []
      const add = (action, text, variant, disabled, title) => {
        actions.push({ action, label: text, variant, disabled, title })
      }
      if (!known) {
        add('start', t('serverStart'), 'primary', true, '')
      } else if (starting) {
        add('start', t('barStarting'), 'primary', true, t('serverStarting'))
      } else if (!healthy) {
        add('start', t('serverStart'), 'primary', !canWrite || needDir,
          needDir ? t('serverPick') : failed ? t('serverStartFailed') : t('serverStart'))
      } else if (owned) {
        add('stop', t('serverStop'), 'quiet', !canWrite, t('serverStop'))
        add('restart', t('serverRestart'), 'quiet', !canWrite, t('serverRestart'))
      } else {
        // An external server is healthy but untouchable; say so on hover
        // instead of hiding the control and leaving the state unexplained.
        add('restart', t('serverRestart'), 'quiet', true, t('serverExternalHint') || t('serverNotOwned'))
      }

      return { tone, label, chipTitle, actions, healthy, owned }
    }

    function TopBar({ stats, synced, runText, plan, serviceOpen, onSync, onReload, onFit, onOpen, onService, onAction, t }) {
      const counts = t('stats')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
      const statText = [counts, synced].filter(part => part.length > 0).join(' · ')
      // The revision is bookkeeping for the Host and the model, not a number
      // a ComfyUI user can act on; keep it in the tooltip instead of the bar.
      const statTitle = t('statsTitle')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
        .replace('{{revision}}', String(stats.revision))
      return h('div', { className: 'dsh-comfyui-bar' },
        h('span', { className: 'dsh-comfyui-dot', 'data-status': plan.tone, title: plan.chipTitle }),
        h('span', { className: 'dsh-comfyui-state', 'data-tone': plan.tone, title: plan.chipTitle }, plan.label),
        // State first, its controls second, counters after: the server switch
        // is the click this bar exists for, and putting it here keeps it on
        // the first line when a narrow panel makes the bar wrap.
        h('div', { className: 'dsh-comfyui-actions' },
          plan.actions.map(action => h('button', {
            key: action.action,
            className: 'dsh-comfyui-button',
            'data-variant': action.variant,
            type: 'button',
            disabled: action.disabled,
            title: action.title,
            onClick: () => onAction(action.action),
          }, action.label)),
        ),
        runText === '' ? null : h('span', { className: 'dsh-comfyui-run' }, runText),
        h('span', { className: 'dsh-comfyui-stats', title: statTitle }, statText),
        h('div', { className: 'dsh-comfyui-tools' },
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            type: 'button',
            title: t('fitView'),
            'aria-label': t('fitView'),
            onClick: onFit,
          }, '\u2922'),
          h('button', { className: 'dsh-comfyui-button', type: 'button', title: t('syncHint'), onClick: onSync }, t('sync')),
          h('button', { className: 'dsh-comfyui-button', type: 'button', title: t('reloadHint'), onClick: onReload }, t('reload')),
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            type: 'button',
            title: t('open'),
            'aria-label': t('open'),
            onClick: onOpen,
          }, '\u2197'),
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            'data-active': serviceOpen ? 'true' : 'false',
            type: 'button',
            title: t('serverPanel'),
            'aria-label': t('serverPanel'),
            'aria-expanded': serviceOpen,
            onClick: onService,
          }, '\u2699\uFE0E'),
        ),
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

    /**
     * The client id the embedded ComfyUI frontend is connected with.
     *
     * ComfyUI addresses execution events to the client that queued the prompt
     * (`server.send_sync(..., server.client_id)`), and its API stores the id
     * the server assigned in `window.name` and `sessionStorage`. A Host-queued
     * prompt has to carry the same id, or the run happens with no queue entry,
     * no node progress, no preview, and nothing in the panel's history.
     */
    function frontendClientId(win) {
      const usable = value => typeof value === 'string' && /^[0-9a-z]{8,64}$/i.test(value)
      if (win === null || win === undefined) return null
      try {
        if (usable(win.name)) return win.name
        const stored = win.sessionStorage?.getItem('clientId')
        if (usable(stored)) return stored
      } catch {
        // Cross-origin iframe or blocked storage: the Host falls back to its
        // own client id, and the run stays invisible to the UI.
      }
      return null
    }

    function findNode(graph, id) {
      if (typeof graph.getNodeById === 'function') return graph.getNodeById(id)
      // Node ids may be strings (see projectGraph); compare numerically.
      const wanted = Number(id)
      return graph._nodes_by_id?.[id]
        ?? graph._nodes_by_id?.[wanted]
        ?? (Array.isArray(graph._nodes) ? graph._nodes.find(node => Number(node.id) === wanted) : undefined)
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

    /** The command ComfyUI's own "zoom to fit" button runs. */
    const FIT_COMMAND = 'Comfy.Canvas.FitView'

    /** Visible graph rect for the live camera; `screen = (graph + offset) * scale`. */
    function visibleRect(canvas) {
      const ds = canvas?.ds
      const element = canvas?.canvas
      const width = element?.clientWidth ?? 0
      const height = element?.clientHeight ?? 0
      if (ds === null || ds === undefined || width <= 0 || height <= 0) return null
      const scale = Number(ds.scale) > 0 ? Number(ds.scale) : 1
      const offsetX = Number(ds.offset?.[0])
      const offsetY = Number(ds.offset?.[1])
      if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null
      return {
        width,
        height,
        scale,
        left: -offsetX,
        top: -offsetY,
        right: width / scale - offsetX,
        bottom: height / scale - offsetY,
      }
    }

    /** Graph-space bounds of every node, ignoring anything without geometry. */
    function nodeBounds(graph) {
      const nodes = Array.isArray(graph?._nodes) ? graph._nodes : []
      const at = (pair, index) => (pair !== null && pair !== undefined ? Number(pair[index]) : Number.NaN)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const node of nodes) {
        const x = at(node?.pos, 0)
        const y = at(node?.pos, 1)
        const w = at(node?.size, 0)
        const h = at(node?.size, 1)
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x + w)
        maxY = Math.max(maxY, y + h)
      }
      if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null
      return { minX, minY, maxX, maxY }
    }

    /** Whether the current camera already shows every node. */
    function viewShowsAll(app) {
      const view = visibleRect(app?.canvas)
      const bounds = nodeBounds(app?.rootGraph ?? app?.graph)
      if (view === null || bounds === null) return false
      const margin = (view.right - view.left) * 0.02
      return bounds.minX >= view.left + margin && bounds.maxX <= view.right - margin
        && bounds.minY >= view.top + margin && bounds.maxY <= view.bottom - margin
    }

    /**
     * Frame the graph the way ComfyUI itself does: run its `FitView` command,
     * which is the exact code path behind the editor's own zoom-to-fit button
     * and therefore respects its margins, sidebars, and selection rules. The
     * bounding-box fallback uses the same camera semantics
     * (`screen = (graph + offset) * scale`) for frontends without commands.
     */
    async function fitCanvas(app) {
      const command = app?.extensionManager?.command
      if (typeof command?.execute === 'function') {
        try {
          await command.execute(FIT_COMMAND)
          return true
        } catch {
          // Fall through to the local fit.
        }
      }
      return fitCanvasByBounds(app)
    }

    /** Local fallback: fit the nodes' bounding box into the visible area. */
    function fitCanvasByBounds(app) {
      const canvas = app?.canvas
      const ds = canvas?.ds
      const view = visibleRect(canvas)
      const bounds = nodeBounds(app?.rootGraph ?? app?.graph)
      if (ds === null || ds === undefined || view === null || bounds === null) return false
      const graphWidth = bounds.maxX - bounds.minX
      const graphHeight = bounds.maxY - bounds.minY
      const scale = Math.min(view.width / graphWidth, view.height / graphHeight) * 0.9
      ds.scale = Math.max(ds.min_scale ?? 0.1, Math.min(ds.max_scale ?? 10, scale))
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      ds.offset = [
        view.width / (2 * ds.scale) - centerX,
        view.height / (2 * ds.scale) - centerY,
      ]
      canvas.setDirty?.(true, true)
      return true
    }

    /**
     * Outline the nodes a model edit touched for a moment. The highlight is a
     * canvas overlay, not `node.color`, because node colors serialize and
     * would turn a cosmetic flash into a workflow revision.
     */
    function flashNodes(app, ids) {
      if (ids === undefined || ids.size === 0) return
      const canvas = app.canvas
      if (canvas === null || canvas === undefined || typeof canvas.setDirty !== 'function') return
      const previous = canvas.onDrawForeground
      const until = Date.now() + 1600
      canvas.onDrawForeground = function drawEditHighlight(ctx, graph) {
        if (typeof previous === 'function') previous.call(this, ctx, graph)
        if (Date.now() > until) {
          canvas.onDrawForeground = previous
          return
        }
        const scale = this.ds?.scale ?? 1
        ctx.save()
        ctx.strokeStyle = 'rgba(96, 165, 250, .95)'
        ctx.lineWidth = 3 / scale
        for (const node of Array.isArray(graph?._nodes) ? graph._nodes : []) {
          if (!ids.has(Number(node.id))) continue
          const x = Number(node.pos?.[0])
          const y = Number(node.pos?.[1])
          const w = Number(node.size?.[0])
          const h = Number(node.size?.[1])
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
          const pad = 5 / scale
          ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2)
        }
        ctx.restore()
        this.setDirty(true, false)
      }
      canvas.setDirty(true, true)
    }

    /** One short, human-readable line per model edit, for the panel toast. */
    function describeOperation(operation, result) {
      switch (operation?.op) {
        case 'add_node':
          return `+${result?.type ?? operation.type ?? '?'} #${result?.id ?? '?'}`
        case 'remove_node':
          return `-${operation.id}`
        case 'set_widget':
          return `#${operation.id}.${operation.name}=${JSON.stringify(operation.value)}`
        case 'connect':
          return `#${operation.from?.id}:${operation.from?.output}→#${operation.to?.id}.${operation.to?.input}`
        case 'disconnect':
          return `#${operation.to?.id}.${operation.to?.input} ×`
        default:
          return String(operation?.op ?? '?')
      }
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
        // LiteGraph 0.4x keeps node ids and link endpoints as strings while
        // the serialized workflow writes numbers; the Host contract is
        // numeric, so normalize here instead of dropping every node.
        const id = Number(node.id)
        if (!Number.isSafeInteger(id) || typeof node.type !== 'string') continue
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
          const originId = Number(link.origin_id)
          const originSlot = Number(link.origin_slot)
          if (!Number.isSafeInteger(originId) || !Number.isSafeInteger(originSlot)) continue
          inputs[String(input.name)] = `${originId}:${originSlot}`
        }
        const entry = { id, type: node.type, widgets, inputs }
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
      // connect/disconnect name their target either as `id` or as `to.id`; both
      // spellings reach the same node, so a caller that only reads the shape of
      // `to` still lands on the right slot.
      const linking = op === 'connect' || op === 'disconnect'
      const targetId = linking && !Number.isInteger(operation.id) ? operation.to?.id : operation.id
      const node = findNode(graph, targetId)
      if (node === undefined || node === null) {
        throw new Error(linking
          ? `Target node ${targetId ?? '(missing)'} not found; ${op} needs "id" or "to.id"`
          : `Node ${operation.id} not found`)
      }
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
      const lastClientIdRef = useRef(null)
      const fittedRef = useRef(false)
      const [status, setStatus] = useState('loading')
      const [bootSeconds, setBootSeconds] = useState(0)
      const [stats, setStats] = useState({ nodes: 0, links: 0, revision: 0 })
      const [message, setMessage] = useState('')
      const [run, setRun] = useState(null)
      const [lastSyncAt, setLastSyncAt] = useState(0)
      const [notice, setNotice] = useState(null)
      const eventRef = useRef({ pending: null, timer: null, sentAt: 0 })
      const syncRef = useRef(null)
      const reloadRef = useRef(null)
      const serviceDraftRef = useRef({ loaded: false })
      const lastServiceHealthRef = useRef(null)
      const [service, setService] = useState(null)
      const [serviceOpen, setServiceOpen] = useState(false)
      const [serviceCwd, setServiceCwd] = useState('')
      const [serviceAutoStart, setServiceAutoStart] = useState(false)
      const [serviceBusy, setServiceBusy] = useState(false)
      const [serviceMessage, setServiceMessage] = useState('')

      const readApp = useCallback(() => {
        const win = iframeRef.current?.contentWindow
        const app = win?.comfyAPI?.app?.app
        if (app === undefined || app === null) return null
        appRef.current = app
        return app
      }, [])

      const loadService = useCallback(async () => {
        try {
          const response = await fetch(SERVICE_URL)
          if (!response.ok) return
          const data = await response.json()
          if (data?.ok !== true) return
          setService(data)
          if (!serviceDraftRef.current.loaded) {
            serviceDraftRef.current.loaded = true
            setServiceCwd(data.settings?.cwd ?? data.detected ?? '')
            setServiceAutoStart(data.settings?.autoStart === true)
          }
        } catch {
          // The Host may be restarting; the next poll retries.
        }
      }, [])

      const serviceAction = useCallback(async (action) => {
        setServiceBusy(true)
        setServiceMessage('')
        try {
          const body = { action }
          if (action === 'save' || action === 'start') {
            body.settings = { cwd: serviceCwd.trim(), autoStart: serviceAutoStart }
          }
          const response = await fetch(SERVICE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data?.ok !== true) throw new Error(data?.error ?? `HTTP ${response.status}`)
          setService(data)
          serviceDraftRef.current.loaded = true
          if (data.settings) {
            setServiceCwd(data.settings.cwd)
            setServiceAutoStart(data.settings.autoStart === true)
          }
        } catch (error) {
          setServiceMessage(`${t('serverFailed')}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setServiceBusy(false)
        }
      }, [serviceAutoStart, serviceCwd, t])

      const push = useCallback(async (app, force = false) => {
        if (sessionId === undefined || sessionId === null) return
        const graph = app.rootGraph ?? app.graph
        if (graph === undefined || graph === null || typeof graph.serialize !== 'function') {
          throw new Error(t('bridgeUnavailable'))
        }
        // ComfyUI addresses execution events to the client that queued the
        // prompt, so the Host has to queue as this iframe or the run never
        // appears in the panel's own queue, previews, or history.
        const frameClient = frontendClientId()
        if (frameClient !== lastClientIdRef.current) {
          lastClientIdRef.current = frameClient
          force = true
        }
        const workflow = JSON.parse(JSON.stringify(graph.serialize()))
        // The frontend stamps `extra.ds` (zoom and pan) on every serialization,
        // so scrolling, zooming, or resizing the panel would otherwise look
        // like an edit and grow the revision the model reads.
        if (workflow.extra !== null && typeof workflow.extra === 'object') {
          delete workflow.extra.ds
          if (Object.keys(workflow.extra).length === 0) delete workflow.extra
        }
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
          body: JSON.stringify({ sessionId, workflow, prompt, semantic, revision, clientId: frameClient }),
        })
        if (!response.ok) throw new Error(`${t('syncFailed')} HTTP ${response.status}`)
        // The Host keeps the revision monotonic across page reloads, so adopt
        // its number: showing the page-local counter made the panel say rev 14
        // while the same workflow read rev 49 from the model side.
        const saved = await response.json().catch(() => null)
        const persisted = Number.isSafeInteger(saved?.revision) ? saved.revision : revision
        revisionRef.current = Math.max(revisionRef.current, persisted)
        setStats({ nodes, links, revision: revisionRef.current })
        setLastSyncAt(Date.now())
        // A fresh editor opens at ComfyUI's default camera, which leaves parts
        // of the graph off-screen; frame it once, unless the current view
        // already shows every node.
        setStatus('ready')
        if (!fittedRef.current && visibleRect(app.canvas) !== null
          && nodeBounds(app.rootGraph ?? app.graph) !== null) {
          // Run the same fit ComfyUI's own zoom-to-fit button runs, only when
          // the current camera does not already contain every node. The
          // frontend restores the workflow camera shortly after the graph
          // loads and can land on top of the first fit, so check twice.
          fittedRef.current = true
          void (async () => {
            try {
              for (let attempt = 0; attempt < 2 && !viewShowsAll(app); attempt += 1) {
                await fitCanvas(app)
                await new Promise(resolve => setTimeout(resolve, 700))
              }
            } catch {
              // A node without a usable pos/size must not fail the sync.
            }
          })()
        }
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
        const touched = new Set()
        const parts = []
        for (const operation of operations) {
          const result = applyOperation({ graph, LiteGraph, app, operation })
          applied.push(result)
          const ids = [operation?.id, result?.id, operation?.to?.id, operation?.from?.id]
          for (const id of ids) if (Number.isSafeInteger(Number(id))) touched.add(Number(id))
          parts.push(describeOperation(operation, result))
        }
        graph.setDirtyCanvas?.(true, true)
        setNotice({ text: `${t('modelEdited')}: ${parts.join(' · ')}`, at: Date.now() })
        flashNodes(app, touched)
        await syncNow(true)
        return { applied: applied.length, operations: applied }
      }, [syncNow, t])

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

      useEffect(() => {
        let disposed = false
        void loadService()
        const timer = setInterval(() => {
          if (!disposed && document.visibilityState === 'visible') void loadService()
        }, 5000)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [loadService])

      const reload = useCallback(() => {
        const frame = iframeRef.current
        if (frame === null) return
        lastJsonRef.current = ''
        appRef.current = null
        fittedRef.current = false
        setRun(null)
        setStatus('loading')
        setMessage('')
        frame.src = PANEL_URL
      }, [])
      reloadRef.current = reload

      // Starting ComfyUI from the panel brings the iframe back without a click:
      // a false -> true health transition reloads the embedded frontend.
      useEffect(() => {
        if (service === null) return
        const previous = lastServiceHealthRef.current
        lastServiceHealthRef.current = service.health === true
        if (previous === false && service.health === true) reloadRef.current?.()
      }, [service])

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

      // A model edit is announced once and fades; it is a glance, not a log.
      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 4500)
        return () => clearTimeout(timer)
      }, [notice])

      // Fixed 24-hour HH:MM: `toLocaleTimeString` can grow "12:59 PM" or a
      // localized 上午/下午 marker and wrap a narrow bar.
      const syncTime = new Date(lastSyncAt)
      const syncClock = `${String(syncTime.getHours()).padStart(2, '0')}:${String(syncTime.getMinutes()).padStart(2, '0')}`
      const syncLabel = status === 'syncing'
        ? t('syncPending')
        : (lastSyncAt > 0 ? t('syncedAt').replace('{{time}}', syncClock) : '')
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

      // Lifecycle controls live in the bar; this form is configuration only, so
      // there is exactly one place that decides whether Start is clickable.
      const plan = barPlan({ status, service, busy: serviceBusy, dir: serviceCwd, bootSeconds, t })
      const serviceStopped = service !== null && service.health === false && service.state !== 'starting'
      const dir = serviceCwd.trim()
      const notOwnedHint = plan.healthy && !plan.owned ? t('serverExternalHint') : ''
      const dirHint = !plan.healthy && dir === '' ? t('serverPick') : ''
      const severity = service !== null && service.controllerError !== null && service.controllerError !== undefined
      const servicePanel = h('div', { className: 'dsh-comfyui-service' },
        h('div', { className: 'dsh-comfyui-service-head' },
          h('span', { className: 'dsh-comfyui-service-state' }, t('serverPanel')),
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            type: 'button',
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => setServiceOpen(false),
          }, '\u00d7'),
        ),
        notOwnedHint === '' ? null : h('div', { className: 'dsh-comfyui-service-hint' }, notOwnedHint),
        h('label', { className: 'dsh-comfyui-service-field' },
          h('span', null, t('serverDir')),
          h('input', {
            className: 'dsh-comfyui-service-input',
            value: serviceCwd,
            placeholder: t('serverDirHint'),
            spellCheck: false,
            disabled: serviceBusy,
            onChange: event => setServiceCwd(event.target.value),
          }),
        ),
        h('label', { className: 'dsh-comfyui-service-check' },
          h('input', {
            type: 'checkbox',
            checked: serviceAutoStart,
            disabled: serviceBusy,
            onChange: event => setServiceAutoStart(event.target.checked),
          }),
          h('span', null, t('serverAutoStart')),
        ),
        h('div', { className: 'dsh-comfyui-service-head' },
          h('button', {
            className: 'dsh-comfyui-button',
            type: 'button',
            disabled: serviceBusy || dir === '',
            onClick: () => { void serviceAction('save') },
          }, t('serverSave')),
          dirHint === '' ? null : h('span', { className: 'dsh-comfyui-service-hint' }, dirHint),
        ),
        serviceMessage === '' ? null : h('div', { className: 'dsh-comfyui-service-message' }, serviceMessage),
        severity ? h('div', { className: 'dsh-comfyui-service-message' }, String(service.controllerError)) : null,
        service !== null && typeof service.lastError === 'string' && service.lastError !== ''
          ? h('div', { className: 'dsh-comfyui-service-message' }, service.lastError)
          : null,
      )

      return h('div', { className: 'dsh-comfyui-panel' },
        h('style', null, CSS),
        h(TopBar, {
          stats,
          synced: syncLabel,
          runText,
          plan,
          serviceOpen,
          t,
          onSync: () => { void syncRef.current?.(true) },
          onReload: reload,
          onFit: () => {
            const app = readApp()
            if (app !== null) void fitCanvas(app).catch(() => {})
          },
          onOpen: open,
          onService: () => setServiceOpen(current => !current),
          onAction: action => { void serviceAction(action) },
        }),
        message === '' ? null : h('div', { className: 'dsh-comfyui-notice', 'data-tone': status === 'error' ? 'error' : 'info' }, message),
        // Explicit-only: an unhealthy upstream must not force this form open
        // and resize the panel; the gear button in the bar carries that
        // affordance.
        serviceOpen ? servicePanel : null,
        h('div', { className: 'dsh-comfyui-stage' },
          h('iframe', {
            ref: iframeRef,
            className: 'dsh-comfyui-frame',
            title: t('title'),
            src: PANEL_URL,
            allow: 'clipboard-read; clipboard-write; fullscreen',
            onLoad: () => {
              lastJsonRef.current = ''
              appRef.current = null
              fittedRef.current = false
              setStatus('loading')
            },
          }),
          // The iframe paints ComfyUI's own splash first; without this the
          // panel looks stuck on a white rectangle while the frontend boots.
          status === 'loading'
            ? h('div', { className: 'dsh-comfyui-overlay' },
              h('span', { className: 'dsh-comfyui-spinner' }),
              h('span', null, bootSeconds > 0 ? `${t('editorLoading')} ${bootSeconds}s` : t('editorLoading')),
            )
            : serviceStopped
              ? h('div', { className: 'dsh-comfyui-overlay dsh-comfyui-empty' },
                h('span', { className: 'dsh-comfyui-empty-title' }, t('notRunning')),
                h('button', {
                  className: 'dsh-comfyui-button',
                  'data-variant': 'primary',
                  type: 'button',
                  disabled: serviceBusy || serviceCwd.trim() === '',
                  title: serviceCwd.trim() === '' ? t('serverPick') : t('serverStart'),
                  onClick: () => { void serviceAction('start') },
                }, t('serverStart')),
              )
              : null,
          notice === null ? null : h('div', { className: 'dsh-comfyui-toast' }, notice.text),
        ),
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
      // Pure editor operations, dictionaries and the top-bar rules, exposed for
      // test/client-ops.mjs. The Host loader reads only `inject` and `apply`.
      __ops: { applyOperation, findNode, coerceWidgetValue, frontendClientId, barPlan, projectGraph, fitCanvas, fitCanvasByBounds, viewShowsAll, describeOperation, en, zh },
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
