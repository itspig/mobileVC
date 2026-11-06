// Test harness for the mobile client (preview/app-live.js).
//
// app-live.js is a single browser IIFE with no exports, so unit tests cannot
// reach its internals directly. This harness reproduces the exact shipped
// source inside an isolated `vm` context with a tiny DOM stub, then injects a
// single `globalThis.__MVC_APP__ = { ... }` line right before the IIFE closes.
// Nothing in the real file is altered on disk — the injection only happens on
// the in-memory string. sync-policy.js is loaded first, exactly as index.html
// loads it, so the client sees `window.__MVC_SYNC__` just like production.
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const APP_PATH = new URL('../preview/app-live.js', import.meta.url)
const SYNC_PATH = new URL('../preview/sync-policy.js', import.meta.url)

// Functions/values the tests need. Keeping the list explicit means a rename in
// the shipped file fails loudly here instead of silently testing nothing.
const EXPORTS = [
  'esc', 'durationLabel', 'walletText', 'accountBalanceText', 'accountLow',
  'isQuotaBlock', 'isMeaningfulSession', 'getEffectiveTheme', 'toolLabel',
  'urlBase64ToUint8Array', 'contentSignature', 'blockKey', 'isIgnoredSystemPrompt',
  'chatBlock', 'questionField', 'traceRows', 'plainHtml',
  'handleAssistantFrame', 'syncCurrentSession', 'shouldSyncNowFallback',
  'applyDetail', 'applyPatch', 'state', 'paintLiveThinkBody', 'isNearBottom',
  'renderAppbar', 'syncAppbarStatus', 'updateDockStatus', 'status',
  'renderTurnRail', 'updateRailArrows', 'mergeCurrentSessionIntoList', 'scrollToTurn',
  'renderMarkdownTables', 'syncAppViewport', 'renderMarkdownMath', 'renderFormattedContent',
]

export function makeElement() {
  const el = {
    dataset: {},
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = String(v) },
      getPropertyValue(k) { return this._p[k] || '' },
    },
    hidden: false, open: false, className: '',
    innerHTML: '', textContent: '', value: '', title: '', id: '',
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0,
    children: [], childNodes: [], firstChild: null, parentNode: null,
    classList: {
      _s: new Set(),
      add(...a) { a.forEach((x) => this._s.add(x)) },
      remove(...a) { a.forEach((x) => this._s.delete(x)) },
      toggle(x, force) {
        if (force === undefined) { this._s.has(x) ? this._s.delete(x) : this._s.add(x) }
        else { force ? this._s.add(x) : this._s.delete(x) }
        return this._s.has(x)
      },
      contains(x) { return this._s.has(x) },
    },
    appendChild(c) { return c }, insertBefore(c) { return c }, removeChild(c) { return c },
    remove() {}, insertAdjacentHTML() {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
    querySelector() { return makeElement() }, querySelectorAll() { return [] }, closest() { return makeElement() },
    focus() {}, blur() {}, click() {}, play() { return Promise.resolve() }, pause() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 } },
    scrollIntoView() {}, getContext() { return null },
  }
  return el
}

function buildContext() {
  const document = {
    documentElement: makeElement(), body: makeElement(), head: makeElement(),
    hidden: false, visibilityState: 'visible', activeElement: null, title: '',
    querySelector() { return makeElement() }, querySelectorAll() { return [] },
    getElementById() { return makeElement() }, createElement() { return makeElement() },
    createTextNode() { return makeElement() },
    addEventListener() {}, removeEventListener() {}, createDocumentFragment() { return makeElement() },
  }
  const windowObj = {
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} } },
    addEventListener() {}, removeEventListener() {}, innerWidth: 390, innerHeight: 844,
    open() { return {} }, visualViewport: null, scrollX: 0, scrollY: 0,
    scrollTo() {}, getComputedStyle() { return { getPropertyValue() { return '' }, paddingBottom: '0px' } },
  }
  const rafQueue = []
  const ctx = {
    window: windowObj,
    document,
    location: { pathname: '/mobilevc/', hash: '', search: '', protocol: 'https:', href: 'https://host/mobilevc/', host: 'host' },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'Mozilla/5.0', serviceWorker: { register() { return Promise.resolve() } }, standalone: false },
    screen: { orientation: { lock() { return Promise.resolve() } } },
    fetch: () => new Promise(() => {}),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length }, cancelAnimationFrame() {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    CSS: { escape: (s) => String(s) }, crypto: { randomUUID: () => 'uuid-test' }, console,
    Math, Date, JSON, Number, String, Boolean, parseInt, parseFloat, isNaN, Infinity, NaN,
    Object, Array, Set, Map, RegExp, Error, TypeError, Promise, Uint8Array, Intl,
    encodeURIComponent, decodeURIComponent, structuredClone,
    FileReader: function () {}, EventSource: undefined, Notification: undefined, PushManager: undefined,
    getComputedStyle: windowObj.getComputedStyle,
    requestIdleCallback: (cb) => { rafQueue.push(cb); return rafQueue.length },
    IntersectionObserver: function () { return { observe() {}, disconnect() {} } },
  }
  ctx.globalThis = ctx
  ctx.self = ctx
  return { ctx, rafQueue }
}

