/**
 * 跨平台安装收尾。
 *
 * Windows：编译 bin/focus-window.exe（点击通知的置顶程序）+ 登记 dsh-notify: 协议。
 * macOS：什么都不用编译——点击通知发生在渲染进程里，不需要协议与原生小工具。
 *
 * 用法：npm run setup
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 同步跑一个子进程，失败就记住退出码（不 throw，好让后续步骤的提示还能打出来）。
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean}
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`${command} 启动失败：${String(result.error.message ?? result.error)}`)
    process.exitCode = 1
    return false
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return false
  }
  return true
}

if (process.platform === 'win32') {
  const built = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'build-focus.ps1')])
  const registered = built && run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'install-protocol.ps1')])
  if (registered) {
    console.log('')
    console.log('Windows：置顶程序已编译，dsh-notify: 协议已登记。')
    console.log('请托盘右键退出 DSH 再打开（Host 插件只在启动时装载）。')
  }
} else if (process.platform === 'darwin') {
  console.log('macOS：不需要编译原生程序，也不需要登记协议。')
  console.log('  点击通知回到会话由渲染进程直接处理（lib/client.js 的 showLocal）。')
  console.log('  首次弹通知时会请求权限：系统设置 → 通知 → DeepSeek Harness 里允许。')
  console.log('  如果之前误点了「不允许」，从同一处改回来即可。')
  console.log('')
  console.log('装完记得彻底退出 DSH 再打开（Host 插件只在启动时装载）。')
} else {
  console.log(`${process.platform}：暂不支持。插件只会把正文回给浏览器半边，不弹系统通知。`)
  process.exitCode = 1
}
