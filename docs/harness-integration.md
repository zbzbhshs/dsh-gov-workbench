# dsh 宿主集成面笔记（0.2.0-rc.2 实测）

本文是 `dsh-gov-workbench` 插件的宿主集成面记录：插件在独立端口（默认 3091）拉起政务风格 WebUI，把浏览器请求送进 dsh 宿主进程内的 API 网关。

本文结论全部取自本机，不是从旧文档转述。版本基线：

| 项 | 值 | 来源 |
| --- | --- | --- |
| dsh / desktop 版本 | 0.2.0-rc.2 | `<DSH_INSTALL>\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh/package.json` 的 `version` |
| dsh runtime node | v24.21.0 | `$DSH_HOME\dsh-runtimes\dsh-primary-runtime\runtime.json` 的 `"node"` |
| 开发机 node | v24.18.0 | `C:\Program Files\nodejs\node.exe --version` |
| 打包进发行版的 `@deepseek-ai/*` 包 | 289 个 | app.asar 的 `dsh/node_modules/@deepseek-ai/` 目录项 |
| 本文对应参考文档 | `ExElectron/dsh-gov-portal@main/docs/harness-integration.md`（0.1.0-rc.6 视角） | 见第 10 节差异对照 |

本文的每一条都可以自己复核。所有 `node -e` / `node --input-type=commonjs` 片段都能直接粘贴运行，它们用纯 Node 内置模块解析 app.asar 的 header（`size` 偏移表 + `JSON.parse`），不依赖 Electron、不依赖 asar 工具链。解析骨架见第 11 节。

---

## 0. 结论速览

1. **`ctx.apiProxy` 在 0.2.0-rc.2 上不存在。** `@deepseek-ai/dsh-host-apiproxy` 已从发行版移除。API 网关被重构为 `ctx.typertGateway`（`@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService`）+ 一批各业务域 controller service。
2. **端点寻址是 `<namespace>/<method>`（斜杠）**，不是参考文档里的 `domain.method`。payload 必须是 `{ args: {...} }`，且 args 的键集合与描述符声明的 wire 名**完全一致**（多一个、少一个都拒：`gateway/arguments-invalid`）。**args 的形状有两种**：单对象参数（`session/prompt(request)`）与位置参数（`settings/update(ns, patch, expectedRevision)`），**必须读描述符，不能靠猜**（第 2.5 节）。
3. **端点清单不再是一份手写表**，而是由 `@deepseek-ai/dsh-typert-registry` 在运行时从各包的 `lib/typert.host.js` 注册进 `ctx.typert.local`。本机 0.2.0-rc.2 上是 140 个端点、13 个流式端点、31 个 agent 作用域端点。
4. **鉴权从「仅围栏」变成「围栏 + BrowserAuth 令牌 Cookie」**：围栏失败 403，令牌失败 401。所以裸 `curl` 打 `127.0.0.1:19387/api/session.list` 拿到 **401**。
5. **网关自有的 Remote 流多路复用 WebSocket 路径是 `/api/remote.mux`**；0.1.x 的 `/api/events.mux`、`/api/events.host` 在 `dsh-client-connection` 里**已经不存在**。
6. **转发事件白名单只有 27 条，不含任何 session 事件**。所以会话事件必须在**宿主进程内**订阅：`ctx.on('session/event', handler, { global: true })`。
7. **`req.signal` 在任何 Node 上都不能依赖**（第 7 节，重点）。必须自建 `AbortController` + `res.on('close')`，并用 `res.writableEnded` 区分「客户端断开」与「正常结束」。
8. **卷宗导出是 ZIP，不是裸 JSONL**：`/api/session.export` 由 `@deepseek-ai/dsh-session-log-export` 用 `connection.fetch.register` 挂载，`content-type: application/zip`。
9. **`inject` 里声明不存在的 service 会让插件永不激活**，Cordis 一直把它挂在「Plugins waiting for services」。因此本插件 `inject = []`，改在 `apply()` 内做能力探测。
10. **cordis 的 `ctx` 是 Proxy：读未声明的 service 属性会抛错**（`cannot get property "x" without inject`），不是返回 `undefined`。必须用 `ctx.get(key, false)` + `try/catch`。**mock ctx 上测不出这个坑**（第 12 节）。
11. **关停必须用 `ctx.effect(() => () => cleanup)`；`ctx.on('dispose', ...)` 永不触发**，用错会端口泄漏（第 13 节）。

---

## 1. 宿主形态探测：`apiProxy` 已不存在

### 1.1 事实

`@deepseek-ai` 命名空间下已无 `dsh-host-apiproxy`。发行版里取而代之的是：

- `dsh-api-gateway`（`TypertGatewayService`）
- `dsh-api-session-controller` / `dsh-api-settings-controller` / `dsh-api-workspace-controller` / `dsh-api-workspace-files` / `dsh-api-account-controller` / `dsh-api-job-controller` / `dsh-api-terminal-controller`
- `dsh-api-remotes`（事件转发白名单）
- `dsh-typert-registry` / `dsh-typert-protocol` / `dsh-typert-loader`

复核：列出 app.asar 里 `dsh/node_modules/@deepseek-ai/` 的全部目录名，然后过滤 `apiproxy`：

```bash
# 输出应为空（0 行）
node --input-type=commonjs - <<'EOF'
const fs = require('fs')
const asar = '<DSH_INSTALL>\\resources\\app.asar'
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jb = Buffer.alloc(jsonLen); fs.readSync(fd, jb, 0, jsonLen, 16)
const h = JSON.parse(jb.toString('utf8'))
const at = (p) => p.split('/').filter(Boolean).reduce((a, k) => a.files[k], h)
const names = Object.keys(at('dsh/node_modules/@deepseek-ai').files)
console.log('packages:', names.length)
console.log(names.filter((n) => /apiproxy|api-gateway|api-remotes|typert/.test(n)).join('\n'))
fs.closeSync(fd)
EOF
```

### 1.2 旁证：`/api` 面还在，但服务名与鉴权都变了

向正在运行的 GUI 发一个裸 POST（无 Cookie）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:19387/api/session.list \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"probe-1","method":"session.list","payload":{}}'
# 输出：401
```

返回 401。这证明三件事同时成立：`/api` 路由仍在、端点名 `session.list` 仍被认作「已知端点」（否则会是 404）、但请求被令牌层拦下（401 而非围栏的 403）。

### 1.3 本插件的应对

`lib/host.js` 的 `createHostBridge(ctx, logger)` 做能力探测，优先 `ctx.apiProxy`（老形态 / 参考文档目标），其次 `ctx.typertGateway`（本机实际形态），两者都没有时返回 `kind: 'unavailable'` 的绑定。页面照常打开，业务接口报 `gateway/service-unavailable`，而不是把 dsh 整个拖崩。

两种形态归一成同一内部接口：

```
invoke(endpoint, args, signal)      → { ok:true, value } | { ok:false, error }
stream(endpoint, args, signal)      → AsyncIterable<帧>
hostEvents(signal)                  → AsyncIterable<宿主转发事件帧>
resolveEventResult(payload, signal) → 回传审批 / 提问的应答
describeEndpoint(endpoint)          → 端点参数 wire 名（动态取，不硬编码）
```

`describeEndpoint` 在老形态返回 `undefined`（那时没有运行时可读的描述符表，走兜底包装），在新形态从 `ctx.typert.local.get('<ns>/<method>')` 读真描述符。

---

## 2. `typertGateway` 形态：寻址、payload、描述符

### 2.1 service 与调用入口

`ctx.typertGateway` 是 `@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService`（`super(ctx, "typertGateway")`）。本插件用到的三个方法：

| 方法 | 用途 | 签名要点 |
| --- | --- | --- |
| `dispatchRpc(endpoint, payload, signal, peer)` | unary 调用 | `payload` 必须恰为 `{ args }` 单键；否则抛 `Remote payload must contain exactly one plain-object args field` |
| `openWireStream(endpoint, payload, uplink, peer, signal, control)` | 流式调用 | `endpoint === '$events'` 时走网关自有的转发事件流；其余转发为 Remote 流 |
| `operatorPeer()` | 取同进程 operator peer | 有 `connection` 时返回 `connection.operator`，否则网关自建一个 |

### 2.2 端点寻址：斜杠，且恰好两段

网关内部：

```js
function endpointOf(namespace, method) { return `${namespace}/${method}` }
// remoteRequest():
const segments = endpoint.split('/')
if (segments.length !== 2 || segments[0] === '' || segments[1] === '') throw new Error(`invalid Remote endpoint ...`)
```

恰好两段。`session/list` 合法，`session.list`（点号）不是端点，`a/b/c` 也不是。

### 2.3 payload 形状与严格键集合

`assertExactArguments(args, descriptor, endpoint)` 的实际判定：

1. `args` 必须是普通对象（`isPlainObject`），否则 `gateway/arguments-invalid`；
2. 期望键集合 = 描述符 `parameters[].wire` 的并集；若 `invocation.kind === 'context'`，再并上 `invocation.wire`；
3. 多键 → 报 `unexpected "xxx"`；少键 → 报 `missing "xxx"`；
4. 例外：`source === 'json'` 且 `acceptsUndefined === true`（或 `codec.mode === 'src-json'`）的参数允许缺省。

**这条对插件是硬约束**，所以 `lib/host.js` 的 `buildArgs(bridge, endpoint, payload)` 完全由描述符驱动，没有任何方法表：

- 读不到描述符 → 原样透传（老形态不需要这一步）；
- 端点声明 0 个参数 → 返回 `{}`（多余的键必须清掉，否则被拒）；
- 端点声明 1 个参数 → payload 已带该 wire 名就原样用，否则包一层（`{ request: payload }`）；
- 端点声明多个参数 → 按声明的 wire 名做投影，丢弃未声明的键；
- 另外把 `invocation.wire`（context 型调用的身份字段）也算进合法键集合。

`test/server-smoke.mjs` 的「buildArgs 按宿主描述符裁剪参数（多参数端点）」一项就是这条规则的回归断言。

### 2.4 描述符注册表在运行时

端点表由 `@deepseek-ai/dsh-typert-registry` 从各包的 `lib/typert.host.js` 注册进 `ctx.typert.local`：

- 本机 26 个包带 `typert.host.js`；
- 描述符形如 `{ id, service, namespace, method, invocation:{kind}, parameters:[{name,wire,source,codec}], result:{...}, scope?:{context,wire} }`；
- `ctx.typert.local.get('<ns>/<method>')` 读单个描述符；`hasSeen(endpoint)` 判断该端点是否曾经注册过（用于区分「未知端点」与「已卸载端点」）。

### 2.5 参数形状有两种，不能靠猜：单对象参数 vs 位置参数

**wire 上的 payload 形状由「宿主方法的参数列表」决定，不是「永远一个 request 对象」。** 0.2.0-rc.2 上同一个域里两种形状都有：

| 端点 | 宿主方法签名 | wire 名 | 形状 |
| --- | --- | --- | --- |
| `session/prompt` | `prompt(request)` | `request` | 单对象参数 |
| `session/page` | `page(request)` | `request` | 单对象参数 |
| `session/list` | `list(_request)` | `_request` | 单对象参数（注意下划线） |
| `settings/update` | `update(ns, patch, expectedRevision)` | `ns` / `patch` / `expectedRevision` | 多个位置参数 |
| `settings/replace` | `replace(ns, section, expectedRevision)` | `ns` / `section` / `expectedRevision` | 多个位置参数 |
| `settings/mutate` | `mutate(ns, ops, expectedRevision)` | `ns` / `ops` / `expectedRevision` | 多个位置参数 |
| `settings/describe` | `describe()` | —（0 个） | 无参数 |
| `directoryPicker/createDirectory` | `createDirectory(path, name)` | `path` / `name` | 多个位置参数 |
| `llm/discoverModels` | `discoverModels(settingsNs, request)` | `settingsNs` / `request` | 混合（位置参数里套对象） |

**浏览器侧不能靠猜，必须读描述符**：`ctx.typert.local.get('<ns>/<method>').parameters[].wire`。本插件的 `buildArgs()`（第 2.3 节）就是按 `wires.length` 分三支（0 / 1 / 多）处理的。

#### 位置参数的真实坑：把 `ns` 字符串当 payload 传

以 `settings/update` 为例，它的描述符是：

```
parameters:
  [0] name: 'ns'               wire: 'ns'               source: json   （必填，codec: z.string()）
  [1] name: 'patch'            wire: 'patch'            source: json   （必填，codec: z.record(...)）
  [2] name: 'expectedRevision' wire: 'expectedRevision' source: json   （可省略）
                               acceptsUndefined: true
                               codec: z.union([z.undefined(), z.number()])
