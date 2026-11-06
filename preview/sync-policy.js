/* MobileVC sync policy — plain classic script, loaded before app-live.js.
 * Kept free of DOM/browser APIs so the same decisions can be unit-tested in
 * Node. Exposed as window.__MVC_SYNC__ (and module.exports for tests).
 *
 * Regression this module guards against: after a server restart the SSE stream
 * can silently lose its last frames. The old code disabled the durable
 * snapshot fallback for idle sessions and dropped renders while the user was
 * scrolling, leaving the phone frozen while desktop showed the full reply.
 */
(function (global) {
  'use strict';

  /**
   * Decide whether the 2.5s hard-fallback tick should pull a durable snapshot.
   * `force` (manual refresh) always wins.
   */
  function shouldSyncNow(s, force) {
    if (force) return true;
    if (!s) return false;
    if (s.hidden || s.syncBusy || s.loading || s.detailLoading) return false;
    if (!s.sessionId) return false;

    var now = Number(s.now) || Date.now();
    var lastFollowAt = Number(s.lastFollowAt) || 0;
    var lastSyncAt = Number(s.lastSyncAt) || 0;
    var followAlive = Boolean(s.followAlive);
    var running = s.state === 'running' || s.state === 'waiting';

    // A connected stream that delivered recently is authoritative.
    if (followAlive && now - lastFollowAt < 4000) return false;
    // While assistant text is streaming, let the stream own the view.
    if (s.live && now - lastFollowAt < 10000) return false;
    // `sending` must NOT disable the fallback: the prompt RPC can stay pending
    // while a dead SSE never delivers the reply (exactly the "desktop shows it,
    // phone does not" symptom). Just poll a bit less often during a send.
    if (s.sending && now - lastSyncAt < 4000) return false;
    // Idle sessions still need a periodic durable fallback: an SSE stream can
    // drop its final frames without ever closing. Throttle to 8s to stay quiet.
    if (!running && now - lastSyncAt < 8000) return false;
    return true;
  }

  /** Never jump the viewport while the user is reading, but NEVER drop the render. */
  function shouldAutoScroll(atBottom, userIsScrolling) {
    return Boolean(atBottom) && !userIsScrolling;
  }

  /** Polling is the SSE fallback: keep it alive whenever no live stream exists. */
  function shouldStopPolling(s) {
    if (!s || !s.sessionId) return true;
    if (s.followAlive) return true;   // SSE is back; it owns the view now
    return false;                     // even when idle — SSE may be dead
  }

  /**
   * Guard against history flicker & scroll jumps:
   * When SSE connects, DSH's follow() returns only a paginated 1-2 turn window.
   * If the client already loaded full history (e.g. 11 turns / 300+ blocks), an
   * incoming smaller snapshot must NEVER truncate the loaded history down to 2
   * turns, which causes the page to collapse, the scrollbar to bounce, and then
   * re-expand seconds later.
   */
  function shouldAcceptSnapshot(currentBlockCount, incomingBlockCount) {
    if (!currentBlockCount) return true;
    return (incomingBlockCount || 0) >= currentBlockCount;
  }

  /**
   * Process SSE assistant-stream frames (chunks of reasoning-delta and text-delta)
   * to power real-time typewriter and live thinking streaming.
   */
  function processAssistantFrame(live, frame) {
    if (!frame) return live;
    if (frame.type === 'start') {
      return { reasoning: '', text: '' };
    }
    if (frame.type === 'end' || frame.type === 'finish') {
      return live;
    }
    var chunk = frame.chunk || frame;
    if (!chunk) return live;
    var current = live ? { reasoning: live.reasoning || '', text: live.text || '' } : { reasoning: '', text: '' };
    var deltaType = chunk.type;
    var text = chunk.text || '';
    if (deltaType === 'reasoning-delta' || chunk.reasoning) {
      current.reasoning += text || chunk.reasoning || '';
    } else if (deltaType === 'text-delta' || deltaType === 'text') {
      current.text += text;
    }
    return current;
  }

  /**
   * Safe sheet kind checking to prevent cross-sheet contamination:
   * "会话轮次目录".startsWith("会话") previously caused 30s background session
   * polling to clobber the turn-outline sheet into the session-list sheet.
   */
  function isMatchingSheet(activeKind, targetKind) {
    if (!activeKind || !targetKind) return false;
    return activeKind === targetKind;
  }

  var api = {
    shouldSyncNow: shouldSyncNow,
    shouldAutoScroll: shouldAutoScroll,
    shouldStopPolling: shouldStopPolling,
    shouldAcceptSnapshot: shouldAcceptSnapshot,
    processAssistantFrame: processAssistantFrame,
    isMatchingSheet: isMatchingSheet,
  };
  global.__MVC_SYNC__ = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
