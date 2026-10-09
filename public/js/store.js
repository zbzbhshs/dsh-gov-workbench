/* ====================================================================
 * store.js —— 前端状态与 localStorage 持久化
 *
 * 键名固定为 `dsh.govWorkbench.v1`。所有 UI 偏好走这里；服务端配置
 * （端口 / 令牌 / 访问计数）在宿主侧，不在 localStorage。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil
  var STORAGE_KEY = 'dsh.govWorkbench.v1'

  /** 默认 UI 偏好。 */
  var DEFAULTS = {
    page: 'home',
    sessionId: '',
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

  /** 从 localStorage 读偏好（失败静默回落默认值）。 */
  function load() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY)
      if (!raw) return util.clone(DEFAULTS)
      var parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return util.clone(DEFAULTS)
      var merged = util.clone(DEFAULTS)
      Object.keys(parsed).forEach(function (key) {
        if (parsed[key] !== undefined) merged[key] = parsed[key]
      })
      return merged
    } catch (error) {
      return util.clone(DEFAULTS)
    }
  }

  /** 写偏好。 */
  function save(prefs) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch (error) {
      console.warn('[gov-workbench] localStorage 写入失败：', error.message)
    }
  }

  /**
   * 建一个 store：`get` / `set` / `subscribe`。
   * `set` 只在值真的变化时通知订阅者，避免无谓重渲染。
   */
  function createStore() {
    var prefs = load()
    var subscribers = []

    function get(key) {
      return key === undefined ? prefs : prefs[key]
    }

    function set(key, value) {
      if (prefs[key] === value) return false
      prefs[key] = value
      save(prefs)
      subscribers.forEach(function (fn) {
        try {
          fn(key, value, prefs)
        } catch (error) {
          console.warn('[gov-workbench] 订阅者异常：', error.message)
        }
      })
      return true
    }

    function patch(values) {
      Object.keys(values).forEach(function (key) {
        set(key, values[key])
      })
    }

    function subscribe(fn) {
      subscribers.push(fn)
      return function () {
        var at = subscribers.indexOf(fn)
        if (at !== -1) subscribers.splice(at, 1)
      }
    }

    return { get: get, set: set, patch: patch, subscribe: subscribe, DEFAULTS: DEFAULTS, STORAGE_KEY: STORAGE_KEY }
  }

  /**
   * 运行期状态（不持久化）：会话列表、模型目录、投影快照、回执行、轨迹行。
   */
  function createRuntime() {
    return {
      sessions: [],
      presets: [],
      permissionOptions: [],
      permissionDefault: '',
      modelGroups: [],
      modelDefault: null,
      settings: [],
      workspaces: [],
      stats: null,
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      /** 宿主投影快照：key → 值（`session.projections` 的 `values`）。 */
      projections: {},
      /** 投影快照的游标，用作 `session.page` 的 throughSeq 上界。 */
      projectionsAsOfSeq: 0,
      /** 打开页面时探到的宿主能力说明（逐条给人看）。 */
      capabilities: [],
      /** 当前会话的办理模式（取自 agentPreset 投影或本地选择）。 */
      preset: '',
      /** 当前会话标题（取自 title 投影）。 */
      sessionTitle: '',
      todos: [],
      transcript: [],
      trace: [],
      turn: 0,
      step: 0,
      running: false,
      streamOpen: false,
      lastError: '',
      hostKind: '',
      visits: 0,
      marquee: [],
      archive: { items: [], page: 1, pageSize: 20, hasMore: false, query: '' },
      startedAt: 0,
      firstTokenAt: 0,
      chunks: 0,
      textChars: 0,
    }
  }

  global.GovStore = { createStore: createStore, createRuntime: createRuntime, STORAGE_KEY: STORAGE_KEY, DEFAULTS: DEFAULTS }
})(window)
