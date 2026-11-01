/**
 * Command channel between the Host tools and the panel's long-poll.
 *
 * `comfyui_edit`, `comfyui_screenshot` and `comfyui_workflow_load` each queue
 * one command for a session; the panel's long-poll takes it, applies it inside
 * the iframe, and posts the result back, because the editor can only be
 * mutated in the browser. Everything those three hops share — the per-session
 * queue, the parked waiters, the pending answers, and their expiry — lives
 * here, so a session's exit ends all of it through one call.
 */

/**
 * @typedef {{ id?: unknown, at?: unknown, [key: string]: unknown }} QueuedCommand
 * @typedef {{ ok: boolean, value?: any, error?: string | null }} PanelAnswer
 * @typedef {{ body: { ok: boolean, command?: QueuedCommand | null, error?: string }, status: number }} PollResult
 * @typedef {{
 *   ask: (sessionId: string, command: QueuedCommand & { id: string }, options: { timeoutMs: number, what: string }) => Promise<PanelAnswer>,
 *   poll: (sessionId: string, options?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<PollResult>,
 *   answer: (id: string, result: { ok?: unknown, value?: unknown, error?: unknown }) => boolean,
 *   drop: (sessionId: string, id: string) => void,
 *   release: (sessionId: string) => void,
 *   connected: (sessionId: string) => boolean,
 * }} CommandChannel
 */

/** How long a queued command may wait for a panel before it is dropped. */
const COMMAND_TTL_MS = 60_000

/**
 * Take the next command a panel can still act on.
 *
 * The queue is read through this rather than shifted directly because a command
 * whose tool call has already failed must not be applied later: a panel that
 * reconnects minutes afterwards would change the user's graph for an edit the
 * model reported as never delivered, and the result would be discarded.
 *
 * @param {QueuedCommand[]} queue - commands in arrival order, each stamped with `at`.
 * @param {number} [now] - current time; injectable so the expiry is testable.
 * @returns {QueuedCommand | null} the oldest live command, or `null` when every one has expired.
 */
export function takeCommand(queue, now = Date.now()) {
  while (queue.length > 0) {
    const command = queue.shift()
    const at = typeof command?.at === 'number' && Number.isFinite(command.at) ? command.at : now
    if (now - at <= COMMAND_TTL_MS) return command
  }
  return null
}

/**
 * Create the command channel the Host routes and tools share.
 *
 * @returns {CommandChannel} the channel.
 */
