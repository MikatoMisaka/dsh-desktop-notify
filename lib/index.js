/**
 * dsh-desktop-notify — Host half.
 *
 * 职责：把浏览器半边发来的「一件事需要你知道」变成 Windows 通知，并记住"这条通知
 * 是谁的、点了该跳到哪"。
 *
 * 为什么不直接在渲染进程用 HTML5 Notification：dsh-app 窗口的源是 `dsh-app://app`
 * （由主进程 forward 到本机 Host），Chromium 在 Windows 上发 toast 需要一个登记到
 * 开始菜单快捷方式的 AppUserModelID；这个 ID 在渲染进程里既拿不到也注册不了。
 * 所以走 Host：用 PowerShell 调 WinRT ToastNotificationManager。
 *
 * 点击行为：toast 用 `activationType="protocol"`，launch 指向 `dsh-notify://focus`。
 * 这个协议由本插件登记，指向预编译的 `bin/focus-window.exe`——用户点击直接拉起的进程
 * 天生带前台权限，所以 restore + 置顶一次做完（实测约 90ms）。
 *
 * 早先用的是 DSH 自己的 `dsh://open`：那要启动一个完整的第二个 Electron 进程才走到
 * 单实例检查，再让旧进程 restore+show；光是"把窗口叫出来"就付一次应用启动的成本，
 * 而且旧进程没有前台权限，窗口常常停在别的窗口后面。没有 exe 时仍会退回这条慢路。
 *
 * 窗口回到前台后，浏览器半边从 /pending 取回 sessionId 并切到那个会话——两段拼起来就是
 * "点通知 → 窗口起来 → 落在对应会话"。
 *
 * AUMID 的坑（v0.1 踩过）：字符串写错时 `CreateToastNotifier` **不报错**，只是把
 * toast 静默丢弃——路由 200、桌面一片安静。默认值取自开始菜单快捷方式的
 * `System.AppUserModel.ID`，也就是安装器登记的 `com.deepseek.dsh`。
 *
 * 安全边界：路由只接受 loopback 上的 POST/GET，body 有上限，滑动窗口限流 + 同 key
 * 去重，避免任何页面通过 DNS rebinding 刷屏。
 */

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件自有的通知路由；浏览器半边用同一常量发 POST。 */
const ROUTE = '/plugins/dsh-desktop-notify/notify'

/** 浏览器半边的排障日志路由（和 Host 日志追加到同一个文件）。 */
const LOG_ROUTE = '/plugins/dsh-desktop-notify/log'

/** 浏览器半边启动时读一次的行为配置。 */
const CONFIG_ROUTE = '/plugins/dsh-desktop-notify/config'

/** 最近一条通知指向的会话；点通知拉起窗口后由浏览器半边取走。 */
const PENDING_ROUTE = '/plugins/dsh-desktop-notify/pending'

/** 把窗口强制拉到前台的辅助路由（协议激活只负责 restore，不给前台权限）。 */
const FOCUS_ROUTE = '/plugins/dsh-desktop-notify/focus'

/**
 * 点通知时交给 Windows 的 URI。
 *
 * 预编译好的 focus-window.exe 存在时用我们自己的 `dsh-notify:` 协议——点击直接跑那个
 * 小 exe（实测 ~90ms 把窗口拉到前台）。没有 exe 就退回 DSH 自己的 `dsh://open`：
 * 那条路要启动一个完整的第二个 Electron 进程才走到单实例检查，用户会觉得"点完要等"。
 */
const ACTIVATION_URI = 'dsh-notify://focus'

/** 没有预编译 exe 时的退路：DSH 已登记，落到 focusPrimaryWindow()。 */
const ACTIVATION_FALLBACK_URI = 'dsh://open'

/** 预编译的置顶程序（免掉 PowerShell 每次 Add-Type 编译的开销）。 */
const FOCUS_EXE = fileURLToPath(new URL('../bin/focus-window.exe', import.meta.url))

/** 前台辅助脚本：没有 exe 时的退路。 */
const FOCUS_SCRIPT = fileURLToPath(new URL('../scripts/focus-window.ps1', import.meta.url))

/** 我们自己的协议名；登记在 HKCU 下，指向 FOCUS_EXE。 */
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-notify'

/** 安装器写进开始菜单快捷方式的 AppUserModelID（Windows 通知的署名）。 */
const DEFAULT_AUMID = 'com.deepseek.dsh'

/** 单次请求体上限；通知内容本来就短，超出的一律拒绝。 */
const MAX_BODY_BYTES = 8 * 1024

