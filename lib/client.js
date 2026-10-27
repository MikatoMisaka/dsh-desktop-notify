/**
 * dsh-desktop-notify — 浏览器半边。
 *
 * 三件事：
 *   1. 盯会话状态，判断「该不该提醒」；
 *   2. 该提醒时敲一下 Host 的通知路由（带 sessionId）；
 *   3. 窗口从最小化恢复可见时，把「刚才那条通知属于哪个会话」取回来并切过去——
 *      这样点通知的链路就是完整的：点 → 协议激活拉起窗口 → 这里跳会话。
 *
 * 触发条件（默认只在窗口最小化/收进托盘时）：
 *   1. 一轮任务从 running 变成不 running，且该会话没有待回答的交互 —— 「任务完成」；
 *   2. 会话第一次出现待回答的交互（提问 / 计划审阅 / 工具确认）—— 「DSH 有问题要问你」。
 *
 * 排障：每个判定都往 Host 的 /log 写一行（Host 落盘到
 * %LOCALAPPDATA%\dsh-desktop-notify\host.log）。有 `client-apply` 说明这半边加载了；
 * `transition` 里能看到判定是 notify 还是 skip-visible。
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Host 半边挂的通知路由（浏览器同源相对路径即可）。 */
    const ROUTE = '/plugins/dsh-desktop-notify/notify'

    /** 判定过程落盘用的日志路由。 */
    const LOG_ROUTE = '/plugins/dsh-desktop-notify/log'

    /** 启动时读一次的行为配置（和 Host 半边共用一份，避免两边判断不一致）。 */
    const CONFIG_ROUTE = '/plugins/dsh-desktop-notify/config'

    /** 最近一条通知指向的会话；点通知拉起窗口后从这里取。 */
    const PENDING_ROUTE = '/plugins/dsh-desktop-notify/pending'

    /** 把窗口提到最前的辅助路由（协议激活只 restore，不给前台权限）。 */
    const FOCUS_ROUTE = '/plugins/dsh-desktop-notify/focus'

    /** 需要会话名、会话状态、以及"切到某个会话"的能力。 */
    const inject = ['sessions', 'uiSession', 'uiWorkspace']

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

      /** 行为开关；Host 的 /config 路由到货后覆盖。 */
      let settings = { trigger: 'unfocused' }

      /** 单会话诊断条数上限，防止长时间运行把日志撑爆。 */
      const diagBudget = new Map()

      function post(path, payload) {
        try {
          return fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        } catch (error) {
          return Promise.reject(error)
        }
      }

      /**
       * 写一行诊断。失败静默：日志永远不能影响通知。
       * @param {string} event
       * @param {object} [extra]
       */
      function diag(event, extra) {
        try {
          post(LOG_ROUTE, { side: 'client', event, ...extra }).catch(() => {})
        } catch {
          // 忽略。
        }
      }

      /** 窗口是不是不在你眼前（最小化 / 收进托盘 / 锁屏）。 */
      function minimized() {
        if (typeof document === 'undefined') return false
        return document.visibilityState !== 'visible'
      }

      function focused() {
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

      /** 你把主视图停在这个会话上，且窗口在前台。 */
      function watching(sessionId) {
        if (!focused()) return false
        const row = rowOf(sessionId)
        return Number(row?.retainedBy?.mainView ?? 0) > 0
      }

      /** 该不该为这个会话打扰你。 */
      function decide(sessionId) {
        if (isDerived(sessionId)) return 'skip-derived'
        if (settings.trigger === 'always') return 'notify'
        if (settings.trigger === 'unfocused') return watching(sessionId) ? 'skip-watching' : 'notify'
        return minimized() ? 'notify' : 'skip-visible'
      }

      function deliver(title, body, key, sessionId) {
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
                  diag('fallback-browser-notification', { title })
                } catch {
                  // 浏览器通知也不可用：没有第三个通道了，交给 Host 日志。
                }
                done()
              }
              try {
                post(ROUTE, { title, body, key, sessionId })
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
        const label = labelOf(sessionId)
        deliver('DSH · 任务已完成', label === '' ? '会话已经跑完这一轮。' : `${label}：这一轮已经跑完。`, `complete:${sessionId}`, sessionId)
      }

      function notifyPending(sessionId, pending) {
        const kind = typeof pending?.kind === 'string' ? pending.kind : 'question'
        const copy = PENDING_COPY[kind] ?? PENDING_COPY.question
        const label = labelOf(sessionId)
        const detail =
          kind === 'approval' && typeof pending?.toolName === 'string' && pending.toolName !== ''
            ? `工具：${pending.toolName}`
            : copy.body
        const body = label === '' ? detail : `${label}：${detail}`
        deliver(copy.title, body, `pending:${sessionId}:${kind}`, sessionId)
      }

      /** 当前主视图停在哪个会话。 */
      function currentSessionId() {
        try {
          const binding = ctx.uiSession.current?.getSnapshot?.()
          const key = binding?.key
          return typeof key === 'string' ? key : ''
        } catch {
          return ''
        }
      }

      /**
       * 点通知把窗口拉起来之后：取回那条通知指向的会话并切过去。
       * 先清 pending 再跳，避免后续任何一次 focus 都重复跳。
       */
      let consuming = false

      async function consumePending() {
        if (consuming) return
        consuming = true
        try {
          await runConsume()
        } finally {
          consuming = false
        }
      }

      async function runConsume() {
        let sessionId = ''
        try {
          const response = await fetch(PENDING_ROUTE, { credentials: 'same-origin' })
          if (!response.ok) return
          const doc = await response.json()
          sessionId = typeof doc?.sessionId === 'string' ? doc.sessionId : ''
        } catch {
          return
        }
        if (sessionId === '') return
        try {
          await post(PENDING_ROUTE, { clear: true })
        } catch {
          // 清不掉也要继续跳，宁可重复一次也别不跳。
        }
        // 协议激活只让窗口"露出来"，前台权限在别的进程手里 —— 补一枪置顶。
        try {
          await post(FOCUS_ROUTE, { reason: 'notification-click' })
        } catch {
          // 置顶失败不影响跳会话。
        }
        if (sessionId === currentSessionId()) {
          diag('navigate-skip', { sessionId, reason: 'already-current' })
          return
        }
        try {
          ctx.uiWorkspace.openSession(sessionId)
          diag('navigate', { sessionId })
        } catch (error) {
          diag('navigate-failed', { sessionId, message: String(error?.message ?? error) })
        }
      }

      function snapshotize(snapshot) {
        const next = new Map()
        for (const [sessionId, entry] of snapshot) {
          next.set(sessionId, { running: entry.running === true, pending: entry.pendingInteraction ?? null })
        }
        return next
      }

      function report(sessionId, transition, action) {
        const used = diagBudget.get(sessionId) ?? 0
        if (used >= 40) return
        diagBudget.set(sessionId, used + 1)
        diag('transition', {
          sessionId,
          transition,
          action,
          trigger: settings.trigger,
          minimized: minimized(),
          label: labelOf(sessionId),
        })
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

          if (pendingAppeared) {
            const action = decide(sessionId)
            const kind = typeof entry.pending?.kind === 'string' ? entry.pending.kind : 'question'
            report(sessionId, `pending:${kind}`, action)
            if (action === 'notify') notifyPending(sessionId, entry.pending)
          } else if (completed) {
            const action = decide(sessionId)
            report(sessionId, 'complete', action)
            if (action === 'notify') notifyComplete(sessionId)
          }
        }
        previous = next
      }

      ctx.effect(() => {
        previous = snapshotize(status.getSnapshot())
        const dispose = status.subscribe(tick)

        // 点通知 → 协议激活 → 窗口恢复可见 → 在这里把会话切过去。
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void consumePending()
        }
        const onFocus = () => void consumePending()
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisible)
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('focus', onFocus)
        }

        try {
          fetch(CONFIG_ROUTE, { credentials: 'same-origin' })
            .then((response) => (response.ok ? response.json() : null))
            .then((config) => {
              if (config !== null && typeof config === 'object') {
                const trigger =
                  config.trigger === 'minimized' || config.trigger === 'always' || config.trigger === 'unfocused'
                    ? config.trigger
                    : 'unfocused'
                settings = { trigger }
                diag('config', settings)
              }
            })
            .catch(() => {})
        } catch {
          // 读不到配置就按默认值走：只在最小化时提醒。
        }

        diag('client-apply', {
          module: 'dsh-desktop-notify',
          visibility: typeof document === 'undefined' ? 'no-document' : document.visibilityState,
          focused: typeof document === 'undefined' ? false : document.hasFocus(),
          sessions: previous.size,
        })
        try {
          console.info('[dsh-desktop-notify] 已就绪：不在前台时提醒，点通知回到对应会话。')
        } catch {
          // console 不可用就算了。
        }

        return () => {
          dispose()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
        }
      }, 'dsh-desktop-notify: 会话状态订阅')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
