/**
 * `/api/*` 桥：把浏览器的四象限 RPC 信封 1:1 派发给宿主 API 网关。
 *
 * 支持的 wire 形状（与 dsh 官方 fetch carrier 完全一致）：
 *   - `POST /api/<domain>.<method>`  body = ClientRequest 信封
 *     响应 = ServerResponse `{type:'server-response', rpcId, result}`
 *   - `GET  /api/events.mux`         → text/event-stream（会话事件 + 审批 + 提问）
 *   - `GET  /api/events.host`        → text/event-stream（宿主转发事件）
 *   - `POST /api/respond`            body = ClientResponse 信封
 *   - `GET  /api/session.export?sessionId=` → JSONL 文本
 *
 * 这里**不写方法表**：域名 → namespace 的映射由 `lib/host.js` 的表驱动，
 * 端点是否存在由宿主自己的注册表回答，未知端点如实回失败信封。
 */
import { persistableShape } from './config.js'
import { buildArgs, toNamespace } from './host.js'
import { handleRespond, json, newRpcId, pipeSse, readJsonBody, trackAbort } from './transport.js'

/** unary 路径：`/api/<domain>.<method>`。 */
const UNARY_PATTERN = /^\/api\/([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)$/

/** 取错误的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 405 响应。 */
function respondMethodNotAllowed(res, allow) {
  json(res, 405, { error: 'method not allowed' }, { allow })
  return true
}

/** 统一失败形状，保证前端只需要认一种。 */
function normalizeResult(result) {
  if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result
  return { ok: true, value: result }
}

/**
 * 处理 `/api/*`。
 *
 * @param runtime - `{ ctx, state, config, bridge, mux, persist }` 运行时上下文。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param url - 已解析的 URL。
 * @returns 是否已处理。
 */
export async function handleApi(runtime, req, res, url) {
  const pathname = url.pathname
  if (!pathname.startsWith('/api/')) return false

  const { bridge, mux } = runtime
  const method = (req.method ?? 'GET').toUpperCase()

  // —— 会话事件流：会话事件 + 投影 + 审批 + 提问 ——
  if (pathname === '/api/events.mux') {
    if (method !== 'GET') return respondMethodNotAllowed(res, 'GET')
    const control = trackAbort(req, res)
    await pipeSse(mux.open(control.controller.signal), res, control)
    return true
  }

  // —— 宿主转发事件流（网关的 $events，帧形状原样透传） ——
  if (pathname === '/api/events.host') {
    if (method !== 'GET') return respondMethodNotAllowed(res, 'GET')
    const control = trackAbort(req, res)
    await pipeSse(hostEventFrames(bridge, control), res, control)
    return true
  }

  // —— 卷宗导出 ——
  if (pathname === '/api/session.export') {
    if (method !== 'GET' && method !== 'HEAD') return respondMethodNotAllowed(res, 'GET, HEAD')
    await exportSessionLog(runtime, req, res, url, method === 'HEAD')
    return true
  }

  // —— 应答 ——
  if (pathname === '/api/respond') {
    if (method !== 'POST') return respondMethodNotAllowed(res, 'POST')
    const control = trackAbort(req, res)
    try {
      const body = await readJsonBody(req, 1024 * 1024)
      const receipt = await handleRespond(bridge, body, control.controller.signal)
      json(res, 200, receipt)
    } catch (error) {
      json(res, 400, { accepted: false, reason: 'bad-response', message: messageOf(error) })
    } finally {
      control.detach()
    }
    return true
  }

  // —— 通用 unary（插件自有端点 workbench.* 也走这条） ——
  const match = UNARY_PATTERN.exec(pathname)
  if (match === null) {
    json(res, 404, { error: `未知的 API 路径 ${pathname}` })
    return true
  }
  if (method !== 'POST') return respondMethodNotAllowed(res, 'POST')

  const control = trackAbort(req, res)
  try {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      json(res, 400, {
        type: 'server-response',
        rpcId: newRpcId(),
        result: { ok: false, error: { code: 'gateway/bad-request', message: messageOf(error), details: {} } },
      })
      return true
    }
    const [, domain, sub] = match
    const rpcId = typeof body?.rpcId === 'string' && body.rpcId !== '' ? body.rpcId : newRpcId()

    if (domain === 'workbench') {
      const value = localEndpoint(runtime, sub)
      const result = value === undefined
        ? { ok: false, error: { code: 'gateway/method-unavailable', message: `未知的插件端点 workbench.${sub}`, details: {} } }
        : { ok: true, value }
      json(res, 200, { type: 'server-response', rpcId, result })
      return true
    }

    const endpoint = `${toNamespace(domain)}/${sub}`
    const args = buildArgs(bridge, endpoint, body?.payload)
    const result = await bridge.invoke(endpoint, args, control.controller.signal)
    json(res, 200, { type: 'server-response', rpcId, result: normalizeResult(result) })
  } catch (error) {
    json(res, 200, {
      type: 'server-response',
      rpcId: newRpcId(),
      result: { ok: false, error: { code: 'internal', message: messageOf(error), details: {} } },
    })
  } finally {
    control.detach()
  }
  return true
}