/** 限流窗口与窗口内允许的通知条数。 */
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 6

/** 同一 key 的最小间隔，防止状态抖动导致重复弹窗。 */
const SAME_KEY_GAP_MS = 1_500

/**
 * pending 的保鲜期。点通知通常是几秒内的事；超过一分钟才回来，多半是自己把窗口拉回来的，
 * 这时候强行跳会话反而突兀——只把窗口留着，不切视图。
 */
const PENDING_TTL_MS = 60_000

/** Host 侧只依赖 webServer；没有它插件就静默待命。 */
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ aumid?: string, sound?: boolean, debug?: boolean, trigger?: 'minimized' | 'unfocused' | 'always', notifyWhenFocused?: boolean }} [config]
 */
export function apply(ctx, config) {
  const aumid = typeof config?.aumid === 'string' && config.aumid.trim() !== '' ? config.aumid.trim() : DEFAULT_AUMID
  const sound = config?.sound !== false
  const debug = config?.debug !== false
  /**
   * 什么时候弹：unfocused（默认，只要 DSH 不在前台）、minimized（仅最小化/收进托盘）、
   * always（总是）。`notifyWhenFocused: true` 是旧名字，等价于 always。
   */
  const trigger = config?.notifyWhenFocused === true ? 'always' : normalizeTrigger(config?.trigger)

  /** 限流状态：窗口起点 + 计数 + 每个 key 的最近一次时间。 */
  const gate = { windowStart: 0, count: 0, keyAt: new Map() }

  /** 最近一条通知指向的会话（sessionId + 时间戳）。 */
  let pending = null

  /** 预编译置顶程序是否就绪；没有就走 PowerShell 退路。 */
  const hasFocusExe = existsSync(FOCUS_EXE)

  /**
   * 先登记协议，再决定 toast 用哪个 URI —— 顺序很重要：
   * 只按"exe 在不在"选 `dsh-notify:`，万一登记失败，点通知就什么都不发生（比慢更糟）。
   * 登记不成功就老老实实退回 DSH 自己的 `dsh://open`。
   */
  const protocolRegistered = hasFocusExe && config?.protocol !== false ? registerProtocol() : false

  /** 这次运行里 toast 点击该用哪个 URI。 */
  const activationUri = protocolRegistered ? ACTIVATION_URI : ACTIVATION_FALLBACK_URI

  record({
    kind: 'protocol',
    uri: activationUri,
    registered: protocolRegistered,
    exe: hasFocusExe,
    ...hasFocusExe ? {} : { hint: 'bin/focus-window.exe 不存在，已退回 dsh://open（慢路径）' },
  })

  /** 排障日志：一行一个 JSON，追加写，失败静默（日志不能反过来害插件）。 */
  function record(entry) {
    if (!debug) return
    try {
      const dir = join(process.env.LOCALAPPDATA ?? homedir() ?? '.', 'dsh-desktop-notify')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'host.log')
      // 超过 1MB 就轮转一次，日志不该无限长（也免得读日志时刷屏）。
      try {
        if (statSync(file).size > 1_000_000) renameSync(file, join(dir, 'host.log.1'))
      } catch {
        // 文件还不存在，正常。
      }
      appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), aumid, ...entry })}\n`, 'utf8')
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
    const script = toastScript(aumid, message.title, message.body, sound, activationUri)
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

  /**
   * 把 DSH 主窗口拉到前台。
   *
   * 有预编译 exe 就直接跑它（~80ms）；没有就用 PowerShell 脚本兜底（慢，但能用）。
   * 浏览器半边在窗口恢复可见后也会叫这里一次，作为"协议没登记"时的保险。
   */
  function focusForeground() {
    const command = hasFocusExe
      ? FOCUS_EXE
      : 'powershell.exe'
    const args = hasFocusExe
      ? []
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', FOCUS_SCRIPT, '-Quiet']
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: false })
      child.on('error', (error) => record({ kind: 'focus-spawn-error', message: String(error?.message ?? error) }))
      // 记下退出码：只有 exe 会给出 0/1/2 这种可核对的结果，退路脚本不看这个。
      child.on('exit', (code) => {
        if (hasFocusExe) record({ kind: 'focus-exit', code })
      })
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
          remember: (sessionId) => {
            pending = sessionId === '' ? null : { sessionId, at: Date.now() }
          },
        }),
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
          return json(res, 200, { trigger, sound, aumid })
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
          if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
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
          if (req.method === 'POST') {
            if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
            pending = null
            return json(res, 200, { ok: true })
          }
          if (req.method !== 'GET') return json(res, 405, { error: 'method-not-allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })
          const fresh = pending !== null && Date.now() - pending.at <= PENDING_TTL_MS ? pending : null
          if (fresh === null) pending = null
          return json(res, 200, { sessionId: fresh === null ? null : fresh.sessionId, ageMs: fresh === null ? null : Date.now() - fresh.at })
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
 *   show: (message: { title: string, body: string }) => boolean,
 *   record: (entry: object) => void,
 *   remember: (sessionId: string) => void,
 * }} deps
 */
function createNotifyHandler(deps) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })
    if (!trustedRequest(req)) return json(res, 403, { error: 'request-not-trusted' })

    const body = await readJson(req, res)
    if (body === undefined) return

    const title = clamp(body.title, 120) || 'DeepSeek Harness'
    const text = clamp(body.body, 400)
    const key = clamp(body.key, 200)
    const sessionId = clamp(body.sessionId, 200)
    if (text === '' && title === '') return json(res, 400, { error: 'empty-notification' })

    const verdict = deps.allow(key)
    if (!verdict.ok) {
      deps.record({ kind: 'notify-skipped', reason: verdict.reason, key, title })
      return json(res, 200, { ok: false, skipped: verdict.reason })
    }

    const spawned = deps.show({ title, body: text })
    if (!spawned) {
      // 通知根本没交给 PowerShell（被拦、powershell.exe 不在）：用 503 让浏览器半边
      // 走它的 new Notification() 兜底，而不是把这次提醒悄悄吞掉。
      deps.record({ kind: 'notify', key, title, body: text, sessionId, spawned })
      return json(res, 503, { ok: false, error: 'notifier-unavailable' })
    }
    deps.remember(sessionId)
    deps.record({ kind: 'notify', key, title, body: text, sessionId, spawned })
    return json(res, 200, { ok: true })
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
    const body = await readJson(req, res)
    if (body === undefined) return
    record({ kind: 'client', ...body })
    return json(res, 200, { ok: true })
  }
}

/**
 * 读一个 JSON body；出错时自己把响应写完并返回 undefined。
 * @param {import('node:http').IncomingMessage} req
 * @param {object} res
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function readJson(req, res) {
  let raw = ''
  try {
    for await (const chunk of req) {
      raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
        json(res, 413, { error: 'body-too-large' })
        req.destroy()
        return undefined
      }
    }
  } catch {
    json(res, 400, { error: 'body-unreadable' })
    return undefined
  }
  let doc
  try {
    doc = JSON.parse(raw === '' ? '{}' : raw)
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
 * PowerShell 脚本：WinRT toast，点击走协议激活把 DSH 窗口拉起来。
 * 用 -EncodedCommand 传（UTF-16LE base64），避免中文与引号的转义问题。
 * @param {string} aumid
 * @param {string} title
 * @param {string} body
 * @param {boolean} sound
 * @param {string} launch - 点击时交给 Windows 的 URI
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
 * 读当前登记的 open command；键不存在时返回 null。
 * @returns {string | null}
 */
function registeredProtocolCommand() {
  try {
    const out = execFileSync('reg', ['query', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve'], {
      windowsHide: true,
      encoding: 'latin1', // reg.exe 按控制台代码页输出；我们的路径是 ASCII，latin1 不会抛
    })
    const match = /REG_SZ\s+(.+?)\s*$/m.exec(out)
    return match === null ? '' : match[1]
  } catch {
    return null
  }
}

/**
 * 登记 `dsh-notify:` 协议到 HKCU，指向预编译的置顶程序。
 *
 * 先 `reg query` 比对，已经指向同一个 exe 就不写注册表——每次启动跑三条 `reg add`
 * 是没必要的开销，也会让注册表无谓地变脏。失败只记日志：退回 dsh://open 照样能用。
 * @returns {boolean}
 */
function registerProtocol() {
  const expected = `"${FOCUS_EXE}" "%1"`
  if (registeredProtocolCommand() === expected) return true
  try {
    execFileSync('reg', ['add', PROTOCOL_KEY, '/ve', '/d', 'URL:dsh-notify', '/f'], { windowsHide: true, stdio: 'ignore' })
    execFileSync('reg', ['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/d', '', '/f'], { windowsHide: true, stdio: 'ignore' })
    execFileSync('reg', ['add', `${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/d', expected, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return registeredProtocolCommand() === expected
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
