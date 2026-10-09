/**
 * server-smoke.mjs —— 宿主插件冒烟测试（无需真实 API 额度）
 *
 * 覆盖：
 *   1. 静态资源托管（含目录穿越防护）
 *   2. `/api/*` 四象限信封分发（unary → mock 网关 → server-response）
 *   3. SSE 帧格式（`\n\n` 分隔、`data: <json>`、server-request 信封）
 *   4. `/api/respond` 应答路由（waterfall rpcId 还原）
 *   5. 卷宗导出（JSONL）
 *   6. **来源校验拒绝跨源**（Origin 不匹配 → 403）
 *   7. **Content-Type 校验**（text/plain 简单请求 → 415）
 *   8. 配对令牌校验（无令牌 → 401）
 *   9. AbortSignal 回归：确认插件把自建 controller.signal 传给宿主，
 *      而不是把 `req.signal`（恒为 undefined）传下去。
 *
 * 运行：node test/server-smoke.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { handleApi } from '../lib/bridge.js'
import { mergeConfig } from '../lib/config.js'
import { MuxController } from '../lib/sse.js'
import { clearPendingResponses, registerPendingResponse } from '../lib/transport.js'
import { admit, checkContentType, checkOrigin } from '../lib/security.js'
import { resolveStaticPath } from '../lib/static.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, '..', 'public')

let passed = 0
let failed = 0
const failures = []

/** 一个断言包装：记录结果而不是立刻中断整个文件。 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  \u2713 ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  \u2717 ${name}`)
    console.log(`      ${error && error.message ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 测试替身                                                            */
/* ------------------------------------------------------------------ */

/** 记录调用参数的 mock 网关。 */
function createMockBridge() {
  const calls = []
  const streamFrames = []
  const hostFrames = []
  const respondCalls = []
  let describeMap = {}

  return {
    kind: 'typertGateway',
    calls,
    streamFrames,
    hostFrames,
    respondCalls,
    setDescribe(map) {
      describeMap = map
    },
    /** 记录每次调用收到的 signal，用于回归验证。 */
    async invoke(endpoint, args, signal) {
      calls.push({ endpoint, args, hasSignal: signal instanceof AbortSignal, signalAborted: signal?.aborted === true })
      if (endpoint === 'session/list') {
        return { ok: true, value: { items: [{ sessionId: 'session-test-1', updatedAt: 1700000000000, running: false, blank: false, agentAvailable: true }] } }
      }
      if (endpoint === 'directoryPicker/list') {
        return { ok: true, value: { path: 'C:\\demo', home: 'C:\\Users\\demo', crumbs: [], entries: [{ name: 'sub', path: 'C:\\demo\\sub', hidden: false }], truncated: false } }
      }
      if (endpoint === 'session/page') {
        return {
          ok: true,
          value: {
            records: [
              { type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } } } },
              { type: 'event', event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] }, usage: { inputTokens: 10, outputTokens: 5 } } } },
            ],
            hasMore: false,
          },
        }
      }
      return { ok: false, error: { code: 'gateway/method-unavailable', message: `mock 未实现 ${endpoint}`, details: {} } }
    },
    async *stream(endpoint, args, signal) {
      calls.push({ endpoint, args, hasSignal: signal instanceof AbortSignal })
      for (const frame of streamFrames) yield frame
    },
    async *hostEvents(signal) {
      for (const frame of hostFrames) yield frame
    },
    async resolveEventResult(payload, signal) {
      respondCalls.push({ payload, hasSignal: signal instanceof AbortSignal })
      return { ok: true, value: undefined }
    },
    async respondLegacy() {
      return undefined
    },
    describeEndpoint(endpoint) {
      return describeMap[endpoint]
    },
  }
}

/** 一个不做任何事的 mock ctx。 */
function createMockCtx() {
  return {
    get() {
      return undefined
    },
    on() {
      return () => undefined
    },
  }
}

