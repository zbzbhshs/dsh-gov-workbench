/**
 * 宿主 API 网关绑定层。
 *
 * 这一层是插件与宿主之间的唯一接缝，目标只有一个：**1:1 复用宿主的会话 /
 * 模型 / 权限 / 模式 / 统计能力，零业务硬编码**。
 *
 * 本机实测（dsh 0.2.0-rc.2）确认了一件事，必须写在代码里以免后来人踩坑：
 * **`ctx.apiProxy` 在 0.2.0-rc.2 上不存在**。`@deepseek-ai/dsh-host-apiproxy`
 * 这个包已经从发行版里移除，API 网关被重构为：
 *
 *   - `ctx.typertGateway`（`@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService`）
 *     负责按 `<namespace>/<method>` 端点派发到实现了对应 Remote 的 Cordis Service；
 *   - 每个业务域各有自己的 Service：`ctx.sessionController`、`ctx.settingsController`、
 *     `ctx.workspaceController`、`ctx.agentPresets`、`ctx.permissionPresets`、
 *     `ctx.llm`、`ctx.userQuestions`、`ctx.approval` 等；
 *   - 端点清单不再是一份手写表，而是由 `@deepseek-ai/dsh-typert-registry` 在运行时
 *     从各包的 `typert.host.js` 里注册进 `ctx.typert.local`。
 *
 * 所以本模块做**能力探测**，同时支持两种宿主形态，并把它们归一成同一个内部接口：
 *
 *   kind === 'apiProxy'      —— 参考文档描述的老形态（0.1.x），`ctx.apiProxy.*`
 *   kind === 'typertGateway' —— 本机 0.2.0-rc.2 的真实形态，`ctx.typertGateway.*`
 *
 * 内部接口（两种形态都必须实现）：
 *   - `invoke(endpoint, args, signal)` → `{ ok:true, value } | { ok:false, error }`
 *   - `stream(endpoint, args, signal)` → AsyncIterable<帧>
 *   - `hostEvents(signal)`             → AsyncIterable<宿主转发事件帧>
 *   - `resolveEventResult(...)`        → 回传审批 / 提问的应答
 *   - `respondLegacy(body, signal)`    → 老形态的 `apiProxy.respond`
 *   - `describeEndpoint(endpoint)`     → 端点参数 wire 名（动态取，不硬编码）
 */
import { randomUUID } from 'node:crypto'

/** 老形态：wire 路径里的单数域名 → apiProxy 属性名（复数）。 */
const APIPROXY_DOMAIN_ALIASES = Object.freeze({
  session: 'sessions',
  agentPreset: 'agentPresets',
  subagent: 'subagents',
  skill: 'skills',
  goal: 'goals',
  workspace: 'workspace',
  settings: 'settings',
  credentials: 'credentials',
  host: 'host',
  llm: 'llm',
})

/** 新形态：wire 域名 → 真实 typert namespace。 */
const TYPERT_NAMESPACE_ALIASES = Object.freeze({
  session: 'session',
  agentPreset: 'agentPresets',
  subagent: 'subagents',
  skill: 'skills',
  goal: 'goals',
  workspace: 'workspace',
  settings: 'settings',
  credentials: 'credentials',
  host: 'directoryPicker',
  llm: 'llm',
  permission: 'permissionPresets',
  permissionPreset: 'permissionPresets',
  directoryPicker: 'directoryPicker',
  workspaceFiles: 'workspaceFiles',
  commands: 'commands',
  userQuestions: 'userQuestions',
  messageFeedback: 'messageFeedback',
  schedule: 'schedule',
  pluginManager: 'pluginManager',
  pluginInventory: 'pluginInventory',
  account: 'account',
  job: 'job',
  terminal: 'terminal',
  speech: 'speech',
})

/** 空异步迭代器：给只需要「一个能 return 的 uplink」的调用用。 */
const EMPTY_ASYNC_ITERABLE = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
}

/** 归一化一个 RPC 失败。 */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** 把任意抛出物归一化成 RPC 失败。 */
function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return failure(error.code, error.message, error.details ?? {})
  }
  return failure('internal', error instanceof Error ? error.message : String(error))
}

