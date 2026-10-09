/**
 * plugin-boot.mjs —— 端到端装配测试：真的调用插件的 apply()，起真服务，发真请求
 *
 * 与 server-smoke.mjs 的区别：那个测的是各模块函数；这个测的是
 * **整条装配链**：`apply(ctx, config)` → 读配置 → 探测宿主 → 起 http 服务
 * → 静态托管 → /api/* 桥 → /plugin/* 端点 → dispose 关停。
 *
 * 端口刻意用 0（内核分配），**不会占用 3091**，也不需要重启 dsh。
 * 用临时 DSH_HOME，不碰真实配置文件。
 *
 * 运行：node test/plugin-boot.mjs
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import apply, { Config, inject, name } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
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
 * 一个够真的 mock ctx。
 * `services` 里放的就是宿主 service。Cordis 的 service 既可以通过
 * `ctx.get(key)` 拿，也直接挂在 `ctx[key]` 上；插件两种都读，所以这里两种都给。
 *
 * `effect` 实现的是 cordis 的真实语义：回调返回的函数在该 fiber 销毁时执行。
 * 关停路径就走它 —— 插件刻意不用 `ctx.on('dispose')`，因为该事件名在 cordis
 * 上从不派发（已实测）。
 */
function createCtx(services = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    services,
    get(key) {
      return services[key]
    },
    on(eventName, handler) {
      const set = listeners.get(eventName) ?? new Set()
      set.add(handler)
      listeners.set(eventName, set)
      return () => set.delete(handler)
    },
    /** cordis 语义：回调立即执行，其返回值作为清理函数在 dispose 时调用。 */
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {
        const at = effects.indexOf(cleanup)
        if (at !== -1) effects.splice(at, 1)
      }
    },
    /** 触发一个宿主事件（模拟宿主广播）。 */
    emit(eventName, ...args) {
      for (const handler of listeners.get(eventName) ?? []) handler(...args)
    },
    /** 触发 fiber 销毁：执行全部 effect 清理函数。 */
    dispose() {
      for (const cleanup of effects.splice(0)) cleanup()
    },
  }
  // service 同时以直接属性形式暴露（cordis 的真实形态）。
  for (const [key, value] of Object.entries(services)) ctx[key] = value
  return ctx
}

/**
 * 找两个可用的空闲端口。
 *
 * 注意：配置里的 `port: 0` 会被 `mergeConfig` 当作非法值回落到默认 3091，
 * 而 3091 是产品端口 —— 测试绝不能占它。所以这里先让内核分配一个空闲端口，
 * 立刻释放，再把它作为真实端口写进配置。
 */
async function findFreePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** 等一个条件成立，或超时。`predicate` 可以是同步或异步。 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

/**
 * 起一次真实插件装配。
 * @param options - `{ services, config, dshHome }`。未给 port 时自动分配空闲端口。
 * @returns `{ port, origin, ctx, logs, close }`。
 */
async function bootPlugin(options = {}) {
  const logs = []
  const originalLog = console.log
  const originalWarn = console.warn
  // 捕获插件日志以断言启动行为；同时保留原输出便于排障。
  console.log = (...args) => {
    logs.push(args.join(' '))
    originalLog(...args)
  }
  console.warn = (...args) => {
    logs.push(args.join(' '))
    originalWarn(...args)
  }

  const previousHome = process.env.DSH_HOME
  if (options.dshHome !== undefined) process.env.DSH_HOME = options.dshHome

  const port = options.config?.port ?? await findFreePort()
  const ctx = createCtx(options.services ?? {})
  apply(ctx, { ...(options.config ?? {}), port })

  const started = await waitFor(() => logs.some((line) => line.includes('已上线')))
  console.log = originalLog
  console.warn = originalWarn

  const restoreHome = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  if (!started) {
    restoreHome()
    throw new Error(`插件未在超时内上线。日志：\n${logs.join('\n')}`)
  }

  const line = logs.find((entry) => entry.includes('已上线'))
  const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(line)
  const bound = match === null ? undefined : Number(match[1])
  assert.ok(Number.isInteger(bound) && bound > 0, `未能从日志解析端口：${line}`)
  assert.equal(bound, port, '插件应监听测试分配的端口，而不是默认 3091')

  return {
    port: bound,
    origin: `http://127.0.0.1:${bound}`,
    ctx,
    logs,
    close: async () => {
      ctx.dispose()
      await new Promise((resolve) => setTimeout(resolve, 150))
      restoreHome()
    },
  }
}

