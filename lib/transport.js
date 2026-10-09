/**
 * 传输层：HTTP 信封、SSE 编码、请求级 AbortController、应答路由。
 *
 * 这一层修掉参考实现里两个真实缺陷。
 *
 * **缺陷 A：把 `req.signal` 传给宿主方法。**
 * `node:http` 的 `IncomingMessage` **没有 `.signal` 属性**，恒为 `undefined`。
 * 宿主的帧队列内部直接 `signal.addEventListener('abort', ...)` 且不做
 * undefined 防御，于是流一打开就抛 TypeError → 前端重连 → 死循环报错。
 * 本模块为每个请求自建 `AbortController`，在 `res.on('close')` 时 abort，
 * 并**区分「客户端断开」与「正常结束」**：只有 `res.writableEnded === false`
 * 才认定为断开，正常 `res.end()` 不会触发 abort。
 *
 * **缺陷 B：`/api/*` 无来源校验。**
 * 校验本身在 `lib/security.js`；本模块只保证：所有写请求都走
 * `readJsonBody`（Content-Type 已在准入层验过），且响应带 `no-store`。
 */
import { randomUUID } from 'node:crypto'

/** SSE 心跳间隔，避免中间层掐掉空闲连接。 */
const HEARTBEAT_MS = 25_000

/** 单条 JSON 请求体上限。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 应答 rpcId 里 clientId 与 eventId 的分隔符。 */
export const RPC_SEPARATOR = '|'

/** 已登记的待应答请求：rpcId → { rpcId, clientId, eventId, kind, sessionId }。 */
const pendingByRpcId = new Map()

/** 生成一个关联 id。 */
export function newRpcId() {
  return randomUUID()
}

/** 写一个 JSON 响应。 */
export function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  })
  res.end(body)
}

/**
 * 读取并解析 JSON 请求体。
 * Content-Type 的准入在 security 层已校验，这里只负责解析与限长。
 *
 * @param req - IncomingMessage。
 * @param limit - 字节上限。
 * @returns 解析后的对象。
 * @throws 超过上限或不是合法 JSON 时抛出。
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体超过上限')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  return parsed
}

/** 把 SSE 帧编码成 `data: <json>\n\n`。 */
export function encodeSseFrame(method, rpcId, payload) {
  return `data: ${JSON.stringify({ type: 'server-request', rpcId, method, payload })}\n\n`
}

/** 写出统一的 SSE 响应头。 */
export function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/**
 * 为一个请求建立 AbortController，并在客户端断开时 abort。
 *
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @returns `{ controller, detach, disconnected }`；`disconnected()` 反映
 *   客户端是否已断开（我们主动 `res.end()` 之后为 false）。
 */
export function trackAbort(req, res) {
  const controller = new AbortController()
  let clientGone = false
  const onClose = () => {
    // 正常结束时 writableEnded 为 true，不算断开。
    if (res.writableEnded) return
    clientGone = true
    controller.abort(new Error('client disconnected'))
  }
  res.on('close', onClose)
  req.on('aborted', onClose)
  return {
    controller,
    disconnected: () => clientGone,
    detach: () => {
      res.off('close', onClose)
      req.off('aborted', onClose)
    },
  }
}

/**
 * 把上游帧流转发为 SSE 响应。
 *
 * @param frames - AsyncIterable<{ method, rpcId, payload }>。
 * @param res - ServerResponse。
 * @param control - 来自 trackAbort。
 */
export async function pipeSse(frames, res, control) {
  writeSseHead(res)
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)
  try {
    for await (const frame of frames) {
      if (control.controller.signal.aborted || res.writableEnded) break
      res.write(encodeSseFrame(frame.method, frame.rpcId, frame.payload))
    }
  } catch (error) {
    if (!control.disconnected() && !res.writableEnded) {
      res.write(
        encodeSseFrame('stream/error', newRpcId(), {
          type: 'stream/error',
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        }),
      )
    }
  } finally {
    clearInterval(heartbeat)
    control.detach()
    if (!res.writableEnded) res.end()
  }
}

/* ------------------------------------------------------------------ */
/* 待应答请求登记表（审批 / 提问）                                      */
/* ------------------------------------------------------------------ */

/**
 * 登记一条待应答的 waterfall 请求。
 * rpcId 编成 `<clientId>|<eventId>`，`/api/respond` 收到它即可精确还原目标。
 *
 * @returns 该请求的 rpcId。
 */
export function registerPendingResponse(clientId, eventId, kind, sessionId) {
  const rpcId = `${clientId}${RPC_SEPARATOR}${eventId}`
  pendingByRpcId.set(rpcId, { rpcId, clientId, eventId, kind, sessionId })
  return rpcId
}

/** 取消登记。 */
export function dropPendingResponse(rpcId) {
  return pendingByRpcId.delete(rpcId)
}

/** 按 eventId 找已登记的待应答请求。 */
export function findPendingByEventId(eventId) {
  for (const entry of pendingByRpcId.values()) {
    if (entry.eventId === eventId) return entry
  }
  return undefined
}

/** 清空登记表（插件 dispose 与测试用）。 */
export function clearPendingResponses() {
  pendingByRpcId.clear()
}

/**
 * 处理一次浏览器应答（`POST /api/respond`）。
 *
 * 两种来源按 rpcId 形态区分：
 *   1. `<clientId>|<eventId>` → 网关转发的审批 / 提问 waterfall；
 *   2. 其它 → 老形态 `apiProxy.respond`（如果宿主是那种形态）。
 *
 * @param bridge - 网关适配器。
 * @param body - 解析后的 ClientResponse 信封。
 * @param signal - 请求级 AbortSignal。
 * @returns 给浏览器的回执对象。
 */
export async function handleRespond(bridge, body, signal) {
  const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : ''
  const result = body?.result
  const value = result !== null && typeof result === 'object' && 'value' in result ? result.value : undefined

  const at = rpcId.indexOf(RPC_SEPARATOR)
  if (at > 0) {
    const clientId = rpcId.slice(0, at)
    const eventId = rpcId.slice(at + 1)
    const pending = pendingByRpcId.get(rpcId)
    if (pending === undefined) return { accepted: false, reason: 'unknown-request' }
    pendingByRpcId.delete(rpcId)
    const outcome = value === undefined ? { kind: 'next' } : { kind: 'result', value }
    const response = await bridge.resolveEventResult({ clientId, eventId, outcome }, signal)
    if (response !== null && typeof response === 'object' && response.ok === false) {
      return { accepted: false, reason: 'host-rejected', error: response.error }
    }
    return { accepted: true }
  }

  const legacy = await bridge.respondLegacy(body, signal)
  if (legacy !== undefined) return legacy
  return { accepted: false, reason: 'unknown-request' }
}
