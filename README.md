# dsh-gov-workbench

> **状态：已完成真机挂载验证。**
>
> **验证边界**：仓库内 138 项自动化测试基于 mock ctx，覆盖协议信封、SSE 帧、`AbortSignal` 回归、
> 来源校验与令牌、Cordis Proxy 语义、`inject` 的 `!!js` 陷阱、前端接线。
>
> **真机验证结果**（dsh 0.2.0-rc.2 / node v24.18.1 / Windows，`desktop` profile）：
>
> | 项 | 实测结果 |
> | --- | --- |
> | 插件挂载 | 成功；3091 正常监听并返回页面 |
> | 网关探测 | `/plugin/status` → `host: "typertGateway"`、`hostAvailable: true` |
> | `session.list` | `result.ok = true`，返回 85 条真实会话 |
> | `agentPreset.list` | `standard, ptc, minimal, cordis, computer-use, redteam` |
> | `settings.describe` | 24 个宿主命名空间，系统配置页全部渲染且可写 |
> | 页面渲染 | 政务门户完整渲染，六栏目可切换 |
>
> 尚未覆盖：`session.prompt` 的完整对话回合、审批/提问弹窗的 `respond` 回环、`events.mux` 的流式事件上屏、
> `sessionStats` 统计口径逐项核对。详见 **§8 已知限制**。

## 1. 它是什么

**综合政务智能工作台** —— 一网通办 · 智能协同 · 全程留痕

一个可独立安装运行的 **dsh（DeepSeek Harness）Cordis 插件**：在插件自己的端口（默认 `3091`）拉起政务门户风格的 WebUI，并把浏览器的每一个请求 **1:1 桥接**到宿主进程内的 API 网关。页面不做任何业务预设 —— 事项、模型、权限档位、统计口径全部实时取自宿主。

- 包名：`dsh-gov-workbench`｜入口：`lib/index.js`（`type: module`，`engines.node >= 22.19`）
- 装配层：`cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它）
- 默认地址：`http://127.0.0.1:3091/`
- 页面六栏目：工作台首页 / 事项办理 / 卷宗档案 / 运行轨迹 / 系统配置 / 规章制度

## 2. 架构

三层结构：

```text
┌─────────────────────────────────────────────────────────────────────┐
│ dsh 主进程（宿主）                                                   │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ dsh-gov-workbench 插件（lib/，跑在宿主进程内）                  │  │
│  │  index.js     Cordis 插件主体 { name, inject, apply, Config }  │  │
│  │  host.js      宿主网关绑定 + 能力探测 + 参数投影                │  │
│  │  bridge.js    /api/* 四象限 RPC 信封派发、卷宗导出              │  │
│  │  security.js  来源 / 令牌 / Content-Type 准入                  │  │
│  │  transport.js HTTP 信封、SSE 编码、请求级 AbortSignal          │  │
│  │  sse.js       MuxController：会话事件 + 投影 + 审批 / 提问      │  │
│  │  static.js    public/ 静态托管（含目录穿越防护）                │  │
│  │  config.js    配置读写、归一化、令牌生成                        │  │
│  │                                                               │  │
│  │  node:http 服务 —— 独立端口 3091（默认绑回环地址）              │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
│                              │ 同进程直调，不走网络                  │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ 宿主 API 网关                                                  │  │
│  │  · 0.2.0+：ctx.typertGateway + 各域 controller                 │  │
│  │    （sessionController / settingsController /                  │  │
│  │      workspaceController / agentPresets / llm / ...）           │  │
│  │  · 0.1.x ：ctx.apiProxy                                        │  │
│  │ 另有 ctx.sessionPersistence / ctx.sessionProjections           │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                    ▲ HTTP / SSE → http://127.0.0.1:3091/
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 浏览器页面（public/）                                                │
│  index.html  六栏目政务版式    js/api.js    四象限 RPC 客户端        │
│  css/gov.css 政务视觉令牌      js/store.js  localStorage 偏好        │
│  js/app.js   页面装配与业务编排（只调 wire 端点，无业务硬编码）       │
└─────────────────────────────────────────────────────────────────────┘
```

**为什么走同进程直调而不是网络转发。** 插件跑在 dsh 主进程内，`lib/host.js` 拿到的 `ctx.typertGateway`（或老形态的 `ctx.apiProxy`）就是宿主自己的对象引用。因此：

- **不走网络** —— 没有中间 HTTP 跳数，也没有「插件端口 → 主 GUI 端口」的第二跳。
- **无 CORS 问题** —— 浏览器只与 `127.0.0.1:3091` 同源通信，不跨源访问 dsh 主 GUI。
- **无鉴权围栏问题** —— 不需要把宿主令牌交给浏览器；插件在宿主侧自行完成准入判定（见 §7）。
- **零业务硬编码** —— 端点是否存在由宿主自己的注册表回答（`ctx.typert.local`），参数按宿主描述符动态投影（`buildArgs`），插件不维护方法表。

页面侧一律使用「单数域名.方法」的 wire 写法（如 `session.list`），由 `lib/host.js` 的别名表映射到真实 namespace（`session/list`）。

## 3. 在测试机上安装与验证

> **本工程未在本机安装。** 开发机只负责产出代码，所有安装动作都在独立测试机上做。
> 本节给出完整的搬运、安装、验证、回滚与排错流程。

### 3.0 前置要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| dsh 版本 | **0.2.0-rc.2**（对齐开发机） | 其它版本也能跑（`lib/host.js` 做能力探测），但集成面按 0.2.0-rc.2 实测，见 `docs/harness-integration.md` |
| Node | **≥ 22.19** | dsh 自身运行时随发行版附带 node 24.21.0。本插件的测试套件已在 **v22.22.2 / v24.18.0 / v24.21.0** 三个版本上全部跑通；更低版本未验证 |
| 包管理器 | pnpm（dsh 自带即可） | `dsh plugin` 会转发给 profile 目录下的 pnpm |
| 端口 | **3091 空闲** | 刻意避开 3080（dsh 主 GUI）与 3081（原版 gov-portal） |
| 平台 | Windows / macOS / Linux | 代码里没有平台特定分支 |

先确认测试机环境：

```bash
dsh --version          # 期望 0.2.0-rc.2
node --version         # 期望 v22.19.0 或更高
```

**关于 profile 名**：`dsh` CLI **拒绝 `--profile desktop`**，会直接报
`error: profile "desktop" is managed exclusively by the Electron application` ——
desktop profile 由 Electron 应用独占管理。所以测试机上请用**非 desktop 的 profile**
（如 `web`，或自建一个），下文的 `<PROFILE>` 即指它。

```bash
# 查看已有 profile
ls "$DSH_HOME/profiles"        # Windows: dir %DSH_HOME%\profiles
```

