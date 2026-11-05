/**
 * 平台适配器的选择器。
 *
 * 主干（`../index.js`）只认下面这个契约，不认具体平台；想知道"Windows 要什么、
 * macOS 要什么"，看 `./windows.js` 与 `./delegated.js` 两个文件即可。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createDelegatedHost } from './delegated.js'
import { createWindowsHost } from './windows.js'

/**
 * @typedef {object} PlatformHost
 * @property {'win32'|'darwin'|'linux'} id
 * @property {string|null} delegate 非 null 时，/notify 把正文回给浏览器半边自己弹
 * @property {string} dataDir 日志与运行态落盘目录
 * @property {string|null} clickFile 点击回执文件（只有 Windows 有）
 * @property {number} clickTtlMs 点击回执的保鲜期
 * @property {boolean} protocolRegistered 点通知能不能带 token（只有 Windows 会 true）
 * @property {{toast: boolean, delegate: boolean, protocol: boolean}} capabilities
 * @property {() => string|null} currentAumid 写进日志的署名（非 Windows 为 null）
 * @property {() => object} describe /config 需要的字段
 * @property {(deps: {record: Function, dryRun: boolean, sound: boolean}) => void} start 装载副作用
 * @property {(message: {title: string, body: string, launch: string}) => Promise<boolean>} show
 * @property {() => boolean} focus
 * @property {() => {token: string, at: number}|null} consumeClick
 * @property {(token: string) => void} clearClick
 * @property {(token: string) => string} launchFor
 */

/**
 * 归一化平台名。只认三个值：其余（freebsd 等）统一当作「非 Windows」处理，
 * 走委派路径总比去 spawn 一个不存在的 powershell.exe 强。
 * @param {unknown} value
 * @returns {'win32' | 'darwin' | 'linux' | null}
 */
export function normalizePlatform(value) {
  if (value === 'win32' || value === 'darwin' || value === 'linux') return value
  return null
}

/**
 * 数据目录。优先级：config.dataDir → DSH_NOTIFY_DATA_DIR → 平台默认。
 * 自检靠前两个把日志写到临时目录，免得读到真实运行态残留。
 * @param {object} config
 * @param {'win32' | 'darwin' | 'linux'} platformId
 * @returns {string}
 */
export function resolveDataDir(config, platformId) {
  if (typeof config?.dataDir === 'string' && config.dataDir.trim() !== '') return config.dataDir.trim()
  if (process.env.DSH_NOTIFY_DATA_DIR) return process.env.DSH_NOTIFY_DATA_DIR
  if (platformId === 'win32') return join(process.env.LOCALAPPDATA || homedir() || '.', 'dsh-desktop-notify')
  return join(homedir() || '.', 'Library', 'Logs', 'dsh-desktop-notify')
}

/**
 * 按平台造一个适配器。只做纯计算（路径、配置），副作用留给 `start()`，
 * 这样主干可以先定义好自己的日志函数再启动适配器。
 * @param {object} config
 * @returns {PlatformHost}
 */
export function createPlatformHost(config) {
  const platformId = normalizePlatform(config?.platform) ?? normalizePlatform(process.platform) ?? 'linux'
  const dataDir = resolveDataDir(config, platformId)
  if (platformId === 'win32') return createWindowsHost(config, { dataDir })
  return createDelegatedHost(platformId, { dataDir })
}
