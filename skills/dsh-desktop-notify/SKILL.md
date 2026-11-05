---
name: dsh-desktop-notify
description: 在 DSH（DeepSeek Harness）里安装、检查或卸载桌面通知插件 dsh-desktop-notify。用户提到「完成通知」「桌面通知」「点通知回到会话」「装通知插件」时使用本技能。
---

# dsh-desktop-notify

给 DSH 桌面端（Windows / macOS）装一套通知：任务跑完、或 DSH 停下来等你回答时弹系统通知；点通知把窗口拉到前台并跳到那条会话。

## 两个平台的区别

| | Windows | macOS |
| --- | --- | --- |
| 谁弹通知 | Host spawn PowerShell 调 WinRT | 渲染进程 `new Notification()` |
| 点击回会话 | `dsh-notify:` 协议 → `bin\focus-window.exe` → `click.json` | `notification.onclick` 直接跳 |
| 原生程序 | 必须编译一次 | **不需要** |
| 通知署名 | AUMID（写错会静默丢 toast） | App 的 bundle id，无需配置 |
| 首次授权 | 无 | 系统问一次「允许通知」 |

Host 的 `/config` 会回 `platform` 与 `capabilities:{toast,delegate,protocol}`，据此判断当前走哪条路。
macOS 的细节与限制见仓库的 `docs/macos-adaptation.md`。

## 先确认这份技能是怎么被读到的

DSH 只从固定根目录发现技能（`.agents\skills`、`.dsh\skills`、`<dshHome>\skills`、`<agentsHome>\skills`），**不会扫 `node_modules` 里的嵌套 `SKILL.md`**。所以随插件发布的这份文件，需要在安装时放到扫描根下：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item <源码>\skills\dsh-desktop-notify "$env:USERPROFILE\.agents\skills\dsh-desktop-notify" -Recurse -Force
```

放完要重启 DSH（或重新加载技能）才生效。不放也不影响通知功能，只是 agent 看不到这份说明。

## 它靠什么工作

- **Host 主干**（`lib/index.js`）：注册 `/plugins/dsh-desktop-notify/*` 路由，维护「这一轮回复的预览」、限流、去重与诊断日志。**平台相关的东西一律在 `lib/platform/`**：`windows.js`（WinRT toast + AUMID 核对 + 协议 + 置顶程序）、`delegated.js`（非 Windows，只把正文回给渲染进程）。主干里没有 `process.platform` 判断，排障先看 `/config` 的 `platform` 与 `capabilities`。
- **浏览器半边**（`lib/client.js`）：判断该不该提醒；Windows 走 Host 弹 toast 并靠协议回传 token，macOS 直接用系统通知 API 弹、点击当场跳会话；两种情况下都会调 `ctx.uiWorkspace.openSession` 切会话。
- **原生小工具**（`bin\focus-window.exe`，**仅 Windows**）：点通知时被协议拉起，负责 restore + 置顶。它由 `native\FocusWindow.cs` 编译而来，**不在仓库里**，Windows 装完必须编译一次；macOS 不需要任何原生程序。

## 安装

先定位 profile 目录：读 `$env:DSH_HOME` 与 `$env:DSH_PROFILE`（本机是 `D:\HarnessData\dsh\profiles\desktop`；`C:\Users\<你>\.dsh` 只是指向它的联接）。

1. 取源码到固定目录，例如 `D:\Projects\own\dsh-notify`（macOS：`~/Projects/dsh-notify`）。
2. 收尾（**必须在包目录里执行**，否则 `npm run setup` 会报 Missing script）。这一步跨平台：
   Windows 编译置顶程序 + 登记协议；macOS 只打印提示，什么都不编译：

   ```powershell
   cd <源码目录>
   npm run setup
   ```

3. 链进 profile（父目录 `node_modules` 必须已存在）：

   ```powershell
   # Windows
   New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target <源码目录>
   ```

   ```bash
   # macOS
   ln -s <源码目录> <profile>/node_modules/dsh-desktop-notify
   ```

4. 改 patch 前先备份，再在 `<profile>\cordis.patch.yml` 末尾追加：

   ```powershell
   Copy-Item <profile>\cordis.patch.yml <profile>\cordis.patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)
   ```

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-desktop-notify
   ```

5. 让用户**完全退出** DSH 桌面端再打开（托盘右键退出，不是关窗口）——Host 插件和浏览器包只在启动时装载。

## 检查是否生效

日志：Windows `%LOCALAPPDATA%\dsh-desktop-notify\host.log`；macOS `~/Library/Logs/dsh-desktop-notify/host.log`（一行一个 JSON）。

- `{"kind":"protocol","platform":"win32","registered":true}` + `{"kind":"host-ready","pid":<DSH 的 pid>,"platform":"win32"}`：Host 半边起来了。
- macOS 上 `protocol` 那条会是 `registered:false`（本来就不登记协议），属正常；`host-ready` 里 `platform` 应为 `darwin`。
- `{"kind":"client","event":"client-apply"}`：浏览器半边进图了。
- `{"kind":"aumid-checked","state":"primary"}`：通知署名核对通过；`aumid-unregistered` 说明配置的 AUMID 没登记，已改用备用身份。

> 自检脚本（`selftest.mjs`）也写同一个日志文件，会留下 `registered:false` 的记录。**核对时认最后一条 `host-ready` 的 pid**，别被自检的 `registered:false` 误导。

通道自测（不碰会话）：先取 DSH 的 web 端口（DSH 界面地址里的那个端口，或 host 启动日志里的监听端口），然后：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:<端口>/plugins/dsh-desktop-notify/notify' -Method POST -ContentType 'application/json' -Body '{"title":"自检","body":"通道测试","key":"probe-1"}' -UseBasicParsing
```

没弹窗但日志有 `notify`：Windows 上多半是 AUMID 不对，跑 `scripts\read-aumid.ps1` 核对（它只打印一个值，填进 insert 下的 `config.aumid`，别新增顶层条目）。

macOS 的通道自测略有不同：`/notify` 不会自己弹窗，而是回 `{"ok":true,"delegate":"darwin","title":…,"body":…}`，由渲染进程弹。所以「没弹窗」先查两处：`config.capabilities.delegate` 是否为 true，以及「系统设置 → 通知 → DeepSeek Harness」是否被设为不允许。日志里对应的是 `notify-delegated`，不是 `notify`。

## 卸载

1. 删掉 `cordis.patch.yml` 里那段 insert（有备份就还原）。
2. Windows：`npm run protocol:uninstall`（**必做**，否则通知中心里的旧 toast 会去找一个不存在的 exe）。macOS 跳过这步。
3. Windows：`cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`（只删联接；别用 `rd /s`）。macOS：`rm <profile>/node_modules/dsh-desktop-notify`。
4. 重启 DSH。

## 注意

- `protocol: false` 或协议登记失败时，点通知会退回 `dsh://open`：慢（要拉起一个完整 DSH 进程），且没有 token，只能按"最近一条通知"跳会话。日志里 `protocol` 的 `registered` 为 false 就是这个状态。
- 改过 `native\FocusWindow.cs` 要重跑 `npm run build:focus`，否则用的还是旧 exe（仅 Windows 有这一步）。
- 挪动源码目录后要**同时**重建联接与重跑 `npm run setup`（Windows 注册表里的协议指向绝对路径）。
- macOS 上 App 退出后点通知回不到会话：渲染进程没了，`notification.onclick` 不会触发，系统只会把 App 重新打开。要补这个缺口得加常驻 helper bundle，见 `docs/macos-adaptation.md`。
