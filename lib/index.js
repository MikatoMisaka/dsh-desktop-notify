/**
 * dsh-desktop-notify — Host 半边。
 *
 * 职责：把浏览器半边发来的「一件事需要你知道」变成 Windows 通知，并记住**每一条**通知
 * 是谁的——用户点哪条，就把窗口拉到前台并跳到哪条对应的会话。
 *
 * 为什么不在渲染进程直接用 HTML5 Notification：dsh-app 窗口的源是 `dsh-app://app`
 * （主进程 forward 到本机 Host），Chromium 在 Windows 上发 toast 需要登记到开始菜单
 * 快捷方式的 AppUserModelID；这个 ID 在渲染进程里拿不到也注册不了。所以走 Host：
 * 用 PowerShell 调 WinRT ToastNotificationManager，AUMID 取安装器登记的 com.deepseek.dsh
 * （写错时 CreateToastNotifier 不报错、只静默丢弃——见 README 的踩坑记录）。
 *
 * 点击链路：toast 用 activationType="protocol"，launch 指向 `dsh-notify://focus?t=<token>`。
 * 该协议由本插件登记，指向预编译的 bin/focus-window.exe —— 用户点击直接拉起的进程天生
 * 带前台权限，restore + 置顶一次做完（约 90ms）。exe 顺手把 token 写进 click.json，
 * 浏览器半边据此知道**被点的是哪一条**，也才不会把"自己切回窗口"误当成点击。
 * 协议装不上时退回 DSH 自己的 `dsh://open`（慢，但没有 token，只能按"最近一条"跳）。
 *
 * 安全边界：路由只接受本机地址、拒绝 cross-site、POST 必须 application/json，
 * body 有上限，滑动窗口限流 + 同 key 去重。
 */

import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 点通知时交给 Windows 的 URI 前缀；真实 URI 会带上一次性 token。 */
const ACTIVATION_URI = 'dsh-notify://focus'

/** 没有预编译 exe 时的退路：DSH 自己登记的协议。 */
const ACTIVATION_FALLBACK_URI = 'dsh://open'

/** 预编译的置顶程序（免掉 PowerShell 每次启动 + Add-Type 编译）。 */
const FOCUS_EXE = fileURLToPath(new URL('../bin/focus-window.exe', import.meta.url))

/** 前台辅助脚本：没有 exe 时的退路。 */
const FOCUS_SCRIPT = fileURLToPath(new URL('../scripts/focus-window.ps1', import.meta.url))

/** 我们自己的协议名；登记在 HKCU 下，指向 FOCUS_EXE。 */
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-notify'

/** 安装器写进开始菜单快捷方式的 AppUserModelID（Windows 通知的署名）。 */
const DEFAULT_AUMID = 'com.deepseek.dsh'

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

/** click.json 的保鲜期：点完半分钟还没被消费就不再算数。 */
const CLICK_TTL_MS = 30_000

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
 *   notifyWhenFocused?: boolean, protocol?: boolean,
 * }} [config]
 */
