/**
 * host-descriptor.mjs —— 用**宿主真实描述符**校验插件的端点表与参数投影。
 *
 * ## 为什么需要它
 *
 * 插件的端点表（`lib/host.js` 的 `TYPERT_NAMESPACE_ALIASES`）与前端调用的
 * 端点名，都必须是宿主**真的注册过**的东西。写错一个字母的代价不是报错，而是
 * 一条永远失败的 UI 路径 —— 真机上表现为「装上了但没什么用」。
 *
 * 本测试直接读 dsh 发行版里的 `app.asar`，把 26 个宿主包的
 * `lib/typert.host.js` 里的 `invocations[]` 全部解出来，然后：
 *
 *   1. 别名表里的每个 namespace 都必须在宿主真实注册过；
 *   2. 前端 `api.js` 调用的每个端点都必须在目录里；
 *   3. `buildArgs` 对 `acceptsUndefined` 的 wire 必须整个省略（不能塞占位对象）；
 *   4. `buildArgs` 对单 wire / 多 wire / context scope 三种形状都要投影正确。
 *
 * ## 找不到 app.asar 时
 *
 * 打印 SKIP 并以 0 退出 —— 测试机上可能没装 dsh 桌面版。但**静态那部分
 * （别名表 vs api.js 的自洽性）永远执行**，不依赖 app.asar。
 *
 * 运行：node test/host-descriptor.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { buildArgs, toNamespace } from '../lib/host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let passed = 0
let failed = 0
const failures = []

function test (label, fn) {
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

/* ------------------------------------------------------------------ */
/* 1. 定位 app.asar                                                    */
/* ------------------------------------------------------------------ */

/**
 * 找 dsh 发行版里的 `app.asar`。
 *
 * 候选顺序：环境变量 → 运行中的 dsh 进程命令行 → $DSH_HOME 下的 Electron 运行时。
 * Electron 运行时。**每个候选都要先验证它真的含 dsh 的 typert 描述符**：
   * 机器上可能同时装着别的 Electron 应用，只看文件名会把它们误当成 dsh，
   * 所以每个候选都要验证它真的含 dsh 的 typert 描述符。
 *
 * 全部候选都不合格时返回 undefined（测试降级为 SKIP）。
 *
 * @returns `{ path, buffer, header, base, files }`，或 undefined。
 */
function locateAsar () {
  const candidates = []
  if (typeof process.env.DSH_ASAR === 'string' && process.env.DSH_ASAR !== '') candidates.push(process.env.DSH_ASAR)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
      // 某些发行版把 Electron 运行时放在一个可选的伴随目录下；这里只做一个通用候选，
      // 真正的判定交给下面的「必须含 dsh typert 描述符」校验。
      candidates.push(join(process.env.DSH_HOME, 'electron-runtime', 'resources', 'app.asar'))
  }
  // 从运行中的 dsh 进程命令行里取（最可靠：正在跑的这份就是真实发行版）。
  // 注意要扫**全部**候选：机器上可能同时跑着别的 Electron 应用，先出现的未必是 dsh。
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*app.asar*' } | ForEach-Object { $_.CommandLine })",
    ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    for (const match of out.matchAll(/"([A-Za-z]:\\[^"]*?app\.asar)/g)) candidates.push(match[1])
  } catch {
    /* 取不到进程信息（非 Windows / 权限不足），忽略 */
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !existsSync(candidate)) continue
    let parsed
    try {
      parsed = parseAsar(candidate)
    } catch {
      continue
    }
    // 只认真的含 dsh typert 描述符的 asar。
    if (parsed.entries.length > 0) return { path: candidate, ...parsed }
  }
  return undefined
}

/**
 * 解析 asar 的头部索引，列出所有 `lib/typert.host.js`。
 *
 * @param asarPath - asar 绝对路径。
 * @returns `{ buffer, header, base, entries }`。
 */
function parseAsar (asarPath) {
  const buffer = readFileSync(asarPath)
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8').replace(/\0+$/, ''))
  const base = 16 + headerSize
  const entries = []
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files ?? {})) {
      const child = node.files[key]
      const path = prefix + '/' + key
      if (child.files) walk(child, path)
      else if (/@deepseek-ai\/[^/]+\/lib\/typert\.host\.js$/.test(path)) entries.push({ path, ...child })
    }
  }
  walk(header, '')
  return { buffer, header, base, entries }
}

