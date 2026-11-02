/**
 * Durable ComfyUI workflows over the Host's domain KV store.
 *
 * Two kinds live side by side: the latest workflow mirrored for each session
 * (restored on Host restart, so tools work with the panel closed) and the named
 * workflows the user saved explicitly (`comfyui_workflow_save`).
 *
 * A profile-installed bundle has no package dependencies, so the domain spec
 * is a plain object rather than a `defineDomain()` result. The storage layer
 * only calls `parse()` on a record schema, so this module supplies a real
 * shape check with a zod-compatible surface instead of importing zod.
 *
 * The store never gates the bridge on durability: writes that arrive before
 * the domain finishes opening are buffered per session and flushed on open.
 * When the domain is unavailable the store reports `memory` and the bridge
 * keeps working exactly as before.
 */

const TABLE = 'sessions'
const WORKFLOWS_TABLE = 'workflows'
const SETTINGS_TABLE = 'settings'
const SETTINGS_KEY = 'service'
const DOMAIN = 'dsh_comfyui'
const MAX_RECORDS = 20
const MAX_PENDING = 20

function invalid(message) {
  throw new TypeError(`dsh-comfyui: ${message}`)
}

/** Validate one persisted workflow record. */
function parseRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('workflow record must be an object')
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 200) {
    invalid('workflow record needs a sessionId')
  }
  // Optional: records written before 0.7.1 have no name, and an unnamed canvas
  // is a real state, so absence and null both mean "no name".
  if (value.name !== undefined && value.name !== null
    && (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80)) {
    invalid('workflow record name must be 1-80 characters')
  }
  // Optional: how the name was attached. 'file' is a name the editor reported
  // for a workflow file; 'tool' is a name a workflow tool gave the canvas. A
  // record without it predates the distinction and is never cleared by a sync.
  if (value.nameSource !== undefined && value.nameSource !== null
    && value.nameSource !== 'file' && value.nameSource !== 'tool') {
    invalid('workflow record nameSource must be "file" or "tool"')
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) invalid('workflow record needs a non-negative revision')
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) invalid('workflow record needs an updatedAt')
  if (value.workflow === null || typeof value.workflow !== 'object' || Array.isArray(value.workflow)) {
    invalid('workflow record needs a workflow object')
  }
  if (value.prompt !== null && (typeof value.prompt !== 'object' || Array.isArray(value.prompt))) {
    invalid('workflow record prompt must be an object or null')
  }
  if (value.semantic !== null && (typeof value.semantic !== 'object' || Array.isArray(value.semantic))) {
    invalid('workflow record semantic must be an object or null')
  }
  return value
}

/** Validate one explicitly saved workflow record. */
function parseNamedWorkflow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('saved workflow must be an object')
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80) {
    invalid('saved workflow needs a name of 1-80 characters')
  }
  if (value.workflow === null || typeof value.workflow !== 'object' || Array.isArray(value.workflow)) {
    invalid('saved workflow needs a workflow object')
  }
  for (const field of ['revision', 'nodes', 'links']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) invalid(`saved workflow needs a non-negative ${field}`)
  }
  if (typeof value.sourceSessionId !== 'string' || value.sourceSessionId.length === 0) {
    invalid('saved workflow needs a sourceSessionId')
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) invalid(`saved workflow needs a ${field}`)
  }
  return value
}

/** Validate the panel-managed service settings record. */
function parseSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('service settings must be an object')
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) invalid('service settings need a cwd')
  if (typeof value.autoStart !== 'boolean') invalid('service settings need an autoStart flag')
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) invalid('service settings need an updatedAt')
  return value
}

/** The domain declaration; `parse` is the only schema method the domain layer uses at open. */
export const WORKFLOW_DOMAIN = {
  name: DOMAIN,
  version: 1,
  tables: {
    [TABLE]: { valueSchema: { parse: parseRecord } },
    [WORKFLOWS_TABLE]: { valueSchema: { parse: parseNamedWorkflow } },
    [SETTINGS_TABLE]: { valueSchema: { parse: parseSettings } },
  },
}

/**
 * Resolve the mounted domain facility. When the storage rows load after this
 * plugin, wait for the service through a one-shot `ctx.inject` instead of
 * silently degrading to memory for the whole process lifetime.
 */
function resolveFacility(ctx) {
  try {
    const current = ctx.get('storageDomain')
    if (current !== undefined && current !== null) return Promise.resolve(current)
  } catch {
    // Fall through to the dependency wait.
  }
  if (typeof ctx.inject !== 'function') return Promise.resolve(undefined)
  return new Promise(resolve => {
    let settled = false
    ctx.inject(['storageDomain'], scoped => {
      if (settled) return
      settled = true
      resolve(scoped.storageDomain)
    })
  })
}

