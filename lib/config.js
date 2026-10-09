/**
 * 插件运行配置的读写。
 *
 * 配置落盘在 `~/.dsh/gov-workbench.json`（随 DSH_HOME 走），与前端
 * localStorage 的 UI 配置互补：这里只放服务端真正需要的东西（端口、
 * host、配对令牌、访问计数），不放任何界面偏好。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 配置文件绝对路径；DSH_HOME 存在时优先使用它。 */
export function configPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'gov-workbench.json')
}

/** 内置默认值。所有可调项都在这里，代码里不出现写死的端口或地址。 */
export const DEFAULTS = Object.freeze({
  /** 本插件监听端口。 */
  port: 3091,
  /** 监听地址；改成 0.0.0.0 会暴露到局域网，请自行评估。 */
  host: '127.0.0.1',
  /** 配对令牌；首次启动自动生成并写回配置文件。 */
  token: '',
  /** 是否强制校验配对令牌。默认开启。 */
  requireToken: true,
  /** 是否允许无 Origin 头的请求（同源导航 / curl）。 */
  allowNoOrigin: true,
  /** 是否校验 Content-Type 必须是 application/json。 */
  requireJsonContentType: true,
  /** 访问次数统计。 */
  visits: 0,
  /** 跑马灯通知内容。 */
  marquee: [
    '综合政务智能工作台已上线运行，本平台业务办理全程留痕。',
    '请通过主导航进入「事项办理」提交申办事项，办理进度可在「运行轨迹」查询。',
    '平台支持卷宗档案导出，导出内容为完整业务流水。',
  ],
  /** 是否在办结时显示盖章动画。 */
  sealOnComplete: true,
  /** 浮窗（飘窗）开关。 */
  floatEnabled: true,
})

/** 读取配置；文件不存在或损坏时返回空对象，让调用方走默认值。 */
export async function loadConfig(file = configPath()) {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(await readFile(file, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** 原子落盘（先写临时文件再改名，避免半截文件）。 */
export async function saveConfig(config, file = configPath()) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

/** 生成一个 32 字节的 base64url 配对令牌。 */
export function mintToken() {
  return randomBytes(32).toString('base64url')
}

/**
 * 合并配置来源：默认值 → 配置文件 → 插件行 config（优先级递增）。
 * 端口与 host 做一次严格校验，非法值直接回落到默认值而不是抛错，
 * 避免一个坏配置把整个 dsh 启动拖垮。
 */
export function mergeConfig(...sources) {
  const merged = { ...DEFAULTS }
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      merged[key] = value
    }
  }
  merged.port = normalizePort(merged.port, DEFAULTS.port)
  merged.host = normalizeHost(merged.host, DEFAULTS.host)
  merged.token = typeof merged.token === 'string' && merged.token !== '' ? merged.token : mintToken()
  merged.requireToken = merged.requireToken !== false
  merged.allowNoOrigin = merged.allowNoOrigin !== false
  merged.requireJsonContentType = merged.requireJsonContentType !== false
  merged.visits = Number.isSafeInteger(merged.visits) && merged.visits >= 0 ? merged.visits : 0
  merged.marquee = Array.isArray(merged.marquee) && merged.marquee.length > 0
    ? merged.marquee.filter((line) => typeof line === 'string' && line !== '')
    : [...DEFAULTS.marquee]
  merged.sealOnComplete = merged.sealOnComplete !== false
  merged.floatEnabled = merged.floatEnabled !== false
  return merged
}

/** 端口必须落在 1..65535；其余一律回落。 */
export function normalizePort(value, fallback) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

/** host 只接受非空字符串。 */
export function normalizeHost(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** 配置文件的落盘形状：只保留真正需要持久化的字段。 */
export function persistableShape(config) {
  return {
    port: config.port,
    host: config.host,
    token: config.token,
    requireToken: config.requireToken,
    allowNoOrigin: config.allowNoOrigin,
    requireJsonContentType: config.requireJsonContentType,
    visits: config.visits,
    marquee: config.marquee,
    sealOnComplete: config.sealOnComplete,
    floatEnabled: config.floatEnabled,
  }
}