### 3.1 传输：把工程拷到测试机

工程是**纯源码、零依赖、无构建**，三种方式任选。

**方式 A：打包 zip（推荐，最省事）**

在开发机（工程根目录的上一级）执行：

```bash
# Windows PowerShell
Compress-Archive -Path dsh-gov-workbench -DestinationPath dsh-gov-workbench.zip -Force

# macOS / Linux
zip -r dsh-gov-workbench.zip dsh-gov-workbench -x '*/node_modules/*'
```

拷到测试机后解压到任意目录，例如：

```bash
# Windows PowerShell
Expand-Archive -Path dsh-gov-workbench.zip -DestinationPath C:\plugins\

# macOS / Linux
unzip dsh-gov-workbench.zip -d ~/plugins/
```

解压后应得到 `C:\plugins\dsh-gov-workbench\package.json`（或 `~/plugins/dsh-gov-workbench/package.json`）。
**下面把这个绝对路径记作 `<PLUGIN_DIR>`。**

**方式 B：git**

```bash
# 开发机：把工程推到一个测试机能访问的仓库
cd dsh-gov-workbench
git init && git add -A && git commit -m "dsh-gov-workbench"
git remote add origin <REPO_URL> && git push -u origin main

# 测试机
git clone <REPO_URL> <PLUGIN_DIR>
```

**方式 C：直接共享目录**（同一局域网 / 挂载盘）

直接把 `dsh-gov-workbench/` 整个目录拷过去即可。**不要**拷贝 `node_modules`（本工程没有依赖，不需要它）。

### 3.2 安装

> **前置：`github:` 源要求 `git` 在 PATH 里。** pnpm 解析 `github:` 规格时
> 会 shell 调用 `git ls-remote` 去问远端的分支与 tag。目标机没装 git 时，
> 安装会在这一步失败，报错形如：
>
> ```text
> [ERROR] Command failed with exit code 1: git ls-remote "https://github.com/<owner>/<repo>.git"
> 'git' 不是内部或外部命令，也不是可运行的程序或批处理文件。
> ```
>
> 两条路：
>
> 1. **装上 git 再重试**：Windows 用 `winget install Git.Git` 或到 git-scm.com 下载；
>    装完**重开终端**让 PATH 生效，再执行上面的 `add` 命令。
> 2. **绕开 git**：把本工程目录（或解压后的 zip）直接拷到目标机，用本地路径安装。
>    本包**零运行时依赖**（`package.json` 没有 `dependencies`），`link:` 安装
>    不需要联网下载任何东西：
>
>    ```bash
>    dsh plugin --profile <PROFILE> add "link:<解压后的目录>"
>    ```
>
>    界面里的「添加插件」对话框同样接受**本地目录路径**，效果一致。

> 下面的命令**只应在测试机上执行**。执行前先确认 `echo $DSH_HOME` 指向测试机的 dsh home。

**推荐：`link:` 协议**（软链到源码目录，改代码后重启即生效，适合联调）

```bash
dsh plugin --profile <PROFILE> add "link:<PLUGIN_DIR>"
```

例（Windows）：

```bash
dsh plugin --profile web add "link:C:\plugins\dsh-gov-workbench"
```

例（macOS / Linux）：

```bash
dsh plugin --profile web add "link:/home/user/plugins/dsh-gov-workbench"
```

**`link:` 换成其它写法：**

| 写法 | 命令 | 适用场景 |
| --- | --- | --- |
| `link:` | `dsh plugin --profile web add "link:<PLUGIN_DIR>"` | 联调；软链，改源码立即反映 |
| `file:` | `dsh plugin --profile web add "file:<PLUGIN_DIR>"` | 拷贝一份到 profile 的 store，与源码解耦 |
| 相对路径 | `dsh plugin --profile web add "../dsh-gov-workbench"` | 在 profile 目录附近时；会被锚定到**当前工作目录** |
| npm 包名 | `dsh plugin --profile web add dsh-gov-workbench` | 已发布到 registry 时。本包 `package.json` 未设 `private`，可直接 `npm publish`；但注意 registry 默认是 npmmirror 镜像，发布要走官方源 |

命令行为（`@deepseek-ai/dsh-plugin-manager` 实测）：

1. 在 `<DSH_HOME>/profiles/<PROFILE>/` 目录下把剩余参数转发给 pnpm（profile 不存在时会先按模板初始化）；
2. 安装完成后 **reconcile** `dsh.profile.bundles`：遍历 profile 的 `dependencies`，凡是**声明了 `dsh.bundle.patch`** 的包就被追加进 bundle 栈；
3. 没声明 `dsh.bundle` 的包只会得到一行警告
   `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，不会成为插件层。

本包在 `package.json` 里声明了 `dsh.bundle.patch: ./cordis.patch.yml`，所以会自动进 bundle 栈。

**手动等效做法**（CLI 不可用或想完全掌控时）：

1. 编辑 `<DSH_HOME>/profiles/<PROFILE>/package.json`，在 `dependencies` 加一行，并在 `dsh.profile.bundles` 追加本包：

   ```jsonc
   {
     "dependencies": {
       "dsh-gov-workbench": "link:C:\\plugins\\dsh-gov-workbench"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-gov-workbench"
         ]
       }
     }
   }
   ```

2. 在 profile 目录执行 `pnpm install`。

> 两种做法等价。走 CLI 的好处是 reconcile 会自动算 bundle 栈，不用手写 `bundles`。

### 3.3 首次启动：确认插件挂上了

**bundle 栈的变化只有重启 dsh 才会被读取**，所以装完必须重启。

生效边界：

```text
安装 / 卸载 / 改端口或 host            → 必须重启 dsh 才挂载
只改 public/ 下的页面资源              → 刷新浏览器即生效（静态资源每次请求都读盘）
只改 $DSH_HOME/gov-workbench.json 内容 → 立即生效
```

**确认点 1：启动日志里 3091 的 ready 行。** 重启后应出现三行：

```text
[gov-workbench] 综合政务智能工作台已上线：http://127.0.0.1:3091/
[gov-workbench] 宿主 API 网关：typertGateway（已接入，1:1 能力）
[gov-workbench] 配对令牌校验：开启；配置文件：<DSH_HOME>/gov-workbench.json
```

第二行是关键：**必须**是 `typertGateway（已接入，1:1 能力）`。若显示
`unavailable（不可用）`，说明网关探测失败 —— 见 §3.6 排错。

**确认点 2：`/plugin/status` 端点自检。**

```bash
curl -i http://127.0.0.1:3091/plugin/status
```

期望 `200` 且含 `plugin` / `host` / `hostAvailable: true` / `port` / `requireToken` 等字段，
**不含** `token` 字段（令牌永不回显）。浏览器直接打开 `http://127.0.0.1:3091/` 也能看到政务门户页面。