/**
 * 老形态适配器：直接调用同进程的 `ctx.apiProxy`。
 *
 * 注意这里对 signal 的处理是本次实现的关键修正点之一：宿主方法要的是
 * `AbortSignal`，而 node:http 的 `IncomingMessage` 上的 `.signal` 在
 * Node ≤22 上是 `undefined`、在 Node ≥24 上只在响应关闭后才 abort，
 * 两种情况下都不能用。调用方必须自己建 AbortController 并把
 * `controller.signal` 传进来，本层只负责转发，绝不从 req 上取 signal。
 */
function createApiProxyBridge(api, logger) {
  const call = async (domain, method, args, signal) => {
    const handler = api?.[domain]?.[method]
    if (typeof handler !== 'function') return failure('gateway/method-unavailable', `apiProxy 上没有 ${domain}.${method}`)
    try {
      const outcome = await handler({ rpcId: randomUUID(), payload: args ?? {} }, signal)
      if (outcome !== null && typeof outcome === 'object' && 'result' in outcome) return outcome.result
      if (outcome !== null && typeof outcome === 'object' && 'ok' in outcome) return outcome
      return { ok: true, value: outcome }
    } catch (error) {
      return failureOf(error)
    }
  }

  return {
    kind: 'apiProxy',
    /** 老形态按「单数域名.方法」寻址，这里做一次别名映射。 */
    async invoke(endpoint, args, signal) {
      const [domainRaw, method] = splitEndpoint(endpoint)
      if (method === undefined) return failure('gateway/bad-request', `端点格式非法：${endpoint}`)
      const domain = APIPROXY_DOMAIN_ALIASES[domainRaw] ?? domainRaw
      return call(domain, method, args, signal)
    },
    async *stream(endpoint, args, signal) {
      const [domainRaw, method] = splitEndpoint(endpoint)
      const domain = APIPROXY_DOMAIN_ALIASES[domainRaw] ?? domainRaw
      const handler = api?.[domain]?.[method]
      if (typeof handler !== 'function') {
        yield failure('gateway/method-unavailable', `apiProxy 上没有流方法 ${domain}.${method}`)
        return
      }
      try {
        const iterable = handler({ rpcId: randomUUID(), payload: args ?? {} }, signal)
        for await (const frame of iterable) {
          if (signal.aborted) return
          yield frame?.payload ?? frame
        }
      } catch (error) {
        if (!signal.aborted) yield failureOf(error)
      }
    },
    async *hostEvents(signal) {
      const mux = api?.events?.mux
      if (typeof mux !== 'function') return
      try {
        const iterable = mux({ rpcId: randomUUID(), payload: {} }, signal)
        for await (const frame of iterable) {
          if (signal.aborted) return
          yield frame?.payload ?? frame
        }
      } catch (error) {
        if (!signal.aborted) logger?.warn?.(`events.mux 流异常：${String(error?.message ?? error)}`)
      }
    },
    async resolveEventResult() {
      return failure('gateway/method-unavailable', 'apiProxy 形态请通过 /api/respond 应答')
    },
    /** 老形态：应答直接交给 `apiProxy.respond`。 */
    async respondLegacy(body) {
      const respond = api?.respond
      if (typeof respond !== 'function') return undefined
      try {
        return await respond(body)
      } catch {
        return { accepted: false, reason: 'bad-response' }
      }
    },
    /** 老形态没有运行时可读的描述符表，返回 undefined 让调用方走兜底包装。 */
    describeEndpoint() {
      return undefined
    },
  }
}

/**
 * 新形态适配器：走 `ctx.typertGateway`。
 *
 * 端点寻址是 `<namespace>/<method>`，payload 必须是 `{ args: {...} }`，
 * 且 args 的键集合必须与描述符声明的 wire 名**完全一致**（多一个少一个都拒：
 * `gateway/arguments-invalid`）。描述符本身可以从 `ctx.typert.local` 动态读到，
 * 所以这里不需要任何方法表。
 */
