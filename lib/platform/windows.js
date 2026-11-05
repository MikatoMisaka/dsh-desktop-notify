/**
 * Windows 适配器。
 *
 * 这个文件里每一样东西都只为 Windows 的限制而存在，macOS 上一条都不会执行：
 *  - **WinRT toast**：Chromium 在 Windows 发通知必须挂在一个登记到开始菜单的
 *    AppUserModelID 上，而这个 ID 渲染进程拿不到，所以只能由 Host spawn PowerShell 弹；
 *  - **AUMID 核对**：ID 写错 Windows 不报错，只静默丢弃，启动时得问一次 `Get-StartApps`；
 *  - **`dsh-notify:` 协议 + `bin/focus-window.exe`**：点击发生在操作系统层面，拿不到
 *    渲染进程上下文，只能用「协议拉起一个 exe → exe 写 click.json → 渲染进程回查」
 *    把"点了哪一条"传回去；
 *  - **按 PID 枚举隐藏窗口再置顶**：DSH 关窗口即收进托盘，`SetForegroundWindow` 需要
 *    先把隐藏窗口找出来。
 *
 * 对外契约见 `./index.js` 的 PlatformHost 注释。
 */
import { spawn, execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 点通知时交给 Windows 的 URI 前缀；真实 URI 会带上一次性 token。 */
export const ACTIVATION_URI = 'dsh-notify://focus'

/** 没有预编译 exe 时的退路：DSH 自己登记的协议。 */
export const ACTIVATION_FALLBACK_URI = 'dsh://open'

/** 预编译的置顶程序（免掉 PowerShell 每次启动 + Add-Type 编译）。 */
const FOCUS_EXE = fileURLToPath(new URL('../../bin/focus-window.exe', import.meta.url))

/** 前台辅助脚本：没有 exe 时的退路。 */
const FOCUS_SCRIPT = fileURLToPath(new URL('../../scripts/focus-window.ps1', import.meta.url))

/** 我们自己的协议名；登记在 HKCU 下，指向 FOCUS_EXE。 */
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-notify'

/** 安装器写进开始菜单快捷方式的 AppUserModelID（Windows 通知的署名）。 */
const DEFAULT_AUMID = 'com.deepseek.dsh'

/**
 * 主 AUMID 不可用时的兜底署名：Windows PowerShell 自己的 AppUserModelID。
 *
 * 它是系统自带、必然已登记的身份（PowerShell 有开始菜单快捷方式），所以这条 toast
 * 一定能落进操作中心——代价是署名显示成 "Windows PowerShell"。
 * 只在主 ID 抛错时启用；主 ID 正常时署名仍是 DSH 自己。
 */
const FALLBACK_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** click.json 的保鲜期：点完半分钟还没被消费就不再算数。 */
const CLICK_TTL_MS = 30_000

/**
 * @param {object} config - 插件配置
 * @param {{ dataDir: string }} options
 */
export function createWindowsHost(config, { dataDir }) {
  const configuredAumid =
    typeof config?.aumid === 'string' && config.aumid.trim() !== '' ? config.aumid.trim() : DEFAULT_AUMID
  /**
   * 兜底署名：显式给空串表示**关闭**兜底（与 sound/protocol/debug 一样可关）。
   * 不给则用系统必然存在的 PowerShell 身份。
   */
  const fallbackEnabled = config?.fallbackAumid !== ''
  const fallbackAumid = fallbackEnabled
    ? clampAumid(typeof config?.fallbackAumid === 'string' ? config.fallbackAumid : FALLBACK_AUMID) || FALLBACK_AUMID
    : ''

  /**
   * 实际使用的署名。启动时用 `Get-StartApps` 探一次登记状态：配置的 AUMID 不在开始
   * 菜单的 AppID 列表里，几乎一定是"格式合法但没人登记"——那种情况 Windows 不抛错、
   * 只把 toast 静默丢弃（本项目踩过）。探到未登记就直接改用兜底身份。
   */
  let effectiveAumid = clampAumid(configuredAumid) || DEFAULT_AUMID
  /** 兜底身份是否确认已登记；没确认之前，退出码 3 仍按失败处理。 */
  let fallbackTrusted = false
  /** 登记探测的结论：primary / fallback / none / unknown。 */
  let aumidState = 'unknown'

  const clickFile = join(dataDir, 'click.json')

  /** start() 时注入的运行期依赖。 */
  let record = () => {}
  let dryRun = false
  let sound = true

  const hasFocusExe = existsSync(FOCUS_EXE)
  const protocolRegistered = hasFocusExe && config?.protocol !== false ? registerProtocol() : false

  function start(deps) {
    record = deps.record
    dryRun = deps.dryRun === true
    sound = deps.sound !== false

    // 探测结论出来之前，兜底路径一律按"不可信"处理——宁可回 503 让浏览器侧兜底，
    // 也不假装送达。异步探测，不阻塞装载。
    verifyAumidRegistration(effectiveAumid, fallbackAumid, (state, registered, fallbackRegistered) => {
      aumidState = state
      fallbackTrusted = fallbackRegistered
      if (state === 'fallback') {
        effectiveAumid = fallbackAumid
        record({
          kind: 'aumid-unregistered',
          configured: configuredAumid,
          using: fallbackAumid,
          hint: '配置的 AUMID 不在开始菜单 AppID 列表里，已改用兜底身份签名；想用回 DSH 自己的署名，跑 scripts/read-aumid.ps1 取真实值后改 config.aumid。',
        })
      } else if (state === 'none') {
        record({
          kind: 'aumid-unregistered',
          configured: configuredAumid,
          using: configuredAumid,
          hint: '配置的 AUMID 与兜底身份都没在开始菜单里登记：toast 很可能被静默丢弃。跑 scripts/read-aumid.ps1 核对。',
        })
      } else {
        record({ kind: 'aumid-checked', state, registered, fallbackRegistered })
      }
    })

    record({
      kind: 'protocol',
      platform: 'win32',
      registered: protocolRegistered,
      exe: hasFocusExe,
      ...protocolRegistered ? {} : { uri: ACTIVATION_FALLBACK_URI },
    })
  }

  /**
   * 弹一条 Windows 通知，并如实报告成败。
   * spawn 对不存在的程序不抛（ENOENT 异步到达），所以必须等 exit 才算数。
   * 退出码 3 表示"主署名失败、已用系统兜底署名发出"——仍然算成功，但要记一笔。
   * @param {{ title: string, body: string, launch: string }} message
   * @returns {Promise<boolean>}
   */
  function show(message) {
    if (dryRun) {
      record({ kind: 'notify-dry-run', title: message.title, body: message.body })
      return Promise.resolve(true)
    }
    const script = toastScript(effectiveAumid, message.title, message.body, sound, message.launch, fallbackAumid)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return new Promise((resolve) => {
      let settled = false
      let child = null
      let timer = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve(value)
      }
      try {
        child = spawn(
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
          if (settled) {
            // 已经按超时回过 503 了：这条 toast 迟到出现，别再改判成败。
            record({ kind: 'notify-exit-late', code })
            return
          }
          if (code === 3) record({ kind: 'notify-fallback-aumid', fallbackAumid })
          // 3 = 用了兜底身份。只有兜底身份确认已登记时才算成功；
          // 否则等于"换了个身份继续静默丢弃"，必须回 503 让浏览器侧兜底。
          const ok = code === 0 || (code === 3 && fallbackTrusted)
          finish(ok)
        })
        // 兜底：PowerShell 卡住时先回失败，并把子进程杀掉——不然它稍后照弹，
        // 用户会收到两条（客户端 watchdog 也会补一条），而那条的 token 已经没意义了。
        timer = setTimeout(() => {
          record({ kind: 'notify-timeout' })
          try {
            child?.kill()
          } catch {
            // 已经退了就算了。
          }
          finish(false)
        }, 2500)
      } catch (error) {
        record({ kind: 'notify-spawn-throw', message: String(error?.message ?? error) })
        finish(false)
      }
    })
  }

  function focus() {
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

  /**
   * 被点过的通知：读 exe 写下的 click.json。
   *
   * 只返回 token 与时间，sessionId 由调用方（Host 主干的 pending 表）映射——
   * 这样"哪个 token 对应哪个会话"只存在一处。
   * @returns {{ token: string, at: number } | null}
   */
  function consumeClick() {
    try {
      const doc = JSON.parse(readFileSync(clickFile, 'utf8'))
      if (typeof doc?.t === 'string' && typeof doc?.at === 'number') return { token: doc.t, at: doc.at }
      return null
    } catch {
      return null
    }
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

  function launchFor(token) {
    return token !== '' && protocolRegistered ? `${ACTIVATION_URI}?t=${token}` : ACTIVATION_FALLBACK_URI
  }

  return {
    id: 'win32',
    /** 非 null 表示"通知由浏览器半边自己弹"；Windows 自己弹，所以是 null。 */
    delegate: null,
    dataDir,
    clickFile,
    /** click.json 的保鲜期，供主干判断点击是否过期。 */
    clickTtlMs: CLICK_TTL_MS,
    get protocolRegistered() {
      return protocolRegistered
    },
    get capabilities() {
      return { toast: true, delegate: false, protocol: protocolRegistered }
    },
    currentAumid: () => effectiveAumid,
    describe: () => ({
      platform: 'win32',
      aumid: effectiveAumid,
      configuredAumid,
      fallbackAumid,
      aumidState,
      protocol: protocolRegistered,
    }),
    start,
    show,
    focus,
    consumeClick,
    clearClick,
    launchFor,
  }
}

/**
 * 归一化 AUMID：剔除控制字符、截到 Windows 认的 128 字符。返回空串表示"没有可用值"。
 * @param {unknown} value
 * @returns {string}
 */
function clampAumid(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u001F\u007F]/gu, '').trim()
  return text.length > 128 ? text.slice(0, 128) : text
}