export function apply(ctx, config) {
  const aumid = typeof config?.aumid === 'string' && config.aumid.trim() !== '' ? config.aumid.trim() : DEFAULT_AUMID
  const sound = config?.sound !== false
  const debug = config?.debug !== false
  const trigger = config?.notifyWhenFocused === true ? 'always' : normalizeTrigger(config?.trigger)

  /** 日志目录（%LOCALAPPDATA% 为空时用家目录，别退化成相对路径）。 */
  const dataDir = join(process.env.LOCALAPPDATA || homedir() || '.', 'dsh-desktop-notify')
  const hostLog = join(dataDir, 'host.log')
  const clickFile = join(dataDir, 'click.json')

  /** 通知限流状态。 */
  const gate = { windowStart: 0, count: 0, keyAt: new Map() }
  /** 诊断日志的独立配额。 */
  const logGate = { windowStart: 0, count: 0 }

  /** token -> { sessionId, at }。一条通知一个 token，点哪条跳哪条。 */
  const pending = new Map()

  const hasFocusExe = existsSync(FOCUS_EXE)
  const protocolRegistered = hasFocusExe && config?.protocol !== false ? registerProtocol() : false

  record({
    kind: 'protocol',
    registered: protocolRegistered,
    exe: hasFocusExe,
    ...protocolRegistered ? {} : { uri: ACTIVATION_FALLBACK_URI },
  })

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
      appendFileSync(hostLog, `${JSON.stringify({ t: new Date().toISOString(), aumid, ...entry })}\n`, 'utf8')
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

  /** 被点过的通知：把 token 换成会话。没有点击记录就返回 null。 */
  function consumeClick() {
    let click
    try {
      const doc = JSON.parse(readFileSync(clickFile, 'utf8'))
      if (typeof doc?.t === 'string' && typeof doc?.at === 'number') click = { token: doc.t, at: doc.at }
    } catch {
      return null
    }
    if (click === undefined) return null
    if (Date.now() - click.at > CLICK_TTL_MS) return { token: click.token, sessionId: null, stale: true }
    const entry = pending.get(click.token)
    return { token: click.token, sessionId: entry?.sessionId ?? null, stale: false }
  }

  function clearClick(token) {
    try {
      if (token !== '') {
        const doc = JSON.parse(readFileSync(clickFile, 'utf8'))
        if (typeof doc?.t === 'string' && doc.t !== token) return
      }
      unlinkSync(clickFile)
    } catch {
      // 没有文件就是已经清过了。
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

  /**
   * 弹一条 Windows 通知，并如实报告成败。
   * spawn 对不存在的程序不抛（ENOENT 异步到达），所以必须等 exit 才算数。
   * @param {{ title: string, body: string, launch: string }} message
   * @returns {Promise<boolean>}
   */
  function show(message) {
    const script = toastScript(aumid, message.title, message.body, sound, message.launch)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, stdio: 'ignore' }
        )
        child.on('error', (error) => {
          record({ kind: 'notify-spawn-error', message: String(error?.message ?? error) })
          finish(false)
        })
        child.on('exit', (code) => {
          record({ kind: 'notify-exit', code })
          finish(code === 0)
        })
        // 兜底：PowerShell 卡住时别把 HTTP 请求挂在外面。
        setTimeout(() => finish(false), 2500)
      } catch (error) {
        record({ kind: 'notify-spawn-throw', message: String(error?.message ?? error) })
        finish(false)
      }
    })
  }

  function focusForeground() {
    const command = hasFocusExe ? FOCUS_EXE : 'powershell.exe'
    const args = hasFocusExe
      ? []
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', FOCUS_SCRIPT, '-Quiet']
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: false })
      child.on('error', (error) => record({ kind: 'focus-spawn-error', message: String(error?.message ?? error) }))
      child.on('exit', (code) => record({ kind: 'focus-exit', code }))
      child.unref()
      record({ kind: 'focus-requested', via: hasFocusExe ? 'exe' : 'powershell' })
      return true
    } catch (error) {
      record({ kind: 'focus-spawn-throw', message: String(error?.message ?? error) })
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: createNotifyHandler({
          allow,
          show,
          record,
          remember,
          nextToken: () => randomBytes(8).toString('hex'),
          launchFor: (token) =>
            token !== '' && protocolRegistered ? `${ACTIVATION_URI}?t=${token}` : ACTIVATION_FALLBACK_URI,
        }),
      }),
    'dsh-desktop-notify: Windows 通知路由'
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
          return json(res, 200, { trigger, sound, aumid, protocol: protocolRegistered })
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
          return json(res, 200, { ok: focusForeground() })
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
            clearClick(token)
            if (token !== '') pending.delete(token)
            else pending.clear() // 没有 token 就是"全都清掉"，给退路模式用
            return json(res, 200, { ok: true })
          }

          if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })

          // 只读：真点击必须能被重复问（上一次导航失败时要能重试）。
          const click = consumeClick()
          if (click !== null) {
            return json(res, 200, {
              sessionId: click.sessionId,
              token: click.token,
              source: 'click',
              ageMs: Date.now() - click.at,
            })
          }

          // 退路模式（协议没登记）拿不到 token，只能按"最近一条"跳；这会带来
          // "自己切回窗口也跳"的老毛病，但好过完全不能跳。
          if (!protocolRegistered) {
            const newest = latestPending()
            return json(res, 200, { sessionId: newest === null ? null : newest.sessionId, token: null, source: 'legacy' })
          }

          return json(res, 200, { sessionId: null, token: null, source: 'none' })
        },
      }),
    'dsh-desktop-notify: 待跳转会话路由'
  )

  record({ kind: 'host-ready', pid: process.pid, trigger })
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
 * 组装通知路由处理器。
 * @param {{
 *   allow: (key: string) => { ok: boolean, reason?: string },
 *   show: (message: { title: string, body: string, launch: string }) => Promise<boolean>,
 *   record: (entry: object) => void,
 *   remember: (token: string, sessionId: string) => void,
 *   nextToken: () => string,
 *   launchFor: (token: string) => string,
 * }} deps
 */
