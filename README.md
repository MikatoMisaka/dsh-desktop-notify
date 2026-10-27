# dsh-desktop-notify

DSH 桌面端（Windows）的通知插件：**任务跑完了**、**DSH 停下来等你选择/确认** 的时候，弹一条 Windows 通知——会在「操作中心 / 消息」里留一条记录，不会因为你切走了、最小化到托盘而错过。

这个插件不注册任何界面：它只盯会话状态，安静地在本机弹通知。

- 项目目录：`D:\Projects\own\dsh-notify`
- 包名：`dsh-desktop-notify`（`node_modules` 里必须叫这个名字，DSH 按包名解析）
- 形态：Host + 浏览器「双面包」，无构建步骤，直接发 ESM（与 `dsh-workbuddy-connect` 同款结构）

## 触发规则

**默认只要 DSH 不在前台就提醒**（`trigger: unfocused`）——你切走去干别的、最小化、收进托盘、锁屏，都算。

| 时机 | 通知标题 |
| --- | --- |
| 一轮任务从「运行中」结束，且没有等你回答的东西 | `DSH · 任务已完成` |
| 会话出现待回答的提问 | `DSH 有问题要问你` |
| 会话出现计划审阅 | `DSH 请你审阅计划` |
| 会话出现工具调用确认 | `DSH 需要你确认`（正文带工具名） |

**不弹**的情况（刻意为之）：

- 你正把窗口开着、焦点在 DSH，而且看的就是这条会话 —— 你已经看见了，不打扰（`trigger: always` 可以连这个也弹）；
- 子智能体 / 派生会话的完成 —— 由父会话那一轮统一提醒，否则多智能体时会刷屏；
- 同一会话 1.5 秒内的重复事件，以及 10 秒内超过 6 条 —— 限流，防止状态抖动刷屏。

正文会带会话名（取会话列表里显示的名字）。

## 点通知 → 回到那条会话

通知用 `activationType="protocol"` + `launch="dsh://open"`。DSH 安装器登记了 `dsh:` 协议（command 是 `"<exe>" "%1"`），单实例锁会把这次启动转成 `second-instance` → `focusPrimaryWindow()`，也就是 `restore()` + `show()` + `focus()`。

**但这一步只让窗口"露出来"，不会把它带到最前面**：真正 show/focus 的是本来就在后台的旧进程，它没有前台权限（foreground right）——新进程拿到的那份权限随着它退出一起消失了。所以链路还有第二段：

窗口恢复可见后，浏览器半边向 `/pending` 取回「刚才那条通知属于哪个会话」，再 POST `/focus` 让 Host 跑 `scripts/focus-window.ps1`。脚本每一轮做四件事，最多重试 5 轮，每轮用 `GetForegroundWindow()` 核对：

1. `keybd_event` 打一次 ALT 按下/抬起 —— 让本进程"刚收到过输入"，拿到前台资格（关键一步，光靠下面几招在 Win11 上经常被拒）；
2. `ShowWindow(SW_RESTORE)` + `Interaction.AppActivate`（内部走 `AttachThreadInput`）；
3. 自己 `AttachThreadInput` 到当前前台线程，再 `BringWindowToTop` + `SetForegroundWindow`；
4. 还不行就 `SwitchToThisWindow` + `SetWindowPos` 的 topmost 抖动，强制改 z 序。

结果写进 `%LOCALAPPDATA%\dsh-desktop-notify\focus.log`（`ok` / `rounds` / `before` / `after` 句柄），置顶这件事从此可核对，不靠"看起来有没有反应"。

置顶完成后再调 `ctx.uiWorkspace.openSession(sessionId)` 切到那个会话，然后清掉 pending。

几个刻意的取舍：

- pending 有 2 分钟保鲜期：点得太晚就只把窗口拉起来，不强行跳会话；
- 已经在那个会话上就不重复切，但仍会置顶；
- 只有 `visibilitychange` 会触发跳转，普通 alt-tab 回一个本来就可见的窗口不会跳（那样才不会莫名换会话）。

## 为什么有 Host 和浏览器两半

