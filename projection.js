/**
 * Semantic projection of a ComfyUI UI workflow.
 *
 * The raw UI workflow is a serialization format: widget values are positional
 * arrays, links are numeric rows, and nothing names an input's source. The
 * panel therefore sends a projection built from the live LiteGraph nodes, where
 * widget names, input names, and link endpoints are known. This module is the
 * Host-side contract for that payload plus a best-effort projection from the
 * raw workflow when an older panel did not send one.
 *
 * Two invariants keep the projection cheap for a model to read:
 *  - every value is JSON-safe, deduplicated, and bounded;
 *  - an input is written as `"<sourceNodeId>:<sourceSlot>"`, which is exactly
 *    the pair `comfyui_edit`'s `connect.from` expects.
 */

const MAX_NODES = 600
const MAX_ENTRIES = 64
const MAX_STRING = 240
const MAX_DEPTH = 2

/** Bound one arbitrary widget value to JSON-safe data. */
export function projectValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map(item => projectValue(item, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      if (key === '__proto__') continue
      out[key] = projectValue(item, depth + 1)
    }
    return out
  }
  return String(value)
}

/** Accept a widget map from the panel, dropping prototype keys and non-data values. */
function projectWidgets(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [name, value] of Object.entries(raw).slice(0, MAX_ENTRIES)) {
    if (typeof name !== 'string' || name.length === 0 || name === '__proto__') continue
    if (value === undefined) continue
    out[name.slice(0, 120)] = projectValue(value)
  }
  return out
}

/** Accept the `name -> "id:slot"` input map, keeping only well-formed references. */
function projectInputs(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [name, source] of Object.entries(raw).slice(0, MAX_ENTRIES)) {
    if (typeof name !== 'string' || typeof source !== 'string') continue
    if (name === '__proto__') continue
    if (!/^\d+:\d+$/.test(source)) continue
    out[name.slice(0, 120)] = source
  }
  return out
}

/**
 * Validate and bound a projection produced by the panel.
 * @param raw - the `semantic` field of a `/api/comfyui/state` body.
 * @returns the projection, or null when the payload is not a projection.
 */
export function sanitizeSemantic(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Array.isArray(raw.nodes)) return null
  const nodes = []
  for (const node of raw.nodes.slice(0, MAX_NODES)) {
    if (node === null || typeof node !== 'object') continue
    if (!Number.isInteger(node.id) || typeof node.type !== 'string') continue
    const projected = {
      id: node.id,
      type: node.type.slice(0, 120),
      widgets: projectWidgets(node.widgets),
      inputs: projectInputs(node.inputs),
    }
    if (typeof node.title === 'string' && node.title.length > 0 && node.title !== node.type) {
      projected.title = node.title.slice(0, 120)
    }
    if (node.mode === 'mute' || node.mode === 'bypass') projected.mode = node.mode
    nodes.push(projected)
  }
  nodes.sort((left, right) => left.id - right.id)
  return {
    nodes,
    linkCount: Number.isInteger(raw.linkCount) ? raw.linkCount : null,
    selection: Array.isArray(raw.selection)
      ? [...new Set(raw.selection.filter(Number.isInteger))].slice(0, 64)
      : [],
  }
}

/**
 * Project the raw UI workflow when no live projection is available (an older
 * panel, or a record persisted before projections existed). Widgets are
 * positional arrays here because only the editor knows their names.
 * @param workflow - the UI workflow JSON.
 * @returns a projection with `projectedFrom: 'workflow'`.
 */
export function projectFromWorkflow(workflow) {
  const sourceNodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const rows = Array.isArray(workflow?.links) ? workflow.links : []
  const links = new Map()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue
    links.set(row[0], { originId: row[1], originSlot: row[2] })
  }
  const nodes = []
  for (const node of sourceNodes.slice(0, MAX_NODES)) {
    if (node === null || typeof node !== 'object') continue
    if (!Number.isInteger(node.id) || typeof node.type !== 'string') continue
    const inputs = {}
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (input === null || typeof input !== 'object' || input.link === null || input.link === undefined) continue
      const link = links.get(input.link)
      if (link === undefined || input.name === '__proto__') continue
      inputs[String(input.name)] = `${link.originId}:${link.originSlot}`
    }
    const projected = { id: node.id, type: node.type.slice(0, 120) }
    if (typeof node.title === 'string' && node.title.length > 0 && node.title !== node.type) {
      projected.title = node.title.slice(0, 120)
    }
    if (Array.isArray(node.widgets_values)) projected.widgetsValues = projectValue(node.widgets_values)
    projected.widgets = {}
    projected.inputs = inputs
    nodes.push(projected)
  }
  nodes.sort((left, right) => left.id - right.id)
  return { nodes, linkCount: rows.length, selection: [] }
}

/**
 * The one-line runtime-context digest for a session desktop.
 * @param state - the session's stored state.
 * @param options.connected - whether the panel polled recently.
 * @param options.run - the latest run record, if any.
 * @param options.revision - the revision shown to the model, when it differs.
 * @returns one short line, or '' when there is nothing to say.
 */
export function digestLine(state, { connected = false, run = null } = {}) {
  if (state === undefined || state === null) return ''
  const parts = [
    `rev ${state.revision}`,
    `${state.nodes} node${state.nodes === 1 ? '' : 's'}`,
    `${state.links} link${state.links === 1 ? '' : 's'}`,
  ]
  const selection = state.semantic?.selection ?? []
  if (selection.length > 0) parts.push(`selected ${selection.slice(0, 8).join(', ')}`)
  if (run?.status === 'running') {
    const progress = run.max > 0 ? ` ${run.value ?? '?'}/${run.max}` : ''
    parts.push(`running${progress}`)
  } else if (run?.status === 'queued') {
    parts.push('queued')
  } else if (run?.status === 'error') {
    parts.push('last run failed')
  }
  parts.push(connected ? 'panel open' : 'panel closed')
  return `ComfyUI: ${parts.join(' · ')}.`
}