**确认点 3：`--dump-config` 查合成树里有没有插入行。**

```bash
dsh --profile <PROFILE> --dump-config | grep -A 8 'gov-workbench'
```

（Windows 无 grep 时用 `dsh --profile <PROFILE> --dump-config > dump.txt` 再搜 `gov-workbench`。）

应能看到 `id: gov-workbench` / `name: dsh-gov-workbench` 以及 `config` 里的 `port: 3091`。
`--dump-config` 打印的是**合成后的** profile 树，因此这一条同时验证了「bundle 栈已包含本包」与
「`cordis.patch.yml` 的 `- insert:` 已合并」。

相关开关（三者互斥）：

```bash
dsh --profile <PROFILE> --dump-config          # 含用户层与 --patch 覆盖的完整树
dsh --profile <PROFILE> --dump-default-config  # 不含用户层，用于对比差异
dsh --profile <PROFILE> --dump-config-schema   # 只打印 profile 条目的 JSON Schema
```

### 3.4 冒烟测试（在测试机上跑）

工程自带 6 个零依赖测试套件，**不需要真实 API 额度**，也不会占用 3091：

```bash
cd <PLUGIN_DIR>

node test/syntax-check.mjs      # 语法 + UTF-8 无 BOM + 分层约束 + package.json 路径 + patch inject 守卫
node test/patch-inject.mjs      # patch 不得用 !!js 写 inject（真 cordis 可用时做端到端验证）
node test/cordis-proxy.mjs      # cordis ctx Proxy 语义（未 inject 的 service 访问会抛错）
node test/host-descriptor.mjs   # 用宿主真实 descriptor 校验端点表与 buildArgs 投影
node test/server-smoke.mjs      # 静态托管 / 四象限信封 / SSE / respond / 导出 / 跨源拒绝
node test/plugin-boot.mjs       # 真 apply() → 真 http → 真 SSE → 惰性接网关 → 关停
node test/frontend-wiring.mjs   # DOM id / 类名 / 栏目 / 模块顺序 / settings 签名 / 宿主必填字段
```

全部应以 `exit=0` 结束，并打印 `全部通过（N 项）`。

> `test/host-descriptor.mjs` 会去读 dsh 发行版里的 `app.asar`，把 26 个宿主包的
> `lib/typert.host.js` 里的 `invocations[]`（140 个端点）全部解出来，然后断言：
> 别名表里每个 namespace 都真的注册过、前端调用的每个端点都存在、`buildArgs` 对
> `acceptsUndefined` 的 wire 会整个省略、单 wire / 多 wire / scope 三种形状投影正确。
> 找不到含 dsh 描述符的 `app.asar` 时（测试机没装桌面版）该组打印 `SKIP` 并以 **0**
> 退出，第 1 组的静态检查永远执行。机器上若同时跑着别的 Electron 应用，定位器会
> 逐个候选验证「真的含 dsh 描述符」再采纳，不会把别的 `app.asar` 误当 dsh。

> 另有 4 个**真机联调**脚本（需要本机 3091 正在运行，且 `$DSH_HOME/gov-workbench.json`
> 里有配对令牌）。它们**不是**回归套件的一部分，只在有真机时手动跑：
>
> ```bash
> node test/_live-frontend.mjs    # 把改后的前端在 VM 里跑起来，捕获它真发的 wire body，原样打到真机
> node test/_live-verify.mjs      # 提交一条真消息，验证 updatedAt 与 asOfSeq 都增长
> node test/_live-regression.mjs  # 17 个已知可用端点回归，确认没改坏
> node test/_live-degrade.mjs     # 工作目录降级路径与 session.search 的真实错误码
> ```
>
> 这 4 个脚本会**真的往宿主里写数据**（建会话、发消息、改名），跑完会在 dsh 里留下
> 若干测试会话 —— 这是真机验证的必要代价，不是副作用。

> `test/patch-inject.mjs` 的第 2 组需要真 `@deepseek-ai/cordis` / `cordis-plugin-loader` /
> `cordis-plugin-include` / `js-yaml`。解析不到时该组打印 `SKIP` 并以 **0** 退出（不算失败），
> 第 1 组的静态检查永远执行 —— 所以测试机上没装这些依赖也不会误报。

**关于 `test/` 是否随包分发**：`package.json` 的 `files` 字段**包含** `test`。
这样无论用 `link:`（软链到源码目录）还是 `file:`（拷贝到 profile store）安装，
都能直接在安装目录里跑上面这些命令。测试本身零依赖、不占用 3091、不碰真实配置，
带上没有副作用。若你只想发最小包，把 `files` 里的 `"test"` 删掉即可 ——
那时测试需要从仓库源码跑。

> `plugin-boot.mjs` 会**真的起一个 http 服务**，但它先让内核分配空闲端口再写进配置，
> 用临时 `DSH_HOME`，**不会占用 3091**，也不碰测试机的真实配置。

也可以只跑最关键的一个：

```bash
node test/server-smoke.mjs
```

### 3.5 回滚 / 卸载

**方式 A：CLI 卸载（推荐）**

```bash
dsh plugin --profile <PROFILE> remove dsh-gov-workbench
```

该命令同样转发给 pnpm，并在结束后 reconcile：本包已不在 `dependencies` 里，
于是也会从 `dsh.profile.bundles` 中移除。**之后同样需要重启 dsh**。

**方式 B：手改回退**（CLI 不可用时）

1. 编辑 `<DSH_HOME>/profiles/<PROFILE>/package.json`：
   - 从 `dependencies` 删掉 `dsh-gov-workbench` 那一行；
   - 从 `dsh.profile.bundles` 删掉 `"dsh-gov-workbench"`。
2. 在 profile 目录执行 `pnpm install`（清理软链/拷贝）。
3. 重启 dsh。

**方式 C：只停用不卸载**

在 `<DSH_HOME>/profiles/<PROFILE>/cordis.patch.yml` 里追加一行按 id 覆盖（用户层最后应用，覆盖 bundle 层）：

```yaml
- id: gov-workbench
  disabled: true
```

这样包还在、页面不再挂载；把这段删掉再重启即可恢复。

**清理运行时残留**（可选）：

```bash
rm "$DSH_HOME/gov-workbench.json"   # 端口/令牌/访问计数
```

浏览器侧清 `localStorage` 的 `dsh.govWorkbench.v1`（UI 偏好）。

### 3.6 排错

**① 端口被占** —— 启动日志出现 `EADDRINUSE` 或 `监听失败：address already in use`

