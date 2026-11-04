/**
 * Session facts for the ComfyUI host half.
 *
 * A session's mirrored workflow, its panel projection, the run record the
 * panel reports, the seed walk a run continues, the tools registered for its
 * agent, and the debounced write to storage all belong to one id. Keeping them
 * together means `release` is the one place a session's memory ends, instead of
 * three sides of `apply()` each deleting their own map entry.
 */
import { sanitizeSemantic, stripViewState } from './projection.js'

/**
 * @typedef {object} SessionState
 * @property {any} workflow - the synced UI workflow, with view state stripped.
 * @property {any} prompt - the API prompt the panel reported, or null.
 * @property {any} semantic - the panel's projection, or null.
 * @property {string} signature - content hash used to decide whether a sync was an edit.
 * @property {string | null} name - the name the panel's editor would save under.
 * @property {'file' | 'tool' | null} nameSource - how the name was attached: the editor's workflow file, a workflow tool, or unknown.
 * @property {string | null} [clientId] - the panel's ComfyUI socket id.
 * @property {TabRecord[]} tabs - the workflows the panel's editor has open, in tab order.
 * @property {number} revision - the descriptive revision the model reads.
 * @property {number} nodes - node count of `workflow`.
 * @property {number} links - link count of `workflow`.
 * @property {string[]} types - up to 64 node class names.
 * @property {number} updatedAt - when the content last changed.
 *
 * A tab's identity is `path`; `name` is the label the user reads, which is null
 * only for a canvas the frontend never named. Tabs are page state like the
 * socket id: they change when the user switches tabs, not when the graph
 * changes, so they stay out of the revision and out of storage.
 *
 * @typedef {object} TabRecord
 * @property {string | null} name
 * @property {string} path
 * @property {boolean} temporary
 * @property {boolean} modified
 * @property {boolean} active
 *
 * @typedef {object} StateSyncBody
 * @property {any} [workflow]
 * @property {any} [prompt]
 * @property {any} [semantic]
 * @property {any} [name]
 * @property {any} [file]
 * @property {any} [clientId]
 * @property {any} [revision]
 * @property {any} [tabs]
 *
 * @typedef {object} PersistedSession
 * @property {string} sessionId
 * @property {number} revision
 * @property {number} updatedAt
 * @property {any} workflow
 * @property {any} [prompt]
 * @property {any} [semantic]
 * @property {unknown} [name]
 * @property {'file' | 'tool' | null} [nameSource]
 *
 * @typedef {object} PanelEvent
 * @property {string} kind
 * @property {string | null} promptId
 * @property {string | null} node
 * @property {number | null} value
 * @property {number | null} max
 * @property {number | null} queueRemaining
 * @property {string | null} error
 * @property {number} at
 *
 * @typedef {object} RunRecord
 * @property {string} promptId
 * @property {string} status
 * @property {number | null} startedAt
 * @property {number} updatedAt
 * @property {string | null} node
 * @property {number | null} value
 * @property {number | null} max
 * @property {string | null} error
 * @property {any} [outputs] - the history outputs when the Host tracked the run itself.
 *
 * @typedef {object} RunBucket
 * @property {PanelEvent | null} latest - the last event the panel reported.
 * @property {Map<string, RunRecord>} runs - runs built from those events.
 * @property {Map<string, RunRecord>} hostRuns - runs the Host polled itself.
 * @property {string | null} hostLatest - the newest host-tracked prompt.
 *
 * @typedef {Map<string, { from: number, used: number }>} SeedCursor
 *
 * @typedef {object} SessionStore
 * @property {(sessionId: string) => SessionState | undefined} get
 * @property {(record: PersistedSession) => void} restore
 * @property {(sessionId: string, body: StateSyncBody) => { ok: true, state: SessionState } | { ok: false, error: string }} sync
 * @property {(sessionId: string, name: string) => void} rename
 * @property {(sessionId: string, event: PanelEvent) => void} recordEvent
 * @property {(sessionId: string, record: RunRecord) => void} mergeRun
 * @property {(sessionId: string) => { latest: PanelEvent | null, run: RunRecord | null }} latestRun
 * @property {(sessionId: string, promptId: string) => RunRecord | null} runFor
 * @property {(sessionId: string) => SeedCursor} seedCursor
 * @property {(sessionId: string, cursor: SeedCursor) => void} commitSeedCursor
 * @property {(sessionId: string, dispose: () => void) => void} trackTools
 * @property {(sessionId: string) => boolean} hasTools
 * @property {(sessionId: string) => void} release
 * @property {() => void} close
 */

