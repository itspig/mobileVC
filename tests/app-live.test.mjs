// Full TDD coverage for the mobile client surface (preview/app-live.js).
// These tests load the *real shipped* browser bundle in a vm and exercise the
// pure/decision logic that powers the phone UI. Several are explicit
// regressions for bugs that shipped (see the comments).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadApp, makeElement } from './_app-live-harness.mjs'

const { app, ctx, flushRaf, resetState, setFetch } = loadApp()

// ---------------------------------------------------------------------------
// Escaping / rendering
// ---------------------------------------------------------------------------
test('esc escapes the five HTML metacharacters and stringifies nullish/numbers', () => {
  assert.equal(app.esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  assert.equal(app.esc(null), '')
  assert.equal(app.esc(undefined), '')
  assert.equal(app.esc(0), '0')
  assert.equal(app.esc(42), '42')
})

test('chatBlock(user) escapes text instead of injecting raw HTML (XSS guard)', () => {
  const html = app.chatBlock({ type: 'user', text: '<script>alert(1)</script>' })
  assert.ok(!html.includes('<script>'), 'raw <script> must not appear')
  assert.ok(html.includes('&lt;script&gt;'), 'text must be HTML-escaped')
})

test('chatBlock(user) surfaces steering tag and optimistic state', () => {
  assert.ok(app.chatBlock({ type: 'user', text: 'hi', source: 'steering' }).includes('插话'))
  assert.ok(app.chatBlock({ type: 'user', text: 'hi', _optimistic: true, _rpcId: 'r1' }).includes('发送中'))
})

test('chatBlock(user) renders optimistic images using inline data: URL', () => {
  const html = app.chatBlock({
    type: 'user',
    text: '预估下培训内容',
    images: [{ name: 'test.jpg', mediaType: 'image/jpeg', data: 'dGVzdA==' }],
    _optimistic: true,
  })
  assert.ok(html.includes('class="user-images"'), 'must render user-images wrapper')
  assert.ok(html.includes('src="data:image/jpeg;base64,dGVzdA=="'), 'must render data URL preview')
  assert.ok(html.includes('预估下培训内容'))
  assert.ok(html.includes('发送中'))
})

test('chatBlock(user) renders durable images via API attachment endpoint', () => {
  const html = app.chatBlock({
    type: 'user',
    text: '查看附件',
    images: [{ attachmentId: 'sha256:123456', name: 'photo.png', width: 800, height: 600 }],
  })
  assert.ok(html.includes('api/attachment?id=sha256%3A123456'), 'must link to attachment endpoint')
  assert.ok(html.includes('800×600'))
})

test('chatBlock(user) renders optimistic files even without attachmentId', () => {
  const html = app.chatBlock({
    type: 'user',
    text: '看文档',
    files: [{ name: 'plan.pdf', size: 10240 }],
    _optimistic: true,
  })
  assert.ok(html.includes('class="user-files"'))
  assert.ok(html.includes('plan.pdf'))
  assert.ok(html.includes('10 KB'))
})

test('chatBlock(assistant) converts pre-baked <p>|...<br> tables from historical sessions (9764.jpg regression)', () => {
  const bakedHtml = '<p>来自 2008 年以前的老规定：</p><p>| 2008 年前的解除类型 | 是否有 12 个月上限 |<br>|---|---|<br>| 协商一致解除 | <strong>有，最多 12 个月</strong> |<br>| 经济性裁员 | 无上限 |</p><p>末尾总结</p>'
  const html = app.chatBlock({ type: 'assistant', html: bakedHtml })
  assert.ok(html.includes('<div class="table-wrap"><table>'), 'must convert baked <p> table to table-wrap table')
  assert.ok(html.includes('<th>2008 年前的解除类型</th>'))
  assert.ok(html.includes('<td><strong>有，最多 12 个月</strong></td>'))
  assert.ok(html.includes('<p>来自 2008 年以前的老规定：</p>'))
  assert.ok(html.includes('<p>末尾总结</p>'))
})

test('chatBlock(thinking) also renders tables inside deep thinking blocks', () => {
  const bakedHtml = '<p>| 参数 | 取值 |<br>|---|---|<br>| timeout | 30s |</p>'
  const html = app.chatBlock({ type: 'thinking', html: bakedHtml, chars: 10 })
  assert.ok(html.includes('<div class="table-wrap"><table>'))
  assert.ok(html.includes('<th>参数</th>'))
  assert.ok(html.includes('<td>timeout</td>'))
})

test('chatBlock(assistant) renders LaTeX math formulas via KaTeX (9770.jpg regression)', () => {
  const latexSnippet = '<p>$$\\text{上下文 } 60\\text{k} \\sim 160\\text{k} \\quad + \\quad \\text{意图为常规写功能 / 修复常规 Bug}$$</p>'
  const html = app.chatBlock({ type: 'assistant', html: latexSnippet })
  assert.ok(html.includes('class="math-block"'), 'must wrap in math-block container')
  assert.ok(html.includes('katex-display') || html.includes('katex'), 'must invoke KaTeX renderer')
  assert.ok(html.includes('上下文'), 'must render Chinese text inside \\text{}')
})

test('chatBlock(assistant) renders inline math without breaking currency amounts', () => {
  const md = '<p>时间复杂度为 $O(n \\log n)$，价格为 $50 美元</p>'
  const html = app.chatBlock({ type: 'assistant', html: md })
  assert.ok(html.includes('class="math-inline"'), 'math should be wrapped in math-inline')
  assert.ok(html.includes('$50 美元'), 'currency like $50 must not be mangled as math')
})

test('renderFormattedContent never converts LaTeX inside <pre><code> (9771.jpg regression)', () => {
  const baked = [
    '<p>已修复截图（<code>9770.jpg</code>）中的数学公式渲染问题：</p>',
    '<pre><code>$$\\text{上下文 } 60\\text{k} \\sim 160\\text{k}$$</code></pre>',
    '<p>直接以原始 LaTeX 代码形式裸露在回答里。</p>',
  ].join('')
  const out = app.renderFormattedContent(baked)
  assert.ok(out.includes('<pre><code>$$'), 'code block must stay verbatim')
  assert.ok(!out.includes('<pre><code><div class="math-block"'), 'no div may be injected into pre/code')
  assert.ok(!out.includes('katex-display'), 'no KaTeX rendering inside code blocks')
  assert.ok(out.includes('直接以原始 LaTeX'), 'surrounding text must survive')
})

test('renderFormattedContent does not pair a stray $ with a later $ (9771.jpg regression)', () => {
  const md = '<p>价格为 $50 美元，另有公式 $E=mc^2$ 与 $100.50 元</p>'
  const out = app.renderFormattedContent(md)
  assert.ok(out.includes('$50 美元'), 'first currency must not be swallowed')
  assert.ok(out.includes('$100.50 元'), 'second currency must not be swallowed')
  assert.equal((out.match(/class="math-inline"/g) || []).length, 1, 'exactly one real inline formula')
  assert.ok(out.includes('class="math-inline"'))
})

test('renderFormattedContent keeps tool-card details/summary intact after formatting', () => {
  const baked = '<p>示例 $$x^2$$</p><pre><code>$$y^2$$</code></pre>'
  const out = app.renderFormattedContent(baked)
  // No stray <details> or default "详情" summary can be produced by broken nesting
  assert.ok(!out.includes('<details'), 'formatting must not introduce stray details elements')
  assert.ok(!out.includes('详情'), 'no default disclosure summary text')
})

test('chatBlock(system) drops ignored scaffolding (AGENTS/runtime) and keeps real notices', () => {
  assert.equal(app.chatBlock({ type: 'system', body: 'Instructions from: AGENTS.md stuff' }), '')
  assert.equal(app.chatBlock({ type: 'system', body: 'Time sampled while preparing turn 1' }), '')
  const real = app.chatBlock({ type: 'system', title: '后台任务', body: 'done' })
  assert.ok(real.includes('后台任务'))
})

test('chatBlock(error) flags quota errors with the quota class', () => {
  const quota = app.chatBlock({ type: 'error', code: 'QUOTA', message: '余额不足' })
  assert.ok(quota.includes('quota'))
  const plain = app.chatBlock({ type: 'error', code: 'E_BOOM', message: 'boom' })
  assert.ok(!plain.includes('error-card quota'))
})

test('questionField renders radio for single, checkbox for multi, and escapes', () => {
  const single = app.questionField({ id: 'q1', question: '<b>Q</b>', options: [{ label: 'A' }, { label: 'B' }] }, 0, 1)
  assert.ok(single.includes('type="radio"'))
  assert.ok(single.includes('&lt;b&gt;Q&lt;/b&gt;'), 'question text must be escaped')
  const multi = app.questionField({ id: 'q2', question: 'Q', multiSelect: true, options: [{ label: 'A' }] }, 1, 2)
  assert.ok(multi.includes('type="checkbox"'))
  assert.ok(multi.includes('可多选'))
})

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
test('durationLabel formats sub-second, seconds and minutes without "60s" rolls', () => {
  assert.equal(app.durationLabel(0), '')
  assert.equal(app.durationLabel(-5), '')
  assert.equal(app.durationLabel(250), '250ms')
  assert.equal(app.durationLabel(1500), '2s')
  assert.equal(app.durationLabel(59999), '1m 0s') // was "60s"
  assert.equal(app.durationLabel(60000), '1m 0s')
  assert.equal(app.durationLabel(61000), '1m 1s')
  assert.equal(app.durationLabel(119999), '2m 0s') // was "1m 60s"
})

test('walletText renders currency and never emits "¥undefined"', () => {
  assert.equal(app.walletText({ currency: 'USD', balance: 12.5 }), '$12.5')
  assert.equal(app.walletText({ currency: 'CNY', balance: 0 }), '¥0')
  assert.equal(app.walletText(null), '')
  // missing balance is hidden, not rendered as "¥undefined"
  assert.equal(app.walletText({ currency: 'CNY' }), '')
  assert.equal(app.walletText({ currency: 'CNY', balance: '' }), '')
})

test('accountLow treats <=5 total balance as low, and ignores missing wallets', () => {
  resetState({ account: { available: true, balance: { ready: true, wallets: [{ balance: 3 }, { balance: 2 }] } } })
  assert.equal(app.accountLow(), true)
  resetState({ account: { available: true, balance: { ready: true, wallets: [{ balance: 3 }, { balance: 3 }] } } })
  assert.equal(app.accountLow(), false)
  resetState({ account: { available: true, balance: { ready: true, wallets: [] } } })
  assert.equal(app.accountLow(), false)
  resetState({ account: undefined })
  assert.equal(app.accountLow(), false)
})

test('accountBalanceText summarizes wallets and appends bonus', () => {
  resetState({ account: { available: false }, accountLoading: true })
  assert.equal(app.accountBalanceText(), '余额 …')
  resetState({ account: { available: false } })
  assert.equal(app.accountBalanceText(), '余额 —')
  resetState({ account: { available: true, balance: { ready: true, wallets: [{ currency: 'CNY', balance: 10 }], bonusWallets: [{ currency: 'CNY', balance: 5 }] } } })
  assert.equal(app.accountBalanceText(), '¥10 + ¥5 赠金')
})

test('isQuotaBlock matches by code, HTTP status and message text only for error blocks', () => {
  assert.equal(app.isQuotaBlock({ type: 'error', code: 'QUOTA' }), true)
  assert.equal(app.isQuotaBlock({ type: 'error', code: 'ACCOUNT_QUOTA' }), true)
  assert.equal(app.isQuotaBlock({ type: 'error', status: 402 }), true)
  assert.equal(app.isQuotaBlock({ type: 'error', message: 'insufficient balance' }), true)
  assert.equal(app.isQuotaBlock({ type: 'error', message: 'boom' }), false)
  assert.equal(app.isQuotaBlock({ type: 'assistant', code: 'QUOTA' }), false)
  assert.equal(app.isQuotaBlock(null), false)
})

test('isMeaningfulSession hides subagents and empty sessions but keeps running/current', () => {
  resetState({ session: { id: 'cur' } })
  assert.equal(app.isMeaningfulSession(null), false)
  assert.equal(app.isMeaningfulSession({ subagent: true, userCount: 9 }), false)
  assert.equal(app.isMeaningfulSession({ id: 'cur' }), true)
  assert.equal(app.isMeaningfulSession({ id: 'x', state: 'running' }), true)
  assert.equal(app.isMeaningfulSession({ id: 'x', userCount: 0, assistantCount: 0, blockCount: 0 }), false)
  assert.equal(app.isMeaningfulSession({ id: 'x', assistantCount: 2 }), true)
})

test('getEffectiveTheme honours explicit modes and falls back to system', () => {
  assert.equal(app.getEffectiveTheme('dark'), 'dark')
  assert.equal(app.getEffectiveTheme('light'), 'light')
  assert.equal(app.getEffectiveTheme('auto'), 'light') // matchMedia stub -> light
  assert.equal(app.getEffectiveTheme(undefined), 'light')
})

test('toolLabel maps known tools and heuristically labels the rest', () => {
  assert.equal(app.toolLabel('read'), '读取文件')
  assert.equal(app.toolLabel('bash'), '执行命令')
  assert.equal(app.toolLabel('some_image_tool'), '图片工具')
  assert.equal(app.toolLabel('file_magic'), '文件工具')
  assert.equal(app.toolLabel('deep_search'), '搜索工具')
  assert.equal(app.toolLabel('mystery'), '其他工具')
})

test('urlBase64ToUint8Array decodes URL-safe base64 (push key)', () => {
  // "AQID" == [1,2,3]
  assert.deepEqual(Array.from(app.urlBase64ToUint8Array('AQID')), [1, 2, 3])
  // URL-safe chars - and _ decoded with padding
  const bytes = app.urlBase64ToUint8Array('-_8')
  assert.ok(bytes.length >= 1)
})

test('blockKey distinguishes block types and stays stable for dedup', () => {
  assert.notEqual(app.blockKey({ type: 'user', text: 'a' }), app.blockKey({ type: 'assistant', text: 'a' }))
  assert.equal(app.blockKey({ type: 'user', text: 'a' }), 'u:a')
  assert.equal(app.blockKey({ type: 'tool', _callId: 'c1', name: 'read', arg: 'x' }), 'tool:c1:read:x')
  assert.equal(app.blockKey(null), '')
})

test('contentSignature changes when block count or state changes', () => {
  const a = app.contentSignature({ state: 'idle', blocks: [], pending: 0 })
  const b = app.contentSignature({ state: 'idle', blocks: [{ type: 'user', text: 'x' }], pending: 0 })
  assert.notEqual(a, b)
  assert.equal(a, 'idle|0||0')
})

test('isIgnoredSystemPrompt filters scaffolding but keeps real content', () => {
  assert.equal(app.isIgnoredSystemPrompt(''), true)
  assert.equal(app.isIgnoredSystemPrompt('Instructions from: AGENTS.md'), true)
  assert.equal(app.isIgnoredSystemPrompt('<system-reminder>x</system-reminder>'), true)
  assert.equal(app.isIgnoredSystemPrompt('Browser time zone for this request: Asia/Shanghai'), true)
  assert.equal(app.isIgnoredSystemPrompt('后台任务已完成'), false)
})

// ---------------------------------------------------------------------------
// Reconciliation (history collapse / incremental patches)
// ---------------------------------------------------------------------------
test('applyDetail accepts full history but refuses to shrink a loaded timeline', () => {
  resetState()
  // starting empty -> accept
  const ok = app.applyDetail({ id: 's', blocks: [{ type: 'user', text: 'a' }, { type: 'user', text: 'b' }] })
  assert.equal(ok, true)
  assert.equal(ctx.__MVC_APP__.state.blocks.length, 2)
  // incoming smaller, not forced -> reject (no collapse), return false
  const rejected = app.applyDetail({ id: 's', blocks: [{ type: 'user', text: 'a' }] })
  assert.equal(rejected, false)
  assert.equal(ctx.__MVC_APP__.state.blocks.length, 2)
  // forced refresh always wins
  const forced = app.applyDetail({ id: 's', blocks: [{ type: 'user', text: 'z' }] }, { force: true })
  assert.equal(forced, true)
  assert.equal(ctx.__MVC_APP__.state.blocks.length, 1)
})

test('applyPatch dedups blocks already present (SSE reconnect replay)', () => {
  resetState()
  app.state.session = { id: 's', state: 'idle' }
  app.state.blocks = [{ type: 'user', text: 'hello' }]
  app.state.blockKeys = new Set(['u:hello'])
  app.applyPatch({ blocks: [{ type: 'user', text: 'hello' }] })
  assert.equal(app.state.blocks.length, 1, 'duplicate replay must not append')
})

test('applyPatch appends genuinely new blocks', () => {
  resetState()
  app.state.session = { id: 's', state: 'idle' }
  app.state.blocks = [{ type: 'user', text: 'hello' }]
  app.state.blockKeys = new Set(['u:hello'])
  app.applyPatch({ blocks: [{ type: 'user', text: 'world' }] })
  assert.equal(app.state.blocks.length, 2)
})

test('applyPatch replaces an optimistic user echo with the real block', () => {
  resetState()
  app.state.session = { id: 's', state: 'running' }
  const optBlock = { type: 'user', text: 'hi', _optimistic: true, _rpcId: 'r1' }
  app.state.blocks = [optBlock]
  app.state.optimisticUser = { rpcId: 'r1', text: 'hi', block: optBlock, busy: false }
  app.state.blockKeys = new Set()
  app.applyPatch({ userRpcId: 'r1', blocks: [{ type: 'user', text: 'hi' }] })
  assert.equal(app.state.optimisticUser, null)
  assert.equal(app.state.blocks.filter((b) => b._optimistic).length, 0)
  assert.equal(app.state.blocks.length, 1)
})

test('applyPatch replaces an optimistic user block with image without duplication (9756.jpg)', () => {
  resetState()
  app.state.session = { id: 's', state: 'running' }
  const optBlock = {
    type: 'user',
    text: '根据我的宿主机 KR 配置',
    images: [{ name: 'screen.png', data: 'dGVzdA==' }],
    _optimistic: true,
    _rpcId: 'mvc-123',
  }
  app.state.blocks = [optBlock]
  app.state.optimisticUser = { rpcId: 'mvc-123', text: '根据我的宿主机 KR 配置', block: optBlock, busy: false }
  app.state.blockKeys = new Set([app.blockKey(optBlock)])

  // Server emits durable block without mvc- prefix (e.g. raw DSH UUID) and with attachmentId
  app.applyPatch({
    userRpcId: 'dsh-raw-uuid-789',
    blocks: [{
      type: 'user',
      text: '根据我的宿主机 KR 配置',
      images: [{ attachmentId: 'sha256:abc', name: 'screen.png' }],
    }],
  })
  assert.equal(app.state.optimisticUser, null, 'optimistic block must be cleared')
  assert.equal(app.state.blocks.length, 1, 'there must be strictly ONE user block, never duplicate')
  assert.equal(app.state.blocks[0]._optimistic, undefined, 'remaining block must be durable')
  assert.equal(app.state.blocks[0].images[0].attachmentId, 'sha256:abc')
})

test('applyDetail empty snapshot does NOT clear optimistic user block prematurely', () => {
  resetState()
  app.state.session = { id: 's-new', state: 'idle' }
  const optBlock = { type: 'user', text: 'new session first prompt', _optimistic: true, _rpcId: 'mvc-1' }
  app.state.blocks = [optBlock]
  app.state.optimisticUser = { rpcId: 'mvc-1', text: 'new session first prompt', block: optBlock, busy: false }

  // Initial empty snapshot from SSE handshake before prompt is logged
  app.applyDetail({ id: 's-new', blocks: [] })
  assert.notEqual(app.state.optimisticUser, null, 'optimistic block must stay alive until real message arrives')
  assert.equal(app.state.blocks.length, 1)
})

test('mergeCurrentSessionIntoList ensures active session is always in drawer list', () => {
  resetState()
  app.state.session = { id: 's-new-123', title: 'KR宿主机dsh插件选择', state: 'running' }
  const list = app.mergeCurrentSessionIntoList([
    { id: 's-old-1', title: '旧会话 1' },
    { id: 's-old-2', title: '旧会话 2' },
  ])
  assert.equal(list.length, 3)
  assert.equal(list[0].id, 's-new-123', 'active session must be unshifted to the top')
  assert.equal(list[0].title, 'KR宿主机dsh插件选择')

  // If already present, don't duplicate
  const list2 = app.mergeCurrentSessionIntoList(list)
  assert.equal(list2.length, 3)
})

test('applyPatch applies a tool result onto the matching tool block', () => {
  resetState()
  app.state.session = { id: 's', state: 'running' }
  app.state.blocks = [{ type: 'tool', _callId: 'c1', name: 'read', status: '运行中', body: '' }]
  app.state.blockKeys = new Set(['tool:c1:read:'])
  app.applyPatch({ toolResult: { callId: 'c1', status: '完成', body: 'file contents' } })
  assert.equal(app.state.blocks[0].status, '完成')
  assert.equal(app.state.blocks[0].body, 'file contents')
})

test('applyPatch adds then removes approvals', () => {
  resetState()
  app.state.session = { id: 's', state: 'running' }
  // Real eventPatch(approval/asked) carries state:'waiting' alongside the card.
  app.applyPatch({ approval: { id: 'a1', tool: 'bash' }, state: 'waiting', stateLabel: '待授权' })
  assert.equal(app.state.approvals.length, 1)
  assert.equal(app.state.session.state, 'waiting')
  app.applyPatch({ approvalDecided: 'a1' })
  assert.equal(app.state.approvals.length, 0)
})

function appbarHtml(overrides = {}) {
  resetState({ session: { id: 's', title: '测试会话', state: 'idle' }, model: 'group/tiered', ...overrides })
  const bar = makeElement()
  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => sel === '#appbar' ? bar : makeElement()
  try {
    app.renderAppbar()
    return bar.innerHTML
  } finally {
    ctx.document.querySelector = prevQuery
  }
}

function appbarSubtitle(html) {
  const m = html.match(/<div class="absub">([\s\S]*?)<\/div>/)
  return m ? m[1] : ''
}

test('renderAppbar keeps only the status dot and settings on the right', () => {
  const html = appbarHtml()
  assert.match(html, /class="conn-dot on"/, 'idle session keeps the dot (green)')
  assert.match(html, /data-act="settings"/, 'settings button must remain')
  assert.doesNotMatch(html, /data-act="new-session"/, 'top-bar + must NOT come back')
  assert.doesNotMatch(html, /新建会话/, 'no new-session affordance in the appbar')
})

test('appbar subtitle shows ONLY the model name, no 空闲 · / 运行中 · prefix', () => {
  assert.equal(appbarSubtitle(appbarHtml()), 'tiered')
  assert.equal(appbarSubtitle(appbarHtml({ session: { id: 's', title: 'T', state: 'running' } })), 'tiered')
  assert.equal(appbarSubtitle(appbarHtml({ session: null })), 'tiered')
  assert.doesNotMatch(appbarHtml(), /<div class="absub">[^<]*·/, 'status prefix must be gone')
})

test('appbar status dot reflects session state: idle green, running yellow, error red', () => {
  assert.match(appbarHtml({ session: { id: 's', title: 'T', state: 'idle' } }), /class="conn-dot on"/, 'idle = green')
  assert.match(appbarHtml({ session: { id: 's', title: 'T', state: 'running' } }), /class="conn-dot busy"/, 'running = yellow')
  assert.match(appbarHtml({ session: { id: 's', title: 'T', state: 'waiting' } }), /class="conn-dot busy"/, 'waiting = yellow')
  assert.match(appbarHtml({ sending: true }), /class="conn-dot busy"/, 'sending = yellow')
  assert.match(appbarHtml({ session: { id: 's', title: 'T', state: 'error' } }), /class="conn-dot err"/, 'error = red')
  const noSession = appbarHtml({ session: null })
  assert.doesNotMatch(noSession, /class="conn-dot (on|busy|err)"/, 'no session = neutral grey')
  assert.match(noSession, /title="会话状态：未连接"/)
})

test('new-session is still reachable from the sessions sheet (no feature loss)', () => {
  const src = readFileSync(new URL('../preview/app-live.js', import.meta.url), 'utf8')
  const sheet = src.slice(src.indexOf('function sessionsBody'), src.indexOf('function setupSessionScrollObserver'))
  assert.match(sheet, /data-act="new-session"/, 'sessions sheet must keep a 新建会话 button')
})

// ---------------------------------------------------------------------------
// REGRESSION (9739.jpg): 对话已开始（思考/工具在跑），顶栏灯却一直是绿色空闲。
// 根因：SSE 增量只走 applyPatch/handleFollowMessage，不调 render()；而
// updateDockStatus() 因底栏改成 unified-bar 后没有 .dock-status 节点而常年
// early-return。灯因此永远停在打开会话时的那次渲染。
// ---------------------------------------------------------------------------
function statusDotProbe(overrides = {}, act) {
  resetState({ session: { id: 's', title: 'T', state: 'idle' }, model: 'group/tiered', ...overrides })
  const dot = makeElement()
  const sub = makeElement()
  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => {
    if (sel === '#appbar .conn-dot') return dot
    if (sel === '#appbar .absub') return sub
    if (sel === '.dock-status') return null // 新版 unified-bar 已无此节点
    return makeElement()
  }
  try {
    act()
    return { cls: dot.className, title: dot.title, sub: sub.textContent }
  } finally {
    ctx.document.querySelector = prevQuery
  }
}

test('updateDockStatus still refreshes the dot when .dock-status does not exist', () => {
  const got = statusDotProbe({}, () => app.updateDockStatus())
  assert.equal(got.cls, 'conn-dot on', 'idle dot must be painted even with no dock status row')
  assert.equal(got.sub, 'tiered', 'subtitle must be kept in sync too')
})

test('a durable SSE state patch turns the dot yellow (running), no full render needed', () => {
  const got = statusDotProbe({}, () => app.applyPatch({ state: 'running', stateLabel: '运行中' }))
  assert.equal(got.cls, 'conn-dot busy', 'turn/start patch must flip green -> yellow')
  assert.match(got.title, /运行中/)
})

test('status() treats an active live stream as busy even without turn/start', () => {
  assert.equal(typeof app.status, 'function')
  resetState({ session: { id: 's', title: 'T', state: 'idle' }, live: { reasoning: '思考中…', text: '' } })
  assert.equal(app.status().dot, 'busy', 'live reasoning must win over a stale idle session state')
  const got = statusDotProbe({ live: { reasoning: '思考中…', text: '' } }, () => app.updateDockStatus())
  assert.equal(got.cls, 'conn-dot busy', 'streaming content must not leave the dot green')
  assert.match(got.title, /输出中/)
})

test('assistant-stream frames refresh the dot without going through applyPatch', () => {
  const got = statusDotProbe({ session: { id: 's', title: 'T', state: 'running' } }, () => {
    app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Step 1: ' } })
  })
  assert.equal(got.cls, 'conn-dot busy', 'stream frames must keep the dot yellow')
})

// ---------------------------------------------------------------------------
// Real-time streaming — REGRESSION: handleAssistantFrame was never defined, so
// assistant-stream SSE frames were silently dropped and the reply only appeared
// at once instead of typing out.
// ---------------------------------------------------------------------------
test('handleAssistantFrame is defined (streaming handler exists)', () => {
  assert.equal(typeof app.handleAssistantFrame, 'function')
})

test('handleAssistantFrame accumulates reasoning then text deltas into state.live', () => {
  resetState({ session: { id: 's', state: 'running' } })
  app.handleAssistantFrame({ type: 'start' })
  assert.deepEqual({ r: app.state.live.reasoning, t: app.state.live.text }, { r: '', t: '' })
  app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Step 1: ' } })
  app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'think.' } })
  assert.equal(app.state.live.reasoning, 'Step 1: think.')
  assert.equal(app.state.live.text, '')
  app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'Hello ' } })
  app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'world!' } })
  assert.equal(app.state.live.text, 'Hello world!')
  // finish preserves what was accumulated (durable patch clears it later)
  app.handleAssistantFrame({ type: 'finish' })
  assert.equal(app.state.live.text, 'Hello world!')
})

