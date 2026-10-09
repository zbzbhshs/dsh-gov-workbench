/**
 * dsh-gov-workbench 宿主插件入口。
 *
 * 形态：`{ name, inject, apply, Config }` 的 Cordis 插件。
 * 装配：`cordis.patch.yml` 用 `- insert:` 插入插件行，`inject: [apiProxy]`
 * 只是「等宿主 API 网关就绪再挂载」的声明；本机 0.2.0-rc.2 上该 service
 * 不存在（已被 `typertGateway` + 各域 controller 取代），因此真正的挂载
 * 依赖由 `lib/host.js` 的能力探测在 `apply()` 内完成 —— 见该文件顶部注释。
 *
 * 服务：用 `node:http` 在插件自己的端口（默认 3091）起服务，托管政务风格
 * 页面并把浏览器请求 1:1 桥接到宿主同进程的 API 网关。宿主进程内起网服
 * 不受 agent 侧沙箱约束（沙箱只约束 agent 工具执行的子进程）。
 */
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApi, statusPayload } from './bridge.js'
import { configPath, mergeConfig, persistableShape, saveConfig } from './config.js'
import { createHostBridge } from './host.js'
import { admit, tokenCookieHeader } from './security.js'
import { MuxController } from './sse.js'
import { publicDirOf, serveStatic } from './static.js'
import { json, readJsonBody, clearPendingResponses } from './transport.js'

/** 插件名；与 cordis.patch.yml 里的行 id 保持一致。 */
export const name = 'gov-workbench'

/**
 * 声明依赖的宿主 service。
 *
 * 这里刻意**留空**：`apiProxy` 在 0.2.0-rc.2 上不存在，若在这里声明会让
 * Cordis 永远等不到该 service，插件永不激活（启动日志里表现为
 * 「Plugins waiting for services」）。等待网关就绪改由 `apply()` 内的
 * 能力探测 + `ctx.inject` 可选订阅完成，两种宿主形态都能挂上。
 */
export const inject = []

/**
 * 插件配置 schema（schemastery 风格的可选注入）。
 *
 * 只做形状校验，不做取值校验：取值由 `mergeConfig` 归一化，坏配置回落
 * 默认值而不是把 dsh 启动拖垮。`Config` 不存在时 Cordis 直接透传原始 config。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-gov-workbench',
    validate(value) {
      const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return { value: input }
    },
  },
}

/** 日志前缀。 */
const LOG_PREFIX = '[gov-workbench]'

/** 日志器。 */
const logger = {
  info: (...args) => console.log(LOG_PREFIX, ...args),
  warn: (...args) => console.warn(LOG_PREFIX, ...args),
}

/** 本文件所在目录，用于定位 public/。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** public 目录绝对路径。 */
const PUBLIC_DIR = publicDirOf(LIB_DIR)

/** 运行期状态（一个插件实例一份）。 */
function createState() {
  return {
    server: undefined,
    startedAt: new Date().toISOString(),
    config: undefined,
    bridge: undefined,
    mux: undefined,
    disposed: false,
  }
}

