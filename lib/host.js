/**
 * 宿主 API 网关绑定层。
 *
 * 这一层是插件与宿主之间的唯一接缝，目标只有一个：**1:1 复用宿主的会话 /
 * 模型 / 权限 / 模式 / 统计能力，零业务硬编码**。
 *
 * ## 宿主形态（本机 dsh 0.2.0-rc.2 实测）
 *
 * **`ctx.apiProxy` 在 0.2.0-rc.2 上不存在**。`@deepseek-ai/dsh-host-apiproxy`
 * 已从发行版移除，API 网关重构为：
 *
 *   - `ctx.typertGateway`（`@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService`）
 *     按 `<namespace>/<method>` 端点派发到实现了对应 Remote 的 Cordis Service；
 *   - 各业务域 Service：`sessionController` / `settingsController` /
 *     `workspaceController` / `agentPresets` / `permissionPresets` / `llm` /
 *     `userQuestions` / `approval` 等；
 *   - 端点清单由 `@deepseek-ai/dsh-typert-registry` 在运行时从各包的
 *     `typert.host.js` 注册进 `ctx.typert.local`。
 *
 * 本模块把两种形态归一成同一内部接口：
 *
 *   kind === 'apiProxy'      —— 0.1.x 老形态
 *   kind === 'typertGateway' —— 0.2.0+ 新形态
 *   kind === 'unavailable'   —— 都没有（页面照常起，业务接口如实报错）
 *
 * ## 关键设计：惰性解析 + 等待式事件流
 *
 * `cordis.patch.yml` **不能**用 `inject:` 声明等待（`!!js` 在 `inject` 上不会
 * 被求值，会把 `__jsExpr` 当成服务名导致插件永不激活 —— 详见该文件注释）。
 * 因此插件立即激活，网关可能在 `apply()` 之后才 provide。
 *
 * 为适应这一点，本层**不在构造时绑定一次**，而是：
 *   - `kind` 是 **getter**，每次读取都重新探测，实时反映当前可用性；
 *   - `invoke` / `stream` / `resolveEventResult` / `describeEndpoint` 在
 *     **每次调用时**重新 `resolve()` 网关，晚到的网关会被自动用上；
 *   - `hostEvents(signal)` 是**等待式生成器**：网关不可用时先等（响应式
 *     `ctx.inject` 回调 + 轮询兜底），网关出现后再开始转发；流自然结束后
 *     若网关仍在且 signal 未 abort，会重新接续，所以 `MuxController`
 *     不需要任何重启逻辑。
 *
 * ## 关于 ctx 上的 service 访问
 *
 * cordis 的 ctx 是 Proxy：**插件作用域下读一个未 inject 的 service 属性会
 * 直接抛错**（`cannot get property "x" without inject`），不是返回 undefined
 * （已实测）。所以一律走 `ctx.get(key, false)` 并整段包 try/catch ——
 * `false` 表示「不要求已注入」，缺失时返回 undefined。
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

/**
 * 新形态：wire 域名 → 真实 typert namespace。
 *
 * 这里的每一项都必须对应**宿主真实注册过的 namespace**（清单从各
 * `@deepseek-ai/dsh-<pkg>` 的 `lib/typert.host.js` 里的 `invocations[]`
 * 抽取，140 个端点，26 个宿主包）。表里没有的域名一律原样透传，
 * 由宿主的注册表回答「不存在」—— 插件绝不替宿主编造端点。
 *
 * **已删除的错误映射**：`host → directoryPicker`。
 * `host.describe` / `host.listDirectory` 是 0.1.x `apiProxy` 时代的端点，
 * 在 0.2.0-rc.2 的 typert 面上不存在；把它映射到 `directoryPicker` 只会
 * 产生 `directoryPicker/describe`、`directoryPicker/listDirectory` 这种
 * 必然 `gateway/invocation-unavailable` 的幽灵端点。真实的目录能力只有
 * 三个：`directoryPicker/list`、`directoryPicker/pick`、
 * `directoryPicker/createDirectory`。
 */