```

`expectedRevision` 带 `acceptsUndefined: true`，所以它在 `assertExactArguments` 里被放进 `acceptsMissing` 集合，允许缺省；`ns` 与 `patch` 没有这个标记，必须存在。

于是浏览器侧有两种写法，只有一种对：

```js
// ✅ 正确：客户端把位置参数组装成「键名与 wire 名一致」的对象
update: function (ns, patch, expectedRevision, s) {
  return unary('settings.update', {
    ns: ns,
    patch: patch,
    ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision }),
  }, s)
}

// ❌ 错误：把「位置参数」直接当 payload 传
update: function (p, s) { return unary('settings.update', p, s) }
```

错误写法为什么会**静默失效**？调用方按位置传 `update('llm-x', {...})` 时，第二个实参 `s`（signal）被当成 `expectedRevision`，而 `ns` 收到的是字符串 `'llm-x'`，于是 payload 变成那个字符串。服务端 `buildArgs` 里：

- `wires.length === 3`，所以「单参数」分支不成立，走多参数投影分支；
- 投影是 `for (const wire of allowed) if (wire in input) out[wire] = input[wire]`；
- `input` 是字符串，`'ns' in 'llm-x'`、`'patch' in 'llm-x'` 全为 `false`；
- 结果 `args` 变成 `{}` → 宿主 `assertExactArguments` 报 `missing "ns", "patch"` → `gateway/arguments-invalid`。

现象就是「**提交配置后静默无效**」：前端如果只 `console.warn` 不弹错误，用户会以为保存成功了。

工程内对应：

- `public/js/api.js` 的 `settings.{update,replace,mutate}` 已按位置参数组装（源码注释里就写着这个反例）；
- `test/frontend-wiring.mjs` 有两条断言守着：`api.js` 签名形状（参数个数 ≥ 3、且 `ns`/`patch` 确实被放进对象）与 `app.js` 调用形状（传的是位置参数而非裸 payload）。两条都忽略注释，因为注释里正是要写「不能这么写」的反例。

---

## 3. 端点清单

### 3.1 命名空间总览

本机 140 个端点，分布在 30 个 namespace（`dsh-api-gateway.claimsEndpoint` 只认两段路径，所以 namespace 名即第一段）：

| namespace | 数量 | service | namespace | 数量 | service |
| --- | --- | --- | --- | --- | --- |
| `session` | 19 | `sessionController` | `dynamicCordisRunner` | 12 | `dynamicCordisRunner` |
| `pluginManager` | 12 | `pluginManager` | `account` | 11 | `accountController` |
| `workspace` | 11 | `workspaceController` | `terminal` | 10 | `terminalController` |
| `goals` | 7 | `goals` | `speech` | 6 | `speechController` |
| `schedule` | 5 | `schedule` | `settings` | 5 | `settingsController` |
| `workspaceFiles` | 5 | `workspaceFiles` | `agentPresets` | 3 | `agentPresets` |
| `credentials` | 3 | `credentialsController` | `directoryPicker` | 3 | `directoryPickerController` |
| `job` | 3 | `jobController` | `llm` | 3 | `llm` |
| `messageFeedback` | 3 | `messageFeedback` | `productAnalytics` | 3 | `productAnalytics` |
| `commands` | 2 | `commands` | `officeToPdf` | 2 | `officeToPdf` |
| `subagents` | 2 | `subagents` | `userQuestions` | 2 | `userQuestions` |
| `fileReferences` | 1 | `sessionFileReferences` | `fileUploads` | 1 | `fileUploads` |
| `permissionPresets` | 1 | `permissionPresets` | `pluginInventory` | 1 | `pluginInventory` |
| `pluginRegistryProbe` | 1 | `pluginRegistryProbe` | `sessionFeedback` | 1 | `sessionFeedback` |
| `sessionReferenceResolver` | 1 | `sessionReferenceResolver` | `skills` | 1 | `sessionSkillCatalog` |

### 3.2 插件实际使用的关键端点

「参数 wire 名」列即 `buildArgs` 必须产出的键集合（`(context)` 标记的键来自 `invocation.wire`，与 `parameters` 并列）。

| 端点 | 参数 wire 名 | 流式 |
| --- | --- | --- |
| `session/list` | `_request`（注意是下划线开头，不是 `request`） | — |
| `session/create` | `request` | — |
| `session/page` | `request` | — |
| `session/projections` | `request` | — |
| `session/modelCatalog` | —（0 参数，必须发 `{}`） | — |
| `session/selectModel` | `request` | — |
| `session/prompt` | `request` | — |
| `session/cancel` | `request` | — |
| `session/rename` | `request` | — |
| `session/fork` | `request` | — |
| `session/search` | `request` | — |
| `session/updateQueue` | `request` | — |
| `session/attachment` | `request` | — |
| `session/follow` | `request` | stream |
| `session/control` | —（0 参数） | stream |
| `agentPresets/list` | — | — |
| `agentPresets/read` | `agentPreset` | — |
| `permissionPresets/catalog` | — | — |
| `settings/describe` | — | — |
| `settings/update` | `ns`, `patch`, `expectedRevision` | — |
| `settings/replace` | `ns`, `section`, `expectedRevision` | — |
| `settings/mutate` | `ns`, `ops`, `expectedRevision` | — |
| `directoryPicker/list` | `path`（可缺省，`z.union([z.undefined(), z.string()])`） | — |
| `directoryPicker/createDirectory` | `path`, `name` | — |
| `directoryPicker/pick` | — | — |
| `llm/listProviders` | — | — |
| `llm/listConfigurableProviders` | — | — |
| `llm/discoverModels` | `settingsNs`, `request` | — |
| `userQuestions/answer` | `agentId`(context), `agentId`, `callId`, `answer` | — |
| `userQuestions/attachWait` | `agentId`(context), `agentId`, `callId` | stream |
| `workspace/create` | `request` | — |
| `workspace/rename` | `request` | — |
| `workspace/delete` | `request` | — |
| `workspace/archiveSession` | `request` | — |
| `workspace/follow` | — | stream |
| `skills/list` | `request` | — |
| `goals/get` | `agentId`(context), `agentId` | — |
| `goals/create` | `agentId`(context), `agentId`, `request` | — |
| `goals/edit` | `agentId`(context), `agentId`, `ref`, `request` | — |
| `goals/pause` / `resume` / `complete` / `clear` | `agentId`(context), `agentId`, `ref` | — |
| `subagents/prompt` | `request` | — |
| `subagents/interruptByParent` | `childSessionId`, `parentSessionId`, `mode` | — |
| `job/list` | `request` | stream |
| `job/follow` | `request` | stream |
| `job/kill` | `request` | — |
| `terminal/list` | `sessionId` | — |
| `terminal/create` | `agentId`(context), `agentId`, `request` | — |
| `terminal/follow` | `agentId`(context), `agentId`, `id`, `attachmentId` | stream |
| `terminal/write` | `agentId`(context), `agentId`, `id`, `attachmentId`, `data` | — |
| `commands/list` | `agentId`(context), `agentId` | — |
| `commands/execute` | `agentId`(context), `agentId`, `line`, `submittedAttachments` | — |
| `fileUploads/upload` | `agentId`(context), `agentId`, `request` | — |
| `pluginManager/listPlugins` / `listBundles` / `registries` | — | — |
| `pluginInventory/list` | — | — |
| `credentials/describe` | `refs` | — |
| `credentials/set` | `ref`, `value` | — |
| `credentials/unset` | `ref` | — |

### 3.3 全部 13 个流式端点

```
account/watch              account/watchExpiry       job/follow
job/list                   session/control           session/follow
terminal/follow            terminal/retain           workspace/follow
workspaceFiles/changes     productAnalytics/watchPolicy
speech/follow              userQuestions/attachWait
```

### 3.4 全部 31 个 agent 作用域端点

这些端点带 `scope: { context: 'agent', wire: 'agentId' }`，**args 里必须同时给 context wire 与同名参数**（描述符里会出现两个 `wire: 'agentId'`）：

```
agentPresets/select          fileReferences/list        terminal/{close,create,environment,follow,rename,resize,shells,write}
fileUploads/upload           commands/{execute,list}     goals/{clear,complete,create,edit,get,pause,resume}
userQuestions/{answer,attachWait}                        sessionReferenceResolver/candidates
dynamicCordisRunner/{getClientCode,reportClientGuardFailure,reportRenderFailure,
                     resolveInspectQuery,runHostHalf,settleUserRun,stopFromPanel,undefineFromPanel}
```

---

## 4. 关键结果 schema（供前端对齐）

以下字段名逐字来自各包的 `lib/typert.host.js` 结果 codec，可直接当作前端类型声明。

### 4.1 session 域

```ts
// session/list  → 请求 { cursor?: string }
{ items: [{ agentAvailable: boolean; sessionId: string; updatedAt: number; running: boolean;
            blank: boolean; parentSessionId?: string; origin?: 'subagent'; cwd?: string;
            projections?: { kind: 'cached' | 'sequenced'; asOfSeq: number; values: {...} } }] }

// session/create → 请求 { workspaceId?; cwd?; sessionId?; agentPreset? }
{ sessionId: string; agentPreset?: string }

// session/prompt → 请求 { requestId; sessionId; mode: 'queue' | 'steer';
//                        content: [{type:'text';text} | {type:'image';mediaType;data;name?}
//                                  | {type:'file';receiptId}];
//                        clientTimeZone? }
{ accepted: true }

// session/cancel | session/rename({sessionId,title}) | session/fork({sessionId,atSeq?})
// session/search({query}) | session/attachment({sessionId,attachmentId})
// session/updateQueue({sessionId,itemId,action:{kind:'edit',content}|{kind:'remove'}|{kind:'steer'}})

// session/selectModel → 请求 { sessionId; provider; model; reasoningEffort? }
{ selected: { provider: string; model: string; reasoningEffort?: string } }