function createNotifyHandler(deps) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    if (!trustedRequest(req) || !jsonContentType(req)) return json(res, 403, { error: 'request-not-trusted' })

    const body = await readJson(req, res)
    if (body === undefined) return

    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const rawBody = typeof body.body === 'string' ? body.body.trim() : ''
    if (rawTitle === '' && rawBody === '') return json(res, 400, { error: 'empty-notification' })

    const title = clamp(rawTitle, 120) || 'DeepSeek Harness'
    const text = clamp(rawBody, 400)
    const key = clamp(body.key, 200)
    const sessionId = clamp(body.sessionId, 200)

    const verdict = deps.allow(key)
    if (!verdict.ok) {
      deps.record({ kind: 'notify-skipped', reason: verdict.reason, key, title })
      return json(res, 200, { ok: false, skipped: verdict.reason })
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

/**
 * PowerShell 脚本：WinRT toast，点击走协议激活。
 * 用 -EncodedCommand 传（UTF-16LE base64），避免中文与引号的转义问题。
 * @param {string} aumid
 * @param {string} title
 * @param {string} body
 * @param {boolean} sound
 * @param {string} launch - 点击时交给 Windows 的 URI（带 token）
 */
function toastScript(aumid, title, body, sound, launch) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Default" />' : '<audio silent="true" />'
  const xml =
    `<toast activationType="protocol" launch="${xmlEscape(launch)}">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
    `</binding></visual>${audio}</toast>`
  const id = aumid.replace(/'/gu, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    `$xml = '${xml.replace(/'/gu, "''")}'`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${id}').Show($toast)`,
  ].join('\n')
}

/**
 * 登记 `dsh-notify:` 协议到 HKCU，指向预编译的置顶程序。
 *
 * 不做"先 query 比对"：reg.exe 按控制台代码页输出，中文路径用 latin1/utf8 读回都是
 * 乱码，会把"已登记"误判成"没登记"，进而永久退化到慢路径。写三条 reg add 只要几十
 * 毫秒，幂等且没有编码问题。
 * @returns {boolean}
 */
function registerProtocol() {
  const expected = `"${FOCUS_EXE}" "%1"`
  const options = { windowsHide: true, stdio: 'ignore', timeout: 2000 }
  try {
    execFileSync('reg', ['add', PROTOCOL_KEY, '/ve', '/d', 'URL:dsh-notify', '/f'], options)
    execFileSync('reg', ['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/d', '', '/f'], options)
    execFileSync('reg', ['add', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/d', expected, '/f'], options)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} value
 */
function xmlEscape(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}
