/**
 * patch-inject.mjs —— 回归：`cordis.patch.yml` 的插件行**不得**用 `!!js` 写 `inject`。
 *
 * ## 为什么要有这个测试
 *
 * 曾经踩过一个致命 bug：patch 里写
 * `inject: !!js "ctx.get('apiProxy', false) ? ['apiProxy'] : []"`，
 * 结果插件**永不激活**。机制（已用真 cordis 4.x + 真 loader + 真 YAML 方言复现）：
 *
 *   1. `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)` 让整个 YAML 文档都按
 *      `!!js` 类型解析，所以 `inject: !!js "..."` 得到的是**对象**
 *      `{ __jsExpr: "..." }`，而不是字符串或数组；
 *   2. loader 的 `interpolate(ctx, value)` **只对 `config` 调用**
 *      （`ctx.on("internal/config", ...) { ... return interpolate(this.ctx, config) }`），
 *      `inject` 不在求值路径上；
 *   3. `disabled` 有专门的 `disabledOf()` 做 `isJsExpr` 判断，**`inject` 没有**；
 *   4. `Inject.resolve({__jsExpr:"..."})` 既不是数组也无 `checkProto`，于是走
 *      「按 Object.keys 注册服务名」的分支 → 把 `__jsExpr` 当成服务名；
 *   5. loader 消费点是
 *      `Inject.resolve(fiber.entry.options.inject, fiber.inject)` ——
 *      只有当 `options.inject` 为 `undefined` 时，插件导出的 `inject` 才生效。
 *
 * ## 依赖缺失时的行为
 *
 * 真 cordis / loader / include 在部分机器上不可解析（本机 `profiles/node_modules`
 * 里不少包是 junction，npx 缓存被清后会失效）。**不可解析时打印 SKIP 并以 0 退出**，
 * 绝不误报失败 —— 这样测试机（可能没装 cordis）也能跑。
 * 但**纯静态检查那部分永远执行**，不依赖任何外部包。
 *
 * 运行：node test/patch-inject.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PATCH_PATH = join(ROOT, 'cordis.patch.yml')

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

const patchText = readFileSync(PATCH_PATH, 'utf8')

/**
 * patch 文件里**去掉注释后**的代码部分。
 * 注释里正是要说明「不能这么写」，会被下面的模式误命中。
 */
const patchCode = patchText
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('#')
  })
  .join('\n')

/* ------------------------------------------------------------------ */
/* 第一部分：纯静态检查（永远执行，不依赖任何外部包）                     */
/* ------------------------------------------------------------------ */

console.log('\n[1] 静态检查：patch 的插件行不得用 !!js 写 inject')

test('cordis.patch.yml 的插件行不含 inject: 字段', () => {
  assert.ok(
    !/^\s*inject\s*:/m.test(patchCode),
    'cordis.patch.yml 的插件行出现了 inject: 字段。\n' +
      '  若值是 !!js 表达式，Inject.resolve 会把 __jsExpr 当成服务名，插件永不激活；\n' +
      '  即使值是 [] 也会覆盖插件导出的 inject。正确做法是整行删掉，\n' +
      '  让 lib/index.js 的 `export const inject = []` 生效。',
  )
})

test('patch 里没有任何 !!js 形式的 inject', () => {
  assert.ok(
    !/inject\s*:\s*!!js/.test(patchCode),
    'cordis.patch.yml 出现 `inject: !!js ...` —— 这是导致插件永不激活的致命写法',
  )
})

test('lib/index.js 导出的 inject 是空数组', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  assert.ok(Array.isArray(mod.inject), 'lib/index.js 的 inject 必须是数组')
  assert.equal(mod.inject.length, 0, 'lib/index.js 的 inject 必须是空数组')
})

test('patch 的插件行 id / name 与插件导出一致', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  assert.ok(/id:\s*gov-workbench/.test(patchText), 'patch 缺少 id: gov-workbench')
  assert.ok(/name:\s*'dsh-gov-workbench'/.test(patchText), "patch 缺少 name: 'dsh-gov-workbench'")
  assert.equal(mod.name, 'gov-workbench')
})

/* ------------------------------------------------------------------ */
/* 第二部分：真 cordis + 真 loader 的端到端验证（不可用时 SKIP）           */
/* ------------------------------------------------------------------ */

console.log('\n[2] 真 cordis / 真 loader 端到端（不可用时 SKIP）')

/**
 * 尝试解析真 cordis 生态的包。
 *
 * 候选位置按「最可能可用」排序：测试机从 npm 装的话在 profile 的 node_modules；
 * 开发机上 `profiles/node_modules` 是 junction 到真实包。
 *
 * @returns `{ Inject, loader, include, yaml }` 或 undefined。
 */