export function createCommandChannel() {
  /** @type {Map<string, { queue: QueuedCommand[], waiters: Array<{ resolve: (command: QueuedCommand | null) => void }>, lastPollAt: number }>} */
  const queues = new Map()
  /** @type {Map<string, { resolve: (answer: PanelAnswer) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>, sessionId: string }>} */
  const pending = new Map()

  /**
   * @param {string} sessionId - the session whose panel polls.
   * @returns {{ queue: QueuedCommand[], waiters: Array<{ resolve: (command: QueuedCommand | null) => void }>, lastPollAt: number }} its queue state, created on first use.
   */
  function stateOf(sessionId) {
    let state = queues.get(sessionId)
    if (state === undefined) {
      state = { queue: [], waiters: [], lastPollAt: 0 }
      queues.set(sessionId, state)
    }
    return state
  }

  /**
   * @param {string} sessionId - the session whose panel should take the command.
   * @param {QueuedCommand & { id: string }} command - the command to hand over.
   */
  function enqueue(sessionId, command) {
    const state = stateOf(sessionId)
    const waiter = state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(command)
    else state.queue.push(command)
  }

  /**
   * Drop a command the panel never picked up.
   *
   * A tool that has already failed must not reach the editor later: the panel
   * can reconnect minutes after a tool call reported that it never answered,
   * and applying the edit then would change a graph the model no longer
   * believes it touched — with the result discarded, because the waiter is
   * gone. The queue and the tool call have to expire together.
   *
   * @param {string} sessionId - the session the command was queued for.
   * @param {string} id - the command id to forget.
   */
  function drop(sessionId, id) {
    const state = queues.get(sessionId)
    if (state === undefined) return
    const index = state.queue.findIndex(command => command.id === id)
    if (index !== -1) state.queue.splice(index, 1)
  }

  /**
   * Queue one command for a session's panel and wait for its result.
   *
   * The panel answers through `commands/result`; a panel that disappears after
   * claiming the command is bounded by the timeout, and `release` rejects the
   * wait when the owning agent goes away. `drop` runs with the timeout so a
   * panel reconnecting later cannot apply an expired command.
   *
   * @param {string} sessionId - the session whose panel should answer.
   * @param {QueuedCommand & { id: string }} command - command body; its `id` correlates the result.
   * @param {{ timeoutMs: number, what: string }} options - how long to wait before giving up, and the short noun for the timeout message.
   * @returns {Promise<PanelAnswer>} the panel's answer.
   */
  function ask(sessionId, command, { timeoutMs, what }) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(command.id)
        drop(sessionId, command.id)
        reject(new Error(`The ComfyUI panel did not answer the ${what} in time. It may be reloading.`))
      }, timeoutMs)
      pending.set(command.id, { resolve, reject, timer, sessionId })
      enqueue(sessionId, command)
    })
  }

  /**
   * Park a panel's long-poll until a command arrives, the budget runs out, or
   * the request aborts.
   *
   * @param {string} sessionId - the session whose panel is polling.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - the client's budget, clamped to 1-25 s, and the request's abort signal.
   * @returns {Promise<PollResult>} the response body and its HTTP status; only an abort is a non-200.
   */
  function poll(sessionId, options = {}) {
    const requested = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : 20000
    const budget = Math.min(25000, Math.max(1000, requested))
    const state = stateOf(sessionId)
    state.lastPollAt = Date.now()
    // `takeCommand` skips anything the tool has given up on, so a panel that
    // polls after a timeout gets nothing instead of a stale edit.
    const live = takeCommand(state.queue)
    if (live !== null) return Promise.resolve({ body: { ok: true, command: live }, status: 200 })
    return new Promise(resolve => {
      let settled = false
      const finish = (body, status) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const index = state.waiters.indexOf(waiter)
        if (index !== -1) state.waiters.splice(index, 1)
        resolve({ body, status })
      }
      const timer = setTimeout(() => finish({ ok: true, command: null }, 200), budget)
      const waiter = { resolve: command => finish({ ok: true, command }, 200) }
      state.waiters.push(waiter)
      options.signal?.addEventListener('abort', () => finish({ ok: false, error: 'poll aborted' }, 499))
    })
  }

  /**
   * Hand the panel's posted result to the tool call still waiting for it.
   *
   * @param {string} id - the command id the panel answers with.
   * @param {{ ok?: unknown, value?: unknown, error?: unknown }} result - the posted result.
   * @returns {boolean} whether a tool call was still waiting for it.
   */
  function answer(id, result) {
    const waiting = pending.get(id)
    if (waiting === undefined) return false
    pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.resolve({
      ok: result?.ok !== false,
      value: result?.value ?? null,
      error: typeof result?.error === 'string' ? result.error.slice(0, 2000) : null,
    })
    return true
  }

  /**
   * End everything the Host is still holding for a session whose agent went
   * away.
   *
   * DSH disposes an agent on clear and compaction too, and the same session id
   * comes back with a fresh agent; a long-poll or a tool call parked on the old
   * panel must not wait out its timeout against an editor nobody owns any more.
   * A queued edit is dropped with its tool call: handing it to the next panel
   * would change a graph the model no longer believes it touched.
   *
   * @param {string} sessionId - the session whose agent was disposed.
   */
  function release(sessionId) {
    const state = queues.get(sessionId)
    if (state !== undefined) {
      // Resolving a waiter with no command releases the open HTTP request so
      // the panel's loop can re-arm under the new agent.
      for (const waiter of [...state.waiters]) waiter.resolve(null)
      queues.delete(sessionId)
    }
    for (const [id, waiting] of [...pending]) {
      if (waiting.sessionId !== sessionId) continue
      pending.delete(id)
      clearTimeout(waiting.timer)
      waiting.reject(new Error('The ComfyUI session closed before the panel answered; open the tab again and retry.'))
    }
  }

  /**
   * Whether this session's panel is listening for commands. A long-poll stays
   * open for up to 20 s, so an idle waiter counts as connected even when the
   * last request started earlier than the freshness window.
   *
   * @param {string} sessionId - the session to ask about.
   * @returns {boolean} whether the panel is connected.
   */
  function connected(sessionId) {
    const state = queues.get(sessionId)
    if (state === undefined) return false
    if (state.waiters.length > 0) return true
    return Date.now() - state.lastPollAt <= 15000
  }

  return { ask, poll, answer, drop, release, connected }
}