test('handleAssistantFrame ignores a null frame without throwing', () => {
  resetState({ session: { id: 's', state: 'running' } })
  app.handleAssistantFrame({ type: 'start' })
  const before = app.state.live
  assert.doesNotThrow(() => app.handleAssistantFrame(null))
  assert.equal(app.state.live, before)
})

test('paintLiveThinkBody pins the live thinking body to the tail while streaming', () => {
  let height = 600
  const body = {
    ...makeElement(),
    get scrollHeight() { return height },
    set textContent(v) { this._text = v; height += 400 },
    get textContent() { return this._text || '' },
    scrollTop: 400,
    clientHeight: 200,
  }
  // Currently at bottom (600 - 400 - 200 = 0 <= 48)
  app.paintLiveThinkBody(body, 'new reasoning delta')
  assert.equal(body.textContent, 'new reasoning delta')
  // After delta, height became 1000 and body was scrolled to 1000 (tail follow)
  assert.equal(body.scrollTop, 1000)
})

test('paintLiveThinkBody preserves scroll position when user scrolled up to read', () => {
  let height = 1000
  const body = {
    ...makeElement(),
    get scrollHeight() { return height },
    set textContent(v) { this._text = v; height += 400 },
    get textContent() { return this._text || '' },
    scrollTop: 100, // far from bottom (1000 - 100 - 200 = 700 > 48)
    clientHeight: 200,
  }
  app.paintLiveThinkBody(body, 'another delta')
  assert.equal(body.textContent, 'another delta')
  // User's scroll position must NOT be yanked
  assert.equal(body.scrollTop, 100)
})