浏览器渲染进程要弹系统通知，得走 Chromium 的 `Notification`，而 Windows 上它依赖一个登记到开始菜单快捷方式的 AppUserModelID；DSH 的窗口源是 `dsh-app://app`（主进程转发到本机 Host），这个 ID 在渲染进程里既拿不到也注册不了。

所以分工是：

- **浏览器半边**（`lib/client.js`）：判断「该不该提醒」，判定通过后带 `sessionId` 向 Host 发一个同源 POST；
- **Host 半边**（`lib/index.js`）：用 PowerShell 调 WinRT `ToastNotificationManager`，显式带安装器登记的 AUMID（默认 `com.deepseek.dsh`），并记住这条通知指向的会话以便点击回跳。

万一 Host 路由不可用（插件版本不匹配、路由被禁用），浏览器半边会回退到 `new Notification()`，至少还能在网页/桌面端弹一条（只是点击不带跳转）。

## 路由安全

`POST /plugins/dsh-desktop-notify/notify`

- 只接受 POST，body 上限 8 KiB；
- 只信任 loopback：`Host` 必须是 127.0.0.1 / ::1 / localhost；带了 `Origin` 时也必须是本机（挡 DNS rebinding 页面）；
- 滑动窗口限流 + 同 key 去重。

## 配置

在 profile 的 `cordis.patch.yml` 里给这条 insert 加 `config` 即可：

```yaml
- id: desktop-notify
  name: dsh-desktop-notify
  config:
    aumid: com.deepseek.dsh   # Windows 通知的署名 AppUserModelID（默认值就是这个）
    sound: true               # false 则静音弹窗
    debug: true               # false 则不再写排障日志
    trigger: unfocused        # unfocused（默认）| minimized | always
```

`trigger` 的三档：

| 值 | 什么时候弹 |
| --- | --- |
| `unfocused`（默认） | 只要 DSH 不在前台就弹；在前台但你停在别的会话上也弹 |
| `minimized` | 只在窗口最小化 / 收进托盘 / 不可见时 |
| `always` | 总是弹，包括你正盯着这条会话（自测用） |

### AUMID 是这套东西最容易踩的坑

Windows 的通知绑定到「开始菜单快捷方式里登记的 AppUserModelID」。字符串写错时 `CreateToastNotifier` **不抛异常**，只是把 toast 静默丢掉——于是现象是"路由 200、桌面一片安静"，很容易误判成插件没装。

v0.1 就踩过：当时默认值是 `DeepSeek Harness`，而安装器登记的是 `com.deepseek.dsh`，所以一条通知都出不来。

换品牌 / 换构筑 / 不确定时，先查真实值：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\read-aumid.ps1
```

## 排障

日志：`%LOCALAPPDATA%\dsh-desktop-notify\host.log`，一行一个 JSON。

| 日志里看到 | 含义 | 下一步 |
| --- | --- | --- |
| `"kind":"host-ready"` | Host 半边装上了 | — |
| `"kind":"client","event":"client-apply"` | 浏览器半边也进图了 | — |
| 只有 `host-ready`，没有 `client-apply` | 浏览器半边没加载 | 看 DevTools Console 有没有 `[dsh-desktop-notify] 已就绪`；检查 `dsh.client` 声明与 `exports["./client"]` |
| `"kind":"notify"` 且 `"spawned":true` | 通知已经交给 PowerShell | 桌面没看到 → AUMID 不对，跑 `read-aumid.ps1` |
| `"kind":"client","event":"transition","action":"skip-visible"` | 窗口开着，按默认规则不弹 | 最小化再试，或把 `trigger` 改成 `unfocused` |
| `"kind":"client","event":"transition","action":"skip-watching"` | `trigger: unfocused` 下，你正看着这个会话 | 正常 |
| `"kind":"notify-skipped","reason":"duplicate"` | 被 1.5 秒去重挡了 | 正常 |
| `"kind":"client","event":"navigate"` | 窗口恢复后切到了对应会话 | — |
| `"kind":"client","event":"navigate-skip"` | 已经在该会话，没重复切 | 正常 |
| `"kind":"focus-requested"` | 已请求把窗口提到最前 | 没提到最前 → 手动跑 `scripts\focus-window.ps1` 看它输出的 JSON |
| `"kind":"focus-spawn-error"` | 置顶脚本没起来 | 检查 `scripts\focus-window.ps1` 是否还在、PowerShell 是否被拦 |

点通知不跳会话时按顺序看：`dsh:` 协议是否登记（`Get-ItemProperty HKCU:\Software\Classes\dsh`）→ 日志里有没有 `navigate` → pending 是否已过期（2 分钟）。窗口不置顶时看有没有 `focus-requested`，并手动跑一次脚本核对 `foregroundAfter`。

> 手动核对置顶：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-window.ps1`，输出 `{"ok":true,...}` 就说明前台句柄确实换成了 DSH 主窗口。