// session/page → 请求 { address: {kind:'session',sessionId}
//                             | {kind:'subagent',parentSessionId,childSessionId,mode};
//                       throughSeq: number; beforeSeq?; maxMessages?;
//                       turnWindow?: {minMessages,minTurns} }
{ records: [{ type: 'event';
              event: { type: string; seq: number; time: number; data: unknown;
                       ignorable?: true; sourceEventSeqs?: unknown; surfaceOp?: unknown } }];
  hasMore: boolean }

// session/projections → 请求 { sessionId }
{ asOfSeq: number; values: {...} } | null

// session/modelCatalog → 请求 {}（0 参数）
{ default: { provider: string; model: string; reasoningEffort?: string };
  routableProviders: string[];
  groups: [{ id: string; name: string;
             models: [{ id: string; name: string; description?: string;
                        reasoning?: { efforts: [{id,name,description?}]; defaultEffort?: string } }] }];
  failures: [{ id: string; name: string; message: string }] }

// session/follow（stream）→ 请求 { address: (同上); assistantStream?: true;
//                                    maxMessages?; turnWindow? }
// 帧判别联合：'event' | 'snapshot' | 'assistant-stream'
{ type: 'event'; event: {...} }                                   // 与 page 的 event 同形
{ type: 'snapshot'; header: { version; id; createdAt; cwd?; parentSession?; isSeeded;
                              origin?; delegationDepth?; agentPreset? };
  cursor: number; records: [{type:'event'; event:{...}}] }        // 开流基线，用于断线重连接续
{ type: 'assistant-stream'; frame: { type: 'start' | 'chunk' | 'end'; attemptId; revision; ... } }

// session/control（stream）→ 请求 {}（0 参数）
{ type: 'baseline'; value: { projections: Record<sessionId, { asOfSeq; values }> } }
{ type: 'projection'; sessionId: string; key: string; value: unknown; seq: number }
```

### 4.2 枚举与配置域

```ts
// permissionPresets/catalog → 请求 {}
{ options: [{ value: string; name: string; description?: string }];
  defaultOptions: [{ value: string; name: string; description?: string }];
  defaultPreset: string }

// agentPresets/list → 请求 {}
{ presets: [{ id: string; isDefault: boolean; name?: string; description?: string; broken?: string }] }

// agentPresets/read → 请求 { agentPreset: string }
{ agentPreset: string; content: string; name?: string; description?: string }

// settings/describe → 请求 {}
{ writable: boolean; hasDocument: boolean;
  namespaces: [{ autoGenerate: boolean; ns: string; schema: unknown; value: unknown;
                 base?: unknown; user?: unknown; applies: string;
                 secrets: [{ path: string[]; set: boolean }]; revision: number }] }
// 注意：describe 一律以 redactSecrets: true 读取，role('secret') 字段不可能随响应外泄。

// settings/update  → args { ns: string; patch: object; expectedRevision?: number }   ← 位置参数
// settings/replace → args { ns: string; section: object; expectedRevision?: number } ← 位置参数
// settings/mutate  → args { ns: string;
//                           ops: [{op:'set'; path: string[]; value} | {op:'unset'; path: string[]}];
//                           expectedRevision?: number }                              ← 位置参数
// 三者结果同形（SettingsNamespaceView，即上面 namespaces[] 的单元素形状）。
// ns / patch / section / ops 必填；expectedRevision 带 acceptsUndefined: true，可省略。
// ⚠️ 详见第 2.5 节：绝不能把「位置参数」直接当 payload 传，否则 args 会变空并被宿主拒绝。

// directoryPicker/list → 请求 { path?: string }
{ path: string; home: string;
  crumbs: [{ name: string; path: string; hidden: boolean }];
  entries: [{ name: string; path: string; hidden: boolean }]; truncated: boolean }
// directoryPicker/pick → {} | string | null

// llm/listProviders → 请求 {}
[{ id: string; name: string }]

// llm/listConfigurableProviders → 请求 {}
[{ provider: string; displayName: string; settingsNs: string; settingsPath: string[];
   declared?: boolean; error?: string }]

// skills/list → 请求 { sessionId }
{ skills: [{ path?: string; name: string; description: string; whenToUse?: string;
             modelInvocable: boolean }] }

// userQuestions/answer → 请求 { agentId(context); agentId; callId;
//                               answer: { answers: [{ id; selected: string[]; custom?: string }] } }
boolean

// job/list（stream）→ 请求 { sessionId }
{ type: 'rows'; jobs: [{ id; kind; label; owner?; outputLimitBytes?;
                         status: 'failed'|'running'|'stopping'|'completed'|'killed';
                         progress?; detail?; startedAt; finishedAt?;
                         output: { total; earliest; spillPaths?: string[] } }] }
```

### 4.3 投影字段（本插件页面直接消费）

| 投影 key | 注册包 | 字段 |
| --- | --- | --- |
| `sessionStats` | `dsh-session-stats` | `turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens` |
| `tokenUsage` | `dsh-token-meter` | `{ totals: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last: { turn, step, buckets } \| null }` |
| `permissions` | `dsh-permission-presets` | `{ currentValue: string }` |

两个必须注意的坑：

1. `tokenUsage` 是嵌套在 `totals` 下的，不是平铺。`stateSchema` 为 `{ totals: projectionSchema, last: {...} \| null }`，视图与状态同形。写成 `value.inputTokens` 会永远拿到 `undefined`。
2. `sessionStats` 的步数权威是 `step/end`，不是 `assistant/message`。该包注释明确：`step/end` 在 `finally` 里每条恰好一次，完成 / 失败 / 取消 / max-tokens 的步都会落一条；数 `assistant/message` 会多算 max-tokens 的 usage-host 消息（空内容、不进 surface）并少算被取消的步（消息尚未组装）。

其余在本机 web/desktop profile 已注册、可随 `session/projection` 帧或 `session/projections` 拿到的键（codec 里确实有）：`inbox`、`agentPreset`、`title`、`todos`、`sessionListMetadata`、`imageLimits`、`modelSelection`、`subagentCatalog`、`subagentTiming`、`subagent`、`goal`、`userQuestions`。

---

## 5. 鉴权与围栏

### 5.1 围栏（`isTrustedApiRequest`）

`dsh-client-connection` 的判定顺序（逐字对应源码）：

```js
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
```

三条硬规则：Host 必须是 loopback 或 trustedHosts；`sec-fetch-site: cross-site` 直接拒；带 `Origin` 时必须 `origin.host === host.host`（跨端口也拒）。没有 `Origin` 头则放行（同源导航 / 服务端脚本）。

### 5.2 BrowserAuth（0.2.0 新增）

```js
requestRejection(request) {
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
  return this.browserAuth.isAuthenticated(request) ? undefined : 401
}
// 拒绝时的响应体只有两个字面量：
//   res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
```

令牌来自 `dsh web` 打印的 URL 上的 `?token=`（`authenticatedUrl()` 把进程 launch token 塞进 `token` 查询参数），换取签名 Cookie：

```
dsh-auth-<authority>=<value>; Max-Age=<n>; Path=/; Expires=<...>; HttpOnly; SameSite=Strict
```

即 `HttpOnly` + `SameSite=Strict`，前端 JS 读不到，只能靠浏览器自动带上。

### 5.3 对本插件的含义

1. 裸 `curl` 打 19387 拿到 401（第 1.2 节），不是 403，说明围栏过了、令牌没过。
2. **本插件的 3091 页面不能直连宿主 3080/19387 的 `/api`**：页面 origin 是 `http://127.0.0.1:3091`，跨端口 → 围栏 403；就算同源也还缺 BrowserAuth Cookie。**必须经插件桥接**（本插件正是这么做的：宿主进程内直调网关，连网络都省了）。
3. **插件自己的 3091 面必须有独立访问控制**，因为宿主的围栏与 BrowserAuth 都不覆盖它。本插件的做法（`lib/security.js`）：来源校验（Origin/Host 一致 + `sec-fetch-site`）→ 配对令牌（Cookie `dsh_gov_workbench_token` 或 `x-gov-token` 头，常量时间比较）→ 写请求 Content-Type 必须 `application/json`；任一失败即拒且不执行副作用。

---

## 6. 流与事件

### 6.1 网关自有的 Remote 流多路复用

| 项 | 0.1.x（参考文档） | 0.2.0-rc.2 |
| --- | --- | --- |
| WS 路径 | `/api/events.mux`、`/api/events.host` | `/api/remote.mux`（唯一，承载全部 Typert Remote 流） |
| 挂载者 | `dsh-client-connection` 的 `WebSocketDownlinks` | `dsh-api-gateway` 的 `RemoteStreamMuxServer`，用 `webServer.registerUpgrade` 注册 |
| 升级准入 | 围栏 | `connection.admit(req)` → 围栏 403 / 令牌 401，然后 `mux.handleUpgrade` |

复核：在 `dsh-client-connection/lib/index.js` 里搜 `/api/events.mux` 与 `/api/events.host` → 0 次命中；在 `dsh-api-gateway/lib/index.js` 里搜 `/api/remote.mux` → 命中常量 `REMOTE_STREAM_MUX_PATH`。

### 6.2 宿主转发事件流：内部端点 `$events`

网关内部逻辑流（不是 HTTP 路径，是 `openWireStream` 的 endpoint）：

```
常量：REMOTE_EVENT_STREAM_ENDPOINT = '$events'
首帧：{ type: 'ready', clientId, host }        // clientId 由网关随机生成，去重后绑定
```

`openRemoteEvents(payload, signal)` 的入参校验极严：`payload` 必须恰为 `{ args: {} }`（args 必须是空对象），否则 `gateway/arguments-invalid`。

帧类型（`broadcastRemoteEvent` / `startRemoteEvent` / `cancelRemoteEvent` 产出）：

| 帧 | 形状 | 含义 |
| --- | --- | --- |
| `ready` | `{ type:'ready', clientId, host }` | 事件源就绪，记下 `clientId`（回传应答时要用） |
| `emit` | `{ type:'emit', event, args }` | 普通 Cordis 事件广播 |
| `waterfall` | `{ type:'waterfall', event, eventId, agentId, request }` | 可应答请求（审批 / 提问） |
| `cancel` | `{ type:'cancel', eventId }` | 该请求被取消（作用域释放 / signal abort） |

应答走 `$events/result` unary 端点，payload 三键严格匹配 `{ clientId, eventId, outcome }`，`outcome` 三选一：

```js
{ kind: 'next' }                       // 只此一键
{ kind: 'result' } | { kind: 'result', value }   // value 必须是 Remote JSON 值
{ kind: 'rejected', error }            // error 经 parseRemoteEventRejection 校验
```

网关侧还会核对 `clientId` 必须是活跃事件流的 id（`remoteEventClients.get(clientId)`），且该 `eventId` 确实投递给了这个 client（`pending.deliveries.has(client)`），否则静默忽略。

### 6.3 转发白名单只有 27 条，且不含 session 事件

`@deepseek-ai/dsh-api-remotes` 的 `API_REMOTE_FORWARDED_EVENTS` 是唯一的转发声明，共 27 条，其中 `mode: 'waterfall'` 的只有 2 条：

