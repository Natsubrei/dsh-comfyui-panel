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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
 * Where comfy-cli keeps `config.ini`. These are its own paths
 * (`comfy_cli/constants.py`, `DEFAULT_CONFIG`), not ones this plugin invented.
 * @param {string} home - the user's home directory.
 * @param {string} platform - `process.platform`.
 * @returns {string} the config file.
 */
export function comfyCliConfigPath(home, platform) {
  if (platform === 'win32') return join(home, 'AppData', 'Local', 'comfy-cli', 'config.ini')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'comfy-cli', 'config.ini')
  return join(home, '.config', 'comfy-cli', 'config.ini')
}

/**
 * The single directory comfy-cli creates when nobody names one
 * (`DEFAULT_COMFY_WORKSPACE`). Linux is `~/comfy/ComfyUI`; macOS and Windows
 * are `~/Documents/comfy/ComfyUI`.
 * @param {string} home - the user's home directory.
 * @param {string} platform - `process.platform`.
 * @returns {string} that directory.
 */
export function comfyCliDefaultInstall(home, platform) {
  if (platform === 'win32' || platform === 'darwin') return join(home, 'Documents', 'comfy', 'ComfyUI')
  return join(home, 'comfy', 'ComfyUI')
}

/**
 * The workspaces a comfy-cli `config.ini` records, in its own preference:
 * `default_workspace` (what `comfy set-default` saved), then `recent_workspace`
 * (the last launch). A missing key, a blank value, and a malformed line are
 * skipped; the file is configparser's `key = value` shape.
 * @param {string} text - the file, or `''` when it cannot be read.
 * @returns {string[]} absolute-looking values, default first.
 */
export function comfyCliWorkspaces(text) {
  /** @type {Record<string, string>} */
  const found = {}
  if (typeof text !== 'string') return []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if ((key === 'default_workspace' || key === 'recent_workspace') && value !== '') found[key] = value
  }
  return [found.default_workspace, found.recent_workspace].filter(value => typeof value === 'string')
}

/**
 * The checkout to pre-fill when the user has not saved one. Saved settings
 * always win over this; this only runs while `settings` is null.
 *
 * The order is what the official tools already record, never a list of folders
 * this plugin hopes for: `COMFYUI_HOME`, then comfy-cli's `default_workspace`,
 * then its `recent_workspace`, then the one directory comfy-cli itself
 * installs into. The first that contains `main.py` wins. ComfyUI Desktop does
 * not publish a path file — it asks once — so there is nothing of its to read.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, platform?: string, isCheckout?: (directory: string) => boolean, readText?: (path: string) => string }} [options] - overrides for tests. Omitted, it reads this machine.
 * @returns {{ cwd: string | null, candidates: string[] }} the chosen directory and everything that was considered.
 */
export function discoverComfyUi({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  isCheckout = isComfyUiDir,
  readText = path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  },
} = {}) {
  const candidates = []
  if (typeof env.COMFYUI_HOME === 'string' && env.COMFYUI_HOME.length > 0) {
    candidates.push(resolve(env.COMFYUI_HOME))
  }
  for (const recorded of comfyCliWorkspaces(readText(comfyCliConfigPath(home, platform)))) {
    if (isAbsolute(recorded)) candidates.push(resolve(recorded))
  }
  candidates.push(comfyCliDefaultInstall(home, platform))
  for (const candidate of candidates) {
    if (isCheckout(candidate)) return { cwd: resolve(candidate), candidates }
  }
  return { cwd: null, candidates }
}

/** The ComfyUI frontend build this panel was verified against. */
export const VERIFIED_FRONTEND = '1.57.1'

/**
 * The interpreter the panel will spawn for a checkout.
 * @param {string} cwd - the ComfyUI directory.
 * @param {{ exists: (path: string) => boolean, platform: string }} options - filesystem and platform, so a test does not depend on this machine.
 * @returns {string} an absolute venv interpreter, or `python` / `python3` on `PATH`.
 */