```bash
# Windows
netstat -ano | findstr :3091
# macOS / Linux
lsof -i :3091
```

判断：若占用者是**上一次未退出的 dsh**，杀掉它再重启；若是别的程序，改本插件端口 ——
编辑 `<DSH_HOME>/gov-workbench.json` 的 `port`，或改 profile 的 `cordis.patch.yml` 里
`config.port`，**然后重启 dsh**（端口改动不热生效）。
页面里「系统配置 → 插件自有端点」改端口只会落盘并返回 `needsRestart: true`，同样要重启。

**② 令牌不匹配** —— 浏览器拿到 `401` / `{"error":"配对令牌无效或缺失。"}`

原因通常是 cookie 没种上或过期。依次尝试：

1. 确认是**首次访问页面**（`GET /`）而不是直接打 `/api/*` —— 令牌 Cookie 在首次静态访问时种下；
2. 清掉浏览器里 `dsh_gov_workbench_token` 这个 Cookie，重新打开 `http://127.0.0.1:3091/`；
3. 检查 `<DSH_HOME>/gov-workbench.json` 的 `token` 与 `requireToken` 是否与预期一致；
   开发期想省事可临时设 `requireToken: false`（**不推荐在共享机器上这么做**）；
4. 用脚本调试时，把令牌放进 `x-gov-token` 头即可，不必依赖 Cookie：

   ```bash
   curl -X POST http://127.0.0.1:3091/api/workbench.status \
     -H 'content-type: application/json' \
     -H "x-gov-token: $(node -e "console.log(require(process.env.DSH_HOME+'/gov-workbench.json').token)")" \
     -d '{"type":"client-request","rpcId":"1","method":"workbench.status","payload":{}}'
   ```

**③ `apiProxy` / 网关未接入** —— 启动日志显示 `宿主 API 网关：unavailable（不可用）`，
或 `/plugin/status` 的 `hostAvailable` 为 `false`

这说明 `lib/host.js` 的能力探测两种形态都没找到（`apiProxy` 与 `typertGateway` 都不在 ctx 上）。
判断顺序：

1. **dsh 版本是否匹配**：`dsh --version`。0.2.0-rc.2 上 `apiProxy` **不存在**，
   正常形态应是 `typertGateway`；若日志里反而是 `apiProxy`，说明测试机是 0.1.x 老形态
   （也能用，但集成面不同）。
2. **profile 是否真的加载了本插件**：回到 §3.3 确认点 3，用 `--dump-config` 查插入行。
   插入行存在但网关不可用 ⇒ 是宿主侧问题；插入行不存在 ⇒ 是安装问题。
3. **确认 profile 里挂了 API 网关层**：`typertGateway` 由 `@deepseek-ai/dsh-api-gateway` 提供，
   它随 `@deepseek-ai/dsh-base` 的 `typert-gateway` 行装入。用 `--dump-config` 搜 `typert-gateway`，
   确认它没被 `disabled: true` 掉。
4. **`inject` 表达式是否生效**：本包用
   `inject: !!js "ctx.get('apiProxy', false) ? ['apiProxy'] : []"`，
   0.2.0+ 上求值为 `[]`（立即激活）。若插件卡在启动日志的
   「Plugins waiting for services」，说明注入表达式被改坏 —— 用 `--dump-config` 核对该行。

**降级行为**：网关不可用时插件**不会崩**，页面照常打开，`/plugin/status` 如实报告
`hostAvailable: false`，所有业务接口返回 `gateway/service-unavailable` 失败信封。
所以「页面能开但提交申办报错」通常就是这一条。

### 3.7 版本兼容性门禁

dsh 在加载插件时会检查 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
的版本范围是否满足运行时版本（预发布版本参与比较，`workspace:^` / `~` / `*` 视为当前运行时）。
不匹配会作为 issue 上报，并可通过「版本豁免」（按 `插件名@版本` → 精确运行时版本）放行。

**本包刻意不声明任何 `peerDependencies`** —— 它不 import 任何 `@deepseek-ai/*` 包，
只通过宿主 ctx 上的 service 通信（见 `lib/host.js`），因此不会触发版本门禁。
这也是它能在 0.1.x 与 0.2.x 两种宿主形态上都跑起来的原因。

## 4. 验证

全部命令在 `dsh-gov-workbench/` 目录下执行。

**逐文件语法检查** —— 覆盖单文件 V8 解析期，任何一项非零退出即为语法错误：

```bash
node --check lib/index.js
node --check lib/host.js
node --check lib/bridge.js
node --check lib/security.js
node --check lib/transport.js
node --check lib/sse.js
node --check lib/static.js
node --check lib/config.js
node --check public/js/api.js
node --check public/js/app.js
```

**工程自检** —— 覆盖全部 `.js` / `.mjs` 的 `node --check`、**UTF-8 无 BOM** 校验、分层约束（`lib/` 下不得出现 `window.` / `document.` / `localStorage.`，不得 import 网关的浏览器产物 `client.js`，不得把 `req.signal` 当实参传给宿主方法；`public/` 脚本不得用 ES module 语法）、`index.html` 前端模块引用顺序、`cordis.patch.yml` 的 `- insert:` 与默认端口 3091、`package.json` 的 `dsh.bundle.patch` / `type: module` / `exports` 声明：

```bash
node test/syntax-check.mjs
```

**宿主插件冒烟测试**（无需真实 API 额度）—— 覆盖静态托管与目录穿越防护、`/api/*` 四象限信封分发（unary → mock 网关 → `server-response`）、域名别名映射（`session→session`、`agentPreset→agentPresets`、`host→directoryPicker`）、`buildArgs` 按宿主描述符裁剪参数、SSE 帧格式（`\n\n` 分隔 + `data: <json>` + `server-request` 信封）、`/api/respond` 的 waterfall rpcId 还原、卷宗导出 JSONL、**来源校验拒绝跨源（403）**、**Content-Type 校验（`text/plain` → 415）**、**配对令牌校验（无令牌 → 401）**、AbortSignal 回归（确认传下去的是自建 `controller.signal`，且客户端断开时立即 abort、正常结束不 abort）、网关不可用时的失败信封降级：

```bash
node test/server-smoke.mjs
```

