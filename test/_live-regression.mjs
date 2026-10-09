/**
 * _live-regression.mjs —— 真机回归：确认原先可用的端点没被改坏。
 *
 * 覆盖任务清单里列出的「已验证可用，不要改坏」清单，全部打真机 3091。
 *
 * 运行：node test/_live-regression.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = JSON.parse(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'gov-workbench.json'), 'utf8')).token
const BASE = 'http://127.0.0.1:3091'

async function call (method, payload) {
  const resp = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gov-token': TOKEN },
    body: JSON.stringify({ type: 'client-request', rpcId: 'g-' + Math.random().toString(36).slice(2), method, payload: payload ?? {} }),
  })
  const text = await resp.text()
  try { return JSON.parse(text).result } catch { return { ok: false, error: { code: 'transport', message: text.slice(0, 200) } } }
}

// 先建一个会话，供需要 sessionId 的端点使用
const created = await call('session.create', {})
const sessionId = created.ok ? created.value.sessionId : undefined

// provider/model 从宿主目录动态取，不硬编码（`model: 'M'` 这种假值会被宿主以
// session/model-unavailable 拒绝，那是业务校验不是 schema 问题）。
const catalog = await call('session.modelCatalog', {})
const group = catalog.ok ? (catalog.value.groups ?? []).find((g) => (g.models ?? []).length > 0) : undefined
const modelEntry = group ? group.models[0] : undefined

const cases = [
  ['session.list', {}, (v) => `items=${v.items.length}`],
  ['session.modelCatalog', {}, (v) => `groups=${v.groups.length} models=${v.groups.reduce((n, g) => n + g.models.length, 0)}`],
  ['agentPreset.list', {}, (v) => `presets=${v.presets.length}`],
  ['agentPreset.read', { agentPreset: 'standard' }, (v) => `content=${v.content.length}B`],
  ['permission.catalog', {}, (v) => `options=${v.options.length} default=${v.defaultPreset}`],
  ['settings.describe', {}, (v) => `namespaces=${v.namespaces.length}`],
  ['session.rename', { sessionId, title: '回归改名' }, (v) => JSON.stringify(v)],
  ['session.projections', { sessionId }, (v) => `asOfSeq=${v.asOfSeq} keys=${Object.keys(v.values).length}`],
  ['session.fork', { sessionId, atSeq: 1 }, (v) => `sessionId=${v.sessionId ?? JSON.stringify(v)}`],
  ['workbench.status', {}, (v) => `host=${v.host} port=${v.port}`],
  ['workbench.visits', {}, (v) => `visits=${v.visits}`],
  ['llm.listProviders', {}, (v) => `providers=${v.length}`],
  ['pluginInventory.list', {}, (v) => `entries=${v.entries.length} presets=${v.agentPresets.length}`],
  ['skills.list', { sessionId }, (v) => `skills=${v.skills.length}`],
  ['session.page', { address: { kind: 'session', sessionId }, throughSeq: 3, maxMessages: 5 }, (v) => `records=${v.records.length}`],
  ['session.selectModel', { sessionId, provider: group ? group.id : 'x', model: modelEntry ? modelEntry.id : 'y' }, (v) => JSON.stringify(v.selected)],
  ['session.prompt', { requestId: 'reg', sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] }, (v) => `accepted=${v.accepted}`],
]

let pass = 0
let fail = 0
for (const [method, payload, summarize] of cases) {
  const r = await call(method, payload)
  const ok = r.ok === true
  if (ok) pass += 1
  else fail += 1
  const detail = ok
    ? (summarize ? summarize(r.value) : JSON.stringify(r.value).slice(0, 120))
    : `${r.error.code}: ${r.error.message}`.slice(0, 160)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${method.padEnd(28)} ${detail}`)
}
console.log(`\n回归：${pass}/${cases.length} 通过`)
