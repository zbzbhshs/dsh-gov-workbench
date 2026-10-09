/**
 * test/screenshot.mjs —— 用无头 Edge 给六个栏目逐一截图。
 *
 * 为什么要脚本化：README 的示例图得能复现，不能是手工截的。这个脚本起一个
 * 无头 Edge，通过 CDP 注入目标栏目与演示会话，等渲染稳定后截图，最后收干净进程。
 *
 * 前置：3091 上的插件正在运行（图里的数据是真的）。不需要 API 额度。
 *
 * 用法：
 *   node test/screenshot.mjs
 *   node test/screenshot.mjs --session session-xxx
 *   node test/screenshot.mjs --out shots --width 1440 --height 1100
 *
 * 环境变量：
 *   DSH_GOV_EDGE   浏览器可执行文件路径（默认自动探测）
 *   DSH_GOV_BASE   插件地址（默认 http://127.0.0.1:3091）
 *   DSH_GOV_TOKEN  配对令牌（默认从 $DSH_HOME/gov-workbench.json 读）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs (argv) {
  const out = { session: '', out: join(ROOT, 'shots'), width: 1440, height: 1100, port: 9222, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--session') out.session = argv[++i] ?? ''
    else if (a === '--out') out.out = resolve(argv[++i] ?? out.out)
    else if (a === '--width') out.width = Number(argv[++i]) || out.width
    else if (a === '--height') out.height = Number(argv[++i]) || out.height
    else if (a === '--port') out.port = Number(argv[++i]) || out.port
    else if (a === '--keep') out.keep = true
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const BASE = process.env.DSH_GOV_BASE ?? 'http://127.0.0.1:3091'

/**
 * 演示数据层：在页面加载前注入，包装 window.fetch，把会暴露真实数据的
 * 端点换成虚构内容。只影响截图，不进仓库、不影响插件本身。
 *
 * 拦的端点与理由：
 *   session.list        卷宗档案页会列出全部真实会话标题
 *   session.modelCatalog 模型列表里有本机的本地模型路径
 *   directoryPicker.*   工作目录会暴露本机路径
 *   session.page        事项办理页会回放真实对话
 *   session.projections 统计值来自真实会话
 *   workbench.visits    访问计数是本机真实值
 *   workbench.status    运行信息含本机 pid / node 版本
 *   settings.describe   会显示真实 provider baseURL、本地模型路径、密钥环境变量名
 *   permission.catalog  权限档位（内容不敏感，但为一致起见一并替换）
 *   agentPreset.list    模式名（同上）
 *   pluginInventory.list 会列出本机已装的第三方插件
 * 其余端点原样放行。
 */