快速验证通道（不启动 DSH、不碰会话）：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:<端口>/plugins/dsh-desktop-notify/notify' -Method POST -ContentType 'application/json' -Body '{"title":"通道自检","body":"直接打路由","key":"probe-1"}' -UseBasicParsing
```


## 安装方式

已安装的形态是**目录联接**，不是副本——改项目里的代码就是改已安装的插件，不用再同步第二份：

```
<profile>\node_modules\dsh-desktop-notify  →  D:\Projects\own\dsh-notify
<profile>\cordis.patch.yml                 →  末尾一段 - insert: [{ id: desktop-notify, name: dsh-desktop-notify }]
```

新机器上装：

1. `git clone <repo> D:\Projects\own\dsh-notify`
2. 建联接：`New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target D:\Projects\own\dsh-notify`
3. `<profile>\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: desktop-notify
      name: dsh-desktop-notify
```

4. 重启 DSH 桌面端（Host 插件和浏览器包都只在启动时装载）

> profile 实际路径：`D:\HarnessData\dsh\profiles\desktop`（`C:\Users\<用户>\.dsh` 是指向它的联接）。

卸载：删掉 insert 那段 → 重启 → 删联接（`cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`，只删联接，不动源码）。

## 开发流程

1. 改 `lib/index.js` 或 `lib/client.js`
2. `node selftest.mjs` / `node client-selftest.mjs` 先自检（不用起 DSH）
3. 完全退出 DSH 桌面端（托盘右键退出，不是关窗口）→ 重开 → 真机验场景
4. 提交

> `.ps1` 一律存成 **UTF-8 with BOM**。Windows PowerShell 5.1 没有 BOM 时按 ANSI 读文件，中文注释会被读成乱码，运气不好直接变成语法错误（"Unexpected token '}'"），而且报错位置会飘到文件后半段，非常难查。改完可以这样静态检查：
>
> ```powershell
> powershell -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('scripts\focus-window.ps1',[ref]$null,[ref]$e); $e.Count"
> ```

## 自检

```bash
node selftest.mjs         # Host 半边：路由注册、请求校验、去重、PowerShell 调用
node client-selftest.mjs  # 浏览器半边：什么情况下该弹、什么情况下不该弹
```

两个脚本都不需要启动 DSH。`selftest.mjs` 会真的弹一条通知（用来验证通知通道本身）。

## 路线（TODO）

- [ ] **M1 真机验证**：前台 / 托盘 / 勿扰 / 多显示器 四种状态下到底弹不弹（目前只在 Node 里打过桩；AUMID 是否真的被 Windows 接受，只有真机能回答）
- [ ] **M2 事件全覆盖**：失败与中断也提醒；同一轮「提问 → 回答 → 完成」合并成一条，别连弹
- [ ] **M3 可配置**：开关、静音、只在后台弹、安静时段、AUMID、中英文案（跟随 DSH 语言）
- [ ] **M4 排障**：`/plugins/dsh-desktop-notify/selftest` 路由（点一下就知道通道通不通）+ README 排障表
- [ ] **M5 分发**：`npm pack` 产物 + 安装说明，发到 DSH 插件仓库（Gitee / GitHub）
