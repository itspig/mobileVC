import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { __test } from '../plugin/index.mjs'

const { decodeSessionLog, scanZstdFrames, isIgnoredSystemPrompt, inspectToBlocks, eventPatch, isSafeSessionId, removeEmptySession } = __test

// --- helpers: build a real concatenated-Zstandard log the way DSH writes it ---
// DSH stores one checksummed frame for the header then one frame per batch.
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
}
function multiFrame(lines) {
  return Buffer.concat(lines.map((l) => frame(l + '\n')))
}

const header = JSON.stringify({
  type: 'session', version: 4, id: 'session-abc', createdAt: 1000,
  cwd: '/root/Local/Chats', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
})
const ev = (type, seq, data) => JSON.stringify({ type, seq, time: 1000 + seq, data })

// ---------------------------------------------------------------------------
// The regression this suite was born from: session.v4.jsonl.zstd is a
// *concatenation* of independent zstd frames. node:zlib's one-shot
// zstdDecompressSync decodes only the FIRST frame, so the naive reader returned
// just the `session` header and zero real events.
// ---------------------------------------------------------------------------

test('scanZstdFrames finds every frame in a concatenated stream', () => {
  const buf = multiFrame([header, ev('turn/start', 0, { turn: 1 }), ev('turn/end', 1, { reason: { kind: 'done' } })])
  const scan = scanZstdFrames(buf)
  assert.equal(scan.frames.length, 3)
  assert.equal(scan.tornStart, undefined)
  // ranges are contiguous and cover the whole buffer
  assert.equal(scan.frames[0].start, 0)
  assert.equal(scan.frames[scan.frames.length - 1].end, buf.length)
})

test('decodeSessionLog decodes ALL concatenated frames, not just the first', () => {
  const lines = [
    header,
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }),
    ev('assistant/message', 3, { message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
    ev('turn/end', 4, { reason: { kind: 'done' } }),
  ]
  const { meta, events } = decodeSessionLog(multiFrame(lines))
  assert.equal(meta.id, 'session-abc')
  assert.equal(meta.cwd, '/root/Local/Chats')
  assert.equal(events.length, 4, 'all 4 non-header events must survive across frames')
  assert.deepEqual(events.map((e) => e.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end'])
})

test('decodeSessionLog handles a single-frame log and an empty buffer', () => {
  const single = zlib.zstdCompressSync(
    Buffer.from([header, ev('turn/start', 0, { turn: 1 })].join('\n') + '\n', 'utf8'),
    { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } },
  )
  assert.equal(decodeSessionLog(single).events.length, 1)
  assert.deepEqual(decodeSessionLog(Buffer.alloc(0)), { meta: {}, events: [] })
})

test('decodeSessionLog keeps complete frames and drops a torn trailing frame', () => {
  const good = multiFrame([header, ev('turn/start', 0, { turn: 1 })])
  const torn = frame(ev('user/message', 1, { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })).subarray(0, 10)
  const { events } = decodeSessionLog(Buffer.concat([good, torn]))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'turn/start')
})

// ---------------------------------------------------------------------------
// Filtering harness scaffolding out of the transcript.
// ---------------------------------------------------------------------------
test('isIgnoredSystemPrompt filters scaffolding but keeps real content', () => {
  assert.equal(isIgnoredSystemPrompt('<system-reminder>\nfoo\n</system-reminder>', 'user'), true)
  assert.equal(isIgnoredSystemPrompt('Time sampled while preparing turn 1', 'user'), true)
  assert.equal(isIgnoredSystemPrompt('random agent notes', 'runtime-context'), true)
  assert.equal(isIgnoredSystemPrompt('AGENTS workspace preamble', 'agent-instructions'), true)
  assert.equal(isIgnoredSystemPrompt('hello world', 'user'), false)
  assert.equal(isIgnoredSystemPrompt('', 'user'), true)
})

test('eventPatch drops ignored non-human system prompts but keeps real notifications', () => {
  const ignored = eventPatch({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }], source: { kind: 'runtime-context' } },
  })
  assert.equal(ignored, null)

  const kept = eventPatch({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '后台任务完成' }], source: { kind: 'tool-jobs' } },
  })
  assert.equal(kept.blocks[0].type, 'system')
})

// ---------------------------------------------------------------------------
// End-to-end: a disk-decoded inspection must reconstruct id/cwd/counts.
// ---------------------------------------------------------------------------
test('inspectToBlocks reconstructs meta + counts from a disk-decoded inspection', () => {
  const lines = [
    header,
    ev('user/message', 1, { content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } }),
    ev('assistant/message', 2, { message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } }),
  ]
  const { meta, events } = decodeSessionLog(multiFrame(lines))
  const detail = inspectToBlocks({ meta, events })
  assert.equal(detail.id, 'session-abc')
  assert.equal(detail.cwd, '/root/Local/Chats')
  assert.equal(detail.userCount, 1)
  assert.equal(detail.assistantCount, 1)
})

// ---------------------------------------------------------------------------
// Security & session ID validation: prevent traversal and handle UUIDs.
// ---------------------------------------------------------------------------
test("isSafeSessionId validates session IDs correctly", () => {
  assert.equal(isSafeSessionId("session-abc-123"), true)
  assert.equal(isSafeSessionId("1f72282d-41a0-4763-bbef-4794be8a0cd8"), true)
  assert.equal(isSafeSessionId("bc5f6771-b3b2-4137-9c02-c98ce971b5bc"), true)

  // Directory traversal attacks
  assert.equal(isSafeSessionId("../session-abc"), false)
  assert.equal(isSafeSessionId("session-abc/../../etc/passwd"), false)
  assert.equal(isSafeSessionId("..\\session-abc"), false)
  assert.equal(isSafeSessionId("session-abc\0bad"), false)

  // Empty or invalid types
  assert.equal(isSafeSessionId(""), false)
  assert.equal(isSafeSessionId(null), false)
  assert.equal(isSafeSessionId(12345), false)
  assert.equal(isSafeSessionId("arbitrary-bad-name"), false)
})

test("removeEmptySession safely rejects invalid or traversal IDs", async () => {
  assert.equal(await removeEmptySession("../etc/passwd"), false)
  assert.equal(await removeEmptySession(""), false)
  assert.equal(await removeEmptySession(null), false)
  assert.equal(await removeEmptySession("nonexistent-dir"), false)
})