/**
 * Create the store that holds every session-scoped fact the Host keeps in
 * memory.
 *
 * @param {object} options - the store's outside edges.
 * @param {(sessionId: string, state: SessionState) => void | Promise<void>} options.persist - writes one session record when the debounce fires.
 * @param {(sessionId: string) => void} options.releaseCommands - ends the command channel's waiters for a released session.
 * @param {{ warn?: (message: string) => void }} [options.logger] - where a failed write is reported.
 * @returns {SessionStore} the store.
 */
export function createSessionStore({ persist, releaseCommands, logger }) {
  /** @type {Map<string, SessionState>} */
  const sessions = new Map()
  /** @type {Map<string, RunBucket>} */
  const progress = new Map()
  /** @type {Map<string, SeedCursor>} */
  const seedCursors = new Map()
  /** @type {Map<string, () => void>} */
  const sessionTools = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const persistTimers = new Map()

  /**
   * The record the tools read, or undefined before the first sync.
   * @param {string} sessionId - the session to look up.
   * @returns {SessionState | undefined} its record.
   */
  function get(sessionId) {
    return sessions.get(sessionId)
  }

  /**
   * Insert a record loaded from storage, as if its panel had synced it.
   * @param {PersistedSession} record - the stored session.
   */
  function restore(record) {
    sessions.set(record.sessionId, stateFromRecord(record))
  }

  /**
   * Fold one `/api/comfyui/state` body into the session record.
   *
   * @param {string} sessionId - the session that synced.
   * @param {StateSyncBody} body - the parsed bridge body.
   * @returns {{ ok: true, state: SessionState } | { ok: false, error: string }} the stored record, or why the body was refused.
   */
  function sync(sessionId, body) {
    // View-only canvas state (zoom/pan) is not an edit; drop it before the
    // content comparison so a scroll or resize cannot bump the revision.
    const workflow = isObject(body?.workflow) ? stripViewState(body.workflow) : null
    const prompt = isObject(body?.prompt) ? body.prompt : null
    if (workflow === null) return { ok: false, error: 'workflow must be an object' }
    const previous = sessions.get(sessionId)
    const incoming = Number.isSafeInteger(body?.revision) ? body.revision : 0
    // The panel reports the name its editor would save under, but only when
    // that name changed: a canvas whose frontend has no file yet sends no
    // `name`, and the Host must keep the name a tool gave the session rather
    // than clear it on every quiet re-sync.
    let name = previous?.name ?? null
    let nameSource = previous?.nameSource ?? null
    if (body?.name !== undefined) {
      if (body.name === null) {
        name = null
        nameSource = null
      } else {
        const requested = validWorkflowName(body.name)
        if (requested === null) return { ok: false, error: 'name must be 1-80 characters without control characters' }
        name = requested
        nameSource = 'file'
      }
    }
    // The panel reports the file the editor has open on every sync. A name that
    // came from a file stops describing the canvas as soon as the editor no
    // longer holds that file — the frontend fell back to a default graph, or the
    // user closed it — so the name goes with it. A name a workflow tool gave
    // this canvas survives: a tool names the canvas, not a file.
    if (body?.file !== undefined) {
      if (body.file === null) {
        if (nameSource === 'file') {
          name = null
          nameSource = null
        }
      } else {
        const file = validWorkflowName(body.file)
        if (file === null) return { ok: false, error: 'file must be 1-80 characters without control characters' }
        name = file
        nameSource = 'file'
      }
    }
    const renamed = name !== (previous?.name ?? null)
    let semantic = sanitizeSemantic(body?.semantic)
    // A projection that sees no nodes while the raw workflow has some comes
    // from a frontend whose live-node layout this client does not recognize;
    // prefer the raw fallback over claiming the graph is empty.
    if (semantic !== null && semantic.nodes.length === 0
      && Array.isArray(workflow.nodes) && workflow.nodes.length > 0) {
      semantic = null
    }
    // The panel re-syncs on a timer even when nothing changed. Compare content
    // so `revision` means "a change was synced" and idle re-syncs stay cheap.
    const signature = JSON.stringify([workflow, prompt, semantic])
    const changed = previous === undefined || previous.signature !== signature
    /** @type {SessionState} */
    const state = {
      workflow,
      prompt,
      semantic,
      signature,
      // The name is metadata, not graph content: it never bumps the revision,
      // because renaming a workflow does not change what the model reads.
      name,
      nameSource,
      // Which socket the embedded frontend is listening on. Execution events
      // only reach the client that queued the prompt, so a run the model
      // starts has to use the panel's id or it never shows up in the UI.
      // Kept in memory only: it changes with the page, not with the workflow.
      clientId: sanitizeClientId(body?.clientId) ?? previous?.clientId ?? null,
      // Open tabs follow the page the same way. A sync without the field — an
      // older panel, or a body built before the list existed — keeps the last
      // list instead of blanking it.
      tabs: body?.tabs === undefined ? (previous?.tabs ?? []) : sanitizeTabs(body.tabs),
      // The panel's counter restarts with the page while the Host may hold a
      // higher persisted revision; keep the descriptive revision monotonic.
      revision: changed
        ? Math.max(incoming, (previous?.revision ?? 0) + 1)
        : (previous?.revision ?? incoming),
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      types: Array.isArray(workflow.nodes)
        ? [...new Set(workflow.nodes.map(node => node?.type).filter(type => typeof type === 'string'))].slice(0, 64)
        : [],
      updatedAt: changed ? Date.now() : (previous?.updatedAt ?? Date.now()),
    }
    sessions.set(sessionId, state)
    if (changed || renamed) schedulePersist(sessionId)
    return { ok: true, state }
  }

  /**
   * Adopt a name a tool gave the canvas, and persist it.
   * @param {string} sessionId - the session to rename.
   * @param {string} name - the validated name.
   */
  function rename(sessionId, name) {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    state.name = name
    state.nameSource = 'tool'
    schedulePersist(sessionId)
  }

  /** Debounced persistence: the panel syncs about once per second while editing. */
  function schedulePersist(sessionId) {
    if (persistTimers.has(sessionId)) return
    persistTimers.set(sessionId, setTimeout(() => {
      persistTimers.delete(sessionId)
      const state = sessions.get(sessionId)
      if (state === undefined) return
      void Promise.resolve()
        .then(() => persist(sessionId, state))
        .catch(error => logger?.warn(`dsh-comfyui: could not persist ${sessionId}: ${String(error)}`))
    }, 1500))
  }

  /**
   * @param {PersistedSession} record - a stored session.
   * @returns {SessionState} the in-memory record it becomes.
   */
  function stateFromRecord(record) {
    const workflow = record.workflow
    const prompt = record.prompt ?? null
    const semantic = sanitizeSemantic(record.semantic)
    return {
      workflow,
      prompt,
      semantic,
      signature: JSON.stringify([workflow, prompt, semantic]),
      name: typeof record.name === 'string' ? record.name : null,
      // Records written before this field existed carry no source, and an
      // unknown source must never be cleared automatically.
      nameSource: record.nameSource === 'file' || record.nameSource === 'tool' ? record.nameSource : null,
      // Not persisted: tabs belong to the page that reported them, and the
      // next sync replaces this list.
      tabs: [],
      revision: record.revision,
      nodes: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
      links: Array.isArray(workflow.links) ? workflow.links.length : 0,
      types: Array.isArray(workflow.nodes)
        ? [...new Set(workflow.nodes.map(node => node?.type).filter(type => typeof type === 'string'))].slice(0, 64)
        : [],
      updatedAt: record.updatedAt,
    }
  }

  /**
   * Fold one panel event into the session's run record.
   * @param {string} sessionId - the session the event was reported for.
   * @param {PanelEvent} event - a normalized event.
   */
  function recordEvent(sessionId, event) {
    let bucket = progress.get(sessionId)
    if (bucket === undefined) {
      bucket = { latest: null, runs: new Map(), hostRuns: new Map(), hostLatest: null }
      progress.set(sessionId, bucket)
    }
    bucket.latest = event
    if (event.promptId === null) return
    let run = bucket.runs.get(event.promptId)
    if (run === undefined) {
      run = {
        promptId: event.promptId,
        status: 'queued',
        startedAt: null,
        updatedAt: event.at,
        node: null,
        value: null,
        max: null,
        error: null,
      }
      bucket.runs.set(event.promptId, run)
    }
    run.updatedAt = event.at
    if (event.kind === 'execution_start') {
      run.status = 'running'
      run.startedAt ??= event.at
    } else if (event.kind === 'execution_success') {
      run.status = 'success'
      run.value = null
      run.max = null
    } else if (event.kind === 'execution_error') {
      run.status = 'error'
      run.error = event.error
    } else if (event.kind === 'execution_interrupted') {
      run.status = 'interrupted'
    } else if (event.kind === 'executing') {
      // A run can be joined after `execution_start` went out: the panel was
      // reloading, or the editor's socket reconnected mid-run. Anything that
      // only happens during a run proves it is running, so the record does not
      // keep claiming "queued" until the success event arrives.
      if (run.status === 'queued') {
        run.status = 'running'
        run.startedAt ??= event.at
      }
      run.node = event.node
    } else if (event.kind === 'progress' || event.kind === 'executed') {
      if (run.status === 'queued') {
        run.status = 'running'
        run.startedAt ??= event.at
      }
      run.node = event.node ?? run.node
      if (event.kind === 'progress') {
        run.value = event.value
        run.max = event.max
      }
    }
    while (bucket.runs.size > 20) {
      const oldest = bucket.runs.keys().next().value
      bucket.runs.delete(oldest)
    }
  }

  /**
   * Fold a host-tracked run into the session, beside the panel's own records.
   *
   * The panel stays canonical where it reported the same prompt: a run built
   * from its events keeps its node and step fields, and `runFor` returns it.
   * The host record fills `latestRun` only when the panel reported no run, so a
   * closed panel does not make a session look like it never started one.
   *
   * @param {string} sessionId - the session that queued the run.
   * @param {RunRecord} record - the tracker's current record.
   */
  function mergeRun(sessionId, record) {
    if (!isObject(record) || typeof record.promptId !== 'string' || record.promptId.length === 0) return
    let bucket = progress.get(sessionId)
    if (bucket === undefined) {
      bucket = { latest: null, runs: new Map(), hostRuns: new Map(), hostLatest: null }
      progress.set(sessionId, bucket)
    }
    const previous = bucket.hostRuns.get(record.promptId)
    bucket.hostRuns.set(record.promptId, {
      promptId: record.promptId,
      status: typeof record.status === 'string' ? record.status : (previous?.status ?? 'queued'),
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : (previous?.startedAt ?? null),
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
      node: record.node ?? previous?.node ?? null,
      value: record.value ?? previous?.value ?? null,
      max: record.max ?? previous?.max ?? null,
      error: record.error ?? null,
      outputs: record.outputs ?? previous?.outputs ?? null,
    })
    // "Latest" means the most recently started run, so only the first record
    // for a prompt can claim it: a slow poll for an older run must not make
    // that run the default again. Every watch emits its queued record before
    // the next watch starts, which keeps this order equal to start order.
    if (previous === undefined) bucket.hostLatest = record.promptId
    while (bucket.hostRuns.size > 20) {
      const oldest = bucket.hostRuns.keys().next().value
      bucket.hostRuns.delete(oldest)
    }
    if (!bucket.hostRuns.has(bucket.hostLatest)) bucket.hostLatest = null
  }

  /**
   * The last event the panel reported, with the run it belongs to.
   * @param {string} sessionId - the session to read.
   * @returns {{ latest: PanelEvent | null, run: RunRecord | null }} the latest event and its run.
   */
  function latestRun(sessionId) {
    const bucket = progress.get(sessionId)
    if (bucket === undefined) return { latest: null, run: null }
    let run = bucket.latest?.promptId == null ? null : (bucket.runs.get(bucket.latest.promptId) ?? null)
    if (run === null && bucket.hostLatest !== null) run = bucket.hostRuns.get(bucket.hostLatest) ?? null
    return { latest: bucket.latest, run }
  }

  /**
   * @param {string} sessionId - the session to read.
   * @param {string} promptId - the run to look up.
   * @returns {RunRecord | null} that run, when the panel or the Host reported one.
   */
  function runFor(sessionId, promptId) {
    const bucket = progress.get(sessionId)
    if (bucket === undefined) return null
    return bucket.runs.get(promptId) ?? bucket.hostRuns.get(promptId) ?? null
  }

  /**
   * The seed walk this session's runs continue from.
   *
   * Returned as a copy: a prompt ComfyUI rejects must not advance the walk, so
   * the run commits it only after the queue accepts the prompt.
   * @param {string} sessionId - the session whose walk to read.
   * @returns {SeedCursor} a copy of the per-node cursors.
   */
  function seedCursor(sessionId) {
    const existing = seedCursors.get(sessionId)
    return new Map(existing ?? [])
  }

  /**
   * @param {string} sessionId - the session whose walk advanced.
   * @param {SeedCursor} cursor - the cursor the accepted run produced.
   */
  function commitSeedCursor(sessionId, cursor) {
    seedCursors.set(sessionId, cursor)
  }

  /**
   * Remember how to dispose the tools and digest registered on this session's
   * agent.
   * @param {string} sessionId - the session the tools belong to.
   * @param {() => void} dispose - the disposer that unregisters them.
   */
  function trackTools(sessionId, dispose) {
    sessionTools.set(sessionId, dispose)
  }

  /**
   * @param {string} sessionId - the session to ask about.
   * @returns {boolean} whether tools are already registered for it.
   */
  function hasTools(sessionId) {
    return sessionTools.has(sessionId)
  }

  /**
   * Forget everything the Host holds for a session.
   *
   * DSH disposes an agent on clear and compaction too, and the same session id
   * comes back with a fresh agent. The canvas survives in `sessions` (and in
   * storage) so the restored workflow is still readable, but the run record,
   * the seed walk, the tool registration and whatever the old panel was
   * holding must not outlive the agent that owned them.
   *
   * The disposers themselves are not called here: the agent's own context tears
   * its registrations down, and calling them twice would unregister a fresh
   * agent's tools.
   *
   * @param {string} sessionId - the session whose agent was disposed.
   */
  function release(sessionId) {
    sessionTools.delete(sessionId)
    progress.delete(sessionId)
    seedCursors.delete(sessionId)
    releaseCommands(sessionId)
  }

  /** Drop the debounce timers and unregister every tool set the Host still owns. */
  function close() {
    for (const timer of persistTimers.values()) clearTimeout(timer)
    persistTimers.clear()
    for (const dispose of sessionTools.values()) dispose()
    sessionTools.clear()
  }

  return {
    get,
    restore,
    sync,
    rename,
    recordEvent,
    mergeRun,
    latestRun,
    runFor,
    seedCursor,
    commitSeedCursor,
    trackTools,
    hasTools,
    release,
    close,
  }
}