const TYPERT_NAMESPACE_ALIASES = Object.freeze({
  session: 'session',
  agentPreset: 'agentPresets',
  subagent: 'subagents',
  skill: 'skills',
  goal: 'goals',
  workspace: 'workspace',
  settings: 'settings',
  credentials: 'credentials',
  llm: 'llm',
  permission: 'permissionPresets',
  permissionPreset: 'permissionPresets',
  directoryPicker: 'directoryPicker',
  workspaceFiles: 'workspaceFiles',
  commands: 'commands',
  userQuestions: 'userQuestions',
  messageFeedback: 'messageFeedback',
  sessionFeedback: 'sessionFeedback',
  schedule: 'schedule',
  pluginManager: 'pluginManager',
  pluginInventory: 'pluginInventory',
  account: 'account',
  job: 'job',
  terminal: 'terminal',
  speech: 'speech',
  goals: 'goals',
  skills: 'skills',
  agentPresets: 'agentPresets',
})

/** 空异步迭代器：给只需要「一个能 return 的 uplink」的调用用。 */
const EMPTY_ASYNC_ITERABLE = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }),
}

/** 网关探测的轮询间隔（`ctx.inject` 不可用时的兜底）。 */
const GATEWAY_POLL_MS = 500

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

/** 取错误的可读信息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 安全地读一个宿主 service。
 *
 * **必须**用 `ctx.get(key, false)`：插件作用域下裸属性访问未 inject 的
 * service 会抛 `cannot get property "x" without inject`（实测）。
 *
 * @param ctx - 插件上下文。
 * @param key - service 名。
 * @returns service 实例，或 undefined。
 */
export function readService(ctx, key) {
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
    /* cordis Proxy 对未 inject 的 service 会抛错 —— 视为不可用 */
    return undefined
  }
}

/**
 * 建一个「等 service 出现」的等待器。
 *
 * 优先用响应式 `ctx.inject([name], cb)`（已实测：service 缺失时不触发，
 * provide 后自动回调）；同时用轮询兜底（`ctx.inject` 不可用时也能等到，
 * 且能覆盖「服务被撤下又重新提供」的情况）。两者都不会抛错。
 *
 * @param ctx - 插件上下文。
 * @param name - service 名。
 * @returns `{ wait(signal), dispose() }`；`wait` resolve 出 service 实例，
 *   signal abort 或等待器被销毁时 resolve `undefined`。
 */
export function createServiceWaiter(ctx, name) {
  /** 当前挂起的 sleep 的唤醒函数。 */
  let wake
  let disposable
  let disposed = false

  const notify = () => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  if (ctx !== null && typeof ctx === 'object' && typeof ctx.inject === 'function') {
    try {
      disposable = ctx.inject([name], () => {
        notify()
      })
    } catch {
      disposable = undefined
    }
  }

  /** 睡 `ms` 毫秒，或在被唤醒 / signal abort / 销毁时提前返回。 */
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', finish)
        if (wake === finish) wake = undefined
        resolve()
      }
      const timer = setTimeout(finish, ms)
      if (signal !== undefined) signal.addEventListener('abort', finish, { once: true })
      // 让 notify() 能提前唤醒这一次 sleep。
      wake = finish
      if (disposed || signal?.aborted === true) finish()
    })

  return {
    /**
     * 等到 service 可用。
     * @param signal - 请求级 AbortSignal。
     * @returns service 实例；signal abort 或等待器被销毁时返回 undefined。
     */
    async wait(signal) {
      for (;;) {
        if (disposed) return undefined
        if (signal !== undefined && signal.aborted) return undefined
        const value = readService(ctx, name)
        if (value !== undefined) return value
        await sleep(GATEWAY_POLL_MS, signal)
      }
    },
    dispose() {
      disposed = true
      notify()
      if (typeof disposable === 'function') {
        try {
          disposable()
        } catch {
          /* 忽略 */
        }
      }
      disposable = undefined
    },
  }
}

