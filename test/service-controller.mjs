/**
 * The service controller's ownership rules: a healthy upstream is adopted when
 * it serves the configured checkout, and reported as external when it does not.
 * The process probes are injected, so no ComfyUI is involved.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceController } from '../service.js'

/** A supervisor stand-in that records what the controller asked it to do. */
function fakeSupervisor() {
  const calls = { attach: [], start: 0, stop: 0 }
  const state = { enabled: true, state: 'stopped', pid: null, restarts: 0, lastExit: null, lastError: null }
  return {
    calls,
    snapshot: () => ({ ...state }),
    attach(pid) {
      calls.attach.push(pid)
      state.state = 'running'
      state.pid = pid
      state.attached = true
    },
    async start() { calls.start += 1 },
    async stop() { calls.stop += 1 },
  }
}

/** A checkout directory a supervisor plan accepts. */
const cwd = mkdtempSync(join(tmpdir(), 'dsh-comfyui-controller-'))
writeFileSync(join(cwd, 'main.py'), '')

/**
 * One controller whose probe answers can be changed between calls.
 * @param {{ healthy?: boolean, pid?: number | null, serves?: boolean }} [initial] - the first answers.
 */
function makeController(initial = {}) {
  const answers = { healthy: true, pid: 4242, serves: true, ...initial }
  const supervisor = fakeSupervisor()
  const controller = createServiceController({
    upstream: 'http://127.0.0.1:8188',
    config: { enabled: false },
    probe: async () => answers.healthy,
    logger: { info() {}, warn() {} },
    findListener: () => answers.pid,
    serves: () => answers.serves,
    makeSupervisor: () => supervisor,
  })
  controller.restore({ cwd, autoStart: false })
  return { controller, supervisor, answers }
}

// A listener from another checkout is external: it is reported, never stopped.
{
  const { controller } = makeController({ serves: false })
  const adopted = await controller.adopt(true)
  assert.equal(adopted.state, 'external')
  assert.equal(adopted.pid, 4242)
  assert.equal(adopted.owned, false)
  await assert.rejects(controller.stop(), /started outside the plugin/)
  await assert.rejects(controller.restart(), /started outside the plugin/)
}

// A listener that serves the configured checkout is attached, and the next
// adopt call does not attach it twice.
{
  const { controller, supervisor } = makeController()
  const adopted = await controller.adopt(true)
  assert.equal(supervisor.calls.attach.length, 1)
  assert.equal(adopted.state, 'running')
  assert.equal(adopted.pid, 4242)
  assert.equal(adopted.owned, true)
  await controller.adopt(true)
  assert.equal(supervisor.calls.attach.length, 1, 'a managed server is not adopted again')
}

// A server that starts after the plugin is picked up by a later healthy call.
{
  const { controller, supervisor, answers } = makeController({ healthy: false })
  assert.equal((await controller.adopt()).state, 'stopped')
  assert.equal(supervisor.calls.attach.length, 0)
  answers.healthy = true
  assert.equal((await controller.adopt()).state, 'running')
  assert.equal(supervisor.calls.attach.length, 1)
}

// A failed adoption is replaced, not repeated: once the checkout matches, the
// external pid must not survive beside the managed process.
{
  const { controller, answers } = makeController({ serves: false })
  assert.equal((await controller.adopt(true)).state, 'external')
  answers.serves = true
  assert.equal((await controller.adopt(true)).state, 'running')
  assert.equal(controller.snapshot().state, 'running')
  assert.equal(controller.snapshot().owned, true)
}

// A portable build is unzipped into one folder holding `ComfyUI/`: saving that
// folder stores the checkout inside it, so the next start finds the files.
{
  const bundle = mkdtempSync(join(tmpdir(), 'dsh-comfyui-bundle-'))
  mkdirSync(join(bundle, 'ComfyUI'), { recursive: true })
  writeFileSync(join(bundle, 'ComfyUI', 'main.py'), '')
  const { controller } = makeController()
  controller.save({ cwd: bundle, autoStart: false })
  assert.equal(controller.settings.cwd, join(bundle, 'ComfyUI'))
  assert.throws(() => controller.save({ cwd: join(bundle, 'ComfyUI', 'models'), autoStart: false }), /does not contain main\.py/)
  rmSync(bundle, { recursive: true, force: true })
}

rmSync(cwd, { recursive: true, force: true })
console.log('service controller test passed')
