/**
 * dsh-desktop-notify — Host 半边（跨平台主干）。
 *
 * 这个文件只放**与平台无关**的东西：路由、限流、同 key 去重、回复预览、诊断日志、
 * 来源校验。至于"通知怎么弹、点了怎么回到会话"，一律交给 `./platform/` 下的适配器：
 *
 *   platform/windows.js     WinRT toast + AUMID 核对 + dsh-notify: 协议 + 预编译置顶程序
 *   platform/delegated.js   非 Windows：不弹，把正文回给浏览器半边自己弹
 *
 * 为什么要分 Windows / 非 Windows：Windows 上 Chromium 发 toast 必须挂在登记到开始
 * 菜单的 AppUserModelID 上，而那个 ID 渲染进程拿不到，所以只能绕 Host + PowerShell；
 * 点击又发生在操作系统层面，只能靠协议拉起 exe 写 click.json 再把 token 传回渲染进程。
 * macOS 没有这些限制：渲染进程直接 `new Notification()`，点击就是本进程的事件，
 * sessionId 当场在手上——所以那边只需要"Host 拼好正文、回给渲染进程"。
 *
 * 安全边界：路由只接受本机地址、拒绝 cross-site、POST 必须 application/json，
 * body 有上限，滑动窗口限流 + 同 key 去重。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createPlatformHost } from './platform/index.js'

/** 插件自有的通知路由；浏览器半边用同一常量发 POST。 */
const ROUTE = '/plugins/dsh-desktop-notify/notify'

/** 浏览器半边的排障日志路由（和 Host 日志写同一个文件）。 */
const LOG_ROUTE = '/plugins/dsh-desktop-notify/log'

/** 浏览器半边启动时读一次的行为配置。 */
const CONFIG_ROUTE = '/plugins/dsh-desktop-notify/config'

/** 「刚才被点的是哪条通知」：GET 只读，POST 才消费。 */
const PENDING_ROUTE = '/plugins/dsh-desktop-notify/pending'

/** 把窗口强制拉到前台的辅助路由。 */
const FOCUS_ROUTE = '/plugins/dsh-desktop-notify/focus'

/** 单次请求体上限；通知内容本来就短。 */
const MAX_BODY_BYTES = 8 * 1024

/** 通知限流：窗口 / 条数；同 key 最小间隔。 */
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 6
const SAME_KEY_GAP_MS = 1_500

/** 诊断日志的独立配额（比通知宽松，但也不给刷爆的机会）。 */
const MAX_LOGS_PER_WINDOW = 30

/** 待跳转记录的保鲜期，以及最多同时记住几条通知。 */
const PENDING_TTL_MS = 60_000
const MAX_PENDING = 16

/**
 * 回复预览：每轮结束时把最后一条 assistant 文本按会话记下来，通知正文用它。
 * 10 分钟足够覆盖"切走一会儿再回来看通知"，超过就只留"这一轮已经跑完"。
 */
const PREVIEW_TTL_MS = 10 * 60_000
const MAX_PREVIEWS = 32
/** 预览正文的字数上限（toast 正文再长也会被折叠）。 */
const PREVIEW_CHARS = 180

/** 日志轮转阈值。 */
const MAX_LOG_BYTES = 1_000_000

/** 允许从浏览器半边透传进日志的字段（其余一律丢弃，防止伪造 Host 记录）。 */
const CLIENT_LOG_FIELDS = [
  'event',
  'side',
  'sessionId',
  'transition',
  'action',
  'trigger',
  'label',
  'message',
  'reason',
  'minimized',
  'focused',
  'visibility',
  'sessions',
  'title',
]

/** Host 侧只依赖 webServer；没有它插件静默待命。 */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   aumid?: string, sound?: boolean, debug?: boolean,
 *   trigger?: 'minimized' | 'unfocused' | 'always',
 *   notifyWhenFocused?: boolean, protocol?: boolean, fallbackAumid?: string,
 *   platform?: 'win32' | 'darwin' | 'linux', dataDir?: string, dryRun?: boolean,
 * }} [config]
 */
