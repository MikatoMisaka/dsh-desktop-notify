# macOS 适配说明

> 目标：在 macOS 上得到和 Windows 一样的一件事——**任务跑完 / 停下来等你回答时弹系统通知，点通知回到对应会话**。
>
> 结论先说：这件事在 macOS 上比 Windows 简单，因为**不需要原生代码**。Windows 那一整套
> （AUMID 署名、`dsh-notify:` 协议、`focus-window.exe`）只是 Windows 平台限制的产物，
> macOS 上可以整段绕开。

## 为什么 macOS 不需要那一套

Windows 上绕道 Host 的原因：Chromium 在 Windows 发 toast 必须挂在一个**已登记到开始菜单的
AppUserModelID** 上，而这个 ID 渲染进程拿不到也注册不了。于是链路变成

```
渲染进程 → POST 给 Host → PowerShell 调 WinRT 弹 toast → 点击经 dsh-notify: 协议拉起 exe
        → exe 写 click.json → 渲染进程回来问"刚才点了哪条" → 才能跳会话
```

`focus-window.exe`、注册表协议、`click.json`、token 全部是为了**把"用户在系统通知里点了哪条"
这个信息传回渲染进程**——因为点击发生在操作系统层面，renderer 拿不到上下文。

macOS 上这条限制不存在：

| 环节 | Windows | macOS |
| --- | --- | --- |
| 谁弹通知 | Host spawn PowerShell（WinRT） | **渲染进程** `new Notification()` |
| 署名身份 | 必须登记的 AUMID，写错就静默丢弃 | 由宿主 App 的 bundle id 决定，**没有可配项** |
| 点击回调 | 自建 `dsh-notify:` 协议 → exe → `click.json` | **`notification.onclick`，事件就在本进程** |
| 知道点了哪条 | token 映射表 | **sessionId 当场就在闭包里** |
| 置顶窗口 | `SetForegroundWindow`（要枚举隐藏窗口、按 PID 找） | 点通知时 Launch Services 已经激活 App |
| 原生代码 | 必需（`FocusWindow.cs`） | **一个字节都不需要** |

关键前提已核实：DSH 桌面端的权限处理是「非 media 权限一律放行」
（`app.asar/lib/main.js` 的 `setPermissionRequestHandler`），所以渲染进程用
`Notification` 不会被拦。macOS 只会在首次弹窗时向用户要一次授权。

## 改了什么

设计原则：**主干只放跨平台逻辑，平台差异各占一个文件。** Host 保留它真正跨平台的那部分能力
——拼正文（回复预览）、限流、同 key 去重、诊断日志——把「怎么弹、点了怎么回跳」交给适配器：

```
lib/
├── index.js              主干：路由、限流、去重、预览、日志、来源校验（不含任何平台分支）
├── client.js             浏览器半边：判该不该提醒；非 Windows 时 showLocal() 自己弹
└── platform/
    ├── index.js          选择器 + 数据目录 + 平台名归一化 + PlatformHost 契约
    ├── windows.js        WinRT toast / AUMID 核对 / dsh-notify: 协议 / 置顶程序 / click.json
    └── delegated.js      非 Windows：不弹，正文回给渲染进程（macOS、Linux 都走这里）
```

适配器契约（`lib/platform/index.js` 里也有注释）：

| 成员 | Windows | 非 Windows |
| --- | --- | --- |
| `id` | `win32` | `darwin` / `linux` |
| `delegate` | `null`（自己弹） | 平台名（让 `/notify` 回正文） |
| `capabilities` | `{toast:true, delegate:false, protocol:<是否登记成功>}` | `{toast:false, delegate:true, protocol:false}` |
| `start()` | 探一次 AUMID + 登记协议 | 只记一条「协议不适用」 |
| `show()` | spawn PowerShell 弹 WinRT toast | 不会被调用（`/notify` 提前委派） |
| `focus()` | 拉 `focus-window.exe` 置顶 | `false` |
| `consumeClick()` | 读 exe 写的 `click.json` | `null` |
| `describe()` | aumid / aumidState / protocol | `aumid:null`、`aumidState:'unsupported'` |

主干里因此没有一处 `process.platform` 判断：它只知道「这个适配器会不会自己弹、要不要 token」。

### `lib/index.js`（Host 主干）

- 新增 `runtime = createPlatformHost(config)`，所有平台相关调用都走它。
- `/notify` 在**限流与去重之后**分流：`runtime.delegate` 非 null 就回
  `{ok:true, delegate:'darwin', title, body, sessionId}`，正文照样由 Host 拼。
- `/focus`：委派模式下回 `{ok:false, delegate}`。
- `/config`：多带 `platform` 与 `capabilities:{toast,delegate,protocol}`。
- `/pending`：点击回执从适配器取（Windows 读 `click.json`，其它平台永远是 `null`）。
- 数据目录由适配器决定：Windows `%LOCALAPPDATA%\dsh-desktop-notify`，
  非 Windows `~/Library/Logs/dsh-desktop-notify`。

### `lib/client.js`（浏览器半边）

- 平台结论：先用 `navigator.userAgent` 猜（文案和首条通知等不到 `/config`），`/config` 到了用真值覆盖。
- `deliver()` 拿到 `delegate` 响应就调 `showLocal()`：`new Notification(title, {body})`，并把
  `onclick` 直接接到 `ctx.uiWorkspace.openSession(sessionId)`。
