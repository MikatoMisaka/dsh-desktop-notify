# dsh-desktop-notify

DSH 桌面端（Windows）的通知插件：**任务跑完了**、**DSH 停下来等你选择/确认** 的时候，弹一条 Windows 通知——会在「操作中心 / 消息」里留一条记录，不会因为你切走了、最小化到托盘而错过。

这个插件不注册任何界面：它只盯会话状态，安静地在本机弹通知。

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
    aumid: DeepSeek Harness   # Windows 通知的署名 AppUserModelID
    sound: true              # false 则静音弹窗
```

## 安装 / 卸载

安装（已经做过一次）：

1. 包目录放到 `<profile>/plugins/dsh-desktop-notify`；
2. `<profile>/node_modules/dsh-desktop-notify` 建一个指向它的目录联接；
3. `<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: desktop-notify
      name: dsh-desktop-notify
```

装完需要重启 DSH 桌面端（Host 插件和浏览器包都只在启动时装载）。

卸载：删掉 `cordis.patch.yml` 里那段 insert，重启即可；再删 `plugins/dsh-desktop-notify` 和 `node_modules/dsh-desktop-notify` 收尾。

## 自检

```bash
node selftest.mjs         # Host 半边：路由注册、请求校验、去重、PowerShell 调用
node client-selftest.mjs  # 浏览器半边：什么情况下该弹、什么情况下不该弹
```

两个脚本都不需要启动 DSH。`selftest.mjs` 会真的弹一条通知（用来验证通知通道本身）。
