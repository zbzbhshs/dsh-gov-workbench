/**
 * frontend-wiring.mjs —— 前端接线自检（静态分析，无需浏览器）
 *
 * 前端是零构建的经典脚本，没有编译期检查，最容易出的错就是
 * 「JS 里 `getElementById` 的 id 在 HTML 里不存在」—— 运行时报 null。
 * 本脚本把这条静态化：
 *   1. `util.$('x')` / `util.qs('#x')` 引用的 id 必须在 index.html 里存在；
 *   2. `document.querySelectorAll('.a')` 用到的类名必须在 CSS 或 HTML 里出现；
 *   3. 全局对象（GovUtil / GovApi / ...）的定义与消费顺序一致；
 *   4. `data-page` / `data-page-link` 的目标页面必须存在。
 *
 * 运行：node test/frontend-wiring.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const html = read('public/index.html')
const css = read('public/css/gov.css')
const appJs = read('public/js/app.js')
const panelsJs = read('public/js/panels.js')
const utilJs = read('public/js/util.js')

let passed = 0
let failed = 0
const failures = []

function test(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  \u2713 ${label}`)
  } catch (error) {
    failed += 1
    failures.push({ label, error })
    console.log(`  \u2717 ${label}`)
    console.log(`      ${error && error.message ? error.message : String(error)}`)
  }
}

/** 收集 html 里出现的所有 id。 */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))

/** 收集 html 里出现的所有 class。 */
const htmlClasses = new Set()
for (const match of html.matchAll(/\bclass="([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name) htmlClasses.add(name)
}

/** 收集 css 里的类选择器。 */
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]))