**端到端装配测试** —— 真的调用插件的 `apply(ctx, config)` → 读配置 → 探测宿主 → 起真 http 服务 → 静态托管 → `/api/*` 桥 → `/plugin/*` 端点 → 关停。断言插件形状与 `Config` 容错、上线日志、未探测到网关时如实告警但仍可开页面、**网关晚于插件 provide 时自动接上**（惰性解析 + `kind` getter）、**网关缺席时 `hostEvents` 等待而不是立即结束**、`typertGateway` 与老形态 `apiProxy` 的优先级、首次访问种令牌 Cookie、令牌落盘可复用、真 SSE + 投影转发（`session/projection` 帧）、`/plugin/status` 不回显令牌、`PUT /plugin/config` 落盘与 `needsRestart` 提示、跨源 `/plugin/*` 403、`ctx.effect` 关停路径真的释放端口（含「不得使用 `ctx.on('dispose')`」的源码守卫）。该测试**先让内核分配空闲端口再写进配置**，**不占用 3091**，使用临时 `DSH_HOME`，不碰真实配置：

```bash
node test/plugin-boot.mjs
```

**前端接线自检**（静态分析，无需浏览器）—— 前端是零构建的经典脚本，没有编译期检查，最容易出的错是「JS 里 `getElementById` 的 id 在 HTML 里不存在」导致运行时报 null。该测试把这条静态化：`app.js` / `panels.js` 引用的每个 DOM id 都必须在 `index.html` 中存在、用到的类选择器必须在 CSS 或 HTML 中有定义、每个 `data-page` / `data-page-link` 都指向真实栏目、模块加载顺序与全局对象导出一致、`util.js` 的对外 API 覆盖实际调用：

```bash
node test/frontend-wiring.mjs
```

**cordis Proxy 语义回归**（无需真 cordis 依赖）—— 用一个复刻 cordis 语义的 Proxy ctx（读未 inject 的 service 属性会抛错），确认网关探测、`MuxController` 订阅路径都不崩，并守卫源码里不出现裸的 `ctx.<service>` 属性访问：

```bash
node test/cordis-proxy.mjs
```

**patch 装配守卫**（致命 bug 回归）—— 确认 `cordis.patch.yml` 的插件行**没有** `inject:` 字段（尤其没有 `!!js` 形式）。第 1 组是纯静态检查，永远执行；第 2 组在真 cordis + 真 loader + 真 YAML 方言下端到端验证 `Inject.resolve` 的结果里不含 `__jsExpr`，并含一个**对照组**（故意构造坏 patch，证明检测手段不是空转）。依赖不可解析时第 2 组 `SKIP` 并以 0 退出：

```bash
node test/patch-inject.mjs
```

**手动确认** —— 应返回 `200` 与运行信息（`plugin` / `host` / `hostAvailable` / `port` / `requireToken` / `visits` / `marquee` / `node` / `pid` / `uptimeSeconds` / `startedAt`），且**不含** `token` 字段：

```bash
curl -i http://127.0.0.1:3091/plugin/status
```

## 5. 配置

### 5.1 服务端配置：`$DSH_HOME/gov-workbench.json`

路径由 `configPath()` 决定：`DSH_HOME` 存在时用它，否则回落到 `~/.dsh`。写入是原子的（先写临时文件再 `rename`）。**合并优先级（递增）**：内置默认值 → 配置文件 → `cordis.patch.yml` 该行的 `config`。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `port` | `3091` | 插件监听端口。刻意避开 3080（dsh 主 GUI）与 3081。取值必须落在 1–65535，非法值静默回落默认值。**改动需重启 dsh**。 |
| `host` | `'127.0.0.1'` | 监听地址。只接受非空字符串。改成 `0.0.0.0` 会把工作台暴露到局域网，请自行评估。**改动需重启 dsh**。 |
| `token` | `''`（启动时自动生成） | 配对令牌，32 字节 `base64url`。首次启动自动生成并写回配置文件；已有值不会被覆盖。 |
| `requireToken` | `true` | 是否强制校验配对令牌。默认开启，可在配置文件里置 `false` 关闭。 |
| `allowNoOrigin` | `true` | 是否放行**无 `Origin` 头**的请求（同源导航、curl、本地脚本）。置 `false` 则无 `Origin` 一律拒绝。 |
| `requireJsonContentType` | `true` | 是否要求写请求的 `Content-Type` 必须是 `application/json`。用于堵掉 `text/plain` 简单请求绕过预检的路径。 |
| `visits` | `0` | 访问次数统计，随 `workbench.visits` / `/plugin/visits` 递增并落盘。 |
| `marquee` | 三条内置通知 | 首页「重要通知」跑马灯内容，字符串数组。空数组会回落默认值。 |
| `sealOnComplete` | `true` | 是否在办结时显示「准予办结」盖章动画。 |
| `floatEnabled` | `true` | 便民提示浮窗（飘窗）开关。 |

### 5.2 前端偏好：`localStorage`

键名固定为 **`dsh.govWorkbench.v1`**，只放界面偏好，不放服务端配置。包含：`page`（当前栏目）、`sessionId`（当前事项）、`workspace` / `permission` / `preset` / `provider` / `model` / `reasoningEffort`（参数行选择）、`autoScrollTrace` / `traceChunkFilter`（轨迹视图）、`sealOnComplete` / `floatEnabled`（界面开关）、`largeFont` / `highContrast`（无障碍）、`marquee`。读写失败一律静默回落默认值。

### 5.3 插件自有端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/plugin/status` | GET | 运行信息，**不回显令牌** |
| `/plugin/config` | GET / PUT | 读写配置。PUT 只改传入字段；端口 / host 变动时回 `needsRestart: true` |
| `/plugin/token` | GET | 回显令牌（能走到这里的请求已通过令牌校验） |
| `/plugin/visits` | GET / PUT | 读取（自增）/ 清零访问计数 |
| `/plugin/marquee` | GET / PUT | 读写跑马灯内容 |

## 6. 与宿主能力对照表

页面调用的 wire 端点（「单数域名.方法」写法）与宿主侧的对应关系。域名 → namespace 的映射由 `lib/host.js` 的别名表驱动。

完整的 140 个宿主端点目录（含每个端点的 wire 名与 `acceptsUndefined` 标记）见
[`docs/host-endpoints.md`](docs/host-endpoints.md)。

