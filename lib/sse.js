/**
 * MuxController —— 把「进程内会话事件」与「网关转发事件」合成一条 MuxFrame 流。
 *
 * 背景（本机 dsh 0.2.0-rc.2 实测）：
 * `@deepseek-ai/dsh-api-remotes` 只把一份**白名单**事件转发给浏览器
 * （`approval/request`、`user-questions/request` 以及各类配置变更），
 * **session 事件不在其中**。0.1.x 的 `apiProxy.events.mux()` 已经不存在。
 *
 * 所以本控制器在宿主进程内**直接订阅** `session/event`、`session/created`、
 * `session/disposed`，并用 `{ global: true }` 拿全局可见性 —— 这正是
 * `dsh-api-session-controller` 自己 follow 会话时用的方式。再叠加
 * `sessionProjections.onChanged` 拿实时投影（统计 / 标题 / 待办），
 * 最后把网关的 `$events` 帧翻译成可应答的 `approval/requested` /
 * `question/requested`。三者合成后，对浏览器就是一个统一的 MuxFrame 流。
 */
import { findPendingByEventId, dropPendingResponse, newRpcId, registerPendingResponse } from './transport.js'

/** 已知的 MuxFrame 判别标签（网关若直接产出这些就原样透传）。 */
const MUX_FRAME_TYPES = new Set([
  'session/event',
  'session/subscribed',
  'session/disposed',
  'approval/requested',
  'approval/resolved',
  'question/requested',
  'question/resolved',
  'session/queue',
  'session/jobs',
  'session/projection',
  'stream/error',
])

/** 宿主事件流控制器。 */
export class MuxController {
  /**
   * @param ctx - Cordis 插件上下文。
   * @param bridge - 网关适配器（提供 hostEvents）。
   * @param logger - `{ info, warn }`。
   */
  constructor(ctx, bridge, logger) {
    this.ctx = ctx
    this.bridge = bridge
    this.logger = logger
    /** 每条 SSE 连接一个推送函数。 */
    this.listeners = new Set()
    /** ctx 订阅的 disposer。 */
    this.disposers = []
    this.started = false
    this.projectionsStarted = false
    /** 网关转发事件的 clientId（来自 `ready` 帧）。 */
    this.remoteClientId = undefined
  }

  /** 建立进程内会话事件订阅；幂等。 */
  start() {
    if (this.started) return
    this.started = true
    const ctx = this.ctx
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') return

    const subscribe = (eventName, handler) => {
      // 优先带 { global: true }，拿全局可见性；老版本退回两参数形式。
      try {
        const dispose = ctx.on(eventName, handler, { global: true })
        if (typeof dispose === 'function') this.disposers.push(dispose)
        return
      } catch {
        /* 继续尝试两参数形式 */
      }
      try {
        const dispose = ctx.on(eventName, handler)
        if (typeof dispose === 'function') this.disposers.push(dispose)
      } catch (error) {
        this.logger?.warn?.(`订阅 ${eventName} 失败：${messageOf(error)}`)
      }
    }

    subscribe('session/event', (session, event) => {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      this.broadcast('session/event', { type: 'session/event', sessionId, event })
    })
    subscribe('session/created', (session) => {
      this.broadcast('session/subscribed', {
        type: 'session/subscribed',
        sessionId: session?.id,
        lastSeq: typeof session?.seq === 'number' ? session.seq : -1,
      })
    })
    subscribe('session/disposed', (session) => {
      this.broadcast('session/disposed', { type: 'session/disposed', sessionId: session?.id })
    })
  }

  /** 订阅投影变更（统计 / 标题 / 待办等实时推送）；幂等。 */
  startProjections() {
    if (this.projectionsStarted) return
    this.projectionsStarted = true
    const projections = readService(this.ctx, 'sessionProjections')
    if (projections === undefined || typeof projections.onChanged !== 'function') {
      this.logger?.warn?.('未找到 sessionProjections，统计与待办将只随会话事件更新。')
      return
    }
    try {
      const dispose = projections.onChanged((session, key, value, seq) => {
        this.broadcast('session/projection', { type: 'session/projection', sessionId: session?.id, key, value, seq })
      })
      if (typeof dispose === 'function') this.disposers.push(dispose)
    } catch (error) {
      this.logger?.warn?.(`订阅投影变更失败：${messageOf(error)}`)
    }
  }