```
waterfall: approval/request, user-questions/request
emit (25): agent-preset/selected, api-session/{activity,added,error,removed,status},
           commands/change, deepseek-account/{session-expired,model-sign-in-required},
           credentials/{record-updated,reference-updated}, goal/activation-changed,
           cordis/{request-run,request-run-resolved,dynamic-package,dynamic-retract,
                   inspect-query,inspect-query-resolved},
           llm/adapters-updated, permission-presets/catalog-changed,
           plugin-manager/{changed,install-log,install-state},
           settings/document-updated, schedule/changed
```

没有任何 session 事件（`session/event`、`session/created`、`session/disposed` 都不在白名单里）。

### 6.4 所以：会话事件必须在宿主进程内订阅

本插件的 `lib/sse.js`（`MuxController`）就是这么做的，而 `dsh-api-session-controller` 自己 follow 会话用的是完全相同的姿势：

```js
const disposeEvent = this.ctx.on('session/event', (session, event) => { ... }, { global: true })
const disposeCreated = this.ctx.on('session/created', (session) => { ... }, { global: true })
```

`{ global: true }` 是拿全局可见性的关键（session / agent 事件带 scope，普通宿主 ctx 监听需要 scope 匹配）。本插件订阅三个宿主事件并合成 MuxFrame：

| 宿主事件 | 转成的 MuxFrame |
| --- | --- |
| `session/event` `(session, event)` | `{ type:'session/event', sessionId, event }` |
| `session/created` `(session)` | `{ type:'session/subscribed', sessionId, lastSeq }`（基线，用于接续） |
| `session/disposed` `(session)` | `{ type:'session/disposed', sessionId }` |

再叠加 `sessionProjections.onChanged(listener(session, key, value, seq))` 拿实时投影变更 → `{ type:'session/projection', sessionId, key, value, seq }`。

最后把网关 `$events` 的 `waterfall` 帧翻译成可应答的 `approval/requested` / `question/requested`：`rpcId` 编成 `<clientId>|<eventId>`，`/api/respond` 收到它即可精确还原应答目标（`lib/transport.js` 的 `registerPendingResponse` / `handleRespond`）。`cancel` 帧则回一条 `approval/resolved{outcome:'cancelled'}`。

`session/control` 是另一条路：它直接给 `baseline`（全量投影快照）+ `projection` 增量，前端不订阅宿主事件也能保持同步。两条路本插件都实现了。

---

## 7. `req.signal` 的版本差异（重点）

这一节把参考实现的一个真实缺陷钉成可复现的事实，而不是靠文档转述。

### 7.1 缺陷 A 的原始形态

参考实现把 `req.signal` 直接传给宿主方法。而 `node:http` 的 `IncomingMessage` 在 Node ≤22 上没有 `.signal` 属性，取值恒为 `undefined`。宿主的帧队列内部直接 `signal.addEventListener('abort', ...)` 且不做 undefined 防御，于是流一打开就抛 `TypeError` → 前端重连 → 再抛 → 死循环。

证据：Node v22 官方文档的 `http.IncomingMessage` API 列表里没有 `message.signal` 这一项；v24 的列表里有。对照两份 ToC 即可确认该属性是 v24 新增：

```bash
# v22 文档：IncomingMessage 小节只有 aborted/complete/connection/destroy/headers/
#           headersDistinct/httpVersion/method/rawHeaders/rawTrailers/setTimeout/
#           socket/statusCode/statusMessage/trailers/trailersDistinct/url  —— 无 signal
curl -s https://nodejs.org/docs/latest-v22.x/api/http.html | grep -c 'message\.signal'   # 0
curl -s https://nodejs.org/docs/latest-v24.x/api/http.html | grep -c 'message\.signal'   # >0
```

### 7.2 Node ≥24 上它存在，但**不能用于流中途取消**

本机两个 Node 上跑探针（脚本见 7.4），结论逐版本不同，这一点很关键：

| 场景 | node v24.18.0（开发机） | node v24.21.0（dsh runtime） |
| --- | --- | --- |
| `typeof req.signal` | `'object'` | `'object'` |
| `req.signal instanceof AbortSignal` | `true` | `true` |
| 进入处理器时已 abort？ | `false` | `false` |
| 正常结束时的事件顺序 | `res.close(writableEnded=true)` → `signal.abort` | `res.close(writableEnded=true)`，**signal 永不 abort**（7 秒后仍为 `false`） |
| 流中途客户端断开时的事件顺序 | `res.close(writableEnded=false)` → `signal.abort` | `signal.abort` → `res.close(writableEnded=false)` |
| 断开后 `signal.aborted` | `true` | `true` |

三个可操作的结论：

1. **两种 Node 上都不能把 `req.signal` 当作「流中途取消」的信号源**。v24.18.0 上它确实会 abort，但总是在 `res.close` 之后；v24.21.0 上正常结束根本不 abort。把它传给宿主，正常结束的流永远收不到取消通知（长连接泄漏），断开的流拿到的也是「已经关完的」迟到信号。
2. `res.writableEnded` 是区分「客户端断开」与「正常结束」的唯一可靠依据。`res.on('close')` 时 `writableEnded === true` 表示我们主动 `res.end()` 结束（不算断开，不能 abort）；`=== false` 才是客户端跑了。
3. 顺序在版本间会翻转，所以任何依赖「abort 先于 / 后于 close」的代码都是脆的。本插件不依赖顺序，只依赖 `writableEnded`。

### 7.3 本插件的修法

`lib/transport.js` 的 `trackAbort(req, res)`：

```js
export function trackAbort(req, res) {
  const controller = new AbortController()
  let clientGone = false
  const onClose = () => {
    // 正常结束时 writableEnded 为 true，不算断开。
    if (res.writableEnded) return
    clientGone = true
    controller.abort(new Error('client disconnected'))
  }
  res.on('close', onClose)
  req.on('aborted', onClose)
  return {
    controller,
    disconnected: () => clientGone,
    detach: () => { res.off('close', onClose); req.off('aborted', onClose) },
  }
}
```

要点：

- 绝不从 `req` 上取 signal，一律用自建 `controller.signal`；
- `req.on('aborted')` 作为旧版 Node 的补充触发点（该事件自 v17 起已废弃，但保留无害，且有 `writableEnded` 兜底不会误判）；
- `detach()` 在响应收尾时摘掉监听，避免长驻 server 上的监听器泄漏；
- `pipeSse` 的 `finally` 里 `if (!res.writableEnded) res.end()`，并用 `control.disconnected()` 决定是否还要给客户端写一条 `stream/error`（客户端已经跑了就别写了）。

`lib/host.js` 的两种适配器都只转发调用方给的 signal，从不自己从 `req` 取。新形态的 `stream()` 还把外部 signal 桥到一个内部 `control`：

```js
const control = new AbortController()
const onAbort = () => control.abort(signal.reason)
signal.addEventListener('abort', onAbort, { once: true })
// ... finally { signal.removeEventListener('abort', onAbort) }
```

### 7.4 可复现的探测脚本

思路与 `test/server-smoke.mjs` 第 5 组一致：起一个最小 server，一个端点正常 `res.end()`，另一个端点**永不结束**（模拟长连接 SSE），分别观察 `signal.abort` 与 `res.close` 的先后和 `writableEnded`。

```bash
# 换 node 二进制即可对比（本机：v24.18.0 与 v24.21.0）
node --input-type=commonjs - <<'EOF'
const http = require('node:http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const recs = new Map()
const server = http.createServer((req, res) => {
  const s = req.signal
  const rec = { url: req.url, typeofSignal: typeof s, isAS: s instanceof AbortSignal,
                abortedAtEntry: s ? s.aborted : null, seq: [], sig: s }
  recs.set(req.url, rec)
  if (s) s.addEventListener('abort', () => rec.seq.push('signal.abort'))
  res.on('close', () => rec.seq.push('res.close(writableEnded=' + res.writableEnded + ')'))
  if (req.url === '/hang') return          // 永不结束：模拟长连接流
  res.end('ok')
})
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  await fetch(`http://127.0.0.1:${port}/normal`).then((r) => r.text())
  await sleep(600)
  const ac = new AbortController()
  fetch(`http://127.0.0.1:${port}/hang`, { signal: ac.signal }).then((r) => r.text()).catch(() => 'aborted')
  await sleep(200); ac.abort(); await sleep(600)
  server.close()
  console.log('node ' + process.version)
  for (const rec of recs.values())
    console.log('  ' + rec.url, 'typeof=' + rec.typeofSignal, 'isAS=' + rec.isAS,
                'entryAborted=' + rec.abortedAtEntry, JSON.stringify(rec.seq))
})
EOF
```

本机输出：

```
# C:\Program Files\nodejs\node.exe        → v24.18.0
  /normal typeof=object isAS=true entryAborted=false ["res.close(writableEnded=true)","signal.abort"]
  /hang   typeof=object isAS=true entryAborted=false ["res.close(writableEnded=false)","signal.abort"]

# $DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe → v24.21.0
  /normal typeof=object isAS=true entryAborted=false ["res.close(writableEnded=true)"]
  /hang   typeof=object isAS=true entryAborted=false ["signal.abort","res.close(writableEnded=false)"]
```

`server-smoke.mjs` 第 5 组的第一项就是这个探针的内嵌版，并且它按 `typeofSignal` 分两支断言：

- `undefined` 分支 → Node ≤22，断言 `isAbortSignal === false`（缺陷 A 的原始形态）；
- 有 signal 分支 → Node ≥24，断言「进入时未 abort」+「响应结束后才 abort」。

**⚠️ 已知偏差**：第二个断言（`abortedAfterEnd === true`）只在 v24.18.0 上成立。在 dsh runtime 的 v24.21.0 上正常结束不会 abort，该断言失败：

```
$ node test/server-smoke.mjs                      # v24.18.0
server-smoke: 全部通过（35 项）                     # exit 0

$ "$DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/server-smoke.mjs
  ✗ req.signal 不可依赖：Node ≤22 为 undefined，Node ≥24 也只在响应关闭后才 abort
      AssertionError [ERR_ASSERTION]: Node ≥24 上它在响应结束后才 abort
      false !== true