function createTypertGatewayBridge(gateway, ctx, logger) {
  const peer = () => {
    try {
      return gateway.operatorPeer()
    } catch {
      return undefined
    }
  }

  return {
    kind: 'typertGateway',
    async invoke(endpoint, args, signal) {
      const dispatch = gateway.dispatchRpc
      if (typeof dispatch !== 'function') return failure('gateway/service-unavailable', 'typertGateway 缺少 dispatchRpc')
      try {
        return await dispatch.call(gateway, endpoint, { args: args ?? {} }, signal, peer())
      } catch (error) {
        return failureOf(error)
      }
    },
    async *stream(endpoint, args, signal) {
      const open = gateway.openWireStream
      if (typeof open !== 'function') {
        yield failure('gateway/service-unavailable', 'typertGateway 缺少 openWireStream')
        return
      }
      const control = new AbortController()
      const onAbort = () => control.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const iterable = open.call(gateway, endpoint, { args: args ?? {} }, EMPTY_ASYNC_ITERABLE, peer(), signal, control)
        for await (const frame of iterable) {
          if (signal.aborted) return
          yield frame
        }
      } catch (error) {
        if (!signal.aborted) yield failureOf(error)
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
    /**
     * 宿主转发的 Cordis 事件流（内部端点 `$events`）。
     * 帧形状：`{type:'ready', clientId, host}` / `{type:'emit', event, args}`
     * / `{type:'waterfall', event, eventId, agentId, request}` / `{type:'cancel', eventId}`。
     */
    async *hostEvents(signal) {
      const open = gateway.openWireStream
      if (typeof open !== 'function') return
      const control = new AbortController()
      try {
        const iterable = open.call(gateway, '$events', { args: {} }, EMPTY_ASYNC_ITERABLE, peer(), signal, control)
        for await (const frame of iterable) {
          if (signal.aborted) return
          yield frame
        }
      } catch (error) {
        if (!signal.aborted) logger?.warn?.(`宿主事件流转发异常：${String(error?.message ?? error)}`)
      }
    },
    /** 回传审批 / 提问结果：`$events/result` + `{clientId, eventId, outcome}`。 */
    async resolveEventResult(payload, signal) {
      const dispatch = gateway.dispatchRpc
      if (typeof dispatch !== 'function') return failure('gateway/service-unavailable', 'typertGateway 缺少 dispatchRpc')
      try {
        return await dispatch.call(gateway, '$events/result', { args: payload }, signal, peer())
      } catch (error) {
        return failureOf(error)
      }
    },
    /** 新形态的应答走 resolveEventResult，没有独立的 legacy 通道。 */
    async respondLegacy() {
      return undefined
    },
    /** 从宿主自己的注册表里读端点描述符（参数 wire 名、是否流式）。 */
    describeEndpoint(endpoint) {
      try {
        const descriptor = ctx?.typert?.local?.get?.(endpoint)
        return descriptor ?? undefined
      } catch {
        return undefined
      }
    },
  }
}

/** 拆分 `<namespace>/<method>`。 */
export function splitEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return [undefined, undefined]
  const at = endpoint.indexOf('/')
  if (at <= 0 || at === endpoint.length - 1) return [undefined, undefined]
  return [endpoint.slice(0, at), endpoint.slice(at + 1)]
}

/** 把 wire 路径里的单数域名换成真实 namespace。 */
export function toNamespace(domain) {
  return TYPERT_NAMESPACE_ALIASES[domain] ?? domain
}

/**
 * 从浏览器给的 payload 推出宿主真正要的 args 对象。
 *
 * 规则完全由描述符驱动，没有方法表：
 *   - 读不到描述符 → 原样透传（老形态的 apiProxy 不需要这一步）；
 *   - 端点声明 0 个参数 → `{}`（多余字段会被宿主拒绝，所以必须清掉）；
 *   - 端点声明 1 个参数 → payload 已带该 wire 名就原样用，否则包一层；
 *   - 端点声明多个参数 → 按声明的 wire 名做投影，丢弃未声明的键。
 * 另外把 `invocation.wire`（context 型调用的身份字段）也算进合法键集合。
 *
 * @param bridge - 网关适配器。
 * @param endpoint - `<namespace>/<method>`。
 * @param payload - 浏览器给的原始 payload。
 * @returns 宿主可直接消费的 args。
 */
