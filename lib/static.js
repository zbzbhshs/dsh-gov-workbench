/**
 * 静态资源托管。
 *
 * 每次请求都从磁盘读，所以改完 `public/` 刷新即生效，不需要重启 dsh。
 * 只做两件事：把路径规范化并锁死在 `public/` 之内（防目录穿越），
 * 以及给每个扩展名一个明确的 Content-Type。
 */
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** 扩展名 → MIME。全部带 charset，避免中文乱码。 */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
})

/**
 * 把 URL 路径解析成 public 目录内的绝对文件路径。
 *
 * @param publicDir - public 目录绝对路径。
 * @param pathname - URL pathname。
 * @returns 绝对路径；越界时返回 undefined。
 */
export function resolveStaticPath(publicDir, pathname) {
  let relative = pathname
  try {
    relative = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (relative === '' || relative === '/') relative = '/index.html'
  // 去掉前导分隔符后规范化，再拼回 publicDir，最后校验前缀。
  const trimmed = relative.replace(/^[/\\]+/, '')
  const target = resolve(publicDir, normalize(trimmed))
  const root = resolve(publicDir)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/**
 * 读一个静态文件。
 *
 * @param publicDir - public 目录绝对路径。
 * @param pathname - URL pathname。
 * @returns `{ status, body, contentType }`；404 时 body 为 undefined。
 */
export async function readStatic(publicDir, pathname) {
  const target = resolveStaticPath(publicDir, pathname)
  if (target === undefined) return { status: 403 }
  try {
    const body = await readFile(target)
    return { status: 200, body, contentType: MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' }
  } catch {
    return { status: 404 }
  }
}

/**
 * 静态请求处理器：命中就返回文件，未命中回落到 index.html（单页导航兜底）。
 *
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param pathname - URL pathname。
 * @param publicDir - public 目录绝对路径。
 */
export async function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  const found = await readStatic(publicDir, pathname)
  if (found.status === 200) {
    res.writeHead(200, {
      'content-type': found.contentType,
      'cache-control': 'no-cache',
      'content-length': String(found.body.byteLength),
    })
    res.end(req.method === 'HEAD' ? undefined : found.body)
    return
  }
  if (found.status === 403) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }
  const fallback = await readStatic(publicDir, '/index.html')
  if (fallback.status === 200) {
    res.writeHead(200, { 'content-type': fallback.contentType, 'cache-control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : fallback.body)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/** 插件根目录下的 public 绝对路径。 */
export function publicDirOf(libDir) {
  return join(libDir, '..', 'public')
}