/**
 * 老形态适配器：直接调用同进程的 `ctx.apiProxy`。
 *
 * 关于 signal：宿主方法要的是 `AbortSignal`，而 node:http 的
 * `IncomingMessage` 上的 `.signal` 在 Node ≤22 上是 `undefined`、在 Node ≥24 上
 * 只在响应关闭后才 abort（且 v24.21.0 上正常结束根本不 abort），三种情况下
 * 都不能用。调用方必须自建 AbortController 并把 `controller.signal` 传进来，
 * 本层只转发，绝不从 req 上取 signal。
 *
 * 本适配器是**惰性**的：每次调用都重新解析 `ctx.apiProxy`。
 *
 * @param ctx - 插件上下文。
 * @param logger - 带 warn 的日志器。
 * @returns 归一化绑定。
 */
function createApiProxyBinding(ctx, logger) {
  const api = () => readService(ctx, 'apiProxy')

  const call = async (domain, method, args, signal) => {
    const target = api()
    if (target === undefined) return failure('gateway/service-unavailable', 'apiProxy 当前不可用')
    const handler = target?.[domain]?.[method]
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
    get kind() {
      return api() === undefined ? 'unavailable' : 'apiProxy'
    },
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
      const target = api()
      if (target === undefined) {
        yield failure('gateway/service-unavailable', 'apiProxy 当前不可用')
        return
      }
      const handler = target?.[domain]?.[method]
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
      const target = api()
      const mux = target?.events?.mux
      if (typeof mux !== 'function') return
      try {
        const iterable = mux({ rpcId: randomUUID(), payload: {} }, signal)
        for await (const frame of iterable) {
          if (signal.aborted) return
          yield frame?.payload ?? frame
        }
      } catch (error) {
        if (!signal.aborted) logger?.warn?.(`events.mux 流异常：${messageOf(error)}`)
      }
    },
    async resolveEventResult() {
      return failure('gateway/method-unavailable', 'apiProxy 形态请通过 /api/respond 应答')
    },
    /** 老形态：应答直接交给 `apiProxy.respond`。 */
    async respondLegacy(body) {
      const respond = api()?.respond
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
 * `gateway/arguments-invalid`）。描述符从 `ctx.typert.local` 动态读，所以这里
 * 没有任何方法表。
 *
 * 同样是**惰性**的：每次调用重新解析网关，晚到的网关自动生效。
 *
 * @param ctx - 插件上下文。
 * @param logger - 带 warn 的日志器。
 * @returns 归一化绑定。
 */
function createTypertGatewayBinding(ctx, logger) {
  const gateway = () => readService(ctx, 'typertGateway')

  const peer = (target) => {
    try {
      return target.operatorPeer()
    } catch {
      return undefined
    }
  }

  return {
    get kind() {
      return gateway() === undefined ? 'unavailable' : 'typertGateway'
    },
    async invoke(endpoint, args, signal) {
      const target = gateway()
      if (target === undefined) return failure('gateway/service-unavailable', 'typertGateway 当前不可用')
      const dispatch = target.dispatchRpc
      if (typeof dispatch !== 'function') return failure('gateway/service-unavailable', 'typertGateway 缺少 dispatchRpc')
      try {
        return await dispatch.call(target, endpoint, { args: args ?? {} }, signal, peer(target))
      } catch (error) {
        return failureOf(error)
      }
    },
    async *stream(endpoint, args, signal) {
      const target = gateway()
      if (target === undefined) {
        yield failure('gateway/service-unavailable', 'typertGateway 当前不可用')
        return
      }
      const open = target.openWireStream
      if (typeof open !== 'function') {
        yield failure('gateway/service-unavailable', 'typertGateway 缺少 openWireStream')
        return
      }
      const control = new AbortController()
      const onAbort = () => control.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const iterable = open.call(target, endpoint, { args: args ?? {} }, EMPTY_ASYNC_ITERABLE, peer(target), signal, control)
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
     * 宿主转发的 Cordis 事件流（内部端点 `$events`）—— **等待式生成器**。
     *
     * 网关还没 provide 时先等（响应式 `ctx.inject` + 轮询兜底），出现后再转发。
     * 流自然结束后，只要网关仍在且 signal 未 abort，就重新接续 —— 这样
     * `MuxController` 不需要任何重启逻辑。
     *
     * 帧形状：`{type:'ready', clientId, host}` / `{type:'emit', event, args}`
     * / `{type:'waterfall', event, eventId, agentId, request}` / `{type:'cancel', eventId}`。
     */
    async *hostEvents(signal) {
      const waiter = createServiceWaiter(ctx, 'typertGateway')
      try {
        while (!signal.aborted) {
          const target = await waiter.wait(signal)
          if (target === undefined || signal.aborted) return
          const open = target.openWireStream
          if (typeof open !== 'function') return
          const control = new AbortController()
          try {
            const iterable = open.call(target, '$events', { args: {} }, EMPTY_ASYNC_ITERABLE, peer(target), signal, control)
            for await (const frame of iterable) {
              if (signal.aborted) return
              yield frame
            }
          } catch (error) {
            if (!signal.aborted) logger?.warn?.(`宿主事件流转发异常：${messageOf(error)}`)
          }
          // 流自然结束：若网关仍在且未 abort，稍候重连续传；否则退出。
          if (signal.aborted) return
          if (readService(ctx, 'typertGateway') === undefined) continue
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, GATEWAY_POLL_MS)
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                resolve()
              },
              { once: true },
            )
          })
        }
      } finally {
        waiter.dispose()
      }
    },
    /** 回传审批 / 提问结果：`$events/result` + `{clientId, eventId, outcome}`。 */
    async resolveEventResult(payload, signal) {
      const target = gateway()
      if (target === undefined) return failure('gateway/service-unavailable', 'typertGateway 当前不可用')
      const dispatch = target.dispatchRpc
      if (typeof dispatch !== 'function') return failure('gateway/service-unavailable', 'typertGateway 缺少 dispatchRpc')
      try {
        return await dispatch.call(target, '$events/result', { args: payload }, signal, peer(target))
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
        const registry = readService(ctx, 'typert')
        const descriptor = registry?.local?.get?.(endpoint)
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
 *
 * **`acceptsUndefined` 的 wire 必须允许缺席。** 宿主的
 * `assertExactArguments()`（`@deepseek-ai/dsh-api-gateway`）把
 * `acceptsUndefined === true`（或 `codec.mode === 'src-json'`）的 json 参数
 * 放进 `acceptsMissing`，即「字段可以整个不出现」。所以这类 wire 在 payload
 * 里没有对应键时**必须从 args 里省略**，绝不能塞一个占位对象 —— 塞进去会走
 * 严格 codec 的 `parse()` 而失败。
 *
 * 真实案例：`directoryPicker/list` 只有一个 wire `path` 且 `acceptsUndefined`。
 * 旧实现把空 payload 包成 `{path: {}}`，宿主报
 * `gateway/input-invalid: wire field "path" failed boundary validation`；
 * 正确形状是 `{}`，由宿主用默认目录（home）作答。
 *
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

  /** 该参数是否允许整个缺席（宿主的 acceptsMissing 判定）。 */
  const optional = (parameter) =>
    parameter?.source === 'json' && (parameter.acceptsUndefined === true || parameter?.codec?.mode === 'src-json')

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
    if (wire in input && input[wire] !== undefined) out[wire] = input[wire]
    else if (optional(parameters[0])) {
      // 允许缺席：只在调用方明确给了非 undefined 值时才带上。
    } else out[wire] = input
    return out
  }
  const out = {}
  for (const wire of allowed) {
    if (wire in input && input[wire] !== undefined) out[wire] = input[wire]
  }
  return out
}

