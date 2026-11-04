/**
 * Host-side truth for a run this plugin queued.
 *
 * ComfyUI sends execution events only to the socket that queued the prompt,
 * and that socket belongs to the panel. Once the panel closes, nothing reports
 * the run's state to the Host. This tracker polls `/queue` and `/history/{id}`
 * for the prompts `comfyui_run` queued, so `comfyui_progress` can still answer
 * after the panel is gone.
 *
 * A tick reads the queue first: an entry in `queue_running` is `running`, one
 * in `queue_pending` is `queued`. A prompt in neither is looked up in history,
 * whose record ends the run as `completed`, `error`, or `interrupted`. A failed
 * queue read keeps the last status, records the error, and retries on the next
 * tick. `maxMs` is a budget on watching, not on the run: when it expires the
 * record becomes `lost`, meaning the Host stopped looking, not that the run
 * disappeared.
 */

/** Statuses after which a tracked prompt needs no more polls. */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'interrupted', 'lost'])

/** One queue or history read. */
const PROBE_TIMEOUT_MS = 2500

/**
 * @typedef {object} RunRecord
 * @property {string} promptId
 * @property {string} status
 * @property {number | null} startedAt
 * @property {number} updatedAt
 * @property {string | null} node
 * @property {number | null} value
 * @property {number | null} max
 * @property {string | null} error
 * @property {any} outputs - the history `outputs` once the run settles, else null.
 */

/**
 * @typedef {object} RunEntry
 * @property {string | null} sessionId
 * @property {RunRecord} record
 * @property {number} deadline
 * @property {any} timer
 * @property {boolean} terminal
 * @property {string} signature
 * @property {Promise<void>} chain
 */

/**
 * @typedef {object} RunTrackerOptions
 * @property {(path: string, timeoutMs: number) => Promise<{ ok: boolean, status: number, data: any, error?: string }>} fetchJson - one read of the ComfyUI upstream.
 * @property {number} [intervalMs] - delay between polls (default 2000).
 * @property {number} [maxMs] - how long a prompt stays watched (default 30 minutes).
 * @property {() => number} [now] - clock, injectable for tests.
 * @property {(fn: () => void, ms: number) => any} [setTimer] - timer, injectable for tests.
 * @property {(handle: any) => void} [clearTimer] - timer cancellation, injectable for tests.
 * @property {(record: RunRecord, sessionId: string | null) => void} [onChange] - called when a record's observed state changes. `sessionId` is the session passed to `watch`, or null after `forget`.
 */

/**
 * @typedef {object} RunTracker
 * @property {(sessionId: string, promptId: string) => void} watch - start watching one queued prompt; repeat calls are no-ops.
 * @property {(sessionId: string) => void} forget - clear that session's association. Polling continues; later `onChange` calls pass a null session id.
 * @property {(promptId: string) => Promise<RunRecord | null>} refresh - poll once now and return the record; no network after the run ended or the tracker stopped.
 * @property {(promptId: string) => RunRecord | null} snapshot - the last observed record, without polling.
 * @property {() => void} stop - cancel every timer.
 */

/**
 * Create the poller that follows the prompts this plugin queued.
 * @param {RunTrackerOptions} options - the upstream reader plus optional clock and timers.
 * @returns {RunTracker} the tracker.
 */