test('handleAssistantFrame preserves outer auto-scroll across large reasoning expansions', () => {
  resetState({ session: { id: 's', state: 'running' } })
  const contentEl = makeElement()
  contentEl.scrollHeight = 500
  contentEl.clientHeight = 500
  contentEl.scrollTop = 0 // at bottom (500 - 0 - 500 = 0 <= 120)

  const liveSlotEl = makeElement()
  let thinkEl = null
  liveSlotEl.querySelector = (sel) => sel === '[data-live-think]' ? thinkEl : makeElement()
  liveSlotEl.insertAdjacentHTML = () => {
    thinkEl = makeElement()
    thinkEl.querySelector = () => makeElement()
    // Simulate a massive reasoning delta that expands content by 600px
    contentEl.scrollHeight += 600
  }

  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => {
    if (sel === '#content') return contentEl
    if (sel === '#live-slot') return liveSlotEl
    return makeElement()
  }

  try {
    app.handleAssistantFrame({ type: 'start' })
    flushRaf()
    app.handleAssistantFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Large thinking content...' } })
    flushRaf()
    // Because stick was measured BEFORE growth, auto-scroll must have followed to the new bottom
    assert.equal(contentEl.scrollTop, contentEl.scrollHeight)
  } finally {
    ctx.document.querySelector = prevQuery
  }
})

