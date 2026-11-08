/**
 * One session's stored workflow, through `createSessionStore`. The command
 * channel is the real one: release has to drop a parked edit, and a fake
 * would only restate the callback.
 */
import assert from 'node:assert/strict'
import { createCommandChannel } from '../commands.js'
import { createSessionStore } from '../session-store.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

{
  const written = []
  const channels = createCommandChannel()
  const store = createSessionStore({
    logger: { warn() {} },
    releaseCommands: sessionId => channels.release(sessionId),
    persist: (sessionId, state) => { written.push({ sessionId, revision: state.revision }) },
  })
  const graph = { nodes: [{ id: 1, type: 'KSampler' }], links: [] }
  assert.equal(store.get('s-store'), undefined, 'an unknown session has no record')
  const synced = store.sync('s-store', {
    revision: 3,
    name: 'lifecycle',
    workflow: { ...graph, extra: { ds: { scale: 0.5, offset: [12, 34] } } },
    prompt: { 1: { class_type: 'KSampler', inputs: {} } },
    semantic: { nodes: [], linkCount: 0, selection: [] },
    clientId: '0f3c2b1a9d8e7f60',
  })
  assert.equal(synced.ok, true)
  const state = store.get('s-store')
  assert.equal(state.revision, 3)
  assert.equal(state.name, 'lifecycle')
  assert.equal(state.clientId, '0f3c2b1a9d8e7f60')
  assert.equal('ds' in (state.workflow.extra ?? {}), false, 'view state is stripped before the comparison')
  assert.equal(state.semantic, null, 'an empty projection over a non-empty graph is dropped')
  assert.equal(written.length, 0, 'persistence is debounced, not immediate')
  const resync = { revision: 9, workflow: graph, prompt: { 1: { class_type: 'KSampler', inputs: {} } }, semantic: { nodes: [], linkCount: 0, selection: [] } }
  const idle = store.sync('s-store', resync)
  assert.equal(idle.ok && idle.state.revision, 3, 'an idle re-sync keeps the revision')
  const grew = store.sync('s-store', { revision: 9, workflow: { nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'UNETLoader' }], links: [] } })
  assert.equal(grew.ok && grew.state.revision, 9, 'an edit moves the revision forward')
  store.rename('s-store', 'renamed')
  assert.equal(store.get('s-store').name, 'renamed')
  assert.equal(store.get('s-store').revision, 9, 'the name is metadata, not a graph edit')
  assert.deepEqual(store.sync('s-store', { workflow: null }), { ok: false, error: 'workflow must be an object' })
  assert.deepEqual(
    store.sync('s-store', { workflow: { nodes: [] }, name: '' }),
    { ok: false, error: 'name must be 1-80 characters without control characters' },
  )
  assert.equal(store.get('s-store').name, 'renamed', 'a refused sync does not consume the name')

  store.recordEvent('s-store', {
    kind: 'execution_start', promptId: 'p7', node: null, value: null, max: null, queueRemaining: null, error: null, at: Date.now(),
  })
  assert.equal(store.latestRun('s-store').run.status, 'running')
  assert.equal(store.runFor('s-store', 'p7').status, 'running')
  assert.equal(store.runFor('s-store', 'p-missing'), null)
  store.mergeRun('s-store', {
    promptId: 'p-host', status: 'queued', startedAt: null, updatedAt: Date.now(), node: null, value: null, max: null, error: null, outputs: null,
  })
  assert.equal(store.latestRun('s-store').run.promptId, 'p7', 'a panel-reported run stays the visible one')
  assert.equal(store.runFor('s-store', 'p-host').status, 'queued')
  store.mergeRun('s-store', {
    promptId: 'p-host', status: 'completed', startedAt: null, updatedAt: Date.now(), node: null, value: null, max: null, error: null, outputs: { 7: { images: [{ filename: 'p-host.png' }] } },
  })
  assert.equal(store.latestRun('s-store').run.promptId, 'p7')
  assert.equal(store.runFor('s-store', 'p-host').outputs[7].images[0].filename, 'p-host.png')
  assert.equal(store.runFor('s-store', 'p7').outputs, undefined, 'a panel run is not given host outputs')
  const cursor = store.seedCursor('s-store')
  cursor.set('8', { from: 5, used: 6 })
  store.commitSeedCursor('s-store', cursor)
  assert.equal(store.seedCursor('s-store').get('8').used, 6)
  store.trackTools('s-store', () => {})
  assert.equal(store.hasTools('s-store'), true)

  const parked = channels.ask('s-store', { id: 'cmd-1', operations: [] }, { timeoutMs: 5000, what: 'edit' })
  assert.equal((await channels.poll('s-store', { timeoutMs: 1000 })).body.command.id, 'cmd-1')
  store.release('s-store')
  await assert.rejects(parked, /session closed/)
  assert.ok(store.get('s-store'), 'the canvas survives: a resumed agent still reads it')
  assert.equal(store.latestRun('s-store').run, null, 'the run record goes with the agent')
  assert.equal(store.runFor('s-store', 'p-host'), null, 'a tracked run goes with the agent too')
  assert.equal(store.seedCursor('s-store').size, 0, 'the seed walk goes with the agent')
  assert.equal(store.hasTools('s-store'), false)
  assert.equal(channels.connected('s-store'), false)

  await delay(1600)
  assert.deepEqual(written.at(-1), { sessionId: 's-store', revision: 9 }, 'the debounced write carries the latest revision')
  store.close()
}

{
  const store = createSessionStore({
    logger: { warn() {} },
    releaseCommands: () => {},
    persist: () => {},
  })
  const graph = { nodes: [{ id: 1, type: 'KSampler' }], links: [] }
  store.sync('s-file', { revision: 1, file: 'emoji', workflow: graph })
  assert.equal(store.get('s-file').name, 'emoji')
  assert.equal(store.get('s-file').nameSource, 'file')
  store.sync('s-file', { revision: 2, file: null, workflow: { nodes: [{ id: 2, type: 'UNETLoader' }], links: [] } })
  assert.equal(store.get('s-file').name, null, 'the name goes when the editor holds no file')
  store.sync('s-file', { revision: 3, file: null, workflow: graph })
  store.rename('s-file', 'slot')
  store.sync('s-file', { revision: 4, file: null, workflow: graph })
  assert.equal(store.get('s-file').name, 'slot', 'a name a tool gave the canvas survives a file-less editor')
  assert.equal(store.get('s-file').nameSource, 'tool')
  assert.deepEqual(
    store.sync('s-file', { workflow: graph, file: '' }),
    { ok: false, error: 'file must be 1-80 characters without control characters' },
  )
  store.close()
}

console.log('session store test passed')
