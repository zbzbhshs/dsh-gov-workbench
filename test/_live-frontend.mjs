/**
 * _live-frontend.mjs —— 真机联调：把**改后的前端模块**在 VM 里跑起来，
 * 用桩 fetch 捕获它真正发出的 wire body，再把这些 body 原样打到运行中的
 * 3091（真 dsh 宿主进程内），看宿主是否接受。
 *
 * ## 为什么必须这么做
 *
 * 3091 托管的是 `profiles/desktop/node_modules/dsh-gov-workbench/public/` 下的
 * **安装副本**，而不是本仓库的 `public/`（实测：`served === installed` 为 true，
 * `served === repo` 为 false；仓库里新建的探针文件在 3091 上回落到 index.html）。
 * 本次修复不允许改动 `profiles/` 下的任何文件、也不允许重装插件，所以
 * 「页面真的发出去的请求」只能在 VM 里复现，再用真机验证该请求被接受。
 *
 * 这比静态 grep 强得多：它跑的是**真前端代码**，验证的是**真宿主**。
 *
 * 运行：node test/_live-frontend.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const TOKEN = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'gov-workbench.json'), 'utf8')).token
const BASE = 'http://127.0.0.1:3091'

/* ---------------- 1. 在 VM 里加载改后的前端，捕获 wire body ---------------- */

const captured = []

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  Intl,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  Boolean,
  Error,
  TextDecoder,
  AbortController,
  crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
  // 桩 fetch：只记录 body，返回一个合法的 server-response 信封。
  fetch: async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : undefined
    captured.push({ url, body })
    const rpcId = body && body.rpcId ? body.rpcId : 'rpc'
    return {
      ok: true,
      status: 200,
      async json () {
        return { type: 'server-response', rpcId, result: { ok: true, value: { accepted: true } } }
      },
      async text () { return '' },
    }
  },
  document: {
    cookie: 'dsh_gov_workbench_token=' + TOKEN,
    createElement: () => ({ style: {}, appendChild () {}, click () {}, remove () {} }),
    body: { appendChild () {} },
  },
  localStorage: { getItem: () => null, setItem () {} },
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

const context = vm.createContext(sandbox)
for (const file of ['public/js/util.js', 'public/js/api.js']) {
  vm.runInContext(read(file), context, { filename: file })
}

const GovApi = sandbox.GovApi

/* ---------------- 2. 取真机上的真实取值（不硬编码任何模型/预设） ---------------- */

async function call (method, payload) {
  const resp = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gov-token': TOKEN },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-' + Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
  })
  const text = await resp.text()
  try { return JSON.parse(text).result } catch { return { ok: false, error: { code: 'transport', message: text } } }
}

const catalog = await call('session.modelCatalog', {})
const groups = catalog.ok ? (catalog.value.groups ?? []) : []
const group = groups.find((g) => (g.models ?? []).length > 0)
const modelEntry = group ? group.models[0] : undefined
const presetList = await call('agentPreset.list', {})
const presetId = presetList.ok ? (presetList.value.presets ?? []).find((p) => !p.broken)?.id : undefined

// 为 selectModel / agentPreset.select 各建一个**全新会话**（已启动的会话会被
// 宿主以 agent-preset/locked 拒绝，那不是 schema 问题，会掩盖真结论）。
const freshForModel = await call('session.create', {})
const freshForPreset = await call('session.create', {})
const sessionForModel = freshForModel.ok ? freshForModel.value.sessionId : undefined
const sessionForPreset = freshForPreset.ok ? freshForPreset.value.sessionId : undefined

console.log('\n真机取值：')
console.log('  provider/model =', group ? group.id : '(无)', '/', modelEntry ? modelEntry.id : '(无)')
console.log('  agentPreset    =', presetId)
console.log('  新会话（模型） =', sessionForModel)
console.log('  新会话（预设） =', sessionForPreset)

/* ---------------- 3. 采集前端真实发出的 payload ---------------- */

captured.length = 0
await GovApi.sessions.prompt({
  sessionId: sessionForModel,
  mode: 'queue',
  content: [{ type: 'text', text: '真机验证：请只回复「收到」两字，不要调用任何工具。' }],
  clientTimeZone: 'Asia/Shanghai',
})
const promptBody = captured[0].body

captured.length = 0
await GovApi.sessions.selectModel({
  sessionId: sessionForModel,
  provider: group.id,
  model: modelEntry.id,
  reasoningEffort: modelEntry.reasoning?.defaultEffort,
})
const selectBody = captured[0].body

captured.length = 0
await GovApi.agentPresets.select(sessionForPreset, presetId)
const presetBody = captured[0].body

captured.length = 0
await GovApi.skills.list({ sessionId: sessionForModel })
const skillsBody = captured[0].body

captured.length = 0
await GovApi.directoryPicker.list({})
const dirEmptyBody = captured[0].body

captured.length = 0
await GovApi.sessions.page({ address: { kind: 'session', sessionId: sessionForModel }, throughSeq: 3, maxMessages: 5 })
const pageBody = captured[0].body

captured.length = 0
await GovApi.sessions.search({ query: '__gov_probe__' })
const searchBody = captured[0].body

console.log('\n=== 改后前端发出的 wire body ===')
for (const [label, body] of [
  ['session.prompt', promptBody],
  ['session.selectModel', selectBody],
  ['agentPreset.select', presetBody],
  ['skills.list', skillsBody],
  ['directoryPicker.list({})', dirEmptyBody],
  ['session.page', pageBody],
  ['session.search', searchBody],
]) {
  console.log(`${label.padEnd(26)} ${body.method.padEnd(24)} payload=${JSON.stringify(body.payload)}`)
}

/* ---------------- 4. 把这些 body 原样打到真机 3091 ---------------- */

async function send (body) {
  const resp = await fetch(`${BASE}/api/${body.method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gov-token': TOKEN },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

console.log('\n=== 原样打到真机 3091（运行中的 dsh 宿主） ===')
const results = []
for (const [label, body, expectOk] of [
  ['session.prompt（带 requestId）', promptBody, true],
  ['session.selectModel（带 provider + reasoningEffort）', selectBody, true],
  ['agentPreset.select（agentId + agentPreset）', presetBody, true],
  ['skills.list（复数 namespace + sessionId）', skillsBody, true],
  ['directoryPicker.list({})', dirEmptyBody, false],
  ['session.page（游标内 throughSeq）', pageBody, true],
  ['session.search（宿主未建索引）', searchBody, false],
]) {
  const out = await send(body)
  const r = out.result
  const accepted = Boolean(r && r.ok === true) === expectOk
  results.push({ label, accepted, result: r })
  const verdict = r && r.ok === true
    ? `OK   ${JSON.stringify(r.value).slice(0, 150)}`
    : `拒绝 ${JSON.stringify(r && r.error).slice(0, 220)}`
  console.log(`${label}\n   → ${verdict}`)
}

/* ---------------- 汇总 ---------------- */

const bad = results.filter((r) => !r.accepted)
console.log('\n真机结果：' + (results.length - bad.length) + '/' + results.length + ' 符合预期')
console.log('说明：directoryPicker.list({}) 与 session.search 的「拒绝」是**预期**的 ——')
console.log('      前者因 3091 跑的是旧构建（lib/ 改动需重启），后者因宿主未建检索索引。')
if (bad.length > 0) {
  console.log('不符合预期：')
  for (const item of bad) console.log('  ' + item.label + ' → ' + JSON.stringify(item.result && item.result.error))
}
process.exit(bad.length === 0 ? 0 : 1)
