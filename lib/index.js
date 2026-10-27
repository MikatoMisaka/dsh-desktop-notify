/**
 * dsh-desktop-notify — Host half.
 *
 * 职责：把浏览器半边发来的「一件事需要你知道」变成 Windows 通知。
 *
 * 为什么不直接在渲染进程用 HTML5 Notification：dsh-app 窗口的源是 `dsh-app://app`
 * （由主进程 forward 到本机 Host），Chromium 在 Windows 上发 toast 需要一个登记到
 * 开始菜单快捷方式的 AppUserModelID；这个 ID 在渲染进程里既拿不到也注册不了。
 * 所以走 Host：用 PowerShell 调 WinRT ToastNotificationManager。
 *
 * AUMID 的坑（v0.1 踩过）：字符串写错时 `CreateToastNotifier` **不报错**，只是把
 * toast 静默丢弃——路由返回 200、桌面一片安静。所以默认值取自开始菜单快捷方式的
 * `System.AppUserModel.ID`，也就是安装器登记的 `com.deepseek.dsh`；换品牌/换构筑时
 * 用 config.aumid 覆盖，或用 `scripts/read-aumid.ps1` 现查。
 *
 * 安全边界：路由只接受 loopback 上的 POST，body 有上限，滑动窗口限流 + 同 key 去重，
 * 避免任何页面通过 DNS rebinding 刷屏。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件自有的通知路由；浏览器半边用同一常量发 POST。 */
const ROUTE = '/plugins/dsh-desktop-notify/notify'

/** 浏览器半边的排障日志路由（和 Host 日志追加到同一个文件）。 */
const LOG_ROUTE = '/plugins/dsh-desktop-notify/log'

/** 浏览器半边启动时读一次的行为配置，保证两半对"什么时候该弹"看法一致。 */
const CONFIG_ROUTE = '/plugins/dsh-desktop-notify/config'

/** 安装器写进开始菜单快捷方式的 AppUserModelID（Windows 通知的署名）。 */
const DEFAULT_AUMID = 'com.deepseek.dsh'

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
 * @param {{ aumid?: string, sound?: boolean, debug?: boolean }} [config]
 */
export function apply(ctx, config) {
  const aumid = typeof config?.aumid === 'string' && config.aumid.trim() !== '' ? config.aumid.trim() : DEFAULT_AUMID
  const sound = config?.sound !== false
  const debug = config?.debug !== false
  /**
   * 你在前台盯着这个会话时还弹不弹。默认不弹（你在看，别打扰）；
   * 想在"就开着窗口"的状态下也收到提醒，就把它设成 true。
   */
  const notifyWhenFocused = config?.notifyWhenFocused === true

  /** 限流状态：窗口起点 + 计数 + 每个 key 的最近一次时间。 */
  const gate = { windowStart: 0, count: 0, keyAt: new Map() }

  /** 排障日志：一行一个 JSON，追加写，失败静默（日志不能反过来害插件）。 */
  function record(entry) {
    if (!debug) return
    try {
      const dir = join(process.env.LOCALAPPDATA ?? homedir() ?? '.', 'dsh-desktop-notify')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'host.log'), `${JSON.stringify({ t: new Date().toISOString(), aumid, ...entry })}\n`, 'utf8')
    } catch {
      // 写不进去就算了，绝不能影响通知本身。
    }
  }

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
   * @returns {boolean} 是否成功把 PowerShell 子进程拉起来
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
      child.on('error', (error) => record({ kind: 'spawn-error', message: String(error?.message ?? error) }))
      child.unref()
      return true
    } catch (error) {
      record({ kind: 'spawn-throw', message: String(error?.message ?? error) })
      return false
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: createNotifyHandler(allow, show, record),
      }),
    'dsh-desktop-notify: Windows 通知路由'
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LOG_ROUTE,
        handler: createLogHandler(record),
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
          return json(res, 200, { notifyWhenFocused, sound, aumid })
        },
      }),
    'dsh-desktop-notify: 配置路由'
  )

  record({ kind: 'host-ready', pid: process.pid, notifyWhenFocused })
}

/**
 * 组装通知路由处理器。
 * @param {(key: string) => { ok: boolean, reason?: string }} allow
 * @param {(message: { title: string, body: string }) => boolean} show
 * @param {(entry: object) => void} record
 */
function createNotifyHandler(allow, show, record) {
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
    if (!verdict.ok) {
      record({ kind: 'notify-skipped', reason: verdict.reason, key, title })
      return json(res, 200, { ok: false, skipped: verdict.reason })
    }

    const spawned = show({ title, body })
    record({ kind: 'notify', key, title, body, spawned })
    return json(res, 200, { ok: spawned })
  }
}

/**
 * 组装日志路由：浏览器半边把判定过程写进同一个文件，事后能复盘。
 * @param {(entry: object) => void} record
 */
function createLogHandler(record) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
          req.destroy()
          return json(res, 413, { error: 'body-too-large' })
        }
      }
      const doc = JSON.parse(raw === '' ? '{}' : raw)
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) record({ kind: 'client', ...doc })
      return json(res, 200, { ok: true })
    } catch {
      return json(res, 400, { error: 'invalid-body' })
    }
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
 * PowerShell 脚本：WinRT toast。AUMID 由调用方给出（默认安装器登记的那个）。
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
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${id}').Show($toast)`,
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