server-smoke: 34 项通过，1 项失败                   # exit 1
```

但这不影响任何结论：该探针的两条分支都指向同一个工程决策，别用 `req.signal`。同组另外两项（「插件不依赖 `req.signal`：自建 controller 并在客户端断开时立即 abort」「正常结束不会误触发 abort」）在两个 Node 上都通过，它们才是真正保护行为的那两条。建议把「响应结束后才 abort」从断言降级为观测记录（打印即可），否则 CI 换 node 版本就会红。

### 7.5 本机 Node 可用性

- v24.18.0（`C:\Program Files\nodejs\node.exe`），开发机默认 `node`；
- v24.21.0（`$DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`），dsh 实际运行插件用的那个；
- Node 22 二进制在本机未找到（全盘搜索 `node.exe` 只命中上面两个；`D:\` 下只有一个 `node-v22.9.0-linux-arm64.tar.gz`，是 Linux 产物，不能用于本机对比）。因此「Node ≤22 → `undefined`」这一支是依据 v22 官方文档的 API 列表缺失（见 7.1）与 `server-smoke.mjs` 的 `undefined` 分支共同确定的，并未在本机跑出来。若需要真机对比，装一个 Node 22 后重跑 7.4 的脚本即可。

---

## 8. 卷宗导出：ZIP，不是裸 JSONL

### 8.1 宿主侧的实现

`@deepseek-ai/dsh-session-log-export`：

```js
const name = 'session-log-download'
const inject = ['commands', 'connection']
const SESSION_LOG_EXPORT_PATH = '/api/session.export'   // 绝对注册路径
// apply():
ctx.effect(() => ctx.commands.register({ name: 'export', ... }))          // Web 的 /export 命令
connectionOf(ctx).fetch.register({                                       // ← 挂路由的姿势
  path: SESSION_LOG_EXPORT_PATH,
  methods: ['GET', 'HEAD'],
  requestBody: 'buffered',
  fetch: async (request) => { ... },
})
```

响应头：`content-type: application/zip`、`content-disposition: attachment; filename="<zip 名>"`。

查询参数：`sessionId`（必填，空或缺失 → 400）、`includeDescendants`（可选，只接受 `'true'` / `'false'`，其它值 → 400）。缺 `sessionQuery` / `sessionPersistence` / `attachments` 任一 service → 500；会话不存在 → 404。

ZIP 内容（无 manifest）：根日志用当前代的规范名 `session[.vN].jsonl`；每个 subagent 后代在 `subagents/<id>/session[.vN].jsonl`；被引用的图片按内容寻址放 `media/<attachmentId>.<ext>`（同一归档不重复存共享图片）；普通文件放 `files/<prefix>/<digest>/<name>`。压缩用 `fflate` 的流式 Zip API，宿主不把整个归档放一个 buffer。

### 8.2 为什么「1:1 复用」在这里要打折

参考文档给的 `readSessionLogText` 同格式做法是裸 JSONL：首行 header，其后每行一个事件，行尾换行。0.2.0 的官方导出是 ZIP，且额外做了两件裸读拿不到的事：

1. live session 的 flush 屏障：读之前先 `sessions.flush(session)`，保证内存里的最新日志落盘（冷会话不需要）；
2. 附件一起打包（图片 / 文件）。

本插件的选择是两条都提供：

- `/api/session.export?sessionId=` 返回裸 JSONL（`application/x-ndjson`），实现方式与官方 `readSessionLogText` 同格式，直接读 `ctx.sessionPersistence`：

  ```js
  const handle = await persistence.open(sessionId, 'read', { signal })
  const { events } = await handle.read(0, undefined, { signal })
  return serializeLog(handle.header, events)   // 首行 header + 每行一个事件 + 行尾 \n
  ```

  这样页面拿到的是可逐行流式消费的文本，适合「运行轨迹」栏目的增量渲染；
- 需要官方 ZIP（含后代 + 附件）时，走宿主自己那条 `/api/session.export`（`GET`，带 BrowserAuth Cookie），或者前端直接给宿主的导出 URL 挂一个下载链接。

注意：本插件自己的 `/api/session.export` 与宿主的同名路径不是同一个东西。本插件在 3091 端口上，宿主在 3080/19387 上，两者互不干扰，但前端拼 URL 时别搞混。

---

## 9. 插件装配：`inject` 的陷阱

### 9.1 装配链

```
package.json 的 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
        ↓
dsh plugin --profile desktop add link:<插件目录>     # pnpm 装入 profile + reconcile dsh.profile.bundles
        ↓
profile boot 把 cordis.patch.yml 的 `- insert:` 合并进 cordis 树
        ↓
loader 按 `name` 解析 main，执行 { name, inject, apply, Config }
```

本机 profile 的实况（`$DSH_HOME\profiles\<profile>\package.json`）里 `dsh.profile.bundles` 是：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "<第三方插件 A>", "<第三方插件 B>",
  "<第三方插件 C>", "..." ]


```

只有声明了 `dsh.bundle.patch` 的包才会被 reconcile 进这个数组。

### 9.2 `inject` 声明不存在的 service → 插件永不激活

这是本插件刻意绕开的坑：**参考文档写的 `inject: ['apiProxy']` 在 0.2.0-rc.2 上会让插件永远停在「Plugins waiting for services」，永不激活。**

本机日志里的实例（`$DSH_HOME\logs\startup-2026-09-18T05-07-04.920Z-*.log`）里同一现象的等价形态（webserver 因 `EADDRINUSE` 失败后，一串依赖它的插件卡住）：

```
Plugins waiting for services (9):
  Plugin                 Missing services
  connection (required)  webRuntime
  session-log-download   connection
  open-in-app            webServer, connection
  directory-picker       webServer
  session-controller     fileUploads
  web-runtime            webServer
  client-hmr             webServer
  file-upload            connection
  ui-deliverables        connection, sessionController
```

该日志里 `dshVersion` 记的是 `0.1.6-alpha.2`（desktop 与 runtime 版本号不同源），但机制一致：Cordis 只在依赖的 service 全部就绪后才 `apply()`，缺一个就无限等待。注意 `session-controller` 等的是 `fileUploads`，连官方包自己都会踩这个形状。

### 9.3 本插件的做法

`lib/index.js`：

```js
export const name = 'gov-workbench'   // 与 cordis.patch.yml 的行 id 一致
export const inject = []              // 刻意留空：apiProxy 在 0.2.0-rc.2 不存在
export const Config = { '~standard': { version: 1, vendor: 'dsh-gov-workbench', validate } }
```

- 不声明 `inject`，改在 `apply()` 内用 `createHostBridge()` 做能力探测（第 1.3 节，另见第 12 节：cordis 的 ctx 是 Proxy，探测方式有硬要求）；
- `Config` 只做形状校验（任意输入都回对象），取值由 `mergeConfig` 归一化，坏配置回落默认值而不是把 dsh 启动拖垮；
- 监听与配置加载放在微任务里（`void (async () => {...})()`），进一步隔离启动期故障；
- 关停挂在 `ctx.effect(() => () => {...})` 上（不是 `ctx.on('dispose', ...)`，后者永不触发，详见第 13 节）：`clearPendingResponses()` + `mux.dispose()` + `server.close()`。

`cordis.patch.yml` 里则用一个 `!!js` 表达式做条件注入，让老形态部署自动等 `apiProxy`、新形态立即激活：

```yaml
- insert:
    - id: gov-workbench
      name: 'dsh-gov-workbench'
      inject: !!js "ctx.get('apiProxy', false) ? ['apiProxy'] : []"
      config:
        port: 3091            # 避开 3080（dsh 主 GUI）与 3081（参考实现）
        host: '127.0.0.1'
        requireToken: true
        allowNoOrigin: true
        requireJsonContentType: true
        sealOnComplete: true
        floatEnabled: true
```

---

## 10. 与参考文档 `harness-integration.md`（0.1.0-rc.6）的差异

参考文档：`https://raw.githubusercontent.com/ExElectron/dsh-gov-portal/main/docs/harness-integration.md`。
下表逐条对照 0.1.0-rc.6 → 0.2.0-rc.2。右列都可以在本机复核。

### 10.1 网关形态与寻址

| # | 维度 | 参考文档（0.1.0-rc.6） | 本机实测（0.2.0-rc.2） | 复核方式 |
| --- | --- | --- | --- | --- |
| 1 | 网关 service | `ctx.apiProxy`（`@deepseek-ai/dsh-host-apiproxy`），`inject: ['webServer','apiProxy']` | `apiProxy` 不存在；`ctx.typertGateway`（`dsh-api-gateway` 的 `TypertGatewayService`）+ 各域 controller | 第 1.1 节脚本，过滤 `apiproxy` 输出为空 |
| 2 | 端点寻址 | `domain.method`（如 `session.prompt`），`method` 必须与 URL 路径段一致 | `<namespace>/<method>`（斜杠），恰好两段 | `endpointOf()`；`remoteRequest()` 的 `segments.length !== 2` 抛错 |
| 3 | payload 形状 | `{ rpcId, payload: {...} }`（apiProxy 的 `RpcRequest`） | `{ args: {...} }`，恰一键；args 键集合与 wire 名严格相等 | `assertExactArguments()`：多键 `unexpected`、少键 `missing` |
| 3b | args 的形状 | 每个方法一个 `payload` 对象 | 两种：单对象参数（`session/prompt(request)`）与位置参数（`settings/update(ns, patch, expectedRevision)`）；可选参数靠 `acceptsUndefined: true` 标出 | 第 2.5 节；`settings/update` 描述符 |
| 4 | 端点表来源 | 手写 `RpcMethodMap`（`rpc-map.d.ts`） | 运行时注册表 `ctx.typert.local`，来自各包 `lib/typert.host.js`；本机 140 个端点 / 26 个包 | 第 2.4 节 |
| 5 | 描述符可读性 | 无运行时描述符表 | `ctx.typert.local.get('<ns>/<method>')` 读 `{parameters[].wire, invocation.kind, mode, scope}` | `describeEndpoint()` 即此实现 |
| 6 | 流式标记 | 由 `events.mux` / 具体方法签名决定 | 描述符 `mode: 'stream'`；本机 13 个 | 第 3.3 节清单 |
| 7 | agent 作用域 | 无此概念 | 31 个端点带 `scope: {context:'agent', wire:'agentId'}`，args 需同时给 context wire 与同名参数 | 第 3.4 节清单 |

### 10.2 流与事件