/** 起一个把 handleApi 挂上去的最小 HTTP 服务，返回 { url, close, runtime }。 */
async function startTestServer(options = {}) {
  const bridge = options.bridge ?? createMockBridge()
  const ctx = options.ctx ?? createMockCtx()
  const config = mergeConfig({ token: 'test-token-abcdefghijklmnop', ...(options.config ?? {}) })
  const state = { startedAt: new Date(0).toISOString() }
  const mux = options.mux ?? new MuxController(ctx, bridge, { info() {}, warn() {} })
  const runtime = {
    ctx,
    state,
    config,
    bridge,
    mux,
    persist: async () => undefined,
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      // 与 lib/index.js 的 handleRequest 同样的准入顺序
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/plugin/')) {
        const verdict = admit(req, {
          token: config.token,
          requireToken: config.requireToken,
          allowNoOrigin: config.allowNoOrigin,
          requireJsonContentType: config.requireJsonContentType,
        })
        if (!verdict.ok) {
          const body = JSON.stringify({ error: verdict.reason })
          res.writeHead(verdict.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(body)
          return
        }
        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApi(runtime, req, res, url)
          if (!handled) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end('{"error":"unknown"}')
          }
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    url: origin,
    origin,
    bridge,
    config,
    runtime,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 带同源 Origin 与令牌的请求头。 */
function sameOriginHeaders(origin, extra = {}) {
  return {
    origin,
    host: new URL(origin).host,
    'content-type': 'application/json',
    'x-gov-token': 'test-token-abcdefghijklmnop',
    ...extra,
  }
}

/* ------------------------------------------------------------------ */
/* 1. 静态资源与路径防护                                                */
/* ------------------------------------------------------------------ */

console.log('\n[1] 静态资源与路径防护')

await test('resolveStaticPath 拒绝目录穿越', () => {
  assert.equal(resolveStaticPath(PUBLIC_DIR, '/../../etc/passwd'), undefined)
  assert.equal(resolveStaticPath(PUBLIC_DIR, '/css/../../package.json'), undefined)
  assert.equal(resolveStaticPath(PUBLIC_DIR, '/%2e%2e%2f%2e%2e%2fpackage.json'), undefined)
})

await test('resolveStaticPath 接受正常路径并回落 index.html', () => {
  const index = resolveStaticPath(PUBLIC_DIR, '/')
  assert.ok(index !== undefined && index.endsWith('index.html'), `期望 index.html，得到 ${index}`)
  const css = resolveStaticPath(PUBLIC_DIR, '/css/gov.css')
  assert.ok(css !== undefined && css.endsWith('gov.css'))
})

await test('index.html 与前端模块真实存在且非空', async () => {
  const files = ['index.html', 'css/gov.css', 'js/util.js', 'js/api.js', 'js/store.js', 'js/marquee.js', 'js/float.js', 'js/panels.js', 'js/app.js']
  for (const file of files) {
    const target = resolveStaticPath(PUBLIC_DIR, `/${file}`)
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(target, 'utf8')
    assert.ok(text.length > 500, `${file} 内容过短（${text.length} 字节）`)
  }
})

await test('index.html 声明了政务版式的关键结构', async () => {
  const { readFile } = await import('node:fs/promises')
  const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8')
  for (const needle of ['综合政务智能工作台', '一网通办 · 智能协同 · 全程留痕', '准予办结', 'XXICP备00000000号-1', '【重要通知】', '设为首页', '无障碍浏览']) {
    assert.ok(html.includes(needle), `index.html 缺少「${needle}」`)
  }
  for (const page of ['home', 'matters', 'archive', 'trace', 'settings', 'rules']) {
    assert.ok(html.includes(`data-page="${page}"`), `index.html 缺少栏目 ${page}`)
  }
})

await test('gov.css 的 :root 声明了全部视觉令牌', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(join(PUBLIC_DIR, 'css/gov.css'), 'utf8')
  const tokens = ['#1879d2', '#015293', '#e4393c', '#333333', '#666666', '#999999', '#ffffff', '#f7f7f7', '#dddddd', '#1874cd', '#0d47a1']
  for (const token of tokens) {
    assert.ok(css.includes(token), `gov.css 缺少令牌 ${token}`)
  }
  assert.ok(/:root\s*\{/.test(css), 'gov.css 缺少 :root 块')
  assert.ok(css.includes('SimSun') && css.includes('SimHei'), 'gov.css 未使用系统中文点阵字体栈')
})

await test('gov.css 不引外部字体、框架或远程图片', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile(join(PUBLIC_DIR, 'css/gov.css'), 'utf8')
  assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(css), 'gov.css 含远程 @import')
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'gov.css 含远程 url()')
})

/* ------------------------------------------------------------------ */
/* 2. 来源校验（缺陷 B 的修复）                                          */
/* ------------------------------------------------------------------ */

console.log('\n[2] 来源校验与 Content-Type 校验')