export function pythonCommand(cwd, { exists, platform }) {
  const candidates = platform === 'win32'
    ? [join(cwd, '.venv', 'Scripts', 'python.exe')]
    : [join(cwd, '.venv', 'bin', 'python')]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return platform === 'win32' ? 'python' : 'python3'
}

/**
 * The working directory named by `lsof -Fn` output.
 * @param {string} listing - stdout of `lsof -a -p <pid> -d cwd -Fn`.
 * @returns {string | null} the path, or null when the listing does not name one.
 */
export function cwdFromLsof(listing) {
  if (typeof listing !== 'string') return null
  for (const line of listing.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1)
  }
  return null
}

/**
 * Whether two directories are the same checkout after resolving symlinks.
 * @param {string | null} actual - a process working directory.
 * @param {string} directory - the configured ComfyUI checkout.
 * @returns {boolean} true when both exist and resolve to the same path.
 */
export function checkoutMatches(actual, directory) {
  if (typeof actual !== 'string' || actual.length === 0) return false
  if (typeof directory !== 'string' || directory.length === 0) return false
  try {
    return realpathSync(actual) === realpathSync(directory)
  } catch {
    return false
  }
}

/**
 * Read the installed frontend version from a `/system_stats` body.
 * Older ComfyUI builds omit the field; a commit hash is not a version.
 * @param {any} data - decoded `/system_stats` JSON, or null when the probe failed.
 * @returns {string | null} the installed `comfyui-frontend-package` version.
 */
export function installedFrontendVersion(data) {
  const system = data?.system
  if (system === null || typeof system !== 'object') return null
  const packages = system.comfy_package_versions
  if (Array.isArray(packages)) {
    const found = packages.find(pkg => pkg !== null && typeof pkg === 'object' && pkg.name === 'comfyui-frontend-package')
    if (typeof found?.installed === 'string' && /^\d+\.\d+\.\d+/.test(found.installed)) return found.installed
  }
  if (typeof system.comfyui_frontend_version === 'string' && /^\d+\.\d+\.\d+/.test(system.comfyui_frontend_version)) {
    return system.comfyui_frontend_version
  }
  return null
}

/**
 * Compare an upstream `/system_stats` body with the frontend this panel was verified against.
 * A missing version is not a mismatch.
 * @param {any} data - decoded `/system_stats` JSON, or null.
 * @returns {{ status: 'verified' | 'mismatch' | 'unreported', installed: string | null, expected: string, warning: string | null }} the report the panel and `comfyui_status` share. `unreported` means the upstream did not name a version; it is not a mismatch.
 */
export function frontendReport(data) {
  const installed = installedFrontendVersion(data)
  if (installed === null) {
    return { status: 'unreported', installed: null, expected: VERIFIED_FRONTEND, warning: null }
  }
  if (installed === VERIFIED_FRONTEND) {
    return { status: 'verified', installed, expected: VERIFIED_FRONTEND, warning: null }
  }
  return {
    status: 'mismatch',
    installed,
    expected: VERIFIED_FRONTEND,
    warning: `ComfyUI frontend ${installed} is not the verified ${VERIFIED_FRONTEND}. The panel may miss runs, edits, or the graph.`,
  }
}

/**
 * The working directory to compare with the checkout.
 * A `/proc` answer is authoritative, including a mismatch. `lsof` is only the fallback when `/proc` cannot name one.
 * @param {string | null} procCwd - realpath of `/proc/<pid>/cwd`, or null.
 * @param {string | null} lsofCwd - path from `lsof`, or null. Ignored when `procCwd` is set.
 * @returns {string | null} the path to compare, or null when neither tool named one.
 */