- 拿不到委派（Host 回了失败、或 `Notification` 不可用）时行为不变：退回本地通知兜底。
- 非 Windows 不再往 `/focus` 打枪（点了通知系统已经激活 App）。
- 设置页文案跟着平台变（「通过系统通知…」而不是「通过 Windows 通知…」）。

### `scripts/setup.mjs`（新增）

`npm run setup` 原来是 `npm run build:focus && npm run protocol:install`，在 mac 上会直接
找不到 `powershell` 而失败。现在改成跨平台入口：Windows 跑原来两步，macOS 只打印
「不用编译、记得开通知权限」，其它平台明确说不支持。

### 测试

- `node selftest.mjs`：Windows 路径不变（`toast:true, delegate:false, protocol:true`）。
- `node macos-selftest.mjs`（新增）：**在 Windows 上就能跑**，用 `platform:'darwin'` 走 mac 分支，
  验证委派正文带预览、会话名、sessionId，去重仍然生效、`/focus` 回委派、日志里走
  `notify-delegated` 而不是 `notify-dry-run`、且全程没有 spawn 过 PowerShell。
- `node client-selftest.mjs`：不变（渲染进程判定逻辑与平台无关）。

## 在 mac 上怎么装

和 Windows 一样的四步，只是第 2 步不做事：

```bash
# 1. 取源码到固定目录
git clone https://github.com/MikatoMisaka/dsh-desktop-notify ~/Projects/dsh-notify

# 2. 收尾（macOS 上只打印提示，不需要编译）
cd ~/Projects/dsh-notify && npm run setup

# 3. 链进 profile（父目录 node_modules 必须已存在）
ln -s ~/Projects/dsh-notify ~/.dsh/profiles/desktop/node_modules/dsh-desktop-notify

# 4. 往 <profile>/cordis.patch.yml 末尾追加
#    - insert:
#        - id: desktop-notify
#          name: dsh-desktop-notify
```

然后**彻底退出 DSH（⌘Q）再打开**。首次收到通知时系统会弹「允许通知」，允许即可；
之后在「系统设置 → 通知 → DeepSeek Harness」里可以改样式和声音。

> 用 `ln -s` 而不是 Windows 的 junction；`package.json` 的 `main` 与 `exports` 都指向
> `lib/index.js`，Node 的 ESM 解析对符号链接正常。

## 已知限制

1. **App 退出后点通知回不到会话。** 渲染进程没了，`onclick` 也不会触发；macOS 只会把 App
   重新打开。Windows 那边靠操作系统把 URI 交给 exe，所以能在冷启动后也跳会话。
   要做到同等效果，需要一个常驻的 helper bundle（见下）。
2. **通知分组按 App，不按会话。** macOS 的通知中心按 App 聚合，Windows 的 Action Center 也一样，
   这块没有差异。
3. **`sound` 配置项在 mac 上无效。** Windows 的 toast XML 里能选提示音；渲染进程的
   `Notification` 目前不带声音参数。要声音得走 native helper 或用 `osascript` 旁路
   （`display notification ... sound name "default"`，但那样署名会变成 Script Editor，不建议）。
4. **未在真机验证。** 本轮改动是在 Windows 上完成的，mac 分支靠 `macos-selftest.mjs` 的
   模拟覆盖到 Host 侧协议层面；`new Notification()` 的真实外观 / 点击行为需要在 Mac 上过一遍。
   上机后请按下面的清单核对。

## 上机核对清单（macOS）

1. `node macos-selftest.mjs` 通过；
2. 重启 DSH 后 `host.log`（`~/Library/Logs/dsh-desktop-notify/host.log`）里出现
   `{"kind":"host-ready","platform":"darwin"}`、`{"kind":"protocol","platform":"darwin","registered":false}`；
3. `curl -s localhost:<端口>/plugins/dsh-desktop-notify/config` → `"platform":"darwin"`、
   `"capabilities":{"toast":false,"delegate":true,"protocol":false}`；
4. 跑完一轮任务 → 弹出通知，**正文是这轮回复的最后一段**（说明预览链路通了）；
5. 点通知 → App 到前台并跳到那条会话；`host.log` 里应有 `{"kind":"client","event":"navigate","via":"notification-click"}`；
6. 「设置 → 通用 → 任务完成提醒」三档都在，切换后行为随之变化；
7. 第一次弹窗如果没出现，先看「系统设置 → 通知 → DeepSeek Harness」是否被设为「不允许」。

## 如果要做"冷启动也能跳会话"（可选的第二步）

只有这一件事需要原生代码。做法是编一个极小的 helper `.app`（~100 行 Swift）：

```
notifyd.app/
├── Info.plist          # LSUIElement=true、CFBundleURLTypes 声明 dsh-notify://
└── notifyd             # UNUserNotificationCenter + UNNotificationCategory 动作
```

- 用 `UNUserNotificationCenter` 发通知，`userInfo` 里带 `{sessionId, token}`；
- `userNotificationCenter(_:didReceive:withCompletionHandler:)` 里把 token 写进
  `~/Library/Logs/dsh-desktop-notify/click.json`（和 Windows 的 `click.json` 同构，
  渲染进程回到前台时照旧读），然后 `NSWorkspace.shared.open(URL("dsh-notify://focus?t=…"))`；
- 协议 `dsh-notify://` 由这个 bundle 自己声明，不需要改 DSH 的 `Info.plist`；
- 代价：多一个需要签名/公证的 bundle，且首次运行要单独授权通知。

只有在"App 常被 ⌘Q 关掉"的使用习惯下才值得做；常驻托盘的使用方式下，当前方案已经够用。