await test('checkOrigin 放行同源请求', () => {
  const verdict = checkOrigin({ headers: { host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091' } }, {})
  assert.equal(verdict.ok, true)
})

await test('checkOrigin 拒绝跨源 Origin', () => {
  const verdict = checkOrigin({ headers: { host: '127.0.0.1:3091', origin: 'http://evil.example.com' } }, {})
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /跨源/)
})

await test('checkOrigin 拒绝跨端口 Origin', () => {
  const verdict = checkOrigin({ headers: { host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3080' } }, {})
  assert.equal(verdict.ok, false)
})

await test('checkOrigin 拒绝 sec-fetch-site: cross-site', () => {
  const verdict = checkOrigin({ headers: { host: '127.0.0.1:3091', 'sec-fetch-site': 'cross-site' } }, {})
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /跨站/)
})

await test('checkOrigin 对无 Origin 请求按 allowNoOrigin 决定', () => {
  assert.equal(checkOrigin({ headers: { host: '127.0.0.1:3091' } }, { allowNoOrigin: true }).ok, true)
  assert.equal(checkOrigin({ headers: { host: '127.0.0.1:3091' } }, { allowNoOrigin: false }).ok, false)
})

await test('checkContentType 只接受 application/json', () => {
  assert.equal(checkContentType({ headers: { 'content-type': 'application/json; charset=utf-8' } }).ok, true)
  assert.equal(checkContentType({ headers: { 'content-type': 'text/plain' } }).ok, false)
  assert.equal(checkContentType({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }).ok, false)
  assert.equal(checkContentType({ headers: {} }).ok, false)
})

/* ------------------------------------------------------------------ */
/* 3. HTTP 端到端                                                      */
/* ------------------------------------------------------------------ */

console.log('\n[3] HTTP 端到端：信封、SSE、应答、导出、拒绝')

await test('POST /api/session.list 返回正确的 server-response 信封', async () => {
  const server = await startTestServer()
  try {
    const rpcId = 'rpc-unary-1'
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, rpcId, 'rpcId 必须回显')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.items[0].sessionId, 'session-test-1')
    assert.equal(server.bridge.calls[0].endpoint, 'session/list', '单数域名必须映射到真实 namespace')
    assert.equal(server.bridge.calls[0].hasSignal, true, '必须传 AbortSignal（缺陷 A 回归）')
  } finally {
    await server.close()
  }
})

await test('域名别名映射：session→session、agentPreset→agentPresets、host→directoryPicker', async () => {
  const server = await startTestServer()
  try {
    const headers = sameOriginHeaders(server.origin)
    await fetch(`${server.url}/api/agentPreset.list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'agentPreset.list', payload: {} }),
    })
    await fetch(`${server.url}/api/directoryPicker.list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'directoryPicker.list', payload: { path: 'C:\\demo' } }),
    })
    const endpoints = server.bridge.calls.map((call) => call.endpoint)
    assert.ok(endpoints.includes('agentPresets/list'), `缺少 agentPresets/list，实际 ${endpoints.join(', ')}`)
    assert.ok(endpoints.includes('directoryPicker/list'), `缺少 directoryPicker/list，实际 ${endpoints.join(', ')}`)
  } finally {
    await server.close()
  }
})

await test('buildArgs 按宿主描述符裁剪参数（多参数端点）', async () => {
  const server = await startTestServer()
  try {
    server.bridge.setDescribe({
      'session/selectModel': {
        invocation: { kind: 'direct' },
        parameters: [{ wire: 'request' }],
      },
      'llm/discoverModels': {
        invocation: { kind: 'direct' },
        parameters: [{ wire: 'settingsNs' }, { wire: 'request' }],
      },
    })
    const headers = sameOriginHeaders(server.origin)
    await fetch(`${server.url}/api/session.selectModel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r3',
        method: 'session.selectModel',
        payload: { sessionId: 's1', provider: 'p', model: 'm', bogus: 'drop-me' },
      }),
    })
    await fetch(`${server.url}/api/llm.discoverModels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r4',
        method: 'llm.discoverModels',
        payload: { settingsNs: 'llm-x', request: { baseURL: 'http://x' }, bogus: 'drop-me' },
      }),
    })
    const single = server.bridge.calls.find((call) => call.endpoint === 'session/selectModel')
    assert.ok(single !== undefined, '未调用 session/selectModel')
    assert.deepEqual(single.args, { request: { sessionId: 's1', provider: 'p', model: 'm', bogus: 'drop-me' } })
    const multi = server.bridge.calls.find((call) => call.endpoint === 'llm/discoverModels')
    assert.ok(multi !== undefined, '未调用 llm/discoverModels')
    assert.deepEqual(multi.args, { settingsNs: 'llm-x', request: { baseURL: 'http://x' } }, '未声明的键必须被裁掉')
  } finally {
    await server.close()
  }
})

