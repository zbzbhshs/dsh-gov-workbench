/**
 * syntax-check.mjs —— 对工程内全部 .js / .mjs 跑一遍语法自检
 *
 * 用 `node --check` 逐文件校验（等价于 V8 的解析阶段），并额外检查：
 *   - 文件必须是 UTF-8 无 BOM；
 *   - 前端脚本不得 import 浏览器产物进宿主插件（反向也成立：
 *     `lib/` 下不得出现 `window` / `document` 引用）；
 *   - 宿主插件不得把 `req.signal` 传给宿主方法。
 *
 * 运行：node test/syntax-check.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 递归收集指定后缀的文件，跳过 node_modules 与 .git。 */
function collect(dir, extensions, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) {
      collect(full, extensions, out)
    } else if (extensions.includes(extname(name))) {
      out.push(full)
    }
  }
  return out
}

const files = collect(ROOT, ['.js', '.mjs']).sort()
let passed = 0
let failed = 0
const failures = []

/** 一个断言包装。 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  \u2713 ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  \u2717 ${name}`)
    console.log(`      ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * 用 `node --check` 校验一个文件。
 *
 * 在受限沙箱里，`spawnSync` 的**管道 stdio** 可能被拒（`EPERM`）—— 这不是
 * 语法错误。此时退回 `stdio: 'inherit'`（沙箱允许继承式 stdio），只取退出码；
 * 两种方式跑的都是同一个 `node --check`，语义不变。
 *
 * @param file - 待校验文件的绝对路径。
 * @returns `{ status, output, via }`；`status` 为 0 表示语法通过。
 */
function checkSyntax(file) {
  const piped = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (piped.error === undefined || piped.error === null) {
    return { status: piped.status, output: piped.stderr || piped.stdout || '', via: 'pipe' }
  }
  if (piped.error.code !== 'EPERM') {
    return { status: piped.status, output: String(piped.error.message ?? piped.error), via: 'pipe' }
  }
  // 沙箱拒绝管道：退回继承式 stdio，仅凭退出码判定。
  const inherited = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  return {
    status: inherited.status,
    output: inherited.status === 0 ? '' : `node --check 失败（stdio 继承模式，退出码 ${String(inherited.status)}）`,
    via: 'inherit',
  }
}

console.log(`\n语法自检：共 ${files.length} 个文件\n`)

let usedFallback = false
for (const file of files) {
  const label = relative(ROOT, file).replace(/\\/g, '/')
  const result = checkSyntax(file)
  if (result.via === 'inherit') usedFallback = true
  check(`node --check ${label}`, () => {
    assert.equal(result.status, 0, `\n${result.output}`)
  })
}

if (usedFallback) {
  console.log('\n  注意：本沙箱拒绝管道 stdio，已退回 stdio:\'inherit\' 模式取退出码；校验方式仍是 node --check。')
}

console.log('\n编码与分层约束\n')

for (const file of files) {
  const label = relative(ROOT, file).replace(/\\/g, '/')
  const buffer = readFileSync(file)
  check(`UTF-8 无 BOM：${label}`, () => {
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      '文件带 UTF-8 BOM',
    )
    // 解码后再编码必须一致，否则说明不是合法 UTF-8。
    const text = buffer.toString('utf8')
    assert.ok(Buffer.from(text, 'utf8').equals(buffer), '文件不是合法 UTF-8')
  })
}

const libFiles = files.filter((file) => relative(ROOT, file).replace(/\\/g, '/').startsWith('lib/'))
const publicFiles = files.filter((file) => relative(ROOT, file).replace(/\\/g, '/').startsWith('public/'))

check('lib/ 下无浏览器全局引用（window / document / localStorage）', () => {
  const offenders = []
  for (const file of libFiles) {
    const text = readFileSync(file, 'utf8')
    // 去掉注释与字符串字面量的粗略近似：这里只关心明显误用。
    for (const needle of ['window.', 'document.', 'localStorage.']) {
      if (text.includes(needle)) offenders.push(`${relative(ROOT, file)}: ${needle}`)
    }
  }
  assert.deepEqual(offenders, [], `发现浏览器全局引用：\n${offenders.join('\n')}`)
})

