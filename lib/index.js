/**
 * dsh-desktop-notify — Host half.
 *
 * 职责：把浏览器半边发来的「一件事需要你知道」变成 Windows 通知。
 *
 * 为什么不直接在渲染进程用 HTML5 Notification：ds-app 窗口的源是 `dsh-app://app`
 * （由主进程 forward 到本机 Host），Chromium 在 Windows 上发 toast 需要一个已登记到
 * 开始菜单快捷方式的 AppUserModelID；这个 ID 由安装器写进快捷方式，而渲染进程拿不到
 * 也无法自行注册。所以走 Host：用 PowerShell 调 WinRT ToastNotificationManager，
 * 显式指定安装器登记的 AUMID（默认 "DeepSeek Harness"）。AUMID 没登记时回退到
 * CreateToastNotifier() 的进程默认 ID，仍会出现在操作中心（只是署名不同）。
 *
 * 安全边界：这条路由只接受 loopback 上的 POST，body 有上限，并用滑动窗口限流，
 * 避免任何页面通过 DNS rebinding 刷屏。
 */

import { spawn } from 'node:child_process'

/** 插件自有的通知路由；浏览器半边用同一常量发 POST。 */
const ROUTE = '/plugins/dsh-desktop-notify/notify'

/** 安装器写进开始菜单快捷方式的 AppUserModelID（Windows 通知的署名）。 */
const DEFAULT_AUMID = 'DeepSeek Harness'

/** 单次请求体上限；通知内容本来就短，超出的一律拒绝。 */
const MAX_BODY_BYTES = 8 * 1024

/** 限流窗口与窗口内允许的通知条数。 */
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 6

/** 同一 key 的最小间隔，防止状态抖动导致重复弹窗。 */
const SAME_KEY_GAP_MS = 1_500

/** Host 侧只依赖 webServer；没有它插件就静默待命。 */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ aumid?: string, sound?: boolean }} [config]
 */
export function apply(ctx, config) {
  const aumid = typeof config?.aumid === 'string' && config.aumid.trim() !== '' ? config.aumid.trim() : DEFAULT_AUMID
  const sound = config?.sound !== false

  /** 限流状态：窗口起点 + 计数 + 每个 key 的最近一次时间。 */
  const gate = { windowStart: 0, count: 0, keyAt: new Map() }

  /**
   * 判断一次通知是否可以放行。
   * @param {string} key - 调用方给的去重键（可为空）。
   * @returns {{ ok: true } | { ok: false, reason: 'rate-limited' | 'duplicate' }}
   */
  function allow(key) {
    const now = Date.now()
    if (now - gate.windowStart >= WINDOW_MS) {
      gate.windowStart = now
      gate.count = 0
    }
    if (key !== '') {
      const last = gate.keyAt.get(key)
      if (last !== undefined && now - last < SAME_KEY_GAP_MS) return { ok: false, reason: 'duplicate' }
      gate.keyAt.set(key, now)
      if (gate.keyAt.size > 64) {
        for (const [candidate, at] of gate.keyAt) {
          if (now - at >= WINDOW_MS) gate.keyAt.delete(candidate)
        }
      }
    }
    if (gate.count >= MAX_PER_WINDOW) return { ok: false, reason: 'rate-limited' }
    gate.count += 1
    return { ok: true }
  }

  /**
   * 弹一条 Windows 通知。
   * @param {{ title: string, body: string }} message
   */
  function show(message) {
    const script = toastScript(aumid, message.title, message.body, sound)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: 'ignore', detached: false }
      )
      child.on('error', () => {})
      child.unref()
    } catch {
      // PowerShell 不可用时不值得让插件炸掉：调用方还会回退到浏览器通知。
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: createHandler(allow, show),
      }),
    'dsh-desktop-notify: Windows 通知路由'
  )
}

/**
 * 组装路由处理器。
 * @param {(key: string) => { ok: boolean, reason?: string }} allow
 * @param {(message: { title: string, body: string }) => void} show
 */
function createHandler(allow, show) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
          json(res, 413, { error: 'body-too-large' })
          req.destroy()
          return
        }
      }
    } catch {
      return json(res, 400, { error: 'body-unreadable' })
    }

    let doc
    try {
      doc = JSON.parse(raw === '' ? '{}' : raw)
    } catch {
      return json(res, 400, { error: 'invalid-json' })
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return json(res, 400, { error: 'invalid-body' })

    const title = clamp(doc.title, 120) || 'DeepSeek Harness'
    const body = clamp(doc.body, 400)
    const key = clamp(doc.key, 200)
    if (body === '' && title === '') return json(res, 400, { error: 'empty-notification' })

    const verdict = allow(key)
    if (!verdict.ok) return json(res, 200, { ok: false, skipped: verdict.reason })

    show({ title, body })
    return json(res, 200, { ok: true })
  }
}

/**
 * 只信任 loopback 上的请求：Host 必须是本机名，带了 Origin 时也必须是本机。
 * 浏览器同源 fetch 不带 Origin，因此仅凭 Host 就能挡掉 DNS rebinding 页面。
 * @param {import('node:http').IncomingMessage} req
 */
function trustedRequest(req) {
  if (!hostIsLoopback(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    return hostIsLoopback(url.host)
  } catch {
    return false
  }
}

/**
 * @param {string | undefined} hostHeader
 */
function hostIsLoopback(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  const bare = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.split(':')[0]
  const host = bare.toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * @param {NodeJS.WritableStream & { writeHead: Function, end: Function }} res
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
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clamp(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * PowerShell 脚本：WinRT toast，AUMID 优先，失败回退进程默认。
 * 用 -EncodedCommand 传（UTF-16LE base64），避免中文与引号的转义问题。
 * @param {string} aumid
 * @param {string} title
 * @param {string} body
 * @param {boolean} sound
 */
function toastScript(aumid, title, body, sound) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Default" />' : '<audio silent="true" />'
  const xml = `<toast activationType="foreground"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual>${audio}</toast>`
  const id = aumid.replace(/'/gu, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    `$xml = '${xml.replace(/'/gu, "''")}'`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    'try {',
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${id}').Show($toast)`,
    '} catch {',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier().Show($toast)',
    '}',
  ].join('\n')
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