/**
 * 问 Windows 一次：这两个 AUMID 有没有登记到开始菜单（`Get-StartApps` 的 AppID 列表）。
 *
 * 这是唯一能区分"格式合法但没人登记"的办法——那种情况 `CreateToastNotifier` 不抛错、
 * 只把 toast 静默丢弃。`History.GetHistory` 和 `ToastNotifier.Setting` 都试过，对伪造
 * 的 ID 同样"有记录/Enabled"，不可用。
 *
 * @param {string} primary
 * @param {string} fallback
 * @param {(state: 'primary'|'fallback'|'none'|'unknown', registered: boolean, fallbackRegistered: boolean) => void} done
 */
function verifyAumidRegistration(primary, fallback, done) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$ids = @()',
    'try { $ids = Get-StartApps | ForEach-Object { $_.AppID } } catch { }',
    '$p = if ($ids -contains $env:DSH_NOTIFY_AUMID) { 1 } else { 0 }',
    "$f = if ($env:DSH_NOTIFY_FALLBACK -ne '' -and ($ids -contains $env:DSH_NOTIFY_FALLBACK)) { 1 } else { 0 }",
    "Write-Output ([string]$p + [string]$f)",
  ].join('; ')

  try {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, DSH_NOTIFY_AUMID: primary, DSH_NOTIFY_FALLBACK: fallback },
        windowsHide: true,
        timeout: 6000,
      },
      (error, stdout) => {
        if (error) {
          done('unknown', false, false)
          return
        }
        const flags = String(stdout ?? '').trim()
        const primaryRegistered = flags.startsWith('1')
        const fallbackRegistered = flags.endsWith('1')
        if (primaryRegistered) done('primary', true, fallbackRegistered)
        else if (fallbackRegistered) done('fallback', false, true)
        else done('none', false, false)
      }
    )
  } catch {
    done('unknown', false, false)
  }
}