| 栏目 / 功能 | 页面调用的 wire 端点 | 宿主 service / 说明 |
| --- | --- | --- |
| 工作目录 | `directoryPicker.list`、`directoryPicker.pick`、`directoryPicker.createDirectory` | namespace `directoryPicker`；`list` 返回 `path` / `home` / `crumbs` / `entries` / `truncated`，**需要 browse capability**，缺失时宿主回 `directory-picker/unavailable`。`list` 的 `path` 声明了 `acceptsUndefined`，所以空值必须整个省略该 wire（`buildArgs` 已处理）。`pick` 无参数，弹原生对话框。**降级**：`list` 不可用时界面切成「可手动编辑的输入框 + 浏览…按钮」，并在提示里如实写明当前模式。 |
| 权限档位（读取） | `permission.catalog` | namespace `permissionPresets`；返回 `options` / `defaultOptions` / `defaultPreset`。 |
| 权限档位（写入） | `settings.update('permission', { defaultPreset })` | `settingsController`。0.2.0-rc.2 的 Remote 面只暴露 `permissionPresets.catalog`，写入走 `settings` 的 `permission.defaultPreset`（与官方 UI 同路）。**注意**：`settings/update` 的宿主签名是位置参数 `(ns, patch, expectedRevision)`，`public/js/api.js` 已把它组装成键名匹配的 payload 对象。 |
| 办理模式 | `agentPreset.list`、`agentPreset.read`、`agentPreset.select` | namespace `agentPresets`；返回 `presets[]`（含 `id` / `name` / `isDefault`）。`read` 传裸 `{agentPreset}`；`select` 是**两个独立 wire** `{agentId, agentPreset}` —— `agentId` 是 scope 身份（即会话身份），传 `sessionId` 会得到 `gateway/arguments-invalid: missing "agentId"`。 |
| 模型与推理强度 | `session.modelCatalog`、`session.selectModel` | `sessionController`。`modelCatalog` 返回 `default` / `routableProviders` / `groups` / `failures`；`selectModel` 的必填字段是 `sessionId` + **`provider`** + `model`，`reasoningEffort` 可选。provider 必须取自 `groups[].id`（不是模型名的一部分）。推理强度会回落到该模型自己的 `reasoning.defaultEffort`。另有 `llm.listProviders` / `llm.listConfigurableProviders`。 |
| 提交申办 | `session.create` → `session.prompt` | `sessionController`。首次提交自动受理（`create`，可带 `cwd` / `agentPreset`），随后 `prompt`。**`session/prompt` 的必填字段是 `requestId` + `sessionId` + `mode` + `content`**（`requestId` 每次提交唯一；漏传会得到 `gateway/input-invalid: wire field "request" failed boundary validation`）。事项编号由宿主分配（`session-*`）。 |
| 取消办理 | `session.cancel` | `sessionController`，带 `sessionId`。 |
| 历史分页 | `session.page`、`session.list` | `sessionController`。`page` 入参 `address: { kind:'session', sessionId }` / `throughSeq` / `maxMessages`，返回 `records` / `hasMore`。**`throughSeq` 必须落在宿主自己的游标内**（超过会得到 `gateway/bad-request: session page through seq N is past cursor M`）；界面取自 `session.list` 的 `projections.asOfSeq`。 |
| 卷宗检索 | `session.search` | `sessionController`，带 `query`。留空显示全部。宿主若把 session-query 索引配成 `openAt "never"`（本机如此），会回 `gateway/internal: session search is disabled` —— 界面显示成「宿主未启用会话检索」。 |
| 技能目录 | `skills.list` | namespace 是**复数** `skills`（不是 `skill`），必带 `sessionId`。 |
| 配置读写 | `settings.describe`、`settings.update`、`settings.replace`、`settings.mutate` | `settingsController`。表单由 `describe` 返回的 schema 动态生成，覆盖全部命名空间；`update` 带修订号做乐观并发控制；敏感项只显示是否已设置。 |
| 统计取值 | `session.projections` + `events.mux` 的 `session/projection` 帧 | `sessionProjections.onChanged`。轮次 / 步数 / 模型耗时 / 工具耗时 / 首 token / 解码耗时与 token 来自 `sessionStats` 投影；输入 / 输出 / 缓存 token 来自 `tokenUsage` 投影 —— **嵌套在 `totals` 下**（`{totals:{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`），读平铺字段会永远拿到 0。平台不估算、不编造任何统计值。 |
| 宿主诊断 | `pluginInventory.list` | namespace `pluginInventory`；返回宿主已加载的插件条目与各预设的组合，用于诊断「插件到底挂上没有」。 |
| 审批应答 | `POST /api/respond` | 网关 `$events` 的 waterfall 帧（`approval/request`）经 `MuxController` 翻译为 `approval/requested`，应答走 `$events/result` + `{ clientId, eventId, outcome }`。 |
| 提问应答 | `POST /api/respond` | 同上路径，`user-questions/request` → `question/requested`，应答携带 `{ answers }`。 |

**已移除的幽灵端点**（0.2.0-rc.2 上不存在，调了必然失败，因此从 `api.js` 与别名表里删掉）：

| 曾经的调用 | 真实情况 |
| --- | --- |
| `host.describe` / `host.listDirectory` | 0.1.x `apiProxy` 时代的端点。别名表曾把域名 `host` 改写成 `directoryPicker`，产生 `directoryPicker/describe`、`directoryPicker/listDirectory` 两个必然 `gateway/invocation-unavailable` 的端点 —— 该映射已删除。 |
| `skill.list` | 真实端点是 `skills/list`（复数 namespace），且必带 `sessionId`。 |
| `subagent.list` | `subagents` namespace 只有 `prompt` 与 `interruptByParent`。 |
| `workspace.list` | 不存在；会话/工作区列表走 `session.list` 的投影。 |
| 卷宗导出 | `GET /api/session.export?sessionId=` | `ctx.sessionPersistence.open(id, 'read')` → `handle.read()`，序列化为 JSONL（首行会话头，其后每行一个事件），与 `dsh-session-log-export` 的 `readSessionLogText` 同格式。网关兜底走 `downloads/sessionLog`。 |
| 事件流 | `GET /api/events.mux` | 合成流：进程内 `session/event` / `session/created` / `session/disposed` + `sessionProjections.onChanged` + 网关 `$events` 翻译出的审批 / 提问帧。 |
| 宿主原始事件流 | `GET /api/events.host` | 网关 `$events` 帧原样透传（`ready` / `emit` / `waterfall` / `cancel`）。 |
| 运行信息 | `workbench.status`、`workbench.visits` | 插件自有端点，同样走四象限信封，便于前端复用一套错误处理。 |

## 7. 安全

准入判定集中在 `lib/security.js` 的 `admit()`，顺序为 **来源 → 令牌 → Content-Type**，任一失败即拒绝且**不执行任何副作用**（被拒绝的请求绝不会到达宿主网关）。`/api/*` 与 `/plugin/*` 都过完整准入；静态资源只做来源校验 —— 否则首次访问会因为拿不到页面而无法种下令牌 Cookie。