test('the shared sync policy is actually loaded for the client', () => {
  assert.ok(ctx.window.__MVC_SYNC__, 'window.__MVC_SYNC__ must exist')
  assert.equal(typeof ctx.window.__MVC_SYNC__.processAssistantFrame, 'function')
})

// ---------------------------------------------------------------------------
// Durability / sync — REGRESSIONS the shared policy exists to fix. The client
// used to re-implement the guards inline and got them wrong: idle sessions and
// in-flight "sending" sessions were skipped, so the phone froze while the
// desktop showed the reply.
// ---------------------------------------------------------------------------
test('syncCurrentSession pulls a snapshot for an IDLE session (frozen-phone regression)', async () => {
  resetState({ session: { id: 's1', state: 'idle' }, follow: null, lastSyncAt: 0 })
  const counter = setFetch({ id: 's1', state: 'idle', blocks: [], approvals: [] })
  await app.syncCurrentSession(false)
  assert.equal(counter.count, 1, 'idle session must still sync the durable snapshot')
})

test('syncCurrentSession keeps working while a prompt is sending (desktop-shows-it regression)', async () => {
  resetState({ session: { id: 's1', state: 'running' }, sending: true, follow: null, lastSyncAt: 0 })
  const counter = setFetch({ id: 's1', state: 'running', blocks: [], approvals: [] })
  await app.syncCurrentSession(false)
  assert.equal(counter.count, 1, 'sending must NOT disable the fallback')
})