const DEMO_MOCK_SOURCE = `(() => {
  const OK = (value) => ({ type: 'server-response', rpcId: 'demo', result: { ok: true, value } })
  const NOW = Date.now()
  const DEMO_CWD = 'D:' + String.fromCharCode(92) + 'workspace' + String.fromCharCode(92) + 'demo'
  const DEMO_SESSIONS = [
    { sessionId: 'session-demo-0001', updatedAt: NOW - 60e3, running: false, blank: false, cwd: 'D:\\\\workspace\\\\demo', agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 128, values: { title: '整理季度办理数据并生成汇总表', agentPreset: 'standard', sessionStats: { turns: 3, steps: 12, llmMs: 18400, toolMs: 4200, ttftMs: 900, ttftSteps: 12, decodeMs: 6100, decodeTokens: 1420 } } } },
    { sessionId: 'session-demo-0002', updatedAt: NOW - 3600e3, running: false, blank: false, cwd: 'D:\\\\workspace\\\\demo', agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 86, values: { title: '核对受理材料清单', agentPreset: 'standard', sessionStats: { turns: 2, steps: 7, llmMs: 9200, toolMs: 1800, ttftMs: 700, ttftSteps: 7, decodeMs: 3100, decodeTokens: 640 } } } },
    { sessionId: 'session-demo-0003', updatedAt: NOW - 86400e3, running: false, blank: false, cwd: 'D:\\\\workspace\\\\demo', agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 54, values: { title: '起草事项办理指南', agentPreset: 'minimal', sessionStats: { turns: 1, steps: 5, llmMs: 6100, toolMs: 900, ttftMs: 620, ttftSteps: 5, decodeMs: 2400, decodeTokens: 410 } } } },
    { sessionId: 'session-demo-0004', updatedAt: NOW - 172800e3, running: false, blank: true, cwd: 'D:\\\\workspace\\\\demo', agentAvailable: true, projections: { kind: 'sequenced', asOfSeq: 3, values: { title: null, agentPreset: 'standard' } } },
  ]
  const DEMO_NAMESPACES = [
    { ns: 'agent-default-model', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 1, refs: {} }, value: { provider: 'demo-provider', model: 'demo-standard', reasoningEffort: 'medium' }, base: { provider: 'demo-provider', model: 'demo-standard' }, user: {} },
    { ns: 'ui-theme', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 2, refs: {} }, value: { preference: 'light' }, base: { preference: 'light' }, user: {} },
    { ns: 'web-search-deepseek', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 3, refs: {} }, value: { apiKeyEnv: 'DEMO_SEARCH_KEY', model: 'demo-search', maxTokens: 4096 }, base: {}, user: {} },
    { ns: 'shell', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 4, refs: {} }, value: {}, base: {}, user: {} },
    { ns: 'locale', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 5, refs: {} }, value: { language: 'zh-CN' }, base: {}, user: {} },
    { ns: 'demo-external-provider', autoGenerate: false, applies: 'live', revision: 0, secrets: [], schema: { uid: 6, refs: {} }, value: { providers: { demo: { apiKeyEnv: 'DEMO_API_KEY', displayName: '示例提供方', api: 'openai-completions', baseURL: 'https://api.example.com/v1' } } }, base: {}, user: {} },
  ]
  const DEMO_PERMISSIONS = {
    options: [
      { value: 'read-only', name: '只读', description: '只能读取，不能修改。' },
      { value: 'workspace-write', name: '工作区可写', description: '可修改工作目录内的文件。' },
      { value: 'danger-full-access', name: '完全访问', description: '不受限制。' },
    ],
    defaultOptions: ['read-only', 'workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
  }
  const DEMO_PRESETS = {
    presets: [
      { id: 'standard', name: '标准模式', isDefault: true, trust: 'builtin' },
      { id: 'minimal', name: '极简模式', isDefault: false, trust: 'builtin' },
      { id: 'code', name: 'PTC 模式', isDefault: false, trust: 'builtin' },
    ],
    authorable: false,
    hasDocument: true,
  }
  const DEMO_GROUPS = [
    { id: 'demo-provider', name: '示例提供方', models: [
      { id: 'demo-standard', name: '示例标准模型', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultEffort: 'medium' } },
      { id: 'demo-fast', name: '示例快速模型' },
    ] },
  ]
  const DEMO_RECORDS = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: NOW - 300e3, data: { message: { role: 'user', content: [{ type: 'text', text: '整理本季度各窗口的受理量，输出一张汇总表。' }] } } } },
    { type: 'event', event: { type: 'step/start', seq: 2, time: NOW - 298e3, data: { turn: 1, step: 1 } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: NOW - 296e3, data: { callId: 'call-demo-1', tool: 'read_file', args: { path: 'D:\\\\workspace\\\\demo\\\\data.csv' } } } },
    { type: 'event', event: { type: 'tool/result', seq: 4, time: NOW - 294e3, data: { callId: 'call-demo-1', ok: true, summary: '已读取 240 行' } } },
    { type: 'event', event: { type: 'assistant/message', seq: 5, time: NOW - 290e3, data: { message: { role: 'assistant', content: [{ type: 'text', text: '已汇总 6 个窗口的受理量，共 1,842 件，明细如下。' }] }, usage: { inputTokens: 1280, outputTokens: 356, cacheReadTokens: 640 } } } },
    { type: 'event', event: { type: 'turn/end', seq: 6, time: NOW - 288e3, data: { reason: 'completed' } } },
  ]
  const DEMO_STATS = { turns: 3, steps: 12, llmMs: 18400, toolMs: 4200, ttftMs: 900, ttftSteps: 12, decodeMs: 6100, decodeTokens: 1420 }
  const DEMO_PROJECTIONS = { asOfSeq: 128, values: { title: '整理季度办理数据并生成汇总表', goal: null, agentPreset: 'standard', sessionStats: DEMO_STATS, tokenUsage: { totals: { uncachedInputTokens: 3840, outputTokens: 1068, cacheReadTokens: 1920, cacheWriteTokens: 0 } } } }

  const RULES = [
    [/\/api\/session\.list$/, () => ({ items: DEMO_SESSIONS })],
    [/\/api\/session\.search$/, () => ({ items: DEMO_SESSIONS.slice(0, 3).map(s => ({ sessionId: s.sessionId, snippet: s.projections.values.title || '' })), hasMore: false })],
    [/\/api\/session\.modelCatalog$/, () => ({ default: { provider: 'demo-provider', model: 'demo-standard', reasoningEffort: 'medium' }, routableProviders: ['demo-provider'], groups: DEMO_GROUPS, failures: [] })],
    [/\/api\/session\.page$/, () => ({ records: DEMO_RECORDS, hasMore: false })],
    [/\/api\/session\.projections$/, () => DEMO_PROJECTIONS],
    [/\/api\/directoryPicker\.list$/, () => ({ path: DEMO_CWD, home: 'D:\\\\workspace', crumbs: [{ name: 'D:' }, { name: 'workspace' }, { name: 'demo' }], entries: [{ name: 'data.csv', path: DEMO_CWD + '\\\\data.csv', hidden: false }, { name: 'report', path: DEMO_CWD + '\\\\report', hidden: false }], truncated: false })],
    [/\/api\/workbench\.visits$/, () => ({ visits: 42 })],
    [/\/api\/workbench\.status$/, () => ({ plugin: 'dsh-gov-workbench', host: 'typertGateway', hostAvailable: true, port: 3091, listenHost: '127.0.0.1', requireToken: true, visits: 42, node: 'v24.0.0', pid: 1000, uptimeSeconds: 3600, startedAt: new Date(NOW - 3600e3).toISOString() })],
    [/\/api\/settings\.describe$/, () => ({ writable: true, hasDocument: true, namespaces: DEMO_NAMESPACES })],
    [/\/api\/permission\.catalog$/, () => DEMO_PERMISSIONS],
    [/\/api\/agentPreset\.list$/, () => DEMO_PRESETS],
    [/\/api\/pluginInventory\.list$/, () => ({ entries: [{ id: 'dsh-base', name: '@deepseek-ai/dsh-base', active: true }, { id: 'dsh-web-app', name: '@deepseek-ai/dsh-web-app', active: true }, { id: 'gov-workbench', name: 'dsh-gov-workbench', active: true }], presets: [] })],
  ]

  const original = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    for (const [re, make] of RULES) {
      if (re.test(url)) {
        return Promise.resolve(new Response(JSON.stringify(OK(make())), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
    }
    return original.apply(this, arguments)
  }
})()`

