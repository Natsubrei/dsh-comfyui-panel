/**
 * The ComfyUI desk session. The page syncs under this id, and a line from the
 * composer is admitted to the same session. The session's agent calls the tools.
 */

const MAX_MESSAGE = 4000

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
