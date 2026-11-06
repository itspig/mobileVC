import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../plugin/index.mjs'

const { mdToHtml } = __test

// ---------------------------------------------------------------------------
// REGRESSION: a fenced code block whose lines start with '#' (shell comments,
// "# tests 16  # pass 16") was corrupted by the heading regex running AFTER
// the fence had been converted to <pre><code>. The injected <div class="md-h">
// with unbalanced tags broke the whole timeline DOM and rendered the phone UI
// as unreadable narrow vertical columns.
// ---------------------------------------------------------------------------

const brokenInput = [
  '新增 `tests/session-log.test.mjs`（7 个用例）。',
  '',
  '```bash',
  '# KR 上 node --test tests/*.test.mjs',
  '# tests 16  # pass 16  # fail 0',
  '```',
  '',
  '修复前 vso 旧实现跑这条多帧用例必失败。',
  '',
  '## 改动文件',
  '',
  '- `plugin/index.mjs`',
].join('\n')

test('code block lines starting with # are NOT turned into headings', () => {
  const html = mdToHtml(brokenInput)
  const pre = (html.match(/<pre>[\s\S]*?<\/pre>/g) || []).join('')
  assert.match(pre, /# tests 16/)
  assert.doesNotMatch(pre, /<div|<strong/)
  assert.match(html, /<div class="md-h">改动文件<\/div>/)
})

test('every opened tag is balanced (no stray div inside pre)', () => {
  const html = mdToHtml(brokenInput)
  const opens = (html.match(/<div\b/g) || []).length
  const closes = (html.match(/<\/div>/g) || []).length
  assert.equal(opens, closes, 'unbalanced <div> tags corrupt the timeline DOM')
  assert.equal((html.match(/<pre>/g) || []).length, (html.match(/<\/pre>/g) || []).length)
  assert.equal((html.match(/<code>/g) || []).length, (html.match(/<\/code>/g) || []).length)
})

test('real markdown headings outside code blocks still work', () => {
  const html = mdToHtml('## 改动文件\n\n正文')
  assert.match(html, /<div class="md-h">改动文件<\/div>/)
  assert.match(html, /<p>正文<\/p>/)
})

test('inline code and bold are not corrupted by fenced blocks', () => {
  const html = mdToHtml('看 `node --test` 和 **全部通过**\n\n```\n# comment\n```')
  assert.match(html, /<code>node --test<\/code>/)
  assert.match(html, /<strong>全部通过<\/strong>/)
  assert.match(html, /# comment/)
  assert.doesNotMatch(html, /<pre><code>[\s\S]*?<strong>/)
})

test('unclosed fence after truncation stays plain text (no injected pre)', () => {
  const html = mdToHtml('```bash\n# never closed', 30)
  assert.equal((html.match(/<pre>/g) || []).length, 0)
})

test('html-special chars in code are escaped', () => {
  const html = mdToHtml('```\n<div onclick="x"> & <script>\n```')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;div/)
})

test('mdToHtml renders markdown tables with balanced tags and alignment (9760.jpg)', () => {
  const sample = [
    '| 测试文件 | 通过/总数 | 状态 |',
    '| :--- | :---: | ---: |',
    '| app-live.test.mjs（手机端渲染） | 52/52 | **完成** |',
    '| event-patch.test.mjs | 17/17 | `通过` |',
  ].join('\n')

  const html = mdToHtml(sample)
  assert.ok(html.includes('<div class="table-wrap"><table>'), 'must wrap in table-wrap and table')
  assert.ok(html.includes('<thead><tr><th>测试文件</th><th style="text-align:center">通过/总数</th><th style="text-align:right">状态</th></tr></thead>'))
  assert.ok(html.includes('<td>app-live.test.mjs（手机端渲染）</td><td style="text-align:center">52/52</td><td style="text-align:right"><strong>完成</strong></td>'))
  assert.ok(html.includes('<code>通过</code>'))

  // Balanced tags guard
  const opens = (html.match(/<div\b/g) || []).length
  const closes = (html.match(/<\/div>/g) || []).length
  assert.equal(opens, closes)
  assert.equal((html.match(/<table\b/g) || []).length, (html.match(/<\/table>/g) || []).length)
  assert.equal((html.match(/<tr\b/g) || []).length, (html.match(/<\/tr>/g) || []).length)
  assert.equal((html.match(/<td\b/g) || []).length, (html.match(/<\/td>/g) || []).length)
})

test('mdToHtml renders blockquotes, links, and horizontal rules', () => {
  const md = '> 这是一条引用说明\n\n---\n\n请访问 [MobileVC](https://mobilevc.top)'
  const html = mdToHtml(md)
  assert.ok(html.includes('<blockquote>这是一条引用说明</blockquote>'))
  assert.ok(html.includes('<hr class="md-hr">'))
  assert.ok(html.includes('<a class="md-link" href="https://mobilevc.top" target="_blank" rel="noopener noreferrer">MobileVC</a>'))
})