/** 落盘当前配置（访问计数等）。 */
async function persistConfig(state) {
  if (state.config === undefined) return
  try {
    await saveConfig(persistableShape(state.config))
  } catch (error) {
    logger.warn(`配置落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 一次请求的完整处理。
 *
 * 准入顺序：`/api/*` 与 `/plugin/*` 都过 `admit()`（来源 → 令牌 →
 * Content-Type），静态资源只做来源校验（读页面不需要令牌，否则首次
 * 访问会拿不到页面去种 Cookie）。
 */
async function handleRequest(runtime, req, res) {
  let url
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  } catch {
    json(res, 400, { error: 'bad request url' })
    return
  }

  const pathname = url.pathname

  try {
    if (pathname.startsWith('/api/')) {
      const verdict = admit(req, {
        token: runtime.config.token,
        requireToken: runtime.config.requireToken,
        allowNoOrigin: runtime.config.allowNoOrigin,
        requireJsonContentType: runtime.config.requireJsonContentType,
      })
      if (!verdict.ok) {
        json(res, verdict.status, { error: verdict.reason })
        return
      }
      const handled = await handleApi(runtime, req, res, url)
      if (!handled) json(res, 404, { error: `未知的 API 路径 ${pathname}` })
      return
    }

    if (pathname.startsWith('/plugin/')) {
      const verdict = admit(req, {
        token: runtime.config.token,
        requireToken: runtime.config.requireToken,
        allowNoOrigin: runtime.config.allowNoOrigin,
        requireJsonContentType: runtime.config.requireJsonContentType,
      })
      if (!verdict.ok) {
        json(res, verdict.status, { error: verdict.reason })
        return
      }
      await handlePluginEndpoint(runtime, req, res, url)
      return
    }

    // 静态资源：只校验来源，不要求令牌（首次访问要能拿到页面）。
    const originOnly = admit(req, {
      requireToken: false,
      allowNoOrigin: runtime.config.allowNoOrigin,
      requireJsonContentType: false,
    })
    if (!originOnly.ok) {
      json(res, originOnly.status, { error: originOnly.reason })
      return
    }
    // 首次访问种下配对令牌 Cookie，后续 /api/* 调用即可通过令牌校验。
    if (runtime.config.requireToken) {
      res.setHeader('set-cookie', tokenCookieHeader(runtime.config.token))
    }
    await serveStatic(req, res, pathname, PUBLIC_DIR)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`请求处理失败 ${pathname}：${message}`)
    if (!res.headersSent) json(res, 500, { error: message })
    else if (!res.writableEnded) res.end()
  }
}

/** `/plugin/*` 端点：运行信息与配置读写。 */
async function handlePluginEndpoint(runtime, req, res, url) {
  const { config, state } = runtime
  const pathname = url.pathname
  const method = (req.method ?? 'GET').toUpperCase()

  if (pathname === '/plugin/status') {
    if (method !== 'GET') {
      json(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    json(res, 200, statusPayload(runtime))
    return
  }

  if (pathname === '/plugin/config') {
    if (method === 'GET') {
      json(res, 200, {
        ...persistableShape(config),
        // 令牌本身不回显，只回是否启用。
        token: undefined,
        tokenSet: config.token !== '',
        configPath: configPath(),
      })
      return
    }
    if (method === 'PUT') {
      let body
      try {
        body = await readJsonBody(req, 1024 * 1024)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const next = mergeConfig(config, body, { token: config.token })
      // 端口 / host 改动需要重启 dsh 才能生效，这里如实告知。
      const needsRestart = next.port !== config.port || next.host !== config.host
      state.config = next
      await persistConfig(state)
      json(res, 200, {
        saved: true,
        needsRestart,
        note: needsRestart ? '端口 / 监听地址修改后需重启 dsh 才生效。' : '配置已保存并立即生效。',
        config: { ...persistableShape(next), token: undefined, tokenSet: next.token !== '' },
      })
      return
    }
    json(res, 405, { error: 'method not allowed' }, { allow: 'GET, PUT' })
    return
  }

  if (pathname === '/plugin/token') {
    if (method !== 'GET') {
      json(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    // 只有通过令牌校验的请求能走到这里，所以回显令牌是安全的。
    json(res, 200, { token: config.token })
    return
  }

  if (pathname === '/plugin/visits') {
    if (method === 'GET') {
      config.visits += 1
      json(res, 200, { visits: config.visits })
      void persistConfig(state)
      return
    }
    if (method === 'PUT') {
      config.visits = 0
      json(res, 200, { visits: 0 })
      void persistConfig(state)
      return
    }
    json(res, 405, { error: 'method not allowed' }, { allow: 'GET, PUT' })
    return
  }

  if (pathname === '/plugin/marquee') {
    if (method === 'GET') {
      json(res, 200, { marquee: config.marquee })
      return
    }
    if (method === 'PUT') {
      try {
        const body = await readJsonBody(req, 256 * 1024)
        const next = mergeConfig(config, { marquee: body?.marquee })
        state.config = next
        await persistConfig(state)
        json(res, 200, { saved: true, marquee: next.marquee })
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' }, { allow: 'GET, PUT' })
    return
  }

  json(res, 404, { error: `未知的插件端点 ${pathname}` })
}

/**
 * Cordis 插件主体。
 *
 * @param ctx - 插件上下文。
 * @param rawConfig - cordis.patch.yml 该行的 `config` 字段。
 */
export function apply(ctx, rawConfig = {}) {
  const state = createState()

  // 关停必须挂在 ctx.effect 上。
  //
  // 注意：**不能**用 `ctx.on('dispose', ...)` —— 已实测（cordis 4.x）该事件名
  // 从来不会被派发，回调永不执行，结果是插件卸载后 http 服务仍占着端口。
  // cordis 的插件级清理语义是 `ctx.effect(() => () => cleanup)`：effect 回调
  // 返回的函数会在该 fiber 被销毁时调用。dsh 自己的插件（如
  // cordis-plugin-timer）也都是这么写的。
  ctx.effect(() => () => {
    state.disposed = true
    clearPendingResponses()
    state.mux?.dispose()
    try {
      state.server?.close()
    } catch {
      /* 忽略：进程正在退出 */
    }
  }, 'gov-workbench: http server and event subscriptions')

  // 监听与配置加载都放到微任务里，避免一个坏配置把 dsh 启动拖垮。
  void (async () => {
    const fileConfig = await loadFileConfig()
    const config = mergeConfig(fileConfig, rawConfig)
    state.config = config
    state.bridge = createHostBridge(ctx, logger)
    state.mux = new MuxController(ctx, state.bridge, logger)
    state.mux.startProjections()

    // 全部走 getter 读 state：PUT /plugin/config 改的就是 state.config，
    // 后续请求必须立刻看到新值，不能读到闭包里的旧引用。
    const runtime = {
      ctx,
      state,
      get config() {
        return state.config
      },
      get bridge() {
        return state.bridge
      },
      get mux() {
        return state.mux
      },
      persist: () => persistConfig(state),
    }

    if (config.token !== fileConfig.token) await persistConfig(state)

    const server = createServer((req, res) => {
      void handleRequest(runtime, req, res)
    })
    server.on('clientError', (error, socket) => {
      logger.warn(`客户端连接异常：${error.message}`)
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    server.on('error', (error) => {
      logger.warn(`监听失败：${error.message}`)
    })

    server.listen(config.port, config.host, () => {
      if (state.disposed) {
        server.close()
        return
      }
      state.server = server
      const shown = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
      logger.info(`综合政务智能工作台已上线：http://${shown}:${config.port}/`)
      logger.info(`宿主 API 网关：${state.bridge.kind}（${state.bridge.kind === 'unavailable' ? '不可用' : '已接入，1:1 能力'}）`)
      logger.info(`配对令牌校验：${config.requireToken ? '开启' : '关闭'}；配置文件：${configPath()}`)
    })
  })()
}

/** 读配置文件；失败时返回空对象让 mergeConfig 走默认值。 */
async function loadFileConfig() {
  const { loadConfig } = await import('./config.js')
  try {
    return await loadConfig()
  } catch (error) {
    logger.warn(`读取配置失败：${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

export default apply