| 机制 | 行为 |
| --- | --- |
| **来源校验** | 有 `Origin` 头时，`new URL(origin).host` 必须等于 `req.headers.host`，否则 **403**（含跨端口，如 `127.0.0.1:3080`）。缺 `Host` 头直接拒绝（HTTP/1.1 必有 Host，缺失说明请求被构造过）。 |
| **跨站拒绝** | `sec-fetch-site: cross-site` 一律 **403**，不依赖 `Origin` 是否存在。 |
| **无 Origin 请求** | 由 `allowNoOrigin` 决定（默认放行，覆盖同源导航 / curl / 本地脚本）。置 `false` 则拒绝。 |
| **Content-Type 校验** | 写请求（非 GET/HEAD/OPTIONS）的 `Content-Type` 必须是 `application/json`（允许带 `; charset=...`），否则 **415**。这条堵掉 `text/plain` 简单请求不触发预检就打到 `/api/session.prompt` 的路径。 |
| **配对令牌** | 默认**开启**。先查 `x-gov-token` 头，再查 Cookie `dsh_gov_workbench_token`，任一正确即通过；否则 **401**。比较用**常量时间**实现（`timingSafeEqualString`），避免逐字符试探。首次访问静态资源时由服务端种下 Cookie（`Path=/; SameSite=Strict; Max-Age=1年`，非 `HttpOnly` 以便页面 JS 读取）。可在配置里置 `requireToken: false` 关闭。 |
| **目录穿越防护** | `resolveStaticPath()` 先 `decodeURIComponent`，再 `normalize` 并 `resolve` 到 `public/`，最后校验前缀必须落在 `public/` 之内；越界返回 **403**（`/%2e%2e%2f%2e%2e%2fpackage.json` 之类的编码绕过同样被拒）。 |
| **绑定回环地址** | 默认 `host: '127.0.0.1'`，仅本机可访问。改成 `0.0.0.0` 会暴露到局域网，需自行评估。 |
| **令牌不回显** | `/plugin/status` 与 `GET /plugin/config` 都不返回 `token` 字段，只返回 `tokenSet` 布尔；`/plugin/token` 能走到就已通过令牌校验。 |
| **响应不可缓存** | 所有 JSON 响应带 `cache-control: no-store`。 |
| **请求体限长** | 单条 JSON 请求体上限 32 MiB（`/api/respond` 与 `/plugin/*` 更小），超限抛错而非静默截断。 |
| **无 CSRF 驱动点** | 准入层为每个请求自建 `AbortController`（而非依赖 `req.signal`），客户端断开时立即 abort，且区分「断开」与「正常结束」—— 正常 `res.end()` 不会误触发 abort。 |
| **`req.signal` 不可依赖** | Node ≤22 上 `http.IncomingMessage` 没有 `.signal`（恒为 `undefined`）；Node ≥24 上它存在，但 v24.18.0 只在响应关闭后才 abort、v24.21.0 正常结束根本不 abort。三个版本行为互不一致，都必须自建 `AbortController`，见 §8 第 8 条。 |

## 8. 已知限制

1. **未在真实 dsh 进程中挂载验证过 3091 端口。** 本插件的端到端装配由 `node test/plugin-boot.mjs` 用 mock ctx 与假网关验证；该测试**先让内核分配一个空闲端口再写进配置**，因此不会占用 3091（注意：`port: 0` 会被 `mergeConfig` 当作非法值回落到默认 3091，所以测试不能用它）。**真实挂载需要重启 dsh**，重启后才会在 `127.0.0.1:3091` 上真正监听。在那之前，3091 上的行为属于未验证状态。

2. **dsh 0.2.0-rc.2 上 `ctx.apiProxy` 不存在。** `@deepseek-ai/dsh-host-apiproxy` 已从发行版移除，API 网关被重构为 `ctx.typertGateway`（`@deepseek-ai/dsh-api-gateway` 的 `TypertGatewayService`）+ 各域 controller（`sessionController` / `settingsController` / `workspaceController` / `agentPresets` / `permissionPresets` / `llm` / `userQuestions` / `approval` 等）；端点清单由 `@deepseek-ai/dsh-typert-registry` 在运行时从各包的 `typert.host.js` 注册进 `ctx.typert.local`。因此 `lib/index.js` 的 `inject` **留空**（原因见上面第 4 条），挂载由 `lib/host.js` 把两种宿主形态归一成同一内部接口（`invoke` / `stream` / `hostEvents` / `resolveEventResult` / `describeEndpoint`），**同时兼容** 0.2.0+ 的 `typertGateway` 与 0.1.x 的老形态 `apiProxy`（后者优先级更高）。两者都不存在时插件照常开页面，并在状态接口里如实报告 `hostAvailable: false`，而不是崩掉整个 dsh。

   配套的**惰性解析**设计：因为插件是「立即激活」的，网关可能在 `apply()` 之后才 provide。所以 `lib/host.js` 不在构造时绑定一次，而是 ——
   - `kind` 是 **getter**，每次读取都重新探测，实时反映可用性；
   - `invoke` / `stream` / `resolveEventResult` / `describeEndpoint` 在**每次调用时**重新 `ctx.get('typertGateway', false)`；
   - `hostEvents(signal)` 是**等待式生成器**：网关未就绪时先等（响应式 `ctx.inject([...], cb)` + 轮询兜底），出现后再开始转发；流自然结束后若网关仍在且未 abort 会重新接续 —— 因此 `MuxController` 不需要任何重启逻辑。

   回归测试：`test/plugin-boot.mjs` 的「网关晚于插件 provide 时自动接上」与「网关缺席时 hostEvents 等待而不是立即结束」两项。

3. **会话事件不在 0.2.0-rc.2 的网关转发白名单里。** `@deepseek-ai/dsh-api-remotes` 只把一份白名单事件转发给浏览器（`approval/request`、`user-questions/request` 以及各类配置变更），**session 事件不在其中**；0.1.x 的 `apiProxy.events.mux()` 也已不存在。所以 `lib/sse.js` 的 `MuxController` 改为在**宿主进程内直接订阅** `ctx.on('session/event', ..., { global: true })`（并订阅 `session/created` / `session/disposed`）—— 这正是 `dsh-session-controller` 自己 follow 会话时用的方式；`{ global: true }` 拿全局可见性，老版本自动退回两参数形式。实时投影（统计 / 标题 / 待办）另经 `sessionProjections.onChanged` 获取。若宿主未挂该投影服务，插件告警但继续工作，统计与待办只随会话事件更新。

