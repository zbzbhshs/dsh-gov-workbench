/**
 * _live-degrade.mjs —— 真机验证工作目录降级路径。
 *
 * `directoryPicker.pick` 会弹**原生对话框**并阻塞，所以不能在这里真的等它返回。
 * 但可以证明两件事（这才是「降级路径可用」的关键前提）：
 *   1. 该端点**真实存在**（请求发出去后不立刻回 invocation-unavailable，
 *      而是挂住等对话框 —— 用超时中止区分这两种情况）；
 *   2. `directoryPicker.list` 的失败错误码是 `directory-picker/unavailable`，
 *      与前端 `setCwdMode('native')` 的判断分支一致。
 *
 * 运行：node test/_live-degrade.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'gov-workbench.json'), 'utf8')).token
const BASE = 'http://127.0.0.1:3091'

async function call (method, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gov-token': TOKEN },
      body: JSON.stringify({ type: 'client-request', rpcId: 'd-' + Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
      signal: controller.signal,
    })
    return { settled: true, result: (await resp.json()).result }
  } catch (error) {
    return { settled: false, error: String(error && error.name) }
  } finally {
    clearTimeout(timer)
  }
}

console.log('\n=== ① directoryPicker.list 的失败错误码 ===')
const list = await call('directoryPicker.list', {}, 8000)
console.log(JSON.stringify(list.result, null, 1))
const code = list.settled && list.result && list.result.error ? list.result.error.code : undefined
console.log('错误码 =', code)
console.log()
console.log('注意：3091 上跑的是**旧构建**（lib/ 改动需重启才生效），所以空 payload 仍被')
console.log('旧 buildArgs 包成 {path:{}}，得到 gateway/input-invalid。重启后同一请求会变成')
console.log('directory-picker/unavailable（buildArgs 已按 acceptsUndefined 省略该 wire）。')
console.log()
console.log('前端降级分支覆盖两种码，任何一种都会切到可手动编辑：')
console.log('  directory-picker/unavailable → setCwdMode(\'native\')（仅原生选择）')
console.log('  其它错误码                   → setCwdMode(\'manual\')（手动输入）')
console.log('  当前旧构建命中 =', code === 'directory-picker/unavailable' ? 'native' : 'manual', '（两种都不是「只禁用下拉」）')

console.log('\n=== ② directoryPicker.pick 端点是否真实存在（2 秒后主动中止，不等对话框） ===')
const pick = await call('directoryPicker.pick', {}, 2000)
if (pick.settled === false) {
  // 请求挂住了 —— 说明宿主真的进到了原生对话框，端点存在且可调用。
  console.log('结果：请求在 2 秒内未返回（' + pick.error + '）→ 端点存在，宿主已进入原生对话框等待用户操作')
  console.log('      「浏览…」按钮可用的前提成立；本次验证主动中止，未点击任何对话框。')
} else {
  const err = pick.result && pick.result.error
  const exists = !(err && err.code === 'gateway/invocation-unavailable')
  console.log('结果：' + JSON.stringify(pick.result))
  console.log('端点存在（不是 invocation-unavailable）=', exists)
}

console.log('\n=== ③ directoryPicker.createDirectory 的 wire 名（path + name） ===')
const createDir = await call('directoryPicker.createDirectory', { path: 'C:\\', name: '__gov_probe__' }, 8000)
console.log(JSON.stringify(createDir.result).slice(0, 300))
const createCode = createDir.settled && createDir.result && createDir.result.error ? createDir.result.error.code : undefined
console.log('错误码 =', createCode, createCode === 'directory-picker/unavailable' ? '（args 投影通过，缺的是 browse capability —— 不是参数形状错误）' : '')

console.log('\n=== ④ session.search 的失败原因（BUG 6） ===')
const search = await call('session.search', { query: '__gov_probe__' }, 8000)
console.log(JSON.stringify(search.result, null, 1))
const searchCode = search.result && search.result.error ? search.result.error.code : undefined
const searchMessage = search.result && search.result.error ? String(search.result.error.message) : ''
console.log('错误码 =', searchCode)
console.log('describeError 能否识别为「宿主未启用会话检索」=',
  searchCode === 'gateway/internal' && /session search is disabled/i.test(searchMessage))