const PAGES = [
  ['home', '01-home'],
  ['matters', '02-matters'],
  ['archive', '03-archive'],
  ['trace', '04-trace'],
  ['settings', '05-settings'],
  ['rules', '06-rules'],
]

function findBrowser () {
  if (process.env.DSH_GOV_EDGE && existsSync(process.env.DSH_GOV_EDGE)) return process.env.DSH_GOV_EDGE
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\Edge\\Application\\msedge.exe'),
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/microsoft-edge',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ]
  return candidates.find((p) => p !== '' && existsSync(p))
}

function readToken () {
  if (process.env.DSH_GOV_TOKEN) return process.env.DSH_GOV_TOKEN
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const p = join(home, 'gov-workbench.json')
  if (!existsSync(p)) return ''
  try {
    return JSON.parse(readFileSync(p, 'utf8')).token ?? ''
  } catch {
    return ''
  }
}

/**
 * 结束浏览器进程树。
 *
 * Windows 上 `child.kill()` 只结束父进程，Edge 的子进程（渲染器 / GPU /
 * 网络服务）会残留并继续占着调试端口与 profile 目录，表现为脚本卡住不退出。
 * 所以 Windows 走 `taskkill /T`，其它平台用进程组信号。
 */
function killTree (child) {
  if (child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
    return
  }
  try { child.kill('SIGKILL') } catch { /* 已退出 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson (url, init) {
  const res = await fetch(url, init)
  return await res.json()
}

async function waitForCdp (port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await fetchJson(`http://127.0.0.1:${port}/json/version`)
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl
    } catch {
      /* 未就绪 */
    }
    await sleep(400)
  }
  return ''
}