test('syncCurrentSession is skipped while a healthy SSE stream just delivered', async () => {
  resetState({ session: { id: 's1', state: 'running' }, follow: {}, lastFollowAt: Date.now(), lastSyncAt: 0 })
  const counter = setFetch({ id: 's1', state: 'running', blocks: [], approvals: [] })
  await app.syncCurrentSession(false)
  assert.equal(counter.count, 0, 'a fresh live stream owns the view')
})

test('syncCurrentSession is skipped during load / while hidden', async () => {
  resetState({ session: { id: 's1', state: 'idle' }, loading: true, lastSyncAt: 0 })
  const c1 = setFetch({ id: 's1', state: 'idle', blocks: [] })
  await app.syncCurrentSession(false)
  assert.equal(c1.count, 0)

  resetState({ session: { id: 's1', state: 'idle' }, lastSyncAt: 0 })
  ctx.document.hidden = true
  const c2 = setFetch({ id: 's1', state: 'idle', blocks: [] })
  await app.syncCurrentSession(false)
  assert.equal(c2.count, 0)
  ctx.document.hidden = false
})

test('forced syncCurrentSession always fetches (manual refresh)', async () => {
  resetState({ session: { id: 's1', state: 'idle' }, loading: true, lastSyncAt: Date.now() })
  const counter = setFetch({ id: 's1', state: 'idle', blocks: [] })
  await app.syncCurrentSession(true)
  assert.equal(counter.count, 1)
})

