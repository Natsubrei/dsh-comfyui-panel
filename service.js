/**
 * Panel-managed ComfyUI process control.
 *
 * The plugin is self-contained: it can adopt, start, restart, and stop ComfyUI
 * from the panel without editing the DSH profile configuration. Settings are
 * limited to the ComfyUI directory and an auto-start flag — the executable and
 * arguments are derived from that directory and the configured upstream port,
 * so the panel cannot be turned into an arbitrary command runner.
 *
 * Advanced setups (custom command, arguments, timing) still use the plugin's
 * `supervise` config block; that config, when enabled, takes precedence at
 * start-up and is adopted rather than duplicated.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createSupervisor, defaultLogPath } from './supervisor.js'

/** Whether a directory looks like a ComfyUI checkout (`main.py` at its root). */
export function isComfyUiDir(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return false
  try {
    if (!statSync(directory).isDirectory()) return false
    return existsSync(join(directory, 'main.py'))
  } catch {
    return false
  }
}

/**
 * Common ComfyUI locations, in preference order. Detection only pre-fills the
 * panel; the user's saved directory always wins.
 * @returns candidate directories and the first existing one.
 */
export function discoverComfyUi() {
  const candidates = []
  if (typeof process.env.COMFYUI_HOME === 'string' && process.env.COMFYUI_HOME.length > 0) {
    candidates.push(resolve(process.env.COMFYUI_HOME))
  }
  candidates.push(join(homedir(), 'ComfyUI'))
  candidates.push(join(homedir(), 'workspace', 'ComfyUI'))
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    candidates.push(join(process.env.DSH_HOME, 'ComfyUI'))
  }
  for (const candidate of candidates) {
    if (isComfyUiDir(candidate)) return { cwd: resolve(candidate), candidates }
  }
  return { cwd: null, candidates }
}

/** Keep only the panel-editable settings. */
export function sanitizeServiceSettings(raw) {
  if (raw === null || typeof raw !== 'object') return null
  let cwd = typeof raw.cwd === 'string' && raw.cwd.trim().length > 0 ? raw.cwd.trim() : null
  if (cwd === null) return null
  if (cwd === '~' || cwd.startsWith('~/')) cwd = join(homedir(), cwd.slice(1))
  if (!isAbsolute(cwd)) return null
  return { cwd: resolve(cwd), autoStart: raw.autoStart === true }
}

/**
 * Turn panel settings into a supervisor config.
 * @param settings - saved `{ cwd, autoStart }`.
 * @param upstream - the plugin's upstream URL, which supplies the port.
 * @returns the normalized supervisor config.
 * @throws when the directory is missing or is not a ComfyUI checkout.
 */
export function planFromSettings(settings, upstream) {
  if (settings === null || typeof settings.cwd !== 'string') {
    throw new Error('Choose the ComfyUI directory first (the folder that contains main.py).')
  }
  const cwd = resolve(settings.cwd)
  if (!isComfyUiDir(cwd)) throw new Error(`"${cwd}" does not contain main.py. Pick the ComfyUI checkout directory.`)
  const python = join(cwd, '.venv', 'bin', 'python')
  const port = new URL(upstream).port || '8188'
  return {
    enabled: true,
    command: existsSync(python) ? python : 'python3',
    args: ['main.py', '--listen', '127.0.0.1', '--port', port],
    cwd,
    env: {},
    restartDelayMs: 5000,
    maxRestarts: 5,
    probeIntervalMs: 20000,
    startTimeoutMs: 120000,
    logPath: defaultLogPath(),
  }
}

/**
 * Whether unloading the plugin may stop this process.
 *
 * Only a child this supervisor spawned qualifies. An adopted pid belongs to
 * whoever launched it — the plugin closed its handle to its own survivor after
 * a reload, and cannot tell that survivor from a server the user started by
 * hand — so unloading leaves it running and the panel's Stop stays the only
 * way to end it.
 *
 * @param {object | undefined} snapshot - supervisor snapshot, if there is one.
 * @returns {boolean} true when the process is the plugin's to stop.
 */
export function stopsOnUnload(snapshot) {
  if (snapshot === undefined || snapshot.attached === true) return false
  return snapshot.state !== 'external' && snapshot.state !== 'stopped' && snapshot.state !== 'failed'
}

/**
 * The pid listening on `port`, or null when the platform will not name it.
 * `ss` is Linux's; `lsof` covers macOS and everything else.
 */
function listenerPid(port) {
  try {
    const listing = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 2000 })
    const match = /pid=(\d+)/.exec(listing)
    if (match !== null) return Number(match[1])
  } catch {
    // No ss on this machine.
  }
  try {
    const listing = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 2000 })
    const first = listing.trim().split('\n')[0]
    if (/^\d+$/.test(first)) return Number(first)
  } catch {
    // Neither tool could name the listener.
  }
  return null
}

/** Whether `pid` runs with `directory` as its working directory. */
function servesDirectory(pid, directory) {
  try {
    return realpathSync(`/proc/${pid}/cwd`) === realpathSync(directory)
  } catch {
    return false
  }
}