/** 插件自有 unary 端点（同样走四象限信封，便于前端复用一套错误处理）。 */
function localEndpoint(runtime, sub) {
  const { config } = runtime
  if (sub === 'status') return statusPayload(runtime)
  if (sub === 'visits') {
    config.visits += 1
    if (typeof runtime.persist === 'function') void runtime.persist()
    return { visits: config.visits }
  }
  if (sub === 'marquee') return { marquee: config.marquee }
  if (sub === 'config') return { ...persistableShape(config), token: undefined, tokenSet: config.token !== '' }
  return undefined
}

/** `/api/workbench.status` 的载荷。 */
export function statusPayload(runtime) {
  const { bridge, config, state } = runtime
  return {
    plugin: 'dsh-gov-workbench',
    host: bridge.kind,
    hostAvailable: bridge.kind !== 'unavailable',
    port: config.port,
    listenHost: config.host,
    requireToken: config.requireToken,
    allowNoOrigin: config.allowNoOrigin,
    requireJsonContentType: config.requireJsonContentType,
    visits: config.visits,
    marquee: config.marquee,
    sealOnComplete: config.sealOnComplete,
    floatEnabled: config.floatEnabled,
    node: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: state.startedAt,
  }
}

/**
 * 宿主事件流：把网关的 `$events` 转发为 SSE。
 * 帧形状保持网关原样（`ready` / `emit` / `waterfall` / `cancel`）。
 */
async function* hostEventFrames(bridge, control) {
  try {
    for await (const frame of bridge.hostEvents(control.controller.signal)) {
      if (control.controller.signal.aborted) return
      yield { method: 'events.host', rpcId: newRpcId(), payload: frame }
    }
  } catch (error) {
    if (!control.disconnected()) {
      yield {
        method: 'events.host',
        rpcId: newRpcId(),
        payload: { type: 'stream/error', error: { code: 'internal', message: messageOf(error) } },
      }
    }
  }
}

/**
 * 导出卷宗（会话逻辑日志）。
 *
 * 直接读宿主 `ctx.sessionPersistence` 并序列化成 JSONL —— 与
 * `@deepseek-ai/dsh-session-log-export` 的 `readSessionLogText` 同格式：
 * 首行 header，其后每行一个事件，行尾换行。
 */
async function exportSessionLog(runtime, req, res, url, headOnly) {
  const sessionId = url.searchParams.get('sessionId')
  if (typeof sessionId !== 'string' || sessionId === '') {
    json(res, 400, { error: '缺少 sessionId 查询参数' })
    return
  }
  const control = trackAbort(req, res)
  try {
    const text = await readSessionLog(runtime, sessionId, control.controller.signal)
    if (text === undefined) {
      json(res, 404, { error: `未找到卷宗 ${sessionId}` })
      return
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="session-${sessionId}.jsonl"`,
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(text)),
    })
    res.end(headOnly ? undefined : text)
  } catch (error) {
    json(res, 500, { error: messageOf(error) })
  } finally {
    control.detach()
  }
}

/**
 * 读取一份会话逻辑日志并序列化为 JSONL。
 * @returns JSONL 文本；会话不存在时 undefined。
 */
async function readSessionLog(runtime, sessionId, signal) {
  const persistence = getService(runtime.ctx, 'sessionPersistence')
  if (persistence !== undefined && typeof persistence.open === 'function') {
    let handle
    try {
      handle = await persistence.open(sessionId, 'read', { signal })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    try {
      const { events } = await handle.read(0, undefined, { signal })
      return serializeLog(handle.header, events)
    } finally {
      if (typeof handle.close === 'function') await handle.close()
    }
  }

  // 兜底：宿主若通过网关暴露了日志下载端点，就用它。
  const viaGateway = await runtime.bridge.invoke('downloads/sessionLog', { sessionId }, signal)
  if (viaGateway !== null && typeof viaGateway === 'object' && viaGateway.ok === true) {
    const value = viaGateway.value
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof value.text === 'string') return value.text
  }
  return undefined
}

/** 会话不存在类错误（不同后端用不同名字，统一按名字与 code 判）。 */
function isNotFound(error) {
  if (error === null || typeof error !== 'object') return false
  const name = String(error.name ?? '')
  const code = String(error.code ?? '')
  return /notfound/i.test(name) || /not.?found/i.test(code)
}

/** 按 dsh 会话日志格式序列化：首行 header，其后每行一个事件。 */
function serializeLog(header, events) {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: header?.version,
      id: header?.id,
      createdAt: header?.createdAt,
      ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header?.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      isSeeded: header?.isSeeded,
      ...(header?.origin === undefined ? {} : { origin: header.origin }),
      delegationDepth: header?.delegationDepth ?? 0,
      ...(header?.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    }),
  ]
  for (const event of events ?? []) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * 安全地探测一个宿主 service。
 *
 * cordis 的 ctx 是 Proxy：读取一个未在 `inject` 中声明的 service 属性会
 * **直接抛错**（`cannot get property "x" without inject`），不是返回
 * undefined。所以必须 try/catch，并优先用 `ctx.get(key, false)`。
 *
 * @param ctx - 插件上下文。
 * @param key - service 名。
 * @returns service 实例，或 undefined。
 */
function getService(ctx, key) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key, false)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* 未声明该 service，或老版本 get 不接受第二参数 */
  }
  try {
    const value = ctx[key]
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}
