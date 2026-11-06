import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Load the browser-side classic script into an isolated context so the exact
// same policy code that ships is what we test (no DOM required).
const code = fs.readFileSync(new URL('../preview/sync-policy.js', import.meta.url), 'utf8')
const ctx = { window: {}, Date, Math, Number, Boolean, module: { exports: {} } }
vm.createContext(ctx)
vm.runInContext(code, ctx)
const { shouldSyncNow, shouldAutoScroll, shouldStopPolling, shouldAcceptSnapshot, processAssistantFrame, isMatchingSheet } = ctx.window.__MVC_SYNC__

const base = {
  hidden: false, syncBusy: false, loading: false, detailLoading: false, sending: false,
  sessionId: 'session-1', followAlive: false, live: false,
  lastFollowAt: 0, lastSyncAt: 0, state: 'idle', now: 100000,
}

// ---------------------------------------------------------------------------
// ROOT CAUSE REGRESSION: after the container restart the SSE stream lost its
// final frames. The session was IDLE and the user had scrolled, so the old
// code disabled the durable snapshot fallback entirely -> phone frozen forever
// while desktop showed the full reply.
// ---------------------------------------------------------------------------
test('idle session with a dead stream MUST still sync (the frozen-phone regression)', () => {
  assert.equal(shouldSyncNow({ ...base, state: 'idle', followAlive: false, lastFollowAt: 0 }, false), true)
})

test('sync is NOT blocked by user scrolling or composer focus anymore', () => {
  // Those guards moved out of the decision entirely; policy has no such inputs.
  assert.equal(shouldSyncNow({ ...base, state: 'idle' }, false), true)
})

test('running session with stale stream syncs immediately', () => {
  assert.equal(shouldSyncNow({ ...base, state: 'running', lastFollowAt: 0 }, false), true)
})

test('a healthy live stream that just delivered is authoritative (no needless fetch)', () => {
  assert.equal(shouldSyncNow({ ...base, followAlive: true, lastFollowAt: 99000 }, false), false)
})

test('streaming assistant text is left to the stream while fresh', () => {
  assert.equal(shouldSyncNow({ ...base, live: true, lastFollowAt: 99500, now: 100000 }, false), false)
})

test('a stale stream is recovered even while live text is on screen', () => {
  assert.equal(shouldSyncNow({ ...base, live: true, lastFollowAt: 0, now: 100000 }, false), true)
})

test('idle fallback is throttled to 8s to stay quiet', () => {
  assert.equal(shouldSyncNow({ ...base, state: 'idle', lastSyncAt: 90000, now: 100000 }, false), true)
  assert.equal(shouldSyncNow({ ...base, state: 'idle', lastSyncAt: 97000, now: 100000 }, false), false)
  assert.equal(shouldSyncNow({ ...base, state: 'idle', lastSyncAt: 99500, now: 100000 }, false), false)
})

test('manual/forced refresh always wins', () => {
  assert.equal(shouldSyncNow({ ...base, hidden: true, sending: true, sessionId: '' }, true), true)
})

test('guards still block work during load / hidden / busy / no session', () => {
  assert.equal(shouldSyncNow({ ...base, hidden: true }, false), false)
  assert.equal(shouldSyncNow({ ...base, syncBusy: true }, false), false)
  assert.equal(shouldSyncNow({ ...base, sessionId: '' }, false), false)
})

// REGRESSION: a pending prompt RPC with a dead SSE must still be able to pull
// the reply, otherwise desktop shows it and the phone stays frozen.
test('sending does NOT disable the fallback (desktop showed reply, phone did not)', () => {
  assert.equal(shouldSyncNow({ ...base, sending: true, state: 'running' }, false), true)
})

test('sending fallback is throttled to 4s to avoid hammering the host', () => {
  assert.equal(shouldSyncNow({ ...base, sending: true, state: 'running', lastSyncAt: 99000, now: 100000 }, false), false)
  assert.equal(shouldSyncNow({ ...base, sending: true, state: 'running', lastSyncAt: 95000, now: 100000 }, false), true)
})

