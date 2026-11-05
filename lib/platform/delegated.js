/**
 * 非 Windows（macOS / Linux / 其它）适配器：**Host 不弹通知**。
 *
 * macOS 上不需要 Windows 那一整套（AUMID、协议、预编译置顶程序），因为
 * 渲染进程可以直接 `new Notification()`，点击事件就落在本进程里——sessionId 当场
 * 在手上，不需要任何"从系统回传 token"的机制。所以这里只做两件事：
 *
 *  1. 声明能力：`delegate: true`，告诉 `/notify` 把拼好的正文回给浏览器半边；
 *  2. 把「点通知回会话」完全交给 `lib/client.js` 的 `showLocal()`。
 *
 * 保留这个文件而不是在主干里写 `if (platform !== 'win32')`，是为了让"某个平台需要
 * 什么"永远只在一个文件里回答；Linux 等平台将来要接 libnotify，也只需要替换这里。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {'darwin' | 'linux'} id
 * @param {{ dataDir: string }} options
 */
export function createDelegatedHost(id, { dataDir }) {
  return {
    id,
    /** 非 null 表示"通知由浏览器半边自己弹"，值为平台名（会回显在 /notify 响应里）。 */
    delegate: id,
    dataDir,
    /** 没有 click.json：点击不需要跨越进程边界。 */
    clickFile: null,
    clickTtlMs: 0,
    protocolRegistered: false,
    capabilities: { toast: false, delegate: true, protocol: false },

    /** 没有 AUMID 这个概念；通知署名由宿主 App 的 bundle id 决定。 */
    currentAumid: () => null,
    describe: () => ({
      platform: id,
      aumid: null,
      configuredAumid: null,
      fallbackAumid: null,
      aumidState: 'unsupported',
      protocol: false,
    }),

    /** 只记一条"协议不适用"，别让排障的人以为登记失败了。 */
    start({ record }) {
      record({ kind: 'protocol', platform: id, registered: false, exe: false })
    },

    /** 兜底：主干在委派模式下不会调到它（/notify 提前返回）。 */
    show(message) {
      return Promise.resolve(false)
    },

    /** 点通知时系统已经把 App 激活，Host 这边无事可做。 */
    focus() {
      return false
    },

    consumeClick() {
      return null
    },

    clearClick() {},

    launchFor() {
      return ''
    },

    /** 数据目录默认值（macOS 惯例位置，Console.app 能直接看）。 */
    staticDataDir() {
      return join(homedir() || '.', 'Library', 'Logs', 'dsh-desktop-notify')
    },
  }
}