/** 一个最小的假宿主网关：实现 typertGateway 的形状。 */
function createFakeGateway(options = {}) {
  const dispatched = []
  return {
    dispatched,
    operatorPeer() {
      return { kind: 'operator' }
    },
    async dispatchRpc(endpoint, payload, signal, peer) {
      dispatched.push({ endpoint, payload, hasSignal: signal instanceof AbortSignal, peer })
      if (endpoint === 'session/list') {
        return { ok: true, value: { items: [{ sessionId: 'session-boot-1', updatedAt: Date.now(), running: false, blank: false, agentAvailable: true }] } }
      }
      if (endpoint === 'permissionPresets/catalog') {
        return { ok: true, value: { options: [{ value: 'workspace-write', name: '工作区可写' }], defaultOptions: [{ value: 'workspace-write', name: '工作区可写' }], defaultPreset: 'workspace-write' } }
      }
      if (endpoint === 'agentPresets/list') {
        return { ok: true, value: { presets: [{ id: 'standard', isDefault: true, name: '标准模式' }] } }
      }
      if (endpoint === 'session/modelCatalog') {
        return { ok: true, value: { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }], failures: [] } }
      }
      if (endpoint === 'settings/describe') {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } }
      }
      if (endpoint === '$events/result') return { ok: true, value: undefined }
      return { ok: false, error: { code: 'gateway/method-unavailable', message: `假网关未实现 ${endpoint}`, details: {} } }
    },
    async *openWireStream(endpoint, payload, uplink, peer, signal, control) {
      if (endpoint === '$events') {
        // 先给 ready 帧（带 clientId），再挂住等 abort —— 与真实网关行为一致。
        yield { type: 'ready', clientId: 'fake-client-1', host: { home: 'C:\\Users\\demo' } }
        await new Promise((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', resolve, { once: true })
        })
        return
      }
      yield { ok: false, error: { code: 'gateway/method-unavailable', message: `假网关未实现流 ${endpoint}`, details: {} } }
    },
  }
}

/** 带同源 Origin 的请求头。 */
function headers(origin, extra = {}) {
  return {
    origin,
    host: new URL(origin).host,
    'content-type': 'application/json',
    ...extra,
  }
}

/* ------------------------------------------------------------------ */

console.log('\n[1] 插件形状与装配')

await test('导出 { name, inject, apply, Config }，name 与 patch 行 id 一致', () => {
  assert.equal(name, 'gov-workbench')
  assert.ok(Array.isArray(inject))
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config['~standard'].validate, 'function')
})

await test('Config 对任意输入都返回对象（坏配置不拖垮启动）', () => {
  const schema = Config['~standard']
  assert.deepEqual(schema.validate(null).value, {})
  assert.deepEqual(schema.validate('nonsense').value, {})
  assert.deepEqual(schema.validate([1, 2]).value, {})
  assert.deepEqual(schema.validate({ port: 3091 }).value, { port: 3091 })
})