  /** 释放全部订阅。 */
  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    this.started = false
    this.projectionsStarted = false
  }

  /** 向所有在线连接广播一帧。 */
  broadcast(method, payload) {
    for (const listener of this.listeners) {
      try {
        listener(method, payload)
      } catch (error) {
        this.logger?.warn?.(`广播帧失败：${messageOf(error)}`)
      }
    }
  }

  /**
   * 打开一条 SSE 连接的事件流。
   * @param signal - 请求级 AbortSignal（由 trackAbort 提供）。
   * @returns AsyncIterable<{method, rpcId, payload}>。
   */
  async *open(signal) {
    this.start()
    const queue = []
    let wake
    const push = (method, payload) => {
      if (signal.aborted) return
      queue.push({ method, rpcId: newRpcId(), payload })
      const resume = wake
      wake = undefined
      resume?.()
    }
    this.listeners.add(push)
    const remote = this.#pumpRemoteEvents(signal, push)
    try {
      while (!signal.aborted) {
        while (queue.length > 0) yield queue.shift()
        if (signal.aborted) return
        await new Promise((resolve) => {
          wake = resolve
        })
      }
    } finally {
      this.listeners.delete(push)
      // 等转发泵自然收尾（signal 已 abort，会立刻返回）。
      await remote.catch(() => undefined)
    }
  }

  /** 消费网关转发事件流，把 waterfall 帧翻译成可应答的 MuxFrame。 */
  async #pumpRemoteEvents(signal, push) {
    try {
      for await (const frame of this.bridge.hostEvents(signal)) {
        if (signal.aborted) return
        if (frame === null || typeof frame !== 'object') continue
        if (MUX_FRAME_TYPES.has(frame.type)) {
          push(frame.type, frame)
          continue
        }
        switch (frame.type) {
          case 'ready': {
            this.remoteClientId = frame.clientId
            break
          }
          case 'emit': {
            push('host/event', { type: 'host/event', event: frame.event, args: frame.args })
            break
          }
          case 'waterfall': {
            this.#translateWaterfall(frame, push)
            break
          }
          case 'cancel': {
            const pending = findPendingByEventId(frame.eventId)
            if (pending !== undefined) {
              dropPendingResponse(pending.rpcId)
              push('approval/resolved', {
                type: 'approval/resolved',
                sessionId: pending.sessionId,
                approvalId: pending.rpcId,
                outcome: 'cancelled',
              })
            }
            break
          }
          default:
            break
        }
      }
    } catch (error) {
      if (!signal.aborted) this.logger?.warn?.(`宿主事件流异常：${messageOf(error)}`)
    }
  }

  /** 把一个 waterfall 帧翻译成 approval/requested 或 question/requested。 */
  #translateWaterfall(frame, push) {
    const clientId = this.remoteClientId
    if (typeof clientId !== 'string' || clientId === '') {
      this.logger?.warn?.('收到 waterfall 帧但尚无 clientId，已忽略该请求。')
      return
    }
    const sessionId = frame.agentId
    if (frame.event === 'approval/request') {
      const request = frame.request ?? {}
      const rpcId = registerPendingResponse(clientId, frame.eventId, 'approval', sessionId)
      push('approval/requested', {
        type: 'approval/requested',
        sessionId,
        approvalId: rpcId,
        toolName: typeof request.toolName === 'string' ? request.toolName : '未命名操作',
        ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
        ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
      })
      return
    }
    if (frame.event === 'user-questions/request') {
      const request = frame.request ?? {}
      const questions = Array.isArray(request.questions) ? request.questions : []
      const rpcId = registerPendingResponse(clientId, frame.eventId, 'question', sessionId)
      push('question/requested', {
        type: 'question/requested',
        sessionId,
        questionRpcId: rpcId,
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(Array.isArray(question.options) ? { options: question.options } : {}),
          ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        })),
      })
    }
  }
}

/** 取错误的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 安全地探测一个宿主 service。
 *
 * **重要**：cordis 的 ctx 是 Proxy，读取一个未在 `inject` 中声明的 service
 * 属性会**直接抛错**（`cannot get property "x" without inject`），不是返回
 * undefined。所以这里必须 try/catch，并优先用 `ctx.get(key, false)`
 * （false = 不要求已注入，缺失时返回 undefined）。
 *
 * @param ctx - 插件上下文。
 * @param key - service 名。
 * @returns service 实例，或 undefined。
 */
function readService(ctx, key) {
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