export function apply(ctx, config) {
  const sound = config?.sound !== false
  const debug = config?.debug !== false
  /**
   * 测试/CI 用：走完整流程但不真的弹窗（Windows 上不 spawn PowerShell）。
   * 自动化跑 selftest 时默认开启，避免往用户桌面弹测试通知。
   */
  const dryRun = config?.dryRun === true
  const trigger = config?.notifyWhenFocused === true ? 'always' : normalizeTrigger(config?.trigger)

  /** 平台适配器：路径、能力、弹窗方式都在它里面，主干只按契约调用。 */
  const runtime = createPlatformHost(config)
  const platform = runtime.id
  const dataDir = runtime.dataDir
  const hostLog = join(dataDir, 'host.log')

  /** 通知限流状态。 */
  const gate = { windowStart: 0, count: 0, keyAt: new Map() }
  /** 诊断日志的独立配额。 */
  const logGate = { windowStart: 0, count: 0 }

  /** token -> { sessionId, at }。一条通知一个 token，点哪条跳哪条。 */
  const pending = new Map()

  /** sessionId -> { text, at }：每轮结束时的最后一条回复，用来做通知预览。 */
  const previews = new Map()

  /**
   * 记录一轮结束时最后一条 assistant 文本。
   *
   * 读法用 `session.deriveMessages()`——这是 DSH 支持的投影读法（官方
   * `dsh-web-deepseek-api` 也这么读）。早先那份第三方插件用的
   * `snapshotEvents()` / `eventAt()` 已被官方标记为"弃用、禁止新增调用"。
   * @param {string} sessionId
   * @param {string} text
   */
  function rememberPreview(sessionId, text) {
    const now = Date.now()
    previews.set(sessionId, { text, at: now })
    for (const [id, entry] of previews) {
      if (now - entry.at > PREVIEW_TTL_MS) previews.delete(id)
    }
    while (previews.size > MAX_PREVIEWS) {
      const oldest = previews.keys().next().value
      if (oldest === undefined) break
      previews.delete(oldest)
    }
  }

  /**
   * @param {string} sessionId
   * @returns {string} 新鲜的预览文本，没有则空串
   */
  function previewFor(sessionId) {
    if (sessionId === '') return ''
    const entry = previews.get(sessionId)
    if (entry === undefined) return ''
    if (Date.now() - entry.at > PREVIEW_TTL_MS) {
      previews.delete(sessionId)
      return ''
    }
    return entry.text
  }

  /**
   * 完成通知的正文：有预览就用预览，没有就退回固定文案。
   * @param {string} label - 会话名
   * @param {string} preview - 回复预览
   * @returns {string}
   */
  function composeCompleteBody(label, preview) {
    if (preview !== '') return label === '' ? preview : `${label}：${preview}`
    if (label === '') return '会话已经跑完这一轮。'
    return `${label}：这一轮已经跑完。`
  }

  /** 追加一行日志；超过阈值轮转一次。失败静默：日志不能反过来害插件。 */
  function record(entry) {
    if (!debug) return
    try {
      mkdirSync(dataDir, { recursive: true })
      try {
        if (statSync(hostLog).size > MAX_LOG_BYTES) renameSync(hostLog, `${hostLog}.1`)
      } catch {
        // 文件还不存在，正常。
      }
      const aumid = runtime.currentAumid()
      const line = { t: new Date().toISOString(), ...aumid === null ? {} : { aumid }, ...entry }
      appendFileSync(hostLog, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // 写不进去就算了。
    }
  }

  function allow(key) {
    const now = Date.now()
    if (now - gate.windowStart >= WINDOW_MS) {
      gate.windowStart = now
      gate.count = 0
    }
    if (gate.count >= MAX_PER_WINDOW) return { ok: false, reason: 'rate-limited' }
    if (key !== '') {
      const last = gate.keyAt.get(key)
      if (last !== undefined && now - last < SAME_KEY_GAP_MS) return { ok: false, reason: 'duplicate' }
      gate.keyAt.set(key, now)
      if (gate.keyAt.size > 64) {
        for (const [candidate, at] of gate.keyAt) {
          if (now - at >= SAME_KEY_GAP_MS) gate.keyAt.delete(candidate)
        }
      }
    }
    gate.count += 1
    return { ok: true }
  }

  function allowLog() {
    const now = Date.now()
    if (now - logGate.windowStart >= WINDOW_MS) {
      logGate.windowStart = now
      logGate.count = 0
    }
    if (logGate.count >= MAX_LOGS_PER_WINDOW) return false
    logGate.count += 1
    return true
  }

  function remember(token, sessionId) {
    if (token === '' || sessionId === '') return
    const now = Date.now()
    pending.set(token, { sessionId, at: now })
    for (const [candidate, entry] of pending) {
      if (now - entry.at > PENDING_TTL_MS) pending.delete(candidate)
    }
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      pending.delete(oldest)
    }
  }

  /** 最近一条还没过期的通知（退路模式没有 token 可用）。 */
  function latestPending() {
    const now = Date.now()
    let newest = null
    for (const entry of pending.values()) {
      if (now - entry.at > PENDING_TTL_MS) continue
      if (newest === null || entry.at > newest.at) newest = entry
    }
    return newest
  }

  // 平台适配器自己的装载副作用：Windows 那边是「探一次 AUMID + 登记协议」，
  // 非 Windows 只记一条"协议不适用"。放在 record 定义之后调用。
  runtime.start({ record, dryRun, sound })

  // 一轮结束时把最后一条回复记下来，给通知正文当预览。`agent/status` 的根事件带
  // agent（官方 api-session-controller 同样这么用），agent.session 是会话本体。
  ctx.effect(
    () =>
      ctx.on('agent/status', ({ agent, status } = {}) => {
        if (status !== 'idle') return
        const session = agent?.session
        if (session?.header?.origin === 'subagent') return
        const sessionId =
          typeof agent?.id === 'string' && agent.id !== '' ? agent.id : session?.header?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        const text = lastAssistantText(session)
        if (text !== '') rememberPreview(sessionId, clamp(text, PREVIEW_CHARS))
      }),
    'dsh-desktop-notify: 记录回复预览'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: createNotifyHandler({
          allow,
          show: (message) => runtime.show(message),
          record,
          remember,
          previewFor,
          composeCompleteBody,
          nextToken: () => randomBytes(8).toString('hex'),
          delegate: runtime.delegate,
          launchFor: (token) => runtime.launchFor(token),
        }),
      }),
    'dsh-desktop-notify: 通知路由'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LOG_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
          if (!allowLog()) return json(res, 200, { ok: false, skipped: 'rate-limited' })
          const body = await readJson(req, res)
          if (body === undefined) return
          const picked = {}
          for (const field of CLIENT_LOG_FIELDS) {
            if (body[field] !== undefined) picked[field] = body[field]
          }
          record({ kind: 'client', ...picked })
          return json(res, 200, { ok: true })
        },
      }),
    'dsh-desktop-notify: 排障日志路由'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CONFIG_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
          return json(res, 200, {
            trigger,
            sound,
            ...runtime.describe(),
            capabilities: runtime.capabilities,
          })
        },
      }),
    'dsh-desktop-notify: 配置路由'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FOCUS_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
          if (!trustedRequest(req) || !jsonContentType(req)) return json(res, 403, { error: 'request-not-trusted' })
          // 非 Windows 的点击由渲染进程自己处理（系统已经激活 App），Host 无事可做。
          if (runtime.delegate !== null) return json(res, 200, { ok: false, delegate: platform })
          return json(res, 200, { ok: runtime.focus() })
        },
      }),
    'dsh-desktop-notify: 前台路由'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PENDING_ROUTE,
        handler: async (req, res) => {
          if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })

          if (req.method === 'POST') {
            if (!jsonContentType(req)) return json(res, 403, { error: 'request-not-trusted' })
            const body = await readJson(req, res)
            if (body === undefined) return
            const token = clamp(body.token, 64)
            runtime.clearClick(token)
            if (token !== '') pending.delete(token)
            else pending.clear() // 没有 token 就是"全都清掉"，给退路模式用
            return json(res, 200, { ok: true })
          }

          if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })

          // 只读：真点击必须能被重复问（上一次导航失败时要能重试）。
          // Windows 走 click.json（exe 写的），其它平台没有这个文件，永远是 null。
          const click = runtime.consumeClick()
          if (click !== null) {
            const ageMs = Date.now() - click.at
            const fresh = ageMs <= runtime.clickTtlMs
            const entry = fresh ? pending.get(click.token) : undefined
            return json(res, 200, {
              sessionId: entry?.sessionId ?? null,
              token: click.token,
              source: 'click',
              ageMs,
            })
          }

          // 退路模式（协议没登记）拿不到 token，只能按"最近一条"跳；这会带来
          // "自己切回窗口也跳"的老毛病，但好过完全不能跳。
          if (!runtime.protocolRegistered) {
            const newest = latestPending()
            return json(res, 200, { sessionId: newest === null ? null : newest.sessionId, token: null, source: 'legacy' })
          }

          return json(res, 200, { sessionId: null, token: null, source: 'none' })
        },
      }),
    'dsh-desktop-notify: 待跳转会话路由'
  )

  record({ kind: 'host-ready', pid: process.pid, platform, trigger })
}