/**
 * 把 asar 里所有 `lib/typert.host.js` 的 descriptor 抽成目录。
 *
 * @param parsed - `parseAsar` 的返回值。
 * @returns `Map<'<ns>/<method>', { invocation, parameters }>`。
 */
function readDescriptorCatalog (parsed) {
  const { buffer, base, entries } = parsed
  const catalog = new Map()
  for (const entry of entries) {
    const text = buffer
      .subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size))
      .toString('utf8')
    const re = /namespace: '([^']+)',\n\s*method: '([^']+)',/g
    let m
    while ((m = re.exec(text)) !== null) {
      const tail = text.slice(m.index, m.index + 6000)
      const invocation = /invocation: \{([^}]*)\}/.exec(tail)
      const scope = /scope: \{([\s\S]*?)\},\n\s*parameters/.exec(tail)
      const pStart = tail.indexOf('parameters: [')
      const parameters = []
      if (pStart !== -1) {
        const open = tail.indexOf('[', pStart)
        let depth = 0
        let end = open
        for (; end < tail.length; end += 1) {
          if (tail[end] === '[') depth += 1
          else if (tail[end] === ']') {
            depth -= 1
            if (depth === 0) break
          }
        }
        const block = tail.slice(open, end + 1)
        for (const pm of block.matchAll(/\{\s*name: '([^']*)',\s*wire: '([^']*)',\s*source: '([^']*)',([\s\S]*?)\n\s{8}\}/g)) {
          parameters.push({ name: pm[1], wire: pm[2], source: pm[3], acceptsUndefined: /acceptsUndefined: true/.test(pm[4]) })
        }
      }
      const kind = invocation ? /kind: '([^']*)'/.exec(invocation[1])?.[1] : undefined
      // 描述符有两种「身份字段」声明方式（`dsh-typert-registry` 的
      // `validateInvocation` 实测）：
      //   - `invocation: { kind: 'context', context, wire }` —— 参数表里没有它；
      //   - 顶层 `scope: { context, wire }`（要求 kind 是 'direct'）—— 该 wire
      //     **同时也是参数表里唯一的 lookup 参数**，所以已经算进 expected 集合。
      const invocationContextWire = invocation && /context: '[^']*',\s*wire: '([^']+)'/.test(invocation[1])
        ? /wire: '([^']+)'/.exec(invocation[1])?.[1]
        : undefined
      const scopeWire = scope ? /wire: '([^']+)'/.exec(scope[1])?.[1] : undefined
      catalog.set(`${m[1]}/${m[2]}`, {
        invocation: { kind, ...(invocationContextWire === undefined ? {} : { wire: invocationContextWire }) },
        ...(scopeWire === undefined ? {} : { scope: { wire: scopeWire } }),
        parameters,
      })
    }
  }
  return catalog
}

/* ------------------------------------------------------------------ */
/* 2. 静态部分：别名表与前端调用自洽（永远执行）                          */
/* ------------------------------------------------------------------ */

console.log('\n[1] 静态：前端调用名与别名表自洽（不依赖 app.asar）')

const apiJs = read('public/js/api.js')
const appJs = read('public/js/app.js')

