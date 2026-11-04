/**
 * The Host-side run tracker: queue and history reads, a failed read, the
 * watching budget, and `stop`. The clock and the timers are injected, so the
 * test advances fake time instead of sleeping.
 */
import assert from 'node:assert/strict'
import { createRunTracker, queueHas } from '../run-tracker.js'

/** Let every promise the timer callback started run to completion. */
const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * A clock whose timers only fire when the test says so.
 * @param {number} [start] - initial epoch milliseconds.
 */
function createClock(start = 1_000_000) {
  let at = start
  /** @type {{ fn: () => void, at: number, cleared: boolean }[]} */
  const timers = []
  return {
    now: () => at,
    advance: ms => { at += ms },
    timers,
    setTimer(fn, ms) {
      const handle = { fn, at: at + ms, cleared: false }
      timers.push(handle)
      return handle
    },
    clearTimer(handle) {
      handle.cleared = true
      const index = timers.indexOf(handle)
      if (index !== -1) timers.splice(index, 1)
    },
    pending: () => timers.filter(timer => !timer.cleared).length,
    async fire() {
      const timer = timers.shift()
      assert.ok(timer, 'expected a scheduled poll')
      timer.fn()
      await flush()
    },
  }
}

/**
 * A `fetchJson` that answers from a script and records what was asked.
 * @param {any[]} steps - responses, functions of the path, or Errors to throw.
 */
function scripted(steps) {
  const calls = []
  return {
    calls,
    async fetchJson(path, timeoutMs) {
      calls.push({ path, timeoutMs })
      assert.ok(steps.length > 0, `unexpected request: ${path}`)
      const step = steps.shift()
      if (step instanceof Error) throw step
      if (typeof step === 'function') return step(path)
      return step
    },
    remaining: () => steps.length,
  }
}

// Queued -> running -> completed, with the history outputs kept and no poll
// left behind once the run settles.
{
  const clock = createClock()
  const changes = []
  const script = scripted([
    { ok: true, status: 200, data: { queue_running: [[1, 'p1', {}, {}, []]], queue_pending: [] } },
    { ok: true, status: 200, data: { queue_running: [], queue_pending: [] } },
    {
      ok: true,
      status: 200,
      data: {
        p1: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 7: { images: [{ filename: 'ComfyUI_0001_.png', subfolder: '', type: 'output' }] } },
        },
      },
    },
  ])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: record => changes.push(record),
  })

  tracker.watch('s1', 'p1')
  assert.equal(tracker.snapshot('p1').status, 'queued', 'the run exists as queued before the first poll')
  assert.equal(script.calls.length, 0, 'watch itself does not hit the upstream')
  assert.deepEqual(changes.map(record => record.status), ['queued'], 'the queued record is reported at once')
  assert.equal(clock.pending(), 1)

  tracker.watch('s1', 'p1')
  assert.equal(clock.pending(), 1, 'watch is idempotent for the same prompt')

  await clock.fire()
  assert.equal(script.calls.at(-1).path, '/queue')
  assert.equal(script.calls.at(-1).timeoutMs, 2500, 'a probe has its own read budget')
  const running = tracker.snapshot('p1')
  assert.equal(running.status, 'running')
  assert.equal(running.startedAt, clock.now(), 'the first running tick starts the record')
  assert.equal(clock.pending(), 1, 'a running run keeps its timer')

  await clock.fire()
  assert.deepEqual(script.calls.slice(-2).map(call => call.path), ['/queue', '/history/p1'])
  const settled = tracker.snapshot('p1')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.outputs[7].images[0].filename, 'ComfyUI_0001_.png', 'history outputs survive')
  assert.equal(clock.pending(), 0, 'a settled run is not polled again')
  assert.deepEqual(changes.map(record => record.status), ['queued', 'running', 'completed'])

  const calls = script.calls.length
  await flush()
  assert.equal(script.calls.length, calls, 'nothing fires after the terminal record')
  assert.equal((await tracker.refresh('p1')).status, 'completed')
  assert.equal(script.calls.length, calls, 'refreshing a settled run reads nothing')
  tracker.stop()
}

// A failed queue read keeps the last status, records the error, and keeps
// polling; the next good read clears the error.
{
  const clock = createClock()
  const script = scripted([
    { ok: false, status: 503, data: null, error: 'upstream unavailable' },
    { ok: true, status: 200, data: { queue_running: [[2, 'p2', {}, {}, []]], queue_pending: [] } },
  ])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  tracker.watch('s1', 'p2')
  await clock.fire()
  const stale = tracker.snapshot('p2')
  assert.equal(stale.status, 'queued', 'a failed read must not invent a run failure')
  assert.equal(stale.error, 'upstream unavailable')
  assert.equal(clock.pending(), 1, 'a failed read is retried')

  await clock.fire()
  const recovered = tracker.snapshot('p2')
  assert.equal(recovered.status, 'running')
  assert.equal(recovered.error, null, 'a successful read clears the stale error')
  tracker.stop()
}

// `refresh` polls immediately, without waiting for the timer, and leaves the
// timer armed: this is what `comfyui_progress` relies on.
{
  const clock = createClock()
  const script = scripted([
    { ok: true, status: 200, data: { queue_running: [], queue_pending: [[1, 'p-live', {}, {}, []]] } },
  ])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  tracker.watch('s1', 'p-live')
  const refreshed = await tracker.refresh('p-live')
  assert.equal(refreshed.status, 'queued')
  assert.equal(script.calls.length, 1, 'refresh reads the queue now')
  assert.equal(clock.pending(), 1, 'the scheduled poll is still armed')
  assert.equal(await tracker.refresh('p-unknown'), null, 'an unwatched prompt has no host record')
  assert.equal(script.calls.length, 1, 'an unwatched prompt is not polled')
  tracker.stop()
}

