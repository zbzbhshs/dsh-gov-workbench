/* ====================================================================
 * util.js —— 纯函数工具：DOM、格式化、时间、转义
 * 无依赖，不碰网络与状态。
 * ==================================================================== */
(function (global) {
  'use strict'

  /** 按 id 取元素。 */
  function $(id) {
    return document.getElementById(id)
  }

  /** 查询单个元素。 */
  function qs(selector, root) {
    return (root || document).querySelector(selector)
  }

  /** 查询全部元素，返回真数组。 */
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector))
  }

  /** 建元素；attrs 里 class/text/html/dataset/on* 有特殊处理。 */
  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        const value = attrs[key]
        if (value === undefined || value === null) return
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { node.dataset[k] = value[k] })
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value)
      })
    }
    if (children) {
      ;(Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === undefined || child === null || child === false) return
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
      })
    }
    return node
  }

  /** 清空一个节点。 */
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild)
  }

  /** HTML 转义（只在确实需要拼 HTML 时用）。 */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /** 6 位补零。 */
  function pad6(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return '000000'
    return String(Math.floor(n)).padStart(6, '0')
  }

  /** 两位补零。 */
  function pad2(value) {
    return String(Math.floor(Number(value) || 0)).padStart(2, '0')
  }

  /** 本地时间 yyyy-mm-dd hh:mm:ss（精确到秒）。 */
  function formatDateTime(date) {
    const d = date || new Date()
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }

  /** 中文星期。 */
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

  /** 本地时间戳 → HH:mm:ss。 */
  function formatClock(ms) {
    if (!Number.isFinite(ms)) return '--:--:--'
    const d = new Date(ms)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }

  /** 本地时间戳 → yyyy-mm-dd HH:mm:ss。 */
  function formatStamp(ms) {
    if (!Number.isFinite(ms)) return '—'
    return formatDateTime(new Date(ms))
  }

  /** 毫秒 → 可读耗时（用于统计行）。 */
  function formatMs(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return '0 ms'
    if (n < 1000) return Math.round(n) + ' ms'
    return (n / 1000).toFixed(2) + ' s'
  }

  /** 数字 → 千分位。 */
  function formatInt(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '0'
    return Math.round(n).toLocaleString('en-US')
  }

  /** 字节 → 可读体积。 */
  function formatBytes(bytes) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let index = 0
    let value = n
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }
    return (index === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index]
  }

  /** 相对时间描述。 */
  function formatAgo(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return '—'
    const diff = Date.now() - n
    if (diff < 0) return '刚刚'
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return seconds + ' 秒前'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + ' 分钟前'
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + ' 小时前'
    const days = Math.floor(hours / 24)
    if (days < 30) return days + ' 天前'
    return formatDateTime(new Date(n))
  }

  /** 短 id 展示：只留头尾。 */
  function shortId(id, head, tail) {
    const text = String(id === undefined || id === null ? '' : id)
    const h = head === undefined ? 8 : head
    const t = tail === undefined ? 4 : tail
    if (text.length <= h + t + 1) return text
    return text.slice(0, h) + '…' + text.slice(text.length - t)
  }

  /** 深拷贝（只处理 JSON 安全数据）。 */
  function clone(value) {
    if (value === undefined || value === null) return value
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (error) {
      return value
    }
  }

  /** 简单防抖。 */
  function debounce(fn, wait) {
    let timer
    return function () {
      const args = arguments
      const self = this
      clearTimeout(timer)
      timer = setTimeout(function () { fn.apply(self, args) }, wait || 120)
    }
  }

  /** 节流（按帧）。 */
  function throttleFrame(fn) {
    let scheduled = false
    let lastArgs = null
    return function () {
      lastArgs = arguments
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(function () {
        scheduled = false
        fn.apply(null, lastArgs)
      })
    }
  }

  /** 生成一个 uuid（带降级）。 */
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  /** 把任意值渲染成稳定文本（对象走 JSON）。 */
  function toText(value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
      return JSON.stringify(value, null, 2)
    } catch (error) {
      return String(value)
    }
  }

  /** 把长文本截断到 n 字符。 */
  function truncate(text, n) {
    const s = String(text === undefined || text === null ? '' : text)
    if (s.length <= n) return s
    return s.slice(0, n) + '…'
  }

  global.GovUtil = {
    $: $,
    qs: qs,
    qsa: qsa,
    el: el,
    clear: clear,
    escapeHtml: escapeHtml,
    pad6: pad6,
    pad2: pad2,
    formatDateTime: formatDateTime,
    formatClock: formatClock,
    formatStamp: formatStamp,
    formatMs: formatMs,
    formatInt: formatInt,
    formatBytes: formatBytes,
    formatAgo: formatAgo,
    shortId: shortId,
    clone: clone,
    debounce: debounce,
    throttleFrame: throttleFrame,
    uuid: uuid,
    toText: toText,
    truncate: truncate,
    WEEKDAYS: WEEKDAYS,
  }
})(window)