/**
 * Create the panel-facing service controller.
 * @param {object} options - the controller's collaborators.
 * @param options.upstream - the ComfyUI upstream URL.
 * @param options.config - normalized `supervise` config from the plugin row.
 * @param options.probe - resolves true when the upstream answers `/system_stats`.
 * @param options.logger - host logger.
 * @returns the controller used by the service route, tools, and shutdown.
 */
export function createServiceController({ upstream, config, probe, logger }) {
  /** Panel-owned settings; null until saved or detected. */
  let settings = config.enabled ? { cwd: config.cwd, autoStart: true } : null
  /** The advanced config plan, used until the panel saves its own settings. */
  let configuredPlan = config.enabled ? { ...config, logPath: config.logPath ?? defaultLogPath() } : null
  let supervisor = null
  let lastError = null

  const snapshot = () => {
    const base = supervisor?.snapshot() ?? {
      enabled: true,
      state: 'stopped',
      pid: null,
      restarts: 0,
      lastExit: null,
      lastError: null,
    }
    return {
      ...base,
      settings,
      configured: config.enabled,
      detected: settings === null ? discoverComfyUi().cwd : null,
      owned: supervisor !== null && base.state !== 'external',
      controllerError: lastError,
    }
  }

  const ensureSupervisor = () => {
    if (supervisor !== null) return supervisor
    const plan = configuredPlan ?? planFromSettings(settings, upstream)
    supervisor = createSupervisor({ config: plan, probe, logger })
    return supervisor
  }

  return {
    /** Current settings, for persistence comparisons. */
    get settings() { return settings },
    /** Restore saved settings at start-up. */
    restore(saved) {
      const clean = sanitizeServiceSettings(saved)
      if (clean !== null) settings = clean
    },
    /** Persistable record for one save, or null when nothing is configured. */
    record() {
      return settings === null ? null : { ...settings, updatedAt: Date.now() }
    },
    /** Health plus supervisor state for the panel and `comfyui_status`. */
    async status() {
      const health = await probe().catch(() => false)
      return { ...snapshot(), health }
    },
    /** Status without an extra health probe (tools that already probed). */
    snapshot,
    /**
     * Adopt a ComfyUI that is already listening on the upstream port. A plugin
     * reload drops the child handle while the ComfyUI process keeps running;
     * adopting it back by pid keeps Stop and Restart working instead of
     * leaving a server no button can touch. Only a process running the
     * configured checkout is adopted — anything else stays external.
     */
    async adopt() {
      if (supervisor !== null) return snapshot()
      const healthy = await probe().catch(() => false)
      if (!healthy) return snapshot()
      let plan
      try {
        plan = configuredPlan ?? planFromSettings(settings, upstream)
      } catch {
        return snapshot()
      }
      const port = new URL(upstream).port || '8188'
      const pid = listenerPid(port)
      if (pid === null || !servesDirectory(pid, plan.cwd)) {
        logger?.info(`dsh-comfyui: ComfyUI is listening upstream but was not started from ${plan.cwd}; leaving it external`)
        return snapshot()
      }
      const target = ensureSupervisor()
      if (typeof target.attach === 'function') target.attach(pid)
      return snapshot()
    },
    /** Save panel settings; does not start anything. */
    save(raw) {
      const clean = sanitizeServiceSettings(raw)
      if (clean === null) throw new Error('The ComfyUI directory must be an absolute path.')
      if (!isComfyUiDir(clean.cwd)) throw new Error(`"${clean.cwd}" does not contain main.py.`)
      settings = clean
      configuredPlan = null
      lastError = null
      return snapshot()
    },
    /**
     * Start (or adopt) ComfyUI. A start while a managed process is already
     * running is a no-op.
     */
    async start() {
      const snap = supervisor?.snapshot()
      // A stopped supervisor instance cannot be started again (it latched its
      // stop); drop it so the next start builds a fresh one.
      if (snap !== undefined && (snap.state === 'stopped' || snap.state === 'failed')) supervisor = null
      else if (snap !== undefined && snap.state !== 'external') return snapshot()
      const target = ensureSupervisor()
      await target.start()
      lastError = null
      return snapshot()
    },
    /** Stop a process this controller started. */
    async stop() {
      const snap = supervisor?.snapshot()
      if (snap === undefined) return snapshot()
      if (snap.state === 'external') {
        throw new Error('ComfyUI was started outside the plugin, so the plugin will not stop it. Stop it where it was launched.')
      }
      if (snap.state === 'stopped' || snap.state === 'failed') return snapshot()
      await supervisor.stop()
      return snapshot()
    },
    /** Restart an owned process; adopts an external one again if it is gone. */
    async restart() {
      const snap = supervisor?.snapshot()
      if (snap?.state === 'external') throw new Error('ComfyUI was started outside the plugin; restart it where it was launched.')
      if (snap !== undefined && snap.state !== 'stopped' && snap.state !== 'failed') await supervisor.stop()
      supervisor = null
      return this.start()
    },
    /**
     * Stop a child on plugin unload. An adopted server keeps running: the
     * plugin did not spawn it, and a reload cannot tell its own survivor from
     * a server the user launched, so unloading leaves both alone.
     */
    async shutdown() {
      const snap = supervisor?.snapshot()
      if (supervisor === null || supervisor === undefined || !stopsOnUnload(snap)) return
      await supervisor.stop().catch(() => {})
    },
  }
}