check('lib/ 不 import api-gateway 的浏览器产物 client.js', () => {
  const offenders = []
  for (const file of libFiles) {
    const text = readFileSync(file, 'utf8')
    if (/from\s+['"][^'"]*dsh-api-gateway\/lib\/client\.js['"]/.test(text)) {
      offenders.push(relative(ROOT, file))
    }
    if (/__ModuleLoader__/.test(text)) offenders.push(relative(ROOT, file))
  }
  assert.deepEqual(offenders, [])
})

check('lib/ 不把 req.signal 传给宿主方法（缺陷 A 约束）', () => {
  const offenders = []
  for (const file of libFiles) {
    const text = readFileSync(file, 'utf8')
    // 直接匹配 `req.signal` 作为实参出现，或作为 bridge 调用的 signal 实参。
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (!line.includes('req.signal')) return
      // 允许在注释里讨论它。
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      offenders.push(`${relative(ROOT, file)}:${index + 1}: ${trimmed}`)
    })
  }
  assert.deepEqual(offenders, [], `发现把 req.signal 当实参使用：\n${offenders.join('\n')}`)
})

check('public/ 脚本不使用 ES module 语法（走经典 script 标签）', () => {
  const offenders = []
  for (const file of publicFiles) {
    const text = readFileSync(file, 'utf8')
    if (/^\s*import\s+[\s\S]{0,40}from\s+['"]/m.test(text)) offenders.push(`${relative(ROOT, file)}: import`)
    if (/^\s*export\s+(default|const|function|class)/m.test(text)) offenders.push(`${relative(ROOT, file)}: export`)
  }
  assert.deepEqual(offenders, [])
})

check('前端模块按依赖顺序在 index.html 中被引用', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
  const order = ['util.js', 'api.js', 'store.js', 'marquee.js', 'float.js', 'panels.js', 'app.js']
  let cursor = -1
  for (const file of order) {
    const at = html.indexOf(`/js/${file}`)
    assert.ok(at !== -1, `index.html 未引用 ${file}`)
    assert.ok(at > cursor, `${file} 的引用顺序不对（应在上一模块之后）`)
    cursor = at
  }
})

check('cordis.patch.yml 存在且用 insert 插入插件行', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(/^- insert:/m.test(text), '缺少顶层 - insert:')
  assert.ok(/name:\s*'dsh-gov-workbench'/.test(text), '缺少插件行 name')
  assert.ok(/id:\s*gov-workbench/.test(text), '缺少插件行 id')
  assert.ok(/port:\s*3091/.test(text), '默认端口应为 3091')
})

check('package.json 声明了 dsh.bundle.patch 与 type: module', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(typeof pkg.engines.node === 'string' && pkg.engines.node.length > 0)
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('public'))
  assert.ok(pkg.exports['.'] !== undefined)
})

check('package.json 的 exports / files / main / patch 路径全部真实存在', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const missing = []
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : value.default
    if (typeof target !== 'string' || !target.startsWith('./')) continue
    if (!existsSync(join(ROOT, target))) missing.push(`exports["${key}"] -> ${target}`)
  }
  for (const entry of pkg.files ?? []) {
    if (!existsSync(join(ROOT, entry))) missing.push(`files -> ${entry}`)
  }
  if (!existsSync(join(ROOT, pkg.main))) missing.push(`main -> ${pkg.main}`)
  if (!existsSync(join(ROOT, pkg.dsh.bundle.patch))) missing.push(`dsh.bundle.patch -> ${pkg.dsh.bundle.patch}`)
  assert.deepEqual(missing, [], `package.json 指向了不存在的路径：\n  ${missing.join('\n  ')}`)
})

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`syntax-check: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`syntax-check: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.name}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