| # | 维度 | 参考文档（0.1.0-rc.6） | 本机实测（0.2.0-rc.2） | 复核方式 |
| --- | --- | --- | --- | --- |
| 8 | WS 多路复用路径 | `/api/events.mux` 与 `/api/events.host`（downlink-only） | `/api/remote.mux`（唯一，承载全部 Remote 流） | `dsh-client-connection` 里搜 `/api/events.mux` → 0 命中；`dsh-api-gateway` 里 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` |
| 9 | 事件流入口 | `apiProxy.events.mux(request, signal)` 返回 `AsyncIterable<RpcRequest<MuxFrame>>` | 网关内部端点 `$events`，payload 必须恰为 `{args:{}}` | `openRemoteEvents()` 的 `gateway/arguments-invalid` 校验 |
| 10 | 事件应答 | `apiProxy.respond(...)`（`POST /api/respond`） | `$events/result` unary，`{clientId, eventId, outcome}`；outcome `{kind:'next'\|'result'\|'rejected'}` | `parseRemoteEventResult()` 的 `exactKeys` 校验 |
| 11 | 帧类型 | `MuxFrame` 判别联合（`session/event`、`session/subscribed`、`approval/requested`、`question/requested`、`session/queue`、`session/jobs`、`session/projection`、`stream/error` …） | 网关侧原始帧只有 4 种：`ready` / `emit` / `waterfall` / `cancel`；参考文档里的 `session/event` 等要插件自己在进程内合成 | `openRemoteEvents()` + `broadcastRemoteEvent()` / `startRemoteEvent()` |
| 12 | 会话事件来源 | `apiProxy.events.mux()` 一次性拿全部会话事件 | 转发白名单 27 条，不含任何 session 事件；必须在进程内 `ctx.on('session/event', h, {global:true})` | 第 6.3 / 6.4 节 |
| 13 | 审批 / 提问 | 白名单外也走 mux | 白名单里只有 `approval/request` 与 `user-questions/request` 是 `waterfall`（可应答），其余 25 条是 `emit` | `API_REMOTE_FORWARDED_EVENTS` |
| 14 | 投影实时推送 | `session/projection` 帧（来自 mux） | `sessionProjections.onChanged(listener)` 进程内订阅；或走 `session/control` 流的 `baseline` + `projection` | 第 6.4 节 |

### 10.3 鉴权

| # | 维度 | 参考文档（0.1.0-rc.6） | 本机实测（0.2.0-rc.2） | 复核方式 |
| --- | --- | --- | --- | --- |
| 15 | 鉴权层 | 仅围栏：`isTrustedApiRequest`（loopback/trustedHosts + `sec-fetch-site` + Origin 同源），无 token、无 cookie | 围栏 + BrowserAuth：`requestRejection()` = 围栏 403 → 令牌 401 | 第 5.2 节源码 |
| 16 | 令牌来源 | — | `dsh web` 打印 URL 上的 `?token=`（`authenticatedUrl()`），换取签名 Cookie | `TOKEN_QUERY = 'token'` |
| 17 | Cookie 形态 | — | `dsh-auth-<authority>=...; Max-Age=...; Path=/; Expires=...; HttpOnly; SameSite=Strict` | `sessionCookie()` 字面量 |
| 18 | 裸请求结果 | 同源即可通 | 401（`res.end('unauthorized')`） | 第 1.2 节：`POST 127.0.0.1:19387/api/session.list` → 401 |
| 19 | WS 升级准入 | 围栏 | 围栏 403 / 令牌 401，然后 `mux.handleUpgrade` | `api-gateway` 的 `connection.admit(req)` |

### 10.4 端点改名 / 新增（按业务域）

| # | 参考文档（0.1.x） | 0.2.0-rc.2 | 备注 |
| --- | --- | --- | --- |
| 20 | `session.history({sessionId,beforeSeq?,maxMessages?})` → `{events, hasMore, projections?}` | `session/page`，请求 `{address, throughSeq, beforeSeq?, maxMessages?, turnWindow?}` → `{records, hasMore}` | 地址从「裸 sessionId」变成判别联合（session / subagent）；`throughSeq` 变必填 |
| 21 | `session.models({sessionId})` → `{current, routable, groups, failures}` | `session/modelCatalog()`（0 参数，宿主态）→ `{default, routableProviders, groups, failures}` | `routable: boolean` 被 `routableProviders: string[]` 取代 |
| 22 | — | `session/projections`、`session/follow`（stream）、`session/control`（stream）、`session/updateQueue`、`session/attachment`、`session/openWorkspacePath`、`session/canOpenWorkspacePath`、`session/initializeDefaultModel`、`session/workspacePathApplications` | 19 个 session 端点 |
| 23 | `host.describe` / `host.listDirectory` / `host.pickDirectory` / `host.createDirectory` / `host.openPath` | `directoryPicker/list` / `createDirectory` / `pick` | `host.*` 域消失，归入 `directoryPicker` |
| 24 | `llm.providers` / `llm.models` / `llm.discoverModels` | `llm/listProviders` / `llm/listConfigurableProviders` / `llm/discoverModels` | 会话态模型目录改走 `session/modelCatalog` |
| 25 | `credentials.describe/set/unset` | `credentials/describe` / `set` / `unset` | 同名，改为斜杠寻址 |
| 26 | `goal.create/edit/pause/resume/complete/clear` | **`goals/*`**（复数 namespace）+ 全部带 agent context wire | 多一个 `get` |
| 27 | `skill.list` | `skills/list` | 复数 |
| 28 | `agentPreset.list/select/read/copy/openDocument/remove` | `agentPresets/list` / `read` / `select` | `copy` / `openDocument` / `remove` 不在 140 个端点里 |
| 29 | `subagent.list/history/prompt/interrupt` | `subagents/prompt` / `subagents/interruptByParent` | 只剩 2 个；历史改走 `session/page` 的 subagent 地址 |
| 30 | `workspace.list/create/rename/delete/insertBefore/insertSessionBefore/archiveSession` | `workspace/create` / `rename` / `delete` / `archiveSession` / `insertBefore` / `insertSessionBefore` / `pinSession` / `unpinSession` / `unarchiveSession` / `initializeDefault` / `follow`(stream) | `list` 不在端点表里（列表走 `session/list` 的 workspace 字段） |
| 31 | — | 全新域：`job`(3)、`terminal`(10)、`commands`(2)、`fileUploads`(1)、`fileReferences`(1)、`messageFeedback`(3)、`schedule`(5)、`speech`(6)、`officeToPdf`(2)、`pluginManager`(12)、`pluginInventory`(1)、`pluginRegistryProbe`(1)、`productAnalytics`(3)、`sessionFeedback`(1)、`sessionReferenceResolver`(1)、`dynamicCordisRunner`(12)、`account`(11) | 合计 30 个 namespace |

### 10.5 统计、投影与导出

| # | 维度 | 参考文档（0.1.0-rc.6） | 本机实测（0.2.0-rc.2） | 复核方式 |
| --- | --- | --- | --- | --- |
| 32 | `sessionStats` 字段 | `turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens` | 完全一致（同由 `dsh-session-stats` 折叠） | `sessionStatsSchema` 逐字比对 |
| 33 | `sessionStats` 计数权威 | 未特别说明 | `step/end`（不是 `assistant/message`），因后者会多算 max-tokens、少算取消步 | 该包模块注释 |
| 34 | token 用量 | `tokenUsage` 投影；宿主侧读 `assistant/message` 的 `data.usage` | 投影 `{ totals: {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, last: {turn,step,buckets}\|null }`，嵌套在 `totals` 下，不是平铺 | `tokenUsageStateSchema` |
| 35 | 权限投影 | `permissions` 折叠 `KnobState {preset, sandbox, approval}` | 视图是 `{ currentValue: string }`（`stateVersion: 2`），内部状态才是多旋钮 | `permission-presets` 的 `wire: { viewSchema: selectionSchema, view }` |
| 36 | 卷宗导出 | 裸 JSONL：首行 header + 每行一个事件（`readSessionLogText` 同格式） | ZIP：`/api/session.export` 由 `dsh-session-log-export` 用 `connection.fetch.register` 挂载，`GET`/`HEAD`，`content-type: application/zip` | 第 8.1 节源码；`SESSION_LOG_EXPORT_PATH` |
| 37 | 导出内容 | 单会话逻辑日志 | ZIP 含后代 subagent 日志（`subagents/<id>/`）+ 附件（`media/`、`files/`）；`includeDescendants=true` | 第 8.1 节 |
| 38 | 导出前的一致性 | 无 | 读 live session 前先 `sessions.flush(session)` 过持久化屏障 | `flushLiveSessionLog()` |
| 39 | 裸 JSONL 怎么拿 | 官方唯一形态 | 不是官方形态，需自己读 `ctx.sessionPersistence`：`open(id,'read')` → `handle.read(0, undefined)` → 序列化 | 本插件 `lib/bridge.js` 的 `readSessionLog` / `serializeLog` |

### 10.6 装配与端口

| # | 维度 | 参考文档（0.1.0-rc.6） | 本机实测（0.2.0-rc.2） | 复核方式 |
| --- | --- | --- | --- | --- |
| 40 | 独立端口 | 3081 | 3091（避开 3080 主 GUI 与 3081 参考实现） | `lib/config.js` 的 `DEFAULTS.port` |
| 41 | `inject` | `inject: ['webServer','apiProxy']` | `inject = []` + `apply()` 内能力探测（声明 `apiProxy` 会**永不激活**） | 第 9.2 节本机日志 |
| 42 | 页面访问控制 | 配对 token / 同源 cookie（插件自建） | 同思路，但必须自建（宿主围栏 + BrowserAuth 都不覆盖 3091） | `lib/security.js` |
| 43 | `api/gate` waterfall 钩子 | 参考文档已注明 rc.6 未发布、不要依赖 | 仍未出现在端点表里 | 140 个端点里无 `api/gate` |
| 44 | 宿主内起网服 | 可行（沙箱只约束 agent 工具子进程） | 结论不变，本插件 `node:http` 直接 `listen(3091)` | `lib/index.js` 的 `server.listen(config.port, config.host, ...)` |
| 45 | 探测宿主 service | 参考文档未提，示例直接 `ctx.get("apiProxy")` | cordis 的 ctx 是 Proxy：读未 inject 的 service 属性会抛错；必须 `ctx.get(key, false)` + `try/catch` | 第 12 节；`test/cordis-proxy.mjs` 8 项 |
| 46 | 插件关停清理 | 参考文档未提 | **`ctx.on('dispose', ...)` 永不触发**；必须 `ctx.effect(() => () => cleanup)`，否则端口泄漏 | 第 13 节；`@deepseek-ai/cordis@4.0.2` |
| 47 | 真 cordis 挂载验证 | 参考文档为纯文档推演 | 已用真 `@deepseek-ai/cordis@4.0.2` 的 `Context` + 假 `typertGateway` 挂载跑通（mounted、端点派发、dispose 释放端口） | 第 13.6 节输出 |

### 10.7 仍然成立的部分（没变）

- 四象限 RPC 信封：`client-request` / `server-response` / `server-request` / `client-response`，`RpcResult = {ok:true,value} | {ok:false,error}`。本插件 1:1 沿用（`lib/bridge.js`、`public/js/api.js`）。
- 信任围栏的三条规则（loopback/trustedHosts、`sec-fetch-site`、Origin 同源）逐字未变。
- 插件形状 `{ name, inject, apply, Config }`、`dsh.bundle.patch` → `cordis.patch.yml` 的 `- insert:` 装配链未变。
- 宿主进程内直调是唯一可行路径：浏览器页面直连宿主 `/api` 会被围栏（跨端口 Origin）与 BrowserAuth 双重拒绝，0.2.0 上这条比 0.1.x 更硬。
- `sessionStats` 的 8 个字段未变。

---

## 11. 复核命令汇总

```bash
# —— 版本基线 ——
"C:\Program Files\nodejs\node.exe" --version                                    # v24.18.0
"$DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --version  # v24.21.0
Get-Content "$DSH_HOME\dsh-runtimes\dsh-primary-runtime\runtime.json"    # node / desktopVersion

# —— apiProxy 是否还在（输出应为空）——
#    用第 1.1 节的脚本过滤 dsh/node_modules/@deepseek-ai 目录名里的 apiproxy

# —— /api 面与鉴权 ——
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:19387/api/session.list \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"p","method":"session.list","payload":{}}'   # 401

# —— 端点表（140 / 13 stream / 31 scoped）——
#    见第 11.1 节的抽取脚本

# —— req.signal 探针 ——
#    见第 7.4 节，换 node 二进制对比

# —— 本插件自测（5 个套件，全部 exit 0）——
cd dsh-gov-workbench
node test/server-smoke.mjs     # 静态托管 / 信封 / SSE / 应答 / 导出 / 拒绝路径 / AbortSignal 回归
                               # 注意：在 dsh runtime 的 v24.21.0 上会多出 1 项失败（第 7.4 节的已知偏差）
node test/plugin-boot.mjs      # 真装配：apply() → 起真服务 → 真请求 → dispose 释放端口
node test/syntax-check.mjs     # 源码与清单形状断言
node test/cordis-proxy.mjs     # 真 cordis Proxy 语义 + 裸 ctx.<service> 源码守卫（第 12 / 13 节）
node test/frontend-wiring.mjs  # 前端模块装配
```

各项数量随开发推进而增长（本文件定稿时为 server-smoke 35、plugin-boot 22、cordis-proxy 8）。判断是否健康看是否有 `✗` 与退出码，不要死记项数。`server-smoke` 在 v24.21.0 上那一项已知偏差除外（第 7.4 节）。

### 11.1 app.asar 解析骨架（所有复核脚本共用）

```js
const fs = require('node:fs')
const asar = '<DSH_INSTALL>\\resources\\app.asar'
const fd = fs.openSync(asar, 'r')
// asar header：8 字节 pickle 头 + 4 字节 header 大小 + 4 字节 JSON 大小，之后是 JSON
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jb = Buffer.alloc(jsonLen); fs.readSync(fd, jb, 0, jsonLen, 16)
const h = JSON.parse(jb.toString('utf8'))
const base = 16 + jsonLen
const nodeAt = (p) => p.split('/').filter(Boolean).reduce((a, k) => a.files[k], h)
const read = (p) => {
  const n = nodeAt(p)
  const b = Buffer.alloc(n.size)
  fs.readSync(fd, b, 0, n.size, base + Number(n.offset))
  return b.toString('utf8')
}
// 例：
// read('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js')
// nodeAt('dsh/node_modules/@deepseek-ai').files   → 289 个包名
```

### 11.2 抽取全部端点（140 个）

```js
const P = 'dsh/node_modules/@deepseek-ai'
const pkgs = Object.keys(nodeAt(P).files).sort()
const all = []
for (const pkg of pkgs) {
  const n = nodeAt(P + '/' + pkg)
  if (!n.files?.lib?.files?.['typert.host.js']) continue
  const src = read(P + '/' + pkg + '/lib/typert.host.js')
  let cur = null
  for (const line of src.split('\n')) {
    const t = line.trim()
    let m
    if ((m = /^id: '([^']+)',$/.exec(t))) { cur = { pkg, ns: '', method: '', mode: 'unary', params: [] }; all.push(cur); continue }
    if (cur === null) continue
    if ((m = /^namespace: '([^']+)',$/.exec(t))) cur.ns = m[1]
    else if ((m = /^method: '([^']+)',$/.exec(t))) cur.method = m[1]
    else if ((m = /^mode: '(stream|unary)',$/.exec(t))) cur.mode = m[1]
    else if ((m = /^wire: '([^']+)',$/.exec(t))) cur.params.push(m[1])
  }
}
const eps = all.filter((e) => e.ns && e.method)
console.log('端点', eps.length, '流式', eps.filter((e) => e.mode === 'stream').length)
console.log('namespace', new Set(eps.map((e) => e.ns)).size)
```

### 11.3 抽取转发事件白名单（27 条）

```js
const src = read(P + '/dsh-api-remotes/lib/index.js')
const m = [...src.matchAll(/\{\s*\n\s*event: "([^"]+)",\s*\n\s*mode: "([^"]+)"/g)]
console.log('白名单', m.length)
console.log('waterfall', m.filter((x) => x[2] === 'waterfall').map((x) => x[1]))
// → ["approval/request", "user-questions/request"]
```

---

## 12. cordis 的 `ctx` 是 Proxy：读未声明的 service 会**抛错**

这一条只有真 cordis 能测出来，mock ctx 上看不出来。

### 12.1 事实

cordis 的插件上下文是一个 Proxy。读取一个未在 `inject` 里声明的 service 属性时，它直接抛错，而不是返回 `undefined`：

```
Error: cannot get property "apiProxy" without inject
```

后果很严重：早期 `lib/host.js` 写的是

```js
const apiProxy = ctx?.apiProxy ?? ctx.get('apiProxy')   // ❌
```

这在 mock ctx 上完全正常（mock 就是普通对象，读不到属性得 `undefined`），但在真 cordis 下插件启动即崩，而且崩在 `apply()` 里，插件永远起不来。

### 12.2 复现

```js
import { Context } from '@deepseek-ai/cordis'

const root = new Context()
root.plugin({
  name: 'probe',
  apply(ctx) {
    try { ctx.apiProxy } catch (e) { console.log(e.message) }
  },
})
// → cannot get property "apiProxy" without inject
```

本机输出（`@deepseek-ai/cordis@4.0.2`，路径 `$DSH_HOME\profiles\node_modules\@deepseek-ai\cordis\lib\index.js`）：

```
1. ctx.apiProxy            -> 抛错: cannot get property "apiProxy" without inject
1. ctx.get("apiProxy", false) -> undefined（不抛错）
1. ctx.typertGateway       -> 抛错: cannot get property "typertGateway" without inject
```

写属性同样受管：`ctx.typertGateway = {...}` 抛 `cannot set property "typertGateway" without provide`；要用 `ctx.provide('typertGateway', ...)`。

### 12.3 正确写法

```js
const get = (key) => {
  if (ctx === null || typeof ctx !== 'object') return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key, false)     // ← 第二参数 false = 不要求已注入，缺失返回 undefined
      if (value !== undefined && value !== null) return value
    }
  } catch { /* 老版本 get 不接受第二参数 */ }
  try {
    const value = ctx[key]                   // ← 仍然可能抛（Proxy），必须包 try/catch
    return value === null ? undefined : value
  } catch {
    return undefined                         // cordis Proxy 对未 inject 的 service 抛错 → 视为不可用
  }
}
```

两条要点缺一不可：

1. 优先 `ctx.get(key, false)`：第二参数 `false` 表示「不要求该 service 已被注入」，缺失时安全返回 `undefined`；
2. **裸属性访问 `ctx[key]` 必须整段包 `try/catch`**，即便用了 `ctx.get`，为兼容老版本或 `get` 不可用的 ctx，兜底分支仍可能触发 Proxy 抛错。

### 12.4 工程内落点

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `lib/host.js` | `createHostBridge()` 内的 `get(key)` | 探测 `apiProxy` / `typertGateway` |
| `lib/sse.js` | `readService()` | 探测 `sessionProjections` 等 |
| `lib/bridge.js` | `getService()` | 探测 `sessionPersistence` |

回归测试：`test/cordis-proxy.mjs`（本文件定稿时 8 项，全部通过），其中包含一条源码守卫，扫描 `lib/` 下所有源码，断言不出现裸的 `ctx.<service>` 属性访问，从而防止这个坑被重新引入：

```
✓ MuxController.startProjections 在投影服务存在时正常订阅
✓ MuxController.start 在会抛错的 ctx 上不崩
✓ lib/ 源码里不出现裸的 ctx.<service> 属性访问
cordis-proxy: 全部通过（8 项）
```

---

## 13. 关停必须用 `ctx.effect`，`ctx.on('dispose')` **永不触发**

### 13.1 事实

cordis 4.x 里，**`ctx.on('dispose', handler)` 的回调永远不会执行**，这个事件名根本不会被派发。cordis 的插件级清理语义是 `ctx.effect(() => () => cleanup)`：effect 回调返回的函数在该 fiber 被销毁时调用。

在 `@deepseek-ai/cordis@4.0.2` 上的输出：

```
no-inject          applyRan=true  onDispose=false effectCleanup=true
inject-empty       applyRan=true  onDispose=false effectCleanup=true
inject-missing     applyRan=false onDispose=false effectCleanup=false
```

第一行是同一次 `dispose()` 的结果：`ctx.on('dispose')` 没跑（`onDispose=false`），`ctx.effect` 的 cleanup 跑了（`effectCleanup=true`）。

第三行是另一回事：`inject: ['typertGateway']` 而该 service 不存在时，`apply()` 压根没执行（`applyRan=false`），所以 effect 也没登记，与第 9.2 节「声明不存在的 service 会让插件永不激活」是同一机制，在此得到独立复现。

### 13.2 复现

```js
import { Context } from '@deepseek-ai/cordis'

