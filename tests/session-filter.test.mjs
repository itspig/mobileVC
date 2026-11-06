import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../plugin/index.mjs'

const { summaryFromInspection, isSafeSessionId } = __test

test('summaryFromInspection maps running session correctly', () => {
  const summary = { sessionId: 'session-123', cwd: '/root/test', running: true, updatedAt: 5000 }
  const inspection = {
    meta: { id: 'session-123', cwd: '/root/test' },
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } } },
      { type: 'turn/start', data: { turn: 1 } },
    ]
  }
  const res = summaryFromInspection(summary, inspection)
  assert.equal(res.id, 'session-123')
  assert.equal(res.state, 'running')
  assert.equal(res.stateLabel, '运行中')
  assert.equal(res.userCount, 1)
  assert.equal(res.title, 'Hello')
  assert.equal(res.subagent, false)
})

test('summaryFromInspection maps pending approvals to waiting state', () => {
  const summary = { sessionId: 'session-appr', cwd: '/root/test', running: false }
  const inspection = {
    meta: { id: 'session-appr' },
    events: [
      { type: 'approval/asked', data: { id: 'appr-1', toolName: 'bash' } }
    ]
  }
  const res = summaryFromInspection(summary, inspection)
  assert.equal(res.state, 'waiting')
  assert.equal(res.stateLabel, '待授权')
  assert.equal(res.pending, 1)
})

test('summaryFromInspection detects subagent origin', () => {
  const summary = { sessionId: 'session-sub', origin: 'subagent' }
  const inspection = { meta: { id: 'session-sub' }, events: [] }
  const res = summaryFromInspection(summary, inspection)
  assert.equal(res.subagent, true)
})

test('isSafeSessionId protects against directory traversal and null bytes', () => {
  assert.equal(isSafeSessionId('../etc/passwd'), false)
  assert.equal(isSafeSessionId('session-ok'), true)
  assert.equal(isSafeSessionId('1f72282d-41a0-4763-bbef-4794be8a0cd8'), true)
  assert.equal(isSafeSessionId('session-\0-hack'), false)
  assert.equal(isSafeSessionId('session-a/b'), false)
})