test('renderTurnRail renders scroll arrows and turn-rail-track wrapper', () => {
  resetState({
    session: { id: 's1', state: 'idle' },
    turns: [
      { index: 0, text: 'Q1' },
      { index: 1, text: 'Q2' },
      { index: 2, text: 'Q3' },
    ],
  })
  const railEl = makeElement()
  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => (sel === '#turn-rail' ? railEl : makeElement())
  try {
    app.renderTurnRail()
    assert.equal(railEl.hidden, false)
    assert.ok(railEl.innerHTML.includes('turn-rail-track'), 'must wrap dashes in turn-rail-track')
    assert.ok(railEl.innerHTML.includes('data-act="rail-scroll-up"'), 'must include up arrow')
    assert.ok(railEl.innerHTML.includes('data-act="rail-scroll-down"'), 'must include down arrow')
  } finally {
    ctx.document.querySelector = prevQuery
  }
})

test('updateRailArrows shows arrows only when track overflows vertically', () => {
  const up = makeElement()
  const down = makeElement()
  const track = makeElement()
  const rail = makeElement()

  // Case 1: no overflow (content fits)
  track.scrollHeight = 200
  track.clientHeight = 200
  track.scrollTop = 0
  rail.querySelector = (sel) => {
    if (sel === '.turn-rail-track') return track
    if (sel === '.turn-rail-arrow.up') return up
    if (sel === '.turn-rail-arrow.down') return down
    return makeElement()
  }

  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => (sel === '#turn-rail' ? rail : makeElement())

  try {
    app.updateRailArrows()
    assert.equal(up.hidden, true, 'up arrow hidden when no overflow')
    assert.equal(down.hidden, true, 'down arrow hidden when no overflow')

    // Case 2: overflows (many turns), at top
    track.scrollHeight = 800
    track.clientHeight = 300
    track.scrollTop = 0
    app.updateRailArrows()
    assert.equal(up.hidden, true, 'up arrow hidden at top')
    assert.equal(down.hidden, false, 'down arrow visible showing more turns below')

    // Case 3: scrolled to middle
    track.scrollTop = 150
    app.updateRailArrows()
    assert.equal(up.hidden, false, 'up arrow visible when scrolled down')
    assert.equal(down.hidden, false, 'down arrow visible when more turns below')

    // Case 4: scrolled to bottom
    track.scrollTop = 500 // 500 + 300 = 800 (reached bottom)
    app.updateRailArrows()
    assert.equal(up.hidden, false, 'up arrow visible at bottom')
    assert.equal(down.hidden, true, 'down arrow hidden at bottom')
  } finally {
    ctx.document.querySelector = prevQuery
  }
})

