// Coverage for the durable-event -> patch translation that feeds the mobile
// timeline, plus the small formatters the mobile UI renders (tool args, times).
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../plugin/index.mjs'

const { eventPatch, argSummary, prettyArgs, relativeTime, sourceLabel, isHumanSource } = __test

// ---------------------------------------------------------------------------
// eventPatch — user messages
// ---------------------------------------------------------------------------
test('eventPatch maps a human user message to a user block with rpcId', () => {
  const patch = eventPatch({ type: 'user/message', data: { content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user', rpcId: 'rpc-1' } } })
  assert.equal(patch.blocks[0].type, 'user')
  assert.equal(patch.blocks[0].text, 'Hello')
  assert.equal(patch.userRpcId, 'rpc-1')
})

test('eventPatch drops scaffolding runtime-context messages', () => {
  const patch = eventPatch({ type: 'user/message', data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'runtime-context' } } })
  assert.equal(patch, null)
})

test('eventPatch converts a real non-human source into a system notice', () => {
  const patch = eventPatch({ type: 'user/message', data: { content: [{ type: 'text', text: 'job done' }], source: { kind: 'tool-jobs' } } })
  assert.equal(patch.blocks[0].type, 'system')
  assert.equal(patch.blocks[0].title, '后台任务通知')
})

test('eventPatch returns null for an empty non-human message', () => {
  assert.equal(eventPatch({ type: 'user/message', data: { content: [], source: { kind: 'agent-instructions' } } }), null)
})

test('eventPatch extracts images from user/message with attachment or raw data', () => {
  const withAtt = eventPatch({
    type: 'user/message',
    data: {
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', name: 'photo.jpg' } },
      ],
      source: { kind: 'user' },
    },
  })
  assert.equal(withAtt.blocks[0].images.length, 1)
  assert.equal(withAtt.blocks[0].images[0].attachmentId, 'sha256:abc')

  const withData = eventPatch({
    type: 'user/message',
    data: {
      content: [
        { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png', name: 'inline.png' },
      ],
      source: { kind: 'user' },
    },
  })
  assert.equal(withData.blocks[0].images.length, 1)
  assert.equal(withData.blocks[0].images[0].data, 'aGVsbG8=')
})

// ---------------------------------------------------------------------------
// eventPatch — assistant / tools
// ---------------------------------------------------------------------------
test('eventPatch maps assistant/message into thinking + assistant blocks and clears live', () => {
  const patch = eventPatch({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'why' }, { type: 'text', text: 'answer' }] } },
  })
  assert.equal(patch.clearLive, true)
  assert.equal(patch.blocks.find((b) => b.type === 'thinking').chars, 3)
  assert.ok(patch.blocks.find((b) => b.type === 'assistant').html.includes('answer'))
})

test('eventPatch maps tool/call to a running tool block', () => {
  const patch = eventPatch({ type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) } })
  assert.equal(patch.blocks[0].type, 'tool')
  assert.equal(patch.blocks[0].status, '运行中')
  assert.equal(patch.blocks[0]._callId, 'c9')
  assert.equal(patch.blocks[0].arg, 'ls -la')
})

test('eventPatch maps tool/result status (完成 vs 失败)', () => {
  const ok = eventPatch({ type: 'tool/result', data: { toolCallId: 'c9', message: { content: [{ type: 'text', text: 'output' }], isError: false } } })
  assert.equal(ok.toolResult.status, '完成')
  const bad = eventPatch({ type: 'tool/result', data: { toolCallId: 'c9', message: { content: [{ type: 'text', text: 'boom' }], isError: true } } })
  assert.equal(bad.toolResult.status, '失败')
})

// ---------------------------------------------------------------------------
// eventPatch — turn lifecycle / metadata
// ---------------------------------------------------------------------------
test('eventPatch turn/end normal -> idle + clearLive', () => {
  const patch = eventPatch({ type: 'turn/end', data: { reason: { kind: 'stop' } } })
  assert.equal(patch.state, 'idle')
  assert.equal(patch.clearLive, true)
  assert.equal(patch.blocks, undefined)
})

test('eventPatch turn/end error -> error state with a failure block', () => {
  const patch = eventPatch({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
  assert.equal(patch.state, 'error')
  assert.equal(patch.blocks[0].type, 'error')
})

test('eventPatch maps session/title and request/header', () => {
  assert.equal(eventPatch({ type: 'session/title', data: { title: '  My chat  ' } }).title, 'My chat')
  const hdr = eventPatch({ type: 'request/header', data: { header: { config: { model: 'm1', provider: 'p1' } } } })
  assert.equal(hdr.model, 'm1')
  assert.equal(hdr.engine, 'p1')
})

test('eventPatch returns null for unknown event types', () => {
  assert.equal(eventPatch({ type: 'nope/nothing', data: {} }), null)
  assert.equal(eventPatch(null), null)
})

// ---------------------------------------------------------------------------
// Formatters rendered by the mobile UI
// ---------------------------------------------------------------------------
test('argSummary extracts the salient argument from JSON', () => {
  assert.equal(argSummary('bash', JSON.stringify({ command: 'ls -la' })), 'ls -la')
  assert.equal(argSummary('read', JSON.stringify({ file_path: '/a/b.txt', x: 1 })), '/a/b.txt')
  assert.equal(argSummary('grep', JSON.stringify({ pattern: 'TODO' })), 'TODO')
})

test('argSummary tolerates non-JSON and non-object args', () => {
  assert.equal(argSummary('task', 'plain text first line\nsecond'), 'plain text first line')
  assert.equal(argSummary('x', 'not json at all'), 'not json at all')
  assert.equal(argSummary('x', 42), '42')
})

test('prettyArgs pretty-prints valid JSON and passes through invalid', () => {
  assert.match(prettyArgs(JSON.stringify({ a: 1 })), /\n\s+"a": 1/)
  assert.equal(prettyArgs('{ not json'), '{ not json')
})

test('relativeTime buckets elapsed time into 刚刚/分钟/小时/天', () => {
  const now = Date.now()
  assert.equal(relativeTime(now - 1000), '刚刚')
  assert.equal(relativeTime(now - 2 * 60_000), '2 分钟前')
  assert.equal(relativeTime(now - 3 * 3_600_000), '3 小时前')
  assert.equal(relativeTime(now - 2 * 86_400_000), '2 天前')
  assert.equal(relativeTime(0), '')
})

test('sourceLabel and isHumanSource classify sources', () => {
  assert.equal(sourceLabel('goal'), '目标提醒')
  assert.equal(sourceLabel('unknown-kind'), '系统消息')
  assert.equal(isHumanSource('user'), true)
  assert.equal(isHumanSource('steering'), true)
  assert.equal(isHumanSource('runtime-context'), false)
  assert.equal(isHumanSource(undefined), true) // defaults to user
})
