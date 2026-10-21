/**
 * Durable session workflows over the Host's domain KV store.
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

/** The domain declaration; `parse` is the only schema method the domain layer uses at open. */
export const WORKFLOW_DOMAIN = {
  name: DOMAIN,
  version: 1,
  tables: { [TABLE]: { valueSchema: { parse: parseRecord } } },
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
  let domain = null
  let backend = 'memory'
  let reason = 'storageDomain is not mounted'

  const ready = resolveFacility(ctx).then(async facility => {
    if (facility === undefined || facility === null) return []
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
      return [...opened.table(TABLE).entries()].map(([, record]) => record)
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      logger?.warn(`dsh-comfyui: workflow persistence is off (${reason}); keeping workflows in memory`)
      return []
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