/**
 * Open the workflow store and load its records.
 * @param ctx - the plugin context; `storageDomain` is resolved lazily.
 * @param logger - host logger for degraded-mode warnings.
 * @returns a store handle whose `backend` is `storage` or `memory`.
 */
export function createWorkflowStore(ctx, logger) {
  /** sessionId -> record written before the domain finished opening. */
  const pending = new Map()
  /** workflow name -> record written before the domain finished opening. */
  const pendingWorkflows = new Map()
  /** Service settings written before the domain finished opening. */
  let pendingSettings = null
  let domain = null
  let backend = 'memory'
  let reason = 'storageDomain is not mounted'

  const ready = resolveFacility(ctx).then(async facility => {
    if (facility === undefined || facility === null) return { sessions: [], settings: null }
    try {
      const opened = await facility.open(WORKFLOW_DOMAIN)
      domain = opened
      backend = 'storage'
      reason = null
      for (const [sessionId, record] of pending) {
        await opened.table(TABLE).put(sessionId, record).catch(error => {
          logger?.warn(`dsh-comfyui: could not persist workflow for ${sessionId}: ${String(error)}`)
        })
      }
      pending.clear()
      for (const [name, record] of pendingWorkflows) {
        await opened.table(WORKFLOWS_TABLE).put(name, record).catch(error => {
          logger?.warn(`dsh-comfyui: could not persist saved workflow "${name}": ${String(error)}`)
        })
      }
      pendingWorkflows.clear()
      if (pendingSettings !== null) {
        await opened.table(SETTINGS_TABLE).put(SETTINGS_KEY, pendingSettings).catch(error => {
          logger?.warn(`dsh-comfyui: could not persist service settings: ${String(error)}`)
        })
        pendingSettings = null
      }
      return {
        sessions: [...opened.table(TABLE).entries()].map(([, record]) => record),
        settings: opened.table(SETTINGS_TABLE).get(SETTINGS_KEY) ?? null,
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      logger?.warn(`dsh-comfyui: workflow persistence is off (${reason}); keeping workflows in memory`)
      return { sessions: [], settings: null }
    }
  })

  return {
    ready,
    /** Whether writes survive a Host restart. */
    get backend() { return backend },
    /** Why persistence is off, when it is. */
    get reason() { return reason },
    /**
     * Persist one session record. Buffered while the domain opens, and pruned
     * to the most recently updated sessions so the unit stays small.
     */
    async save(record) {
      if (domain === null) {
        pending.set(record.sessionId, record)
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value)
        return
      }
      const table = domain.table(TABLE)
      await table.put(record.sessionId, record)
      while (table.size > MAX_RECORDS) {
        let oldestKey = null
        let oldestAt = Infinity
        for (const [key, entry] of table.entries()) {
          if (entry.updatedAt < oldestAt) {
            oldestAt = entry.updatedAt
            oldestKey = key
          }
        }
        if (oldestKey === null) break
        await table.delete(oldestKey)
      }
    },
    /** Store the panel-managed service settings; buffered like workflow writes. */
    async saveSettings(record) {
      if (domain === null) {
        pendingSettings = record
        return
      }
      await domain.table(SETTINGS_TABLE).put(SETTINGS_KEY, record)
    },
    /** Store one explicitly saved workflow under its name, replacing that slot. */
    async saveWorkflow(record) {
      if (domain === null) {
        pendingWorkflows.set(record.name, record)
        return
      }
      await domain.table(WORKFLOWS_TABLE).put(record.name, record)
    },
    /**
     * Read one saved workflow.
     * @param {string} name - the slot name.
     * @returns {Promise<any | null>} the record, or null when the slot is empty.
     */
    async workflow(name) {
      const buffered = pendingWorkflows.get(name)
      if (buffered !== undefined) return buffered
      await ready
      if (domain === null) return null
      return (await domain.table(WORKFLOWS_TABLE).get(name)) ?? null
    },
    /**
     * List every saved workflow, most recently written first.
     * @returns {Promise<any[]>} the records; callers project the bounded fields.
     */
    async workflows() {
      await ready
      const found = domain === null
        ? []
        : [...domain.table(WORKFLOWS_TABLE).entries()].map(([, record]) => record)
      const byName = new Map(found.map(record => [record.name, record]))
      for (const [name, record] of pendingWorkflows) byName.set(name, record)
      return [...byName.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    },
    /** Close the domain handle; further saves fall back to memory. */
    async close() {
      if (domain === null) return
      const closing = domain
      domain = null
      backend = 'memory'
      await closing.close().catch(() => {})
    },
  }
}