4. **`cordis.patch.yml` 的插件行不能写 `inject` 字段（尤其不能写 `!!js`）。** 这是本项目踩过的最致命的一个坑，完整记录如下。

   **症状**：插件装上去后**永不激活**，启动日志停在「Plugins waiting for services」，3091 根本不监听。

   **机制**（用真 cordis 4.x + 真 `cordis-plugin-loader` + 真 YAML 方言逐条复现）：

   1. `cordis-plugin-include` 里 `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，让**整个 YAML 文档**都按 `!!js` 类型解析 —— 所以 `inject: !!js "..."` 得到的是一个**对象** `{ __jsExpr: "..." }`，而不是字符串或数组。
   2. loader 的 `interpolate(ctx, value)` **只对 `config` 调用**：
      `ctx.on("internal/config", function (_config, next) { const config = next(); ...; return interpolate(this.ctx, config) })`。
      `inject` 不在求值路径上，所以那个表达式**永远不会被求值**。
   3. `disabled` 有专门处理 —— `disabledOf(options) { return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.disabled.__jsExpr)) : Boolean(options.disabled) }`。**`inject` 没有对应的 `isJsExpr` 分支。**
   4. `Inject.resolve` 的实现是：

      ```js
      function resolve(inject, result = Object.create(null)) {
        if (!inject) return result
        if (Array.isArray(inject)) for (const name of inject) result[name] = null
        else if (Reflect.has(inject, symbols.checkProto)) { /* 原型链式注入 */ }
        else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
        return result
      }
      ```

      `{__jsExpr:"..."}` 既不是数组、也没有 `checkProto`，于是走最后一条分支 —— **把 `__jsExpr` 当成一个 service 名注册**。实测 `Inject.resolve(...)` → `["__jsExpr"]`。
   5. loader 的消费点是 `ctx.on("internal/plugin", (fiber) => { ... Inject.resolve(fiber.entry.options.inject, fiber.inject) })`。**只有当 `options.inject` 为 `undefined` 时，插件自己导出的 `inject` 才生效**。

   **正确做法**：**整行删掉 `inject:`**（不是写 `inject: []` —— 空数组同样会覆盖插件导出的值），让 `lib/index.js` 的 `export const inject = []` 生效。

   **回归守卫**：`test/patch-inject.mjs`（8 项）。第 1 组是纯静态检查（不依赖任何外部包，测试机上也能跑）；第 2 组用**真 cordis + 真 loader + 真 YAML 方言**端到端验证，其中有一项是**对照组** —— 故意构造一个带 `inject: !!js` 的 patch，断言检测手段确实能识别出 `{__jsExpr}`，从而证明这个检查不是空转。依赖不可解析时该组打印 `SKIP` 并以 0 退出，不会误报失败。`test/syntax-check.mjs` 另有一条静态守卫。

   顺带一提，`inject: [apiProxy]`（普通数组写法）在 0.2.0-rc.2 上同样会让插件永不激活 —— 因为该版本已无 `apiProxy` service。两种写法都不能用，原因不同。

5. **`test/syntax-check.mjs` 在受限沙箱下会自动降级。** 该脚本用 `node --check` 逐文件校验；若沙箱拒绝子进程的管道 stdio（`EPERM`），脚本会自动退回 `stdio: 'inherit'` 模式仅取退出码，并在输出里注明降级（校验方式仍是同一个 `node --check`）。本机 danger-full-access 模式下不会触发降级。

6. **端口 / host 改动不热生效。** `PUT /plugin/config` 会落盘并返回 `needsRestart: true` 与提示文案，但当前监听保持不变 —— 需重启 dsh。

7. **`public/` 资源不缓存但每次读盘。** 好处是改完刷新即生效、无需重启；代价是每个静态请求都有一次磁盘读。适合本机单用户场景。

8. **`req.signal` 的版本差异（三版本实测，非推测）。** 参考实现把 `req.signal` 传给宿主方法，这在任何 Node 上都不可靠：

   | Node | `req.signal` | 正常结束时会 abort 吗 | 能否用于流中途取消 |
   | --- | --- | --- | --- |
   | v22.22.2 | 不存在，恒为 `undefined` | —（无 signal） | 不能。宿主帧队列 `signal.addEventListener(...)` 无 undefined 防御 → `TypeError` → 前端重连死循环 |
   | v24.18.0 | 存在，真实 `AbortSignal` | 会，但在 `res.close` **之后** | 不能，太晚 |
   | **v24.21.0**（dsh runtime） | 存在，真实 `AbortSignal` | **不会**（实测等 7 秒仍 `false`） | 不能，连结束都不反映 |

   三者行为互不一致，因此 `lib/transport.js` 的 `trackAbort()` 一律自建 `AbortController`，在 `res.on('close')` 里 abort，并用 `res.writableEnded` 区分「客户端断开」与「正常结束」。`test/server-smoke.mjs` 第 5 组是可复现探针，**只断言三版本都成立的部分**（进入处理器时尚未 abort），不对「结束后一定 abort」做断言 —— 否则换 Node 版本 CI 会红。

   全部 5 个测试套件已在 **v22.22.2 / v24.18.0 / v24.21.0** 三个 Node 上跑通。

9. **关停必须用 `ctx.effect`，不能用 `ctx.on('dispose')`。** 已实测（cordis 4.x）：`ctx.on('dispose', fn)` 的 `fn` **永远不会执行**，该事件名从不被派发。若用它做清理，插件卸载后 http 服务会继续占着 3091 端口。cordis 的插件级清理语义是 `ctx.effect(() => () => cleanup)` —— effect 回调返回的函数在该 fiber 销毁时调用（`@deepseek-ai/cordis-plugin-timer` 等官方插件都是这个写法）。`lib/index.js` 已改用 `ctx.effect`，并有两条回归断言守着（行为断言 + 源码模式断言，且忽略注释）。

10. **cordis 的 `ctx` 是 Proxy：读未声明 service 的属性会抛错，不是返回 `undefined`。** 这是真实挂载时才暴露的坑 —— `ctx.apiProxy` 在 mock ctx 上完全正常，在真 cordis 下直接抛 `cannot get property "apiProxy" without inject`，插件启动即崩。因此 `lib/host.js` / `lib/sse.js` / `lib/bridge.js` 的 service 探测一律走 `ctx.get(key, false)`（`false` = 不要求已注入），并整段包 `try/catch`。`test/cordis-proxy.mjs` 用一个「复刻该抛错语义的 Proxy ctx」把这条钉死，另有源码守卫禁止裸的 `ctx.<service>` 属性访问。

11. **`settings` 写入端点是位置参数，不是单 payload。** 宿主签名是 `settings/update(ns, patch, expectedRevision)`（`replace` / `mutate` 同理）。wire 上的 payload 必须是与描述符 wire 名一致的对象，因此 `public/js/api.js` 在客户端就把位置参数组装成 `{ ns, patch, expectedRevision? }`。若写成 `update: (p, s) => unary('settings.update', p, s)`，传进来的 `ns` 字符串会被当成 payload，服务端 `buildArgs` 会把它丢掉，宿主以 `gateway/arguments-invalid` 拒绝 —— 表现为「提交配置后静默无效」。`test/frontend-wiring.mjs` 有两条断言守着（`api.js` 的签名形状 + `app.js` 的调用形状）。

---

MIT
