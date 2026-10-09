/**
 * 来源校验、Content-Type 校验与配对令牌校验。
 *
 * 这一层修掉参考实现的一个真实缺陷：原版只对 `/plugin/*` 做 origin 白名单，
 * `/api/*` 完全裸奔，而且 `readJsonBody` 不看 Content-Type 直接 JSON.parse。
 * 结果是任意网页都能用 `content-type: text/plain` 的简单请求（不触发预检）
 * 打到 `http://127.0.0.1:<port>/api/session.prompt`，把整个宿主 API 网关
 * 变成 CSRF 驱动点。
 *
 * 本模块的判定顺序（任一失败即拒绝，且都不执行副作用）：
 *   1. 有 `Origin` → `new URL(origin).host` 必须等于 `req.headers.host`；
 *      没有 `Origin` → 由 `allowNoOrigin` 决定放行（同源导航 / curl）。
 *   2. `sec-fetch-site: cross-site` → 拒绝。
 *   3. 写请求的 `Content-Type` 必须是 `application/json`。
 *   4. 开启 `requireToken` 时，Cookie 或 `x-gov-token` 头必须带正确令牌。
 */

/** 令牌的 Cookie 名。 */
export const TOKEN_COOKIE = 'dsh_gov_workbench_token'

/** 令牌的自定义请求头名（给不带 Cookie 的脚本用）。 */
export const TOKEN_HEADER = 'x-gov-token'

/** 拒绝原因 → 给浏览器的说明。 */
export const REJECT_REASON = Object.freeze({
  origin: '跨源请求被拒绝：Origin 与 Host 不一致。',
  crossSite: '跨站请求被拒绝：sec-fetch-site 为 cross-site。',
  noOrigin: '缺少 Origin 头的请求被拒绝（当前配置不允许）。',
  contentType: 'Content-Type 必须是 application/json。',
  token: '配对令牌无效或缺失。',
  method: '该端点不支持此请求方法。',
})

/**
 * 把 `host` 头规范化成可比较的 authority。
 * @param value - 原始 Host 头。
 * @returns 规范化后的 authority，无法解析时返回 undefined。
 */
export function normalizeAuthority(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return new URL(`http://${value}`).host
  } catch {
    return undefined
  }
}

/**
 * 判定一个请求是否通过来源校验。
 * @param req - node:http 的 IncomingMessage。
 * @param options - `{ allowNoOrigin }`。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
 */
export function checkOrigin(req, options = {}) {
  const allowNoOrigin = options.allowNoOrigin !== false
  const headers = req.headers ?? {}
  const authority = normalizeAuthority(headers.host)
  if (authority === undefined) {
    // 没有 Host 头：HTTP/1.1 必有 Host，缺失说明请求被构造过。
    return { ok: false, reason: REJECT_REASON.origin }
  }
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].toLowerCase() : ''
  if (site === 'cross-site') return { ok: false, reason: REJECT_REASON.crossSite }

  const origin = headers.origin
  if (origin === undefined || origin === '') {
    if (!allowNoOrigin) return { ok: false, reason: REJECT_REASON.noOrigin }
    return { ok: true }
  }
  let originAuthority
  try {
    originAuthority = new URL(origin).host
  } catch {
    return { ok: false, reason: REJECT_REASON.origin }
  }
  if (originAuthority !== authority) return { ok: false, reason: REJECT_REASON.origin }
  return { ok: true }
}

/**
 * 判定写请求的 Content-Type 是否为 application/json。
 * @param req - IncomingMessage。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
 */
export function checkContentType(req) {
  const raw = req.headers?.['content-type']
  const value = typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : ''
  if (value === 'application/json') return { ok: true }
  return { ok: false, reason: REJECT_REASON.contentType }
}

/**
 * 从 Cookie 头里取一个 cookie 值（只做精确名匹配，不引入 cookie 解析库）。
 * @param header - 原始 Cookie 头。
 * @param name - cookie 名。
 * @returns cookie 值或 undefined。
 */
export function readCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** 常量时间字符串比较，避免令牌逐字符试探。 */
export function timingSafeEqualString(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index]
  return diff === 0
}

/**
 * 判定请求是否携带正确配对令牌。
 * 先看 `x-gov-token` 头，再看 Cookie；两者任一正确即通过。
 * @param req - IncomingMessage。
 * @param token - 服务端当前令牌。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
 */
export function checkToken(req, token) {
  const headers = req.headers ?? {}
  const fromHeader = headers[TOKEN_HEADER]
  if (typeof fromHeader === 'string' && timingSafeEqualString(fromHeader, token)) return { ok: true }
  const fromCookie = readCookie(headers.cookie, TOKEN_COOKIE)
  if (typeof fromCookie === 'string' && timingSafeEqualString(fromCookie, token)) return { ok: true }
  return { ok: false, reason: REJECT_REASON.token }
}

/**
 * 一个受保护端点请求的完整准入判定。
 *
 * 顺序刻意如此：来源校验 → 令牌校验 → Content-Type 校验。Content-Type
 * 放在最后是因为它只对写请求有意义，且读请求不带 body 时不该因此被拒。
 *
 * @param req - IncomingMessage。
 * @param options - `{ token, requireToken, allowNoOrigin, requireJsonContentType }`。
 * @returns `{ ok: true }` 或 `{ ok: false, status, reason }`。
 */
export function admit(req, options = {}) {
  const origin = checkOrigin(req, { allowNoOrigin: options.allowNoOrigin })
  if (!origin.ok) return { ok: false, status: 403, reason: origin.reason }

  if (options.requireToken !== false) {
    const token = checkToken(req, options.token ?? '')
    if (!token.ok) return { ok: false, status: 401, reason: token.reason }
  }

  const method = (req.method ?? 'GET').toUpperCase()
  const writes = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  if (writes && options.requireJsonContentType !== false) {
    const contentType = checkContentType(req)
    if (!contentType.ok) return { ok: false, status: 415, reason: contentType.reason }
  }

  return { ok: true }
}

/** 令牌 Cookie 的 Set-Cookie 值。`HttpOnly` 由页面自己决定是否要 JS 读。 */
export function tokenCookieHeader(token, options = {}) {
  const attributes = [
    `${TOKEN_COOKIE}=${token}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${String(options.maxAgeSeconds ?? 60 * 60 * 24 * 365)}`,
  ]
  if (options.httpOnly === true) attributes.push('HttpOnly')
  if (options.secure === true) attributes.push('Secure')
  return attributes.join('; ')
}
