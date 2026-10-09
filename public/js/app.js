/* ====================================================================
 * app.js —— 页面编排：接线、事件流、各栏目渲染调度
 *
 * 所有数据都来自宿主（四象限 RPC + SSE），页面不做任何业务硬编码：
 * 工作目录来自 directoryPicker、权限来自 permissionPresets.catalog、
 * 模式来自 agentPresets.list、模型来自 session.modelCatalog、
 * 统计来自 sessionStats / tokenUsage 投影。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil
  var api = global.GovApi
  var panels = global.GovPanels
  var el = util.el

  var store = global.GovStore.createStore()
  var runtime = global.GovStore.createRuntime()

  /** 回执条目的 key 生成器（同一会话同一轮内稳定）。 */
  var receiptSeq = 0
  /** 回执索引：key → 条目对象。 */
  var receiptIndex = new Map()
  /** 当前正在流式累积的条目 key。 */
  var liveTextKey = ''
  var liveThinkKey = ''
  /** 工具调用 callId → 回执 key。 */
  var toolKeys = new Map()

  var marquee = null
  var floats = []
  var streamController = null
  var clockTimer = 0

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  function boot() {
    bindChrome()
    applyPreferences()
    startClock()
    void loadStatus()
    void loadDirectory()
    void loadPermissions()
    void loadPresets()
    void loadModels()
    void loadSessions()
    void loadSettings()
    openEventStream()
    startFloats()
  }

  /** 顶部工具条：设为首页 / 加入收藏 / 无障碍浏览。 */
  function bindChrome() {
    util.$('gov-set-home').addEventListener('click', function (event) {
      event.preventDefault()
      try {
        global.localStorage.setItem('dsh.govWorkbench.home', '1')
        global.alert('已记录本页为工作台首页（浏览器安全策略不允许脚本直接修改主页设置）。')
      } catch (error) {
        global.alert('浏览器拒绝了本次操作：' + error.message)
      }
    })
    util.$('gov-add-fav').addEventListener('click', function (event) {
      event.preventDefault()
      global.alert('请按 Ctrl+D 将本页加入收藏夹。')
    })
    var a11y = util.$('gov-a11y')
    a11y.addEventListener('click', function (event) {
      event.preventDefault()
      var large = !store.get('largeFont')
      store.set('largeFont', large)
      document.body.classList.toggle('gov-large', large)
      var contrast = !store.get('highContrast')
      store.set('highContrast', contrast)
      document.body.classList.toggle('gov-contrast', contrast)
    })
    // 主导航
    util.qsa('.gov-nav-item').forEach(function (button) {
      button.addEventListener('click', function () {
        showPage(button.dataset.page)
      })
    })
    // 查询框：回车即在本页卷宗里检索
    var query = util.$('gov-query')
    var doQuery = function () {
      var text = query.value.trim()
      if (text === '') return
      store.set('page', 'archive')
      showPage('archive')
      util.$('gov-archive-query').value = text
      void searchArchive(text)
    }
    util.$('gov-query-btn').addEventListener('click', doQuery)
    query.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') doQuery()
    })
    // 无障碍跳转锚点
    util.$('gov-skip').addEventListener('click', function (event) {
      event.preventDefault()
      var target = util.$('gov-main')
      if (target) target.focus()
    })
    // 首页「常用通道」里的栏目跳转按钮
    util.qsa('[data-page-link]').forEach(function (button) {
      button.addEventListener('click', function () {
        showPage(button.dataset.pageLink)
      })
    })
  }

  /** 应用 UI 偏好到 DOM。 */
  function applyPreferences() {
    document.body.classList.toggle('gov-large', store.get('largeFont') === true)
    document.body.classList.toggle('gov-contrast', store.get('highContrast') === true)
    showPage(store.get('page') || 'home')
  }

  /** 实时日期时间（精确到秒）。 */
  function startClock() {
    var node = util.$('gov-clock')
    var tick = function () {
      var now = new Date()
      node.textContent = util.formatDateTime(now) + ' ' + util.WEEKDAYS[now.getDay()]
    }
    tick()
    clockTimer = global.setInterval(tick, 1000)
  }

  /** 切换栏目。 */
  function showPage(page) {
    var name = page || 'home'
    util.qsa('.gov-page').forEach(function (section) {
      section.classList.toggle('is-active', section.dataset.page === name)
    })
    util.qsa('.gov-nav-item').forEach(function (button) {
      var active = button.dataset.page === name
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-current', active ? 'page' : 'false')
    })
    store.set('page', name)
    if (name === 'archive') void loadSessions()
    if (name === 'settings') void loadSettings()
  }

  /* ------------------------------------------------------------------ */
  /* 插件运行信息与访问计数                                               */
  /* ------------------------------------------------------------------ */

  async function loadStatus() {
    var result = await api.workbench.status()
    if (!result.ok) {
      setHostState('fail', '宿主状态读取失败')
      runtime.lastError = result.error.message
      return
    }
    var value = result.value || {}
    runtime.hostKind = value.host
    runtime.startedAt = Date.parse(value.startedAt || '') || 0
    runtime.marquee = Array.isArray(value.marquee) ? value.marquee : []
    setHostState(value.hostAvailable ? 'ok' : 'fail', value.hostAvailable
      ? '系统状态: 正常运行'
      : '系统状态: 网关未接入')
    util.$('gov-host-kind').textContent = panels.describeBridge(value.host)
    if (value.sealOnComplete === false) store.set('sealOnComplete', false)
    if (value.floatEnabled === false) store.set('floatEnabled', false)
    // 跑马灯
    var view = util.$('gov-marquee-view')
    if (marquee === null) marquee = global.GovMarquee.createMarquee(view, runtime.marquee)
    else marquee.setLines(runtime.marquee)
    await bumpVisits()
  }

  /** 访问次数：服务端持久化，6 位补零。 */
  async function bumpVisits() {
    var result = await api.workbench.visits()
    if (!result.ok) return
    runtime.visits = Number(result.value && result.value.visits) || 0
    util.$('gov-visits').textContent = '本站已被访问：' + util.pad6(runtime.visits) + ' 次'
  }

  /** 顶部绿色状态圆点。 */
  function setHostState(kind, text) {
    var dot = util.$('gov-dot')
    dot.classList.remove('is-down', 'is-warn')
    if (kind === 'fail') dot.classList.add('is-down')
    else if (kind === 'warn') dot.classList.add('is-warn')
    util.$('gov-host-state').textContent = text
  }

  /* ------------------------------------------------------------------ */
  /* 参数行：工作目录                                                    */
  /* ------------------------------------------------------------------ */

  async function loadDirectory(path) {
    var select = util.$('gov-cwd')
    var target = typeof path === 'string' && path !== '' ? path : (store.get('workspace') || '')
    var payload = target === '' ? {} : { path: target }
    var result = await api.directoryPicker.list(payload)
    if (!result.ok) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（工作目录枚举失败）' }))
      select.disabled = true
      util.$('gov-cwd-hint').textContent = '目录枚举失败：' + result.error.message
      return
    }
    var value = result.value || {}
    var options = []
    if (typeof value.path === 'string') options.push({ value: value.path, label: '（当前）' + value.path })
    ;(value.entries || []).forEach(function (entry) {
      options.push({ value: entry.path, label: entry.name + (entry.hidden ? '（隐藏）' : ''), title: entry.path })
    })
    if (typeof value.home === 'string' && value.home !== '' && options.length === 0) {
      options.push({ value: value.home, label: value.home })
    }
    var current = typeof value.path === 'string' ? value.path : target
    panels.fillSelect(select, options, current, '（无子目录）')
    if (!select.disabled && select.value !== current) {
      // 让「当前目录」始终是默认项
      select.value = options.length > 0 ? options[0].value : ''
    }
    store.set('workspace', select.value)
    var crumbs = (value.crumbs || []).map(function (crumb) { return crumb.name })
    util.$('gov-cwd-hint').textContent = '当前：' + (value.path || '—') +
      (crumbs.length > 0 ? '（' + crumbs.join(' / ') + '）' : '') +
      (value.truncated ? ' · 已截断' : '')
  }

  /* ------------------------------------------------------------------ */
  /* 参数行：权限（动态取自 permissionPresets.catalog）                   */
  /* ------------------------------------------------------------------ */

  async function loadPermissions() {
    var select = util.$('gov-permission')
    var result = await api.permission.catalog()
    if (!result.ok) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（权限目录不可用）' }))
      select.disabled = true
      util.$('gov-permission-hint').textContent = '权限目录读取失败：' + result.error.message
      return
    }
    var value = result.value || {}
    runtime.permissionOptions = Array.isArray(value.options) ? value.options : []
    runtime.permissionDefault = typeof value.defaultPreset === 'string' ? value.defaultPreset : ''
    var options = runtime.permissionOptions.map(function (option) {
      return { value: option.value, label: option.name || option.value, title: option.description || '' }
    })
    panels.fillSelect(select, options, store.get('permission') || runtime.permissionDefault, '（无可用档位）')
    store.set('permission', select.value)
    var picked = runtime.permissionOptions.filter(function (option) { return option.value === select.value })[0]
    util.$('gov-permission-hint').textContent = picked && picked.description
      ? picked.description
      : '默认档位：' + (runtime.permissionDefault || '—')
  }

  /* ------------------------------------------------------------------ */
  /* 参数行：模式（agentPresets.list）                                    */
  /* ------------------------------------------------------------------ */

  async function loadPresets() {
    var select = util.$('gov-preset')
    var result = await api.agentPresets.list()
    if (!result.ok) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（模式列表不可用）' }))
      select.disabled = true
      util.$('gov-preset-hint').textContent = '模式列表读取失败：' + result.error.message
      return
    }
    var value = result.value || {}
    runtime.presets = Array.isArray(value.presets) ? value.presets : []
    var options = runtime.presets.map(function (preset) {
      var label = preset.name || preset.id
      if (preset.isDefault) label += '（默认）'
      if (preset.broken) label += '（不可用）'
      return { value: preset.id, label: label, title: preset.description || preset.id }
    })
    var fallback = options.filter(function (option) { return option.value === runtime.presets.filter(function (p) { return p.isDefault })[0]?.id })[0]
    panels.fillSelect(select, options, store.get('preset') || (fallback ? fallback.value : ''), '（无可用模式）')
    store.set('preset', select.value)
    var picked = runtime.presets.filter(function (preset) { return preset.id === select.value })[0]
    util.$('gov-preset-hint').textContent = picked && picked.description ? picked.description : '办理模式决定可用工具集。'
  }

  /* ------------------------------------------------------------------ */
  /* 参数行：模型（session.modelCatalog，按 provider 分组）               */
  /* ------------------------------------------------------------------ */

  async function loadModels() {
    var select = util.$('gov-model')
    var result = await api.sessions.modelCatalog()
    if (!result.ok) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（模型目录不可用）' }))
      select.disabled = true
      util.$('gov-model-hint').textContent = '模型目录读取失败：' + result.error.message
      refreshEfforts()
      return
    }
    var value = result.value || {}
    runtime.modelDefault = value.default || null
    runtime.modelGroups = panels.modelOptionsFromCatalog(value)
    var currentKey = store.get('provider') && store.get('model')
      ? store.get('provider') + '\u0001' + store.get('model')
      : (runtime.modelDefault ? runtime.modelDefault.provider + '\u0001' + runtime.modelDefault.model : '')
    panels.fillModelSelect(select, runtime.modelGroups, currentKey)
    syncModelSelection()
    var failures = Array.isArray(value.failures) ? value.failures : []
    util.$('gov-model-hint').textContent = failures.length > 0
      ? '有 ' + String(failures.length) + ' 个 provider 不可用：' + failures.map(function (failure) { return failure.name + '（' + failure.message + '）' }).join('；')
      : '模型目录取自宿主已注册的适配器。'
  }

  /** 从模型下拉的当前值同步 provider/model，并刷新推理强度。 */
  function syncModelSelection() {
    var select = util.$('gov-model')
    var raw = select.value || ''
    var at = raw.indexOf('\u0001')
    if (at === -1) {
      store.set('provider', '')
      store.set('model', '')
      refreshEfforts()
      return
    }
    store.set('provider', raw.slice(0, at))
    store.set('model', raw.slice(at + 1))
    refreshEfforts()
  }

  /** 推理强度随模型动态刷新。 */
  function refreshEfforts() {
    var select = util.$('gov-effort')
    var hint = util.$('gov-effort-hint')
    var provider = store.get('provider')
    var model = store.get('model')
    if (!provider || !model) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（该模型无推理强度）' }))
      select.disabled = true
      hint.textContent = '推理强度随所选模型动态提供。'
      store.set('reasoningEffort', '')
      return
    }
    var info = panels.effortsForModel(runtime.modelGroups, provider + '\u0001' + model)
    if (info.efforts.length === 0) {
      util.clear(select)
      select.appendChild(el('option', { value: '', text: '（该模型无推理强度）' }))
      select.disabled = true
      hint.textContent = '当前模型未声明推理强度选项。'
      store.set('reasoningEffort', '')
      return
    }
    panels.fillSelect(select, info.efforts, store.get('reasoningEffort') || info.defaultEffort, '（默认）')
    store.set('reasoningEffort', select.value)
    hint.textContent = '默认强度：' + (info.defaultEffort || '未声明')
  }

  /* ------------------------------------------------------------------ */
  /* 事件流                                                             */
  /* ------------------------------------------------------------------ */

  function openEventStream() {
    if (streamController !== null) streamController.abort()
    streamController = new AbortController()
    runtime.streamOpen = false
    api.openStream('events.mux', handleFrame, {
      signal: streamController.signal,
      onOpen: function () {
        runtime.streamOpen = true
        setHostState('ok', '系统状态: 正常运行')
      },
      onError: function (error) {
        runtime.streamOpen = false
        setHostState('warn', '系统状态: 事件流中断，正在重连')
        runtime.lastError = String(error && error.message ? error.message : error)
        global.setTimeout(openEventStream, 3000)
      },
      onClose: function () {
        runtime.streamOpen = false
        if (!streamController.signal.aborted) global.setTimeout(openEventStream, 3000)
      },
    })
  }

  /** 处理一条 MuxFrame。 */
  function handleFrame(frame) {
    var payload = frame.payload
    if (payload === null || typeof payload !== 'object') return
    switch (payload.type) {
      case 'session/event':
        handleSessionEvent(payload.sessionId, payload.event)
        break
      case 'session/projection':
        handleProjection(payload)
        break
      case 'session/subscribed':
        break
      case 'session/disposed':
        if (payload.sessionId === store.get('sessionId')) markRunning(false)
        break
      case 'approval/requested':
        showApprovalModal(payload)
        break
      case 'approval/resolved':
        closeModal()
        break
      case 'question/requested':
        showQuestionModal(payload)
        break
      case 'question/resolved':
        closeModal()
        break
      case 'stream/error':
        appendReceipt('error', '事件流异常：' + util.toText(payload.error), { title: 'stream' })
        break
      default:
        break
    }
  }

  /** 处理一条会话事件。 */
  function handleSessionEvent(sessionId, event) {
    if (event === null || typeof event !== 'object') return
    var type = event.type
    var data = event.data || {}

    // 轨迹：所有事件都进轨迹表
    runtime.trace.push({
      seq: typeof event.seq === 'number' ? event.seq : runtime.trace.length,
      time: typeof event.time === 'number' ? event.time : Date.now(),
      type: type,
      sessionId: sessionId,
      summary: panels.summarizeEvent(type, data),
    })
    if (runtime.trace.length > 4000) runtime.trace.splice(0, runtime.trace.length - 4000)
    scheduleTraceRender()

    // 只有当前会话的事件进回执
    if (sessionId !== store.get('sessionId')) return

    switch (type) {
      case 'turn/start':
        runtime.turn = Number(data.turn) || runtime.turn
        markRunning(true)
        break
      case 'step/start':
        runtime.step = Number(data.step) || runtime.step
        break
      case 'assistant/chunk':
        handleChunk(data)
        break
      case 'assistant/message':
        handleAssistantMessage(data)
        break
      case 'tool/call':
        handleToolCall(data)
        break
      case 'tool/result':
        handleToolResult(data)
        break
      case 'todo/write':
        runtime.todos = Array.isArray(data.todos) ? data.todos : []
        renderTodos()
        break
      case 'turn/end':
        markRunning(false)
        finalizeLive()
        if (store.get('sealOnComplete') !== false) stampSeal()
        break
      case 'session/title':
        if (typeof data.title === 'string') runtime.sessionTitle = data.title
        break
      case 'approval/asked':
        appendReceipt('trace', '发起审批：' + util.toText(data), { title: type })
        break
      case 'approval/decided':
        appendReceipt('trace', '审批结果：' + util.toText(data.outcome), { title: type })
        break
      default:
        break
    }
    renderStats()
  }

  /** assistant/chunk：区分思考流与正文流。 */
  function handleChunk(data) {
    var chunk = data.chunk
    if (chunk === null || typeof chunk !== 'object') {
      var rawText = panels.chunkText(chunk)
      if (rawText) appendLiveText(rawText)
      return
    }
    if (chunk.type === 'block-start') {
      // 新块开始：闭合上一块
      finalizeLive()
      var blockType = chunk.block && chunk.block.type
      if (blockType === 'thinking') liveThinkKey = ''
      else liveTextKey = ''
      return
    }
    if (chunk.type === 'block-end') {
      finalizeLive()
      return
    }
    var text = panels.chunkText(chunk)
    if (!text) return
    runtime.chunks += 1
    if (runtime.firstTokenAt === 0) runtime.firstTokenAt = Date.now()
    var isThinking = Boolean(chunk.thinking !== undefined || (chunk.block && chunk.block.type === 'thinking'))
    if (isThinking) appendLiveThink(text)
    else appendLiveText(text)
  }

  /** assistant/message：一轮成文，替换掉流式累积。 */
  function handleAssistantMessage(data) {
    finalizeLive()
    var text = panels.messageText(data.message)
    var usage = data.usage
    if (usage !== null && typeof usage === 'object') {
      runtime.usage.inputTokens = Number(usage.inputTokens) || runtime.usage.inputTokens
      runtime.usage.outputTokens = Number(usage.outputTokens) || runtime.usage.outputTokens
      runtime.usage.cacheReadTokens = Number(usage.cacheReadTokens) || 0
      runtime.usage.cacheWriteTokens = Number(usage.cacheWriteTokens) || 0
    }
    if (text) {
      appendReceipt('text', text, {
        title: '第 ' + String(data.turn ?? runtime.turn) + ' 轮 · 第 ' + String(data.step ?? runtime.step) + ' 步',
        note: usage && usage.outputTokens ? '输出 ' + util.formatInt(usage.outputTokens) + ' token' : '',
      })
      runtime.textChars = 0
    }
    renderStats()
  }

  /** tool/call。 */
  function handleToolCall(data) {
    finalizeLive()
    var callId = String(data.callId || util.uuid())
    var key = 'tool-' + callId
    toolKeys.set(callId, key)
    appendReceipt('tool', util.toText(data.args), {
      key: key,
      title: String(data.tool || '未命名工具'),
      note: '调用中',
      mono: true,
    })
  }

  /** tool/result。 */
  function handleToolResult(data) {
    var callId = String(data.callId || '')
    var key = toolKeys.get(callId)
    var text = util.toText(data.result ?? data.output ?? data)
    if (key !== undefined && receiptIndex.has(key)) {
      var entry = receiptIndex.get(key)
      entry.text = entry.text + '\n\n── 结果 ──\n' + text
      entry.note = data.isError ? '失败' : '完成'
      entry.kind = data.isError ? 'error' : 'result'
      scheduleTranscriptRender()
      return
    }
    appendReceipt('result', text, { title: '工具结果', note: callId ? util.shortId(callId, 8, 4) : '', mono: true })
  }

  /* ------------------------------------------------------------------ */
  /* 回执窗口                                                           */
  /* ------------------------------------------------------------------ */

  /** 追加一条回执。 */
  function appendReceipt(kind, text, options) {
    var opts = options || {}
    var key = opts.key || ('r-' + String(receiptSeq++))
    if (receiptIndex.has(key)) {
      var existing = receiptIndex.get(key)
      existing.text = text
      existing.note = opts.note === undefined ? existing.note : opts.note
      existing.kind = kind
    } else {
      receiptIndex.set(key, {
        key: key,
        kind: kind,
        title: opts.title || '',
        note: opts.note || '',
        time: Date.now(),
        text: text,
        mono: opts.mono === true,
      })
    }
    scheduleTranscriptRender()
    return key
  }

  /** 流式正文累积。 */
  function appendLiveText(text) {
    if (liveTextKey === '') {
      liveTextKey = 'live-text-' + String(receiptSeq++)
      receiptIndex.set(liveTextKey, {
        key: liveTextKey,
        kind: 'text',
        title: '办理回复',
        note: '生成中',
        time: Date.now(),
        text: '',
        mono: false,
      })
    }
    var entry = receiptIndex.get(liveTextKey)
    entry.text += text
    runtime.textChars += text.length
    scheduleTranscriptRender()
  }

  /** 流式思考累积。 */
  function appendLiveThink(text) {
    if (liveThinkKey === '') {
      liveThinkKey = 'live-think-' + String(receiptSeq++)
      receiptIndex.set(liveThinkKey, {
        key: liveThinkKey,
        kind: 'think',
        title: '推理过程',
        note: '生成中',
        time: Date.now(),
        text: '',
        mono: false,
      })
    }
    var entry = receiptIndex.get(liveThinkKey)
    entry.text += text
    scheduleTranscriptRender()
  }

  /** 闭合当前流式块（把 note 从「生成中」改掉）。 */
  function finalizeLive() {
    if (liveTextKey !== '') {
      var textEntry = receiptIndex.get(liveTextKey)
      if (textEntry !== undefined) textEntry.note = ''
      liveTextKey = ''
    }
    if (liveThinkKey !== '') {
      var thinkEntry = receiptIndex.get(liveThinkKey)
      if (thinkEntry !== undefined) thinkEntry.note = ''
      liveThinkKey = ''
    }
    scheduleTranscriptRender()
  }

  var scheduleTranscriptRender = util.throttleFrame(function () {
    panels.renderTranscript(util.$('gov-receipt'), Array.from(receiptIndex.values()))
  })

  var scheduleTraceRender = util.throttleFrame(function () {
    panels.renderTrace(
      util.$('gov-trace-body'),
      runtime.trace,
      util.$('gov-trace-filter').value.trim(),
      400,
    )
    if (store.get('autoScrollTrace') !== false) {
      var wrap = util.$('gov-trace-scroll')
      wrap.scrollTop = wrap.scrollHeight
    }
    util.$('gov-trace-count').textContent = String(runtime.trace.length)
  })

  function renderStats() {
    panels.renderStats(util.$('gov-stats'), runtime)
  }

  function renderTodos() {
    panels.renderTodos(util.$('gov-todos'), runtime.todos)
  }

  /** 办理状态与按钮可用性。 */
  function markRunning(running) {
    runtime.running = running
    var submit = util.$('gov-submit')
    var cancel = util.$('gov-cancel')
    submit.disabled = running
    cancel.disabled = !running
    submit.textContent = running ? '办理中…' : '提交申办'
    var state = util.$('gov-run-state')
    state.className = 'gov-state ' + (running ? 'is-busy' : 'is-ok')
    state.textContent = running ? '办理中' : '空闲'
  }

  /* ------------------------------------------------------------------ */
  /* 提交申办                                                           */
  /* ------------------------------------------------------------------ */

  async function submitPrompt() {
    var input = util.$('gov-prompt')
    var text = input.value.trim()
    if (text === '') {
      global.alert('请先填写申办内容。')
      return
    }
    var sessionId = store.get('sessionId')
    if (!sessionId) {
      var created = await api.sessions.create({
        ...(store.get('workspace') ? { cwd: store.get('workspace') } : {}),
        ...(store.get('preset') ? { agentPreset: store.get('preset') } : {}),
      })
      if (!created.ok) {
        appendReceipt('error', '受理失败：' + created.error.message, { title: 'session.create' })
        return
      }
      sessionId = created.value && created.value.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        appendReceipt('error', '受理失败：宿主未返回会话编号。', { title: 'session.create' })
        return
      }
      store.set('sessionId', sessionId)
      runtime.todos = []
      renderTodos()
      void refreshTicket()
    }

    // 权限档位：0.2.0-rc.2 的 Remote 面只暴露 permissionPresets.catalog，
    // 写入走 settings 的 permission.defaultPreset（与官方 UI 同路）。
    if (store.get('permission') && store.get('permission') !== runtime.permissionDefault) {
      var applied = await api.settings.update('permission', { defaultPreset: store.get('permission') })
      if (!applied.ok) {
        appendReceipt('trace', '权限档位写入失败：' + applied.error.message, { title: 'settings.update' })
      } else {
        runtime.permissionDefault = store.get('permission')
      }
    }

    // 模型选择（会话级）
    if (store.get('provider') && store.get('model')) {
      var selected = await api.sessions.selectModel({
        sessionId: sessionId,
        provider: store.get('provider'),
        model: store.get('model'),
        ...(store.get('reasoningEffort') ? { reasoningEffort: store.get('reasoningEffort') } : {}),
      })
      if (!selected.ok) {
        appendReceipt('trace', '模型切换失败：' + selected.error.message, { title: 'session.selectModel' })
      }
    }

    appendReceipt('user', text, { title: '申办内容' })
    runtime.firstTokenAt = 0
    runtime.chunks = 0
    runtime.textChars = 0
    input.value = ''
    markRunning(true)

    var result = await api.sessions.prompt({
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    if (!result.ok) {
      markRunning(false)
      appendReceipt('error', '提交失败：' + result.error.message, { title: 'session.prompt' })
      return
    }
    if (result.value && result.value.command && result.value.command.text) {
      appendReceipt('trace', result.value.command.text, { title: '命令回执' })
    }
  }

  /** 取消当前办理。 */
  async function cancelPrompt() {
    var sessionId = store.get('sessionId')
    if (!sessionId) return
    var result = await api.sessions.cancel({ sessionId: sessionId })
    if (!result.ok) {
      appendReceipt('error', '取消失败：' + result.error.message, { title: 'session.cancel' })
      return
    }
    appendReceipt('trace', '已提交取消请求。', { title: 'session.cancel' })
  }

  /** 刷新事项编号条。 */
  async function refreshTicket() {
    var sessionId = store.get('sessionId')
    var info = {
      sessionId: sessionId,
      preset: store.get('preset'),
      running: runtime.running,
      cwd: store.get('workspace'),
      bridgeKind: runtime.hostKind,
      createdAt: 0,
    }
    if (sessionId) {
      var listed = await api.sessions.list({})
      if (listed.ok && listed.value && Array.isArray(listed.value.items)) {
        var found = listed.value.items.filter(function (item) { return item.sessionId === sessionId })[0]
        if (found !== undefined) {
          info.running = found.running
          info.createdAt = found.updatedAt
          info.cwd = found.cwd || info.cwd
          if (found.projections && found.projections.values) {
            info.preset = found.projections.values.agentPreset || info.preset
          }
        }
      }
    }
    panels.renderTicket(util.$('gov-ticket'), info)
    // 事项办理页顶部有同一份编号条，两处保持一致。
    panels.renderTicket(util.$('gov-ticket-2'), info)
    markRunning(info.running)
  }

  /* ------------------------------------------------------------------ */
  /* 卷宗档案                                                           */
  /* ------------------------------------------------------------------ */

  async function loadSessions() {
    var result = await api.sessions.list({})
    if (!result.ok) {
      runtime.archive.items = []
      renderArchive()
      util.$('gov-archive-hint').textContent = '卷宗列表读取失败：' + result.error.message
      return
    }
    var value = result.value || {}
    runtime.archive.items = Array.isArray(value.items) ? value.items : []
    runtime.archive.query = ''
    runtime.archive.page = 1
    renderArchive()
    util.$('gov-archive-hint').textContent = '共 ' + String(runtime.archive.items.length) + ' 份卷宗（宿主上限内）。'
  }

  async function searchArchive(query) {
    if (query === '') {
      await loadSessions()
      return
    }
    var result = await api.sessions.search({ query: query })
    if (!result.ok) {
      util.$('gov-archive-hint').textContent = '检索失败：' + result.error.message
      return
    }
    var value = result.value || {}
    var hits = Array.isArray(value.items) ? value.items : []
    var byId = {}
    runtime.archive.items.forEach(function (item) { byId[item.sessionId] = item })
    runtime.archive.items = hits.map(function (hit) {
      var known = byId[hit.sessionId]
      return known !== undefined ? { ...known, snippet: hit.snippet } : { sessionId: hit.sessionId, updatedAt: 0, running: false, snippet: hit.snippet }
    })
    runtime.archive.query = query
    runtime.archive.page = 1
    renderArchive()
    util.$('gov-archive-hint').textContent = '检索「' + query + '」命中 ' + String(hits.length) + ' 份卷宗' + (value.hasMore ? '（还有更多）' : '') + '。'
  }

  function renderArchive() {
    var archive = runtime.archive
    var start = (archive.page - 1) * archive.pageSize
    var page = {
      items: archive.items.slice(start, start + archive.pageSize),
      query: archive.query,
    }
    panels.renderArchive(util.$('gov-archive-body'), page, {
      onOpen: function (item) {
        store.set('sessionId', item.sessionId)
        showPage('home')
        void refreshTicket()
        void loadHistory(item.sessionId)
      },
      onExport: function (item) {
        api.exportSessionLog(item.sessionId)
      },
    })
    var totalPages = Math.max(1, Math.ceil(archive.items.length / archive.pageSize))
    util.$('gov-archive-page').textContent = '第 ' + String(archive.page) + ' / ' + String(totalPages) + ' 页'
    util.$('gov-archive-prev').disabled = archive.page <= 1
    util.$('gov-archive-next').disabled = archive.page >= totalPages
  }

  /** 把历史回执灌进回执窗口。 */
  async function loadHistory(sessionId) {
    var listed = await api.sessions.list({})
    var cursor = -1
    if (listed.ok && listed.value && Array.isArray(listed.value.items)) {
      var found = listed.value.items.filter(function (item) { return item.sessionId === sessionId })[0]
      if (found !== undefined) cursor = 0
    }
    if (cursor === -1) {
      appendReceipt('trace', '该卷宗不在宿主的活动列表内，仅能通过「导出」查看完整流水。', { title: '卷宗' })
      return
    }
    var result = await api.sessions.page({
      address: { kind: 'session', sessionId: sessionId },
      throughSeq: -1,
      maxMessages: 40,
    })
    if (!result.ok) {
      appendReceipt('error', '历史读取失败：' + result.error.message, { title: 'session.page' })
      return
    }
    var value = result.value || {}
    var records = Array.isArray(value.records) ? value.records : []
    // 清掉旧回执，重放历史
    receiptIndex.clear()
    receiptSeq = 0
    liveTextKey = ''
    liveThinkKey = ''
    records.forEach(function (record) {
      var event = record.event
      if (event === null || typeof event !== 'object') return
      if (event.type === 'user/message') {
        appendReceipt('user', panels.messageText(event.data && event.data.message), { title: '申办内容' })
      } else if (event.type === 'assistant/message') {
        appendReceipt('text', panels.messageText(event.data && event.data.message), { title: '办理回复' })
      } else if (event.type === 'tool/call') {
        appendReceipt('tool', util.toText(event.data && event.data.args), {
          key: 'tool-' + String(event.data && event.data.callId),
          title: String((event.data && event.data.tool) || '工具'),
          note: '历史',
          mono: true,
        })
      } else if (event.type === 'tool/result') {
        var callId = String((event.data && event.data.callId) || '')
        var key = toolKeys.get(callId) || ('tool-' + callId)
        appendReceipt('result', util.toText(event.data && (event.data.result ?? event.data)), { key: key, title: '工具结果', note: '历史', mono: true })
      }
    })
    if (records.length === 0) {
      appendReceipt('trace', '该卷宗暂无消息记录。', { title: '卷宗' })
    }
  }

  /* ------------------------------------------------------------------ */
  /* 系统配置                                                           */
  /* ------------------------------------------------------------------ */

  async function loadSettings() {
    var root = util.$('gov-settings-list')
    var result = await api.settings.describe()
    if (!result.ok) {
      util.clear(root)
      root.appendChild(el('div', { class: 'gov-hint is-error', text: '配置读取失败：' + result.error.message }))
      return
    }
    var value = result.value || {}
    runtime.settings = Array.isArray(value.namespaces) ? value.namespaces : []
    util.$('gov-settings-hint').textContent = '共 ' + String(runtime.settings.length) +
      ' 个命名空间；' + (value.writable ? '当前可写' : '当前只读') +
      (value.hasDocument ? '；配置文件已存在' : '；配置文件尚未创建') + '。'
    util.clear(root)
    runtime.settings.forEach(function (entry) {
      root.appendChild(panels.renderSettingsNamespace(entry, onSettingsChange))
    })
    if (runtime.settings.length === 0) {
      root.appendChild(el('div', { class: 'gov-hint', text: '宿主未暴露任何配置命名空间。' }))
    }
  }

  /** 提交一节配置。 */
  async function onSettingsChange(ns, patch, revision) {
    var result = await api.settings.update(ns, patch, revision)
    if (!result.ok) {
      util.$('gov-settings-hint').textContent = '提交「' + ns + '」失败：' + result.error.message
      global.alert('提交失败：' + result.error.message)
      return
    }
    util.$('gov-settings-hint').textContent = '「' + ns + '」已提交并生效。'
    await loadSettings()
  }

  /* ------------------------------------------------------------------ */
  /* 审批 / 提问弹窗                                                     */
  /* ------------------------------------------------------------------ */

  function modalRoot() {
    return util.$('gov-modal-root')
  }

  /** 关闭当前弹窗。 */
  function closeModal() {
    util.clear(modalRoot())
  }

  /** 建一个弹窗骨架。 */
  function buildModal(title, bodyNodes, actions) {
    closeModal()
    var mask = el('div', { class: 'gov-modal-mask', role: 'dialog', 'aria-modal': 'true' })
    var modal = el('div', { class: 'gov-modal' })
    var head = el('div', { class: 'gov-modal-head' })
    head.appendChild(el('span', { text: title }))
    head.appendChild(el('div', { class: 'gov-spacer' }))
    var close = el('button', { class: 'gov-float-close', type: 'button', text: '×', 'aria-label': '关闭', onclick: closeModal })
    head.appendChild(close)
    modal.appendChild(head)
    var body = el('div', { class: 'gov-modal-body' })
    bodyNodes.forEach(function (node) { body.appendChild(node) })
    modal.appendChild(body)
    var foot = el('div', { class: 'gov-modal-foot' })
    actions.forEach(function (action) { foot.appendChild(action) })
    modal.appendChild(foot)
    mask.appendChild(modal)
    modalRoot().appendChild(mask)
    return { mask: mask, modal: modal, body: body, foot: foot }
  }

  /** 审批弹窗：准予执行 / 不予批准。 */
  function showApprovalModal(frame) {
    var body = [
      el('div', { class: 'gov-hint is-warn', text: '办理过程请求执行一项需要批准的操作，请核阅后决定。' }),
      el('div', { class: 'gov-q' }, [
        el('div', { class: 'gov-q-title', text: '操作：' + String(frame.toolName || '未命名操作') }),
        frame.reason ? el('div', { class: 'gov-q-detail', text: String(frame.reason) }) : null,
        frame.callId ? el('div', { class: 'gov-q-detail', text: '调用编号：' + String(frame.callId) }) : null,
      ]),
    ].filter(Boolean)

    var allow = el('button', {
      class: 'gov-btn',
      type: 'button',
      text: '准予执行',
      onclick: function () {
        void api.respond(frame.approvalId, 'allowed-once')
        closeModal()
        appendReceipt('trace', '已批准：' + String(frame.toolName || ''), { title: '审批' })
      },
    })
    var deny = el('button', {
      class: 'gov-btn gov-btn-danger',
      type: 'button',
      text: '不予批准',
      onclick: function () {
        void api.respond(frame.approvalId, 'rejected')
        closeModal()
        appendReceipt('trace', '已驳回：' + String(frame.toolName || ''), { title: '审批' })
      },
    })
    buildModal('审批事项', body, [deny, allow])
  }

  /** 系统咨询弹窗：支持多选与自填。 */
  function showQuestionModal(frame) {
    var questions = Array.isArray(frame.questions) ? frame.questions : []
    var controls = []
    var body = [el('div', { class: 'gov-hint', text: '办理过程需要补充信息，请作答后提交。' })]
    questions.forEach(function (question) {
      var wrapper = el('div', { class: 'gov-q' })
      wrapper.appendChild(el('div', { class: 'gov-q-title', text: question.header ? question.header + '：' + question.question : question.question }))
      if (question.detail) wrapper.appendChild(el('div', { class: 'gov-q-detail', text: question.detail }))
      var inputs = []
      var multi = question.multiSelect === true
      ;(question.options || []).forEach(function (option) {
        var id = 'q-' + question.id + '-' + Math.random().toString(36).slice(2, 8)
        var input = el('input', { type: multi ? 'checkbox' : 'radio', name: 'q-' + question.id, id: id })
        input.value = option.label
        var label = el('label', { class: 'gov-q-option', for: id }, [
          input,
          el('span', {}, [
            el('span', { text: option.label }),
            option.description ? el('small', { text: option.description }) : null,
          ].filter(Boolean)),
        ])
        wrapper.appendChild(label)
        inputs.push(input)
      })
      var custom = el('input', { class: 'gov-q-custom', type: 'text', placeholder: '其他（可留空）' })
      wrapper.appendChild(custom)
      controls.push({ question: question, inputs: inputs, custom: custom, multi: multi })
      body.push(wrapper)
    })

    var submit = el('button', {
      class: 'gov-btn',
      type: 'button',
      text: '提交作答',
      onclick: function () {
        var answers = controls.map(function (control) {
          var selected = control.inputs.filter(function (input) { return input.checked }).map(function (input) { return input.value })
          var custom = control.custom.value.trim()
          return {
            id: control.question.id,
            selected: selected,
            ...(custom === '' ? {} : { custom: custom }),
          }
        })
        void api.respond(frame.questionRpcId, { answers: answers })
        closeModal()
        appendReceipt('trace', '已提交作答。', { title: '系统咨询' })
      },
    })
    var cancel = el('button', {
      class: 'gov-btn gov-btn-plain',
      type: 'button',
      text: '暂不作答',
      onclick: function () {
        void api.respond(frame.questionRpcId, undefined)
        closeModal()
      },
    })
    buildModal('系统咨询', body, [cancel, submit])
  }

  /* ------------------------------------------------------------------ */
  /* 办结盖章                                                           */
  /* ------------------------------------------------------------------ */

  function stampSeal() {
    var seal = util.$('gov-seal')
    seal.classList.remove('is-visible', 'is-stamping')
    // 强制重排以重启动画
    void seal.offsetWidth
    seal.classList.add('is-stamping')
    global.setTimeout(function () {
      seal.classList.remove('is-stamping')
      seal.classList.add('is-visible')
    }, 700)
    global.setTimeout(function () {
      seal.classList.remove('is-visible')
    }, 6000)
  }

  /* ------------------------------------------------------------------ */
  /* 飘窗                                                               */
  /* ------------------------------------------------------------------ */

  function startFloats() {
    if (store.get('floatEnabled') === false) return
    floats.forEach(function (item) { item.destroy() })
    floats = []
    var body = el('div')
    body.appendChild(el('div', { text: '本平台业务办理全程留痕。' }))
    body.appendChild(el('div', { text: '提交申办后，可在「运行轨迹」查看每一步。' }))
    body.appendChild(el('div', { text: '卷宗可在「卷宗档案」中导出 JSONL。' }))
    floats.push(global.GovFloat.createFloat({ title: '便民提示', body: body }))
  }

  /* ------------------------------------------------------------------ */
  /* 表单接线                                                           */
  /* ------------------------------------------------------------------ */

  function bindForm() {
    util.$('gov-cwd').addEventListener('change', function () {
      store.set('workspace', util.$('gov-cwd').value)
      void loadDirectory(util.$('gov-cwd').value)
    })
    util.$('gov-cwd-up').addEventListener('click', function () {
      var current = store.get('workspace') || ''
      if (current === '') return
      var parent = current.replace(/[/\\][^/\\]*$/, '')
      if (parent === '' || parent === current) return
      store.set('workspace', parent)
      void loadDirectory(parent)
    })
    util.$('gov-permission').addEventListener('change', function () {
      store.set('permission', util.$('gov-permission').value)
      void loadPermissions()
    })
    util.$('gov-preset').addEventListener('change', function () {
      store.set('preset', util.$('gov-preset').value)
    })
    util.$('gov-model').addEventListener('change', syncModelSelection)
    util.$('gov-effort').addEventListener('change', function () {
      store.set('reasoningEffort', util.$('gov-effort').value)
    })
    util.$('gov-submit').addEventListener('click', function () { void submitPrompt() })
    util.$('gov-cancel').addEventListener('click', function () { void cancelPrompt() })
    util.$('gov-prompt').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void submitPrompt()
      }
    })
    util.$('gov-refresh').addEventListener('click', function () {
      void loadStatus()
      void loadDirectory()
      void loadPermissions()
      void loadPresets()
      void loadModels()
      void refreshTicket()
    })
    // 轨迹
    util.$('gov-trace-filter').addEventListener('input', util.debounce(function () {
      scheduleTraceRender()
    }, 150))
    util.$('gov-trace-autoscroll').addEventListener('change', function () {
      store.set('autoScrollTrace', util.$('gov-trace-autoscroll').checked)
    })
    util.$('gov-trace-clear').addEventListener('click', function () {
      runtime.trace = []
      scheduleTraceRender()
    })
    // 卷宗
    util.$('gov-archive-query').addEventListener('input', util.debounce(function () {
      void searchArchive(util.$('gov-archive-query').value.trim())
    }, 320))
    util.$('gov-archive-prev').addEventListener('click', function () {
      runtime.archive.page = Math.max(1, runtime.archive.page - 1)
      renderArchive()
    })
    util.$('gov-archive-next').addEventListener('click', function () {
      runtime.archive.page += 1
      renderArchive()
    })
    util.$('gov-archive-reload').addEventListener('click', function () { void loadSessions() })
    // 配置
    util.$('gov-settings-reload').addEventListener('click', function () { void loadSettings() })
    // 印章开关
    util.$('gov-seal-toggle').addEventListener('change', function () {
      store.set('sealOnComplete', util.$('gov-seal-toggle').checked)
    })
    util.$('gov-seal-toggle').checked = store.get('sealOnComplete') !== false
    util.$('gov-trace-autoscroll').checked = store.get('autoScrollTrace') !== false
  }

  /* ------------------------------------------------------------------ */
  /* 收尾                                                               */
  /* ------------------------------------------------------------------ */

  global.addEventListener('beforeunload', function () {
    if (streamController !== null) streamController.abort()
    if (marquee !== null) marquee.destroy()
    if (clockTimer !== 0) global.clearInterval(clockTimer)
    floats.forEach(function (item) { item.destroy() })
  })

  bindForm()
  renderTodos()
  renderStats()
  panels.renderTranscript(util.$('gov-receipt'), [])
  panels.renderTrace(util.$('gov-trace-body'), [], '', 400)
  renderArchive()
  markRunning(false)
  refreshTicket()
  boot()
})(window)