// ---------------------------------------------------------------------------
// Render must NEVER be dropped. We only suppress the auto-scroll jump.
// ---------------------------------------------------------------------------
test('auto-scroll happens only at bottom and not while the user is reading', () => {
  assert.equal(shouldAutoScroll(true, false), true)
  assert.equal(shouldAutoScroll(true, true), false)
  assert.equal(shouldAutoScroll(false, false), false)
  assert.equal(shouldAutoScroll(false, true), false)
})

// ---------------------------------------------------------------------------
// Polling is the SSE fallback and must survive an idle session.
// ---------------------------------------------------------------------------
test('polling stays alive when SSE is down, even when session is idle', () => {
  assert.equal(shouldStopPolling({ sessionId: 's', followAlive: false }), false)
})

test('polling stops once SSE is back (and when no session)', () => {
  assert.equal(shouldStopPolling({ sessionId: 's', followAlive: true }), true)
  assert.equal(shouldStopPolling({ sessionId: '', followAlive: false }), true)
  assert.equal(shouldStopPolling(null), true)
})

// ---------------------------------------------------------------------------
// REGRESSION: "手机端打开后默认只显示两轮对话，然后它又加载到全部对话。
// 在这个过程中，页面会乱跳"
// DSH's follow() returns only a 1-2 turn windowed snapshot. If the client has
// already loaded full history (e.g. 11 turns, 389 blocks), an incoming smaller
// snapshot must NEVER truncate the history down to 2 turns and cause the page
// to collapse and scrollbar to jitter.
// ---------------------------------------------------------------------------
test('shouldAcceptSnapshot guards against history collapse and scroll jumps', () => {
  // Never shrink 389 blocks down to a 63-block windowed snapshot
  assert.equal(shouldAcceptSnapshot(389, 63), false)
  // Accept when starting empty
  assert.equal(shouldAcceptSnapshot(0, 63), true)
  // Accept equal count
  assert.equal(shouldAcceptSnapshot(63, 63), true)
  // Accept growing history
  assert.equal(shouldAcceptSnapshot(63, 100), true)
})

// ---------------------------------------------------------------------------
// REGRESSION: "为什么我现在看到的回答是突然一下出现的，并没有 流式输出？"
// Real-time streaming frames were never processed because handleAssistantFrame
// was never defined. Test that frames cleanly accumulate into live.reasoning
// and live.text for real-time typewriter output.
// ---------------------------------------------------------------------------
test('processAssistantFrame accumulates reasoning and text streaming deltas', () => {
  let live = processAssistantFrame(null, { type: 'start', turn: 1, step: 1 })
  assert.equal(live.reasoning, '')
  assert.equal(live.text, '')

  live = processAssistantFrame(live, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Step 1: ' } })
  live = processAssistantFrame(live, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'analyzing.' } })
  assert.equal(live.reasoning, 'Step 1: analyzing.')
  assert.equal(live.text, '')

  live = processAssistantFrame(live, { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello ' } })
  live = processAssistantFrame(live, { type: 'chunk', chunk: { type: 'text-delta', text: 'world!' } })
  assert.equal(live.text, 'Hello world!')

  // Terminal frames preserve state
  const finished = processAssistantFrame(live, { type: 'finish', reason: 'stop' })
  assert.equal(finished.text, 'Hello world!')
  assert.equal(finished.reasoning, 'Step 1: analyzing.')
})

// ---------------------------------------------------------------------------
// REGRESSION: "设置里面的轮次目录按钮打开后为什么有时候变成 session 目录了"
// title.startsWith('会话') matched both '会话' (sessions) and '会话轮次目录' (turn outline).
// When background session refresh (every 30s) ran, it clobbered the turn outline
// sheet body into the session list body.
// ---------------------------------------------------------------------------
test('isMatchingSheet prevents cross-sheet body clobbering', () => {
  assert.equal(isMatchingSheet('turn-outline', 'sessions'), false)
  assert.equal(isMatchingSheet('sessions', 'sessions'), true)
  assert.equal(isMatchingSheet('turn-outline', 'turn-outline'), true)
  assert.equal(isMatchingSheet('', 'sessions'), false)
  assert.equal(isMatchingSheet('settings', 'sessions'), false)
})
