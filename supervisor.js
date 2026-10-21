/**
 * Optional ComfyUI process supervision.
 *
 * When `supervise.enabled` is true the Host starts ComfyUI itself and keeps it
 * alive, so reopening the panel does not wait for a cold boot and a crashed
 * backend comes back without a shell. An already-running external ComfyUI is
 * adopted instead of duplicated: the supervisor only spawns when the upstream
 * health probe fails.
 *
 * The child is owned by the plugin lifetime: unloading the plugin (or a Host
 * shutdown) stops it. A Host crash leaves the child behind — ComfyUI is a
 * long-lived server, not a request-scoped job — and the next start adopts it.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default log file: inside the DSH home so it survives plugin reinstalls. */
export function defaultLogPath() {
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`
  return `${home}/comfyui/comfyui.log`
}

/**
 * Create the supervisor.
 * @param options.config - normalized `supervise` config.
 * @param options.probe - resolves true when the upstream answers `/system_stats`.
 * @param options.logger - host logger.
 * @returns start/stop controls plus a status snapshot.
 */
export function createSupervisor({ config, probe, logger }) {
  const logPath = config.logPath ?? defaultLogPath()
  const status = {
    enabled: true,
    state: 'idle',
    pid: null,
    restarts: 0,
    lastExit: null,
    lastError: null,
    startedAt: null,
    logPath,
  }
  let child = null
  let stopping = false
  let startTimer = null
  let monitorTimer = null
  let bootTimer = null
  let healthyMisses = 0

  const clearTimers = () => {
    if (startTimer !== null) {
      clearTimeout(startTimer)
      startTimer = null
    }
    if (monitorTimer !== null) {
      clearInterval(monitorTimer)
      monitorTimer = null
    }
    if (bootTimer !== null) {
      clearInterval(bootTimer)
      bootTimer = null
    }
  }

  const schedule = (delayMs, action) => {
    if (startTimer !== null) clearTimeout(startTimer)
    startTimer = setTimeout(() => {
      startTimer = null
      action()
    }, delayMs)
  }

  const restart = () => {
    if (stopping) return
    if (status.restarts >= config.maxRestarts) {
      status.state = 'failed'
      logger?.warn(`dsh-comfyui: ComfyUI exited ${status.restarts} times; not restarting again (see ${logPath})`)
      return
    }
    status.restarts += 1
    status.state = 'restarting'
    logger?.warn(`dsh-comfyui: restarting ComfyUI in ${config.restartDelayMs}ms (attempt ${status.restarts}/${config.maxRestarts})`)
    schedule(config.restartDelayMs, () => { void launch() })
  }

  const monitor = () => {
    if (monitorTimer !== null) return
    monitorTimer = setInterval(() => {
      void (async () => {
        if (stopping) return
        const healthy = await probe().catch(() => false)
        if (healthy) {
          healthyMisses = 0
          if (status.state === 'starting') status.state = child === null ? 'external' : 'running'
          else if (status.state === 'failed' || status.state === 'stopped' || status.state === 'restarting') {
            status.state = child === null ? 'external' : 'running'
            status.restarts = 0
          }
          return
        }
        // The restart budget is spent; a later healthy probe adopts again.
        if (status.state === 'failed') return
        if (child === null) {
          // An adopted server went away, or the first probe found nothing:
          // take ownership and bring one up after a short grace period, so a
          // single slow probe does not race a healthy generation.
          healthyMisses += 1
          if (healthyMisses >= 3) {
            healthyMisses = 0
            void launch()
          }
          return
        }
        healthyMisses += 1
        if (healthyMisses >= 3) {
          healthyMisses = 0
          logger?.warn('dsh-comfyui: ComfyUI stopped answering health probes; restarting it')
          child.kill('SIGTERM')
        }
      })()
    }, config.probeIntervalMs)
    monitorTimer.unref?.()
  }

  /**
   * Poll health every second until the fresh child answers or the budget runs
   * out. A ComfyUI cold start takes seconds to tens of seconds; the panel shows
   * its own boot progress meanwhile.
   */
  const waitForHealthy = () => {
    if (bootTimer !== null) return
    const deadline = Date.now() + config.startTimeoutMs
    bootTimer = setInterval(() => {
      void (async () => {
        if (stopping) return
        const healthy = await probe().catch(() => false)
        if (healthy) {
          clearInterval(bootTimer)
          bootTimer = null
          healthyMisses = 0
          status.state = 'running'
          status.startedAt = Date.now()
          monitor()
          return
        }
        if (Date.now() > deadline) {
          clearInterval(bootTimer)
          bootTimer = null
          status.state = 'failed'
          status.lastError = `ComfyUI did not answer /system_stats within ${config.startTimeoutMs}ms`
          logger?.warn(`dsh-comfyui: ${status.lastError} (see ${logPath})`)
        }
      })()
    }, 1000)
    bootTimer.unref?.()
  }

  const launch = async () => {
    if (stopping || child !== null) return
    let log = null
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      log = openSync(logPath, 'a')
    } catch (error) {
      logger?.warn(`dsh-comfyui: cannot open ${logPath}: ${String(error)}`)
    }
    status.state = 'starting'
    status.lastError = null
    let proc
    try {
      proc = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      })
    } catch (error) {
      if (log !== null) closeSync(log)
      status.state = 'failed'
      status.lastError = error instanceof Error ? error.message : String(error)
      logger?.error(`dsh-comfyui: could not start ComfyUI: ${status.lastError}`)
      return
    }
    if (log !== null) closeSync(log)
    child = proc
    status.pid = proc.pid ?? null
    status.state = 'starting'
    logger?.info(`dsh-comfyui: started ComfyUI pid ${proc.pid} (log ${logPath})`)
    proc.once('error', error => {
      status.lastError = error instanceof Error ? error.message : String(error)
      logger?.error(`dsh-comfyui: ComfyUI process error: ${status.lastError}`)
      // A spawn failure (no pid) never emits 'exit'; report it instead of
      // waiting out the boot budget on a process that does not exist.
      if (proc.pid === undefined) {
        child = null
        status.pid = null
        status.state = 'failed'
        status.lastExit = { code: null, signal: null, at: Date.now() }
        clearTimers()
      }
    })
    proc.once('exit', (code, signal) => {
      child = null
      status.pid = null
      status.startedAt = null
      if (bootTimer !== null) {
        clearInterval(bootTimer)
        bootTimer = null
      }
      status.lastExit = { code, signal, at: Date.now() }
      if (stopping) {
        status.state = 'stopped'
        return
      }
      logger?.warn(`dsh-comfyui: ComfyUI exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)
      restart()
    })
    waitForHealthy()
  }

  return {
    /**
     * Begin supervising. Adopts a healthy external upstream, otherwise starts
     * one and waits for the health probe before reporting `running`.
     */
    async start() {
      if (stopping) return
      const healthy = await probe().catch(() => false)
      if (healthy) {
        status.state = 'external'
        logger?.info(`dsh-comfyui: ComfyUI is already running upstream; supervising it in place`)
        monitor()
        return
      }
      await launch()
    },
    /** Stop the owned child and every timer. Idempotent. */
    async stop() {
      stopping = true
      clearTimers()
      if (child === null) {
        status.state = status.state === 'failed' ? 'failed' : 'stopped'
        return
      }
      const proc = child
      await new Promise(resolve => {
        const force = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 5000)
        force.unref?.()
        proc.once('exit', () => {
          clearTimeout(force)
          resolve()
        })
        proc.kill('SIGTERM')
      })
      child = null
      status.pid = null
      status.state = 'stopped'
    },
    /** Current supervisor status for `comfyui_status`. */
    snapshot() {
      return { ...status }
    },
  }
}

/**
 * Inert supervisor for profiles that leave `supervise.enabled` false.
 * @returns a supervisor-shaped handle that never starts a process.
 */
export function disabledSupervisor() {
  return {
    async start() {},
    async stop() {},
    snapshot() { return { enabled: false, state: 'disabled' } },
  }
}
