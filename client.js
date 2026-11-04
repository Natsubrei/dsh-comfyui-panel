/**
 * Browser half of the dsh-comfyui P0 bundle.
 *
 * The right-sidebar tab hosts the real ComfyUI frontend in a same-origin
 * iframe. Because the Host proxies ComfyUI under `/comfyui/`, the parent page
 * can reach `iframe.contentWindow.comfyAPI.app.app`, serialize the UI
 * workflow, ask the editor for its API prompt, and POST both to the Host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-comfyui-panel',
  /**
   * @param {(id: string) => any} require - the loader's dependency resolver, not
   *   the CommonJS global: React arrives as a dependency, not an installed module.
   */
  factory(require) {
    // React is injected by the Host's loader, not installed, so this local
    // alias keeps the type checker from looking for its package.
    /** @type {(id: string) => any} */
    const load = require
    const React = load('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dshComfyUI'
    const TAB_ID = 'dsh-comfyui-panel/workflow'
    const TAB_KIND = 'comfyui'
    const PANEL_URL = '/comfyui/'
    const INTERRUPT_URL = `${PANEL_URL}interrupt`
    /** How long a successful Cancel waits for its event before re-enabling. */
    const CANCEL_FALLBACK_MS = 10_000
    const STATE_URL = '/api/comfyui/state'
    const EVENT_URL = '/api/comfyui/events'
    const COMMAND_POLL_URL = '/api/comfyui/commands/poll'
    const COMMAND_RESULT_URL = '/api/comfyui/commands/result'
    const SERVICE_URL = '/api/comfyui/service'

    const en = {
      title: 'ComfyUI',
      description: 'ComfyUI, shared with the model',
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
      editorStalled: 'The editor did not load',
      editorStalledHint: 'ComfyUI answers, but the frontend never exposed its editor. Reload it, or start the server again from Server settings.',
      open: 'Open in new tab',
      noSession: 'No session',
      stats: '{{nodes}} nodes · {{links}} links',
      statsTitle: '{{nodes}} nodes · {{links}} links · rev {{revision}}',
      editorLoading: 'Loading the editor…',
      bridgeUnavailable: 'ComfyUI did not expose its editor API. Check that the panel is served from /comfyui/.',
      frontendUnverified: 'ComfyUI frontend {{installed}} is not the verified {{expected}}. Runs and edits may not show up.',
      syncFailed: 'Could not send the workflow to the Host.',
      // Not "Running": the server state already says that, and two "Running"
      // labels in one bar read as one contradictory sentence.
      queued: 'Queued',
      runNode: 'node {{node}}',
      runSeconds: '{{seconds}}s',
      runFailed: 'Run failed',
      runInterrupted: 'Run interrupted',
      runCancel: 'Cancel',
      runCancelling: 'Cancelling…',
      runCancelFailed: 'Could not cancel the run',
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
      description: '与模型共用的 ComfyUI',
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
      editorStalled: '编辑器没有加载出来',
      editorStalledHint: 'ComfyUI 有响应，但前端一直没有交出编辑器。可以重新加载；如果仍不行，到「服务设置」里重启服务。',
      open: '新标签打开',
      noSession: '无会话',
      stats: '{{nodes}} 个节点 · {{links}} 条连线',
      statsTitle: '{{nodes}} 个节点 · {{links}} 条连线 · rev {{revision}}',
      editorLoading: '正在加载编辑器…',
      bridgeUnavailable: 'ComfyUI 没有暴露编辑器 API。请确认面板是通过 /comfyui/ 同源加载的。',
      frontendUnverified: '当前 ComfyUI 前端是 {{installed}}，本面板只验证过 {{expected}}。运行和编辑可能不会显示。',
      syncFailed: '工作流未能发送到 Host。',
      queued: '排队中',
      runNode: '节点 {{node}}',
      runSeconds: '{{seconds}} 秒',
      runFailed: '运行失败',
      runInterrupted: '运行已中断',
      runCancel: '取消',
      runCancelling: '正在取消…',
      runCancelFailed: '取消运行失败',
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
      .dsh-comfyui-preview {
        width: 26px; height: 20px; flex: 0 0 auto;
        object-fit: cover; border-radius: 3px;
        border: 1px solid var(--dsw-alias-border-l1);
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
      .dsh-comfyui-empty-hint {
        max-width: 360px; text-align: center; line-height: 1.5;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-comfyui-empty-actions { display: flex; align-items: center; gap: 8px; }
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

    // A ComfyUI that never hands over `comfyAPI.app` looks exactly like a slow
    // one, so the spinner turns into an explanation with a way out after this.
    const EDITOR_STALL_SECONDS = 45

    /**
     * Which full-stage overlay the editor area shows, if any.
     *
     * Order is the fix for a panel that spun forever: while ComfyUI is stopped
     * the embedded frontend can never finish booting, so `status` stays
     * `'loading'` and a status-only rule painted a spinner over the whole tab.
     * The server snapshot leads, and the bridge status only decides what to say
     * while the server is believed to be up.
     */
    function overlayPlan({ status, service, bootSeconds = 0, dir = '', t }) {
      const known = service !== null && service !== undefined
      const state = known ? service.state : null
      const starting = state === 'starting' || state === 'restarting'
      const needDir = String(dir ?? '').trim() === ''
      const idle = { stage: 'none', title: '', hint: '', seconds: 0, canStart: false, needDir }
      // The iframe stays mounted underneath, so a probe that flips false for one
      // poll covers the canvas for five seconds and then uncovers it; nothing
      // the user typed is lost and no reload is triggered by the overlay.
      // `=== false`, not `!healthy`: a snapshot without a health field (an older
      // Host) must fall through to the spinner, not claim the server is down.
      if (known && service.health === false && !starting) {
        return {
          stage: 'stopped',
          title: t('notRunning'),
          hint: needDir ? t('serverPick') : '',
          seconds: 0,
          canStart: !needDir,
          needDir,
        }
      }
      if (starting) {
        return { stage: 'starting', title: t('serverStarting'), hint: '', seconds: bootSeconds, canStart: false, needDir }
      }
      if (status !== 'loading') return idle
      if (bootSeconds >= EDITOR_STALL_SECONDS) {
        return {
          stage: 'stalled',
          title: t('editorStalled'),
          hint: t('editorStalledHint'),
          seconds: bootSeconds,
          canStart: false,
          needDir,
        }
      }
      return { stage: 'loading', title: t('editorLoading'), hint: '', seconds: bootSeconds, canStart: false, needDir }
    }

    /**
     * How often the bar re-reads the Host's server status.
     *
     * A start is the one transition the panel cannot see any other way, and the
     * supervisor flips `starting` to `running` within a second of its probe, so
     * the usual cadence would leave "Starting ComfyUI…" on screen long after
     * the editor is usable. Once the server is up only a crash changes the
     * answer, and the supervisor notices that within 20 s; polling every five
     * seconds for the rest of the session is a dozen requests a minute for
     * nothing. A missing or unhealthy probe stays fast, because that is exactly
     * when the panel has something to show.
     *
     * @param {{ state?: string, health?: boolean } | null} service - last snapshot, or null before the first read.
     * @returns {number} poll interval in milliseconds.
     */
    function servicePollMs(service) {
      if (service === null || service === undefined) return 5000
      if (service.state === 'starting' || service.state === 'restarting') return 1000
      return service.health === true ? 30000 : 5000
    }

    /**
     * The overlay that covers the editor area. Pure markup over an
     * `overlayPlan` result so the stopped / starting / stalled faces can be
     * rendered and asserted in `test/client-ops.mjs` without a browser.
     */
    function StageOverlay({ stage, busy, t, onStart, onReload, onService }) {
      if (stage.stage === 'none') return null
      if (stage.stage === 'loading' || stage.stage === 'starting') {
        return h('div', { className: 'dsh-comfyui-overlay' },
          h('span', { className: 'dsh-comfyui-spinner' }),
          h('span', null, stage.seconds > 0 ? `${stage.title} ${stage.seconds}s` : stage.title),
        )
      }
      return h('div', { className: 'dsh-comfyui-overlay dsh-comfyui-empty' },
        h('span', { className: 'dsh-comfyui-empty-title' }, stage.title),
        stage.hint === '' ? null : h('span', { className: 'dsh-comfyui-empty-hint' }, stage.hint),
        h('div', { className: 'dsh-comfyui-empty-actions' },
          stage.stage === 'stopped'
            ? h('button', {
              className: 'dsh-comfyui-button',
              'data-variant': 'primary',
              type: 'button',
              disabled: busy || !stage.canStart,
              title: stage.needDir ? t('serverPick') : t('serverStart'),
              onClick: onStart,
            }, t('serverStart'))
            : h('button', {
              className: 'dsh-comfyui-button',
              'data-variant': 'primary',
              type: 'button',
              onClick: onReload,
            }, t('reload')),
          h('button', {
            className: 'dsh-comfyui-button',
            'data-variant': 'quiet',
            type: 'button',
            onClick: onService,
          }, t('serverPanel')),
        ),
      )
    }

    function TopBar({ stats, synced, syncAt, runText, previewUrl, previewTitle, filesTitle, run, plan, serviceOpen, onSync, onReload, onFit, onOpen, onService, onAction, onCancel, t }) {
      const counts = t('stats')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
      // The name leads: it is the one fact the panel and the model have to agree
      // on, and a bar that shows only counts reads the same for every workflow.
      const name = typeof stats.name === 'string' && stats.name.length > 0 ? stats.name : ''
      const statText = [name === '' ? '' : `「${name}」`, counts, synced].filter(part => part.length > 0).join(' · ')
      // The revision is bookkeeping for the Host and the model, not a number
      // a ComfyUI user can act on; keep it in the tooltip instead of the bar.
      const statTitle = t('statsTitle')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
        .replace('{{revision}}', String(stats.revision))
      const canCancel = run !== null && run !== undefined
        && run.status === 'running'
        && typeof run.promptId === 'string' && run.promptId.length > 0
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
          // Cancel sits with the lifecycle controls because it acts on the
          // same server state, and only exists while this session's prompt runs.
          canCancel ? h('button', {
            key: 'cancel',
            className: 'dsh-comfyui-button',
            'data-action': 'cancel',
            type: 'button',
            disabled: run.cancel === 'busy',
            onClick: onCancel,
          }, cancelLabel(run, t)) : null,
        ),
        previewUrl ? h('img', {
          className: 'dsh-comfyui-preview',
          src: previewUrl,
          alt: '',
          title: previewTitle,
        }) : null,
        runText === '' ? null : h('span', { className: 'dsh-comfyui-run', title: filesTitle }, runText),
        // The counters are also the only machine-readable state the panel
        // publishes, so the headless UI check reads them instead of parsing
        // localized bar text.
        h('span', {
          className: 'dsh-comfyui-stats',
          title: statTitle,
          'data-workflow-name': name,
          'data-nodes': String(stats.nodes),
          'data-links': String(stats.links),
          'data-revision': String(stats.revision),
          'data-synced': String(syncAt),
        }, statText),
        h('div', { className: 'dsh-comfyui-tools' },
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            type: 'button',
            title: t('fitView'),
            'aria-label': t('fitView'),
            'data-tool': 'fit',
            onClick: onFit,
          }, '\u2922'),
          h('button', { className: 'dsh-comfyui-button', type: 'button', title: t('syncHint'), 'data-tool': 'sync', onClick: onSync }, t('sync')),
          h('button', { className: 'dsh-comfyui-button', type: 'button', title: t('reloadHint'), 'data-tool': 'reload', onClick: onReload }, t('reload')),
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            type: 'button',
            title: t('open'),
            'aria-label': t('open'),
            'data-tool': 'open',
            onClick: onOpen,
          }, '\u2197'),
          h('button', {
            className: 'dsh-comfyui-button dsh-comfyui-icon',
            'data-active': serviceOpen ? 'true' : 'false',
            'data-tool': 'server',
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
     * Whether a value is a Blob, whichever realm made it.
     *
     * `b_preview` dispatches a Blob created inside the iframe, where
     * `instanceof Blob` is false in the parent page. The toString tag and the
     * Blob methods are realm-independent.
     * @param {any} value - candidate.
     * @returns {boolean} whether the value is a Blob or a File.
     */
    function isBlob(value) {
      if (value === null || typeof value !== 'object') return false
      if (typeof value.size !== 'number' || typeof value.type !== 'string' || typeof value.slice !== 'function') return false
      const tag = Object.prototype.toString.call(value)
      return tag === '[object Blob]' || tag === '[object File]'
    }

    /**
     * Normalize a preview event payload.
     *
     * `b_preview` carries the Blob itself; `b_preview_with_metadata` carries
     * `{ blob, nodeId, promptId }`. Both reduce to one shape, and anything else
     * returns null instead of reaching `URL.createObjectURL`.
     * @param {any} payload - the event detail.
     * @returns {{ blob: Blob, nodeId: string | null, promptId: string | null } | null} preview, or null.
     */
    function readPreview(payload) {
      const id = value => (typeof value === 'string' && value.length > 0)
        ? value
        : (Number.isSafeInteger(value) ? String(value) : null)
      if (isBlob(payload)) return { blob: payload, nodeId: null, promptId: null }
      if (payload === null || typeof payload !== 'object') return null
      if (!isBlob(payload.blob)) return null
      return {
        blob: payload.blob,
        nodeId: id(payload.nodeId) ?? id(payload.node_id),
        promptId: id(payload.promptId) ?? id(payload.prompt_id),
      }
    }

    /**
     * Reduce ComfyUI's `progress_state` payload to one node's progress.
     *
     * The event maps every node in the prompt to its own `{ value, max,
     * state }`; the bar has room for one line, so the running node wins and
     * the lowest id breaks a tie. Without a running node the first node with a
     * usable `max` is used, because a state that finished between ticks still
     * says more than an empty bar.
     * @param {any} payload - `{ nodes: { <id>: { value, max, state } } }`.
     * @returns {{ node: string, value: number, max: number } | null} summary, or null.
     */
    function progressSummary(payload) {
      const nodes = payload?.nodes
      if (nodes === null || typeof nodes !== 'object') return null
      const candidates = []
      for (const [id, entry] of Object.entries(nodes)) {
        if (entry === null || typeof entry !== 'object') continue
        const value = Number(entry.value)
        const max = Number(entry.max)
        if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue
        candidates.push({ node: String(id), value, max, running: entry.state === 'running' })
      }
      if (candidates.length === 0) return null
      const running = candidates.filter(candidate => candidate.running)
      const pool = running.length > 0 ? running : candidates
      pool.sort((left, right) => Number(left.node) - Number(right.node) || left.node.localeCompare(right.node))
      const chosen = pool[0]
      return { node: chosen.node, value: chosen.value, max: chosen.max }
    }

    /**
     * File names in an `executed` message, for the bar's tooltip.
     * @param {any} data - the message body.
     * @returns {string[]} file names, bounded.
     */
    function outputFiles(data) {
      const output = data?.output
      if (output === null || typeof output !== 'object') return []
      const files = []
      for (const entry of Object.values(output)) {
        if (!Array.isArray(entry)) continue
        for (const item of entry) {
          if (typeof item?.filename === 'string' && item.filename !== '') files.push(item.filename)
        }
      }
      return files.slice(0, 8)
    }

    /** The bar's run state before any event. */
    function emptyRun() {
      return {
        status: null,
        promptId: null,
        node: null,
        value: null,
        max: null,
        startedAt: null,
        files: [],
        preview: null,
        cancel: 'none',
      }
    }

    /**
     * One event in, the next run state out.
     *
     * Everything the bar shows about a run lives here: the prompt id Cancel
     * needs, node and step progress, the start time the elapsed seconds count
     * from, collected output names, the thumbnail, and the cancel phase.
     * Turning the preview Blob into a URL is the component's job, because that
     * is a browser effect rather than a state transition.
     * @param {any} run - current state, or null before the first event.
     * @param {any} event - a mapped editor event, or a local `preview` / `cancel` one.
     * @param {number} [now] - current time in milliseconds.
     * @returns {any} next state.
     */
    function applyRunEvent(run, event, now = Date.now()) {
      const base = run ?? emptyRun()
      switch (event?.kind) {
        case 'execution_start':
          // A new prompt owns the bar: an older thumbnail and the previous
          // run's output names do not describe it.
          return { ...emptyRun(), status: 'running', promptId: event.promptId ?? null, startedAt: now }
        case 'executing': {
          if (event.node === null || event.node === undefined) return base
          const sameNode = base.node === event.node
          return {
            ...base,
            status: 'running',
            promptId: event.promptId ?? base.promptId,
            node: event.node,
            value: sameNode ? base.value : null,
            max: sameNode ? base.max : null,
            startedAt: typeof base.startedAt === 'number' ? base.startedAt : now,
          }
        }
        case 'progress':
        case 'progress_state':
          return {
            ...base,
            status: 'running',
            promptId: event.promptId ?? base.promptId,
            node: event.node ?? base.node,
            value: typeof event.value === 'number' ? event.value : base.value,
            max: typeof event.max === 'number' ? event.max : base.max,
            startedAt: typeof base.startedAt === 'number' ? base.startedAt : now,
          }
        case 'executed': {
          const files = Array.isArray(event.files) ? event.files : []
          const merged = files.length === 0 ? base.files : [...new Set([...base.files, ...files])]
          return {
            ...base,
            promptId: event.promptId ?? base.promptId,
            node: event.node ?? base.node,
            files: merged.slice(-8),
          }
        }
        case 'execution_success':
          return {
            ...base,
            status: 'success',
            promptId: event.promptId ?? base.promptId,
            value: null,
            max: null,
            preview: null,
            cancel: 'none',
          }
        case 'execution_error':
          return {
            ...base,
            status: 'error',
            promptId: event.promptId ?? base.promptId,
            error: event.error ?? null,
            preview: null,
            cancel: 'none',
          }
        case 'execution_interrupted':
          return {
            ...base,
            status: 'interrupted',
            promptId: event.promptId ?? base.promptId,
            preview: null,
            cancel: 'none',
          }
        case 'preview': {
          const preview = readPreview(event.preview)
          if (preview === null) return base
          return { ...base, preview, promptId: preview.promptId ?? base.promptId }
        }
        case 'cancel':
          if (base.status !== 'running') return base
          return { ...base, cancel: event.state === 'busy' ? 'busy' : event.state === 'failed' ? 'failed' : 'none' }
        default:
          return base
      }
    }

    /**
     * The one line the bar shows for a run.
     *
     * Node and step progress come from `progress_state` (or `progress`), the
     * seconds from the recorded start time, and a failed Cancel replaces the
     * line. Empty when there is nothing to say, so the bar keeps its space.
     * @param {any} run - state from `applyRunEvent`.
     * @param {(key: string) => string} t - translator.
     * @param {number} [now] - current time in milliseconds.
     * @returns {string} label, possibly empty.
     */
    function runLabel(run, t, now = Date.now()) {
      if (run === null || run === undefined) return ''
      if (run.cancel === 'failed') return t('runCancelFailed')
      if (run.status === 'queued') return t('queued')
      if (run.status === 'running') {
        const parts = []
        if (run.node !== null && run.node !== undefined && String(run.node) !== '') {
          parts.push(t('runNode').replace('{{node}}', String(run.node)))
        }
        if (typeof run.value === 'number' && typeof run.max === 'number' && run.max > 0) {
          parts.push(`${run.value}/${run.max}`)
        }
        if (typeof run.startedAt === 'number' && Number.isFinite(run.startedAt)) {
          const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000))
          parts.push(t('runSeconds').replace('{{seconds}}', String(seconds)))
        }
        return parts.join(' · ')
      }
      if (run.status === 'error') return t('runFailed')
      if (run.status === 'interrupted') return t('runInterrupted')
      return ''
    }

    /**
     * The Cancel button's label: a request in flight replaces the verb.
     * @param {any} run - state from `applyRunEvent`.
     * @param {(key: string) => string} t - translator.
     * @returns {string} label.
     */
    function cancelLabel(run, t) {
      return run?.cancel === 'busy' ? t('runCancelling') : t('runCancel')
    }

    /** Event kinds the editor's bus dispatches that the Host records. */
    const PANEL_EVENTS = [
      'status',
      'execution_start',
      'execution_cached',
      'executing',
      'progress',
      'executed',
      'execution_success',
      'execution_error',
      'execution_interrupted',
    ]

    /** Event kinds the panel reads but the Host does not record. */
    const LOCAL_EVENTS = ['progress_state']

    /**
     * Preview kinds carry a Blob. They feed the bar's thumbnail only; the
     * Host's event route takes JSON and has no use for the binary.
     */
    const PREVIEW_EVENTS = ['b_preview', 'b_preview_with_metadata']

    /**
     * Reduce one event the editor's own bus delivered to the shape the Host
     * stores.
     *
     * The frontend dispatches these from the `api` object behind the iframe's
     * WebSocket, so the panel can read the same events the editor renders
     * instead of opening a socket of its own. The payload is not uniform:
     * `executing` carries only the node id, `status` only the queue state, and
     * everything else the raw message body. Kinds the panel does not use
     * return null, and `progress_state` is mapped for the bar only.
     */
    function mapApiEvent(kind, detail) {
      const data = detail !== null && typeof detail === 'object' ? detail : {}
      const promptId = typeof data.prompt_id === 'string' ? data.prompt_id : null
      const node = typeof data.node === 'string' ? data.node : null
      switch (kind) {
        case 'status':
          return { kind, queueRemaining: data?.exec_info?.queue_remaining ?? null }
        case 'executing':
          return { kind, promptId, node: typeof detail === 'string' ? detail : node }
        case 'progress':
          return { kind, promptId, node, value: data.value ?? null, max: data.max ?? null }
        case 'progress_state': {
          const summary = progressSummary(data)
          if (summary === null) return null
          return { kind, promptId, node: summary.node, value: summary.value, max: summary.max }
        }
        case 'executed':
          return { kind, promptId, node, files: outputFiles(data) }
        case 'execution_error':
          return {
            kind,
            promptId,
            error: typeof data.exception_message === 'string'
              ? data.exception_message
              : (typeof data.exception_type === 'string' ? data.exception_type : 'execution error'),
          }
        case 'execution_start':
        case 'execution_cached':
        case 'execution_success':
        case 'execution_interrupted':
          return { kind, promptId }
        default:
          return null
      }
    }

    /**
     * Start relaying one editor api's execution events to the panel.
     *
     * Returns a disposer that removes every listener again. Kept apart from the
     * effect so the wiring itself — every kind subscribed, the payload mapped,
     * the local kinds kept away from the Host, nothing left behind — is
     * testable without a DOM.
     */
    function relayEditorEvents(api, { applyEvent, postEvent }) {
      const listeners = []
      const listen = (kind, listener) => {
        try {
          api.addEventListener(kind, listener)
          listeners.push([kind, listener])
        } catch {
          // A frontend that refuses a listener name is not fatal: the panel
          // still syncs, only the progress readouts stay empty.
        }
      }
      for (const kind of PANEL_EVENTS) {
        listen(kind, event => {
          const mapped = mapApiEvent(kind, event?.detail)
          if (mapped === null) return
          applyEvent(mapped)
          postEvent(mapped)
        })
      }
      for (const kind of LOCAL_EVENTS) {
        listen(kind, event => {
          const mapped = mapApiEvent(kind, event?.detail)
          if (mapped !== null) applyEvent(mapped)
        })
      }
      for (const kind of PREVIEW_EVENTS) {
        listen(kind, event => {
          const preview = readPreview(event?.detail)
          if (preview !== null) applyEvent({ kind: 'preview', preview })
        })
      }
      return () => {
        for (const [kind, listener] of listeners) {
          try {
            api.removeEventListener(kind, listener)
          } catch {
            // The iframe reloaded: its realm, and the api with it, are gone.
          }
        }
      }
    }

    /**
     * The client id the embedded ComfyUI frontend is connected with.
     *
     * ComfyUI addresses execution events to the client that queued the prompt
     * (`server.send_sync(..., server.client_id)`). A Host-queued prompt has to
     * carry the id of a socket the editor is listening on, or the run happens
     * with no queue entry, no node progress, no preview, and nothing in the
     * panel's history. Two sources hold it, and the editor's own `api` is the
     * authoritative one: `window.name` and `sessionStorage` are what ComfyUI's
     * api keeps for the id the server assigned.
     * @param {Window | null | undefined} win - the editor iframe's window.
     * @param {any} app - the editor's `comfyAPI.app.app`, when it has one.
     * @returns {string | null} the id to queue under, or `null` when unknown.
     */
    function frontendClientId(win, app) {
      const usable = value => typeof value === 'string' && /^[0-9a-z]{8,64}$/i.test(value)
      if (usable(app?.api?.clientId)) return app.api.clientId
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

    /**
     * The embedded editor's app, but only once its graph exists.
     *
     * Reading `rootGraph` before setup makes the frontend log "ComfyApp graph
     * accessed before initialization", and the first sync tick lands exactly in
     * that window. `isGraphReady` answers without touching the getter; older
     * frontends do not expose it, so an undefined answer falls through and
     * behaves as before.
     * @param {any} win - the editor iframe's window (`comfyAPI` is the frontend's own global).
     * @returns {any | null} the app when its graph is ready, else null.
     */
    function panelApp(win) {
      const app = win?.comfyAPI?.app?.app
      if (app === undefined || app === null) return null
      if (app.isGraphReady === false) return null
      return app
    }

    /**
     * The label ComfyUI gives a workflow that has no file, plus its "(2)" copies.
     *
     * Older frontends left `filename` empty for a temporary canvas. 1.57 writes
     * this label instead — the same string its own store compares against to
     * decide a workflow needs saving — so a panel that only checks for an empty
     * name reports it as the session's file and hands the model a name no file
     * has.
     */
    const UNSAVED_WORKFLOW = /^Unsaved Workflow(?: \(\d+\))?$/u

    /**
     * The name the editor would save its workflow under, or null when the
     * canvas has never been saved.
     *
     * ComfyUI derives the tab label, and the path Save writes to, from the
     * active workflow's `filename`: a temporary canvas has none, which is why
     * the tab reads "Unsaved Workflow". The Host uses this value as the
     * session's workflow name, so the two sides name the same graph the same
     * way. That placeholder is not a name — see `UNSAVED_WORKFLOW`.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @returns {string | null} the file stem, without folders or `.json`.
     */
    function workflowNameFromEditor(app) {
      const workflow = app?.extensionManager?.workflow?.activeWorkflow
      const filename = typeof workflow?.filename === 'string' ? workflow.filename : ''
      const base = filename.split(/[\\/]/).pop() ?? ''
      const name = base.replace(/\.json$/i, '').trim()
      if (name.length === 0 || UNSAVED_WORKFLOW.test(name)) return null
      return name
    }

    /**
     * Show a Host-side workflow name in the editor's tab.
     *
     * The frontend shows the tab from `filename`, which carries no extension,
     * and identifies the workflow by `path`, under `workflows/`. Writing either
     * in another shape makes `getWorkflowByPath` miss the workflow — which
     * freezes its modified dot — and can send the next Save to a different
     * file than the one the tab names.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {string} name - the name to show; a saved slot or a reported file.
     * @returns {boolean} whether the label was changed.
     */
    function bindWorkflowLabel(app, name) {
      const workflow = app?.extensionManager?.workflow?.activeWorkflow
      if (workflow === null || workflow === undefined) return false
      if (typeof name !== 'string' || name.length === 0) return false
      workflow.filename = name
      workflow.path = `workflows/${name}.json`
      return true
    }

    /**
     * Whether ComfyUI's user data already holds a workflow file with this name.
     *
     * The request goes through the editor's own `api.fetchApi`, the same call
     * its workflow browser makes: a bare `/api/userdata` would resolve against
     * the DSH origin instead of the `/comfyui/` proxy prefix.
     * @param {any} win - the editor iframe's window (`comfyAPI` is its own global).
     * @param {string} name - the workflow name, without `.json`.
     * @returns {Promise<boolean>} true when `workflows/<name>.json` is listed.
     */
    async function workflowFileExists(win, name) {
      const api = win?.comfyAPI?.app?.app?.api ?? win?.comfyAPI?.api?.api
      if (typeof api?.fetchApi !== 'function') return false
      try {
        const response = await api.fetchApi('/userdata?dir=workflows')
        if (response?.ok !== true) return false
        const list = await response.json()
        return Array.isArray(list) && list.includes(`${name}.json`)
      } catch {
        return false
      }
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
        case 'move_node': {
          const [x, y] = Array.isArray(result?.pos) ? result.pos : []
          return `#${operation.id} @${x},${y}`
        }
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
      if (op === 'move_node') {
        // Repositioning is the one edit that changes nothing but `pos`: doing it
        // with remove+add would drop every link and widget value the node holds.
        const pos = operation.pos
        if (!Array.isArray(pos) || pos.length < 2 || !Number.isFinite(Number(pos[0])) || !Number.isFinite(Number(pos[1]))) {
          throw new Error(`Node ${operation.id} needs "pos": [x, y]`)
        }
        node.pos = [Number(pos[0]), Number(pos[1])]
        graph.setDirtyCanvas?.(true, true)
        return { op, id: node.id, pos: node.pos }
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

    /**
     * Capture the editor canvas as a PNG data URL.
     *
     * The panel is the only place that can see the graph: the Host stores the
     * workflow JSON, not the pixels. LiteGraph paints every node, link, and
     * widget on one 2D canvas, so its `toDataURL` is exactly what the user is
     * looking at — zoom, pan and selection included.
     */
    function captureGraph(app) {
      const canvas = app?.canvas?.canvas
      if (canvas === undefined || canvas === null || typeof canvas.toDataURL !== 'function') {
        throw new Error('The editor canvas is not ready; if ComfyUI is stopped, start it from the panel and retry')
      }
      let dataUrl = canvas.toDataURL('image/png')
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
        throw new Error('The editor canvas refused to serialize as PNG')
      }
      // The command channel carries this as one JSON body. A large retina canvas
      // can serialize past a few megabytes, so halve it once before sending
      // rather than letting the round trip fail on a body limit.
      if (dataUrl.length > 3_000_000 && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const copy = document.createElement('canvas')
        copy.width = Math.max(1, Math.round(canvas.width / 2))
        copy.height = Math.max(1, Math.round(canvas.height / 2))
        copy.getContext('2d')?.drawImage(canvas, 0, 0, copy.width, copy.height)
        dataUrl = copy.toDataURL('image/png')
      }
      return {
        kind: 'screenshot',
        dataUrl,
        width: canvas.width,
        height: canvas.height,
      }
    }

    /**
     * Replace the editor's graph with a saved UI workflow.
     *
     * `loadGraphData` is the same entry ComfyUI's own Load uses: it cleans the
     * current graph, configures the new one, and runs the frontend's load
     * hooks. The saved camera is ignored (`restore_view` false) because synced
     * workflows strip view state; the caller frames the result instead.
     *
     * Its fourth argument is the workflow the graph belongs to. Passed null, the
     * frontend opens a temporary one — a second tab labelled "Unsaved
     * Workflow", with no file path for the next sync to report. Passed the
     * workflow the store already holds, the graph lands in that tab and keeps
     * its file identity.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any} workflow - a serialized UI workflow.
     * @param {any | null} [target] - the store's workflow for the file being loaded.
     * @returns {Promise<{nodes: number, links: number}>} the loaded graph's size.
     */
    async function applyWorkflowGraph(app, workflow, target = null) {
      if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow) || !Array.isArray(workflow.nodes)) {
        throw new Error('The saved workflow is not a ComfyUI UI workflow')
      }
      if (typeof app?.loadGraphData !== 'function') {
        throw new Error('This ComfyUI frontend cannot load a workflow; reload the panel')
      }
      await app.loadGraphData(workflow, true, false, target)
      const graph = app.rootGraphOrUndefined ?? app.rootGraph ?? app.graph
      graph?.setDirtyCanvas?.(true, true)
      const links = graph?.links instanceof Map ? graph.links.size : Object.keys(graph?.links ?? {}).length
      return { nodes: graph?._nodes?.length ?? workflow.nodes.length, links }
    }

    /**
     * The workflow the editor's store holds for `workflows/<name>.json`.
     *
     * Loading a graph into it is what keeps a loaded file one tab: the tab
     * carries the file's name and path, Save targets that file, and the sync
     * reports a name instead of the "Unsaved Workflow" placeholder. A slot with
     * no file behind it has no entry here, which is the answer the caller needs
     * — that graph has to open as a temporary workflow, as it must.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {string | null | undefined} name - the workflow name being loaded.
     * @returns {any | null} the store's workflow for that file, or null.
     */
    function fileWorkflow(app, name) {
      if (typeof name !== 'string' || name.length === 0) return null
      const manager = app?.extensionManager?.workflow
      if (typeof manager?.getWorkflowByPath !== 'function') return null
      return manager.getWorkflowByPath(`workflows/${name}.json`) ?? null
    }

    /**
     * Load a saved workflow and prove the Host received it.
     *
     * `syncNow` reports a failed state POST through the bar and returns, so a
     * caller that ignores it would tell the model the load succeeded while the
     * Host still mirrors the previous graph. Here the sync result is load-bearing:
     * a workflow that loaded but did not reach the Host is an error.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any} workflow - a serialized UI workflow.
     * @param {{fit: (app: any) => Promise<unknown>, sync: () => Promise<boolean>, name?: string | null}} hooks
     *   `fit` frames the loaded graph; `sync` reports whether the state POST
     *   landed; `name` is the workflow the Host asked for, so a file-backed
     *   load can land in its own tab.
     * @returns {Promise<{applied: number, nodes: number, links: number, operations: {op: string}[]}>}
     */
    async function loadWorkflow(app, workflow, { fit, sync, name = null }) {
      const value = await applyWorkflowGraph(app, workflow, fileWorkflow(app, name))
      // Synced workflows carry no camera, so frame the loaded graph instead of
      // leaving it wherever the previous workflow was panned to. A framing
      // failure must not fail the load.
      await fit(app).catch(() => {})
      if (!(await sync())) {
        throw new Error('The workflow loaded, but the Host did not receive it; retry Sync')
      }
      return { applied: 1, nodes: value.nodes, links: value.links, operations: [{ op: 'load_workflow' }] }
    }

    /**
     * The editor surface one sync reads, bound to the app it was read from.
     *
     * A push needs exactly these seven facts and nothing else from the iframe,
     * which is what lets test/client-ops.mjs drive the loop with a fake editor.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {Window | null | undefined} win - the editor iframe's window, for the socket id.
     * @returns {any} the adapter `createSync` consumes.
     */
    function editorAdapter(app, win) {
      const graph = app.rootGraph ?? app.graph
      return {
        graph: () => graph,
        serialize: () => graph.serialize(),
        selection: () => Object.keys(app.canvas?.selected_nodes ?? {})
          .map(Number)
          .filter(Number.isInteger),
        name: () => workflowNameFromEditor(app),
        clientId: () => frontendClientId(win, app),
        project: () => projectGraph(app),
        toPrompt: () => app.graphToPrompt(),
      }
    }

    /**
     * The sync loop with no browser around it.
     *
     * A push used to mix serialization, the camera strip, the generation
     * guard, the name rule, prompt conversion, the POST body, revision
     * adoption and React state updates. Everything but the transport and the
     * rendering lives here, so the same decisions run against a fake editor
     * and a fake `post` in test/client-ops.mjs.
     * @param {object} options - the loop's collaborators.
     * @param {string | null | undefined} options.sessionId - the session every push reports under; a missing id posts nothing.
     * @param {() => any | null} options.editor - returns the adapter for the editor to sync now, or null before the panel has booted it.
     * @param {(payload: any) => Promise<any | null>} options.post - sends one state body and resolves to its parsed response, or null when the body cannot be parsed.
     * @param {() => number} options.now - the clock for the last-sync stamp.
     * @param {() => void} [options.onPost] - called once a push decides to post, before the prompt conversion, so the caller can show its pending state.
     * @param {() => string} [options.bridgeError] - the message for a push whose editor exposes no graph.
     * @returns {{push: (force?: boolean) => Promise<any>, snapshot: () => any, reset: () => void, adopt: (name: string) => void}}
     *   `push` reports the decision; `snapshot` reads what the last successful
     *   push left; `reset` forgets the signature and names, as an iframe reload
     *   must; `adopt` remembers a name the panel itself put into the editor so
     *   the next push does not report it as a user rename.
     */
    function createSync({ sessionId, editor, post, now, onPost, bridgeError }) {
      let revision = 0
      let lastJson = ''
      let lastClientId = null
      /** @type {string | null | undefined} */
      let lastEditorName
      /** @type {string | null | undefined} */
      let lastHostName
      /** @type {string | null} */
      let displayName = null
      let lastNodes = 0
      let lastLinks = 0
      let lastAt = 0
      /** Bumped by every push; a slower one must not overtake a newer snapshot. */
      let generation = 0

      /**
       * What the last successful sync left behind, for a caller that has no
       * state of its own.
       * @returns {{revision: number, name: string | null, nodes: number, links: number, at: number}} the remembered snapshot.
       */
      function snapshot() {
        return { revision, name: displayName, nodes: lastNodes, links: lastLinks, at: lastAt }
      }

      /**
       * Forget the last signature and both names, so the next push reports them
       * again. A reloaded editor is a different editor, even when its
       * autosaved graph serializes the same.
       * @returns {void}
       */
      function reset() {
        lastJson = ''
        lastEditorName = undefined
        lastHostName = undefined
      }

      /**
       * Remember a name the panel bound into the editor's tab, so the next push
       * does not report the panel's own rename as one the user just made.
       * @param {string} name - the name the editor now carries.
       * @returns {void}
       */
      function adopt(name) {
        lastEditorName = name
      }

      /**
       * Post one editor snapshot to the Host unless it is unchanged.
       * @param {boolean} [force] - post even when the graph and the name are unchanged.
       * @returns {Promise<any>} `{posted, revision, name, nodes, links, at, adoptName}`.
       */
      async function push(force = false) {
        if (sessionId === undefined || sessionId === null) return { posted: false, ...snapshot() }
        try {
          return await pushOnce(force)
        } catch (error) {
          // The signature no longer matches what the Host holds, so the next
          // tick has to retry this graph instead of skipping it as unchanged.
          lastJson = ''
          throw error
        }
      }

      /**
       * The body of one push, after the session check.
       * @param {boolean} force - post even when nothing changed.
       * @returns {Promise<any>} what the caller should render.
       */
      async function pushOnce(force) {
        const started = ++generation
        const view = editor()
        if (view === null || view === undefined) throw new Error(bridgeError?.() ?? 'The editor is not ready')
        const graph = view.graph()
        if (graph === null || graph === undefined || typeof graph.serialize !== 'function') {
          throw new Error(bridgeError?.() ?? 'The editor is not ready')
        }
        // ComfyUI addresses execution events to the client that queued the
        // prompt, so the Host has to queue as this iframe or the run never
        // appears in the panel's own queue, previews, or history. Both sources
        // matter: the editor's socket id, and the window that assigned it.
        const clientId = view.clientId()
        if (clientId !== lastClientId) {
          lastClientId = clientId
          force = true
        }
        const workflow = JSON.parse(JSON.stringify(view.serialize()))
        // The frontend stamps `extra.ds` (zoom and pan) on every serialization,
        // so scrolling, zooming, or resizing the panel would otherwise look
        // like an edit and grow the revision the model reads.
        if (workflow.extra !== null && typeof workflow.extra === 'object') {
          delete workflow.extra.ds
          if (Object.keys(workflow.extra).length === 0) delete workflow.extra
        }
        const selection = view.selection()
        const json = `${JSON.stringify(workflow)}|${selection.join(',')}`
        // The name lives outside the graph JSON, so a rename alone would never
        // reach the Host. It travels only when it changed, and the first sync
        // reports a file the editor already had: a quiet re-sync must not clear
        // a name that a workflow tool gave this session.
        const editorName = view.name()
        const firstSync = lastEditorName === undefined
        const renamed = firstSync ? editorName !== null : lastEditorName !== editorName
        if (!force && json === lastJson && !renamed) return { posted: false, ...snapshot() }
        lastJson = json
        onPost?.()
        let semantic = null
        try {
          semantic = view.project()
        } catch {
          // A projection failure must not block the raw workflow sync.
        }
        let prompt = null
        try {
          const converted = await view.toPrompt()
          prompt = converted?.output ?? null
        } catch {
          // A graph that cannot be converted yet (missing links, empty graph)
          // still syncs; the run tool will report the missing prompt.
        }
        // A newer push started while this one was converting the graph. Its
        // snapshot is later than ours, so posting this one would make the Host
        // store an older workflow under a higher revision — and nothing would
        // correct it, because `lastJson` already holds the newer json and the
        // next tick sees no change.
        if (started !== generation) return { posted: false, ...snapshot() }
        revision += 1
        const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
        const links = Array.isArray(workflow.links) ? workflow.links.length : 0
        const saved = await post({
          sessionId,
          workflow,
          prompt,
          semantic,
          revision,
          clientId,
          // The file the editor has open, on every push: the Host drops a name
          // that no longer describes the canvas, and a quiet re-sync would
          // otherwise leave the old one attached.
          file: editorName,
          // A canvas without a file reports only that. `file: null` is what
          // tells the Host to drop a name that came from a file, while a name a
          // workflow tool gave the canvas survives — which is what a temporary
          // tab opened over a saved slot should do.
          ...(renamed && editorName !== null ? { name: editorName } : {}),
        })
        // The Host keeps the revision monotonic across page reloads, so adopt
        // its number: showing the page-local counter made the panel say rev 14
        // while the same workflow read rev 49 from the model side.
        const persisted = Number.isSafeInteger(saved?.revision) ? saved.revision : revision
        revision = Math.max(revision, persisted)
        lastEditorName = editorName
        const hostName = typeof saved?.name === 'string' && saved.name.length > 0 ? saved.name : null
        // Only a name the Host *changed* is pushed into the editor: a steady
        // name must not fight a file the user opened in the meantime.
        const hostRenamed = lastHostName !== hostName
        lastHostName = hostName
        // An unparseable body says nothing about the name; a body without one
        // means the Host cleared it.
        if (saved !== null && saved !== undefined) displayName = hostName
        lastNodes = nodes
        lastLinks = links
        lastAt = now()
        return {
          posted: true,
          revision,
          name: displayName,
          nodes,
          links,
          at: lastAt,
          adoptName: hostRenamed && hostName !== null && hostName !== editorName ? hostName : null,
        }
      }

      return { push, snapshot, reset, adopt }
    }

    function ComfyPanel({ sessionId, t }) {
      const iframeRef = useRef(null)
      const appRef = useRef(null)
      const lastForcedAtRef = useRef(0)
      /** Set by an iframe load: the next tick must post even if it looks unchanged. */
      const forceNextRef = useRef(false)
      const fittedRef = useRef(false)
      /** `name -> whether workflows/<name>.json exists`, so each name is asked once. */
      const workflowFileCacheRef = useRef(new Map())
      const [status, setStatus] = useState('loading')
      const [bootSeconds, setBootSeconds] = useState(0)
      const [stats, setStats] = useState({ nodes: 0, links: 0, revision: 0, name: null })
      const [message, setMessage] = useState('')
      const [run, setRun] = useState(null)
      const runRef = useRef(null)
      runRef.current = run
      /** Pending fallback for a successful Cancel; see `cancelRun`. */
      const cancelTimerRef = useRef(null)
      /** Bumped once a second while a run with a start time is on screen. */
      const [runClock, setRunClock] = useState(0)
      const [previewUrl, setPreviewUrl] = useState('')
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
      // Read by the boot clock below; the overlay recomputes the same two facts
      // through `overlayPlan` so the rule itself stays testable.
      const serverStarting = service !== null
        && (service.state === 'starting' || service.state === 'restarting')
      const serverStopped = service !== null && service.health === false && !serverStarting
      // A number, not the snapshot: the interval must not be rebuilt by every
      // response, or each fetch would schedule the next one immediately.
      const servicePeriod = servicePollMs(service)

      const readApp = useCallback(() => {
        const app = panelApp(iframeRef.current?.contentWindow)
        if (app === null) return null
        appRef.current = app
        return app
      }, [])

      const readEditor = useCallback(() => {
        const app = readApp()
        return app === null ? null : editorAdapter(app, iframeRef.current?.contentWindow)
      }, [readApp])

      // One loop per session: it owns the last signature, both names and the
      // revision, which have to survive every re-render.
      const loopRef = useRef(null)
      // Kept in refs so the loop always calls the current locale-bound `post`
      // and translator without being rebuilt when the locale changes.
      const tRef = useRef(t)
      tRef.current = t
      const postRef = useRef(null)
      const post = useCallback(async payload => {
        const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) throw new Error(`${t('syncFailed')} HTTP ${response.status}`)
        return response.json().catch(() => null)
      }, [sessionId, t])
      postRef.current = post
      if (loopRef.current === null || loopRef.current.sessionId !== sessionId) {
        loopRef.current = {
          sessionId,
          sync: createSync({
            sessionId,
            editor: readEditor,
            post: payload => postRef.current(payload),
            now: () => Date.now(),
            onPost: () => {
              // A post makes this graph the known one, so an iframe load's
              // pending invalidation is satisfied.
              forceNextRef.current = false
              setStatus('syncing')
              setMessage('')
            },
            bridgeError: () => tRef.current('bridgeUnavailable'),
          }),
        }
      }
      const loop = loopRef.current.sync

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

      /**
       * Adopt a name the Host holds for this session.
       *
       * The bar always shows it. The editor's tab follows only when the file
       * really exists, so the panel never invents a save: a name that is only a
       * slot cannot repoint Save at a path the user cannot find.
       * @param {any} app - the editor's `comfyAPI.app.app`.
       * @param {string} name - the Host's name for this session's workflow.
       * @returns {Promise<boolean>} whether the editor's label changed.
       */
      const adoptWorkflowName = useCallback(async (app, name) => {
        const win = iframeRef.current?.contentWindow
        if (win === null || win === undefined) return false
        if (typeof name !== 'string' || name.length === 0) return false
        const cache = workflowFileCacheRef.current
        let exists = cache.get(name)
        if (exists === undefined) {
          exists = await workflowFileExists(win, name)
          cache.set(name, exists)
        }
        if (!exists) return false
        if (!bindWorkflowLabel(app, name)) return false
        // The editor now carries the name, so the next sync must not report it
        // back as if it were a rename the user just made.
        loopRef.current?.sync.adopt(name)
        return true
      }, [])

      /**
       * Render one push's decision.
       *
       * These updates used to sit inside the push callback; keeping them here
       * leaves the loop free of React while both callers (the timer and the
       * manual sync) still show the same result.
       * @param {any} app - the editor the push read.
       * @param {any} result - the object `sync.push` resolved with.
       * @returns {void}
       */
      const applySync = useCallback((app, result) => {
        if (result.posted !== true) return
        setStats({ nodes: result.nodes, links: result.links, revision: result.revision, name: result.name })
        // A tool can name the session (save, load) while the panel is open; the
        // editor's tab follows when the file it names really exists.
        if (result.adoptName !== null) void adoptWorkflowName(app, result.adoptName)
        setLastSyncAt(result.at)
        setStatus('ready')
        // A fresh editor opens at ComfyUI's default camera, which leaves parts
        // of the graph off-screen; frame it once, unless the current view
        // already shows every node.
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
      }, [adoptWorkflowName])

      const syncNow = useCallback(async (force = true) => {
        const app = readApp()
        if (app === null) {
          setStatus('loading')
          setMessage(t('bridgeUnavailable'))
          return false
        }
        try {
          applySync(app, await loop.push(force))
          return true
        } catch (error) {
          setStatus('error')
          setMessage(error instanceof Error ? error.message : String(error))
          return false
        }
      }, [applySync, loop, readApp, t])
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
        // Counters travel with the edit so a batch that half-applied (a graph
        // left with no links) is visible in the tool result, not only in the
        // next status read.
        const links = graph.links instanceof Map ? graph.links.size : Object.keys(graph.links ?? {}).length
        return { applied: applied.length, nodes: graph._nodes?.length ?? 0, links, operations: applied }
      }, [syncNow, t])

      const applyWorkflow = useCallback((app, workflow, name) => loadWorkflow(app, workflow, {
        fit: target => fitCanvas(target),
        sync: () => syncNow(true),
        name,
      }), [syncNow])

      const runCommand = useCallback(async (app, command) => {
        if (command.kind === 'screenshot') return captureGraph(app)
        if (command.kind === 'workflow') return applyWorkflow(app, command.workflow, command.name)
        return applyOperations(app, command.operations ?? [])
      }, [applyOperations, applyWorkflow])

      const commandRef = useRef(null)
      commandRef.current = runCommand

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
                const value = await commandRef.current(app, command)
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
        setRun(current => applyRunEvent(current, event, Date.now()))
      }, [])

      /**
       * Drop the fallback timer a successful Cancel armed, if any.
       * @returns {void}
       */
      const clearCancelTimer = useCallback(() => {
        if (cancelTimerRef.current === null) return
        clearTimeout(cancelTimerRef.current)
        cancelTimerRef.current = null
      }, [])

      /**
       * Ask ComfyUI to stop this session's prompt.
       *
       * The button is disabled while the request is in flight and returns on a
       * failure; a success waits for `execution_interrupted` / `execution_error`
       * to end the run, because the server may still be tearing down the last
       * node. If that event never arrives, the fallback re-enables the button
       * after `CANCEL_FALLBACK_MS` and leaves the progress line untouched.
       * No response, including a network error, reaches the console as an
       * exception: the bar says it could not cancel and keeps the run.
       * @returns {Promise<void>} resolves when the request settles.
       */
      const cancelRun = useCallback(async () => {
        const current = runRef.current
        if (current === null || current === undefined || current.status !== 'running') return
        if (current.cancel === 'busy') return
        const promptId = typeof current.promptId === 'string' ? current.promptId : ''
        if (promptId === '') return
        clearCancelTimer()
        setRun(value => (value !== null && value.promptId === promptId && value.status === 'running')
          ? applyRunEvent(value, { kind: 'cancel', state: 'busy' })
          : value)
        try {
          const response = await fetch(INTERRUPT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ prompt_id: promptId }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          cancelTimerRef.current = setTimeout(() => {
            cancelTimerRef.current = null
            setRun(value => (value !== null && value.promptId === promptId && value.status === 'running' && value.cancel === 'busy')
              ? applyRunEvent(value, { kind: 'cancel', state: 'none' })
              : value)
          }, CANCEL_FALLBACK_MS)
        } catch {
          clearCancelTimer()
          setRun(value => (value !== null && value.promptId === promptId && value.status === 'running')
            ? applyRunEvent(value, { kind: 'cancel', state: 'failed' })
            : value)
        }
      }, [clearCancelTimer])

      // The fallback belongs to one run. A new prompt or a status change makes
      // it irrelevant; progress updates on the same running prompt leave it
      // armed, or a busy server would keep the button disabled forever.
      const cancelScope = run === null ? '' : `${run.promptId ?? ''}:${run.status ?? ''}`
      useEffect(() => clearCancelTimer, [cancelScope, clearCancelTimer])

      // Execution events follow the socket that queued the prompt, and that is
      // the editor's own. Reading them from its event bus is what lets the
      // Host's progress, the digest and `comfyui_progress` see a run at all: a
      // socket the panel opened for itself would receive nothing but `status`,
      // because no prompt ever queues under that id.
      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let attached = null
        const detach = () => {
          if (attached === null) return
          attached.detach()
          attached = null
        }
        // The shim exposes the api inside the app; the namespace path is the
        // fallback for a frontend whose app object no longer carries it.
        const editorApi = () => {
          const win = iframeRef.current?.contentWindow
          for (const candidate of [win?.comfyAPI?.app?.app?.api, win?.comfyAPI?.api?.api]) {
            if (typeof candidate?.addEventListener === 'function') return candidate
          }
          return null
        }
        const attach = () => {
          const api = editorApi()
          if (api === null) return
          if (attached !== null && attached.api === api) return
          detach()
          attached = { api, detach: relayEditorEvents(api, { applyEvent, postEvent }) }
        }
        attach()
        // The iframe finishes booting after this effect runs, and every reload
        // brings a new api: keep checking until we are attached to the current
        // one, and re-attach when it changes.
        const timer = setInterval(attach, 1000)
        return () => {
          clearInterval(timer)
          detach()
        }
      }, [applyEvent, postEvent, sessionId])

      // One interval while a run with a start time is on screen; its cleanup
      // covers the run ending, a reload, and unmounting the panel.
      const runningStartedAt = run !== null && run.status === 'running' && typeof run.startedAt === 'number'
        ? run.startedAt
        : null
      useEffect(() => {
        if (runningStartedAt === null) return undefined
        const timer = setInterval(() => setRunClock(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [runningStartedAt])

      // The preview Blob becomes an object URL only here. Replacing the
      // preview or ending the run runs this cleanup, which revokes the old URL,
      // so a run that produces dozens of previews leaks no object URLs.
      const previewBlob = run?.preview?.blob ?? null
      useEffect(() => {
        if (previewBlob === null) {
          setPreviewUrl('')
          return undefined
        }
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
        let url = ''
        try {
          url = URL.createObjectURL(previewBlob)
        } catch {
          setPreviewUrl('')
          return undefined
        }
        setPreviewUrl(url)
        return () => URL.revokeObjectURL(url)
      }, [previewBlob])

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
            const due = Date.now() - lastForcedAtRef.current > 30000
            if (due) lastForcedAtRef.current = Date.now()
            const force = forceNextRef.current || due
            forceNextRef.current = false
            applySync(app, await loop.push(force))
          } catch (error) {
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
      }, [applySync, loop, readApp, sessionId])

      useEffect(() => {
        let disposed = false
        void loadService()
        const timer = setInterval(() => {
          if (!disposed && document.visibilityState === 'visible') void loadService()
        }, servicePeriod)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [loadService, servicePeriod])

      const reload = useCallback(() => {
        const frame = iframeRef.current
        if (frame === null) return
        // The new page fetches its own autosaved graph, so the signature and
        // the name the old one carried say nothing about it.
        loopRef.current?.sync.reset()
        appRef.current = null
        fittedRef.current = false
        workflowFileCacheRef.current.clear()
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
        // The boot clock also runs while the Host is starting the child process:
        // "Starting ComfyUI… 12s" is the difference between a progress report
        // and a spinner that looks hung. It must not run while the server is
        // stopped, or an hour of waiting would turn the first second of a real
        // start into "the editor did not load".
        const counting = !serverStopped && (status === 'loading' || serverStarting)
        if (!counting) {
          setBootSeconds(0)
          return undefined
        }
        setBootSeconds(0)
        const started = Date.now()
        const timer = setInterval(() => {
          setBootSeconds(Math.round((Date.now() - started) / 1000))
        }, 1000)
        return () => clearInterval(timer)
      }, [serverStarting, serverStopped, status])

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
      // The label is one pure function so node, steps, seconds and cancel
      // failures cannot drift apart; the ticking clock is the only state it
      // reads beyond the run.
      const runText = runLabel(run, t, runningStartedAt === null ? Date.now() : Math.max(Date.now(), runClock))
      const filesTitle = run !== null && Array.isArray(run.files) && run.files.length > 0
        ? run.files.join(' · ')
        : ''
      const previewNode = run?.preview?.nodeId
      const previewTitle = previewNode === null || previewNode === undefined
        ? filesTitle
        : [t('runNode').replace('{{node}}', String(previewNode)), filesTitle].filter(part => part !== '').join(' · ')

      if (sessionId === undefined || sessionId === null) {
        return h('div', { className: 'dsh-comfyui-panel' },
          h('style', null, CSS),
          h('div', { className: 'dsh-comfyui-notice' }, t('noSession')),
        )
      }

      // Lifecycle controls live in the bar; this form is configuration only, so
      // there is exactly one place that decides whether Start is clickable.
      const plan = barPlan({ status, service, busy: serviceBusy, dir: serviceCwd, bootSeconds, t })
      const stage = overlayPlan({ status, service, bootSeconds, dir: serviceCwd, t })
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
            onChange: event => setServiceCwd(/** @type {HTMLInputElement} */ (event.target).value),
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
          syncAt: lastSyncAt,
          runText,
          previewUrl,
          previewTitle,
          filesTitle,
          run,
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
          onCancel: () => { void cancelRun() },
        }),
        message === '' ? null : h('div', { className: 'dsh-comfyui-notice', 'data-tone': status === 'error' ? 'error' : 'info' }, message),
        service?.frontend?.status === 'mismatch'
          ? h('div', { className: 'dsh-comfyui-notice', 'data-tone': 'info' }, t('frontendUnverified').replace('{{installed}}', String(service.frontend.installed)).replace('{{expected}}', String(service.frontend.expected)))
          : null,
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
              forceNextRef.current = true
              appRef.current = null
              fittedRef.current = false
              setStatus('loading')
            },
          }),
          // The iframe paints ComfyUI's own splash first; without this the
          // panel looks stuck on a white rectangle while the frontend boots.
          // A stopped server, a starting one, and a stuck frontend each get
          // their own face: only the last untouched state is a bare spinner.
          h(StageOverlay, {
            stage,
            busy: serviceBusy,
            t,
            onStart: () => { void serviceAction('start') },
            onReload: reload,
            onService: () => setServiceOpen(true),
          }),
          notice === null ? null : h('div', { className: 'dsh-comfyui-toast' }, notice.text),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      // Editor operations, dictionaries, and the bar/stage rules, exposed for
      // test/client-ops.mjs. The Host loader reads only `inject` and `apply`.
      __ops: { applyOperation, captureGraph, applyWorkflowGraph, loadWorkflow, coerceWidgetValue, frontendClientId, panelApp, workflowNameFromEditor, bindWorkflowLabel, mapApiEvent, relayEditorEvents, readPreview, progressSummary, applyRunEvent, runLabel, cancelLabel, TopBar, barPlan, overlayPlan, servicePollMs, StageOverlay, projectGraph, fitCanvas, viewShowsAll, describeOperation, en, zh, createSync },
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
      },
    }
  },
})