class CdpSession {
  constructor (ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.id === undefined) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message ?? 'CDP 错误'))
      else slot.resolve(msg.result)
    })
  }

  send (method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30_000)
    })
  }

  static async connect (url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    return new CdpSession(ws)
  }
}

async function main () {
  const browser = findBrowser()
  if (!browser) {
    console.log('未找到 Edge / Chrome，跳过截图。用 DSH_GOV_EDGE 指定可执行文件路径。')
    process.exit(0)
  }

  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (error) {
    console.log(`插件未在 ${BASE} 响应：${error.message}`)
    console.log('先启动 dsh（插件随宿主进程挂载），再跑本脚本。')
    process.exit(1)
  }

  mkdirSync(ARGS.out, { recursive: true })
  const profileDir = join(ARGS.out, '.browser-profile')
  const token = readToken()

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    `--remote-debugging-port=${ARGS.port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${ARGS.width},${ARGS.height}`,
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    const browserWs = await waitForCdp(ARGS.port)
    if (!browserWs) throw new Error('CDP 调试端口未就绪')

    let target
    try {
      target = await fetchJson(`http://127.0.0.1:${ARGS.port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    } catch {
      target = await fetchJson(`http://127.0.0.1:${ARGS.port}/json/new?${encodeURIComponent('about:blank')}`)
    }
    if (!target.webSocketDebuggerUrl) throw new Error('无法新建标签页')

    const page = await CdpSession.connect(target.webSocketDebuggerUrl)
    await page.send('Page.enable')
    await page.send('Runtime.enable')

    await page.send('Page.navigate', { url: `${BASE}/` })
    await sleep(2500)

    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: DEMO_MOCK_SOURCE })

    const prefs = {
      page: 'home',
      sessionId: ARGS.session,
      workspace: '',
      permission: '',
      preset: '',
      provider: '',
      model: '',
      reasoningEffort: '',
      autoScrollTrace: true,
      traceChunkFilter: '',
      sealOnComplete: true,
      floatEnabled: true,
      largeFont: false,
      highContrast: false,
      marquee: [],
    }
    // 安装演示数据层：包装 window.fetch，把几个端点换成假数据。
    // 目的是让 README 的示例图不夹带真实会话标题与本地路径。
    const cookie = token === '' ? '' : `document.cookie = 'dsh_gov_workbench_token=${token}; Path=/; SameSite=Strict';`
    await page.send('Runtime.evaluate', {
      expression: `(() => { localStorage.setItem('dsh.govWorkbench.v1', ${JSON.stringify(JSON.stringify(prefs))}); ${cookie} return 'ok' })()`,
      returnByValue: true,
    })

    for (const [pageName, fileBase] of PAGES) {
      await page.send('Runtime.evaluate', {
        expression: `(() => { const raw = JSON.parse(localStorage.getItem('dsh.govWorkbench.v1') || '{}'); raw.page = ${JSON.stringify(pageName)}; localStorage.setItem('dsh.govWorkbench.v1', JSON.stringify(raw)); return raw.page })()`,
        returnByValue: true,
      })
      await page.send('Page.navigate', { url: `${BASE}/` })
      await sleep(2600)

      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(join(ARGS.out, `${fileBase}.png`), Buffer.from(shot.data, 'base64'))
      console.log(`  ✓ ${pageName.padEnd(10)} → ${join(ARGS.out, fileBase + '.png')}`)
    }

    console.log('')
    console.log(`截图完成，输出目录：${ARGS.out}`)
    if (ARGS.session === '') console.log('提示：未指定 --session，事项办理页显示浏览器里原有的会话。')
  } finally {
    if (!ARGS.keep) {
      killTree(child)
    } else {
      console.log(`浏览器保留在调试端口 ${ARGS.port}`)
    }
  }
}

main().catch((error) => {
  console.log('截图失败：' + (error?.message ?? String(error)))
  process.exit(1)
})