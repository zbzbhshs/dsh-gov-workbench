/**
 * cordis-proxy.mjs —— 回归：cordis 的 ctx 是 Proxy，未 inject 的 service
 * 属性访问会**抛错**而不是返回 undefined。
 *
 * 这是一个真实的坑：`lib/host.js` 早期写的是 `ctx?.apiProxy ?? ctx.get(...)`，
 * 在 mock ctx 上完全正常，但在**真 cordis** 下直接抛
 * `cannot get property "apiProxy" without inject`，导致插件在真实挂载时
 * 立刻崩掉。本测试用一个「会抛错的 Proxy ctx」把这个行为钉死，确保
 * 探测逻辑永远走 try/catch + `ctx.get(key, false)`。
 *
 * 不需要真 cordis 依赖，用 Proxy 精确模拟其语义即可。
 *
 * 运行：node test/cordis-proxy.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { createHostBridge } from '../lib/host.js'
import { MuxController } from '../lib/sse.js'

const HERE = dirname(fileURLToPath(import.meta.url))

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

/**
 * 复刻 cordis 的 ctx Proxy 语义：
 *   - 读取**已注入**的 service 名 → 返回实例；
 *   - 读取**未注入**的 service 名 → 抛 `cannot get property "x" without inject`；
 *   - `ctx.get(name, false)` → 缺失时返回 undefined，不抛；
 *   - 其余普通属性（on / effect / get / 非 service 键）正常返回。
 */
function createCordisLikeCtx({ services = {}, declared = [] } = {}) {
  const declaredSet = new Set(declared)
  const base = {
    get(name, strict = true) {
      if (services[name] !== undefined) return services[name]
      if (strict === true && !declaredSet.has(name)) {
        throw new Error(`cannot get property "${name}" without inject`)
      }
      return undefined
    },
    on() {
      return () => undefined
    },
    effect(callback) {
      const cleanup = callback()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(services, prop)) {
        if (!declaredSet.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return services[prop]
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

console.log('\ncordis Proxy 语义回归\n')

test('前提：未 inject 的 service 属性访问确实会抛错（复刻 cordis 行为）', () => {
  const ctx = createCordisLikeCtx({ services: { typertGateway: {} }, declared: [] })
  assert.throws(() => ctx.typertGateway, /without inject/, 'Proxy 未按预期抛错，本测试失去意义')
})

test('createHostBridge 在「属性访问会抛错的 ctx」上不崩，并能探测到 typertGateway', () => {
  const gateway = {
    operatorPeer: () => ({ kind: 'operator' }),
    async dispatchRpc() {
      return { ok: true, value: { ok: true } }
    },
  }
  const ctx = createCordisLikeCtx({ services: { typertGateway: gateway }, declared: [] })
  let bridge
  assert.doesNotThrow(() => {
    bridge = createHostBridge(ctx, { info() {}, warn() {} })
  }, 'createHostBridge 在真 cordis 语义下抛错了 —— 说明用了裸属性访问')
  assert.equal(bridge.kind, 'typertGateway', '应探测到 typertGateway')
})

test('createHostBridge 在完全无网关时降级而不是抛错', () => {
  const ctx = createCordisLikeCtx({ services: {}, declared: [] })
  let bridge
  assert.doesNotThrow(() => {
    bridge = createHostBridge(ctx, { info() {}, warn() {} })
  })
  assert.equal(bridge.kind, 'unavailable')
})

test('老形态 apiProxy 存在时优先选中（同样不得裸访问属性）', () => {
  const apiProxy = { sessions: { list: async () => ({ ok: true, value: {} }) } }
  const ctx = createCordisLikeCtx({ services: { apiProxy, typertGateway: {} }, declared: [] })
  const bridge = createHostBridge(ctx, { info() {}, warn() {} })
  assert.equal(bridge.kind, 'apiProxy')
})

test('MuxController.startProjections 在会抛错的 ctx 上不崩', () => {
  const ctx = createCordisLikeCtx({ services: {}, declared: [] })
  const mux = new MuxController(ctx, { async *hostEvents() {} }, { info() {}, warn() {} })
  assert.doesNotThrow(() => mux.startProjections(), 'startProjections 不得裸访问 ctx.sessionProjections')
})

test('MuxController.startProjections 在投影服务存在时正常订阅', () => {
  let listener
  const ctx = createCordisLikeCtx({
    services: { sessionProjections: { onChanged(fn) { listener = fn; return () => {} } } },
    declared: [],
  })
  const mux = new MuxController(ctx, { async *hostEvents() {} }, { info() {}, warn() {} })
  mux.startProjections()
  assert.equal(typeof listener, 'function', '应订阅到 onChanged')
})

test('MuxController.start 在会抛错的 ctx 上不崩', () => {
  const ctx = createCordisLikeCtx({ services: {}, declared: [] })
  const mux = new MuxController(ctx, { async *hostEvents() {} }, { info() {}, warn() {} })
  assert.doesNotThrow(() => mux.start())
})

test('lib/ 源码里不出现裸的 ctx.<service> 属性访问', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const libDir = join(HERE, '..', 'lib')
  const files = readdirSync(libDir).filter((f) => f.endsWith('.js'))
  // 允许的属性：框架方法与非 service 键。
  const allowed = new Set(['get', 'on', 'effect', 'services', 'dispose', 'emit', 'root', 'logger', 'fiber'])
  const offenders = []
  for (const file of files) {
    const source = readFileSync(join(libDir, file), 'utf8')
    const codeOnly = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
      .join('\n')
    for (const match of codeOnly.matchAll(/\bctx\??\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g)) {
      const prop = match[1]
      if (allowed.has(prop)) continue
      offenders.push(`${file}: ctx.${prop}`)
    }
  }
  assert.deepEqual(offenders, [], `发现可能抛错的裸 service 访问：\n  ${offenders.join('\n  ')}`)
})

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`cordis-proxy: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`cordis-proxy: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
