/* ====================================================================
 * float.js —— 飘窗（DVD 屏保式匀速碰撞反弹浮窗）
 *
 * 匀速直线运动，撞到视口边界按分量取反，永不停下。悬停暂停，
 * 可拖动，可 [×] 销毁。位置写 transform，不引起重排。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil

  /** 默认速度（像素/秒）。 */
  var SPEED_X = 68
  var SPEED_Y = 46

  /**
   * 建一个飘窗。
   * @param options - `{ title, body, onClose }`。
   * @returns `{ destroy, pause, resume }`。
   */
  function createFloat(options) {
    var opts = options || {}
    var state = {
      x: 0,
      y: 0,
      vx: SPEED_X,
      vy: SPEED_Y,
      width: 214,
      height: 120,
      paused: false,
      dragging: false,
      dragDx: 0,
      dragDy: 0,
      destroyed: false,
      raf: 0,
      lastTime: 0,
    }

    var root = util.el('div', { class: 'gov-float', role: 'complementary' })
    var head = util.el('div', { class: 'gov-float-head' })
    var title = util.el('span', { class: 'gov-float-title', text: opts.title || '便民提示' })
    var close = util.el('button', {
      class: 'gov-float-close',
      type: 'button',
      title: '关闭飘窗',
      'aria-label': '关闭飘窗',
      text: '×',
    })
    head.appendChild(title)
    head.appendChild(close)
    var body = util.el('div', { class: 'gov-float-body' })
    if (opts.body) body.appendChild(opts.body)
    root.appendChild(head)
    root.appendChild(body)
    document.body.appendChild(root)

    // 初始位置：右下角偏内，随机一点避免每次都一样。
    state.x = Math.max(12, global.innerWidth - state.width - 40 - Math.random() * 80)
    state.y = Math.max(12, global.innerHeight - state.height - 60 - Math.random() * 80)
    apply()

    function apply() {
      root.style.transform = 'translate(' + Math.round(state.x) + 'px, ' + Math.round(state.y) + 'px)'
    }

    function measure() {
      state.width = root.offsetWidth || 214
      state.height = root.offsetHeight || 120
    }

    function tick(time) {
      if (state.destroyed) return
      state.raf = requestAnimationFrame(tick)
      var delta = state.lastTime === 0 ? 0 : Math.min((time - state.lastTime) / 1000, 0.1)
      state.lastTime = time
      if (state.paused || state.dragging) return

      state.x += state.vx * delta
      state.y += state.vy * delta

      var maxX = Math.max(0, global.innerWidth - state.width)
      var maxY = Math.max(0, global.innerHeight - state.height)
      if (state.x <= 0) {
        state.x = 0
        state.vx = Math.abs(state.vx)
      } else if (state.x >= maxX) {
        state.x = maxX
        state.vx = -Math.abs(state.vx)
      }
      if (state.y <= 0) {
        state.y = 0
        state.vy = Math.abs(state.vy)
      } else if (state.y >= maxY) {
        state.y = maxY
        state.vy = -Math.abs(state.vy)
      }
      apply()
    }

    function onEnter() {
      if (!state.dragging) state.paused = true
    }
    function onLeave() {
      if (!state.dragging) {
        state.paused = false
        state.lastTime = 0
      }
    }
    function onResize() {
      measure()
    }

    function onPointerDown(event) {
      if (event.target === close) return
      state.dragging = true
      state.paused = true
      state.dragDx = event.clientX - state.x
      state.dragDy = event.clientY - state.y
      if (typeof head.setPointerCapture === 'function' && event.pointerId !== undefined) {
        try { head.setPointerCapture(event.pointerId) } catch (error) { /* 忽略 */ }
      }
      event.preventDefault()
    }

    function onPointerMove(event) {
      if (!state.dragging) return
      var maxX = Math.max(0, global.innerWidth - state.width)
      var maxY = Math.max(0, global.innerHeight - state.height)
      state.x = Math.min(maxX, Math.max(0, event.clientX - state.dragDx))
      state.y = Math.min(maxY, Math.max(0, event.clientY - state.dragDy))
      apply()
    }

    function onPointerUp() {
      if (!state.dragging) return
      state.dragging = false
      state.paused = false
      state.lastTime = 0
      // 拖到哪就从哪继续，速度方向按落点相对屏幕中心重算，避免贴边卡死。
      state.vx = state.x > global.innerWidth / 2 ? -Math.abs(SPEED_X) : Math.abs(SPEED_X)
      state.vy = state.y > global.innerHeight / 2 ? -Math.abs(SPEED_Y) : Math.abs(SPEED_Y)
    }

    function destroy() {
      if (state.destroyed) return
      state.destroyed = true
      if (state.raf !== 0) cancelAnimationFrame(state.raf)
      state.raf = 0
      root.removeEventListener('mouseenter', onEnter)
      root.removeEventListener('mouseleave', onLeave)
      head.removeEventListener('pointerdown', onPointerDown)
      global.removeEventListener('pointermove', onPointerMove)
      global.removeEventListener('pointerup', onPointerUp)
      global.removeEventListener('resize', onResize)
      close.removeEventListener('click', onCloseClick)
      if (root.parentNode) root.parentNode.removeChild(root)
      if (typeof opts.onClose === 'function') opts.onClose()
    }

    function onCloseClick() {
      destroy()
    }

    root.addEventListener('mouseenter', onEnter)
    root.addEventListener('mouseleave', onLeave)
    head.addEventListener('pointerdown', onPointerDown)
    global.addEventListener('pointermove', onPointerMove)
    global.addEventListener('pointerup', onPointerUp)
    global.addEventListener('resize', onResize)
    close.addEventListener('click', onCloseClick)

    measure()
    state.raf = requestAnimationFrame(tick)

    return {
      destroy: destroy,
      pause: function () { state.paused = true },
      resume: function () { state.paused = false; state.lastTime = 0 },
    }
  }

  global.GovFloat = { createFloat: createFloat, SPEED_X: SPEED_X, SPEED_Y: SPEED_Y }
})(window)
