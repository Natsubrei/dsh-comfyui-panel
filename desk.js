/**
 * The ComfyUI desk session. The page syncs under this id, and a line from the
 * composer is admitted to the same session. The session's agent calls the tools.
 */

const MAX_MESSAGE = 4000

/** Rows the dock shows at most; the session keeps the full history. */
export const MAX_TRANSCRIPT = 40

/** How much of one tool argument or result the column keeps. */
const MAX_TOOL_TEXT = 800

/**
 * Bound one tool string for the column.
 * @param {unknown} value - the raw text.
 * @param {number} [limit] - characters to keep.
 * @returns {string | null} the clipped text, or null when there is nothing to show.
 */
function clip(value, limit = MAX_TOOL_TEXT) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/**
 * The arguments a tool was called with, as the column shows them.
 *
 * An empty payload is dropped: `{}` is what every argument-less tool sends,
 * and a card whose detail is "{}" teaches the reader nothing.
 *
 * @param {unknown} raw - the `arguments` string from `tool/call`.
 * @returns {string | null} the payload, or null.
 */
function toolArguments(raw) {
  const text = clip(raw)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return null
    return text
  } catch {
    return text
  }
}

/**
 * The visible text of one message's content.
 * @param {unknown} content - a message's `content` blocks.
 * @returns {string} the text blocks, joined; empty when there are none.
 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Reduce session wire records to the rows the dock renders.
 *
 * A tool call becomes one row that its result fills in, so the column shows a
 * finished edit as one card instead of two lines. Injected context (a message
 * whose `source.kind` is not `user`) and reasoning stay out; a tool result is
 * trimmed, because the column is a conversation, not a log.
 *
 * @param {readonly any[]} records - `SessionHistoryRecord`s from `sessionController.events`.
 * @returns {{ id: string, role: string, text: string, at?: number, tokens?: number, name?: string, args?: string, result?: string, status?: string, durationMs?: number }[]} the rows, oldest first.
 */
export function transcriptRows(records) {
  /** @type {any[]} */
  const rows = []
  /** @type {Map<string, any>} callId -> the row its result paints. */
  const calls = new Map()
  for (const record of records) {
    if (record?.type !== 'event') continue
    const event = record.event
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const id = String(event.seq)
    /** When the event happened; the wire carries it beside the data. */
    const at = typeof event.time === 'number' ? event.time : null
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      // A user message stores the message itself; an assistant message stores
      // `{ message, stream, usage }`. Both fields are optional in the wire type.
      const message = data.message === undefined ? data : data.message
      if (message === null || typeof message !== 'object') continue
      if (event.type === 'user/message' && message.source?.kind !== 'user') continue
      const text = contentText(message.content)
      if (text.length === 0) continue
      /** @type {any} */
      const row = { id, role: event.type === 'user/message' ? 'user' : 'assistant', text }
      if (at !== null) row.at = at
      // Output tokens are the one usage figure a reader can act on; the input
      // count is the whole context and reads as noise per turn.
      if (event.type === 'assistant/message' && typeof data.usage?.outputTokens === 'number') {
        row.tokens = data.usage.outputTokens
      }
      rows.push(row)
      continue
    }
    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'tool'
      /** @type {any} */
      const row = { id, role: 'tool', name, text: name, status: 'running' }
      if (at !== null) row.at = at
      const args = toolArguments(data.arguments)
      if (args !== null) row.args = args
      rows.push(row)
      if (typeof data.callId === 'string' && data.callId.length > 0) calls.set(data.callId, row)
      continue
    }
    if (event.type === 'tool/result') {
      const message = data.message
      const callId = typeof data.toolCallId === 'string'
        ? data.toolCallId
        : (typeof message?.source?.callId === 'string' ? message.source.callId : null)
      if (callId === null) continue
      const row = calls.get(callId)
      // A result whose call fell outside the window has nowhere to paint.
      if (row === undefined) continue
      row.status = data.isError === true ? 'error' : 'done'
      const result = clip(contentText(message?.content))
      if (result !== null) row.result = result
      if (at !== null && typeof row.at === 'number' && at >= row.at) row.durationMs = at - row.at
      calls.delete(callId)
      continue
    }
  }
  return rows.slice(-MAX_TRANSCRIPT)
}

/** The stored desk session is not in the session service anymore. */
export class DeskSessionMissing extends Error {
  constructor() {
    super('The desk session is gone')
    this.name = 'DeskSessionMissing'
  }
}

/**
 * The one session that owns the canvas.
 *
 * A stored id is reused. The first visit creates one and stores whatever id
 * came back. `resume` runs either way, so the Agent exists before the page syncs.
 *
 * @param {{
 *   read: () => Promise<string | null>,
 *   save: (sessionId: string) => Promise<void>,
 *   create: () => Promise<string>,
 *   resume: (sessionId: string) => Promise<void>,
 * }} adapters - stored id, persistence, session creation, and agent resume.
 * @returns {Promise<string>} the session id the page syncs under.
 */
export async function ensureDeskSession({ read, save, create, resume }) {
  const stored = await read()
  if (typeof stored === 'string' && stored.length > 0) {
    try {
      await resume(stored)
      return stored
    } catch (error) {
      if (!(error instanceof DeskSessionMissing)) throw error
    }
  }
  const sessionId = await create()
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('The desk session was not created')
  }
  await save(sessionId)
  await resume(sessionId)
  return sessionId
}

/**
 * Send one line into the desk session. The session's own agent calls the tools.
 *
 * @param {unknown} message - the user's text.
 * @param {{
 *   sessionId: () => Promise<string>,
 *   prompt: (sessionId: string, text: string) => Promise<void>,
 * }} adapters - where the session id comes from, and how a line is admitted.
 * @returns {Promise<{ ok: true, sessionId: string } | { ok: false, status: number, error: string }>} the turn.
 */
export async function sendDeskMessage(message, { sessionId, prompt }) {
  if (typeof message !== 'string') return { ok: false, status: 400, error: 'message must be a string' }
  const text = message.trim()
  if (text.length === 0) return { ok: false, status: 400, error: 'message is empty' }
  if (text.length > MAX_MESSAGE) return { ok: false, status: 400, error: 'message is too long' }
  let id
  try {
    id = await sessionId()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 502, error: detail || 'The desk session is unavailable' }
  }
  try {
    await prompt(id, text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 502, error: detail || 'The session did not accept the message' }
  }
  return { ok: true, sessionId: id }
}