/** 从 api.js 里抽出所有 `unary('<domain>.<method>', ...)` 的 wire 名。 */
const frontendCalls = [...apiJs.matchAll(/unary\('([A-Za-z]+)\.([A-Za-z]+)'/g)].map((m) => `${m[1]}.${m[2]}`)

test('api.js 里每个 unary 调用的域名都在别名表里有定义', () => {
  const missing = []
  for (const call of frontendCalls) {
    const domain = call.split('.')[0]
    // 插件自有端点走独立分支，不经过别名表。
    if (domain === 'workbench') continue
    if (toNamespace(domain) === domain && !read('lib/host.js').includes(`${domain}:`)) {
      missing.push(call)
    }
  }
  assert.deepEqual(missing, [], `这些域名在 lib/host.js 的别名表里查不到，会被原样透传给宿主：\n  ${missing.join('\n  ')}`)
})

test('前端不再引用幽灵端点', () => {
  const ghosts = ['skill.list', 'subagent.list', 'workspace.list', 'host.describe', 'host.listDirectory']
  const found = ghosts.filter((ghost) => apiJs.includes(`'${ghost}'`))
  assert.deepEqual(found, [], `api.js 仍在调用不存在的端点：${found.join(', ')}`)
})

test('前端调用的端点名与 lib/host.js 的注释清单一致（skills 是复数）', () => {
  assert.ok(frontendCalls.includes('skills.list'), 'skills 的真实 namespace 是复数 skills/list')
  assert.ok(frontendCalls.includes('agentPreset.select'), 'agentPresets/select 的 wire 域名是单数 agentPreset')
  assert.ok(frontendCalls.includes('directoryPicker.list'), 'directoryPicker 域必须保留原名')
})

test('app.js 不直接拼端点字符串（一律走 api 包装）', () => {
  const raw = [...appJs.matchAll(/unary\('([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(raw, [], `app.js 应通过 GovApi 调用，不应直接 unary：${raw.join(', ')}`)
})

/* ------------------------------------------------------------------ */
/* 3. 动态部分：与宿主真实描述符对照（找不到 app.asar 时 SKIP）           */
/* ------------------------------------------------------------------ */

console.log('\n[2] 动态：与宿主真实描述符对照（找不到 app.asar 时 SKIP）')

const located = locateAsar()
if (located === undefined) {
  console.log('  SKIP  未找到含 dsh typert 描述符的 app.asar（可用 DSH_ASAR 环境变量指定）')
  console.log('        （测试机上未安装 dsh 桌面版时自动跳过，不算失败）')
} else {
  console.log(`  已定位：${located.path}（${located.entries.length} 个宿主包的 typert.host.js）`)
  const catalog = readDescriptorCatalog(located)
  console.log(`  解出 ${catalog.size} 个端点`)
  const bridge = { describeEndpoint: (endpoint) => catalog.get(endpoint) }

  test('别名表里的每个 namespace 都真的被宿主注册过', () => {
    const namespaces = new Set([...catalog.keys()].map((key) => key.slice(0, key.indexOf('/'))))
    const source = read('lib/host.js')
    const table = /const TYPERT_NAMESPACE_ALIASES = Object\.freeze\(\{([\s\S]*?)\}\)/m.exec(source)
    assert.ok(table !== null, 'lib/host.js 里找不到 TYPERT_NAMESPACE_ALIASES')
    const entries = [...table[1].matchAll(/([A-Za-z]+):\s*'([^']+)'/g)].map((m) => ({ from: m[1], to: m[2] }))
    assert.ok(entries.length >= 20, `别名表过短：${entries.length}`)
    const ghosts = entries.filter((entry) => !namespaces.has(entry.to))
    assert.deepEqual(ghosts.map((e) => `${e.from} → ${e.to}`), [], `这些映射指向宿主没有的 namespace：\n  ${ghosts.map((e) => `${e.from} → ${e.to}`).join('\n  ')}`)
  })

  test('前端调用的每个端点都存在于宿主目录', () => {
    const missing = frontendCalls
      .filter((call) => call.split('.')[0] !== 'workbench')
      .map((call) => {
        const [domain, method] = call.split('.')
        return `${toNamespace(domain)}/${method}`
      })
      .filter((endpoint) => !catalog.has(endpoint))
    assert.deepEqual(missing, [], `前端调用了宿主不存在的端点：\n  ${missing.join('\n  ')}`)
  })

  test('buildArgs 对 acceptsUndefined 的 wire 整个省略（directoryPicker/list 的真实形状）', () => {
    const descriptor = catalog.get('directoryPicker/list')
    assert.ok(descriptor !== undefined, '宿主目录里没有 directoryPicker/list')
    assert.equal(descriptor.parameters.length, 1)
    assert.equal(descriptor.parameters[0].acceptsUndefined, true, 'directoryPicker/list 的 path 应声明 acceptsUndefined')
    assert.deepEqual(buildArgs(bridge, 'directoryPicker/list', {}), {}, '空 payload 必须投影成 {} —— 不能塞 {path:{}}')
    assert.deepEqual(buildArgs(bridge, 'directoryPicker/list', { path: 'D:\\x' }), { path: 'D:\\x' })
  })

  test('buildArgs 对 agentPresets/select 的两个 wire 投影正确（含 scope 字段）', () => {
    const descriptor = catalog.get('agentPresets/select')
    assert.ok(descriptor !== undefined, '宿主目录里没有 agentPresets/select')
    // 真实描述符形状：`invocation: {kind:'direct'}` + 独立的顶层 `scope`
    // `{ context:'agent', wire:'agentId' }`，而 `agentId` **同时也是参数表里
    // 唯一的 lookup 参数**（typert-registry 的 validateInvocation 强制这一点）。
    // 所以 buildArgs 只要按参数表投影，scope 身份就自然带上了。
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.scope.wire, 'agentId', 'scope 的 wire 是 agentId')
    const wires = descriptor.parameters.map((p) => p.wire)
    assert.deepEqual(wires, ['agentId', 'agentPreset'])
    assert.equal(descriptor.parameters[0].source, 'lookup', 'agentId 是 lookup 参数（会话身份）')
    assert.deepEqual(
      buildArgs(bridge, 'agentPresets/select', { agentId: 's1', agentPreset: 'standard' }),
      { agentId: 's1', agentPreset: 'standard' },
    )
    // 旧的错误形状：sessionId 会被裁掉，只剩 agentPreset → 宿主报 missing "agentId"
    assert.deepEqual(
      buildArgs(bridge, 'agentPresets/select', { sessionId: 's1', agentPreset: 'standard' }),
      { agentPreset: 'standard' },
    )
  })

  test('buildArgs 对单 wire 端点整体包一层（session/prompt 的真实形状）', () => {
    const descriptor = catalog.get('session/prompt')
    assert.ok(descriptor !== undefined, '宿主目录里没有 session/prompt')
    assert.deepEqual(descriptor.parameters.map((p) => p.wire), ['request'])
    const payload = { requestId: 'r', sessionId: 's', mode: 'queue', content: [{ type: 'text', text: 'x' }] }
    assert.deepEqual(buildArgs(bridge, 'session/prompt', payload), { request: payload })
    // 已经带 wire 名时原样用。
    assert.deepEqual(buildArgs(bridge, 'session/prompt', { request: payload }), { request: payload })
  })

  test('buildArgs 对无参数端点清空多余字段', () => {
    for (const endpoint of ['session/modelCatalog', 'permissionPresets/catalog', 'settings/describe']) {
      const descriptor = catalog.get(endpoint)
      assert.ok(descriptor !== undefined, `宿主目录里没有 ${endpoint}`)
      assert.deepEqual(descriptor.parameters, [], `${endpoint} 应无参数`)
      assert.deepEqual(buildArgs(bridge, endpoint, { bogus: 1 }), {}, `${endpoint} 的多余字段必须被清掉`)
    }
  })

  test('buildArgs 对 settings 写入的三个位置参数保留全部 wire', () => {
    const descriptor = catalog.get('settings/update')
    assert.ok(descriptor !== undefined, '宿主目录里没有 settings/update')
    assert.deepEqual(descriptor.parameters.map((p) => p.wire), ['ns', 'patch', 'expectedRevision'])
    assert.deepEqual(
      buildArgs(bridge, 'settings/update', { ns: 'permission', patch: { defaultPreset: 'read-only' } }),
      { ns: 'permission', patch: { defaultPreset: 'read-only' } },
      'expectedRevision 可缺席，缺了就不带',
    )
    assert.deepEqual(
      buildArgs(bridge, 'settings/update', { ns: 'n', patch: {}, expectedRevision: 3 }),
      { ns: 'n', patch: {}, expectedRevision: 3 },
    )
  })

  test('buildArgs 对 session/list 的 _request wire 投影成 _request 对象', () => {
    const descriptor = catalog.get('session/list')
    assert.ok(descriptor !== undefined, '宿主目录里没有 session/list')
    assert.deepEqual(descriptor.parameters.map((p) => p.wire), ['_request'])
    assert.deepEqual(buildArgs(bridge, 'session/list', {}), { _request: {} })
    assert.deepEqual(buildArgs(bridge, 'session/list', { cursor: 'abc' }), { _request: { cursor: 'abc' } })
  })
}

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`host-descriptor: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`host-descriptor: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
