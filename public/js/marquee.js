/* ====================================================================
 * marquee.js —— 【重要通知】横向滚动跑马灯
 *
 * 匀速平移，跑完一条接一条。鼠标悬停暂停，移开继续。
 * 用 transform 驱动（GPU 合成），不触发布局，不引起页面跳动。
 * ==================================================================== */
(function (global) {
  'use strict'

  var util = global.GovUtil

  /** 每秒平移像素数。 */
  var SPEED_PX_PER_SECOND = 60

  /**
   * 建一个跑马灯。
   * @param view - 视口元素（overflow:hidden）。
   * @param lines - 通知文本数组。
   * @returns `{ setLines, start, stop, destroy }`。
   */
  function createMarquee(view, lines) {
    var node = util.el('div', { class: 'gov-marquee-text' })
    view.appendChild(node)

    var queue = (lines || []).slice()
    var index = 0
    var raf = 0
    var paused = false
    var destroyed = false
    var lastTime = 0
    var offset = 0
    var currentWidth = 0
    var viewWidth = 0

    function measure() {
      viewWidth = view.clientWidth || 0
      currentWidth = node.scrollWidth || 0
    }

    function nextLine() {
      if (queue.length === 0) {
        node.textContent = '暂无通知。'
        currentWidth = node.scrollWidth || 0
        return
      }
      node.textContent = queue[index % queue.length]
      index += 1
      measure()
      offset = viewWidth
    }

    function tick(time) {
      if (destroyed) return
      raf = requestAnimationFrame(tick)
      var delta = lastTime === 0 ? 0 : (time - lastTime) / 1000
      lastTime = time
      if (paused) return
      if (currentWidth === 0) measure()
      offset -= SPEED_PX_PER_SECOND * delta
      if (offset + currentWidth < 0) nextLine()
      node.style.transform = 'translate(' + Math.round(offset) + 'px, -50%)'
    }

    function onEnter() { paused = true }
    function onLeave() { paused = false }
    function onResize() { measure() }

    node.addEventListener('mouseenter', onEnter)
    node.addEventListener('mouseleave', onLeave)
    global.addEventListener('resize', onResize)

    function setLines(next) {
      queue = (next || []).slice()
      index = 0
      if (queue.length === 0) {
        node.textContent = '暂无通知。'
        return
      }
      nextLine()
    }

    setLines(queue)
    raf = requestAnimationFrame(tick)

    return {
      setLines: setLines,
      start: function () {
        if (raf === 0 && !destroyed) {
          lastTime = 0
          raf = requestAnimationFrame(tick)
        }
      },
      stop: function () {
        if (raf !== 0) {
          cancelAnimationFrame(raf)
          raf = 0
        }
      },
      destroy: function () {
        destroyed = true
        if (raf !== 0) cancelAnimationFrame(raf)
        raf = 0
        node.removeEventListener('mouseenter', onEnter)
        node.removeEventListener('mouseleave', onLeave)
        global.removeEventListener('resize', onResize)
        if (node.parentNode) node.parentNode.removeChild(node)
      },
    }
  }

  global.GovMarquee = { createMarquee: createMarquee, SPEED_PX_PER_SECOND: SPEED_PX_PER_SECOND }
})(window)