/**
 * 组装通知路由处理器。
 * @param {{
 *   allow: (key: string) => { ok: boolean, reason?: string },
 *   show: (message: { title: string, body: string, launch: string }) => Promise<boolean>,
 *   record: (entry: object) => void,
 *   remember: (token: string, sessionId: string) => void,
 *   previewFor: (sessionId: string) => string,
 *   composeCompleteBody: (label: string, preview: string) => string,
 *   nextToken: () => string,
 *   launchFor: (token: string) => string,
 *   delegate?: string | null,
 * }} deps
 */
function createNotifyHandler(deps) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    if (!trustedRequest(req) || !jsonContentType(req)) return json(res, 403, { error: 'request-not-trusted' })

    const body = await readJson(req, res)
    if (body === undefined) return

    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const key = clamp(body.key, 200)
    const sessionId = clamp(body.sessionId, 200)
    const kind = clamp(body.kind, 20)

    // 「这一轮跑完了」这类通知，正文用 Host 侧记下的回复预览；没有预览才退回固定文案。
    // 其它通知（提问 / 确认）沿用浏览器半边拼好的正文。
    let text
    if (kind === 'complete') {
      const preview = body.preview === true ? deps.previewFor(sessionId) : ''
      text = clamp(deps.composeCompleteBody(clamp(body.label, 80), preview), 400)
    } else {
      text = clamp(typeof body.body === 'string' ? body.body : '', 400)
    }

    if (rawTitle === '' && text === '') return json(res, 400, { error: 'empty-notification' })

    const title = clamp(rawTitle, 120) || 'DeepSeek Harness'

    const verdict = deps.allow(key)
    if (!verdict.ok) {
      deps.record({ kind: 'notify-skipped', reason: verdict.reason, key, title })
      return json(res, 200, { ok: false, skipped: verdict.reason })
    }

    // 非 Windows（目前是 macOS）：Host 只负责拼正文、限流、去重，真正的弹窗交给
    // 浏览器半边用系统通知 API 完成。好处是点击事件留在渲染进程里，可以直接跳会话，
    // 不需要协议、AUMID、预编译置顶程序这一整套 Windows 机制。
    if (typeof deps.delegate === 'string' && deps.delegate !== '') {
      deps.record({ kind: 'notify-delegated', platform: deps.delegate, key, title, body: text.slice(0, 120), sessionId })
      return json(res, 200, { ok: true, delegate: deps.delegate, title, body: text, sessionId })
    }

    const token = sessionId === '' ? '' : deps.nextToken()
    const ok = await deps.show({ title, body: text, launch: deps.launchFor(token) })
    if (!ok) {
      deps.record({ kind: 'notify-failed', key, title, sessionId })
      // 告诉浏览器半边"没发出去"，让它走 new Notification() 兜底，别把提醒悄悄吞掉。
      return json(res, 503, { ok: false, error: 'notifier-unavailable' })
    }
    deps.remember(token, sessionId)
    deps.record({ kind: 'notify', key, title, body: text.slice(0, 120), sessionId, token })
    return json(res, 200, { ok: true })
  }
}

