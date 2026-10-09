/* ====================================================================
 * panels.js —— 各栏目的渲染与动态表单
 *
 * 只做「把宿主给的数据画出来」，不含网络调用。所有字段名都取自宿主
 * 的真实投影与 Remote 结果（见 docs/harness-integration.md 对照表），
 * 这里不做任何字段名猜测。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil
  var el = util.el

  /* ------------------------------------------------------------------ */
  /* 事项编号条                                                          */
  /* ------------------------------------------------------------------ */

  /** 渲染事项编号条。 */
  function renderTicket(root, info) {
    util.clear(root)
    var fields = [
      ['事项编号', util.shortId(info.sessionId, 10, 6) || '未受理', true],
      ['办理模式', info.preset || '—', false],
      ['受理时间', info.createdAt ? util.formatStamp(info.createdAt) : util.formatDateTime(), false],
      ['办理状态', info.running ? '办理中' : (info.sessionId ? '已受理' : '待受理'), false],
      ['工作目录', info.cwd || '—', false],
    ]
    fields.forEach(function (entry) {
      var value = el('span', { class: 'gov-ticket-value' + (entry[2] ? ' is-strong' : ''), text: entry[1] })
      if (entry[0] === '事项编号' && info.sessionId) value.title = info.sessionId
      root.appendChild(el('span', { class: 'gov-ticket-label', text: entry[0] + '：' }))
      root.appendChild(value)
    })
    if (info.bridgeKind) {
      root.appendChild(el('span', { class: 'gov-ticket-label', text: '接入方式：' }))
      root.appendChild(el('span', { class: 'gov-ticket-value', text: describeBridge(info.bridgeKind) }))
    }
  }

  /** 宿主形态的中文说明。 */
  function describeBridge(kind) {
    if (kind === 'apiProxy') return '宿主网关直连（apiProxy）'
    if (kind === 'typertGateway') return '宿主网关直连（typertGateway）'
    if (kind === 'unavailable') return '未接入'
    return kind || '未知'
  }

  /* ------------------------------------------------------------------ */
  /* 交互回执窗口                                                        */
  /* ------------------------------------------------------------------ */

  /** 回执条目类型 → 中文标签与样式类。 */
  var KIND_META = {
    user: { label: '申办', cls: 'is-user' },
    text: { label: '回复', cls: 'is-text' },
    think: { label: '思考', cls: 'is-think' },
    tool: { label: '调用', cls: 'is-tool' },
    result: { label: '结果', cls: 'is-trace' },
    trace: { label: '轨迹', cls: 'is-trace' },
    todo: { label: '待办', cls: 'is-todo' },
    system: { label: '系统', cls: 'is-trace' },
    error: { label: '异常', cls: 'is-error' },
  }

  /** 建一个回执条目节点。 */
  function receiptNode(entry) {
    var meta = KIND_META[entry.kind] || KIND_META.trace
    var node = el('div', { class: 'receipt-item' })
    var head = el('div', { class: 'receipt-head' })
    head.appendChild(el('span', { class: 'receipt-kind ' + meta.cls, text: meta.label }))
    if (entry.title) head.appendChild(el('span', { class: 'receipt-meta', text: entry.title }))
    if (entry.time) head.appendChild(el('span', { class: 'receipt-meta', text: util.formatClock(entry.time) }))
    if (entry.note) head.appendChild(el('span', { class: 'receipt-meta', text: entry.note }))
    node.appendChild(head)
    var body = el('div', {
      class: 'receipt-body' + (entry.kind === 'think' ? ' is-think' : '') + (entry.mono ? ' is-mono' : ''),
    })
    body.textContent = entry.text === undefined || entry.text === '' ? '（空）' : entry.text
    node.appendChild(body)
    return node
  }

  /**
   * 渲染整条回执。
   * 采用「按 key 增量替换」而不是全量重建：流式输出时只有当前那条在变，
   * 全量重建会让滚动位置抖动，也会闪。
   */
  function renderTranscript(container, entries, options) {
    var opts = options || {}
    var empty = util.qs('.gov-receipt-empty', container)
    if (entries.length === 0) {
      if (!empty) {
        util.clear(container)
        container.appendChild(
          el('div', {
            class: 'gov-receipt-empty',
            text: '暂无办理回执。请在下方申报表单中填写事项内容并提交，办理过程将在此实时显示。',
          }),
        )
      }
      return
    }
    if (empty) empty.remove()

    var existing = {}
    util.qsa('.receipt-item', container).forEach(function (node) {
      existing[node.dataset.key] = node
    })

    var atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48
    entries.forEach(function (entry) {
      var node = existing[entry.key]
      if (node === undefined) {
        node = receiptNode(entry)
        node.dataset.key = entry.key
        container.appendChild(node)
      } else {
        // 内容变了才替换，避免无谓的 DOM 抖动。
        if (node.dataset.hash !== hashEntry(entry)) {
          var fresh = receiptNode(entry)
          fresh.dataset.key = entry.key
          container.replaceChild(fresh, node)
          node = fresh
        }
      }
      node.dataset.hash = hashEntry(entry)
      delete existing[entry.key]
    })

    Object.keys(existing).forEach(function (key) {
      if (existing[key].parentNode) existing[key].parentNode.removeChild(existing[key])
    })

    if (opts.autoScroll !== false && atBottom) container.scrollTop = container.scrollHeight
  }

  /** 条目的稳定指纹（用于判断是否需要重画）。 */
  function hashEntry(entry) {
    return [entry.kind, entry.title, entry.note, entry.time, (entry.text || '').length, entry.text].join('\u0001')
  }

  /* ------------------------------------------------------------------ */
  /* 统计行                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 渲染统计行。
   *
   * 数据来源（严格按宿主字段，不编造）：
   *   - `sessionStats` 投影：turns / steps / llmMs / toolMs / ttftMs /
   *     ttftSteps / decodeMs / decodeTokens
   *   - `tokenUsage` 投影：inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
   *   - 本地增量：本次连接收到的 chunk 数与文本字符数（用于字/秒）
   */
  function renderStats(root, runtime) {
    var stats = runtime.stats || {}
    var usage = runtime.usage || {}
    var decodeSeconds = Number(stats.decodeMs) > 0 ? Number(stats.decodeMs) / 1000 : 0
    var charsPerSecond = decodeSeconds > 0 && runtime.textChars > 0 ? runtime.textChars / decodeSeconds : 0
    var ttftAverage = Number(stats.ttftSteps) > 0 ? Number(stats.ttftMs) / Number(stats.ttftSteps) : 0
    var cacheTotal = Number(usage.cacheReadTokens || 0) + Number(usage.cacheWriteTokens || 0)
    var cacheHitRate = Number(usage.inputTokens) > 0 ? Number(usage.cacheReadTokens || 0) / Number(usage.inputTokens) : 0

    var cells = [
      ['轮次', util.formatInt(stats.turns), false],
      ['步数', util.formatInt(stats.steps), false],
      ['模型耗时', util.formatMs(stats.llmMs), true],
      ['工具耗时', util.formatMs(stats.toolMs), true],
      ['首 token', util.formatMs(ttftAverage), true],
      ['解码耗时', util.formatMs(stats.decodeMs), true],
      ['解码 token', util.formatInt(stats.decodeTokens), false],
      ['输出速度', charsPerSecond > 0 ? charsPerSecond.toFixed(1) + ' 字/秒' : '—', true],
      ['输入 token', util.formatInt(usage.inputTokens), false],
      ['输出 token', util.formatInt(usage.outputTokens), false],
      ['缓存命中', cacheTotal > 0 ? util.formatInt(usage.cacheReadTokens) + '（' + (cacheHitRate * 100).toFixed(1) + '%）' : '—', true],
      ['缓存写入', util.formatInt(usage.cacheWriteTokens), false],
    ]

    var signature = cells.map(function (cell) { return cell[0] + '=' + cell[1] }).join('|')
    if (root.dataset.signature === signature) return
    root.dataset.signature = signature
    util.clear(root)
    cells.forEach(function (cell) {
      root.appendChild(
        el('div', { class: 'gov-stat' }, [
          el('div', { class: 'gov-stat-label', text: cell[0] }),
          el('div', { class: 'gov-stat-value' + (cell[2] ? ' is-small' : ''), text: cell[1] }),
        ]),
      )
    })
  }

  /* ------------------------------------------------------------------ */
  /* 待办（todo/write）                                                  */
  /* ------------------------------------------------------------------ */

  /** 渲染待办清单。 */
  function renderTodos(root, todos) {
    util.clear(root)
    if (!todos || todos.length === 0) {
      root.appendChild(el('div', { class: 'gov-tips', text: '本次办理暂无待办事项。' }))
      return
    }
    var list = el('ul', { class: 'gov-list' })
    todos.forEach(function (todo) {
      var status = todo.status === 'completed' ? '已完成' : todo.status === 'in_progress' ? '办理中' : '待办理'
      var cls = todo.status === 'completed' ? 'is-ok' : todo.status === 'in_progress' ? 'is-busy' : 'is-wait'
      list.appendChild(
        el('li', {}, [
          el('span', { class: 'gov-state ' + cls, text: status }),
          el('span', { class: 'gov-text', text: todo.content || '' }),
        ]),
      )
    })
    root.appendChild(list)
  }

  /* ------------------------------------------------------------------ */
  /* 参数行下拉（全部动态枚举）                                           */
  /* ------------------------------------------------------------------ */

  /** 用选项数组重建一个 select，尽量保留当前选择。 */
  function fillSelect(select, options, current, placeholder) {
    util.clear(select)
    if (options.length === 0) {
      select.appendChild(el('option', { value: '', text: placeholder || '（无可用选项）' }))
      select.disabled = true
      return false
    }
    select.disabled = false
    options.forEach(function (option) {
      var node = el('option', { value: option.value, text: option.label })
      if (option.title) node.title = option.title
      select.appendChild(node)
    })
    var has = options.some(function (option) { return option.value === current })
    select.value = has ? current : options[0].value
    return true
  }

  /** 模型目录 → 按 provider 分组的 optgroup。 */
  function modelOptionsFromCatalog(catalog) {
    var groups = []
    ;(catalog && catalog.groups ? catalog.groups : []).forEach(function (group) {
      var models = (group.models || []).map(function (model) {
        return {
          value: group.id + '\u0001' + model.id,
          label: model.name || model.id,
          title: model.description || (group.name + ' / ' + model.id),
          model: model,
        }
      })
      if (models.length > 0) groups.push({ id: group.id, name: group.name || group.id, models: models })
    })
    return groups
  }

  /** 用分组填充模型 select。 */
  function fillModelSelect(select, groups, currentKey) {
    util.clear(select)
    if (groups.length === 0) {
      select.appendChild(el('option', { value: '', text: '（无可用模型）' }))
      select.disabled = true
      return false
    }
    select.disabled = false
    groups.forEach(function (group) {
      var optgroup = el('optgroup', { label: group.name })
      group.models.forEach(function (model) {
        optgroup.appendChild(el('option', { value: model.value, text: model.label, title: model.title }))
      })
      select.appendChild(optgroup)
    })
    var flat = []
    groups.forEach(function (group) { group.models.forEach(function (model) { flat.push(model.value) }) })
    select.value = flat.indexOf(currentKey) !== -1 ? currentKey : flat[0]
    return true
  }

  /** 取某个模型在目录里的推理强度选项。 */
  function effortsForModel(groups, modelKey) {
    for (var i = 0; i < groups.length; i += 1) {
      for (var j = 0; j < groups[i].models.length; j += 1) {
        var model = groups[i].models[j]
        if (model.value !== modelKey) continue
        var reasoning = model.model && model.model.reasoning
        if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return { efforts: [], defaultEffort: '' }
        return {
          efforts: reasoning.efforts.map(function (effort) {
            return { value: effort.id, label: effort.name || effort.id, title: effort.description || '' }
          }),
          defaultEffort: reasoning.defaultEffort || '',
        }
      }
    }
    return { efforts: [], defaultEffort: '' }
  }

  /* ------------------------------------------------------------------ */
  /* 卷宗档案                                                            */
  /* ------------------------------------------------------------------ */

  /** 渲染卷宗列表表格。 */
  function renderArchive(tbody, archive, handlers) {
    util.clear(tbody)
    if (archive.items.length === 0) {
      var row = el('tr')
      row.appendChild(el('td', { colspan: '6', text: archive.query ? '未检索到匹配的卷宗。' : '暂无卷宗档案。' }))
      tbody.appendChild(row)
      return
    }
    archive.items.forEach(function (item) {
      var title = ''
      var preset = ''
      if (item.projections && item.projections.values) {
        title = item.projections.values.title || ''
        preset = item.projections.values.agentPreset || ''
      }
      var tr = el('tr')
      tr.appendChild(el('td', { class: 'is-num', title: item.sessionId, text: util.shortId(item.sessionId, 12, 6) }))
      tr.appendChild(el('td', { class: 'gov-text', text: title || '（未命名）' }))
      tr.appendChild(el('td', { text: preset || '—' }))
      tr.appendChild(el('td', {
        text: item.running ? '办理中' : '已归档',
        class: item.running ? 'is-nowrap' : 'is-nowrap',
      }))
      tr.appendChild(el('td', { class: 'is-nowrap', text: util.formatAgo(item.updatedAt) }))
      var actions = el('td', { class: 'is-nowrap' })
      actions.appendChild(el('button', {
        class: 'gov-btn gov-btn-plain',
        type: 'button',
        text: '调阅',
        onclick: function () { handlers.onOpen(item) },
      }))
      actions.appendChild(document.createTextNode(' '))
      actions.appendChild(el('button', {
        class: 'gov-btn gov-btn-plain',
        type: 'button',
        text: '导出',
        onclick: function () { handlers.onExport(item) },
      }))
      tr.appendChild(actions)
      tbody.appendChild(tr)
    })
  }

  /* ------------------------------------------------------------------ */
  /* 运行轨迹                                                            */
  /* ------------------------------------------------------------------ */

  /** 轨迹行：类型 → 标签。 */
  function traceKindLabel(type) {
    if (type === 'assistant/chunk') return '流式'
    if (type === 'assistant/message') return '成文'
    if (type === 'tool/call') return '工具调用'
    if (type === 'tool/result') return '工具结果'
    if (type === 'step/start') return '步开始'
    if (type === 'step/end') return '步结束'
    if (type === 'turn/start') return '轮开始'
    if (type === 'turn/end') return '轮结束'
    if (type === 'todo/write') return '待办'
    if (type === 'user/message') return '申办'
    if (type === 'approval/asked') return '审批请求'
    if (type === 'approval/decided') return '审批结果'
    if (type === 'session/title') return '标题'
    if (type === 'permission/preset') return '权限'
    if (type === 'sandbox/mode') return '沙箱'
    return type
  }

  /** 渲染轨迹表（增量追加，最多保留 maxRows 行）。 */
  function renderTrace(tbody, trace, filter, maxRows) {
    var limit = maxRows || 400
    util.clear(tbody)
    var rows = trace
    if (filter) {
      rows = trace.filter(function (row) {
        return String(row.type || '').toLowerCase().indexOf(filter.toLowerCase()) !== -1
      })
    }
    var shown = rows.slice(Math.max(0, rows.length - limit))
    if (shown.length === 0) {
      var emptyRow = el('tr')
      emptyRow.appendChild(el('td', { colspan: '5', text: filter ? '当前过滤条件下无轨迹记录。' : '暂无运行轨迹。' }))
      tbody.appendChild(emptyRow)
      return
    }
    shown.forEach(function (row) {
      var tr = el('tr')
      tr.appendChild(el('td', { class: 'is-num', text: String(row.seq) }))
      tr.appendChild(el('td', { class: 'is-nowrap', text: util.formatClock(row.time) }))
      tr.appendChild(el('td', { class: 'is-nowrap', text: traceKindLabel(row.type) }))
      tr.appendChild(el('td', { class: 'is-num', text: util.shortId(row.sessionId, 8, 4) }))
      tr.appendChild(el('td', { class: 'gov-text', text: util.truncate(row.summary || '', 400) }))
      tbody.appendChild(tr)
    })
  }

  /** 把一条会话事件压成一行轨迹摘要。 */
  function summarizeEvent(type, data) {
    var d = data || {}
    switch (type) {
      case 'assistant/chunk':
        return chunkText(d.chunk)
      case 'assistant/message':
        return messageText(d.message)
      case 'tool/call':
        return (d.tool || '未知工具') + ' ' + util.truncate(util.toText(d.args), 200)
      case 'tool/result':
        return (d.tool || d.callId || '工具结果') + ' ' + util.truncate(util.toText(d.result ?? d.output ?? d), 200)
      case 'step/start':
      case 'step/end':
        return '第 ' + String(d.turn ?? '?') + ' 轮 / 第 ' + String(d.step ?? '?') + ' 步'
      case 'turn/start':
      case 'turn/end':
        return '第 ' + String(d.turn ?? '?') + ' 轮' + (d.reason ? '（' + d.reason + '）' : '')
      case 'todo/write':
        return '待办 ' + String((d.todos || []).length) + ' 项'
      case 'user/message':
        return messageText(d.message)
      case 'approval/asked':
        return (d.toolName || '操作') + (d.reason ? '：' + d.reason : '')
      case 'approval/decided':
        return String(d.outcome || '')
      case 'session/title':
        return String(d.title || '')
      case 'permission/preset':
        return String(d.preset || d.name || '')
      case 'sandbox/mode':
        return String(d.mode || '')
      default:
        return util.truncate(util.toText(d), 200)
    }
  }

  /** 从 assistant/chunk 的 chunk 里取文本（结构多变，做防御式提取）。 */
  function chunkText(chunk) {
    if (chunk === undefined || chunk === null) return ''
    if (typeof chunk === 'string') return chunk
    if (typeof chunk.text === 'string') return chunk.text
    if (typeof chunk.delta === 'string') return chunk.delta
    if (chunk.delta && typeof chunk.delta.text === 'string') return chunk.delta.text
    if (chunk.block && typeof chunk.block.text === 'string') return chunk.block.text
    if (chunk.block && typeof chunk.block.thinking === 'string') return chunk.block.thinking
    if (typeof chunk.thinking === 'string') return chunk.thinking
    if (Array.isArray(chunk.content)) {
      return chunk.content.map(function (part) {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      }).join('')
    }
    return ''
  }

  /** 从 assistant/message 的 message 里取文本。 */
  function messageText(message) {
    if (message === undefined || message === null) return ''
    if (typeof message === 'string') return message
    if (Array.isArray(message.content)) {
      return message.content.map(function (part) {
        if (typeof part === 'string') return part
        if (part === null || typeof part !== 'object') return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.thinking === 'string') return part.thinking
        if (part.type === 'tool-call' || part.type === 'tool_call') {
          return '[工具调用 ' + String(part.tool || part.name || '') + ']'
        }
        return ''
      }).join('')
    }
    if (typeof message.text === 'string') return message.text
    return ''
  }

  /* ------------------------------------------------------------------ */
  /* 系统配置：schemastery schema → 动态表单                             */
  /* ------------------------------------------------------------------ */

  /** 判断一个 schema 节点是不是对象。 */
  function schemaObject(schema) {
    return schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? schema : undefined
  }

  /**
   * 把 schemastery 的 schema 描述递归渲染成表单控件。
   *
   * schemastery 的 wire 形状（`schema` 字段）常见形态：
   *   `{type:'object', dict:{key: schema}}`
   *   `{type:'string'|'number'|'boolean', ...}`
   *   `{type:'union', list:[...]}`  / `{type:'const', value}`
   *   `{type:'array', inner: schema}`
   *   `{type:'intersect', list:[...]}`
   * 未识别的形态一律退化成 JSON 文本框，保证任何命名空间都能编辑。
   */
  function schemaToFields(schema, path, value, idPrefix) {
    var node = schemaObject(schema)
    if (node === undefined) {
      return [{ kind: 'json', path: path, label: path[path.length - 1] || '(根)', value: value, id: idPrefix }]
    }
    if (node.type === 'object' && node.dict && typeof node.dict === 'object') {
      var fields = []
      Object.keys(node.dict).forEach(function (key) {
        var childPath = path.concat(key)
        var childValue = value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined
        fields = fields.concat(schemaToFields(node.dict[key], childPath, childValue, idPrefix + '-' + key))
      })
      return fields
    }
    if (node.type === 'union' && Array.isArray(node.list) && node.list.length > 0) {
      // 字面量联合 → 下拉；其余 → JSON。
      var literals = node.list.filter(function (item) { return schemaObject(item) && schemaObject(item).type === 'const' })
      if (literals.length === node.list.length) {
        return [{
          kind: 'select',
          path: path,
          label: path[path.length - 1] || '(根)',
          id: idPrefix,
          value: value,
          options: node.list.map(function (item) {
            var literal = schemaObject(item).value
            return { value: String(literal), label: literal === null ? 'null' : String(literal), raw: literal }
          }),
        }]
      }
      return [{ kind: 'json', path: path, label: path[path.length - 1] || '(根)', value: value, id: idPrefix }]
    }
    if (node.type === 'const') {
      return [{ kind: 'const', path: path, label: path[path.length - 1] || '(根)', id: idPrefix, value: node.value }]
    }
    if (node.type === 'boolean') {
      return [{ kind: 'boolean', path: path, label: path[path.length - 1] || '(根)', id: idPrefix, value: value === true }]
    }
    if (node.type === 'number' || node.type === 'natural' || node.type === 'percent') {
      return [{ kind: 'number', path: path, label: path[path.length - 1] || '(根)', id: idPrefix, value: value, meta: node }]
    }
    if (node.type === 'string') {
      return [{ kind: 'string', path: path, label: path[path.length - 1] || '(根)', id: idPrefix, value: value, meta: node }]
    }
    if (node.type === 'array') {
      return [{ kind: 'json', path: path, label: path[path.length - 1] || '(根)', value: value, id: idPrefix, note: '数组项请用 JSON 编辑' }]
    }
    return [{ kind: 'json', path: path, label: path[path.length - 1] || '(根)', value: value, id: idPrefix, note: 'schema 类型：' + String(node.type) }]
  }

  /** 渲染一个命名空间的配置表单。 */
  function renderSettingsNamespace(entry, onChange) {
    var box = el('div', { class: 'gov-box' })
    var head = el('div', { class: 'gov-box-head' })
    head.appendChild(el('div', { class: 'gov-box-title', text: entry.ns }))
    head.appendChild(el('div', { class: 'gov-spacer' }))
    head.appendChild(el('span', {
      class: 'gov-receipt-meta',
      text: (entry.autoGenerate ? '自动生成' : '已声明') + ' · 修订 ' + String(entry.revision) + (entry.applies === 'live' ? ' · 即时生效' : ''),
    }))
    box.appendChild(head)

    var body = el('div', { class: 'gov-box-body' })
    if (Array.isArray(entry.secrets) && entry.secrets.length > 0) {
      var secretLine = entry.secrets.map(function (secret) {
        return secret.path.join('.') + (secret.set ? '（已设置）' : '（未设置）')
      }).join('；')
      body.appendChild(el('div', { class: 'gov-hint', text: '敏感项：' + secretLine + '。出于安全考虑，敏感值不在页面回显。' }))
    }

    var schema = entry.schema
    var fields
    if (schema === null || schema === undefined) {
      fields = [{ kind: 'json', path: [], label: '(整节)', value: entry.value, id: entry.ns + '-root', note: '该命名空间未声明 schema，请用 JSON 编辑。' }]
    } else {
      fields = schemaToFields(schema, [], entry.value, entry.ns)
    }

    var grid = el('div', { class: 'gov-params' })
    var inputs = []
    fields.forEach(function (field) {
      inputs.push({ field: field, control: buildControl(field) })
    })
    inputs.forEach(function (item) {
      grid.appendChild(item.control.wrapper)
    })
    body.appendChild(grid)

    var actions = el('div', { style: 'margin-top:10px; display:flex; gap:10px; align-items:center;' })
    var saveBtn = el('button', {
      class: 'gov-btn',
      type: 'button',
      text: '提交本节配置',
      onclick: function () {
        var patch = collectPatch(inputs)
        if (patch === undefined) return
        onChange(entry.ns, patch, entry.revision)
      },
    })
    actions.appendChild(saveBtn)
    actions.appendChild(el('span', {
      class: 'gov-field-hint',
      text: '仅提交本节；未改动的字段不会被写入。',
    }))
    body.appendChild(actions)
    box.appendChild(body)
    return box
  }

  /** 按字段类型建控件，返回 `{ wrapper, read }`。 */
  function buildControl(field) {
    var wrapper = el('div', { class: 'gov-field' })
    var label = el('label', { class: 'gov-field-label', text: field.label, for: 'gov-f-' + field.id })
    wrapper.appendChild(label)
    var read

    if (field.kind === 'boolean') {
      var checkbox = el('input', { type: 'checkbox', id: 'gov-f-' + field.id })
      checkbox.checked = field.value === true
      wrapper.appendChild(checkbox)
      read = function () { return checkbox.checked }
    } else if (field.kind === 'select') {
      var select = el('select', { id: 'gov-f-' + field.id })
      field.options.forEach(function (option) {
        select.appendChild(el('option', { value: option.value, text: option.label }))
      })
      var current = field.value === undefined || field.value === null ? '' : String(field.value)
      select.value = field.options.some(function (option) { return option.value === current }) ? current : field.options[0].value
      wrapper.appendChild(select)
      read = function () {
        var chosen = field.options.filter(function (option) { return option.value === select.value })
        return chosen.length > 0 ? chosen[0].raw : select.value
      }
    } else if (field.kind === 'number') {
      var numberInput = el('input', { type: 'number', id: 'gov-f-' + field.id })
      if (field.value !== undefined && field.value !== null) numberInput.value = String(field.value)
      var meta = field.meta || {}
      if (Number.isFinite(meta.min)) numberInput.min = String(meta.min)
      if (Number.isFinite(meta.max)) numberInput.max = String(meta.max)
      if (Number.isFinite(meta.step)) numberInput.step = String(meta.step)
      wrapper.appendChild(numberInput)
      read = function () {
        if (numberInput.value === '') return undefined
        var parsed = Number(numberInput.value)
        return Number.isFinite(parsed) ? parsed : undefined
      }
    } else if (field.kind === 'string') {
      var textInput = el('input', { type: 'text', id: 'gov-f-' + field.id })
      if (field.value !== undefined && field.value !== null) textInput.value = String(field.value)
      wrapper.appendChild(textInput)
      read = function () { return textInput.value }
    } else if (field.kind === 'const') {
      wrapper.appendChild(el('div', { class: 'gov-field-hint', text: '固定值：' + util.toText(field.value) }))
      read = function () { return undefined }
    } else {
      var area = el('textarea', { id: 'gov-f-' + field.id, spellcheck: 'false' })
      area.value = field.value === undefined ? '' : util.toText(field.value)
      wrapper.appendChild(area)
      if (field.note) wrapper.appendChild(el('div', { class: 'gov-field-hint', text: field.note }))
      read = function () {
        var text = area.value.trim()
        if (text === '') return undefined
        try {
          return JSON.parse(text)
        } catch (error) {
          return { __invalid: error.message }
        }
      }
    }

    return { wrapper: wrapper, read: read, field: field }
  }

  /**
   * 收集一节表单的 patch。
   *
   * 只提交「与初始值不同」的叶子字段；JSON 字段解析失败时中止整次提交
   * 并给出提示，避免把坏数据写进宿主配置。
   */
  function collectPatch(inputs) {
    var patch = {}
    var invalid = []
    inputs.forEach(function (item) {
      var next = item.read()
      if (next === undefined) return
      if (next !== null && typeof next === 'object' && next.__invalid !== undefined) {
        invalid.push(item.field.label + '：' + next.__invalid)
        return
      }
      var initial = item.field.value
      if (sameValue(initial, next)) return
      assignPath(patch, item.field.path, next)
    })
    if (invalid.length > 0) {
      global.alert('以下字段不是合法 JSON，未提交：\n' + invalid.join('\n'))
      return undefined
    }
    if (Object.keys(patch).length === 0) {
      global.alert('没有检测到改动，未提交。')
      return undefined
    }
    return patch
  }

  /** 按路径写进嵌套对象。 */
  function assignPath(target, path, value) {
    if (path.length === 0) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.keys(value).forEach(function (key) { target[key] = value[key] })
      }
      return
    }
    var cursor = target
    for (var i = 0; i < path.length - 1; i += 1) {
      var key = path[i]
      if (cursor[key] === null || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
      cursor = cursor[key]
    }
    cursor[path[path.length - 1]] = value
  }

  /** 宽松相等（对象走 JSON 比较）。 */
  function sameValue(a, b) {
    if (a === b) return true
    if (a === undefined || b === undefined) return false
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch (error) {
      return false
    }
  }

  global.GovPanels = {
    renderTicket: renderTicket,
    describeBridge: describeBridge,
    renderTranscript: renderTranscript,
    renderStats: renderStats,
    renderTodos: renderTodos,
    fillSelect: fillSelect,
    fillModelSelect: fillModelSelect,
    modelOptionsFromCatalog: modelOptionsFromCatalog,
    effortsForModel: effortsForModel,
    renderArchive: renderArchive,
    renderTrace: renderTrace,
    summarizeEvent: summarizeEvent,
    traceKindLabel: traceKindLabel,
    chunkText: chunkText,
    messageText: messageText,
    renderSettingsNamespace: renderSettingsNamespace,
  }
})(window)