test('scrollToTurn scrolls only #content and never scrollIntoView (turn rail click regression)', () => {
  const content = makeElement()
  content.scrollTop = 500
  let scrolledTo = null
  content.scrollTo = (opts) => { scrolledTo = opts; content.scrollTop = opts.top }
  content.getBoundingClientRect = () => ({ top: 100, left: 0, width: 390, height: 600, bottom: 700, right: 390 })

  const target = makeElement()
  let scrollIntoViewCalls = 0
  target.scrollIntoView = () => { scrollIntoViewCalls += 1 }
  target.getBoundingClientRect = () => ({ top: 250, left: 0, width: 300, height: 40, bottom: 290, right: 300 })

  const prevQuery = ctx.document.querySelector
  const prevById = ctx.document.getElementById
  ctx.document.querySelector = (sel) => (sel === '#content' ? content : makeElement())
  ctx.document.getElementById = (id) => (id === 'turn-3' ? target : makeElement())

  try {
    app.scrollToTurn(3)
    assert.equal(scrollIntoViewCalls, 0, 'scrollIntoView must NOT be used (it scrolls the whole WebView page)')
    assert.ok(scrolledTo, 'content.scrollTo must be called')
    assert.equal(scrolledTo.behavior, 'smooth')
    assert.equal(content.scrollTop, 500 + (250 - 100) - 12)
  } finally {
    ctx.document.querySelector = prevQuery
    ctx.document.getElementById = prevById
  }
})