export function buildArgs(bridge, endpoint, payload) {
  const input = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const descriptor = bridge.describeEndpoint(endpoint)
  const parameters = Array.isArray(descriptor?.parameters) ? descriptor.parameters : undefined
  if (parameters === undefined) return { ...input }

  const wires = parameters.map((parameter) => parameter.wire).filter((wire) => typeof wire === 'string')
  const contextWire = descriptor?.invocation?.kind === 'context' ? descriptor.invocation.wire : undefined
  const allowed = new Set(wires)
  if (typeof contextWire === 'string') allowed.add(contextWire)

  if (wires.length === 0) {
    const out = {}
    if (typeof contextWire === 'string' && contextWire in input) out[contextWire] = input[contextWire]
    return out
  }
  if (wires.length === 1) {
    const wire = wires[0]
    const out = {}
    if (typeof contextWire === 'string' && contextWire in input) out[contextWire] = input[contextWire]
    if (wire in input) out[wire] = input[wire]
    else out[wire] = input
    return out
  }
  const out = {}
  for (const wire of allowed) {
    if (wire in input) out[wire] = input[wire]
  }
  return out
}

/**
 * 探测宿主形态并建立绑定。
 *
 * 优先 `ctx.apiProxy`（老形态 / 参考文档目标），其次 `ctx.typertGateway`
 * （本机 0.2.0-rc.2 的真实形态）。两者都没有时返回不可用绑定，插件会
 * 照常起页面并在状态接口里如实报告，而不是崩掉整个 dsh。
 *
 * @param ctx - Cordis 插件上下文。
 * @param logger - 带 info / warn 的日志器。
 * @returns 归一化后的网关绑定。
 */
export function createHostBridge(ctx, logger) {
  /**
   * 安全地探测一个宿主 service。
   *
   * **重要（已在真 cordis 上踩到）**：cordis 的 ctx 是 Proxy，读取一个
   * *未在 inject 中声明* 的 service 属性会**直接抛错**
   * （`cannot get property "apiProxy" without inject`），不是返回 undefined。
   * 所以绝不能用 `ctx.apiProxy` / `ctx?.typertGateway` 这种裸属性访问 ——
   * 必须整段包在 try/catch 里，并且优先用 `ctx.get(key, false)`（false =
   * 不要求已注入，缺失时返回 undefined）。
   *
   * @param key - service 名。
   * @returns service 实例，或 undefined。
   */
  const get = (key) => {
    if (ctx === null || typeof ctx !== 'object') return undefined
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(key, false)
        if (value !== undefined && value !== null) return value
      }
    } catch {
      /* 忽略：老版本 get 不接受第二参数，或该 service 未声明 */
    }
    try {
      const value = ctx[key]
      return value === null ? undefined : value
    } catch {
      /* cordis Proxy 对未 inject 的 service 会抛错 —— 视为不可用 */
      return undefined
    }
  }

  const apiProxy = get('apiProxy')
  if (apiProxy !== undefined) {
    logger?.info?.('宿主形态：apiProxy（同进程直调）')
    return createApiProxyBridge(apiProxy, logger)
  }

  const gateway = get('typertGateway')
  if (gateway !== undefined) {
    logger?.info?.('宿主形态：typertGateway（dsh 0.2.0 起的 API 网关）')
    return createTypertGatewayBridge(gateway, ctx, logger)
  }

  logger?.warn?.('未探测到宿主 API 网关（apiProxy / typertGateway 都不可用），页面可打开但业务接口会报错。')
  return {
    kind: 'unavailable',
    async invoke() {
      return failure('gateway/service-unavailable', '宿主 API 网关不可用')
    },
    async *stream() {
      yield failure('gateway/service-unavailable', '宿主 API 网关不可用')
    },
    async *hostEvents() {
      /* 无宿主事件源：正常结束，不报错。 */
    },
    async resolveEventResult() {
      return failure('gateway/service-unavailable', '宿主 API 网关不可用')
    },
    async respondLegacy() {
      return undefined
    },
    describeEndpoint() {
      return undefined
    },
  }
}