export function loadApp() {
  let code = fs.readFileSync(fileURLToPath(APP_PATH), 'utf8')
  const syncCode = fs.readFileSync(fileURLToPath(SYNC_PATH), 'utf8')
  const inject = `\n  globalThis.__MVC_APP__ = { ${EXPORTS.join(', ')} };\n})();`
  const close = code.lastIndexOf('})();')
  if (close < 0) throw new Error('app-live.js: closing IIFE not found')
  code = code.slice(0, close) + inject

  const { ctx, rafQueue } = buildContext()
  vm.createContext(ctx)
  // Load KaTeX first if vendored, exactly like index.html.
  const katexPath = new URL('../preview/assets/katex/katex.min.js', import.meta.url)
  if (fs.existsSync(fileURLToPath(katexPath))) {
    const katexCode = fs.readFileSync(fileURLToPath(katexPath), 'utf8')
    vm.runInContext(katexCode, ctx, { filename: 'katex.min.js' })
  }
  // Load the shared policy first, exactly like index.html.
  vm.runInContext(syncCode, ctx, { filename: 'sync-policy.js' })
  vm.runInContext(code, ctx, { filename: 'app-live.js' })
  const app = ctx.__MVC_APP__
  if (!app) throw new Error('app-live.js: __MVC_APP__ was not exposed')

  const flushRaf = () => { const q = rafQueue.splice(0); for (const cb of q) cb() }

  // Provide a clean, deterministic state for each test. Load-time bootstrap
  // (loadSessions/render) leaves `loading` etc. mutated, so we reset explicitly.
  function resetState(overrides = {}) {
    Object.assign(app.state, {
      provisional: false, blockKeys: null, turns: [], sessionsQuery: '',
      sessionsOffset: 0, sessionsHasMore: true, sessionsTotal: 0, sessionsLoading: false,
      sessions: [], session: null, blocks: [], approvals: [], questions: [], questionSig: '',
      skills: [], memories: [], logs: null, files: [], cwd: '', filePath: '', fileParent: '',
      fileLoading: false, fileSeq: 0, attachments: [], optimisticUser: null, queue: [],
      queueSeq: 0, interjections: [], jobs: [], jobsSeq: 0,
      account: { available: false, status: 'unknown', links: { topUpUrl: '', usageUrl: '' }, balance: null },
      accountBusy: false, accountLoading: false, accountRetry: null, quotaRedirected: false,
      reconcileTimer: null, memoryDefaultPath: '', engine: 'DSH', model: '', loading: false,
      detailLoading: false, error: '', draft: '', sending: false, sendStartedAt: 0,
      pollTimer: null, pollIdle: 0, contentSig: '', follow: null, followRetry: null,
      lastFollowAt: 0, lastSyncAt: 0, syncBusy: false, resumeInFlight: false, live: null,
      liveRaf: null, themeMode: 'auto', theme: 'light', traceMode: 'simple',
    }, overrides)
  }

  // Replace the global fetch; resolves to `body` via r.json(). Returns a
  // counter object so tests can assert whether a network call happened.
  function setFetch(body) {
    const counter = { count: 0, lastUrl: '' }
    ctx.fetch = (url, opts) => {
      counter.count += 1
      counter.lastUrl = String(url)
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => body })
    }
    return counter
  }

  return { app, state: app.state, ctx, flushRaf, resetState, setFetch }
}