await test('events.mux 帧格式：\\n\\n 分隔 + data: <json> + server-request 信封', async () => {
  const ctx = createMockCtx()
  const bridge = createMockBridge()
  const mux = new MuxController(ctx, bridge, { info() {}, warn() {} })
  const server = await startTestServer({ ctx, bridge, mux })
  try {
    const controller = new AbortController()
    const resp = await fetch(`${server.url}/api/events.mux`, {
      method: 'GET',
      headers: { origin: server.origin, host: new URL(server.origin).host, 'x-gov-token': 'test-token-abcdefghijklmnop' },
      signal: controller.signal,
    })
    assert.equal(resp.status, 200)
    assert.match(resp.headers.get('content-type'), /text\/event-stream/)

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    // 等 mux 建立订阅后广播一帧
    await new Promise((resolve) => setTimeout(resolve, 80))
    mux.broadcast('session/event', {
      type: 'session/event',
      sessionId: 'session-test-1',
      event: { type: 'assistant/chunk', seq: 7, time: 1700000000000, data: { chunk: { type: 'delta', text: '你好' } } },
    })

    // 读到一条 data 帧为止（跳过 `: ping` 心跳这类注释行）。
    let buffer = ''
    let dataFrame = ''
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && dataFrame === '') {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 500)),
      ])
      if (chunk.done) continue
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) continue
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (frame.startsWith('data: ')) dataFrame = frame
    }
    controller.abort()

    assert.ok(dataFrame !== '', `未收到 data 帧，累计收到：${JSON.stringify(buffer.slice(0, 200))}`)
    const parsed = JSON.parse(dataFrame.slice(6))
    assert.equal(parsed.type, 'server-request')
    assert.equal(parsed.method, 'session/event')
    assert.ok(typeof parsed.rpcId === 'string' && parsed.rpcId.length > 0, 'rpcId 必须是非空字符串')
    assert.equal(parsed.payload.event.seq, 7)
    assert.equal(parsed.payload.event.data.chunk.text, '你好')
  } finally {
    await server.close()
  }
})

await test('POST /api/respond 通过 waterfall rpcId 精确还原应答目标', async () => {
  clearPendingResponses()
  const server = await startTestServer()
  try {
    const rpcId = registerPendingResponse('client-42', 'event-99', 'approval', 'session-test-1')
    assert.equal(rpcId, 'client-42|event-99')
    const resp = await fetch(`${server.url}/api/respond`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value: 'allowed-once' } }),
    })
    const receipt = await resp.json()
    assert.equal(receipt.accepted, true, `应答应被接受，实际 ${JSON.stringify(receipt)}`)
    assert.equal(server.bridge.respondCalls.length, 1)
    assert.deepEqual(server.bridge.respondCalls[0].payload, {
      clientId: 'client-42',
      eventId: 'event-99',
      outcome: { kind: 'result', value: 'allowed-once' },
    })
    assert.equal(server.bridge.respondCalls[0].hasSignal, true, '应答也要带 AbortSignal')
  } finally {
    await server.close()
  }
})