/**
 * 取会话里最后一条 assistant 文本（用于通知预览）。
 *
 * 用 `session.deriveMessages()` —— DSH 支持的投影读法，官方 `dsh-web-deepseek-api`
 * 也这样读消息；不要用 `snapshotEvents()` / `eventAt()`，那两个已被标记弃用。
 * @param {unknown} session
 * @returns {string}
 */
function lastAssistantText(session) {
  try {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      const text = message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text !== '') return text
    }
  } catch {
    // 投影读失败就当没有预览，通知照发。
  }
  return ''
}

/**
 * @param {unknown} value
 * @returns {'minimized' | 'unfocused' | 'always'}
 */
function normalizeTrigger(value) {
  if (value === 'minimized' || value === 'unfocused' || value === 'always') return value
  return 'unfocused'
}

/**
 * 读一个 JSON body；出错时自己把响应写完并返回 undefined。
 * 先收 Buffer 再解码：逐 chunk toString 会把跨 TCP 边界的中文劈成 U+FFFD。
 * @param {import('node:http').IncomingMessage} req
 * @param {object} res
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function readJson(req, res) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        json(res, 413, { error: 'body-too-large' })
        req.destroy()
        return undefined
      }
      chunks.push(buffer)
    }
  } catch {
    json(res, 400, { error: 'body-unreadable' })
    return undefined
  }
  let doc
  try {
    doc = JSON.parse(chunks.length === 0 ? '{}' : Buffer.concat(chunks).toString('utf8'))
  } catch {
    json(res, 400, { error: 'invalid-json' })
    return undefined
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    json(res, 400, { error: 'invalid-body' })
    return undefined
  }
  return doc
}

/**
 * 只信任本机来源：
 *  - Host 必须是 IP 字面量或 localhost（DNS rebinding 的 Host 是攻击者域名，会被挡）；
 *  - 拒绝 sec-fetch-site: cross-site；
 *  - 带了 Origin 时必须与 Host 同 authority（或就是 dsh-app://app）。
 * 浏览器同源 fetch 通常不带 Origin，只靠 Host 判据也能过。
 * @param {import('node:http').IncomingMessage} req
 */
function trustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (!isLocalAuthority(host)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  // 自定义协议/沙箱上下文会发 "null"；JSON Content-Type 那道闸已经挡住了 no-cors 伪造。
  if (origin === 'null') return true
  if (origin === 'dsh-app://app') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Host 是否指向本机（IP 字面量或 localhost）。
 * 允许局域网 IP：DSH 可以绑到 192.168.x.x，那种部署下同源请求的 Host 就是它。
 * @param {string} hostHeader
 */
function isLocalAuthority(hostHeader) {
  let host = hostHeader
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end < 0) return false
    return host.slice(1, end).includes(':')
  }
  const colon = host.lastIndexOf(':')
  if (colon > 0) host = host.slice(0, colon)
  host = host.toLowerCase()
  if (host === 'localhost') return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (part === '' || part.length > 3) return false
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255
  })
}

/**
 * POST 必须声明 application/json。浏览器在 no-cors 下无法设置这个头，
 * 这一条就挡住了"任意本机页面伪造通知"的路。
 * @param {import('node:http').IncomingMessage} req
 */
function jsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().startsWith('application/json')
}

/**
 * @param {object} res
 * @param {number} status
 * @param {object} value
 */
function json(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * 归一化外部文本：折叠空白、剔除 XML 1.0 不接受的控制字符（否则整条 toast 会被
 * LoadXml 拒掉、一条都不显示）、截断。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clamp(value, max) {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
