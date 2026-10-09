/**
 * _live-verify.mjs —— 真机验证：提交一条真实消息后，宿主侧确有推进。
 *
 * 三项证据（全部来自宿主自己的返回，不做任何推算）：
 *   1. session.prompt 返回 {"accepted":true}
 *   2. session.list 里该会话的 updatedAt 增大
 *   3. session.projections 的 asOfSeq 增大（游标前进 = 事件真的落盘）
 *
 * 运行：node test/_live-verify.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'gov-workbench.json'), 'utf8')).token
const BASE = 'http://127.0.0.1:3091'

async function call (method, payload) {
  const resp = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gov-token': TOKEN },
    body: JSON.stringify({ type: 'client-request', rpcId: 'v-' + Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
  })
  return (await resp.json()).result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function snapshot (sessionId) {
  const list = await call('session.list', {})
  const item = list.ok ? (list.value.items ?? []).find((i) => i.sessionId === sessionId) : undefined
  const proj = await call('session.projections', { sessionId })
  return {
    updatedAt: item ? item.updatedAt : undefined,
    asOfSeq: proj.ok ? proj.value.asOfSeq : undefined,
    title: proj.ok ? proj.value.values.title : undefined,
  }
}

const created = await call('session.create', {})
if (!created.ok) {
  console.log('session.create 失败：', JSON.stringify(created.error))
  process.exit(1)
}
const sessionId = created.value.sessionId
console.log('新会话：', sessionId)

const before = await snapshot(sessionId)
console.log('提交前：', JSON.stringify(before))

const accepted = await call('session.prompt', {
  requestId: 'live-verify-' + Date.now(),
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请只回复「收到」两字，不要调用任何工具。' }],
  clientTimeZone: 'Asia/Shanghai',
})
console.log('session.prompt →', JSON.stringify(accepted))

// 等宿主把这一轮落盘（轮询而不是死等，最多 90 秒）
let after = before
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  await sleep(1500)
  after = await snapshot(sessionId)
  if (after.updatedAt > before.updatedAt && after.asOfSeq > before.asOfSeq) break
}

console.log('提交后：', JSON.stringify(after))
console.log()
console.log('① session.prompt accepted     =', accepted.ok === true && accepted.value.accepted === true)
console.log('② updatedAt 增长              =', after.updatedAt > before.updatedAt, `(${before.updatedAt} → ${after.updatedAt})`)
console.log('③ asOfSeq 增长（事件落盘）     =', after.asOfSeq > before.asOfSeq, `(${before.asOfSeq} → ${after.asOfSeq})`)
console.log('④ 宿主自动生成标题            =', typeof after.title === 'string' && after.title !== '' ? JSON.stringify(after.title) : '(未生成)')

const all = accepted.ok === true && accepted.value.accepted === true && after.updatedAt > before.updatedAt && after.asOfSeq > before.asOfSeq
console.log('\n结论：', all ? '全部通过 —— 消息真的发出去了并落到宿主会话日志' : '有未通过项')
process.exit(all ? 0 : 1)
