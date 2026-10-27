/**
 * dsh-desktop-notify — 浏览器半边。
 *
 * 四件事：
 *   1. 盯会话状态，判断「该不该提醒」；
 *   2. 该提醒时敲一下 Host 的通知路由（带 sessionId）；
 *   3. 窗口恢复可见时，把「刚才那条通知属于哪个会话」取回来并切过去，再请 Host 把窗口置顶；
 *   4. 在「设置 → 通用」里给出一行开关，让用户自己选触发时机（存 localStorage）。
 *
 * 触发条件（默认：只要 DSH 不在前台）：
 *   1. 一轮任务从 running 变成不 running，且该会话没有待回答的交互 —— 「任务完成」；
 *   2. 会话第一次出现待回答的交互（提问 / 计划审阅 / 工具确认）—— 「DSH 有问题要问你」。
 *
 * 排障：每个判定都往 Host 的 /log 写一行（Host 落盘到
 * %LOCALAPPDATA%\dsh-desktop-notify\host.log）。有 `client-apply` 说明这半边加载了；
 * `transition` 里能看到判定是 notify / skip-visible / skip-watching。
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

    /** 启动时读一次的行为配置（Host 侧默认值；用户在本机设置里的选择优先）。 */
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

    // ── 用户可配：三档触发时机 ────────────────────────────────────────────

    /** 本机偏好（localStorage）；没选过就跟随 Host 的默认值。 */
    const STORAGE_KEY = 'dsh-desktop-notify:trigger'

    /** 默认档位：只要 DSH 不在前台就提醒。 */
    const DEFAULT_TRIGGER = 'unfocused'

    /** 三档的取值与文案键。 */
    const TRIGGER_OPTIONS = [
      { value: 'unfocused', label: 'optionUnfocused', hint: 'hintUnfocused' },
      { value: 'minimized', label: 'optionMinimized', hint: 'hintMinimized' },
      { value: 'always', label: 'optionAlways', hint: 'hintAlways' },
    ]

    function isTrigger(value) {
      return value === 'unfocused' || value === 'minimized' || value === 'always'
    }

    function readStoredTrigger() {
      try {
        const value = window.localStorage.getItem(STORAGE_KEY)
        return isTrigger(value) ? value : undefined
      } catch {
        return undefined
      }
    }

    function writeStoredTrigger(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value)
      } catch {
        // 存不了就只在本次会话生效。
      }
    }

    /** 存过的选择压过 Host 默认值，避免"设置里选了却被 /config 覆盖回去"。 */
    const storedAtBoot = readStoredTrigger()

    /** 全局唯一的行为开关；设置行改的就是它。 */
    const settings = { trigger: storedAtBoot ?? DEFAULT_TRIGGER }

    /** 发同源 POST；异常统一交给调用方。 */
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

    /** 写一行诊断；失败静默——日志永远不能影响通知。 */
    function diag(event, extra) {
      try {
        post(LOG_ROUTE, { side: 'client', event, ...extra }).catch(() => {})
      } catch {
        // 忽略。
      }
    }

    // ── 设置页里的那一行 ─────────────────────────────────────────────────

    const SETTINGS_NS = 'desktop-notify'
    const STYLE_ID = 'dsh-desktop-notify/settings.css'
    const STYLE_CSS =
      '.dshNotifyRow{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}' +
      '.dshNotifyText{min-width:0}' +
      '.dshNotifyTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}' +
      '.dshNotifyDescription{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}' +
      '.dshNotifySegmented{display:inline-flex;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);overflow:hidden}' +
      '.dshNotifySegment{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:6px 10px;cursor:pointer;white-space:nowrap}' +
      '.dshNotifySegment:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dshNotifySegment[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}'

    const zh = {
      title: '任务完成提醒',
      description: '通过 Windows 通知告诉你任务跑完了，或者 DSH 停下来等你回答。',
      optionUnfocused: '不在前台就提醒',
      optionMinimized: '仅最小化时',
      optionAlways: '总是提醒',
      hintUnfocused: '你切到别的窗口、最小化、锁屏时都会提醒',
      hintMinimized: '只有最小化或收进托盘时才提醒',
      hintAlways: '包括你正看着这条会话（调试用）',
    }

    const en = {
      title: 'Task notifications',
      description: 'Notify through Windows when a run finishes or DSH is waiting for your answer.',
      optionUnfocused: 'When not focused',
      optionMinimized: 'Only when minimized',
      optionAlways: 'Always',
      hintUnfocused: 'Also fires when another window has focus',
      hintMinimized: 'Only when minimized or hidden to the tray',
      hintAlways: 'Even while you are watching this session (debug)',
    }

    /** 注入一次样式表（同款做法：plugin-owned <style data-plugin-css>）。 */
    function ensureStyle() {
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function' || document.head === undefined) return
        if (typeof document.querySelector === 'function' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-desktop-notify'
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = STYLE_CSS
        document.head.appendChild(tag)
      } catch {
        // 样式注入失败不影响功能，只是设置行会朴素一点。
      }
    }

    /**
     * 造出设置行组件。用 createElement 而不是 JSX —— 这个包没有构建步骤。
     * @param {object} React - 由模块加载器提供的 react
     */
    function createTriggerRow(React) {
      return function TriggerRow(props) {
        const t = typeof props?.t === 'function' ? props.t : (key) => key
        const [current, setCurrent] = React.useState(settings.trigger)
        const choose = (value) => {
          settings.trigger = value
          writeStoredTrigger(value)
          setCurrent(value)
          diag('trigger-changed', { trigger: value })
        }
        return React.createElement(
          'div',
          { className: 'dshNotifyRow' },
          React.createElement(
            'div',
            { className: 'dshNotifyText' },
            React.createElement('div', { className: 'dshNotifyTitle' }, t('title')),
            React.createElement('div', { className: 'dshNotifyDescription' }, t('description'))
          ),
          React.createElement(
            'div',
            { className: 'dshNotifySegmented', role: 'group', 'aria-label': t('title') },
            TRIGGER_OPTIONS.map((option) =>
              React.createElement(
                'button',
                {
                  key: option.value,
                  type: 'button',
                  className: 'dshNotifySegment',
                  'data-active': current === option.value ? 'true' : 'false',
                  'aria-pressed': current === option.value,
                  title: t(option.hint),
                  onClick: () => choose(option.value),
                },
                t(option.label)
              )
            )
          )
        )
      }
    }

    function apply(ctx) {
      const status = ctx.uiSession.sessionStatus

      /** 上一次的状态快照：sessionId -> { running, pending }。 */
      let previous = new Map()

      /** 通知发送的串行队列，避免连点把 PowerShell 进程堆起来。 */
      let queue = Promise.resolve()

      /** pending 消费的在途保护：focus 与 visibilitychange 会同时触发。 */
      let consuming = false

      /** 单会话诊断条数上限，防止长时间运行把日志撑爆。 */
      const diagBudget = new Map()

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

      /** 消费 pending：取回会话 → 清掉 → 请 Host 置顶 → 切过去。 */
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

        // 点通知 → 协议激活 → 窗口恢复可见 → 在这里置顶并切会话。
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
              if (config === null || typeof config !== 'object') return
              if (storedAtBoot !== undefined) return // 用户在本机选过，就别被默认值覆盖
              const trigger = isTrigger(config.trigger) ? config.trigger : DEFAULT_TRIGGER
              settings.trigger = trigger
              diag('config', { trigger })
            })
            .catch(() => {})
        } catch {
          // 读不到配置就按默认值走。
        }

        diag('client-apply', {
          module: 'dsh-desktop-notify',
          visibility: typeof document === 'undefined' ? 'no-document' : document.visibilityState,
          focused: typeof document === 'undefined' ? false : document.hasFocus(),
          sessions: previous.size,
          trigger: settings.trigger,
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

      // 设置页里的一行。整段包在 try/catch 里：UI 出问题绝不能让提醒跟着挂。
      try {
        let React = null
        try {
          React = require('react')
        } catch {
          React = null
        }
        if (React !== null) {
          const TriggerRow = createTriggerRow(React)
          ctx.inject(['slots', 'locale'], (scope) => {
            scope.effect(() => {
              ensureStyle()
              return scope.locale.register(SETTINGS_NS, { zh, en })
            }, 'dsh-desktop-notify: 设置文案')
            scope.effect(
              () =>
                scope.slots.inject('settings.general.item', () =>
                  scope.slots.register(
                    {
                      name: 'settings.general.item',
                      id: 'desktop-notify',
                      order: 17,
                      locale: SETTINGS_NS,
                    },
                    TriggerRow
                  )
                ),
              'dsh-desktop-notify: 设置项'
            )
          })
          diag('settings-registered')
        }
      } catch (error) {
        diag('settings-register-failed', { message: String(error?.message ?? error) })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