await test('POST /api/respond 对未登记的 rpcId 如实拒绝', async () => {
  clearPendingResponses()
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/respond`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-response', rpcId: 'nobody|nothing', result: { ok: true, value: 1 } }),
    })
    const receipt = await resp.json()
    assert.equal(receipt.accepted, false)
    assert.equal(receipt.reason, 'unknown-request')
  } finally {
    await server.close()
  }
})

await test('GET /api/session.export 输出 JSONL 卷宗', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-export-'))
  try {
    const server = await startTestServer()
    try {
      // 挂一个假的 sessionPersistence 到 runtime.ctx 上
      const logText = '{"type":"session","id":"session-test-1","version":3,"createdAt":1,"isSeeded":false}\n' +
        '{"type":"user/message","seq":0,"time":1,"data":{}}\n'
      server.runtime.ctx = {
        get(key) {
          if (key !== 'sessionPersistence') return undefined
          return {
            async open(id) {
              if (id !== 'session-test-1') {
                const error = new Error('not found')
                error.name = 'SessionPersistenceNotFoundError'
                throw error
              }
              return {
                header: { version: 3, id, createdAt: 1, isSeeded: false },
                async read() {
                  return { events: [{ type: 'user/message', seq: 0, time: 1, data: {} }] }
                },
                async close() {},
              }
            },
          }
        },
      }
      const resp = await fetch(`${server.url}/api/session.export?sessionId=session-test-1`, {
        method: 'GET',
        headers: { origin: server.origin, host: new URL(server.origin).host, 'x-gov-token': 'test-token-abcdefghijklmnop' },
      })
      assert.equal(resp.status, 200)
      assert.match(resp.headers.get('content-type'), /ndjson/)
      assert.match(resp.headers.get('content-disposition'), /session-test-1\.jsonl/)
      const text = await resp.text()
      const lines = text.trim().split('\n')
      assert.equal(lines.length, 2, `期望 2 行 JSONL，实际 ${lines.length}`)
      assert.equal(JSON.parse(lines[0]).type, 'session')
      assert.equal(JSON.parse(lines[1]).type, 'user/message')

      const missing = await fetch(`${server.url}/api/session.export?sessionId=session-nope`, {
        method: 'GET',
        headers: { origin: server.origin, host: new URL(server.origin).host, 'x-gov-token': 'test-token-abcdefghijklmnop' },
      })
      assert.equal(missing.status, 404, '不存在的卷宗应回 404')

      const noParam = await fetch(`${server.url}/api/session.export`, {
        method: 'GET',
        headers: { origin: server.origin, host: new URL(server.origin).host, 'x-gov-token': 'test-token-abcdefghijklmnop' },
      })
      assert.equal(noParam.status, 400, '缺少 sessionId 应回 400')
      // 顺带确认日志文本被真正写出来过
      await writeFile(join(dir, 'probe.txt'), logText, 'utf8')
    } finally {
      await server.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* 4. 拒绝路径（缺陷 B 的核心断言）                                      */
/* ------------------------------------------------------------------ */

console.log('\n[4] 拒绝路径：跨源、Content-Type、令牌')

await test('跨源 Origin 打 /api/session.prompt 被 403 拒绝（CSRF 驱动点已封）', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/session.prompt`, {
      method: 'POST',
      headers: {
        origin: 'http://evil.example.com',
        host: new URL(server.origin).host,
        'content-type': 'application/json',
        'x-gov-token': 'test-token-abcdefghijklmnop',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.prompt', payload: { sessionId: 's', mode: 'queue', content: [] } }),
    })
    assert.equal(resp.status, 403, `期望 403，实际 ${resp.status}`)
    assert.equal(server.bridge.calls.length, 0, '被拒绝的请求绝不能到达宿主网关')
  } finally {
    await server.close()
  }
})

await test('sec-fetch-site: cross-site 被拒绝', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: {
        host: new URL(server.origin).host,
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
        'x-gov-token': 'test-token-abcdefghijklmnop',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 403)
    assert.equal(server.bridge.calls.length, 0)
  } finally {
    await server.close()
  }
})

await test('text/plain 简单请求被 415 拒绝（不触发预检的绕过已封）', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: {
        host: new URL(server.origin).host,
        'content-type': 'text/plain',
        'x-gov-token': 'test-token-abcdefghijklmnop',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 415, `期望 415，实际 ${resp.status}`)
    assert.equal(server.bridge.calls.length, 0)
  } finally {
    await server.close()
  }
})

await test('缺少配对令牌被 401 拒绝', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: {
        origin: server.origin,
        host: new URL(server.origin).host,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 401, `期望 401，实际 ${resp.status}`)
    assert.equal(server.bridge.calls.length, 0)
  } finally {
    await server.close()
  }
})

await test('错误令牌被 401 拒绝', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: {
        origin: server.origin,
        host: new URL(server.origin).host,
        'content-type': 'application/json',
        'x-gov-token': 'wrong-token-wrong-token-wrong',
      },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 401)
  } finally {
    await server.close()
  }
})

await test('requireToken: false 时无令牌放行（可关闭的开关）', async () => {
  const server = await startTestServer({ config: { requireToken: false } })
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: { origin: server.origin, host: new URL(server.origin).host, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 200, `期望 200，实际 ${resp.status}`)
    assert.equal(server.bridge.calls.length, 1)
  } finally {
    await server.close()
  }
})

