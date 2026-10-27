/**
 * dsh-desktop-notify — 浏览器半边。
 *
 * 只做两件事：盯会话状态，和在「该提醒了」的时候敲一下 Host 的通知路由。
 *
 * 触发条件（都不弹窗的情况请见下面每条注释）：
 *   1. 一轮任务从 running 变成不 running，且该会话没有待回答的交互 —— 「任务完成」；
 *   2. 会话第一次出现待回答的交互（提问 / 计划审阅 / 工具确认）—— 「DSH 有问题要问你」。
 *
 * 判定「你是不是正看着它」用 document 可见性 + 焦点 + 该会话是否挂在主视图上：
 * 你盯着这个会话看的时候不需要弹窗，反之（切到别的会话、最小化到托盘、锁屏走开）
 * 就要弹。
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Host 半边挂的通知路由（浏览器同源相对路径即可）。 */
    const ROUTE = '/plugins/dsh-desktop-notify/notify'

    /** 需要会话名和会话状态两个服务。 */
    const inject = ['sessions', 'uiSession']

    /** 三类待回答交互的文案。 */
    const PENDING_COPY = {
      approval: { title: 'DSH 需要你确认', body: '有一项工具调用在等你同意。' },
      'plan-review': { title: 'DSH 请你审阅计划', body: '计划已经写好，等你确认后继续。' },
      question: { title: 'DSH 有问题要问你', body: '会话停下来等你回答。' },
    }

    function apply(ctx) {
      const status = ctx.uiSession.sessionStatus

      /** 上一次的状态快照：sessionId -> { running, pending }。 */
      let previous = new Map()

      /** 通知发送的串行队列，避免连点把 PowerShell 进程堆起来。 */
      let queue = Promise.resolve()

      function visible() {
        if (typeof document === 'undefined') return false
        return document.visibilityState === 'visible' && document.hasFocus()
      }

      function rowOf(sessionId) {
        try {
          return ctx.sessions.list.getSnapshot().byId[sessionId]
        } catch {
          return undefined
        }
      }

      function labelOf(sessionId) {
        const row = rowOf(sessionId)
        const title = row?.displayTitle ?? row?.title
        return typeof title === 'string' && title.trim() !== '' ? title.trim() : ''
      }

      /** 子智能体/派生会话：由父会话那一轮统一提醒，逐个弹会变成刷屏。 */
      function isDerived(sessionId) {
        const row = rowOf(sessionId)
        if (row === undefined) return false
        if (typeof row.parentSessionId === 'string' && row.parentSessionId !== '') return true
        return Number(row.depth ?? 0) > 0
      }

      /** 你把主视图停在这个会话上，且窗口在前台 —— 这种情况下不需要通知。 */
      function watching(sessionId) {
        if (!visible()) return false
        const row = rowOf(sessionId)
        return Number(row?.retainedBy?.mainView ?? 0) > 0
      }

      function deliver(title, body, key) {
        queue = queue.then(
          () =>
            new Promise((resolve) => {
              let settled = false
              let watchdog = 0
              const done = () => {
                if (settled) return
                settled = true
                clearTimeout(watchdog)
                resolve()
              }
              const fallback = () => {
                if (settled) return
                try {
                  if (typeof Notification === 'function') new Notification(title, { body })
                } catch {
                  // 浏览器通知也不可用：没有第三个通道了，交给 Host 日志。
                }
                done()
              }
              try {
                fetch(ROUTE, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ title, body, key }),
                })
                  .then((response) => {
                    if (!response.ok) fallback()
                    else done()
                  })
                  .catch(fallback)
              } catch {
                fallback()
              }
              watchdog = setTimeout(fallback, 3000)
            })
        )
      }

      function notifyComplete(sessionId) {
        if (isDerived(sessionId) || watching(sessionId)) return
        const label = labelOf(sessionId)
        deliver('DSH · 任务已完成', label === '' ? '会话已经跑完这一轮。' : `${label}：这一轮已经跑完。`, `complete:${sessionId}`)
      }

      function notifyPending(sessionId, pending) {
        if (isDerived(sessionId) || watching(sessionId)) return
        const kind = typeof pending?.kind === 'string' ? pending.kind : 'question'
        const copy = PENDING_COPY[kind] ?? PENDING_COPY.question
        const label = labelOf(sessionId)
        const detail =
          kind === 'approval' && typeof pending?.toolName === 'string' && pending.toolName !== ''
            ? `工具：${pending.toolName}`
            : copy.body
        const body = label === '' ? detail : `${label}：${detail}`
        deliver(copy.title, body, `pending:${sessionId}:${kind}`)
      }

      function snapshotize(snapshot) {
        const next = new Map()
        for (const [sessionId, entry] of snapshot) {
          next.set(sessionId, { running: entry.running === true, pending: entry.pendingInteraction ?? null })
        }
        return next
      }

      function tick() {
        let snapshot
        try {
          snapshot = status.getSnapshot()
        } catch {
          return
        }
        const next = snapshotize(snapshot)
        for (const [sessionId, entry] of next) {
          const before = previous.get(sessionId)
          if (before === undefined) continue
          const pendingAppeared = entry.pending !== null && before.pending === null
          const completed = before.running && !entry.running && entry.pending === null && before.pending === null
          if (pendingAppeared) notifyPending(sessionId, entry.pending)
          else if (completed) notifyComplete(sessionId)
        }
        previous = next
      }

      ctx.effect(() => {
        previous = snapshotize(status.getSnapshot())
        const dispose = status.subscribe(tick)
        try {
          console.info('[dsh-desktop-notify] 已就绪：任务完成与待回答交互会弹 Windows 通知。')
        } catch {
          // console 不可用就算了。
        }
        return dispose
      }, 'dsh-desktop-notify: 会话状态订阅')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