// Only the history knows a run finished: status_str decides completion, and
// ComfyUI's own interruption message keeps the panel's vocabulary.
{
  const clock = createClock()
  const script = scripted([
    { ok: true, status: 200, data: { queue_running: [], queue_pending: [] } },
    {
      ok: true,
      status: 200,
      data: { p3: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] }, outputs: {} } },
    },
    { ok: true, status: 200, data: { queue_running: [], queue_pending: [] } },
    {
      ok: true,
      status: 200,
      data: { p4: { status: { status_str: 'error', messages: [['execution_interrupted', { node_id: '7' }]] }, outputs: {} } },
    },
  ])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  tracker.watch('s1', 'p3')
  await clock.fire()
  assert.equal(tracker.snapshot('p3').status, 'error')
  assert.equal(tracker.snapshot('p3').error, 'CUDA out of memory')

  tracker.watch('s1', 'p4')
  await clock.fire()
  assert.equal(tracker.snapshot('p4').status, 'interrupted')
  assert.equal(tracker.snapshot('p4').error, null)
  assert.equal(clock.pending(), 0)
  tracker.stop()
}

// Nobody can observe forever: past maxMs the run is lost, not failed, and the
// tracker stops without spending another request.
{
  const clock = createClock()
  const script = scripted([])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    intervalMs: 100,
    maxMs: 5000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  tracker.watch('s1', 'p5')
  clock.advance(5000)
  await clock.fire()
  assert.equal(tracker.snapshot('p5').status, 'lost')
  assert.equal(script.calls.length, 0, 'the budget is checked before the probe')
  assert.equal(clock.pending(), 0)
  await flush()
  assert.equal(script.calls.length, 0, 'a lost run is not polled again')
  tracker.stop()
}

// stop clears the timer, refuses new watches, and makes refresh a pure read.
{
  const clock = createClock()
  const script = scripted([])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  tracker.watch('s1', 'p6')
  assert.equal(clock.pending(), 1)
  tracker.stop()
  assert.equal(clock.pending(), 0, 'stop clears every timer')
  assert.equal((await tracker.refresh('p6')).status, 'queued', 'the last record stays readable')
  assert.equal(script.calls.length, 0, 'refresh after stop does not hit the upstream')
  tracker.watch('s1', 'p7')
  assert.equal(tracker.snapshot('p7'), null, 'a stopped tracker does not start new watches')
  assert.equal(clock.pending(), 0)
}

// `onChange` is told which session queued the prompt. `forget` clears that
// association without stopping the poll: later callbacks pass null, the
// record stays readable, and the timer runs until the run settles. Watching
// the same prompt again does not bring the session back.
{
  const clock = createClock()
  const changes = []
  const script = scripted([
    { ok: true, status: 200, data: { queue_running: [[1, 'p-forget', {}, {}, []]], queue_pending: [] } },
    { ok: true, status: 200, data: { queue_running: [], queue_pending: [] } },
    {
      ok: true,
      status: 200,
      data: { 'p-forget': { status: { status_str: 'success', completed: true, messages: [] }, outputs: {} } },
    },
  ])
  const tracker = createRunTracker({
    fetchJson: script.fetchJson,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onChange: (record, sessionId) => changes.push({ status: record.status, sessionId }),
  })
  tracker.watch('s-forget', 'p-forget')
  assert.deepEqual(changes, [{ status: 'queued', sessionId: 's-forget' }], 'onChange receives the session passed to watch')
  assert.equal(clock.pending(), 1)

  tracker.forget('s-forget')
  assert.equal(clock.pending(), 1, 'forget leaves the timer armed')
  assert.equal(tracker.snapshot('p-forget').status, 'queued', 'forget does not drop the record')
  assert.deepEqual(changes, [{ status: 'queued', sessionId: 's-forget' }], 'forget itself does not emit')

  tracker.watch('s-other', 'p-forget')
  assert.equal(clock.pending(), 1, 'a second watch of the same prompt stays a no-op')
  assert.equal(changes.length, 1, 'a second watch does not report the run again')

  await clock.fire()
  assert.equal(tracker.snapshot('p-forget').status, 'running')
  assert.equal(changes.at(-1).sessionId, null, 'a poll after forget reports no session')
  assert.equal(clock.pending(), 1, 'polling continues after forget')

  const refreshed = await tracker.refresh('p-forget')
  assert.equal(refreshed.status, 'completed')
  assert.equal(tracker.snapshot('p-forget').status, 'completed', 'snapshot still returns the settled record')
  assert.equal(changes.at(-1).status, 'completed')
  assert.equal(changes.at(-1).sessionId, null, 'the settling callback also passes null')
  assert.equal(clock.pending(), 0, 'the timer stays until the run settles, then stops')
  tracker.stop()
}

// ComfyUI queue lists are tuples of [number, prompt_id, ...]. Anything that
// is not an array is not a queue.
{
  assert.equal(queueHas([[4, 'prompt-a', {}, { extra: true }, []]], 'prompt-a'), true)
  assert.equal(queueHas([[4, 'prompt-b', {}, {}, []]], 'prompt-a'), false)
  assert.equal(queueHas([[4, 'prompt-a']], 'prompt-a'), true, 'only the prompt id slot is required')
  assert.equal(queueHas([null, 'prompt-a', { 1: 'prompt-a' }], 'prompt-a'), false, 'a non-tuple entry is not a hit')
  assert.equal(queueHas(null, 'prompt-a'), false)
  assert.equal(queueHas(undefined, 'prompt-a'), false)
  assert.equal(queueHas({ 1: 'prompt-a' }, 'prompt-a'), false)
  assert.equal(queueHas('prompt-a', 'prompt-a'), false)
}

console.log('run tracker test passed')