/**
 * 建一个**惰性**的宿主网关绑定。
 *
 * 优先 `apiProxy`（0.1.x 老形态），其次 `typertGateway`（0.2.0+ 新形态）。
 * 两者都不可用时返回一个降级绑定：`kind` 为 `'unavailable'`，方法返回
 * `gateway/service-unavailable` 失败信封 —— 页面照常打开，业务接口如实报错，
 * 不会崩掉整个 dsh。
 *
 * `kind` 是 getter，且所有方法都在调用时重新解析网关，所以**网关晚于插件
 * provide 也能自动接上**，不需要重启插件。
 *
 * @param ctx - Cordis 插件上下文。
 * @param logger - 带 info / warn 的日志器。
 * @returns 归一化后的网关绑定。
 */
export function createHostBridge(ctx, logger) {
  const apiProxy = createApiProxyBinding(ctx, logger)
  const typert = createTypertGatewayBinding(ctx, logger)

  const choose = () => {
    if (readService(ctx, 'apiProxy') !== undefined) return apiProxy
    if (readService(ctx, 'typertGateway') !== undefined) return typert
    return undefined
  }

  let announced = undefined
  const announce = (kind) => {
    if (announced === kind) return
    announced = kind
    if (kind === 'apiProxy') logger?.info?.('宿主形态：apiProxy（同进程直调）')
    else if (kind === 'typertGateway') logger?.info?.('宿主形态：typertGateway（dsh 0.2.0 起的 API 网关）')
    else logger?.warn?.('未探测到宿主 API 网关（apiProxy / typertGateway 都不可用），页面可打开但业务接口会报错。')
  }

  /** 当前生效的绑定；没有可用网关时返回 undefined。 */
  const active = () => {
    const picked = choose()
    announce(picked === undefined ? 'unavailable' : picked.kind)
    return picked
  }

  return {
    /** 实时反映当前可用性（getter，不是快照）。 */
    get kind() {
      const picked = choose()
      return picked === undefined ? 'unavailable' : picked.kind
    },
    /** 打印一次形态日志（由 apply() 在上线时调用，避免 getter 有副作用）。 */
    announce() {
      active()
    },
    async invoke(endpoint, args, signal) {
      const picked = active()
      if (picked === undefined) return failure('gateway/service-unavailable', '宿主 API 网关不可用')
      return picked.invoke(endpoint, args, signal)
    },
    async *stream(endpoint, args, signal) {
      const picked = active()
      if (picked === undefined) {
        yield failure('gateway/service-unavailable', '宿主 API 网关不可用')
        return
      }
      yield* picked.stream(endpoint, args, signal)
    },
    /**
     * 宿主事件流。网关尚未就绪时**等待**而不是立即结束：
     * 新形态走等待式生成器；老形态若 mux 不可用也退回等待。
     */
    async *hostEvents(signal) {
      const picked = choose()
      if (picked !== undefined && picked.kind === 'apiProxy') {
        yield* picked.hostEvents(signal)
        return
      }
      // 新形态（或还没就绪）：用等待式实现，晚到的网关会自动接上。
      yield* typert.hostEvents(signal)
    },
    async resolveEventResult(payload, signal) {
      const picked = active()
      if (picked === undefined) return failure('gateway/service-unavailable', '宿主 API 网关不可用')
      return picked.resolveEventResult(payload, signal)
    },
    async respondLegacy(body, signal) {
      const picked = choose()
      if (picked === undefined) return undefined
      return picked.respondLegacy(body, signal)
    },
    describeEndpoint(endpoint) {
      const picked = choose()
      if (picked === undefined) return undefined
      return picked.describeEndpoint(endpoint)
    },
  }
}