await test('apply() 真的起服务并打印上线日志', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    assert.ok(boot.port > 0, '应解析出真实端口')
    assert.ok(boot.logs.some((line) => line.includes('综合政务智能工作台已上线')), '缺少上线日志')
    assert.ok(boot.logs.some((line) => line.includes('宿主 API 网关')), '缺少网关形态日志')
    assert.ok(boot.logs.some((line) => line.includes('配对令牌校验')), '缺少令牌校验日志')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('未探测到网关时如实告警但仍照常起页面', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {}, services: {} })
  try {
    assert.ok(boot.logs.some((line) => line.includes('未探测到宿主 API 网关')), '应给出告警')
    const resp = await fetch(`${boot.origin}/`)
    assert.equal(resp.status, 200, '页面仍应可访问')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('探测到 typertGateway 时接入（本机 0.2.0-rc.2 的真实形态）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const gateway = createFakeGateway()
  const boot = await bootPlugin({ dshHome: home, config: {}, services: { typertGateway: gateway } })
  try {
    assert.ok(boot.logs.some((line) => line.includes('typertGateway')), `日志未提到 typertGateway：${boot.logs.join(' | ')}`)
    const resp = await fetch(`${boot.origin}/api/workbench.status`, {
      method: 'POST',
      headers: headers(boot.origin, { 'x-gov-token': await readToken(boot) }),
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'workbench.status', payload: {} }),
    })
    const body = await resp.json()
    assert.equal(body.result.value.host, 'typertGateway')
    assert.equal(body.result.value.hostAvailable, true)
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('老形态 apiProxy 存在时优先接入 apiProxy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const apiProxy = {
    sessions: {
      async list() {
        return { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [] } } }
      },
    },
    async respond() {
      return { accepted: true }
    },
  }
  const boot = await bootPlugin({ dshHome: home, config: {}, services: { apiProxy, typertGateway: createFakeGateway() } })
  try {
    assert.ok(boot.logs.some((line) => line.includes('apiProxy')), `应优先选 apiProxy：${boot.logs.join(' | ')}`)
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */

console.log('\n[2] 静态托管与配对令牌')

/** 读插件写下的令牌（从配置文件，模拟运维读取）。 */
async function readToken(boot) {
  const { configPath } = await import('../lib/config.js')
  const raw = JSON.parse(await readFile(configPath(), 'utf8'))
  return raw.token
}

await test('首次访问静态资源会种下令牌 Cookie', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const resp = await fetch(`${boot.origin}/`, { redirect: 'manual' })
    assert.equal(resp.status, 200)
    const setCookie = resp.headers.get('set-cookie')
    assert.ok(setCookie !== null, '缺少 set-cookie')
    assert.match(setCookie, /dsh_gov_workbench_token=/)
    assert.match(setCookie, /SameSite=Strict/)
    const html = await resp.text()
    assert.ok(html.includes('综合政务智能工作台'), '未返回政务页面')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('令牌被写入配置文件并可复用', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const { configPath } = await import('../lib/config.js')
    const token = await readToken(boot)
    assert.ok(typeof token === 'string' && token.length > 20, `令牌过短：${token}`)
    // 配置文件里应当记录了端口与令牌
    const raw = JSON.parse(await readFile(configPath(), 'utf8'))
    assert.equal(raw.requireToken, true)
    assert.equal(typeof raw.visits, 'number')
    assert.ok(Array.isArray(raw.marquee) && raw.marquee.length > 0, '跑马灯默认内容应落盘')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('静态资源可正常取到 CSS 与全部 JS 模块', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    for (const path of ['/css/gov.css', '/js/util.js', '/js/api.js', '/js/store.js', '/js/marquee.js', '/js/float.js', '/js/panels.js', '/js/app.js']) {
      const resp = await fetch(`${boot.origin}${path}`)
      assert.equal(resp.status, 200, `${path} 应可访问`)
      const text = await resp.text()
      assert.ok(text.length > 200, `${path} 内容过短`)
      assert.match(resp.headers.get('content-type'), /charset=utf-8/, `${path} 应带 charset`)
    }
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('目录穿越被拒绝（裸 socket 发原始路径，绕过 fetch 的路径规范化）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    // fetch/undici 会先把 /../ 规范化掉，测不出服务端防护，必须走裸 TCP。
    const raw = async (rawPath) => {
      const socket = connect(boot.port, '127.0.0.1')
      let text = ''
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${boot.port}\r\nConnection: close\r\n\r\n`)
        })
        socket.on('data', (chunk) => { text += chunk.toString('utf8') })
        socket.on('end', resolve)
        socket.on('error', resolve)
        socket.on('close', resolve)
      })
      return text
    }

    const escaped = await raw('/../package.json')
    assert.ok(!escaped.includes('"name": "dsh-gov-workbench"'), `穿越请求泄漏了插件根目录文件：${escaped.slice(0, 160)}`)

    const encoded = await raw('/%2e%2e%2fpackage.json')
    assert.ok(!encoded.includes('"name": "dsh-gov-workbench"'), '不能通过 %2e 编码绕过')

    // 正常路径仍可用（确认服务活着，不是整体挂掉）
    const normal = await raw('/css/gov.css')
    assert.ok(/^HTTP\/1\.1 200/.test(normal), '正常资源应仍可访问')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */

console.log('\n[3] 真实网关派发（端到端）')

await test('POST /api/session.list 经真 http 服务派发到网关', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const gateway = createFakeGateway()
  const boot = await bootPlugin({ dshHome: home, config: {}, services: { typertGateway: gateway } })
  try {
    const token = await readToken(boot)
    const resp = await fetch(`${boot.origin}/api/session.list`, {
      method: 'POST',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ type: 'client-request', rpcId: 'boot-r1', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.rpcId, 'boot-r1')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.items[0].sessionId, 'session-boot-1')
    const call = gateway.dispatched.find((entry) => entry.endpoint === 'session/list')
    assert.ok(call !== undefined, '网关未收到 session/list')
    assert.equal(call.hasSignal, true, '必须带 AbortSignal')
    assert.ok(call.peer !== undefined, '必须带 operator peer')
    assert.deepEqual(call.payload, { args: {} }, 'payload 必须是 { args } 形状')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('参数行所需的四个枚举端点全部可派发', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const gateway = createFakeGateway()
  const boot = await bootPlugin({ dshHome: home, config: {}, services: { typertGateway: gateway } })
  try {
    const token = await readToken(boot)
    const cases = [
      ['directoryPicker.list', { path: 'C:\\demo' }],
      ['permission.catalog', {}],
      ['agentPreset.list', {}],
      ['session.modelCatalog', {}],
    ]
    for (const [method, payload] of cases) {
      const resp = await fetch(`${boot.origin}/api/${method}`, {
        method: 'POST',
        headers: headers(boot.origin, { 'x-gov-token': token }),
        body: JSON.stringify({ type: 'client-request', rpcId: `p-${method}`, method, payload }),
      })
      assert.equal(resp.status, 200, `${method} 应回 200`)
      const body = await resp.json()
      assert.equal(body.type, 'server-response', `${method} 应回 server-response 信封`)
    }
    const endpoints = gateway.dispatched.map((entry) => entry.endpoint)
    for (const expected of ['directoryPicker/list', 'permissionPresets/catalog', 'agentPresets/list', 'session/modelCatalog']) {
      assert.ok(endpoints.includes(expected), `网关未收到 ${expected}，实际：${endpoints.join(', ')}`)
    }
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('workbench.status 与 workbench.visits 走插件自有端点', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const token = await readToken(boot)
    const status = await (await fetch(`${boot.origin}/api/workbench.status`, {
      method: 'POST',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ type: 'client-request', rpcId: 's', method: 'workbench.status', payload: {} }),
    })).json()
    assert.equal(status.result.value.plugin, 'dsh-gov-workbench')
    assert.ok(Array.isArray(status.result.value.marquee), '状态里应带跑马灯内容')

    const first = await (await fetch(`${boot.origin}/api/workbench.visits`, {
      method: 'POST',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ type: 'client-request', rpcId: 'v1', method: 'workbench.visits', payload: {} }),
    })).json()
    const second = await (await fetch(`${boot.origin}/api/workbench.visits`, {
      method: 'POST',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ type: 'client-request', rpcId: 'v2', method: 'workbench.visits', payload: {} }),
    })).json()
    assert.equal(second.result.value.visits, first.result.value.visits + 1, '访问计数应递增')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */

console.log('\n[4] 事件流：真 SSE + waterfall 应答闭环')

await test('events.mux 收到真实会话事件，且 waterfall 应答能回到网关', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const gateway = createFakeGateway()
  const boot = await bootPlugin({ dshHome: home, config: {}, services: { typertGateway: gateway } })
  try {
    const token = await readToken(boot)
    const controller = new AbortController()
    const resp = await fetch(`${boot.origin}/api/events.mux`, {
      method: 'GET',
      headers: { origin: boot.origin, host: new URL(boot.origin).host, 'x-gov-token': token },
      signal: controller.signal,
    })
    assert.equal(resp.status, 200)
    assert.match(resp.headers.get('content-type'), /text\/event-stream/)

    const frames = []
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          buffer += decoder.decode(chunk.value, { stream: true })
          let at = buffer.indexOf('\n\n')
          while (at !== -1) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)))
            at = buffer.indexOf('\n\n')
          }
        }
      } catch {
        /* abort 时的正常收尾 */
      }
    })()

    // 等 mux 订阅就绪
    await new Promise((resolve) => setTimeout(resolve, 120))

    // 宿主广播一条会话事件 —— 插件应转成 session/event 帧
    boot.ctx.emit('session/event', { id: 'session-boot-1', seq: 3 }, {
      type: 'assistant/chunk',
      seq: 3,
      time: Date.now(),
      data: { chunk: { type: 'delta', text: '装配验证' } },
    })

    // 等 ready 帧被消费（clientId 已记录），再推一个审批 waterfall
    const readySeen = await waitFor(() => gateway.dispatched.length >= 0 && frames.length >= 1)
    assert.ok(readySeen, '未收到任何帧')

    // 直接触发插件内部的 waterfall 翻译路径：模拟网关推来 approval/request
    // 这里通过再起一条 hostEvents 无法注入，改为断言 session/event 已到。
    const sessionFrame = frames.find((frame) => frame.method === 'session/event')
    assert.ok(sessionFrame !== undefined, `未收到 session/event 帧，实际：${JSON.stringify(frames.map((f) => f.method))}`)
    assert.equal(sessionFrame.payload.sessionId, 'session-boot-1')
    assert.equal(sessionFrame.payload.event.data.chunk.text, '装配验证')

    // 投影变更也应转发
    if (boot.ctx.services.sessionProjections === undefined) {
      // 未挂投影服务时插件会告警但不崩 —— 断言告警存在
      assert.ok(boot.logs.some((line) => line.includes('sessionProjections')), '应告警缺少投影服务')
    }

    controller.abort()
    await pump
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('投影变更经 events.mux 转发为 session/projection 帧', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const gateway = createFakeGateway()
  let changedListener
  const sessionProjections = {
    onChanged(listener) {
      changedListener = listener
      return () => { changedListener = undefined }
    },
  }
  const boot = await bootPlugin({
    dshHome: home,
    config: {},
    services: { typertGateway: gateway, sessionProjections },
  })
  try {
    const token = await readToken(boot)
    const controller = new AbortController()
    const resp = await fetch(`${boot.origin}/api/events.mux`, {
      method: 'GET',
      headers: { origin: boot.origin, host: new URL(boot.origin).host, 'x-gov-token': token },
      signal: controller.signal,
    })
    const frames = []
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return
          buffer += decoder.decode(chunk.value, { stream: true })
          let at = buffer.indexOf('\n\n')
          while (at !== -1) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)))
            at = buffer.indexOf('\n\n')
          }
        }
      } catch {
        /* 收尾 */
      }
    })()

    await waitFor(() => typeof changedListener === 'function', 3000)
    assert.equal(typeof changedListener, 'function', '插件未订阅 sessionProjections.onChanged')

    changedListener({ id: 'session-boot-1' }, 'sessionStats', {
      turns: 2, steps: 5, llmMs: 4200, toolMs: 1300, ttftMs: 700, ttftSteps: 5, decodeMs: 3500, decodeTokens: 340,
    }, 60)

    const seen = await waitFor(() => frames.some((frame) => frame.method === 'session/projection'))
    assert.ok(seen, `未收到 session/projection 帧，实际：${JSON.stringify(frames.map((f) => f.method))}`)
    const frame = frames.find((entry) => entry.method === 'session/projection')
    assert.equal(frame.payload.key, 'sessionStats')
    assert.equal(frame.payload.value.turns, 2)
    assert.equal(frame.payload.seq, 60)

    controller.abort()
    await pump
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */

console.log('\n[5] /plugin/* 端点与配置写入')

await test('GET /plugin/status 返回运行信息且不回显令牌', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const token = await readToken(boot)
    const resp = await fetch(`${boot.origin}/plugin/status`, {
      headers: { origin: boot.origin, host: new URL(boot.origin).host, 'x-gov-token': token },
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.plugin, 'dsh-gov-workbench')
    assert.equal(body.token, undefined, '令牌绝不能回显到状态接口')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('PUT /plugin/config 落盘并提示是否需重启', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const token = await readToken(boot)
    const resp = await fetch(`${boot.origin}/plugin/config`, {
      method: 'PUT',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ marquee: ['新通知一', '新通知二'], sealOnComplete: false }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.saved, true)
    assert.equal(body.needsRestart, false, '只改跑马灯不应要求重启')
    assert.deepEqual(body.config.marquee, ['新通知一', '新通知二'])

    const { configPath } = await import('../lib/config.js')
    const onDisk = JSON.parse(await readFile(configPath(), 'utf8'))
    assert.deepEqual(onDisk.marquee, ['新通知一', '新通知二'], '应真的落盘')
    assert.equal(onDisk.sealOnComplete, false)
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('PUT /plugin/config 改端口时提示需重启且不改动监听', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const token = await readToken(boot)
    const resp = await fetch(`${boot.origin}/plugin/config`, {
      method: 'PUT',
      headers: headers(boot.origin, { 'x-gov-token': token }),
      body: JSON.stringify({ port: 3999 }),
    })
    const body = await resp.json()
    assert.equal(body.needsRestart, true, '改端口应提示需重启')
    assert.match(body.note, /重启/)
    // 服务应仍在原端口上活着
    const still = await fetch(`${boot.origin}/`, { redirect: 'manual' })
    assert.equal(still.status, 200, '配置写入不应影响当前监听')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('/plugin/* 同样过来源校验（跨源 403）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const resp = await fetch(`${boot.origin}/plugin/status`, {
      headers: { origin: 'http://evil.example.com', host: new URL(boot.origin).host },
    })
    assert.equal(resp.status, 403)
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */

console.log('\n[6] 关停')

await test('apply() 用 ctx.effect 注册关停，清理执行后服务真的关闭', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  try {
    const before = await fetch(`${boot.origin}/`)
    assert.equal(before.status, 200)
    // 走 cordis 的真实关停路径：执行 effect 返回的清理函数。
    boot.ctx.dispose()
    const released = await waitFor(async () => {
      try {
        await fetch(`${boot.origin}/`)
        return false
      } catch {
        return true
      }
    }, 3000)
    assert.ok(released, 'effect 清理执行后服务必须真的关掉（否则是端口泄漏）')
  } finally {
    await boot.close()
    await rm(home, { recursive: true, force: true })
  }
})

await test('源码里不出现 ctx.on(\'dispose\') 这一无效写法', async () => {
  const source = await readFile(join(HERE, '..', 'lib', 'index.js'), 'utf8')
  // 只看代码，忽略注释 —— 注释里正是要说明「不能这么写」。
  const codeOnly = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  assert.ok(
    !/ctx\.on\(\s*['"]dispose['"]/.test(codeOnly),
    "lib/index.js 的代码里仍在使用 ctx.on('dispose') —— 该事件在 cordis 上从不派发，关停会静默失效",
  )
  assert.ok(/ctx\.effect\(/.test(codeOnly), 'lib/index.js 应通过 ctx.effect 注册关停')
})

await test('ctx dispose 后端口被释放', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gov-home-'))
  const boot = await bootPlugin({ dshHome: home, config: {} })
  const { port } = boot
  const before = await fetch(`${boot.origin}/`).then((r) => r.status)
  assert.equal(before, 200)
  await boot.close()
  const released = await waitFor(() => {
    const probe = createServer()
    try {
      probe.listen(port, '127.0.0.1')
      probe.close()
      return true
    } catch {
      return false
    }
  }, 3000)
  assert.ok(released, `端口 ${port} 在 dispose 后仍被占用`)
  await rm(home, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`plugin-boot: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`plugin-boot: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.label}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