/** 从一段 JS 里抽取 util.$('id') 与 util.qs('#id') 引用。 */
function referencedIds(source) {
  const ids = new Set()
  for (const match of source.matchAll(/util\.\$\('([^']+)'\)/g)) ids.add(match[1])
  for (const match of source.matchAll(/util\.qs\('#([^']+)'/g)) ids.add(match[1])
  return ids
}

console.log('\n前端接线自检\n')

test('app.js 引用的每个 DOM id 都存在于 index.html', () => {
  const missing = []
  for (const id of referencedIds(appJs)) {
    if (!htmlIds.has(id)) missing.push(id)
  }
  assert.deepEqual(missing, [], `index.html 缺少这些 id（app.js 会拿到 null）：\n  ${missing.join('\n  ')}`)
})

test('panels.js 引用的 DOM id 也都存在', () => {
  const missing = []
  for (const id of referencedIds(panelsJs)) {
    if (!htmlIds.has(id)) missing.push(id)
  }
  assert.deepEqual(missing, [], `index.html 缺少：${missing.join(', ')}`)
})

test('app.js 用到的类选择器在 CSS 或 HTML 中有定义', () => {
  const selectors = new Set()
  for (const match of appJs.matchAll(/util\.qsa?\('\.([A-Za-z][A-Za-z0-9_-]*)/g)) selectors.add(match[1])
  for (const match of appJs.matchAll(/util\.qsa?\('([a-z]+)\.([A-Za-z][A-Za-z0-9_-]*)/g)) selectors.add(match[2])
  const missing = [...selectors].filter((name) => !cssClasses.has(name) && !htmlClasses.has(name))
  assert.deepEqual(missing, [], `未定义的类选择器：${missing.join(', ')}`)
})

test('每个 data-page 栏目标签都有对应的页面 section', () => {
  const navTargets = [...html.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1])
  const sections = new Set([...html.matchAll(/<section[^>]*data-page="([^"]+)"/g)].map((m) => m[1]))
  assert.ok(navTargets.length >= 6, `导航项过少：${navTargets.length}`)
  for (const target of navTargets) {
    assert.ok(sections.has(target), `导航项 ${target} 没有对应的 <section data-page="${target}">`)
  }
  // 首页默认激活
  assert.ok(/class="gov-page is-active" data-page="home"/.test(html), '首页 section 应默认 is-active')
})

test('data-page-link 目标都是真实栏目', () => {
  const sections = new Set([...html.matchAll(/<section[^>]*data-page="([^"]+)"/g)].map((m) => m[1]))
  const links = [...html.matchAll(/data-page-link="([^"]+)"/g)].map((m) => m[1])
  assert.ok(links.length > 0, '首页应有常用通道跳转')
  for (const link of links) {
    assert.ok(sections.has(link), `data-page-link="${link}" 指向不存在的栏目`)
  }
})

test('前端脚本的全局对象定义先于消费', () => {
  const order = ['util.js', 'api.js', 'store.js', 'marquee.js', 'float.js', 'panels.js', 'app.js']
  const positions = order.map((file) => {
    const at = html.indexOf(`/js/${file}`)
    assert.ok(at !== -1, `index.html 未引用 ${file}`)
    return at
  })
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `${order[i]} 应在 ${order[i - 1]} 之后加载`)
  }
})

test('每个前端模块都挂载了对应的全局对象', () => {
  const expectations = [
    ['public/js/util.js', 'global.GovUtil'],
    ['public/js/api.js', 'global.GovApi'],
    ['public/js/store.js', 'global.GovStore'],
    ['public/js/marquee.js', 'global.GovMarquee'],
    ['public/js/float.js', 'global.GovFloat'],
    ['public/js/panels.js', 'global.GovPanels'],
  ]
  for (const [file, needle] of expectations) {
    assert.ok(read(file).includes(needle), `${file} 未导出 ${needle}`)
  }
})

test('panels.js 导出的函数都被 app.js 用到或明确保留', () => {
  const exported = [...panelsJs.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1])
  assert.ok(exported.length > 10, `panels.js 导出过少：${exported.length}`)
  const used = exported.filter((name) => appJs.includes(`panels.${name}`))
  // 至少要有一半被真正用上，否则说明导出了死代码
  assert.ok(used.length >= exported.length / 2, `panels.js 导出 ${exported.length} 个，app.js 只用了 ${used.length} 个：未用 ${exported.filter((n) => !used.includes(n)).join(', ')}`)
})

test('util.js 的对外 API 覆盖 app/panels 实际调用', () => {
  const utilExports = new Set([...utilJs.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]))
  const callers = appJs + panelsJs
  const called = new Set([...callers.matchAll(/util\.([a-zA-Z]+)\(/g)].map((m) => m[1]))
  const missing = [...called].filter((name) => !utilExports.has(name))
  assert.deepEqual(missing, [], `util 缺少这些方法：${missing.join(', ')}`)
})

test('HTML 引用的前端模块文件都真实存在', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
  assert.ok(scripts.length >= 7, `脚本过少：${scripts.length}`)
  for (const src of scripts) {
    const text = read(`public${src}`)
    assert.ok(text.length > 100, `${src} 内容过短`)
  }
  const links = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1])
  for (const href of links) {
    assert.ok(read(`public${href}`).length > 100, `${href} 内容过短`)
  }
})

test('api.js 的 settings 写入端点把位置参数组装成 payload 对象', () => {
  const raw = read('public/js/api.js')
  // 只看代码：注释里正是要说明「不能这么写」，会被下面的模式误命中。
  const apiJs = raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  // settings.update/replace/mutate 的宿主签名是位置参数，wire payload 必须是
  // 键名与描述符 wire 名一致的对象；若写成 (p, s) => unary('settings.update', p, s)，
  // 传进来的 ns 字符串会被当 payload，服务端 buildArgs 会丢掉它 → arguments-invalid。
  for (const name of ['update', 'replace', 'mutate']) {
    const re = new RegExp(`\\b${name}:\\s*function\\s*\\(([^)]*)\\)`)
    const match = re.exec(apiJs)
    assert.ok(match !== null, `api.js 缺少 settings.${name}`)
    const params = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    assert.ok(params.length >= 3, `settings.${name} 应接受位置参数（ns, ...），实际只有 ${params.join(', ')}`)
  }
  assert.ok(/ns:\s*ns/.test(apiJs), 'settings 写入必须把 ns 放进 payload 对象')
  assert.ok(/patch:\s*patch/.test(apiJs), 'settings.update 必须把 patch 放进 payload 对象')
})

test('app.js 调用 settings.update 时传位置参数而非裸 payload', () => {
  const call = /api\.settings\.update\(([^)]*)\)/.exec(appJs)
  assert.ok(call !== null, 'app.js 应调用 settings.update')
  const args = call[1].split(',').map((s) => s.trim())
  assert.ok(args.length >= 2, `settings.update 应至少传 (ns, patch)，实际：${call[1]}`)
  assert.ok(/^'|^"/.test(args[0]), `第一个参数应是命名空间字符串，实际：${args[0]}`)
})

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`frontend-wiring: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`frontend-wiring: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