test('scrollToTurn clamps negative targets and falls back when scrollTo is unavailable', () => {
  const content = makeElement()
  content.scrollTop = 0
  content.scrollTo = undefined
  content.getBoundingClientRect = () => ({ top: 100, left: 0, width: 390, height: 600, bottom: 700, right: 390 })
  const target = makeElement()
  target.getBoundingClientRect = () => ({ top: 105, left: 0, width: 300, height: 40, bottom: 145, right: 300 })

  const prevQuery = ctx.document.querySelector
  const prevById = ctx.document.getElementById
  ctx.document.querySelector = (sel) => (sel === '#content' ? content : makeElement())
  ctx.document.getElementById = (id) => (id === 'turn-0' ? target : makeElement())

  try {
    app.scrollToTurn(0)
    assert.ok(content.scrollTop >= 0, 'scrollTop must never go negative')
  } finally {
    ctx.document.querySelector = prevQuery
    ctx.document.getElementById = prevById
  }
})

test('syncAppViewport scrolls #content up when virtual keyboard pops up (9767.jpg regression)', () => {
  const content = makeElement()
  content.scrollHeight = 1200
  content.clientHeight = 500
  content.scrollTop = 700 // at bottom (1200 - 700 - 500 = 0 <= 320)

  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => (sel === '#content' ? content : makeElement())

  const prevVv = ctx.window.visualViewport
  ctx.window.innerHeight = 800
  ctx.window.visualViewport = { height: 450, offsetTop: 0 }

  try {
    app.syncAppViewport()
    flushRaf()
    assert.equal(ctx.document.documentElement.style.getPropertyValue('--kb-inset'), '350px')
    assert.equal(ctx.document.body.classList.contains('keyboard-open'), true)
    // Content was near bottom, so it must follow the lifted dock to the bottom
    assert.equal(content.scrollTop, content.scrollHeight)
  } finally {
    ctx.document.querySelector = prevQuery
    ctx.window.visualViewport = prevVv
  }
})

test('syncAppViewport shifts scrollTop by delta when reading history in middle of chat', () => {
  // Ensure keyboard was closed initially so inset starts from 0
  ctx.window.innerHeight = 800
  ctx.window.visualViewport = { height: 800, offsetTop: 0 }
  app.syncAppViewport()
  flushRaf()

  const content = makeElement()
  content.scrollHeight = 2500
  content.clientHeight = 500
  content.scrollTop = 400 // far from bottom (2500 - 400 - 500 = 1600 > 320)

  const prevQuery = ctx.document.querySelector
  ctx.document.querySelector = (sel) => (sel === '#content' ? content : makeElement())

  const prevVv = ctx.window.visualViewport
  // Keyboard expands from inset 0 to 300
  ctx.window.visualViewport = { height: 500, offsetTop: 0 }

  try {
    app.syncAppViewport()
    flushRaf()
    assert.equal(content.scrollTop, 400 + 300, 'must shift by keyboard delta to preserve relative viewport')
  } finally {
    ctx.document.querySelector = prevQuery
    ctx.window.visualViewport = prevVv
  }
})
