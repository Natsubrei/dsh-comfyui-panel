/**
 * The command channel, through its own interface. No Host and no panel.
 */
import assert from 'node:assert/strict'
import { createCommandChannel, takeCommand } from '../commands.js'

{
  const now = Date.now()
  const queue = [{ id: 'stale', at: now - 120_000 }, { id: 'fresh', at: now - 5_000 }]
  assert.equal(takeCommand(queue, now).id, 'fresh', 'the expired command is skipped, not returned after it')
  assert.equal(queue.length, 0, 'skipping discards it: a later poll must not revive it')
  assert.equal(takeCommand([{ id: 'stale', at: now - 61_000 }], now), null)
  assert.equal(takeCommand([], now), null)
}

{
  const channels = createCommandChannel()
  const operations = [{ op: 'remove_node', id: 1 }]
  const awaited = channels.ask('s-cmd', { id: 'cmd-2', operations }, { timeoutMs: 5000, what: 'edit' })
  const polled = await channels.poll('s-cmd', { timeoutMs: 1000 })
  assert.equal(polled.status, 200)
  assert.deepEqual(polled.body.command, { id: 'cmd-2', operations })
  assert.equal(channels.connected('s-cmd'), true)
  assert.equal(channels.answer('cmd-2', { ok: true, value: { nodes: 2, links: 1 } }), true)
  assert.deepEqual(await awaited, { ok: true, value: { nodes: 2, links: 1 }, error: null })
  assert.equal(channels.answer('cmd-2', { ok: true }), false, 'a command is answered once')

  const expired = channels.ask('s-cmd', { id: 'cmd-3', at: Date.now() }, { timeoutMs: 20, what: 'screenshot' })
  await assert.rejects(expired, /did not answer the screenshot in time/)
  assert.equal(
    (await channels.poll('s-cmd', { timeoutMs: 1000 })).body.command,
    null,
    'an expired command is never handed to a later poll',
  )

  const waiting = channels.poll('s-gone', { timeoutMs: 5000 })
  channels.release('s-gone')
  assert.deepEqual(await waiting, { body: { ok: true, command: null }, status: 200 })
  assert.equal(channels.connected('s-gone'), false)
}

{
  const channels = createCommandChannel()
  const controller = new AbortController()
  controller.abort()
  const dead = await channels.poll('s-abort', { timeoutMs: 5000, signal: controller.signal })
  assert.equal(dead.status, 499)
  const awaited = channels.ask('s-abort', { id: 'cmd-live', operations: [] }, { timeoutMs: 5000, what: 'edit' })
  const polled = await channels.poll('s-abort', { timeoutMs: 1000 })
  assert.equal(polled.body.command?.id, 'cmd-live', 'an already-aborted poll must not take the next command')
  assert.equal(channels.answer('cmd-live', { ok: true, value: { applied: 1 } }), true)
  await awaited
}

{
  const channels = createCommandChannel()
  const awaited = channels.ask('s-queued', { id: 'cmd-queued', operations: [] }, { timeoutMs: 5000, what: 'edit' })
  const controller = new AbortController()
  controller.abort()
  const dead = await channels.poll('s-queued', { timeoutMs: 1000, signal: controller.signal })
  assert.equal(dead.status, 499)
  assert.equal(dead.body.command, undefined, 'an aborted poll must not be handed a command that was already queued')
  const live = await channels.poll('s-queued', { timeoutMs: 1000 })
  assert.equal(live.body.command?.id, 'cmd-queued')
  assert.equal(channels.answer('cmd-queued', { ok: true, value: { applied: 1 } }), true)
  await awaited
}

console.log('commands test passed')