export function adoptDirectory(procCwd, lsofCwd) {
  return procCwd !== null ? procCwd : lsofCwd
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
  const port = new URL(upstream).port || '8188'
  return {
    enabled: true,
    command: pythonCommand(cwd, { exists: existsSync, platform: process.platform }),
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

/**
 * The process working directory from Linux `/proc`.
 * @param {number} pid - the listener.
 * @returns {string | null} the real path, or null when this platform has no `/proc` or the pid is gone.
 */
function readProcCwd(pid) {
  try {
    return realpathSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/**
 * The process working directory from `lsof`.
 * @param {number} pid - the listener.
 * @returns {string | null} the path, or null when `lsof` cannot name it.
 */
function readLsofCwd(pid) {
  try {
    const listing = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000,
    })
    return cwdFromLsof(listing)
  } catch {
    return null
  }
}

/**
 * Whether `pid` runs with `directory` as its working directory.
 * `/proc` is authoritative when it names a directory, so a mismatch does not spawn `lsof`.
 * @param {number} pid - the listener.
 * @param {string} directory - the configured ComfyUI checkout.
 * @returns {boolean} true when the named working directory is that checkout.
 */
function servesDirectory(pid, directory) {
  const fromProc = readProcCwd(pid)
  const fromLsof = fromProc !== null ? null : readLsofCwd(pid)
  return checkoutMatches(adoptDirectory(fromProc, fromLsof), directory)
}

/**
 * Create the panel-facing service controller.
 * @param {object} options - the controller's collaborators.
 * @param options.upstream - the ComfyUI upstream URL.
 * @param options.config - normalized `supervise` config from the plugin row.
 * @param options.probe - resolves true when the upstream answers `/system_stats`.
 * @param options.logger - host logger.
 * @param [options.findListener] - pid listening on a port; injectable for tests.
 * @param [options.serves] - whether a pid runs a checkout; injectable for tests.
 * @param [options.makeSupervisor] - supervisor factory; injectable for tests.
 * @returns the controller used by the service route, tools, and shutdown.
 */
export function createServiceController({
  upstream,
  config,
  probe,
  logger,
  findListener = listenerPid,
  serves = servesDirectory,
  makeSupervisor = createSupervisor,
}) {
  /** Panel-owned settings; null until saved or detected. */
  let settings = config.enabled ? { cwd: config.cwd, autoStart: true } : null
  /** The advanced config plan, used until the panel saves its own settings. */
  let configuredPlan = config.enabled ? { ...config, logPath: config.logPath ?? defaultLogPath() } : null
  let supervisor = null
  let lastError = null
  /** A healthy server this controller cannot prove it may manage. */
  let externalPid = null

  const snapshot = () => {
    const base = supervisor?.snapshot() ?? {
      enabled: true,
      state: externalPid === null ? 'stopped' : 'external',
      pid: externalPid,
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
    supervisor = makeSupervisor({ config: plan, probe, logger })
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
     *
     * It may run more than once: a reload or a late start can leave a healthy
     * server unowned, so the status path calls this whenever it sees one.
     * @param healthy - a probe result the caller already has, to avoid a second request.
     */
    async adopt(healthy) {
      if (supervisor !== null) return snapshot()
      const reachable = healthy ?? await probe().catch(() => false)
      if (reachable !== true) return snapshot()
      let plan
      try {
        plan = configuredPlan ?? planFromSettings(settings, upstream)
      } catch {
        return snapshot()
      }
      const port = new URL(upstream).port || '8188'
      const pid = findListener(port)
      if (pid === null || !serves(pid, plan.cwd)) {
        externalPid = pid
        logger?.info(`dsh-comfyui: ComfyUI is listening upstream but was not started from ${plan.cwd}; leaving it external`)
        return snapshot()
      }
      const target = ensureSupervisor()
      if (typeof target.attach === 'function') target.attach(pid)
      externalPid = null
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
      externalPid = null
      return snapshot()
    },
    /**
     * Start (or adopt) ComfyUI. A start while a managed process is already
     * running is a no-op.
     */
    async start() {
      externalPid = null
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
      if (snap === undefined) {
        if (externalPid !== null) throw new Error('ComfyUI was started outside the plugin, so the plugin will not stop it. Stop it where it was launched.')
        return snapshot()
      }
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
      if (snap === undefined && externalPid !== null) {
        throw new Error('ComfyUI was started outside the plugin; restart it where it was launched.')
      }
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
