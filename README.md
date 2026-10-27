# dsh-desktop-notify

DSH 桌面端（Windows）的通知插件：**任务跑完了**、**DSH 停下来等你选择/确认** 的时候，弹一条 Windows 通知——会在「操作中心 / 消息」里留一条记录，不会因为你切走了、最小化到托盘而错过。

这个插件不注册任何界面：它只盯会话状态，安静地在本机弹通知。

- 项目目录：`D:\Projects\own\dsh-notify`
- 包名：`dsh-desktop-notify`（`node_modules` 里必须叫这个名字，DSH 按包名解析）
- 形态：Host + 浏览器「双面包」，无构建步骤，直接发 ESM（与 `dsh-workbuddy-connect` 同款结构）

## 触发规则

| 时机 | 通知标题 |
| --- | --- |
| 一轮任务从「运行中」结束，且没有等你回答的东西 | `DSH · 任务已完成` |
| 会话出现待回答的提问 | `DSH 有问题要问你` |
| 会话出现计划审阅 | `DSH 请你审阅计划` |
| 会话出现工具调用确认 | `DSH 需要你确认`（正文带工具名） |

**不弹**的情况（刻意为之）：

- 你正把窗口开着、焦点就在这个会话上 —— 你已经看见了，不必再弹；
- 子智能体 / 派生会话的完成 —— 由父会话那一轮统一提醒，否则多智能体时会刷屏；
- 同一会话 1.5 秒内的重复事件，以及 10 秒内超过 6 条 —— 限流，防止状态抖动刷屏。

被通知的那条会话如果不在前台，标题下面会带会话名（取会话列表里显示的名字）。

## 为什么有 Host 和浏览器两半

浏览器渲染进程要弹系统通知，得走 Chromium 的 `Notification`，而 Windows 上它依赖一个登记到开始菜单快捷方式的 AppUserModelID；DSH 的窗口源是 `dsh-app://app`（主进程转发到本机 Host），这个 ID 在渲染进程里既拿不到也注册不了。

所以分工是：

- **浏览器半边**（`lib/client.js`）：判断「该不该提醒」，然后向 Host 发一个同源 POST；
- **Host 半边**（`lib/index.js`）：用 PowerShell 调 WinRT `ToastNotificationManager`，显式带安装器登记的 AUMID（默认 `DeepSeek Harness`），AUMID 没登记时回退到进程默认 ID。

万一 Host 路由不可用（插件版本不匹配、路由被禁用），浏览器半边会回退到 `new Notification()`，至少还能在网页/桌面端弹一条。

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
```

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
| `"kind":"client","event":"transition","action":"skip-watching"` | 判定你在看这个会话，故意不弹 | 切走再试 |
| `"kind":"notify-skipped","reason":"duplicate"` | 被 1.5 秒去重挡了 | 正常 |

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
