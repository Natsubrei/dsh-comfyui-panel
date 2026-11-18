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
    { id: '3', role: 'tool', name: 'comfyui_edit', text: 'comfyui_edit', status: 'running' },
    { id: '4', role: 'assistant', text: 'Done.' },
  ])
  assert.deepEqual(transcriptRows([]), [])
  assert.deepEqual(transcriptRows([{ type: 'event', event: { type: 'step/start', seq: 1, data: {} } }]), [])
}


{
  // A call and its result are one card: the result paints onto the row the
  // call opened, so a finished edit reads as one line, not two.
  const records = [
    { type: 'event', event: { type: 'tool/call', seq: 5, time: 1000, data: {
      callId: 'call-1', name: 'comfyui_run', arguments: '{"wait":true}',
    } } },
    { type: 'event', event: { type: 'tool/result', seq: 6, time: 2600, data: {
      toolCallId: 'call-1', isError: false,
      message: { role: 'tool', content: [{ type: 'text', text: 'prompt_id p1' }] },
    } } },
  ]
  assert.deepEqual(transcriptRows(records), [{
    id: '5', role: 'tool', name: 'comfyui_run', text: 'comfyui_run',
    status: 'done', at: 1000, args: '{"wait":true}', result: 'prompt_id p1', durationMs: 1600,
  }])
}

{
  // A failed call says so, and an empty argument payload is dropped rather
  // than shown as "{}".
  const records = [
    { type: 'event', event: { type: 'tool/call', seq: 7, data: { callId: 'c2', name: 'comfyui_edit', arguments: '{}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 8, data: {
      toolCallId: 'c2', isError: true, message: { content: [{ type: 'text', text: 'node 9 not found' }] } } } },
  ]
  const [row] = transcriptRows(records)
  assert.equal(row.status, 'error')
  assert.equal(row.result, 'node 9 not found')
  assert.equal(row.args, undefined)
}

{
  // Time and output tokens ride along with a reply, and the window keeps the
  // newest turns only.
  const assistant = { type: 'event', event: { type: 'assistant/message', seq: 9, time: 1700, data: {
    message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Done.' }] },
    usage: { outputTokens: 42 },
  } } }
  assert.deepEqual(transcriptRows([assistant]), [{ id: '9', role: 'assistant', text: 'Done.', at: 1700, tokens: 42 }])
  const many = Array.from({ length: 45 }, (_, index) => ({
    type: 'event',
    event: { type: 'user/message', seq: index + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'm' + (index + 1) }] } },
  }))
  const trimmed = transcriptRows(many)
  assert.equal(trimmed.length, 40)
  assert.equal(trimmed[0].id, '6')
  assert.equal(trimmed.at(-1).id, '45')
}
console.log('desk test passed')