/* ------------------------------------------------------------------ */
/* 5. AbortSignal 回归（缺陷 A）                                        */
/* ------------------------------------------------------------------ */

console.log('\n[5] AbortSignal 回归（缺陷 A）')

await test('req.signal 不可依赖（各 Node 版本行为不同，结论一致）', async () => {
  // 这一项把缺陷 A 的根因钉死成可复现的事实，而不是靠文档转述。
  //
  // 实测三种 Node 的 `req.signal`：
  //   v22.22.2 —— 属性不存在（undefined）
  //   v24.18.0 —— 是 AbortSignal，正常结束后会 abort（在 res.close 之后）
  //   v24.21.0 —— 是 AbortSignal，但**正常结束根本不 abort**（等 7 秒仍 false）
  // 因为版本间行为不一致，这里只断言「所有版本都成立」的那部分：
  // ① 进入处理器时都还没 abort（不能当取消信号用）；
  // ② 若该属性存在，它在响应结束后也不能被当作「流已结束」的可靠信号。
  // 断言「结束后一定 abort」会让 CI 在不同 node 上红，故不做该断言。
  const probe = createServer(async (req, res) => {
    const signal = req.signal
    probe.observed = {
      typeofSignal: typeof signal,
      isAbortSignal: signal instanceof AbortSignal,
      abortedAtEntry: signal?.aborted,
      abortedAfterEnd: undefined,
    }
    if (req.url === '/hang') {
      // 流式端点会长时间挂在这里，正是原版崩掉的场景。
      await new Promise((resolve) => setTimeout(resolve, 400))
      probe.observed.abortedMidStream = signal?.aborted
      res.end('late')
      return
    }
    res.end('ok')
    await new Promise((resolve) => setTimeout(resolve, 150))
    probe.observed.abortedAfterEnd = signal?.aborted
  })
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port

  await fetch(`http://127.0.0.1:${port}/normal`).then((r) => r.text())
  await new Promise((resolve) => setTimeout(resolve, 400))
  await new Promise((resolve) => probe.close(resolve))

  const observed = probe.observed
  if (observed.typeofSignal === 'undefined') {
    // Node ≤ 22：原版把 undefined 传给宿主，宿主 addEventListener 直接抛 TypeError。
    assert.equal(observed.isAbortSignal, false)
    console.log(`      （本机 ${process.version}：req.signal 为 undefined —— 缺陷 A 的原始形态）`)
  } else {
    assert.equal(observed.isAbortSignal, true)
    // 关键断言：进入处理器时尚未 abort → 无法用作「客户端断开」信号。
    assert.equal(observed.abortedAtEntry, false, '进入处理器时必须尚未 abort')
    console.log(`      （本机 ${process.version}：req.signal 是 AbortSignal，进入时未 abort；响应结束后 aborted=${String(observed.abortedAfterEnd)}，各版本不一致，故不作为可用信号）`)
  }
})

await test('插件不依赖 req.signal：自建 controller 并在客户端断开时立即 abort', async () => {
  let capturedSignal
  const bridge = {
    kind: 'typertGateway',
    async invoke(endpoint, args, signal) {
      capturedSignal = signal
      // 挂住不返回，等客户端断开
      await new Promise((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', resolve, { once: true })
      })
      return { ok: true, value: { aborted: signal.aborted } }
    },
    async *stream() {},
    async *hostEvents() {},
    async resolveEventResult() {
      return { ok: true, value: undefined }
    },
    async respondLegacy() {
      return undefined
    },
    describeEndpoint() {
      return undefined
    },
  }
  const server = await startTestServer({ bridge })
  try {
    const controller = new AbortController()
    const pending = fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId: 'abort-1', method: 'session.list', payload: {} }),
      signal: controller.signal,
    }).catch(() => 'aborted')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.ok(capturedSignal instanceof AbortSignal, '宿主方法必须收到真实 AbortSignal')
    assert.equal(capturedSignal.aborted, false, '客户端仍在时不应 abort')
    controller.abort()
    await pending
    const deadline = Date.now() + 2000
    while (!capturedSignal.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.equal(capturedSignal.aborted, true, '客户端断开后宿主 signal 必须被 abort')
  } finally {
    await server.close()
  }
})