async function loadRealCordis() {
  const require = createRequire(import.meta.url)
  // 从 $DSH_HOME 推导 profile 的 node_modules（开发机与测试机通用），
  // 不硬编码任何用户路径。
  const home = process.env.DSH_HOME
  const profileName = process.env.DSH_PROFILE
  const candidates = []
  if (typeof home === 'string' && home !== '') {
    const normalized = home.replace(/\\/g, '/')
    if (typeof profileName === 'string' && profileName !== '') {
      candidates.push(`${normalized}/profiles/${profileName}/node_modules`)
    }
    candidates.push(`${normalized}/profiles/node_modules`)
  }
  const tryPaths = []
  for (const base of candidates) {
    tryPaths.push({
      cordis: `${base}/@deepseek-ai/cordis/lib/index.js`,
      loader: `${base}/@deepseek-ai/cordis-plugin-loader/lib/index.js`,
      include: `${base}/@deepseek-ai/cordis-plugin-include/lib/index.js`,
      yaml: `${base}/js-yaml/index.js`,
    })
  }
  // 再试裸包名（测试机从 npm 装了依赖时）
  try {
    tryPaths.push({
      cordis: require.resolve('@deepseek-ai/cordis'),
      loader: require.resolve('@deepseek-ai/cordis-plugin-loader'),
      include: require.resolve('@deepseek-ai/cordis-plugin-include'),
      yaml: require.resolve('js-yaml'),
    })
  } catch {
    /* 裸包名不可解析，忽略 */
  }

  for (const paths of tryPaths) {
    try {
      const cordis = await import(pathToFileURL(paths.cordis).href)
      const loader = await import(pathToFileURL(paths.loader).href)
      const include = await import(pathToFileURL(paths.include).href)
      const yaml = await import(pathToFileURL(paths.yaml).href)
      if (typeof cordis.Inject?.resolve !== 'function') continue
      if (typeof loader.isJsExpr !== 'function') continue
      if (include.entryListSchema === undefined) continue
      if (typeof yaml.load !== 'function') continue
      return { Inject: cordis.Inject, loader, include, yaml }
    } catch {
      continue
    }
  }
  return undefined
}

const real = await loadRealCordis()

if (real === undefined) {
  console.log('  SKIP  真 cordis / cordis-plugin-loader / cordis-plugin-include / js-yaml 不可解析')
  console.log('        （测试机上若未安装这些依赖，本条自动跳过，不算失败）')
} else {
  console.log('  已解析到真 cordis 生态，开始端到端验证')

  const { Inject, loader, include, yaml } = real

  test('用真 YAML 方言解析 patch：插件行的 inject 不是 {__jsExpr} 对象', () => {
    const parsed = yaml.load(patchText, { schema: include.entryListSchema })
    assert.ok(Array.isArray(parsed), 'patch 顶层必须是数组')
    const insert = parsed[0]?.insert
    assert.ok(Array.isArray(insert), 'patch 第一段必须是 - insert:')
    const row = insert.find((entry) => entry.id === 'gov-workbench')
    assert.ok(row !== undefined, 'patch 里找不到 id: gov-workbench 的行')

    assert.equal(
      loader.isJsExpr(row.inject),
      false,
      'inject 被解析成 !!js 表达式节点（{__jsExpr}）—— 这会让插件永不激活',
    )
    assert.equal(row.inject, undefined, '插件行的 inject 必须完全缺省，让 lib/index.js 的导出生效')
  })

  test('Inject.resolve(该行.inject ?? 插件导出) 的结果不含 __jsExpr', async () => {
    const parsed = yaml.load(patchText, { schema: include.entryListSchema })
    const row = parsed[0].insert.find((entry) => entry.id === 'gov-workbench')
    const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

    const resolved = Inject.resolve(row.inject ?? mod.inject)
    const names = Object.keys(resolved)
    assert.ok(
      !names.includes('__jsExpr'),
      `Inject.resolve 解析出了 __jsExpr 服务名（实际：${JSON.stringify(names)}）—— 插件会永久等待它`,
    )
    assert.deepEqual(names, [], `插件不应等待任何 service，实际：${JSON.stringify(names)}`)
  })

  test('对照：loader 确实会对 !!js 的 inject 产生 {__jsExpr}（证明该检查有效）', () => {
    // 故意构造一个有问题的 patch，确认检测手段能识别出来。
    const bad = "- insert:\n    - id: probe\n      name: 'probe'\n      inject: !!js \"['apiProxy']\"\n"
    const parsed = yaml.load(bad, { schema: include.entryListSchema })
    const row = parsed[0].insert[0]
    assert.equal(loader.isJsExpr(row.inject), true, '本检测手段无法识别 !!js inject，测试本身失效')
    const names = Object.keys(Inject.resolve(row.inject))
    assert.ok(names.includes('__jsExpr'), 'Inject.resolve 未按预期把 __jsExpr 当服务名')
  })

  test('interpolate 只作用于 config，不作用于 inject（机制确认）', () => {
    const bad = "- insert:\n    - id: probe\n      name: 'probe'\n      inject: !!js \"['x']\"\n      config:\n        n: !!js '1 + 1'\n"
    const parsed = yaml.load(bad, { schema: include.entryListSchema })
    const row = parsed[0].insert[0]
    const fakeCtx = { get: () => undefined }
    const config = loader.interpolate(fakeCtx, row.config)
    assert.equal(config.n, 2, 'config 里的 !!js 应被求值')
    assert.equal(loader.isJsExpr(row.inject), true, 'inject 未被 interpolate 触碰，仍是表达式节点')
  })
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`patch-inject: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`patch-inject: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