/**
 * Validate a workflow name without throwing.
 *
 * The bridge accepts one from the panel on every sync, where an unusable value
 * is a client bug rather than a tool-call error, so the check is shared with
 * the saved-workflow tools instead of duplicated.
 * @param {unknown} value - the requested name.
 * @returns {string | null} the trimmed name, or null when it is not usable.
 */
export function validWorkflowName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length === 0 || name.length > 80) return null
  if (/[\u0000-\u001f\u007f]/u.test(name)) return null
  return name
}

/** A ComfyUI socket id (hex uuid, or the panel's own), when it looks like one. */
function sanitizeClientId(value) {
  return typeof value === 'string' && /^[0-9a-z]{8,64}$/i.test(value) ? value : null
}

/**
 * Reduce the panel's tab list to the fields the Host reads.
 *
 * The list is page state, not graph content: a malformed entry is dropped
 * rather than failing the sync, because losing a tab listing must never cost
 * the workflow beside it. At most 64 tabs survive, which is far past what a
 * person opens and short enough to stay out of a status reply's way.
 * @param {unknown} value - the `tabs` field a panel sent.
 * @returns {TabRecord[]} the usable tabs, in the order they arrived.
 */
export function sanitizeTabs(value) {
  if (!Array.isArray(value)) return []
  const tabs = []
  for (const entry of value.slice(0, 64)) {
    if (!isObject(entry)) continue
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (path.length === 0 || path.length > 200) continue
    const name = validWorkflowName(entry.name) ?? null
    tabs.push({
      name,
      path,
      temporary: entry.temporary === true,
      modified: entry.modified === true,
      active: entry.active === true,
    })
  }
  return tabs
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
