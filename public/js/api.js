/* ====================================================================
 * api.js —— dsh 四象限 RPC 客户端（与宿主 API 网关 1:1 对接）
 *
 * 协议（与 @deepseek-ai/dsh-client-connection 的 fetch carrier 一致）：
 *  - unary：POST /api/<domain>.<method>
 *      body {type:'client-request', rpcId, method, payload}
 *      resp {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 *  - 流：GET /api/events.mux → text/event-stream
 *      帧 = '\n\n' 分隔，行 'data: <json>'，
 *      json = {type:'server-request', rpcId, method, payload}
 *  - 应答：POST /api/respond  body {type:'client-response', rpcId, result}
 *  - 导出：GET /api/session.export?sessionId=
 *
 * 本模块只做协议，不含业务判断：域名 → 端点的映射由服务端 lib/host.js 负责，
 * 页面侧一律使用「单数域名.方法」这种 wire 写法。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil
  var BASE = ''

  /** 从 cookie 里取配对令牌（服务端在首次静态访问时种下）。 */
  function tokenFromCookie() {
    var parts = String(document.cookie || '').split(';')
    for (var i = 0; i < parts.length; i += 1) {
      var segment = parts[i]
      var at = segment.indexOf('=')
      if (at === -1) continue
      if (segment.slice(0, at).trim() !== 'dsh_gov_workbench_token') continue
      return segment.slice(at + 1).trim()
    }
    return ''
  }

  /** 统一请求头：JSON + 配对令牌。 */
  function headers() {
    var out = { 'content-type': 'application/json' }
    var token = tokenFromCookie()
    if (token) out['x-gov-token'] = token
    return out
  }

  /**
   * unary 调用。
   * @returns {Promise<{ok:true,value:any}|{ok:false,error:{code,message}}>}
   *   业务错误不抛异常，统一从返回值判读。
   */
  async function unary(method, payload, signal) {
    var body = { type: 'client-request', rpcId: util.uuid(), method: method, payload: payload || {} }
    try {
      var resp = await fetch(BASE + '/api/' + method, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: signal,
      })
      if (!resp.ok) {
        var detail = ''
        try { detail = await resp.text() } catch (error) { detail = '' }
        return { ok: false, error: { code: 'transport', message: 'HTTP ' + resp.status + (detail ? '：' + util.truncate(detail, 200) : '') } }
      }
      var full = await resp.json()
      if (!full || full.type !== 'server-response') {
        return { ok: false, error: { code: 'transport', message: '响应信封格式错误' } }
      }
      if (full.rpcId !== body.rpcId) {
        return { ok: false, error: { code: 'transport', message: 'rpcId 不匹配' } }
      }
      return full.result
    } catch (error) {
      if (error && error.name === 'AbortError') return { ok: false, error: { code: 'aborted', message: '请求已取消' } }
      return { ok: false, error: { code: 'transport', message: String((error && error.message) || error) } }
    }
  }

  /**
   * 打开一条 SSE 流，逐帧回调。
   * @param streamName - 'events.mux' | 'events.host'
   * @param onFrame - ({rpcId, method, payload}) => void
   * @param opts - { signal, onOpen, onError, onClose }
   */
  async function openStream(streamName, onFrame, opts) {
    var options = opts || {}
    var controller = new AbortController()
    var outer = options.signal
    var onAbort = function () { controller.abort() }
    if (outer && typeof outer.addEventListener === 'function') outer.addEventListener('abort', onAbort)
    try {
      var resp = await fetch(BASE + '/api/' + streamName, {
        method: 'GET',
        headers: { 'x-gov-token': tokenFromCookie() },
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status)
      if (typeof options.onOpen === 'function') options.onOpen()
      var reader = resp.body.getReader()
      var decoder = new TextDecoder()
      var buffer = ''
      for (;;) {
        var chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        var boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          var frameText = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          var data = frameText
            .split('\n')
            .filter(function (line) { return line.indexOf('data: ') === 0 })
            .map(function (line) { return line.slice(6) })
            .join('')
          if (data) {
            try {
              var full = JSON.parse(data)
              if (full && full.type === 'server-request') {
                onFrame({ rpcId: full.rpcId, method: full.method, payload: full.payload })
              }
            } catch (error) {
              console.warn('[gov-workbench] 跳过坏帧：', error.message)
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (outer && outer.aborted) return
      if (controller.signal.aborted) return
      if (typeof options.onError === 'function') options.onError(error)
    } finally {
      if (outer && typeof outer.removeEventListener === 'function') outer.removeEventListener('abort', onAbort)
      if (typeof options.onClose === 'function') options.onClose()
    }
  }

  /** 应答一个 server-request（审批 / 提问）。 */
  async function respond(rpcId, value) {
    try {
      var resp = await fetch(BASE + '/api/respond', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'client-response', rpcId: rpcId, result: { ok: true, value: value } }),
      })
      return await resp.json()
    } catch (error) {
      return { accepted: false, reason: 'bad-response', message: String((error && error.message) || error) }
    }
  }

  /** 触发一次卷宗下载。 */
  function exportSessionLog(sessionId) {
    var link = document.createElement('a')
    link.href = BASE + '/api/session.export?sessionId=' + encodeURIComponent(sessionId)
    link.download = 'session-' + sessionId + '.jsonl'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  /* ---------------- 业务便捷方法（全部是 wire 单数域名） ---------------- */

  var api = {
    unary: unary,
    openStream: openStream,
    respond: respond,
    exportSessionLog: exportSessionLog,

    sessions: {
      list: function (p, s) { return unary('session.list', p, s) },
      create: function (p, s) { return unary('session.create', p, s) },
      page: function (p, s) { return unary('session.page', p, s) },
      projections: function (p, s) { return unary('session.projections', p, s) },
      modelCatalog: function (p, s) { return unary('session.modelCatalog', p, s) },
      selectModel: function (p, s) { return unary('session.selectModel', p, s) },
      /* `session/prompt` 的宿主必填字段是
       * `requestId, sessionId, mode, content`（zod schema 实测）。
       * `requestId` 是**每次提交唯一**的请求身份，宿主用它把队列项、文件回执
       * 与历史观测串起来；漏传会直接 `wire field "request" failed boundary
       * validation`。这里在包装层兜底生成，调用方不必自己拼。 */
      prompt: function (p, s) {
        var payload = p || {}
        return unary('session.prompt', {
          requestId: typeof payload.requestId === 'string' && payload.requestId !== '' ? payload.requestId : util.uuid(),
          sessionId: payload.sessionId,
          mode: payload.mode === 'steer' ? 'steer' : 'queue',
          content: Array.isArray(payload.content) ? payload.content : [],
          ...(typeof payload.clientTimeZone === 'string' && payload.clientTimeZone !== ''
            ? { clientTimeZone: payload.clientTimeZone }
            : {}),
        }, s)
      },
      cancel: function (p, s) { return unary('session.cancel', p, s) },
      rename: function (p, s) { return unary('session.rename', p, s) },
      fork: function (p, s) { return unary('session.fork', p, s) },
      search: function (p, s) { return unary('session.search', p, s) },
      updateQueue: function (p, s) { return unary('session.updateQueue', p, s) },
      attachment: function (p, s) { return unary('session.attachment', p, s) },
      openWorkspacePath: function (p, s) { return unary('session.openWorkspacePath', p, s) },
    },

    agentPresets: {
      list: function (p, s) { return unary('agentPreset.list', p, s) },
      /* `agentPresets/read` 只有一个 wire `agentPreset`，传裸 `{agentPreset}`。 */
      read: function (p, s) { return unary('agentPreset.read', p, s) },
      /* `agentPresets/select` 是**两个独立参数**：
       *   scope  { context: 'agent', wire: 'agentId' }
       *   parameters [ agentId(lookup), agentPreset(json) ]
       * 描述符要求 args 的键集合与 wire 名完全一致，所以必须传
       * `{ agentId, agentPreset }` —— 传 `{sessionId, agentPreset}` 会得到
       * `gateway/arguments-invalid: missing "agentId"`。
       * `agentId` 就是会话身份（宿主 SessionId 与 Agent 身份同源）。 */
      select: function (sessionId, agentPreset, s) {
        return unary('agentPreset.select', { agentId: sessionId, agentPreset: agentPreset }, s)
      },
    },

    /* 真实端点是 `skills/list`（复数 namespace），不是 `skill.list`；
     * 且宿主 zod 必填 `sessionId`（返回该会话可见的技能目录）。 */
    skills: { list: function (p, s) { return unary('skills.list', p, s) } },

    permission: { catalog: function (p, s) { return unary('permission.catalog', p, s) } },

    /* `workspace/*` 在 0.2.0-rc.2 上确实存在（wire 名为 `request`），
     * 但**没有** `workspace.list`：会话列表走 `session.list`，
     * 工作区列表由 `session.list` 的 `projections.values.sessionListMetadata`
     * 与 `workspace/*` 的写动词共同表达。所以这里不提供 `list`。 */
    workspace: {
      create: function (p, s) { return unary('workspace.create', p, s) },
      rename: function (p, s) { return unary('workspace.rename', p, s) },
      delete: function (p, s) { return unary('workspace.delete', p, s) },
      archiveSession: function (p, s) { return unary('workspace.archiveSession', p, s) },
    },

    /* `directoryPicker` 只有三个真实动词：
     *   list(path?)        —— 需要 browse capability，缺失时宿主回
     *                         `directory-picker/unavailable`；
     *   pick()             —— 原生对话框，任何组合都可用；
     *   createDirectory(path, name)。
     * `path` 声明了 acceptsUndefined，所以**空 payload 必须整个省略该键**
     * （服务端 buildArgs 已按描述符处理）。 */
    directoryPicker: {
      list: function (p, s) { return unary('directoryPicker.list', p, s) },
      pick: function (p, s) { return unary('directoryPicker.pick', p, s) },
      createDirectory: function (p, s) { return unary('directoryPicker.createDirectory', p, s) },
    },

    /* 配置写入。
     *
     * 这三个端点的宿主签名是**位置参数**：`settings/update(ns, patch,
     * expectedRevision)`、`settings/replace(ns, section, expectedRevision)`、
     * `settings/mutate(ns, ops, expectedRevision)`。而 wire 上的 payload 是一个
     * 对象，其键必须与描述符声明的 wire 名严格一致 —— 所以这里在客户端就把
     * 位置参数组装成对象，调用方直接 `update(ns, patch, revision)` 即可。
     *
     * 注意：**不能**写成 `update: function (p, s) { return unary('settings.update', p, s) }`，
     * 那样传进来的 ns 字符串会被当成 payload，服务端 buildArgs 会把它丢掉，
     * 结果是 args 为空、宿主以 gateway/arguments-invalid 拒绝。 —— */
    settings: {
      describe: function (p, s) { return unary('settings.describe', p, s) },
      update: function (ns, patch, expectedRevision, s) {
        return unary('settings.update', {
          ns: ns,
          patch: patch,
          ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision }),
        }, s)
      },
      replace: function (ns, section, expectedRevision, s) {
        return unary('settings.replace', {
          ns: ns,
          section: section,
          ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision }),
        }, s)
      },
      mutate: function (ns, ops, expectedRevision, s) {
        return unary('settings.mutate', {
          ns: ns,
          ops: ops,
          ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision }),
        }, s)
      },
    },

    llm: {
      providers: function (p, s) { return unary('llm.listProviders', p, s) },
      configurableProviders: function (p, s) { return unary('llm.listConfigurableProviders', p, s) },
    },

    /* —— 宿主插件清单（诊断用；真实端点是 `pluginInventory/list`） —— */
    pluginInventory: {
      list: function (p, s) { return unary('pluginInventory.list', p, s) },
    },

    /* —— 插件自身端点（同样走统一信封，便于复用同一套错误处理） —— */
    workbench: {
      status: function (p, s) { return unary('workbench.status', p, s) },
      visits: function (p, s) { return unary('workbench.visits', p, s) },
    },
  }

  /**
   * 把宿主错误码翻译成页面能直接显示的中文原因。
   *
   * 页面**不做业务判断**，只做「错误码 → 人话」的措辞映射：原因、细节、
   * 建议全部来自宿主返回的 `code` / `message` / `details`，不编造。
   *
   * @param error - `{ code, message, details }`。
   * @returns 面向使用者的说明字符串。
   */
  function describeError(error) {
    if (error === null || typeof error !== 'object') return String(error)
    var code = String(error.code || '')
    var detail = String(error.message || '')
    switch (code) {
      case 'directory-picker/unavailable':
        return '本机目录枚举不可用（宿主组合的是原生选择器，未装 browse 能力）'
      case 'gateway/invocation-unavailable':
        return '宿主未导出该端点' + (detail ? '：' + detail : '')
      case 'gateway/input-invalid':
        return '参数形状不被宿主接受' + (detail ? '：' + detail : '')
      case 'gateway/arguments-invalid':
        return '参数名与宿主描述符不一致' + (detail ? '：' + detail : '')
      case 'gateway/signature-invalid':
        return '该端点必须走流式通道' + (detail ? '：' + detail : '')
      case 'gateway/internal':
        if (/session search is disabled/i.test(detail)) return '宿主未启用会话检索（session-query 索引配置为 openAt "never"）'
        return '宿主内部错误' + (detail ? '：' + detail : '')
      case 'session/not-found':
        return '该事项编号在宿主上不存在（可能已被删除或归档）'
      case 'agent-preset/locked':
        return '该事项已开始办理，不能再更换办理模式'
      default:
        return detail || code || '未知错误'
    }
  }

  api.describeError = describeError

  global.GovApi = api
})(window)