/**
 * PowerShell 脚本：WinRT toast，点击走协议激活。
 * 用 -EncodedCommand 传（UTF-16LE base64），避免中文与引号的转义问题。
 *
 * 双署名：先用 DSH 自己的 AUMID 发；只有它**抛错**（WinRT 不可用 / 策略拦截 / 字符串
 * 非法）才用系统必然已登记的 PowerShell AUMID 再发一次，保证通知不会因为署名问题彻底消失。
 *
 * 注意：主 AUMID"格式合法但没登记"时 Windows 并不抛错，只是静默丢弃——这种情况这里
 * 检测不出来（试过 `History.GetHistory`，它返回 COM 集合、对真假 AUMID 都给同样的
 * Count，不可用）。所以那种情况仍要靠 `scripts/read-aumid.ps1` 人工核对。
 *
 * 退出码：0 = 主署名成功，3 = 退回备用署名，1 = 两条都没发出去。
 *
 * @param {string} aumid
 * @param {string} title
 * @param {string} body
 * @param {boolean} sound
 * @param {string} launch - 点击时交给 Windows 的 URI（带 token）
 * @param {string} [fallbackAumid]
 * @returns {string}
 */
function toastScript(aumid, title, body, sound, launch, fallbackAumid = FALLBACK_AUMID) {
  const audio = sound ? '<audio src="ms-winsoundevent:Notification.Default" />' : '<audio silent="true" />'
  const xml =
    `<toast activationType="protocol" launch="${xmlEscape(launch)}">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text>` +
    `</binding></visual>${audio}</toast>`
  const primary = aumid.replace(/'/gu, "''")
  const fallback = String(fallbackAumid).replace(/'/gu, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    `$xml = '${xml.replace(/'/gu, "''")}'`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    'try {',
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${primary}').Show($toast)`,
    '  exit 0',
    '} catch {',
    '  try {',
    `    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${fallback}').Show($toast)`,
    '    exit 3',
    '  } catch { exit 1 }',
    '}',
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
