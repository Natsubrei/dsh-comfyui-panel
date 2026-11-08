/**
 * The desk session seam. Creating a session, reusing it, and sending a line
 * into it are the whole interface. The Host services are fakes.
 */
import assert from 'node:assert/strict'
import { DeskSessionMissing, ensureDeskSession, sendDeskMessage, transcriptRows } from '../desk.js'

{
  const calls = []
  const id = await ensureDeskSession({
    read: async () => null,
    save: async sessionId => { calls.push(['save', sessionId]) },
    create: async () => { calls.push(['create']); return 'ses-1' },
    resume: async sessionId => { calls.push(['resume', sessionId]) },
  })
  assert.equal(id, 'ses-1')
  assert.deepEqual(calls, [
    ['create'],
    ['save', 'ses-1'],
    ['resume', 'ses-1'],
  ])
}

{
  const calls = []
  const id = await ensureDeskSession({
    read: async () => 'ses-kept',
    save: async sessionId => { calls.push(['save', sessionId]) },
    create: async () => { calls.push(['create']); return 'ses-new' },
    resume: async sessionId => { calls.push(['resume', sessionId]) },
  })
  assert.equal(id, 'ses-kept')
  assert.deepEqual(calls, [['resume', 'ses-kept']])
}

{
  const calls = []
  const id = await ensureDeskSession({
    read: async () => 'ses-gone',
    save: async sessionId => { calls.push(['save', sessionId]) },
    create: async () => { calls.push(['create']); return 'ses-2' },
    resume: async sessionId => {
      calls.push(['resume', sessionId])
      if (sessionId === 'ses-gone') throw new DeskSessionMissing()
    },
  })
  assert.equal(id, 'ses-2')
  assert.deepEqual(calls, [
    ['resume', 'ses-gone'],
    ['create'],
    ['save', 'ses-2'],
    ['resume', 'ses-2'],
  ])
}

{
  await assert.rejects(
    () => ensureDeskSession({
      read: async () => 'ses-busy',
      save: async () => { throw new Error('should not save') },
      create: async () => { throw new Error('should not create') },
      resume: async () => { throw new Error('the agent is busy') },
    }),
    /agent is busy/,
  )
}

{
  const sent = []
  const turn = await sendDeskMessage('  set steps to 20  ', {
    sessionId: async () => 'ses-1',
    prompt: async (sessionId, text) => { sent.push([sessionId, text]) },
  })
  assert.equal(turn.ok, true)
  assert.equal(turn.sessionId, 'ses-1')
  assert.deepEqual(sent, [['ses-1', 'set steps to 20']])
}

{
  const turn = await sendDeskMessage('   ', {
    sessionId: async () => 'ses-1',
    prompt: async () => { throw new Error('should not send') },
  })
  assert.equal(turn.ok, false)
  assert.equal(turn.status, 400)
}

{
  const turn = await sendDeskMessage('hello', {
    sessionId: async () => 'ses-1',
    prompt: async () => { throw new Error('the session is gone') },
  })
  assert.equal(turn.ok, false)
  assert.equal(turn.status, 502)
  assert.match(turn.error, /session is gone/)
}

{
  const records = [
    // The stored form: the user message is the event data itself.
    { type: 'event', event: { type: 'user/message', seq: 1, data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'set steps to 20' }],
    } } },
    // Injected context is not the human speaking.
    { type: 'event', event: { type: 'user/message', seq: 2, data: {
      role: 'user',
      source: { kind: 'agent' },
      content: [{ type: 'text', text: 'AGENTS.md contents' }],
    } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, data: { name: 'comfyui_edit', arguments: '{}' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 4, data: { message: {
      role: 'assistant',
      source: { kind: 'model' },
      content: [{ type: 'reasoning', text: 'skip me' }, { type: 'text', text: 'Done.' }],
    } } } },
  ]
  assert.deepEqual(transcriptRows(records), [
    { id: '1', role: 'user', text: 'set steps to 20' },
    { id: '3', role: 'tool', text: 'comfyui_edit' },
    { id: '4', role: 'assistant', text: 'Done.' },
  ])
  assert.deepEqual(transcriptRows([]), [])
  assert.deepEqual(transcriptRows([{ type: 'event', event: { type: 'step/start', seq: 1, data: {} } }]), [])
}

console.log('desk test passed')