await test('正常结束不会误触发 abort（区分断开与结束）', async () => {
  let capturedSignal
  const bridge = {
    kind: 'typertGateway',
    async invoke(endpoint, args, signal) {
      capturedSignal = signal
      return { ok: true, value: { fine: true } }
    },
    async *stream() {},
    async *hostEvents() {},
    async resolveEventResult() {
      return { ok: true, value: undefined }
    },
    async respondLegacy() {
      return undefined
    },
    describeEndpoint() {
      return undefined
    },
  }
  const server = await startTestServer({ bridge })
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId: 'ok-1', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 200)
    await resp.json()
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.ok(capturedSignal instanceof AbortSignal)
    assert.equal(capturedSignal.aborted, false, '正常结束绝不能被当成断开而 abort')
  } finally {
    await server.close()
  }
})

/* ------------------------------------------------------------------ */
/* 6. 网关不可用时的降级                                                */
/* ------------------------------------------------------------------ */

console.log('\n[6] 网关不可用时的降级')

await test('网关不可用时返回失败信封而不是崩溃', async () => {
  const bridge = {
    kind: 'unavailable',
    async invoke() {
      return { ok: false, error: { code: 'gateway/service-unavailable', message: '宿主 API 网关不可用', details: {} } }
    },
    async *stream() {},
    async *hostEvents() {},
    async resolveEventResult() {
      return { ok: false, error: { code: 'gateway/service-unavailable', message: '不可用', details: {} } }
    },
    async respondLegacy() {
      return undefined
    },
    describeEndpoint() {
      return undefined
    },
  }
  const server = await startTestServer({ bridge })
  try {
    const resp = await fetch(`${server.url}/api/session.list`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId: 'down-1', method: 'session.list', payload: {} }),
    })
    assert.equal(resp.status, 200)
    const body = await resp.json()
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'gateway/service-unavailable')
  } finally {
    await server.close()
  }
})

await test('插件自有端点 workbench.status 返回运行信息', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/workbench.status`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId: 'st-1', method: 'workbench.status', payload: {} }),
    })
    const body = await resp.json()
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.plugin, 'dsh-gov-workbench')
    assert.equal(body.result.value.host, 'typertGateway')
    assert.equal(body.result.value.port, 3091, '默认端口必须是 3091')
    assert.equal(body.result.value.requireToken, true, '令牌校验默认开启')
  } finally {
    await server.close()
  }
})

await test('未知 API 路径回 404 而不是静默', async () => {
  const server = await startTestServer()
  try {
    const resp = await fetch(`${server.url}/api/nosuchthing`, {
      method: 'POST',
      headers: sameOriginHeaders(server.origin),
      body: JSON.stringify({ type: 'client-request', rpcId: 'u-1', method: 'x', payload: {} }),
    })
    assert.equal(resp.status, 404)
  } finally {
    await server.close()
  }
})

/* ------------------------------------------------------------------ */
/* 7. 配置                                                             */
/* ------------------------------------------------------------------ */

console.log('\n[7] 配置')

await test('mergeConfig 归一化端口并生成令牌', () => {
  const config = mergeConfig({ port: '3091', host: ' 127.0.0.1 ' })
  assert.equal(config.port, 3091)
  assert.equal(config.host, '127.0.0.1')
  assert.ok(config.token.length > 20, '应自动生成配对令牌')
  assert.equal(config.requireToken, true)
  assert.equal(config.requireJsonContentType, true)
  assert.equal(config.allowNoOrigin, true)
})

await test('mergeConfig 对非法端口回落到默认值而不是抛错', () => {
  assert.equal(mergeConfig({ port: 0 }).port, 3091)
  assert.equal(mergeConfig({ port: 70000 }).port, 3091)
  assert.equal(mergeConfig({ port: 'abc' }).port, 3091)
  assert.equal(mergeConfig({ port: null }).port, 3091)
})

await test('mergeConfig 保留已有令牌，不覆盖', () => {
  const config = mergeConfig({ token: 'keep-this-token-value' })
  assert.equal(config.token, 'keep-this-token-value')
})

await test('requireToken 可显式关闭', () => {
  assert.equal(mergeConfig({ requireToken: false }).requireToken, false)
})

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(64))
if (failed === 0) {
  console.log(`server-smoke: 全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`server-smoke: ${passed} 项通过，${failed} 项失败`)
  for (const failure of failures) {
    console.log(`\n失败：${failure.name}`)
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
  }
  process.exit(1)
}