const flags = { onDispose: false, effectCleanup: false }
const root = new Context()
const fiber = root.plugin({
  name: 'probe',
  apply(ctx) {
    ctx.on('dispose', () => { flags.onDispose = true })
    ctx.effect(() => () => { flags.effectCleanup = true }, 'probe cleanup')
  },
})
await fiber.dispose()
// → onDispose=false, effectCleanup=true
```

### 13.3 后果：端口泄漏

用 `ctx.on('dispose')` 做清理，插件卸载后 http 服务仍然占着端口：`server.close()` 从不执行，3091 一直被占，重新加载插件会 `EADDRINUSE`。本插件监听的是固定端口，这个泄漏会直接导致「改完代码重载插件起不来」。

### 13.4 本插件的修法

`lib/index.js`：

```js
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
  try { state.server?.close() } catch { /* 忽略：进程正在退出 */ }
}, 'gov-workbench: http server and event subscriptions')
```

dsh 官方插件也是这个写法，例如 `@deepseek-ai/cordis-plugin-timer`。

### 13.5 一个容易误判的细节：dispose 早于 apply 时不成立

`ctx.effect` 的 cleanup 只有在 effect 已经登记之后 dispose 才会跑：

```
dispose-immediately      applyRanAtDispose=false effectCleanup=false
dispose-after-150ms      applyRanAtDispose=true  effectCleanup=true
```

即 cordis 对 `apply()` 的调用是异步调度的：若在 `apply` 真正执行前就 `fiber.dispose()`，effect 根本没被登记，cleanup 自然不跑，这不是 `ctx.effect` 的问题。写测试时**必须先等 apply 执行完再 dispose**，否则会得到「effect 也不生效」的假阴性。

`test/plugin-boot.mjs` 里对应两项（都已通过）：

```
✓ apply() 用 ctx.effect 注册关停，清理执行后服务确实关闭
✓ 源码里不出现 ctx.on('dispose') 这一无效写法
```

第二项是源码模式断言（忽略注释），防止这个坑被重新引入。

### 13.6 真实 cordis 挂载已验证

用真 `@deepseek-ai/cordis@4.0.2` 的 `Context`（从 `$DSH_HOME\profiles\node_modules\@deepseek-ai\cordis\lib\index.js` 直接 import）+ 假 `typertGateway`（`ctx.provide('typertGateway', gateway)`）跑通全链路，本机输出：

```
插件 name=gov-workbench  inject=[]
[gov-workbench] 宿主形态：typertGateway（dsh 0.2.0 起的 API 网关）
[gov-workbench] 综合政务智能工作台已上线：http://127.0.0.1:3092/
[gov-workbench] 宿主 API 网关：typertGateway（已接入，1:1 能力）
index status=200  token=<首次访问种下的配对令牌>
session.list -> {"ok":true,"value":{"items":[{"sessionId":"session-real-1",...
workbench.status -> host=typertGateway hostAvailable=true node=v24.18.0
网关收到的端点=["session/list"] 带signal=true
fiber.dispose() 后 3092 可重新监听 = true
```

要点：

- 插件确实挂上了：`root.plugin({ name, apply })` 里调用本插件的 `apply()`，探测到 `typertGateway`（真 cordis 上走的是第 12.3 节的 `get(key)` 路径，没有触发 Proxy 抛错）；
- `/api/session.list` 确实派发到了网关，且 `signal instanceof AbortSignal === true`（第 7 节的自建 controller 确实传下去了）；
- `fiber.dispose()` 后端口释放（能重新 `listen`），这是第 13.4 节 `ctx.effect` 修法的效果。

**仍未验证**：没有在真实 dsh 进程里挂载 3091（那需要重启 dsh）。上表是真 cordis + 假网关，不是真 dsh + 真网关；`sessionProjections` 也未 provide，插件给出告警而非崩溃。

---

## 14. `inject` 不能用 `!!js`：`Inject.resolve` 会把表达式节点当成服务名

这是本项目踩过的**最致命**的一个坑：patch 里写
`inject: !!js "ctx.get('apiProxy', false) ? ['apiProxy'] : []"`，
结果插件**永不激活**，启动日志停在「Plugins waiting for services」，3091 根本不监听。

### 14.1 事实（真 cordis 4.x + 真 loader + 真 YAML 方言）

```
=== parsed patch row ===
  id   : gov-workbench
  name : dsh-gov-workbench
  inject raw: {"__jsExpr":"ctx.get('apiProxy', false) ? ['apiProxy'] : []"}
  isJsExpr(inject)? true

=== after interpolate(ctx, config) (loader only calls it on config) ===
  inject touched?: {"__jsExpr":"ctx.get('apiProxy', false) ? ['apiProxy'] : []"}

=== Inject.resolve(inject) -> services the plugin waits for ===
  ["__jsExpr"]
```

### 14.2 机制（五步，逐条可复核）

1. YAML 方言：`cordis-plugin-include` 里

   ```js
   const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
     kind: 'scalar',
     resolve: (data) => typeof data === 'string',
     construct: (data) => ({ __jsExpr: data }),
     predicate: isJsExpr,
     represent: (data) => data.__jsExpr,
   })
   const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
   ```

   （注意它用的是 `js-yaml` 的 `yaml.Type` / `JSON_SCHEMA.extend`，不是 `yaml` 包的 API，复核时别拿错包。）
   整个文档都按 `!!js` 解析，所以 `inject: !!js "..."` 得到的是对象 `{__jsExpr:"..."}`。

2. 求值范围：loader 只在 `config` 上调用 `interpolate`：

   ```js
   ctx.on("internal/config", function (_config, next) {
     const config = next()
     if (!this.entry || this.parent.fiber?.entry === this.entry) return config
     if (this.runtime?.callback?.[EntryGroup.key]) return config
     return interpolate(this.ctx, config)
   }, { global: true })
   ```

   `inject` 不在求值路径上，那个表达式**永远不会被求值**。

3. `disabled` 有专门分支，`inject` 没有：

   ```js
   disabledOf(options) {
     return isJsExpr(options.disabled)
       ? Boolean(this.evaluate(options.disabled.__jsExpr))
       : Boolean(options.disabled)
   }
   ```

   全文搜索 `isJsExpr` 只有 `interpolate`、`disabledOf`、类型判定三处用途，没有 `injectOf` 之类的东西。

4. `Inject.resolve` 把 `__jsExpr` 当服务名：

   ```js
   function resolve(inject, result = Object.create(null)) {
     if (!inject) return result
     if (Array.isArray(inject)) for (const name of inject) result[name] = null
     else if (Reflect.has(inject, symbols.checkProto)) {
       Object.assign(result, resolve(Object.getPrototypeOf(inject)))
       for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
     } else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
     return result
   }
   ```

   `{__jsExpr:"..."}` 既不是数组、也没有 `checkProto` → 走最后一条 → `result["__jsExpr"] = "..."`。

5. 消费点与「插件导出的 inject 何时生效」：

   ```js
   ctx.on("internal/plugin", (fiber) => {
     if (fiber.parent[Entry.key] && !fiber.entry) {
       fiber.entry = fiber.parent[Entry.key]
       Inject.resolve(fiber.entry.options.inject, fiber.inject)
     }
     ...
   })
   ```

   只有当 `entry.options.inject` 为 `undefined` 时，`Inject.resolve` 提前 return，插件自己导出的 `inject` 才生效。

### 14.3 正确做法

整行删掉 `inject:`，不是写 `inject: []`。空数组会让 `Inject.resolve` 走第一条分支（`Array.isArray` 为真）但什么都不注册，同样覆盖掉插件导出的 `inject`。

删掉后 `lib/index.js` 的 `export const inject = []` 生效，插件立即激活。

另外 `inject: [apiProxy]`（普通数组）在 0.2.0-rc.2 上同样会让插件永不激活，因为该版本已无 `apiProxy` service。**两种写法都不能用，原因不同**。

### 14.4 `ctx.inject([name], cb)` 是响应式的（等待网关就绪的正确手段）

删掉 `inject` 后插件立即激活，网关可能在 `apply()` 之后才 provide。`ctx.inject` 正好能解决这个时机问题：

```
--- 注册 ctx.inject(["typertGateway"], cb) ---
inject() 返回值类型: object
回调立即触发了吗: false
等待 50ms 后，回调触发次数: 0

--- 现在 provide typertGateway ---
[inject 回调被触发] 拿到 typertGateway: object
provide 之后，回调触发次数: 1
结论: 响应式确认 ✓
```

语义：service 缺失时不触发，provide 后自动回调；返回一个 disposer。

工程内落点（`lib/host.js`）：

- `readService(ctx, key)`：一律 `ctx.get(key, false)` + try/catch（见第 12 节）；
- `createServiceWaiter(ctx, name)`：用 `ctx.inject([name], cb)` 做响应式唤醒，叠加轮询兜底（`ctx.inject` 不可用时也能等到，且能覆盖「服务被撤下又重新提供」）；
- `kind` 是 getter，`invoke` / `stream` / `resolveEventResult` / `describeEndpoint` 每次调用重新解析网关；
- `hostEvents(signal)` 是等待式生成器：先 `await waiter.wait(signal)`，网关出现后再转发；流自然结束后若网关仍在且未 abort 会重新接续，所以 `MuxController` 不需要任何重启逻辑。

回归测试：`test/plugin-boot.mjs` 的「网关晚于插件 provide 时自动接上」与「网关缺席时 hostEvents 等待而不是立即结束」；
装配守卫：`test/patch-inject.mjs`（含一个故意构造坏 patch 的对照组，证明检测不是空转）。

## 15. 已知偏差与未验证项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Node ≤22 上 `req.signal === undefined` | **未在本机真机验证** | 全盘搜索 `node.exe` 只命中 v24.18.0 与 v24.21.0；`D:\` 下唯一的 Node 22 是 `node-v22.9.0-linux-arm64.tar.gz`（Linux 产物）。结论依据 v22 官方文档 API 列表缺失 + `server-smoke.mjs` 的 `undefined` 分支 |
| `server-smoke.mjs` 第 5 组在 v24.21.0 上失败 | **已复现，建议降级为观测** | 断言「Node ≥24 上响应结束后才 abort」只在 v24.18.0 成立；v24.21.0 正常结束不 abort。同组另两项在两个 Node 上都通过，行为保护不受影响 |
| `desktopVersion` 与日志里的 `dshVersion` 不同源 | 已记录 | `runtime.json` 写 `0.2.0-rc.2`；`startup-*.log` 里写 `0.1.6-alpha.2`。本文所有结论以 app.asar 内 `dsh/package.json` 的 `0.2.0-rc.2` 与运行时实际解析到的源码为准 |
| 140 个端点 = 本机 web/desktop profile 的可达集 | 视 profile 而定 | 端点表由各 bundle 是否装入决定。换 profile（如更精简的 headless）数量会变；本文数字对应 `$DSH_HOME\profiles\<profile>` |
| 端点总数：任务简报写 139，本文数出来 140 | 以本文的 140 为准 | 按「`id` + `namespace` + `method` 齐全的描述符块」计数：140 个块、140 个 distinct 端点、0 个重复、来自 26 个包（`new Set(eps).size === eps.length`）。差 1 个最可能是简报计数时把某个端点漏掉或去重口径不同；复核脚本见第 11.2 节，任何人都能复跑 |
| 宿主侧 `/api/session.export` 的 ZIP 未在本插件内直连验证 | 未端到端跑通 | 本插件走的是裸 JSONL 路线（读 `ctx.sessionPersistence`），已在 `server-smoke.mjs` 用替身持久化层断言；ZIP 路线只做了源码级确认（路径、方法、响应头、查询参数校验） |
| `session/follow` 的 `assistant-stream` 子帧全量字段 | 部分确认 | 已确认 `type` 取值集合含 `start` / `chunk` / `end` 及 `committed` / `abandoned`；`chunk` 帧带 `{attemptId, revision, index, time, chunk}`。未逐一穷举 `end` 帧全部字段 |
| 未在真实 dsh 进程里挂载 3091 | **未验证** | 第 13.6 节是真 cordis + 假 typertGateway；在真 dsh 进程里挂载需要重启 dsh，本轮未做 |
| `sessionProjections` 在真 cordis 探针里缺失 | 环境限制 | 第 13.6 节探针只 provide 了 `typertGateway`，未 provide `sessionProjections`，插件给出「未找到 sessionProjections」告警而非崩溃，这本身就是降级路径的正面证据 |
| 曾用 `inject: !!js "..."` 导致插件永不激活 | 已修，已加回归守卫 | 致命 bug。`Inject.resolve` 把 `{__jsExpr}` 当服务名，插件永久等待。修法：整行删掉 `inject:`。详见第 14 节；`test/patch-inject.mjs` 8 项守着（含对照组） |
| `lib/sse.js` 的 `readService` 改为从 `lib/host.js` 导入 | 去重 | 原先两处各有一份实现，行为相同；现在单一来源，避免漂移 |

---

## 附：本插件的模块分工（与本文各节对应）

| 文件 | 负责 | 对应节 |
| --- | --- | --- |
| `lib/index.js` | Cordis 插件入口：`apply()` → 探测 → 起 3091 → 准入；关停走 `ctx.effect`；`inject` 留空（第 14 节） | 9, 13, 14 |
| `lib/host.js` | 双形态适配（`apiProxy` / `typertGateway`）+ Proxy 安全的 service 探测 + 惰性解析 / `kind` getter / 等待式 `hostEvents` + 描述符驱动的 `buildArgs` | 1, 2, 12, 14.4 |
| `lib/bridge.js` | `/api/<domain>.<method>` 四象限信封 → 网关；`/api/events.mux`、`/api/events.host`、`/api/respond`、`/api/session.export` | 3, 8 |
| `lib/transport.js` | `trackAbort`（缺陷 A 修复）、SSE 编码与心跳、应答登记表 | 7 |
| `lib/sse.js` | `MuxController`：进程内订阅会话事件 + 投影 + `$events` waterfall 翻译 | 6, 12 |
| `lib/security.js` | 来源 / 令牌 / Content-Type 准入 | 5 |
| `lib/config.js` | 配置读写与归一化（端口 / host / 令牌 / 跑马灯） | 9 |
| `cordis.patch.yml` | 装配层：`- insert:` 插件行，故意不写 `inject:` | 14 |
| `public/js/api.js` | 浏览器侧四象限客户端（wire 一律「单数域名.方法」写法；`settings.*` 按位置参数组装 payload） | 2, 3 |
| `test/cordis-proxy.mjs` | 真 cordis Proxy 语义 + 「源码里不得裸访问 `ctx.<service>`」守卫 | 12 |
| `test/patch-inject.mjs` | **`inject` 不得用 `!!js`**：静态检查 + 真 cordis/loader 端到端 + 对照组 | 14 |
| `test/plugin-boot.mjs` | 真装配：`apply()` → 起真服务 → 真请求 → 惰性接网关 → dispose 释放端口；含 `ctx.effect` 行为与源码断言 | 13, 14.4 |
| `test/frontend-wiring.mjs` | 前端装配；含 `settings.*` 位置参数形状的两条守卫（第 2.5 节） | 2.5 |