export function createRunTracker(options) {
  const {
    fetchJson,
    intervalMs = 2000,
    maxMs = 30 * 60 * 1000,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    onChange = () => {},
  } = options ?? {}
  if (typeof fetchJson !== 'function') throw new TypeError('createRunTracker requires a fetchJson function')

  /** @type {Map<string, RunEntry>} */
  const entries = new Map()
  let stopped = false

  /**
   * @param {string} sessionId - the session that queued the prompt.
   * @param {string} promptId - the prompt id ComfyUI returned.
   */
  function watch(sessionId, promptId) {
    if (stopped) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof promptId !== 'string' || promptId.length === 0) return
    if (entries.has(promptId)) return
    const at = now()
    /** @type {RunRecord} */
    const record = {
      promptId,
      status: 'queued',
      startedAt: null,
      updatedAt: at,
      node: null,
      value: null,
      max: null,
      error: null,
      outputs: null,
    }
    const entry = {
      sessionId,
      record,
      deadline: at + maxMs,
      timer: null,
      terminal: false,
      signature: '',
      chain: Promise.resolve(),
    }
    entries.set(promptId, entry)
    // The run exists as "queued" from the moment ComfyUI accepted it, so the
    // session record is written before the first poll, not two seconds later.
    publish(entry)
    schedule(entry)
  }

  /**
   * Drop the session association for every prompt that session queued.
   *
   * Polling continues until the tracker's own budget or a terminal status:
   * the timers stay armed. Later `onChange` calls for those prompts pass
   * `null`. `snapshot` and `refresh` still return the record, and a second
   * `watch` of the same prompt stays a no-op.
   * @param {string} sessionId - the session whose prompts should stop naming it.
   * @returns {void}
   */
  function forget(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    for (const entry of entries.values()) {
      if (entry.sessionId === sessionId) entry.sessionId = null
    }
  }

  /**
   * Bring one watched run up to date without waiting for its timer. Terminal
   * and stopped records are returned as-is: their state cannot change.
   * @param {string} promptId - the prompt to poll.
   * @returns {Promise<RunRecord | null>} the record after the poll, or null when this prompt was never watched.
   */
  async function refresh(promptId) {
    const entry = entries.get(promptId)
    if (entry === undefined) return null
    if (!stopped && !entry.terminal) {
      await enqueue(entry).catch(() => {})
      if (!stopped && !entry.terminal) schedule(entry)
    }
    return clone(entry.record)
  }

  /**
   * @param {string} promptId - the prompt to read.
   * @returns {RunRecord | null} the last observed record, or null when unknown.
   */
  function snapshot(promptId) {
    const entry = entries.get(promptId)
    return entry === undefined ? null : clone(entry.record)
  }

  /** Cancel every pending poll. Records stay readable through `snapshot`. */
  function stop() {
    stopped = true
    for (const entry of entries.values()) {
      if (entry.timer === null) continue
      clearTimer(entry.timer)
      entry.timer = null
    }
  }

  /**
   * Serialize work for one prompt: a timer tick and a `refresh` must not read
   * the upstream at the same time and overwrite each other's result.
   * @param {RunEntry} entry - the watched run.
   * @returns {Promise<void>} the queued probe.
   */
  function enqueue(entry) {
    const next = entry.chain.then(() => probe(entry), () => probe(entry))
    entry.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * @param {RunEntry} entry - the watched run.
   */
  function schedule(entry) {
    if (stopped || entry.terminal || entry.timer !== null) return
    entry.timer = setTimer(() => {
      entry.timer = null
      void enqueue(entry)
        .catch(() => {})
        .finally(() => { schedule(entry) })
    }, intervalMs)
  }

  /**
   * One poll: queue first, history only when the prompt is in neither queue.
   * @param {RunEntry} entry - the watched run.
   */
  async function probe(entry) {
    if (stopped || entry.terminal) return
    const record = entry.record
    const at = now()
    // The budget bounds watching, so do not spend a request on a run the
    // tracker is about to stop following.
    if (at >= entry.deadline) {
      record.status = 'lost'
      record.updatedAt = at
      finish(entry)
      return
    }
    const queue = await read('/queue')
    if (stopped || entry.terminal) return
    if (queue.ok !== true) {
      // A read failure is not a run failure. Keep the last status and retry;
      // `error` says the Host's information is stale.
      record.error = queue.error ?? `HTTP ${queue.status}`
      record.updatedAt = at
      publish(entry)
      return
    }
    const location = queueLocation(queue.data, record.promptId)
    if (location === 'running') {
      record.status = 'running'
      record.startedAt ??= at
      record.error = null
      record.updatedAt = at
      publish(entry)
      return
    }
    if (location === 'queued') {
      record.status = 'queued'
      record.error = null
      record.updatedAt = at
      publish(entry)
      return
    }
    const history = await read(`/history/${encodeURIComponent(record.promptId)}`)
    if (stopped || entry.terminal) return
    if (history.ok !== true) {
      record.error = history.error ?? `HTTP ${history.status}`
      record.updatedAt = at
      publish(entry)
      return
    }
    const settled = isObject(history.data) ? history.data[record.promptId] : null
    if (!isObject(settled)) {
      // The prompt left the queue but history has not caught up (or a queued
      // prompt was cancelled, which ComfyUI does not archive). Keep the last
      // status and look again next tick.
      record.error = null
      record.updatedAt = at
      publish(entry)
      return
    }
    record.outputs = settled.outputs ?? null
    record.status = historyStatus(settled.status)
    record.error = record.status === 'error' ? historyError(settled.status) : null
    record.updatedAt = at
    finish(entry)
  }

  /**
   * @param {RunEntry} entry - the watched run that settled.
   */
  function finish(entry) {
    entry.terminal = true
    if (entry.timer !== null) {
      clearTimer(entry.timer)
      entry.timer = null
    }
    publish(entry)
  }

  /**
   * Tell the listener about a change the session record cares about. `updatedAt`
   * moves on every probe; the signature keeps a quiet tick from rewriting the
   * record.
   * @param {RunEntry} entry - the watched run.
   */
  function publish(entry) {
    const signature = JSON.stringify([entry.record.status, entry.record.startedAt, entry.record.error, entry.record.outputs])
    if (signature === entry.signature) return
    entry.signature = signature
    try {
      onChange(clone(entry.record), entry.sessionId)
    } catch {
      // A listener must not stop the poll loop.
    }
  }

  /**
   * @param {string} path - upstream path.
   * @returns {Promise<{ ok: boolean, status: number, data: any, error?: string }>} the read, with a rejection folded into `ok: false`.
   */
  async function read(path) {
    try {
      return await fetchJson(path, PROBE_TIMEOUT_MS)
    } catch (error) {
      return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return { watch, forget, refresh, snapshot, stop }
}

/** Return a copy: a reader must not be able to mutate the tracked record. */
function clone(record) {
  return /** @type {RunRecord} */ (JSON.parse(JSON.stringify(record)))
}

/**
 * @param {any} data - a `/queue` body.
 * @param {string} promptId - the prompt to find.
 * @returns {'running' | 'queued' | null} where the prompt is, or null when it is in neither list.
 */
function queueLocation(data, promptId) {
  if (!isObject(data)) return null
  if (queueHas(data.queue_running, promptId)) return 'running'
  if (queueHas(data.queue_pending, promptId)) return 'queued'
  return null
}

/**
 * ComfyUI queue entries are `[number, prompt_id, prompt, extra_data, outputs]`.
 * @param {any} list - `queue_running` or `queue_pending`.
 * @param {string} promptId - the prompt to find.
 * @returns {boolean} whether the list holds it.
 */
export function queueHas(list, promptId) {
  if (!Array.isArray(list)) return false
  return list.some(entry => Array.isArray(entry) && entry[1] === promptId)
}

/**
 * Map a history status to the tracker's vocabulary: a success is `completed`,
 * an interruption is `interrupted`, any other error is `error`.
 * @param {any} status - the history `status` object.
 * @returns {string} the run status.
 */
function historyStatus(status) {
  if (!isObject(status) || status.status_str !== 'error') return 'completed'
  return Array.isArray(status.messages) && status.messages.some(message => Array.isArray(message) && message[0] === 'execution_interrupted')
    ? 'interrupted'
    : 'error'
}

/**
 * @param {any} status - the history `status` object.
 * @returns {string} the exception ComfyUI recorded, or a fallback.
 */
function historyError(status) {
  const messages = isObject(status) && Array.isArray(status.messages) ? status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue
    const data = message[1]
    if (isObject(data) && typeof data.exception_message === 'string' && data.exception_message.length > 0) {
      // The panel caps its own error strings at 2000; a history exception can
      // be just as long, and this one is returned to the model.
      return data.exception_message.slice(0, 2000)
    }
  }
  return 'ComfyUI reported status_str "error"'
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
