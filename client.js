/**
 * Browser half of the dsh-comfyui P0 bundle.
 *
 * The left-sidebar entry opens this page in the main column. The real ComfyUI
 * frontend sits in a same-origin iframe. The column on the right sends into
 * the session that owns this canvas. Because the Host proxies ComfyUI under `/comfyui/`, the parent page
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
    const PANEL_KEY = 'comfyui'
    const PANEL_URL = '/comfyui/'
    const DESK_URL = '/api/comfyui/desk'
    const DESK_CHAT_URL = '/api/comfyui/desk/chat'
    const DESK_TRANSCRIPT_URL = '/api/comfyui/desk/transcript'
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
      modelEdited: 'Model edit',
      syncedAt: 'synced {{time}}',
      syncPending: 'syncing…',
      notRunning: 'ComfyUI is not running',
      notRunningHint: 'Start the server from the bottom toolbar; the editor appears here once it is ready.',
      notRunningPick: 'Open ComfyUI first — the desktop app or a portable build — or pick its folder in Settings and start it from the bottom toolbar.',
      installHint: 'No ComfyUI yet?',
      installLink: 'Install it',
      editorStalled: 'The editor did not load',
      editorStalledHint: 'ComfyUI answers, but the frontend never exposed its editor. Reload it, or start the server again from Settings.',
      noSession: 'No session',
      stats: '{{nodes}} nodes · {{links}} links',
      statsTitle: '{{nodes}} nodes · {{links}} links · rev {{revision}}',
      editorLoading: 'Loading the editor…',
      bridgeUnavailable: 'ComfyUI did not expose its editor API. Check that the panel is served from /comfyui/.',
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
      serverAlreadyRunning: 'Already running',
      serverStarting: 'Starting ComfyUI',
      serverDir: 'ComfyUI directory',
      serverDirHint: 'The folder that contains main.py',
      serverAutoStart: 'Start with DSH',
      serverStart: 'Start',
      serverStop: 'Stop',
      serverBusy: 'Waiting for the previous request',
      serverSave: 'Save',
      serverFailed: 'Could not control ComfyUI',
      serverStartFailed: 'ComfyUI did not start',
      serverExternalHint: 'This ComfyUI was not started by the plugin, so Stop and Restart are unavailable. Restart it where it was launched.',
      serverNotOwned: 'Not managed by this plugin',
      serverPick: 'Pick the ComfyUI folder, then start it here.',
      settings: 'Settings',
      close: 'Close',
      barRunning: 'Running',
      barExternal: 'External',
      barStopped: 'Stopped',
      barStarting: 'Starting',
      barFailed: 'Start failed',
      barUnknown: 'Checking',
      assistant: 'Assistant',
      assistantClose: 'Collapse',
      assistantNew: 'New',
      assistantPlaceholder: 'Say what to change',
      assistantSend: 'Send',
      assistantSending: 'Sending…',
      assistantFailed: 'The assistant did not answer',
      assistantEmpty: 'Say what to change. The model uses the tools on this canvas.',
      assistantClosed: 'The editor is still opening.',
      instructions: 'Commands',
      compact: 'Compact',
      export: 'Export log',
      rewind: 'Rewind',
      undo: 'Undo',
      commandFailed: 'The command did not run',
      menu: 'Menu',
      model: 'Model',
      permissions: 'Permissions',
      'preset.readOnly': 'Read only',
      'preset.readOnlyDetail': 'Look, but do not change files unless you approve it.',
      'preset.workspaceWrite': 'Workspace write',
      'preset.workspaceWriteDetail': 'Edit files in the workspace. Anything wider asks first.',
      'preset.fullAccess': 'Full access',
      'preset.fullAccessDetail': 'Skip the confirmations, including file changes and commands.',
      confirmFullTitle: 'Enable Full access?',
      confirmFullBody: 'Full access lets the agent do more without asking, including sensitive actions, file changes, and commands. Use it only when you trust this task.',
      confirmFullEnable: 'Enable Full access',
      confirmCancel: 'Cancel',
      optionFailed: 'Could not change it',
      optionsFailed: 'The choices could not be read',
      optionsEmpty: 'Nothing to choose here',
      toolRunning: 'Running',
      toolDone: 'Done',
      toolFailed: 'Failed',
      toolArgs: 'Arguments',
      toolResult: 'Result',
      tokens: '{{count}} tokens',
      truncated: 'Showing the latest 40 turns; earlier ones live in the session.',
      assistantHint: 'Enter sends, Shift+Enter adds a line. Replies render as markdown.',
      assistantThinking: 'Thinking…',
      assistantWorking: 'Working',
      assistantJump: 'Jump to latest',
      copy: 'Copy',
      copied: 'Copied',
      codeBlock: 'code',
      retry: 'Retry',
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
      modelEdited: '模型修改',
      syncedAt: '已同步 {{time}}',
      syncPending: '同步中…',
      notRunning: 'ComfyUI 未运行',
      notRunningHint: '在底部工具栏点击「启动」，服务就绪后编辑器会显示在这里。',
      notRunningPick: '先打开 ComfyUI（桌面版或便携版）；也可以在「设置」里选目录，再从底部工具栏启动。',
      installHint: '还没装 ComfyUI？',
      installLink: '安装方式',
      editorStalled: '编辑器没有加载出来',
      editorStalledHint: 'ComfyUI 有响应，但前端一直没有交出编辑器。可以重新加载；如果仍不行，到「设置」里重启服务。',
      noSession: '无会话',
      stats: '{{nodes}} 个节点 · {{links}} 条连线',
      statsTitle: '{{nodes}} 个节点 · {{links}} 条连线 · rev {{revision}}',
      editorLoading: '正在加载编辑器…',
      bridgeUnavailable: 'ComfyUI 没有暴露编辑器 API。请确认面板是通过 /comfyui/ 同源加载的。',
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
      serverAlreadyRunning: '已经在运行',
      serverStarting: '正在启动 ComfyUI',
      serverDir: 'ComfyUI 目录',
      serverDirHint: '包含 main.py 的那个目录',
      serverAutoStart: '随 DSH 启动',
      serverStart: '启动',
      serverStop: '停止',
      serverBusy: '上一次请求还没结束',
      serverSave: '保存',
      serverFailed: '无法控制 ComfyUI',
      serverStartFailed: '启动失败',
      serverExternalHint: '这个 ComfyUI 不是插件启动的，停止和重启不可用；请到启动它的地方重启。',
      serverNotOwned: '不归本插件管理',
      serverPick: '选好 ComfyUI 目录后，在这里启动它。',
      settings: '设置',
      close: '关闭',
      barRunning: '运行中',
      barExternal: '外部运行',
      barStopped: '未启动',
      barStarting: '启动中',
      barFailed: '启动失败',
      barUnknown: '检查中',
      assistant: '助手',
      assistantClose: '收起',
      assistantNew: '新建',
      assistantPlaceholder: '说要改什么',
      assistantSend: '发送',
      assistantSending: '发送中…',
      assistantFailed: '助手没有回复',
      assistantEmpty: '直接说要改哪里。模型会用这张画布上的工具。',
      assistantClosed: '编辑器还在打开。',
      instructions: '指令',
      compact: '压缩',
      export: '下载日志',
      rewind: '回退',
      undo: '撤销',
      commandFailed: '命令没有执行',
      menu: '菜单',
      model: '模型',
      permissions: '访问权限',
      'preset.readOnly': '仅可查看',
      'preset.readOnlyDetail': '不能直接改文件，改动都要先批准。',
      'preset.workspaceWrite': '工作区内修改',
      'preset.workspaceWriteDetail': '可以改工作区里的文件，超出范围会先问你。',
      'preset.fullAccess': '完全权限',
      'preset.fullAccessDetail': '不再逐步确认，可以直接改文件、执行命令。',
      confirmFullTitle: '确认启用完全权限？',
      confirmFullBody: '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
      confirmFullEnable: '启用完全权限',
      confirmCancel: '取消',
      optionFailed: '切换失败',
      optionsFailed: '读不到可选项',
      optionsEmpty: '没有可选项',
      toolRunning: '运行中',
      toolDone: '完成',
      toolFailed: '失败',
      toolArgs: '参数',
      toolResult: '结果',
      tokens: '{{count}} 令牌',
      truncated: '只显示最近 40 条，更早的记录在会话里。',
      assistantHint: 'Enter 发送，Shift+Enter 换行；回复按 Markdown 渲染。',
      assistantThinking: '正在思考…',
      assistantWorking: '处理中',
      assistantJump: '回到最新',
      copy: '复制',
      copied: '已复制',
      codeBlock: '代码',
      retry: '重试',
    }

    const CSS = `
      .dsh-comfyui-panel {
        position: relative;
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: inherit;
        background: transparent;
        font: inherit;
      }
      .dsh-comfyui-bar {
        /* ComfyUI owns every corner: tabs top-left, Run top-right, its settings
           and frame-rate readout bottom-left, zoom bottom-right. The bottom
           centre belongs to none of them, so the toolbar sits there, over the
           canvas, without pushing it anywhere. */
        position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
        z-index: 4;
        display: flex; align-items: center; gap: 4px;
        max-width: calc(100% - 24px);
        padding: 4px;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        border-radius: 999px;
        background: var(--glass, var(--dsw-alias-bg-layer-1));
        backdrop-filter: blur(24px) saturate(160%);
        box-shadow: var(--dsw-elevation-soft);
        font-size: 13px; line-height: 20px;
        color: var(--ink2);
      }
      .dsh-comfyui-status {
        display: flex; align-items: center; gap: 6px;
        min-width: 0; padding: 0 8px 0 6px;
      }
      .dsh-comfyui-actions { display: flex; align-items: center; gap: 2px; }
      .dsh-comfyui-bar .dsh-comfyui-button {
        height: 28px; padding: 0 12px; border-radius: 999px;
        color: var(--ink, var(--dsw-alias-label-primary));
      }
      .dsh-comfyui-bar .dsh-comfyui-button:hover:not(:disabled) {
        background: color-mix(in srgb, var(--ink) 10%, transparent);
      }
      .dsh-comfyui-bar .dsh-comfyui-button:disabled {
        color: var(--ink2, var(--dsw-alias-label-secondary));
        opacity: .6;
      }
      .dsh-comfyui-bar .dsh-comfyui-button[data-active="true"] {
        background: color-mix(in srgb, var(--ink) 10%, transparent);
      }
      .dsh-comfyui-bar-sep {
        width: 1px; height: 14px; flex: 0 0 auto;
        margin: 0 3px;
        background: color-mix(in srgb, var(--ink) 22%, transparent);
      }
      .dsh-comfyui-visually-hidden {
        position: absolute; width: 1px; height: 1px; overflow: hidden;
        clip-path: inset(50%); white-space: nowrap;
      }
      .dsh-comfyui-bar .dsh-comfyui-icon { width: 28px; padding: 0; }
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
        min-width: 0; overflow: hidden; text-overflow: ellipsis;
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
      .dsh-comfyui-actions {
        display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
        margin-left: 2px;
      }
      .dsh-comfyui-bar-divider { margin-left: 2px; padding: 0 12px 0 10px; }
      .dsh-comfyui-bar-divider[data-active="true"] {
        background: var(--dsw-alias-bg-layer-2); color: var(--ink);
      }
      .dsh-comfyui-button {
        height: 32px; padding: 0 12px; border-radius: var(--r-md, 12px); cursor: pointer;
        flex: 0 0 auto;
        border: 0;
        background: transparent; color: var(--ink2, var(--dsw-alias-label-secondary));
        font: inherit;
      }
      .dsh-comfyui-button:hover:not(:disabled) {
        background: var(--hover, var(--dsw-alias-bg-layer-2));
        color: var(--ink, var(--dsw-alias-label-primary));
      }
      .dsh-comfyui-button:disabled { opacity: .45; cursor: default; }
      .dsh-comfyui-button[data-variant="primary"] {
        background: var(--primary, var(--dsw-alias-button-primary-fill));
        color: var(--on-primary, var(--dsw-alias-label-primary-foreground));
      }
      .dsh-comfyui-button[data-variant="primary"]:hover:not(:disabled) {
        background: var(--primary-hover, var(--dsw-alias-button-primary-hover));
        color: var(--on-primary, var(--dsw-alias-label-primary-foreground));
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
      .dsh-comfyui-frame { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 0; background: var(--dsw-alias-bg-base); }
      .dsh-comfyui-overlay {
        position: absolute; inset: 0; z-index: 1;
        display: flex; align-items: center; justify-content: center; gap: 10px;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-base);
        font-size: 13px;
      }
      .dsh-comfyui-toast {
        position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
        z-index: 2; max-width: calc(100% - 32px);
        padding: 8px 14px; border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-overlay);
        color: var(--dsw-alias-label-primary);
        font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        pointer-events: none;
      }
      .dsh-comfyui-empty {
        flex-direction: column; gap: 0;
        background:
          radial-gradient(120% 80% at 50% 8%, color-mix(in srgb, var(--card) 70%, transparent) 0%, transparent 62%),
          var(--dsw-alias-bg-base);
      }
      .dsh-comfyui-empty-card {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        width: min(420px, calc(100% - 48px));
        padding: 40px 36px 34px;
        text-align: center;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        border-radius: 24px;
        background: color-mix(in srgb, var(--card) 62%, transparent);
        backdrop-filter: blur(30px) saturate(160%);
        box-shadow: 0 20px 60px color-mix(in srgb, #000 10%, transparent);
      }
      .dsh-comfyui-empty-mark {
        display: grid; place-items: center;
        width: 68px; height: 68px; border-radius: 22px;
        margin-bottom: 2px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--card) 92%, transparent), color-mix(in srgb, var(--card) 60%, transparent));
        box-shadow:
          inset 0 0 0 .5px var(--line, var(--dsw-alias-border-l1)),
          0 10px 30px color-mix(in srgb, #000 12%, transparent);
      }
      .dsh-comfyui-empty-title {
        color: var(--dsw-alias-label-primary);
        font-size: 19px; line-height: 26px; font-weight: 600; letter-spacing: -.01em;
      }
      .dsh-comfyui-empty-hint {
        max-width: 292px; line-height: 1.6;
        overflow-wrap: anywhere;
        color: var(--dsw-alias-label-secondary);
      }
      .dsh-comfyui-empty-link {
        color: var(--dsw-alias-brand-primary, var(--ink));
        text-decoration: underline; text-underline-offset: 3px;
      }
      .dsh-comfyui-empty-link:hover { text-decoration-thickness: 2px; }
      .dsh-comfyui-empty-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
      .dsh-comfyui-empty-actions .dsh-comfyui-button { height: 36px; padding: 0 18px; border-radius: 10px; }
      .dsh-comfyui-empty-actions .dsh-comfyui-button[data-variant="quiet"] {
        box-shadow: inset 0 0 0 .5px var(--line, var(--dsw-alias-border-l1));
      }
      .dsh-comfyui-empty-note {
        max-width: 100%; margin-top: 2px;
        padding: 5px 11px;
        border-radius: 9px;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
        color: var(--ink2, var(--dsw-alias-label-secondary));
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px; line-height: 16px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .dsh-comfyui-loading {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 20px;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        border-radius: 999px;
        background: var(--glass, var(--dsw-alias-bg-layer-1));
        backdrop-filter: blur(24px) saturate(160%);
        box-shadow: var(--dsw-elevation-soft);
      }
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
      .dsh-comfyui-dialog-layer { position: absolute; inset: 0; z-index: 5; }
      .dsh-comfyui-sheet {
        /* Same glass and radius as the pill it grows out of: a panel control,
           not a modal dropped on top of the canvas. */
        position: absolute; left: 50%; bottom: 58px; transform: translateX(-50%);
        box-sizing: border-box;
        display: flex; flex-direction: column; gap: 14px;
        width: min(340px, calc(100% - 32px));
        padding: 16px;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        border-radius: 18px;
        background: var(--glass, var(--dsw-alias-bg-layer-1));
        backdrop-filter: blur(28px) saturate(160%);
        box-shadow: 0 16px 44px color-mix(in srgb, #000 22%, transparent);
        color: var(--ink);
        font-size: 13px; line-height: 19px;
      }
      .dsh-comfyui-sheet-head { display: flex; align-items: center; gap: 8px; }
      .dsh-comfyui-sheet-head strong { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
      .dsh-comfyui-sheet-body { display: flex; flex-direction: column; gap: 10px; }
      .dsh-comfyui-field { display: flex; flex-direction: column; gap: 6px; }
      .dsh-comfyui-field > span { color: var(--ink2, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 16px; }
      .dsh-comfyui-input {
        height: 32px; padding: 0 10px;
        border-radius: 9px;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        background: color-mix(in srgb, var(--dsw-alias-bg-base) 86%, transparent);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px;
      }
      .dsh-comfyui-input:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dsh-comfyui-check {
        display: flex; align-items: center; gap: 8px; cursor: pointer;
        color: var(--ink2, var(--dsw-alias-label-secondary));
      }
      .dsh-comfyui-sheet-foot { display: flex; justify-content: flex-end; gap: 6px; }
      .dsh-comfyui-sheet-foot .dsh-comfyui-button { height: 30px; padding: 0 14px; border-radius: 9px; }
      .dsh-comfyui-sheet-message { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 16px; }
      .dsh-comfyui-sheet-hint { color: var(--ink2, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 16px; }
      .dsh-comfyui-desk {
        --ink: var(--dsw-alias-label-primary);
        --ink2: var(--dsw-alias-label-secondary);
        --ink3: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        --on-primary: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-label-primary-foreground));
        --primary: var(--dsw-alias-button-primary-fill);
        --primary-hover: var(--dsw-alias-button-primary-hover);
        --line: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
        --hover: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
        --active: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2));
        --card: var(--dsw-alias-bg-layer-2);
        --glass: color-mix(in srgb, var(--card) 72%, transparent);
        --r-md: var(--dsw-radius-md, 12px);
        --r-lg: var(--dsw-radius-lg, 16px);
        --r-panel: var(--dsw-radius-panel, 28px);
        position: relative;
        display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0;
        overflow: clip;
        background: var(--dsw-alias-bg-base);
        color: var(--ink);
        font-family: var(--dsw-font-family, system-ui, sans-serif);
        font-size: 14px; line-height: 22px;
      }
      .dsh-comfyui-desk > .dsh-comfyui-panel { flex: 1 1 auto; min-width: 0; }
      .dsh-comfyui-dock {
        flex: 0 0 336px; width: 336px; min-width: 0; min-height: 0;
        display: flex; flex-direction: column;
        border-left: .5px solid var(--line);
        background: color-mix(in srgb, var(--card) 62%, transparent);
        backdrop-filter: blur(28px) saturate(160%);
      }
      .dsh-comfyui-dock-head {
        flex: 0 0 auto; display: flex; align-items: center;
        padding: 14px 16px 8px 18px;
      }
      .dsh-comfyui-dock-head strong { font-size: 15px; line-height: 22px; font-weight: 600; }
      .dsh-comfyui-dock-head { justify-content: space-between; }
      .dsh-comfyui-dock.is-closed {
        flex-basis: 0; width: 0; border-left: 0; overflow: visible;
        /* A zero-width dock still had its own backdrop root, and the tab's
           glass inside it sampled that instead of the canvas: the tab painted
           dark while the toolbar painted light. */
        backdrop-filter: none;
        background: transparent;
      }
      .dsh-comfyui-dock.is-closed .dsh-comfyui-dock-head {
        position: absolute; right: 0; top: 50%; transform: translateY(-50%);
        padding: 0; z-index: 5;
      }
      .dsh-comfyui-dock.is-closed .dsh-comfyui-dock-head strong,
      .dsh-comfyui-dock.is-closed .dsh-comfyui-dock-new { display: none; }
      .dsh-comfyui-dock-new {
        margin-left: auto;
        height: 28px; padding: 0 10px; border: 0; border-radius: 8px;
        background: transparent; color: var(--ink2, var(--dsw-alias-label-secondary));
        cursor: pointer; font: inherit; font-size: 13px;
      }
      .dsh-comfyui-dock-new:hover { color: var(--ink, var(--dsw-alias-label-primary)); }
      .dsh-comfyui-dock-new:disabled { opacity: .45; cursor: default; }
      .dsh-comfyui-dock-toggle {
        width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--r-md, 12px);
        display: grid; place-items: center;
        background: transparent; color: var(--ink2, var(--dsw-alias-label-secondary));
        cursor: pointer;
        font: inherit;
      }
      .dsh-comfyui-dock-toggle:hover {
        background: color-mix(in srgb, var(--ink, var(--dsw-alias-label-primary)) 10%, transparent);
        color: var(--ink, var(--dsw-alias-label-primary));
      }
      .dsh-comfyui-dock.is-closed .dsh-comfyui-dock-toggle {
        width: auto; height: auto; min-height: 72px; padding: 14px 9px;
        writing-mode: vertical-rl;
        border: .5px solid var(--line, var(--dsw-alias-border-l1));
        border-right: 0; border-radius: 999px 0 0 999px;
        /* The same glass as the toolbar over the canvas: the tab sits on the
           same surface and read as a solid white slab beside it. */
        background: var(--glass, var(--dsw-alias-bg-layer-1));
        backdrop-filter: blur(24px) saturate(160%);
        color: var(--ink, var(--dsw-alias-label-primary));
        font-size: 13px; line-height: 20px; letter-spacing: .04em;
        box-shadow: var(--dsw-elevation-soft);
      }
      .dsh-comfyui-dock.is-closed .dsh-comfyui-dock-toggle:hover {
        /* The same wash the toolbar's buttons use, laid over the glass instead
           of replacing it: a translucent-only fill let the canvas through. */
        background:
          linear-gradient(color-mix(in srgb, var(--ink, var(--dsw-alias-label-primary)) 10%, transparent), color-mix(in srgb, var(--ink, var(--dsw-alias-label-primary)) 10%, transparent)),
          var(--glass, var(--dsw-alias-bg-layer-1));
      }
      .dsh-comfyui-dock-log {
        flex: 1 1 auto; min-height: 0; overflow: auto;
        display: flex; flex-direction: column; gap: 14px;
        padding: 6px 18px 12px;
      }
      .dsh-comfyui-dock-log:has(.dsh-comfyui-dock-empty) { justify-content: center; }
      .dsh-comfyui-dock-empty {
        margin: 0; padding: 0 4px 28px;
        color: var(--ink3);
        font-size: 25px; line-height: 36px; font-weight: 300;
      }
      .dsh-comfyui-dock-row { display: flex; }
      .dsh-comfyui-dock-row[data-role="user"] { justify-content: flex-end; }
      .dsh-comfyui-dock-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dsh-comfyui-dock-badge {
        flex: 0 0 auto; padding: 1px 7px; border-radius: 999px;
        background: color-mix(in srgb, var(--primary) 14%, transparent);
        color: var(--primary);
        font-size: 11px; line-height: 16px; letter-spacing: .02em;
      }
      .dsh-comfyui-dock-msg {
        position: relative; min-width: 0; max-width: 100%;
        overflow-wrap: anywhere;
      }
      .dsh-comfyui-dock-row[data-role="user"] .dsh-comfyui-dock-msg {
        max-width: 88%; padding: 9px 13px; border-radius: var(--r-lg);
        background: var(--active); color: var(--ink);
      }
      .dsh-comfyui-dock-row[data-role="tool"] { padding-left: 2px; }
      .dsh-comfyui-dock-tool {
        display: inline-flex; align-items: center; gap: 6px;
        max-width: 100%; padding: 2px 9px 2px 7px;
        border: .5px solid var(--line); border-radius: 999px;
        background: color-mix(in srgb, var(--card) 70%, transparent);
        color: var(--ink3);
        font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
        font-size: 11.5px; line-height: 17px;
      }
      .dsh-comfyui-dock-tool-mark { color: var(--ink3); opacity: .7; }
      .dsh-comfyui-dock-tool-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-comfyui-dock-meta {
        /* A quiet line under the bubble: a reply reads as text until the reader
           reaches for its source, its time, or its cost. */
        display: flex; align-items: center; gap: 8px; margin-top: 2px;
        color: var(--ink3); font-size: 11px; line-height: 16px;
        opacity: 0; transition: opacity .15s ease;
      }
      .dsh-comfyui-dock-row:hover .dsh-comfyui-dock-meta,
      .dsh-comfyui-dock-msg:focus-within .dsh-comfyui-dock-meta { opacity: 1; }
      .dsh-comfyui-dock-action {
        padding: 0; border: 0; border-radius: 6px;
        background: transparent; color: inherit;
        cursor: pointer; font: inherit; font-size: 11px; line-height: 16px;
      }
      .dsh-comfyui-dock-action:hover { color: var(--ink); }
      .dsh-comfyui-dock-card {
        max-width: 100%; min-width: 0;
        border: .5px solid var(--line); border-radius: 10px;
        background: color-mix(in srgb, var(--card) 70%, transparent);
        overflow: hidden;
      }
      .dsh-comfyui-dock-card-head {
        display: flex; align-items: center; gap: 7px; width: 100%;
        padding: 5px 10px 5px 8px;
        border: 0; background: transparent; cursor: pointer;
        color: var(--ink2); font: inherit; font-size: 12px; line-height: 18px;
        text-align: left;
      }
      .dsh-comfyui-dock-card-head:disabled { cursor: default; }
      .dsh-comfyui-dock-card-mark { flex: 0 0 auto; color: var(--ink3); font-size: 10px; }
      .dsh-comfyui-dock-card-name {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
        font-size: 11.5px;
      }
      .dsh-comfyui-dock-card-status { flex: 0 0 auto; color: var(--ink3); font-size: 11px; }
      .dsh-comfyui-dock-card[data-status="error"] .dsh-comfyui-dock-card-status { color: var(--dsw-alias-state-error-primary); }
      .dsh-comfyui-dock-card-body { border-top: .5px solid var(--line); padding: 6px 10px 8px; }
      .dsh-comfyui-dock-card-block + .dsh-comfyui-dock-card-block { margin-top: 6px; }
      .dsh-comfyui-dock-card-label {
        display: block; margin-bottom: 2px;
        color: var(--ink3); font-size: 10.5px; line-height: 15px;
      }
      .dsh-comfyui-dock-card-pre {
        margin: 0; max-height: 180px; overflow: auto;
        font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
        font-size: 11.5px; line-height: 17px;
        white-space: pre-wrap; word-break: break-word;
        color: var(--ink2);
      }
      .dsh-comfyui-dock-truncated {
        margin: 0 0 6px; padding: 4px 8px; border-radius: 8px;
        background: color-mix(in srgb, var(--ink) 5%, transparent);
        color: var(--ink3); font-size: 11px; line-height: 16px;
      }
      .dsh-comfyui-thinking {
        display: inline-flex; align-items: center; gap: 5px;
        color: var(--ink3); font-size: 12.5px; line-height: 20px;
      }
      .dsh-comfyui-thinking-dot {
        width: 5px; height: 5px; border-radius: 50%;
        background: currentColor; opacity: .35;
        animation: dsh-comfyui-pulse 1.1s ease-in-out infinite;
      }
      .dsh-comfyui-thinking-dot:nth-child(2) { animation-delay: .15s; }
      .dsh-comfyui-thinking-dot:nth-child(3) { animation-delay: .3s; }
      .dsh-comfyui-thinking-label { margin-left: 3px; }
      @keyframes dsh-comfyui-pulse {
        0%, 100% { opacity: .25; transform: translateY(0); }
        50% { opacity: .9; transform: translateY(-1px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-comfyui-thinking-dot { animation: none; opacity: .55; }
      }
      .dsh-comfyui-dock-emptyblock { padding: 0 4px 24px; }
      .dsh-comfyui-dock-emptyblock .dsh-comfyui-dock-empty { padding: 0 0 8px; }
      .dsh-comfyui-dock-hint { margin: 0; color: var(--ink3); font-size: 12px; line-height: 18px; }
      .dsh-comfyui-dock-jump {
        align-self: center; margin: -4px 0 8px;
        padding: 4px 12px; border: .5px solid var(--line); border-radius: 999px;
        background: var(--card); color: var(--ink2);
        box-shadow: var(--dsw-elevation-soft);
        cursor: pointer; font: inherit; font-size: 12px; line-height: 18px;
      }
      .dsh-comfyui-dock-jump:hover { color: var(--ink); }
      .dsh-comfyui-dock-jump[hidden] { display: none; }
      .dsh-comfyui-dock-error {
        flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
        margin: 0; padding: 0 18px 8px;
        color: var(--dsw-alias-state-error-primary);
        font-size: 13px; line-height: 18px;
      }
      .dsh-comfyui-dock-error-text { flex: 1 1 auto; min-width: 0; }
      .dsh-comfyui-dock-retry {
        flex: 0 0 auto; padding: 2px 9px; border: .5px solid currentColor; border-radius: 999px;
        background: transparent; color: inherit; cursor: pointer;
        font: inherit; font-size: 12px; line-height: 16px;
      }
      .dsh-comfyui-md { font-size: 14px; line-height: 22px; }
      .dsh-comfyui-md > :first-child { margin-top: 0; }
      .dsh-comfyui-md > :last-child { margin-bottom: 0; }
      .dsh-comfyui-md-p { margin: 0 0 8px; white-space: pre-wrap; }
      .dsh-comfyui-md-heading {
        margin: 14px 0 6px; font-size: 14.5px; line-height: 21px; font-weight: 600;
      }
      .dsh-comfyui-md-list { margin: 0 0 8px; padding-left: 20px; }
      .dsh-comfyui-md-list li { margin: 2px 0; }
      .dsh-comfyui-md-quote {
        margin: 0 0 8px; padding: 2px 0 2px 10px;
        border-left: 2px solid color-mix(in srgb, var(--ink) 22%, transparent);
        color: var(--ink2);
      }
      .dsh-comfyui-md-rule { margin: 12px 0; border: 0; border-top: .5px solid var(--line); }
      .dsh-comfyui-md-inline-code {
        padding: 1px 5px; border-radius: 5px;
        background: color-mix(in srgb, var(--ink) 8%, transparent);
        font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
        font-size: 12.5px;
      }
      .dsh-comfyui-md-code {
        margin: 0 0 8px; border: .5px solid var(--line); border-radius: 10px;
        background: color-mix(in srgb, var(--card) 80%, transparent);
        overflow: hidden;
      }
      .dsh-comfyui-md-code-head {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 3px 6px 3px 10px;
        border-bottom: .5px solid var(--line);
        color: var(--ink3);
        font-size: 11px; line-height: 16px;
      }
      .dsh-comfyui-md-lang { text-transform: lowercase; letter-spacing: .02em; }
      .dsh-comfyui-md-copy {
        padding: 1px 6px; border: 0; border-radius: 6px;
        background: transparent; color: var(--ink3); cursor: pointer;
        font: inherit; font-size: 11px; line-height: 16px;
      }
      .dsh-comfyui-md-copy:hover { color: var(--ink); }
      .dsh-comfyui-md-pre {
        margin: 0; padding: 9px 11px; overflow: auto;
        font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
        font-size: 12.5px; line-height: 19px;
        tab-size: 2;
      }
      .dsh-comfyui-md-pre code { font: inherit; }
      .dsh-comfyui-md-table-wrap { margin: 0 0 8px; overflow-x: auto; }
      .dsh-comfyui-md-table { border-collapse: collapse; font-size: 13px; line-height: 19px; }
      .dsh-comfyui-md-table th,
      .dsh-comfyui-md-table td { padding: 4px 9px; border: .5px solid var(--line); text-align: left; }
      .dsh-comfyui-md-table th { font-weight: 600; }
      .dsh-comfyui-md a { color: var(--dsw-alias-brand-primary); text-decoration: underline; text-underline-offset: 2px; }
      .dsh-comfyui-dock-row[data-role="user"] .dsh-comfyui-md-p { white-space: pre-wrap; }
      .dsh-comfyui-dock-add {
        width: 28px; height: 28px; flex: 0 0 auto; margin-left: -6px;
        display: grid; place-items: center;
        border: 0; border-radius: 50%; padding: 0;
        background: transparent; color: var(--ink2);
        cursor: pointer; font: inherit; font-size: 18px; line-height: 1;
      }
      .dsh-comfyui-dock-add:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink); }
      .dsh-comfyui-dock-add[aria-expanded="true"] { background: color-mix(in srgb, var(--ink) 10%, transparent); color: var(--ink); }
      .dsh-comfyui-dock-menu {
        position: absolute; left: 0; right: 0; bottom: 84px;
        z-index: 6; max-height: 300px; overflow: auto;
        padding: 6px; border: .5px solid var(--line); border-radius: 14px;
        background: var(--card); box-shadow: var(--dsw-elevation-soft);
      }
      .dsh-comfyui-dock-menu-head {
        margin: 0; padding: 4px 10px 2px;
        color: var(--ink3); font-size: 11px; line-height: 16px;
      }
      .dsh-comfyui-dock-menu-item {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 10px; border: 0; border-radius: 9px;
        background: transparent; color: var(--ink);
        cursor: pointer; font: inherit; font-size: 13px; line-height: 19px;
        text-align: left;
      }
      .dsh-comfyui-dock-menu-item:hover { background: var(--hover); }
      .dsh-comfyui-dock-menu-item[data-active="true"] { color: var(--primary); font-weight: 600; }
      .dsh-comfyui-dock-menu-item[data-active="true"]::after { content: "·"; margin-left: auto; }
      .dsh-comfyui-dock-menu-choice { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; }
      .dsh-comfyui-dock-menu-detail { color: var(--ink3); font-size: 11px; font-weight: 400; line-height: 15px; }
      .dsh-comfyui-dock-menu > .dsh-comfyui-dock-menu-detail { margin: 0; padding: 2px 10px 8px; }
      .dsh-comfyui-dock-menu-item:disabled { opacity: .5; cursor: default; }
      .dsh-comfyui-dock-menu-sep { height: .5px; margin: 4px 6px; background: var(--line); }
      .dsh-comfyui-dock-menu-empty { margin: 0; padding: 6px 10px; color: var(--ink3); font-size: 12px; }
      .dsh-comfyui-dock-menu-error { margin: 0 0 4px; padding: 4px 10px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
      .dsh-comfyui-dock-controls {
        flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
        margin: 0 12px 6px; min-height: 22px;
      }
      .dsh-comfyui-dock-chip {
        /* 30/70 of the row; shrinkable so the 6px gap does not overflow it. */
        flex: 0 1 30%; min-width: 0; max-width: 30%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        padding: 1px 9px; border: .5px solid var(--line); border-radius: 999px;
        background: transparent; color: var(--ink2);
        cursor: pointer; font: inherit; font-size: 11.5px; line-height: 17px;
      }
      .dsh-comfyui-dock-chip[data-kind="model"] { flex-basis: 70%; max-width: 70%; }
      .dsh-comfyui-dock-chip:hover { color: var(--ink); border-color: color-mix(in srgb, var(--ink) 25%, transparent); }
      .dsh-comfyui-dock-form {
        position: relative;
        /* Centred, not bottom-aligned: an empty field is one line tall, and
           flex-end left the round send button sitting below that line. */
        flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
        margin: 0 12px 12px; padding: 6px 8px 6px 14px;
        border-radius: var(--r-panel);
        background: var(--card);
        box-shadow: var(--dsw-elevation-soft);
        transition: box-shadow .2s ease;
      }
      .dsh-comfyui-dock-form:focus-within {
        box-shadow: 0 0 0 1px var(--ink, var(--dsw-alias-label-primary)), var(--dsw-elevation-soft);
      }
      .dsh-comfyui-dock-input {
        flex: 1 1 auto; min-width: 0; box-sizing: border-box;
        height: 32px; max-height: 120px;
        resize: none; padding: 5px 0; border: 0; border-radius: 0;
        background: transparent; overflow: hidden;
        color: var(--ink);
        font: inherit; font-size: 14px; line-height: 22px;
      }
      .dsh-comfyui-dock-input:focus-visible { outline: none; }
      .dsh-comfyui-send {
        width: 32px; height: 32px; flex: 0 0 auto;
        display: grid; place-items: center;
        border: 0; border-radius: 50%; padding: 0; cursor: pointer;
        background: var(--primary); color: var(--on-primary);
        transition: opacity .15s, transform .2s ease;
      }
      .dsh-comfyui-send:not(:disabled):hover { transform: translateY(-1px); }
      .dsh-comfyui-send:disabled { opacity: .28; cursor: default; }
      .dsh-comfyui-send:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
      }

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
    function barPlan({ status, service, busy = false, dir = '', t }) {
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
        // The server is up, so the bar says so. Whether the embedded editor has
        // exposed its API yet is the stage's business — it is already on screen
        // with its own clock — and "running · connecting" read as if the server
        // were the thing still connecting.
        tone = status === 'error' ? 'error' : 'ok'
        label = owned ? t('barRunning') : t('barExternal')
        chipTitle = owned
          ? t('serverRunning').replace('{{pid}}', pid === '' ? '?' : pid)
          : t('serverExternal')
        if (status === 'error') label = `${label} · ${t('error')}`
      } else if (known) {
        label = t('barStopped')
        chipTitle = needDir ? t('serverPick') : t('serverStopped')
      }

      // One fixed set of controls, always in the same order and always present:
      // what changes is whether a button can be pressed, never whether it is
      // there, so the bar never changes width under the pointer.
      const canStart = known && !busy && !healthy && !starting && !needDir
      const canStop = known && owned && !busy && (state === 'running' || starting)
      const whyNotStart = () => {
        if (!known) return t('barUnknown')
        if (busy) return t('serverBusy')
        if (starting) return t('serverStarting')
        if (healthy) return owned ? t('serverAlreadyRunning') : t('serverNotOwned')
        return t('serverPick')
      }
      const whyNotStop = () => {
        if (!known) return t('barUnknown')
        if (busy) return t('serverBusy')
        // A live server this plugin does not own, including `state: 'external'`.
        // A dead one still says nothing is running, even if the last snapshot
        // was external: the pid can outlive the process.
        if (healthy && !owned) return t('serverNotOwned')
        if (state === 'running') return t('serverNotOwned')
        return t('serverStopped')
      }
      const actions = [
        {
          action: 'start',
          label: t('serverStart'),
          disabled: !canStart,
          title: canStart ? t('serverStart') : whyNotStart(),
        },
        {
          action: 'stop',
          label: t('serverStop'),
          disabled: !canStop,
          title: canStop ? t('serverStop') : whyNotStop(),
        },
      ]

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
      const idle = { stage: 'none', title: '', hint: '', seconds: 0, canStart: false, needDir, dir: '' }
      // The iframe stays mounted underneath, so a probe that flips false for one
      // poll covers the canvas for five seconds and then uncovers it; nothing
      // the user typed is lost and no reload is triggered by the overlay.
      // `=== false`, not `!healthy`: a snapshot without a health field (an older
      // Host) must fall through to the spinner, not claim the server is down.
      if (known && service.health === false && !starting) {
        // A start that already failed has a sentence; "not running, click
        // Start" sent people back to the same button. The log path is only
        // added when that sentence does not already name it.
        const failed = state === 'failed'
        const error = failed && typeof service.lastError === 'string' ? service.lastError.trim() : ''
        const logPath = failed && typeof service.logPath === 'string' ? service.logPath.trim() : ''
        return {
          stage: 'stopped',
          title: failed ? t('serverStartFailed') : t('notRunning'),
          hint: error !== '' ? error : (needDir ? t('notRunningPick') : t('notRunningHint')),
          seconds: 0,
          canStart: !needDir,
          needDir,
          dir: String(dir ?? '').trim(),
          log: logPath !== '' && !error.includes(logPath) ? logPath : '',
        }
      }
      if (starting) {
        return { stage: 'starting', title: t('serverStarting'), hint: '', seconds: bootSeconds, canStart: false, needDir, dir: '' }
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
          dir: '',
        }
      }
      return { stage: 'loading', title: t('editorLoading'), hint: '', seconds: bootSeconds, canStart: false, needDir, dir: '' }
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
    /**
     * What covers the canvas until the editor can paint. A stopped server gets
     * the why and the folder; the commands live in the bar underneath, so this
     * card holds no buttons — duplicating Start here only asked which one was
     * the real one.
     *
     * @param {{ stage: any, t: (key: string) => string, onReload: () => void }} props - the plan, the locale, and the recovery action a stalled editor needs.
     * @returns {any} the overlay, or `null` when the editor is up.
     */
    function StageOverlay({ stage, t, onReload }) {
      if (stage.stage === 'none') return null
      if (stage.stage === 'loading' || stage.stage === 'starting') {
        return h('div', { className: 'dsh-comfyui-overlay' },
          h('div', { className: 'dsh-comfyui-loading' },
            h('span', { className: 'dsh-comfyui-spinner' }),
            h('span', null, stage.seconds > 0 ? `${stage.title} ${stage.seconds}s` : stage.title),
          ),
        )
      }
      const stopped = stage.stage === 'stopped'
      const note = stopped && typeof stage.dir === 'string' && stage.dir !== '' ? stage.dir : ''
      return h('div', { className: 'dsh-comfyui-overlay dsh-comfyui-empty' },
        h('div', { className: 'dsh-comfyui-empty-card' },
          h('span', { className: 'dsh-comfyui-empty-mark' }, h(PanelIcon, { size: 34 })),
          h('span', { className: 'dsh-comfyui-empty-title' }, stage.title),
          stage.hint === '' ? null : h('span', { className: 'dsh-comfyui-empty-hint' }, stage.hint),
          // Someone with no checkout has no folder to type: the card is the
          // only place that can name where one comes from.
          stage.needDir === true
            ? h('span', { className: 'dsh-comfyui-empty-hint' },
              t('installHint'), ' ',
              h('a', {
                className: 'dsh-comfyui-empty-link',
                href: 'https://docs.comfy.org/installation',
                target: '_blank',
                rel: 'noreferrer',
              }, t('installLink')))
            : null,
          note === '' ? null : h('span', { className: 'dsh-comfyui-empty-note', title: note }, note),
          typeof stage.log === 'string' && stage.log !== ''
            ? h('span', { className: 'dsh-comfyui-empty-note', title: stage.log }, stage.log)
            : null,
          stopped ? null : h('div', { className: 'dsh-comfyui-empty-actions' },
            h('button', {
              className: 'dsh-comfyui-button',
              'data-variant': 'primary',
              type: 'button',
              onClick: onReload,
            }, t('reload')),
          ),
        ),
      )
    }

    /**
     * The panel's own toolbar: state, the two lifecycle commands, Settings,
     * and Cancel while a prompt runs. Flat, because every control here is one
     * click away from what it does — a second click to open a menu costs more
     * than the pixels it saves.
     *
     * @param {object} props - the stats, the run, the plan, and the handlers.
     * @returns {any} the bar.
     */
    function TopBar({ stats, syncLabel, syncAt, runText, previewUrl, previewTitle, filesTitle, run, plan, serviceOpen, onService, onAction, onCancel, t }) {
      const counts = t('stats')
        .replace('{{nodes}}', String(stats.nodes))
        .replace('{{links}}', String(stats.links))
      // The name leads: it is the one fact the panel and the model have to agree
      // on, and a bar that shows only counts reads the same for every workflow.
      const name = typeof stats.name === 'string' && stats.name.length > 0 ? stats.name : ''
      const statText = [name === '' ? '' : `「${name}」`, counts, syncLabel].filter(part => part.length > 0).join(' · ')
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
        // State first, then the commands: the label is what the eye lands on,
        // and the buttons sit where the thumb reaches next.
        h('div', {
          className: 'dsh-comfyui-status',
          title: [plan.chipTitle, statText].filter(part => part.length > 0).join(' · '),
        },
        h('span', { className: 'dsh-comfyui-dot', 'data-status': plan.tone }),
        h('span', { className: 'dsh-comfyui-state', 'data-tone': plan.tone }, plan.label),
        runText === '' ? null : h('span', {
          className: 'dsh-comfyui-run',
          title: filesTitle === '' ? runText : filesTitle,
        }, runText),
        previewUrl ? h('img', {
          className: 'dsh-comfyui-preview',
          src: previewUrl,
          alt: '',
          title: previewTitle,
        }) : null,
        ),
        h('span', { className: 'dsh-comfyui-bar-sep', 'aria-hidden': 'true' }),
        h('div', { className: 'dsh-comfyui-actions' },
          plan.actions.map(action => h('button', {
            key: action.action,
            className: 'dsh-comfyui-button',
            type: 'button',
            disabled: action.disabled,
            title: action.title,
            onClick: () => onAction(action.action),
          }, action.label)),
          h('span', { className: 'dsh-comfyui-bar-sep', 'aria-hidden': 'true' }),
          // Words, not a gear: it sits in the same row as the two commands, so
          // it reads as one of them.
          h('button', {
            className: 'dsh-comfyui-button',
            'data-active': serviceOpen ? 'true' : 'false',
            'data-tool': 'server',
            type: 'button',
            title: t('settings'),
            'aria-expanded': serviceOpen,
            onClick: onService,
          }, t('settings')),
          canCancel ? h('span', { key: 'sep', className: 'dsh-comfyui-bar-sep', 'aria-hidden': 'true' }) : null,
          canCancel ? h('button', {
            key: 'cancel',
            className: 'dsh-comfyui-button',
            'data-action': 'cancel',
            type: 'button',
            disabled: run.cancel === 'busy',
            onClick: onCancel,
          }, cancelLabel(run, t)) : null,
        ),
        // The counters are also the only machine-readable state the panel
        // publishes, so the headless UI check reads them instead of parsing
        // localized bar text. They stay out of the visual: the tooltip says
        // the same thing, and the canvas needs the pixels.
        h('span', {
          className: 'dsh-comfyui-stats dsh-comfyui-visually-hidden',
          title: statTitle,
          'data-workflow-name': name,
          'data-nodes': String(stats.nodes),
          'data-links': String(stats.links),
          'data-revision': String(stats.revision),
          'data-tabs': String(stats.tabs ?? 0),
          'data-synced': String(syncAt),
        }, statText),
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

    /**
     * Kinds a burst may collapse to the latest copy. Anything else is a
     * different fact: `execution_success` followed by `status` must not
     * disappear, or the Host's run record stays `running` after the graph
     * has finished.
     */
    const REPLACEABLE_RELAY_KINDS = new Set(['progress', 'status', 'executing'])

    /**
     * Fold one event into the relay box.
     *
     * Same-kind progress, status, and executing replace whatever is waiting,
     * because the Host only needs the latest of those. A different kind is
     * returned so the caller posts it now; the new event waits for the next gap.
     * @param {{ pending: object | null }} box - the relay's one waiting slot.
     * @param {object} event - the event just mapped from the editor bus.
     * @returns {object | null} the event to post immediately, when one was displaced.
     */
    function offerRelayEvent(box, event) {
      const pending = box.pending
      if (pending !== null && pending.kind === event.kind && REPLACEABLE_RELAY_KINDS.has(event.kind)) {
        box.pending = event
        return null
      }
      if (pending !== null) {
        box.pending = event
        return pending
      }
      box.pending = event
      return null
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
     * The editor's open workflows, as the host's tab list is built from.
     *
     * 1.57 keeps them on the workflow store; a frontend without that store
     * reports no tabs rather than an error, because the graph beside them still
     * syncs. An entry without a path cannot be addressed, so it is dropped.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @returns {any[]} the open workflows, in tab order.
     */
    function openTabEntries(app) {
      const raw = app?.extensionManager?.workflow?.openWorkflows
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.value) ? raw.value : []
      return list.filter(workflow => typeof workflow?.path === 'string' && workflow.path.trim().length > 0)
    }

    /**
     * The label a tab shows, or null when the frontend never named it.
     *
     * Unlike a session's workflow name, a tab's "Unsaved Workflow" label is its
     * identity here: it is how the user names the tab they want closed.
     * @param {any} workflow - one entry of the store's `openWorkflows`.
     * @returns {string | null} the label without `.json`.
     */
    function tabLabel(workflow) {
      const filename = typeof workflow?.filename === 'string' ? workflow.filename : ''
      const base = filename.split(/[\\/]/).pop() ?? ''
      const label = base.replace(/\.json$/i, '').trim()
      return label.length > 0 ? label : null
    }

    /**
     * The editor's open tabs as the Host stores them.
     *
     * The Host mirrors one graph, so it cannot otherwise tell a settled session
     * from one whose user is looking at a different tab.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @returns {{name: string | null, path: string, temporary: boolean, modified: boolean, active: boolean}[]} the tabs.
     */
    function readTabs(app) {
      const manager = app?.extensionManager?.workflow
      return openTabEntries(app).map(workflow => ({
        name: tabLabel(workflow),
        path: workflow.path,
        temporary: workflow?.isTemporary === true,
        modified: workflow?.isModified === true,
        active: typeof manager?.isActive === 'function' ? manager.isActive(workflow) === true : false,
      }))
    }

    /**
     * The open workflow a tab command addresses.
     *
     * A path is exact, so it settles the case two files share a label. A label
     * is what the user reads, and is enough whenever it is unique — the common
     * case.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {{name?: string | null, path?: string | null}} target - a tab's label, its path, or both.
     * @returns {any} that tab's workflow.
     */
    function findTab(app, { name = null, path = null } = {}) {
      const entries = openTabEntries(app)
      const wantedPath = typeof path === 'string' ? path.trim() : ''
      if (wantedPath.length > 0) {
        const byPath = entries.find(workflow => workflow.path === wantedPath)
        if (byPath === undefined) throw new Error(`No open tab has the path "${wantedPath}"`)
        return byPath
      }
      const wanted = typeof name === 'string' ? name.trim() : ''
      const matches = entries.filter(workflow => tabLabel(workflow) === wanted)
      if (matches.length === 0) {
        throw new Error(`No open tab is named "${wanted}"; read the tabs from the session's status first`)
      }
      if (matches.length > 1) {
        // Two files in different folders can share a label; the path is the
        // identity, so name the candidates instead of leaving a dead end.
        throw new Error(`More than one open tab is named "${wanted}"; address one by its path instead: ${matches.map(match => match.path).join(', ')}`)
      }
      return matches[0]
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
      // FitView toasts "Empty canvas" when the graph has no nodes. A load of
      // an empty workflow must not show a toast the user did not ask for.
      if (nodeBounds(app?.rootGraph ?? app?.graph) === null) return false
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
        // LiteGraph 0.4x keeps node ids and link endpoints as strings while the
        // serialized workflow writes numbers. The panel posts numbers. The Host
        // also accepts the canonical spelling (`"9"`) and drops any other spelling.
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
     * Apply a batch of edits and prove the Host received the graph.
     *
     * The canvas changes before the sync. A caller that ignores a failed sync
     * tells the model the edit landed while the Host still mirrors the previous
     * graph, which is the mistake `loadWorkflow` already refuses.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any[]} operations - the edit batch.
     * @param {{ liteGraph: any, sync: () => Promise<boolean>, onApplied?: (summary: string, touched: Set<number>) => void }} hooks
     *   `sync` reports whether the state POST landed. `onApplied` runs after the
     *   canvas changes and before that proof, so a toast still shows when the
     *   mirror fails.
     * @returns {Promise<{applied: number, nodes: number, links: number, operations: any[]}>}
     */
    async function applyEdits(app, operations, { liteGraph, sync, onApplied }) {
      const graph = app.rootGraph ?? app.graph
      if (graph === undefined || graph === null || liteGraph === undefined) throw new Error('ComfyUI graph is not ready')
      const applied = []
      const touched = new Set()
      const parts = []
      for (const operation of operations) {
        const result = applyOperation({ graph, LiteGraph: liteGraph, app, operation })
        applied.push(result)
        const ids = [operation?.id, result?.id, operation?.to?.id, operation?.from?.id]
        for (const id of ids) if (Number.isSafeInteger(Number(id))) touched.add(Number(id))
        parts.push(describeOperation(operation, result))
      }
      graph.setDirtyCanvas?.(true, true)
      onApplied?.(parts.join(' · '), touched)
      if (!(await sync())) throw new Error('The edit was applied, but the Host did not receive it; retry Sync')
      const links = graph.links instanceof Map ? graph.links.size : Object.keys(graph.links ?? {}).length
      return { applied: applied.length, nodes: graph._nodes?.length ?? 0, links, operations: applied }
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
      // The result route rejects a body over 1_000_000 characters before the
      // command is answered, and the panel used to swallow that 413. Shrink
      // until the data URL fits, with room for the JSON around it, and report
      // the size actually sent.
      const budget = 900_000
      let width = canvas.width
      let height = canvas.height
      let source = canvas
      while (dataUrl.length > budget && width > 1 && height > 1
        && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const copy = document.createElement('canvas')
        width = Math.max(1, Math.round(width / 2))
        height = Math.max(1, Math.round(height / 2))
        copy.width = width
        copy.height = height
        copy.getContext('2d')?.drawImage(source, 0, 0, width, height)
        const next = copy.toDataURL('image/png')
        if (typeof next !== 'string' || !next.startsWith('data:image/png') || next.length >= dataUrl.length) break
        dataUrl = next
        source = copy
      }
      if (dataUrl.length > budget) {
        throw new Error('The screenshot is too large for the command channel; zoom out and retry')
      }
      return { kind: 'screenshot', dataUrl, width, height }
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
     * Load one tab's own state into the canvas, without reading the file.
     *
     * A tab that is already open keeps its edits in `activeState`, so this is
     * what "switch to that tab" means: the graph the user left there, not the
     * file's older copy.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any} workflow - the store's workflow for that tab.
     * @returns {Promise<{nodes: number, links: number}>} the loaded graph's size.
     */
    async function activateTab(app, workflow) {
      if (workflow?.isLoaded !== true && typeof workflow?.load === 'function') await workflow.load()
      const state = workflow?.activeState ?? workflow?.initialState
      if (state === null || state === undefined) throw new Error('That tab has no graph to load')
      return applyWorkflowGraph(app, JSON.parse(JSON.stringify(state)), workflow)
    }

    /**
     * Switch the editor to a tab that is already open.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {{name?: string | null, path?: string | null}} target - which tab; see `findTab`.
     * @param {{fit: (app: any) => Promise<unknown>, sync: () => Promise<boolean>}} hooks - framing and mirroring.
     * @returns {Promise<{switched: string, path: string, nodes: number, links: number}>} the tab that is now active.
     */
    async function switchTab(app, target, { fit, sync }) {
      const workflow = findTab(app, target)
      const value = await activateTab(app, workflow)
      await fit(app).catch(() => {})
      if (!(await sync())) throw new Error('The tab switched, but the Host did not receive it; retry Sync')
      return { switched: tabLabel(workflow) ?? workflow.path, path: workflow.path, nodes: value.nodes, links: value.links }
    }

    /**
     * Close one tab the user asked to close.
     *
     * A tab with a file and unsaved changes goes through ComfyUI's own dialog,
     * which offers save, close-without-saving, and cancel; the command returns
     * while that dialog is open, because the user may answer long after a
     * command's lifetime. Everything the dialog needs is checked *before* that
     * answer, so `awaiting-confirmation` only ever means a dialog is really
     * open. A temporary tab with changes is refused: it has no file to save
     * them to, and only the user can decide to discard them.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {{name?: string | null, path?: string | null}} target - which tab; see `findTab`.
     * @param {{sync: () => Promise<boolean>}} hooks - mirroring after the close.
     * @returns {Promise<{status: 'closed' | 'awaiting-confirmation', name: string, path: string, remaining?: (string | null)[]}>} what happened.
     */
    async function closeTab(app, target, { sync }) {
      const workflow = findTab(app, target)
      const label = tabLabel(workflow) ?? workflow.path
      if (workflow.isModified === true) {
        if (workflow.isTemporary === true) {
          throw new Error(`The tab "${label}" has unsaved changes and no file to save them to; ask the user to close it in ComfyUI, or save it as a workflow first`)
        }
        const dialog = app?.extensionManager?.dialog
        const manager = app?.extensionManager?.workflow
        if (typeof dialog?.confirm !== 'function' || typeof manager?.saveWorkflow !== 'function') {
          throw new Error('This ComfyUI frontend cannot ask whether to save; close the tab in its own UI')
        }
        void closeModifiedTab(app, workflow, { dialog, sync }).catch(error => {
          console.error('dsh-comfyui: closing the tab failed', error)
        })
        return { status: 'awaiting-confirmation', name: label, path: workflow.path }
      }
      await performClose(app, workflow, { sync })
      return { status: 'closed', name: label, path: workflow.path, remaining: readTabs(app).map(tab => tab.name) }
    }

    /**
     * Ask the user whether to save, then close — through ComfyUI's own dialog.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any} workflow - the tab's workflow; it has a file and unsaved changes.
     * @param {{dialog: any, sync: () => Promise<boolean>}} hooks - the dialog that asks, and mirroring.
     * @returns {Promise<void>} resolves once the tab closed, or the user cancelled.
     */
    async function closeModifiedTab(app, workflow, { dialog, sync }) {
      const manager = app?.extensionManager?.workflow
      const label = tabLabel(workflow) ?? workflow.path
      // `dirtyClose` is the dialog ComfyUI itself shows on a tab's ×: confirm
      // saves, deny closes without saving, cancel keeps the tab.
      const answer = await dialog.confirm({
        title: 'Close a workflow',
        message: `"${label}" has unsaved changes.`,
        type: 'dirtyClose',
        itemList: [workflow.path],
        denyLabel: 'Close without saving',
      })
      if (answer !== true && answer !== false) return
      if (answer === true) {
        try {
          await manager.saveWorkflow(workflow)
        } catch (error) {
          // Losing the work is worse than a close the user has to repeat.
          console.error('dsh-comfyui: the workflow did not save, so its tab stays open', error)
          return
        }
      }
      await performClose(app, workflow, { sync })
    }

    /**
     * Remove a tab from the editor, moving the active tab first when needed.
     *
     * The store's close drops the entry without touching the canvas, so closing
     * the active tab would leave the editor showing a workflow it no longer
     * lists. With a neighbour we move to it; as the last tab we ask the editor
     * for its default workflow, which is what ComfyUI's own close does.
     * @param {any} app - the editor's `comfyAPI.app.app`.
     * @param {any} workflow - the tab's workflow.
     * @param {{sync: () => Promise<boolean>}} hooks - mirroring after the close.
     * @returns {Promise<void>} resolves once the tab is closed.
     */
    async function performClose(app, workflow, { sync }) {
      const manager = app?.extensionManager?.workflow
      if (typeof manager?.closeWorkflow !== 'function') {
        throw new Error('This ComfyUI frontend cannot close a tab; reload the panel')
      }
      const active = typeof manager.isActive === 'function' && manager.isActive(workflow) === true
      if (active) {
        const neighbour = openTabEntries(app).find(entry => entry !== workflow)
        if (neighbour !== undefined) await activateTab(app, neighbour)
        else if (typeof app?.loadGraphData === 'function') await app.loadGraphData()
      }
      manager.closeWorkflow(workflow)
      if (!(await sync())) throw new Error('The tab closed, but the Host did not receive it; retry Sync')
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
        tabs: () => readTabs(app),
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
     * @param {() => void} [options.onPost] - called once a push decides to post, so the caller can show its pending state. A superseded push does not call it.
     * @param {() => string} [options.bridgeError] - the message for a push whose editor exposes no graph.
     * @returns {{push: (force?: boolean) => Promise<any>, snapshot: () => any, reset: () => void, adopt: (name: string) => void}}
     *   `push` reports the decision; `snapshot` reads what the last successful
     *   push left; `reset` forgets the signature and names, as an iframe reload
     *   must; `adopt` remembers a name the panel itself put into the editor so
     *   the next push does not report it as a user rename.
     */
    function createSync({ sessionId, editor, post, now, onPost, bridgeError }) {
      let revision = 0
      let pushSeq = 0
      let lastJson = ''
      /** The tab list travels outside the graph, so it needs its own signature. */
      let lastTabsJson = ''
      let lastClientId = null
      /** @type {string | null | undefined} */
      let lastEditorName
      /** @type {string | null | undefined} */
      let lastHostName
      /** @type {string | null} */
      let displayName = null
      let lastNodes = 0
      let lastLinks = 0
      let lastTabs = 0
      let lastAt = 0
      /**
       * Bumped only by a push that will try to post. A quiet tick must not
       * take a number: it would cancel an in-flight post that the Host is
       * about to accept, and the next tick would then see no change.
       */
      let generation = 0
      /**
       * The newest push that has decided to post. An older call waits for this
       * instead of reporting failure while that newer snapshot is on its way.
       * @type {Promise<any>}
       */
      let latest = Promise.resolve({ posted: false })

      /**
       * What the last successful sync left behind, for a caller that has no
       * state of its own.
       * @returns {{revision: number, name: string | null, nodes: number, links: number, tabs: number, at: number}} the remembered snapshot.
       */
      function snapshot() {
        return { revision, name: displayName, nodes: lastNodes, links: lastLinks, tabs: lastTabs, at: lastAt }
      }

      /**
       * Forget the last signature and both names, so the next push reports them
       * again. A reloaded editor is a different editor, even when its
       * autosaved graph serializes the same.
       * @returns {void}
       */
      function reset() {
        lastJson = ''
        lastTabsJson = ''
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
        return pushOnce(force)
      }

      /**
       * The body of one push, after the session check.
       * @param {boolean} force - post even when nothing changed.
       * @returns {Promise<any>} what the caller should render.
       */
      async function pushOnce(force) {
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
        // The open tabs are page state beside the graph: switching a tab changes
        // none of the graph JSON, so without their own comparison the Host would
        // keep a tab list from before the switch.
        const tabs = view.tabs()
        const tabsJson = JSON.stringify(tabs)
        const firstSync = lastEditorName === undefined
        const renamed = firstSync ? editorName !== null : lastEditorName !== editorName
        if (!force && json === lastJson && !renamed && tabsJson === lastTabsJson) {
          return { posted: false, ...snapshot() }
        }
        // Taken before the prompt conversion and the POST, so a slower push
        // carries an earlier stamp even when its response arrives last. Not
        // named `syncedAt`: that string is the bar's "synced at" label. A quiet
        // tick never reaches here, so it cannot supersede a push that is posting.
        const started = ++generation
        const pushedAt = now() * 1000 + (pushSeq % 1000)
        pushSeq += 1
        /** @type {(value: any) => void} */
        let finish = () => {}
        /** @type {(error: unknown) => void} */
        let fail = () => {}
        const run = new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        })
        // Assigned before `send` can await, so a push that loses the race waits
        // for this promise and never for itself.
        latest = run
        void send().then(finish, fail)
        return run

        /**
         * Post this snapshot, or wait for the newer one that took the generation.
         * @returns {Promise<any>} the result the caller should treat as its own.
         */
        async function send() {
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
          // A newer push started while this one was converting the graph. Posting
          // this snapshot would store an older workflow under a higher revision.
          // Leave the signature unset so the winner, or the next tick, still sees
          // the change. The caller waits for that winner instead of being told
          // the Host missed an edit the winner is about to send.
          if (started !== generation) return latest
          lastJson = json
          lastTabsJson = tabsJson
          onPost?.()
          revision += 1
          const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0
          const links = Array.isArray(workflow.links) ? workflow.links.length : 0
          try {
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
              pushedAt,
              tabs,
              // A canvas without a file reports only that. `file: null` is what
              // tells the Host to drop a name that came from a file, while a name a
              // workflow tool gave the canvas survives — which is what a temporary
              // tab opened over a saved slot should do.
              ...(renamed && editorName !== null ? { name: editorName } : {}),
            })
            // The POST landed, but a newer snapshot has since taken over. Adopting
            // this response would move the page counter backwards. The Host keeps
            // the newer body because this one carries the earlier stamp, and the
            // caller observes that newer push's result.
            if (started !== generation) return latest
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
            lastTabs = tabs.length
            lastAt = now()
            return {
              posted: true,
              revision,
              name: displayName,
              nodes,
              links,
              tabs: lastTabs,
              at: lastAt,
              adoptName: hostRenamed && hostName !== null && hostName !== editorName ? hostName : null,
            }
          } catch (error) {
            // A newer snapshot owns the outcome. This POST failed, but failing
            // the caller would report a lost edit while that snapshot is still
            // going out — and a retry would apply it twice.
            if (started !== generation) return latest
            // The signature no longer matches what the Host holds, so the next
            // tick has to retry this graph instead of skipping it as unchanged.
            lastJson = ''
            throw error
          }
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
      const [stats, setStats] = useState({ nodes: 0, links: 0, revision: 0, name: null, tabs: 0 })
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
      const reloadRef = useRef(null)
      /** Bumped by `reload()`: a new key is a new iframe element. */
      const [frameKey, setFrameKey] = useState(0)
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
        setStats({ nodes: result.nodes, links: result.links, revision: result.revision, name: result.name, tabs: result.tabs })
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
          const result = await loop.push(force)
          applySync(app, result)
          // `posted: false` here is a quiet tick, not a lost edit: a forced push
          // that lost the race resolves with the newer push's result.
          return result?.posted === true
        } catch (error) {
          setStatus('error')
          setMessage(error instanceof Error ? error.message : String(error))
          return false
        }
      }, [applySync, loop, readApp, t])

      const applyOperations = useCallback(async (app, operations) => {
        return applyEdits(app, operations, {
          liteGraph: iframeRef.current?.contentWindow?.LiteGraph,
          sync: () => syncNow(true),
          onApplied: (summary, touched) => {
            setNotice({ text: `${t('modelEdited')}: ${summary}`, at: Date.now() })
            flashNodes(app, touched)
          },
        })
      }, [syncNow, t])

      const applyWorkflow = useCallback((app, workflow, name) => loadWorkflow(app, workflow, {
        fit: target => fitCanvas(target),
        sync: () => syncNow(true),
        name,
      }), [syncNow])

      const switchToTab = useCallback((app, target) => switchTab(app, target, {
        fit: target => fitCanvas(target),
        sync: () => syncNow(true),
      }), [syncNow])

      const closeEditorTab = useCallback((app, target) => closeTab(app, target, {
        sync: () => syncNow(true),
      }), [syncNow])

      const runCommand = useCallback(async (app, command) => {
        if (command.kind === 'screenshot') return captureGraph(app)
        if (command.kind === 'workflow') return applyWorkflow(app, command.workflow, command.name)
        if (command.kind === 'switch-tab') return switchToTab(app, { name: command.name, path: command.path })
        if (command.kind === 'close-tab') return closeEditorTab(app, { name: command.name, path: command.path })
        return applyOperations(app, command.operations ?? [])
      }, [applyOperations, applyWorkflow, switchToTab, closeEditorTab])

      const commandRef = useRef(null)
      commandRef.current = runCommand

      useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        let disposed = false
        const abort = new AbortController()
        const loop = async () => {
          while (!disposed) {
            try {
              const response = await fetch(COMMAND_POLL_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, timeoutMs: 20000 }),
                signal: abort.signal,
              })
              if (!response.ok) throw new Error(`command poll HTTP ${response.status}`)
              const data = await response.json()
              const command = data?.command
              if (command === undefined || command === null) continue
              if (disposed) {
                await fetch(COMMAND_RESULT_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    sessionId,
                    id: command.id,
                    ok: false,
                    error: 'The ComfyUI editor is closed. Return to ComfyUI and retry.',
                  }),
                }).catch(() => {})
                break
              }
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
        return () => {
          disposed = true
          abort.abort()
        }
      }, [readApp, sessionId])

      const postEvent = useCallback((event) => {
        if (sessionId === undefined || sessionId === null) return
        const box = eventRef.current
        const send = payload => {
          void fetch(EVENT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, event: payload }),
          }).catch(() => {})
        }
        const displaced = offerRelayEvent(box, event)
        if (displaced !== null) send(displaced)
        if (box.timer !== null) return
        const wait = Math.max(0, 200 - (Date.now() - box.sentAt))
        box.timer = setTimeout(() => {
          box.timer = null
          const payload = box.pending
          box.pending = null
          if (payload === null) return
          box.sentAt = Date.now()
          send(payload)
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

      // Remounting, not navigating: ComfyUI arms a beforeunload guard while the
      // workflow has unsaved changes, and assigning `src` makes the browser ask
      // "leave this page?" about a reload the user never asked for. Replacing
      // the element drops the old document without a navigation (pagehide, no
      // beforeunload), and the new one starts from the same URL.
      const reload = useCallback(() => {
        if (iframeRef.current === null) return
        // The new page fetches its own autosaved graph, so the signature and
        // the name the old one carried say nothing about it.
        loopRef.current?.sync.reset()
        appRef.current = null
        fittedRef.current = false
        workflowFileCacheRef.current.clear()
        setRun(null)
        setStatus('loading')
        setMessage('')
        setFrameKey(key => key + 1)
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

      // The lifecycle switch lives on the pill; this dialog is configuration and
      // diagnostics, so there is exactly one place that decides whether Start is
      // clickable. It floats over the canvas instead of taking a row from it.
      const plan = barPlan({ status, service, busy: serviceBusy, dir: serviceCwd, t })
      const stage = overlayPlan({ status, service, bootSeconds, dir: serviceCwd, t })
      const dir = serviceCwd.trim()
      const notOwnedHint = plan.healthy && !plan.owned ? t('serverExternalHint') : ''
      const dirHint = !plan.healthy && dir === '' ? t('serverPick') : ''
      const severity = service !== null && service.controllerError !== null && service.controllerError !== undefined
      const closeService = () => setServiceOpen(false)
      const serviceDialog = h('div', {
        className: 'dsh-comfyui-dialog-layer',
        onMouseDown: event => { if (event.target === event.currentTarget) closeService() },
      },
        h('div', {
          className: 'dsh-comfyui-sheet',
          role: 'dialog',
          'aria-label': t('settings'),
        },
          h('div', { className: 'dsh-comfyui-sheet-head' },
            h('strong', null, t('settings')),
            h('button', {
              className: 'dsh-comfyui-button dsh-comfyui-icon',
              type: 'button',
              title: t('close'),
              'aria-label': t('close'),
              onClick: closeService,
            }, '\u00d7'),
          ),
          h('div', { className: 'dsh-comfyui-sheet-body' },
            notOwnedHint === '' ? null : h('div', { className: 'dsh-comfyui-sheet-hint' }, notOwnedHint),
            h('label', { className: 'dsh-comfyui-field' },
              h('span', null, t('serverDir')),
              h('input', {
                className: 'dsh-comfyui-input',
                value: serviceCwd,
                placeholder: t('serverDirHint'),
                spellCheck: false,
                disabled: serviceBusy,
                onChange: event => setServiceCwd(/** @type {HTMLInputElement} */ (event.target).value),
              }),
            ),
            h('label', { className: 'dsh-comfyui-check' },
              h('input', {
                type: 'checkbox',
                checked: serviceAutoStart,
                disabled: serviceBusy,
                onChange: event => setServiceAutoStart(event.target.checked),
              }),
              h('span', null, t('serverAutoStart')),
            ),
            dirHint === '' ? null : h('div', { className: 'dsh-comfyui-sheet-hint' }, dirHint),
            serviceMessage === '' ? null : h('div', { className: 'dsh-comfyui-sheet-message' }, serviceMessage),
            severity ? h('div', { className: 'dsh-comfyui-sheet-message' }, String(service.controllerError)) : null,
            service !== null && typeof service.lastError === 'string' && service.lastError !== ''
              ? h('div', { className: 'dsh-comfyui-sheet-message' }, service.lastError)
              : null,
          ),
          h('div', { className: 'dsh-comfyui-sheet-foot' },
            h('button', {
              className: 'dsh-comfyui-button',
              'data-variant': 'primary',
              type: 'button',
              disabled: serviceBusy || dir === '',
              onClick: () => { void serviceAction('save') },
            }, t('serverSave')),
          ),
        ),
      )

      return h('div', { className: 'dsh-comfyui-panel' },
        h('style', null, CSS),
        h(TopBar, {
          stats,
          syncLabel,
          syncAt: lastSyncAt,
          runText,
          previewUrl,
          previewTitle,
          filesTitle,
          run,
          plan,
          serviceOpen,
          t,
          onService: () => setServiceOpen(current => !current),
          onAction: action => { void serviceAction(action) },
          onCancel: () => { void cancelRun() },
        }),
        message === '' ? null : h('div', { className: 'dsh-comfyui-notice', 'data-tone': status === 'error' ? 'error' : 'info' }, message),
        // Explicit-only: an unhealthy upstream must not force this open, and it
        // floats, so opening it never resizes the canvas.
        serviceOpen ? serviceDialog : null,
        h('div', { className: 'dsh-comfyui-stage' },
          h('iframe', {
            key: frameKey,
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
            t,
            onReload: reload,
          }),
          notice === null ? null : h('div', { className: 'dsh-comfyui-toast' }, notice.text),
        ),
      )
    }

    /** Locale bound in `apply`. The main panel renders after that assignment. */
    let deskT = key => key
    /** The client remote, bound in apply; null when the Host has none. */
    /**
     * The three remote namespaces the column calls. Each is its own Cordis
     * service (`remote.session`, not a field of `remote`); `apply` reads them
     * with `ctx.get`, which does not require this plugin to inject them.
     * @type {{ session: any, presets: any, commands: any }}
     */
    let deskRemotes = { session: null, presets: null, commands: null }

    /**
     * Read one remote namespace. A missing service leaves the menu empty
     * instead of taking the panel down.
     * @param {any} ctx - the client context.
     * @param {string} name - the Cordis service name.
     * @returns {any} the namespace, or null.
     */
    function remoteNamespace(ctx, name) {
      try {
        const value = typeof ctx.get === 'function' ? ctx.get(name) : null
        return value ?? null
      } catch {
        return null
      }
    }

    /** Badge outline of the ComfyUI mark: a rounded square on a 520 grid. */
    const COMFY_BADGE = 'M0 184.335C0 119.812 0 87.5502 12.5571 62.9055C23.6026 41.2274 41.2274 23.6026 62.9055 12.5571C87.5502 0 119.812 0 184.335 0H335.665C400.188 0 432.45 0 457.094 12.5571C478.773 23.6026 496.397 41.2274 507.443 62.9055C520 87.5502 520 119.812 520 184.335V335.665C520 400.188 520 432.45 507.443 457.094C496.397 478.773 478.773 496.397 457.094 507.443C432.45 520 400.188 520 335.665 520H184.335C119.812 520 87.5502 520 62.9055 507.443C41.2274 496.397 23.6026 478.773 12.5571 457.094C0 432.45 0 400.188 0 335.665V184.335Z'
    /** The C inside it, knocked out of the badge. */
    const COMFY_MARK = 'M176.484 428.831C168.649 428.831 162.327 425.919 158.204 420.412C153.966 414.755 152.861 406.857 155.171 398.749L164.447 366.178C165.187 363.585 164.672 360.794 163.059 358.636C161.446 356.483 158.921 355.216 156.241 355.216H129.571C121.731 355.216 115.409 352.308 111.289 346.802C107.051 341.14 105.946 333.242 108.258 325.134L140.124 213.748L143.642 201.51C148.371 184.904 165.62 171.407 182.097 171.407H214.009C217.817 171.407 221.167 168.868 222.215 165.183L232.769 128.135C237.494 111.545 254.742 98.048 271.219 98.048L339.468 97.9264L389.431 97.9221C397.268 97.9221 403.59 100.831 407.711 106.337C411.949 111.994 413.054 119.892 410.744 128L396.457 178.164C391.734 194.75 374.485 208.242 358.009 208.242L289.607 208.372H257.706C253.902 208.372 250.557 210.907 249.502 214.588L222.903 307.495C222.159 310.093 222.673 312.892 224.291 315.049C225.904 317.202 228.428 318.469 231.107 318.469C231.113 318.469 276.307 318.381 276.307 318.381H326.122C333.959 318.381 340.281 321.29 344.402 326.796C348.639 332.457 349.744 340.355 347.433 348.463L333.146 398.619C328.423 415.209 311.174 428.701 294.698 428.701L226.299 428.831H176.484Z'

    /**
     * Left-sidebar glyph: the official ComfyUI mark, single colour. The badge
     * paints in the column's own ink and the C is cut out, so it reads on a
     * light and a dark sidebar without a second asset.
     * @param {{ size?: number }} props - the shell's icon size.
     * @returns {any} the svg.
     */
    function PanelIcon({ size }) {
      const s = size || 18
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 520 520',
        'aria-hidden': 'true',
      },
      h('mask', {
        id: 'dsh-comfyui-badge',
        maskUnits: 'userSpaceOnUse',
        x: 0,
        y: 0,
        width: 520,
        height: 520,
      },
      h('path', { d: COMFY_BADGE, fill: '#fff' }),
      h('path', { d: COMFY_MARK, fill: '#000' }),
      ),
      h('path', { d: COMFY_BADGE, fill: 'currentColor', mask: 'url(#dsh-comfyui-badge)' }),
      )
    }

    // ── Markdown ────────────────────────────────────────────────────────────
    // A reply is markdown, and a full engine is a dependency this bundle
    // cannot carry, so this is the subset a reply actually uses. Everything
    // below builds React children, never HTML: a graph title or a tool result
    // cannot inject markup into the DSH page.

    /** Link schemes the column renders; anything else stays plain text. */
    const SAFE_LINK = /^(?:https?:|mailto:)/iu
    /** A fenced block's opening line: three backticks or three tildes, then a language. */
    const FENCE_OPEN = /^\s*(```|~~~)\s*([^\s`]*)\s*$/u
    /** An inline code span. */
    const INLINE_CODE = new RegExp('^`([^`]+)`', 'u')
    /** A heading: one to six hashes and a space. */
    const HEADING = /^(#{1,6})\s+(.*)$/u
    /** A horizontal rule: three or more of one marker. */
    const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/u
    /** A blockquote line. */
    const QUOTE = /^\s*>\s?(.*)$/u
    /** A list item: a bullet, or "1." / "1)". */
    const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/u
    /** A table's separator row, under a header row. */
    const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/u

    /**
     * Split one line into inline tokens.
     *
     * Only the five spans a reply uses are recognised — code, strong,
     * emphasis, strike, and links — and the underscore is deliberately not an
     * emphasis marker: tool names and paths are full of snake_case, and a
     * renderer that italicises them makes every tool name look broken.
     *
     * @param {string} line - one line of markdown.
     * @returns {{ type: string, text: string, href?: string }[]} tokens in order.
     */
    function parseInline(line) {
      /** @type {{ type: string, text: string, href?: string }[]} */
      const tokens = []
      let rest = String(line ?? '')
      while (rest.length > 0) {
        const code = INLINE_CODE.exec(rest)
        if (code !== null) {
          tokens.push({ type: 'code', text: code[1] })
          rest = rest.slice(code[0].length)
          continue
        }
        const link = /^\[([^\]]*)\]\(([^)\s]+)\)/u.exec(rest)
        if (link !== null) {
          tokens.push({ type: 'link', text: link[1].length > 0 ? link[1] : link[2], href: link[2] })
          rest = rest.slice(link[0].length)
          continue
        }
        const strong = /^\*\*([^*]+)\*\*/u.exec(rest) ?? /^__([^_]+)__/u.exec(rest)
        if (strong !== null) {
          tokens.push({ type: 'strong', text: strong[1] })
          rest = rest.slice(strong[0].length)
          continue
        }
        const strike = /^~~([^~]+)~~/u.exec(rest)
        if (strike !== null) {
          tokens.push({ type: 'strike', text: strike[1] })
          rest = rest.slice(strike[0].length)
          continue
        }
        const em = /^\*([^*\n]+)\*/u.exec(rest)
        if (em !== null) {
          tokens.push({ type: 'em', text: em[1] })
          rest = rest.slice(em[0].length)
          continue
        }
        const plain = /^[^`\[\]*_~\n]+/u.exec(rest)
        if (plain !== null) {
          tokens.push({ type: 'text', text: plain[0] })
          rest = rest.slice(plain[0].length)
          continue
        }
        tokens.push({ type: 'text', text: rest[0] })
        rest = rest.slice(1)
      }
      // A lone character that starts no span (the underscore in a tool name,
      // a bracket that opens nothing) arrives as its own token. Join runs of
      // plain text so the caller sees words, not characters.
      const merged = []
      for (const token of tokens) {
        const last = merged[merged.length - 1]
        if (token.type === "text" && last !== undefined && last.type === "text") last.text += token.text
        else merged.push({ ...token })
      }
      return merged
    }

    /**
     * Parse a message into the blocks the column renders.
     *
     * A wrapped list item starts a paragraph instead of continuing the bullet:
     * that is what the model's own wrapping looks like, and joining it needs
     * indentation state this subset does not carry.
     *
     * @param {string} text - the markdown source.
     * @returns {any[]} blocks: paragraph, heading, code, list, quote, table, hr.
     */
    function parseMarkdown(text) {
      const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')
      /** @type {any[]} */
      const blocks = []
      /** Whether this line opens a block that ends a paragraph. */
      const startsBlock = (line, next) => /^\s*$/u.test(line)
        || FENCE_OPEN.test(line) || HEADING.test(line) || RULE.test(line)
        || QUOTE.test(line) || LIST_ITEM.test(line)
        || (line.includes('|') && typeof next === 'string' && TABLE_RULE.test(next))
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*$/u.test(line)) {
          index += 1
          continue
        }
        const fence = FENCE_OPEN.exec(line)
        if (fence !== null) {
          const closing = new RegExp('^\\s*' + fence[1] + '\\s*$', 'u')
          /** @type {string[]} */
          const body = []
          index += 1
          while (index < lines.length && !closing.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') })
          continue
        }
        const heading = HEADING.exec(line)
        if (heading !== null) {
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
          index += 1
          continue
        }
        if (RULE.test(line)) {
          blocks.push({ type: 'hr' })
          index += 1
          continue
        }
        if (QUOTE.test(line)) {
          /** @type {string[]} */
          const body = []
          while (index < lines.length) {
            const quoted = QUOTE.exec(lines[index])
            if (quoted === null) break
            body.push(quoted[1])
            index += 1
          }
          blocks.push({ type: 'quote', text: body.join('\n') })
          continue
        }
        if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
          const cells = value => value.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map(cell => cell.trim())
          /** @type {string[][]} */
          const rows = []
          index += 2
          while (index < lines.length && lines[index].includes('|') && !/^\s*$/u.test(lines[index])) {
            rows.push(cells(lines[index]))
            index += 1
          }
          blocks.push({ type: 'table', header: cells(line), rows })
          continue
        }
        const item = LIST_ITEM.exec(line)
        if (item !== null) {
          const ordered = /^\d/u.test(item[1])
          /** @type {string[]} */
          const items = []
          while (index < lines.length) {
            const next = LIST_ITEM.exec(lines[index])
            if (next === null || /^\d/u.test(next[1]) !== ordered) break
            items.push(next[2])
            index += 1
          }
          blocks.push({ type: 'list', ordered, items })
          continue
        }
        /** @type {string[]} */
        const paragraph = [line]
        index += 1
        while (index < lines.length && !startsBlock(lines[index], lines[index + 1])) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
      }
      return blocks
    }

    /**
     * Render inline tokens as React children.
     * @param {{ type: string, text: string, href?: string }[]} tokens - from parseInline.
     * @returns {any[]} children in order.
     */
    function renderInline(tokens) {
      return tokens.map((token, index) => {
        const key = 'i' + index
        if (token.type === 'code') return h('code', { key, className: 'dsh-comfyui-md-inline-code' }, token.text)
        if (token.type === 'strong') return h('strong', { key }, token.text)
        if (token.type === 'em') return h('em', { key }, token.text)
        if (token.type === 'strike') return h('del', { key }, token.text)
        if (token.type === 'link') {
          // A non-http scheme stays text: a reply must not be able to ship a
          // javascript: link onto the DSH page.
          if (typeof token.href !== 'string' || !SAFE_LINK.test(token.href)) return h('span', { key }, token.text)
          return h('a', { key, href: token.href, target: '_blank', rel: 'noreferrer noopener' }, token.text)
        }
        return token.text
      })
    }

    /**
     * Copy text to the clipboard.
     * @param {string} text - what to copy.
     * @returns {Promise<boolean>} whether the browser took it.
     */
    async function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /**
     * One fenced block, with its own copy control.
     * @param {{ lang?: string, text: string, t: (key: string) => string }} props - language, body, locale.
     * @returns {any} the block.
     */
    function CodeBlock({ lang, text, t }) {
      const [copied, setCopied] = useState(false)
      const label = typeof lang === 'string' && lang.length > 0 ? lang : t('codeBlock')
      return h('div', { className: 'dsh-comfyui-md-code' },
        h('div', { className: 'dsh-comfyui-md-code-head' },
          h('span', { className: 'dsh-comfyui-md-lang' }, label),
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-md-copy',
            'aria-label': copied ? t('copied') : t('copy'),
            onClick: () => {
              void copyText(text).then(ok => {
                if (!ok) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              })
            },
          }, copied ? t('copied') : t('copy')),
        ),
        h('pre', { className: 'dsh-comfyui-md-pre' }, h('code', null, text)),
      )
    }

    /**
     * Render a message as markdown.
     * @param {string} text - the message body.
     * @param {(key: string) => string} t - the locale bound in apply.
     * @returns {any} one element wrapping the blocks.
     */
    function renderMarkdown(text, t) {
      return h('div', { className: 'dsh-comfyui-md' }, ...parseMarkdown(text).map((block, index) => {
        const key = 'b' + index
        if (block.type === 'code') return h(CodeBlock, { key, lang: block.lang, text: block.text, t })
        // A reply's own headings are never document headings: keep them one
        // step down so a single "#" cannot out-size the column's title.
        if (block.type === 'heading') return h('h' + Math.min(4, block.level + 1), { key, className: 'dsh-comfyui-md-heading' }, renderInline(parseInline(block.text)))
        if (block.type === 'hr') return h('hr', { key, className: 'dsh-comfyui-md-rule' })
        if (block.type === 'quote') return h('blockquote', { key, className: 'dsh-comfyui-md-quote' }, renderInline(parseInline(block.text)))
        if (block.type === 'list') {
          return h(block.ordered ? 'ol' : 'ul', { key, className: 'dsh-comfyui-md-list' },
            block.items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(parseInline(item)))))
        }
        if (block.type === 'table') {
          return h('div', { key, className: 'dsh-comfyui-md-table-wrap' },
            h('table', { className: 'dsh-comfyui-md-table' },
              h('thead', null, h('tr', null, block.header.map((cell, cellIndex) => h('th', { key: cellIndex }, renderInline(parseInline(cell)))))),
              h('tbody', null, block.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
                row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(parseInline(cell)))))))))
        }
        return h('p', { key, className: 'dsh-comfyui-md-p' }, renderInline(parseInline(block.text)))
      }))
    }

    /**
     * A row's copy control: its label flips for a moment so a click is visible.
     * What it copies is the row's source, not its rendering.
     * @param {{ text: string, t: (key: string) => string }} props - source and locale.
     * @returns {any} the button.
     */
    function CopyRow({ text, t }) {
      const [copied, setCopied] = useState(false)
      return h('button', {
        type: 'button',
        className: 'dsh-comfyui-dock-action',
        'aria-label': copied ? t('copied') : t('copy'),
        onClick: () => {
          void copyText(text).then(ok => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          })
        },
      }, copied ? t('copied') : t('copy'))
    }

    /**
     * A clock label for one event time.
     * @param {number} at - epoch milliseconds.
     * @returns {string} HH:MM in the page zone.
     */
    function formatClock(at) {
      const date = new Date(at)
      return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0")
    }

    /**
     * A short duration for a finished tool call.
     * @param {number} ms - milliseconds.
     * @returns {string} "800ms", "1.2s", or "3m".
     */
    function formatDuration(ms) {
      if (ms < 1000) return Math.round(ms) + "ms"
      if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s"
      return Math.round(ms / 60000) + "m"
    }

    /**
     * One row of the column: a bubble of markdown, or a tool card.
     * @param {{ row: any, t: (key: string) => string }} props - the row and the locale.
     * @returns {any} the row.
     */
    function DockRow({ row, t }) {
      const [expanded, setExpanded] = useState(false)
      if (row.role === "tool") {
        const status = row.status === "error" ? t("toolFailed") : row.status === "done" ? t("toolDone") : t("toolRunning")
        const timing = typeof row.durationMs === "number" ? " · " + formatDuration(row.durationMs) : ""
        const hasDetail = typeof row.args === "string" || typeof row.result === "string"
        return h("div", { className: "dsh-comfyui-dock-row", "data-role": "tool" },
          h("div", { className: "dsh-comfyui-dock-card", "data-status": row.status ?? "running" },
            h("button", {
              type: "button",
              className: "dsh-comfyui-dock-card-head",
              disabled: !hasDetail,
              "aria-expanded": expanded,
              onClick: () => setExpanded(value => !value),
            },
              h("span", { className: "dsh-comfyui-dock-card-mark", "aria-hidden": "true" }, hasDetail ? (expanded ? "▾" : "▸") : "·"),
              h("span", { className: "dsh-comfyui-dock-card-name" }, typeof row.name === "string" ? row.name : row.text),
              h("span", { className: "dsh-comfyui-dock-card-status" }, status + timing),
            ),
            expanded
              ? h("div", { className: "dsh-comfyui-dock-card-body" },
                typeof row.args === "string"
                  ? h("div", { className: "dsh-comfyui-dock-card-block" },
                    h("span", { className: "dsh-comfyui-dock-card-label" }, t("toolArgs")),
                    h("pre", { className: "dsh-comfyui-dock-card-pre" }, row.args))
                  : null,
                typeof row.result === "string"
                  ? h("div", { className: "dsh-comfyui-dock-card-block" },
                    h("span", { className: "dsh-comfyui-dock-card-label" }, t("toolResult")),
                    h("pre", { className: "dsh-comfyui-dock-card-pre" }, row.result))
                  : null)
              : null,
          ))
      }
      const stamp = typeof row.at === "number" ? formatClock(row.at) : ""
      const tokens = typeof row.tokens === "number" ? t("tokens").replace("{{count}}", String(row.tokens)) : ""
      return h("div", { className: "dsh-comfyui-dock-row", "data-role": row.role },
        h("div", { className: "dsh-comfyui-dock-msg" },
          renderMarkdown(row.text, t),
          h("div", { className: "dsh-comfyui-dock-meta" },
            stamp.length > 0 ? h("span", null, stamp) : null,
            tokens.length > 0 ? h("span", null, tokens) : null,
            row.role === "assistant" ? h(CopyRow, { text: row.text, t }) : null)))
    }

    /**
     * The session's composer. A line is admitted to the desk session, not answered here.
     * @param {{ t: (key: string) => string, sessionId: string | null, onSession: (sessionId: string) => void }} props - locale, the desk session, and how a replacement is adopted.
     * @returns {any} the column.
     */
    function AssistantDock({ t, sessionId, onSession }) {
      const [rows, setRows] = useState([])
      const [pending, setPending] = useState(null)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      /** @type {[null | { message: string, text: string }, any]} */
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(true)
      /** Whether the log follows new turns; a reader who scrolled up keeps their place. */
      const [stick, setStick] = useState(true)
      /** Whether the session holds more turns than the column was given. */
      const [truncated, setTruncated] = useState(false)
      /** Which menu page is open: null, "root", "model", or "preset". */
      const [menu, setMenu] = useState(null)
      /** Full access waits for the same confirmation the native picker shows. */
      const [confirmPreset, setConfirmPreset] = useState(null)
      /** The model catalog and permission presets the menu offers. */
      const [options, setOptions] = useState(null)
      const [menuBusy, setMenuBusy] = useState(false)
      const [menuError, setMenuError] = useState("")
      const logRef = useRef(null)
      /** The newest read wins; an older poll must not overwrite it. */
      const readAt = useRef(0)
      /**
       * A choice just made. The projection it writes lags the call that made
       * it, so the next read would paint the previous value back. Hold the
       * choice until a read agrees with it.
       */
      const held = useRef({ model: null, preset: null })
      useEffect(() => {
        // A held choice belongs to the session that made it; a new conversation
        // must not inherit it.
        held.current = { model: null, preset: null }
      }, [sessionId])
      const load = useCallback(async () => {
        const stamp = Date.now()
        if (stamp < readAt.current) return
        readAt.current = stamp
        const response = await fetch(DESK_TRANSCRIPT_URL).catch(() => null)
        if (response === null) return
        const body = await response.json().catch(() => null)
        if (readAt.current !== stamp) return
        if (body?.ok === true && typeof body.sessionId === 'string' && body.sessionId !== sessionId) {
          onSession(body.sessionId)
        }
        if (body?.ok === true && Array.isArray(body.rows)) {
          setRows(body.rows)
          setTruncated(body.truncated === true)
          setPending(current => {
            if (current === null) return null
            return body.rows.some(row => row.role === 'user' && row.text === current.text) ? null : current
          })
        }
      }, [onSession, sessionId])
      // A user turn with no answer behind it is the model working, not a stall:
      // this column is the only place a turn shows up.
      const lastRole = rows.length === 0 ? null : rows[rows.length - 1].role
      const awaiting = pending !== null || lastRole === 'user'
      const thinking = awaiting || busy
      useEffect(() => {
        if (sessionId === null || !open) return undefined
        void load()
        // While a reply is due, read faster: three seconds of silence reads as
        // "nothing happened" exactly when the model is slow.
        const timer = setInterval(() => { void load() }, thinking ? 1200 : 3000)
        return () => { clearInterval(timer) }
      }, [load, sessionId, open, thinking])
      useEffect(() => {
        const log = logRef.current
        if (log === null || !open || !stick) return
        log.scrollTop = log.scrollHeight
      }, [rows, pending, open, stick, thinking])
      const onScroll = event => {
        const log = event.currentTarget
        setStick(log.scrollHeight - log.scrollTop - log.clientHeight < 64)
      }
      const jumpToLatest = () => {
        const log = logRef.current
        if (log !== null) log.scrollTop = log.scrollHeight
        setStick(true)
      }
      /**
       * Admit one line to the desk session.
       * @param {string} message - the trimmed text.
       * @param {{ retry?: boolean }} [options] - a retry keeps the draft as it is.
       * @returns {Promise<void>}
       */
      const admit = useCallback(async (message, { retry = false } = {}) => {
        if (busy || message.length === 0) return
        if (sessionId === null) {
          setError({ message: t('assistantClosed'), text: message })
          return
        }
        setBusy(true)
        setError(null)
        setStick(true)
        setPending({ text: message })
        if (!retry) setDraft('')
        try {
          const response = await fetch(DESK_CHAT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message }),
          })
          const body = await response.json().catch(() => null)
          if (body?.ok !== true) {
            setPending(null)
            setDraft(message)
            setError({
              message: typeof body?.error === 'string' && body.error.length > 0 ? body.error : t('assistantFailed'),
              text: message,
            })
          } else {
            void load()
          }
        } catch {
          setPending(null)
          setDraft(message)
          setError({ message: t('assistantFailed'), text: message })
        } finally {
          setBusy(false)
        }
      }, [busy, load, sessionId, t])
      const remoteCall = async fn => {
        try {
          return await fn()
        } catch {
          return null
        }
      }
      const loadOptions = useCallback(async () => {
        const session = deskRemotes.session
        const presets = deskRemotes.presets
        const commands = deskRemotes.commands
        const catalog = session === null ? null : await remoteCall(() => session.modelCatalog())
        const presetCatalog = presets === null ? null : await remoteCall(() => presets.catalog())
        const listed = sessionId === null || commands === null ? null : await remoteCall(() => commands.list(sessionId))
        // The catalog has no "current". The session projection does: `permissions`
        // is `{ currentValue }`, and `modelSelection` is the provider and model.
        const projected = session === null || sessionId === null
          ? null
          : await remoteCall(() => session.projections({ sessionId }))
        const values = projected?.ok === true && projected.value?.kind === 'sequenced'
          ? projected.value.values
          : null
        const projectedModel = values?.modelSelection
        let model = projectedModel !== null && typeof projectedModel === 'object' && typeof projectedModel.provider === 'string'
          ? projectedModel
          : (catalog?.ok === true ? catalog.value?.default ?? null : null)
        const heldModel = held.current.model
        if (heldModel !== null) {
          if (model?.provider === heldModel.provider && model?.model === heldModel.model) held.current.model = null
          else model = heldModel
        }
        let preset = typeof values?.permissions?.currentValue === 'string' ? values.permissions.currentValue : null
        if (held.current.preset !== null) {
          if (preset === held.current.preset) held.current.preset = null
          else preset = held.current.preset
        }
        setOptions({
          models: catalog?.ok === true && Array.isArray(catalog.value?.groups) ? catalog.value.groups : [],
          model,
          modelFailed: catalog === null || catalog.ok !== true,
          presets: presetCatalog?.ok === true && Array.isArray(presetCatalog.value?.options) ? presetCatalog.value.options : [],
          preset,
          presetFailed: presetCatalog === null || presetCatalog.ok !== true,
          commands: listed?.ok === true && Array.isArray(listed.value) ? listed.value : [],
        })
      }, [sessionId])
      const toggleMenu = () => {
        setMenuError("")
        setConfirmPreset(null)
        setMenu(current => {
          if (current !== null) return null
          setOptions(null)
          void loadOptions()
          return "root"
        })
      }
      const finishOption = result => {
        if (result === null || result.ok !== true) {
          const message = result?.error?.message
          setMenuError(typeof message === 'string' && message.length > 0 ? message : t('optionFailed'))
          return
        }
        setMenu(null)
        void loadOptions()
      }
      const chooseModel = (provider, model) => {
        setMenuBusy(true)
        setMenuError("")
        const session = deskRemotes.session
        if (session === null || sessionId === null) {
          setMenuBusy(false)
          finishOption(null)
          return
        }
        void remoteCall(() => session.selectModel({ sessionId, provider, model }))
          .then(result => {
            const selected = result?.ok === true ? (result.value?.selected ?? { provider, model }) : null
            if (selected !== null && typeof selected.provider === 'string') {
              held.current.model = selected
              setOptions(current => current === null ? current : { ...current, model: selected, modelFailed: false })
            }
            finishOption(result)
          })
          .finally(() => setMenuBusy(false))
      }
      const choosePreset = value => {
        setMenuBusy(true)
        setMenuError("")
        const commands = deskRemotes.commands
        // The native picker submits `/permission <preset>`. There is no
        // `permissionPresets.set`. An unknown name comes back as `ok` with no value.
        if (commands === null || sessionId === null || !/^[A-Za-z0-9_-]+$/u.test(value)) {
          setMenuBusy(false)
          finishOption(null)
          return
        }
        void remoteCall(() => commands.execute(sessionId, '/permission ' + value, []))
          .then(result => {
            const failed = result === null || result.ok !== true || result.value === undefined
            if (!failed) {
              held.current.preset = value
              setOptions(current => current === null ? current : { ...current, preset: value })
            }
            finishOption(failed ? { ok: false, error: { message: result?.error?.message || t('optionFailed') } } : result)
          })
          .finally(() => setMenuBusy(false))
      }
      const runCommand = command => {
        setMenuBusy(true)
        setMenuError("")
        const commands = deskRemotes.commands
        if (commands === null || sessionId === null) {
          setMenuBusy(false)
          finishOption(null)
          return
        }
        void remoteCall(() => commands.execute(sessionId, command, []))
          .then(result => finishOption(result))
          .finally(() => setMenuBusy(false))
      }
      /**
       * The three modes the native permission picker shows, in its order.
       * Anything else the catalog returns (auto, custom) keeps the host's own name.
       */
      const PERMISSION_MODES = [
        ['read-only', 'preset.readOnly', 'preset.readOnlyDetail'],
        ['workspace-write', 'preset.workspaceWrite', 'preset.workspaceWriteDetail'],
        ['danger-full-access', 'preset.fullAccess', 'preset.fullAccessDetail'],
      ]
      const permissionCopy = option => {
        const known = PERMISSION_MODES.find(([value]) => value === option?.value)
        if (known !== undefined) return { label: t(known[1]), detail: t(known[2]) }
        const name = typeof option?.name === 'string' && option.name.length > 0 ? option.name : String(option?.value ?? '')
        const detail = typeof option?.description === 'string' ? option.description : ''
        return { label: name, detail }
      }
      const orderedPresets = presets => {
        const known = []
        const rest = []
        for (const option of presets) {
          const index = PERMISSION_MODES.findIndex(([value]) => value === option?.value)
          if (index >= 0) known[index] = option
          else rest.push(option)
        }
        return [...known.filter(option => option !== undefined), ...rest]
      }
      const presetLabel = () => {
        if (options === null || typeof options.preset !== 'string') return ''
        const found = options.presets.find(item => item?.value === options.preset)
        if (found === undefined) return permissionCopy({ value: options.preset, name: options.preset }).label
        return permissionCopy(found).label
      }
      const menuRow = (key, label, active, onClick) => h('button', {
        key,
        type: "button",
        className: "dsh-comfyui-dock-menu-item",
        "data-active": active,
        disabled: menuBusy,
        onClick,
      }, label)
      const menuRows = () => {
        if (menu === 'root') {
          // Commands come from the session registry, so a plugin that adds
          // /rewind gets an entry here without this file knowing it.
          const commands = Array.isArray(options?.commands) ? options.commands : []
          const rows = []
          if (commands.length > 0) rows.push(h("p", { key: "g-cmd", className: "dsh-comfyui-dock-menu-head" }, t("instructions")))
          for (const command of commands) {
            const name = typeof command?.name === 'string' ? command.name : String(command ?? '')
            if (name.length === 0) continue
            const title = typeof command?.title === 'string' ? command.title : name
            rows.push(menuRow('c-' + name, title, false, () => runCommand(name.startsWith('/') ? name : '/' + name)))
          }
          if (rows.length === 0) rows.push(h("p", { key: "none", className: "dsh-comfyui-dock-menu-empty" }, t("optionsEmpty")))
          rows.push(h("div", { key: "sep", className: "dsh-comfyui-dock-menu-sep" }))
          rows.push(menuRow('model', t('model') + (options?.model?.model ? ' · ' + options.model.model : ''), false, () => setMenu('model')))
          rows.push(menuRow('preset', presetLabel() || t('permissions'), false, () => { setConfirmPreset(null); setMenu('preset') }))
          return rows
        }
        if (menu === 'model') {
          if (options === null) return [h("p", { key: "load", className: "dsh-comfyui-dock-menu-empty" }, t("loading"))]
          if (options.modelFailed) return [h("p", { key: "fail", className: "dsh-comfyui-dock-menu-empty" }, t("optionsFailed"))]
          const rows = []
          for (const group of options.models) {
            const name = typeof group?.name === 'string' ? group.name : String(group?.id ?? '')
            rows.push(h('p', { key: 'g-' + String(group?.id), className: 'dsh-comfyui-dock-menu-head' }, name))
            for (const item of Array.isArray(group?.models) ? group.models : []) {
              const modelId = String(item?.id ?? '')
              const active = options.model?.provider === group?.id && options.model?.model === item?.id
              rows.push(menuRow('m-' + String(group?.id) + '-' + modelId, typeof item?.name === 'string' ? item.name : modelId, active, () => chooseModel(String(group?.id), modelId)))
            }
          }
          if (rows.length === 0) rows.push(h("p", { key: "none", className: "dsh-comfyui-dock-menu-empty" }, t("optionsEmpty")))
          return rows
        }
        if (menu === 'preset') {
          if (options === null) return [h("p", { key: "load", className: "dsh-comfyui-dock-menu-empty" }, t("loading"))]
          if (options.presetFailed) return [h("p", { key: "fail", className: "dsh-comfyui-dock-menu-empty" }, t("optionsFailed"))]
          if (confirmPreset !== null) {
            return [
              h('p', { key: 'title', className: 'dsh-comfyui-dock-menu-head' }, t('confirmFullTitle')),
              h('p', { key: 'body', className: 'dsh-comfyui-dock-menu-detail' }, t('confirmFullBody')),
              menuRow('cancel', t('confirmCancel'), false, () => setConfirmPreset(null)),
              menuRow('enable', t('confirmFullEnable'), false, () => {
                const value = confirmPreset
                setConfirmPreset(null)
                choosePreset(value)
              }),
            ]
          }
          const rows = orderedPresets(options.presets).map(option => {
            const value = String(option?.value ?? '')
            const copy = permissionCopy(option)
            const label = h('span', { className: 'dsh-comfyui-dock-menu-choice' },
              h('span', null, copy.label),
              copy.detail.length > 0 ? h('span', { className: 'dsh-comfyui-dock-menu-detail' }, copy.detail) : null)
            return menuRow('p-' + value, label, options.preset === option?.value, () => {
              if (value === 'danger-full-access' && options.preset !== value) {
                setConfirmPreset(value)
                return
              }
              choosePreset(value)
            })
          })
          if (rows.length === 0) rows.push(h("p", { key: "none", className: "dsh-comfyui-dock-menu-empty" }, t("optionsEmpty")))
          return rows
        }
        return []
      }
      useEffect(() => {
        if (menu === null) return undefined
        const close = event => {
          const target = event.target
          if (target instanceof Element && target.closest(".dsh-comfyui-dock-menu, .dsh-comfyui-dock-add") !== null) return
          setConfirmPreset(null)
          setMenu(null)
        }
        document.addEventListener("pointerdown", close)
        return () => document.removeEventListener("pointerdown", close)
      }, [menu])
      useEffect(() => {
        // The chips under the log name the current model and preset, so the
        // options are read once on mount as well as when the menu opens.
        void loadOptions()
      }, [loadOptions, sessionId])
      const send = event => {
        event.preventDefault()
        void admit(draft.trim())
      }
      const startNew = () => {
        if (busy) return
        setBusy(true)
        setError(null)
        fetch(DESK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'new' }),
        })
          .then(response => response.json())
          .then(body => {
            if (body?.ok === true && typeof body.sessionId === 'string') {
              setRows([])
              setPending(null)
              setStick(true)
              onSession(body.sessionId)
            } else {
              setError({
                message: typeof body?.error === 'string' && body.error.length > 0 ? body.error : t('assistantFailed'),
                text: '',
              })
            }
          })
          .catch(() => setError({ message: t('assistantFailed'), text: '' }))
          .finally(() => setBusy(false))
      }
      const shown = pending === null ? rows : [...rows, { id: 'pending', role: 'user', text: pending.text }]
      const hint = thinking && lastRole !== 'assistant' ? t('assistantThinking') : ''
      return h('aside', {
        className: open ? 'dsh-comfyui-dock' : 'dsh-comfyui-dock is-closed',
        'aria-label': t('assistant'),
      },
        h('header', { className: 'dsh-comfyui-dock-head' },
          h('div', { className: 'dsh-comfyui-dock-title' },
            h('strong', null, t('assistant')),
            thinking ? h('span', { className: 'dsh-comfyui-dock-badge' }, t('assistantWorking')) : null,
          ),
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-dock-new',
            disabled: busy,
            onClick: startNew,
          }, t('assistantNew')),
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-dock-toggle',
            'aria-label': open ? t('assistantClose') : t('assistant'),
            title: open ? t('assistantClose') : t('assistant'),
            onClick: () => setOpen(value => !value),
          }, open ? h('svg', {
            width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.2,
            'aria-hidden': 'true',
          },
            h('path', { d: 'M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z' }),
            h('path', { d: 'M5.5 1.5V14.5' }),
          ) : t('assistant')),
        ),
        open ? h('div', { className: 'dsh-comfyui-dock-log', ref: logRef, onScroll },
          truncated && shown.length > 0
            ? h('p', { className: 'dsh-comfyui-dock-truncated' }, t('truncated'))
            : null,
          shown.length === 0 && !thinking
            ? h('div', { className: 'dsh-comfyui-dock-emptyblock' },
              h('p', { className: 'dsh-comfyui-dock-empty' }, t('assistantEmpty')),
              h('p', { className: 'dsh-comfyui-dock-hint' }, t('assistantHint')))
            : shown.map(row => h(DockRow, { key: row.id, row, t })),
          thinking ? h('div', { className: 'dsh-comfyui-dock-row', 'data-role': 'assistant', 'data-thinking': 'true' },
            h('div', { className: 'dsh-comfyui-thinking' },
              h('span', { className: 'dsh-comfyui-thinking-dot' }),
              h('span', { className: 'dsh-comfyui-thinking-dot' }),
              h('span', { className: 'dsh-comfyui-thinking-dot' }),
              h('span', { className: 'dsh-comfyui-thinking-label' }, hint.length > 0 ? hint : t('assistantSending')))) : null,
        ) : null,
        open ? h('button', {
          type: 'button',
          className: 'dsh-comfyui-dock-jump',
          hidden: stick || shown.length === 0,
          onClick: jumpToLatest,
        }, t('assistantJump')) : null,
        open && error !== null ? h('div', { className: 'dsh-comfyui-dock-error' },
          h('span', { className: 'dsh-comfyui-dock-error-text' }, error.message),
          error.text.length > 0 && !busy
            ? h('button', {
              type: 'button',
              className: 'dsh-comfyui-dock-retry',
              onClick: () => { void admit(error.text, { retry: true }) },
            }, t('retry'))
            : null) : null,
        open ? h('div', { className: 'dsh-comfyui-dock-controls' },
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-dock-chip',
            onClick: () => { setConfirmPreset(null); setOptions(null); void loadOptions(); setMenu('preset') },
          }, presetLabel() || t('permissions')),
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-dock-chip',
            'data-kind': 'model',
            onClick: () => { setOptions(null); void loadOptions(); setMenu('model') },
          }, typeof options?.model?.model === 'string' ? options.model.model : t('model')),
        ) : null,
        open ? h('form', { className: 'dsh-comfyui-dock-form', onSubmit: send },
          h('button', {
            type: 'button',
            className: 'dsh-comfyui-dock-add',
            'aria-label': t('menu'),
            'aria-expanded': menu !== null,
            onClick: toggleMenu,
          }, '+'),
          h('textarea', {
            className: 'dsh-comfyui-dock-input',
            rows: 1,
            value: draft,
            placeholder: t('assistantPlaceholder'),
            'aria-label': t('assistantPlaceholder'),
            onChange: event => {
              setDraft(event.target.value)
              const field = event.target
              field.style.height = 'auto'
              field.style.height = Math.min(field.scrollHeight, 120) + 'px'
            },
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            },
          }),
          h('button', {
            className: 'dsh-comfyui-send',
            type: 'submit',
            disabled: busy || draft.trim() === '',
            'aria-label': busy ? t('assistantSending') : t('assistantSend'),
          }, h('svg', {
            width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
            'aria-hidden': 'true',
          }, h('path', { d: 'M12 19V5M6 11l6-6 6 6' }))),
          menu !== null
            ? h('div', { className: 'dsh-comfyui-dock-menu' },
              menuError.length > 0 ? h('p', { className: 'dsh-comfyui-dock-menu-error' }, menuError) : null,
              ...menuRows())
            : null,
        ) : null,
      )
    }
    /** Main column: the editor for the desk session, and that session's composer. */
    function Desk() {
      const [sessionId, setSessionId] = useState(null)
      const [failed, setFailed] = useState(null)
      useEffect(() => {
        let gone = false
        fetch(DESK_URL)
          .then(response => response.json())
          .then(body => {
            if (gone) return
            if (body?.ok === true && typeof body.sessionId === 'string') setSessionId(body.sessionId)
            else setFailed(typeof body?.error === 'string' ? body.error : deskT('assistantFailed'))
          })
          .catch(() => { if (!gone) setFailed(deskT('assistantFailed')) })
        return () => { gone = true }
      }, [])
      return h('div', { className: 'dsh-comfyui-desk' },
        sessionId === null
          ? h('div', { className: 'dsh-comfyui-panel' },
            h('style', null, CSS),
            h('div', { className: 'dsh-comfyui-notice' }, failed ?? deskT('loading')),
          )
          : h(ComfyPanel, { key: sessionId, sessionId, t: deskT }),
        h(AssistantDock, { t: deskT, sessionId, onSession: setSessionId }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      // Editor operations, dictionaries, and the bar/stage rules, exposed for
      // test/client-ops.mjs. The Host loader reads only `inject` and `apply`.
      __ops: { applyOperation, applyEdits, captureGraph, applyWorkflowGraph, loadWorkflow, switchTab, closeTab, readTabs, tabLabel, coerceWidgetValue, frontendClientId, panelApp, workflowNameFromEditor, bindWorkflowLabel, mapApiEvent, offerRelayEvent, relayEditorEvents, readPreview, progressSummary, applyRunEvent, runLabel, cancelLabel, TopBar, barPlan, overlayPlan, servicePollMs, StageOverlay, projectGraph, fitCanvas, viewShowsAll, describeOperation, en, zh, createSync, parseMarkdown, parseInline, renderInline, renderMarkdown },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        // A cordis context throws on an uninjected service property, and that
        // throw took the whole client plugin down with it. Both access paths
        // are tried, and a deployment without either leaves the menu empty
        // instead of removing the panel from the sidebar.
        deskRemotes = {
          session: remoteNamespace(ctx, 'remote.session'),
          presets: remoteNamespace(ctx, 'remote.permissionPresets'),
          commands: remoteNamespace(ctx, 'remote.commands'),
        }
        deskT = t
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-comfyui: dictionaries')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 7,
          label: () => t('title'),
        }, PanelIcon)), 'dsh-comfyui: sidebar entry')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_KEY,
        }, Desk)), 'dsh-comfyui: main panel')
      },
    }
  },
})
