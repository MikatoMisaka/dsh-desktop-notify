# dsh-desktop-notify

DSH 桌面端（Windows）的通知插件：**任务跑完了**、**DSH 停下来等你选择/确认** 的时候弹一条 Windows 通知，留在「操作中心」里；点它，DSH 直接到前台并落到**那一条**通知对应的会话。

- 项目目录：`D:\Projects\own\dsh-notify`
- 包名：`dsh-desktop-notify`（`node_modules` 里必须叫这个名字，DSH 按包名解析）
- 形态：Host + 浏览器「双面包」，无构建步骤，直接发 ESM（与 `dsh-workbuddy-connect` 同款结构）

## 触发规则

**默认只要 DSH 不在前台就提醒**（`trigger: unfocused`）——切走、最小化、收进托盘、锁屏都算。

| 时机 | 通知标题 |
| --- | --- |
| 一轮任务从「运行中」结束，且没有等你回答的东西 | `DSH · 任务已完成` |
| 会话出现待回答的提问 | `DSH 有问题要问你` |
| 会话出现计划审阅 | `DSH 请你审阅计划` |
| 会话出现工具调用确认 | `DSH 需要你确认`（正文带工具名） |

**不弹**的情况（刻意为之）：

- 你正把窗口开着、焦点在 DSH，而且看的就是这条会话 —— 你已经看见了（`trigger: always` 可连这个也弹）；
- **子智能体 / 派生会话**（行里 `origin === 'subagent'` 或带 `parentId`）—— 由父会话那一轮统一提醒，否则多智能体刷屏；
- 同一张交互卡被 hide/reveal（`callId` 没变）—— 只有真的换了卡才再提醒；
- 同一会话 1.5 秒内的重复事件，10 秒内超过 6 条 —— 限流。

正文带会话名（取会话列表里的显示名）。

## 点通知 → 回到那条会话

通知是 `activationType="protocol"`，点击交给 Windows 开一个 URI。**URI 带一次性 token**，所以点哪条就跳哪条：

```
toast click
  → dsh-notify://focus?t=<token>
      → bin\focus-window.exe（用户点击直接拉起，天生有前台权限）
           ├─ 按 token 写 %LOCALAPPDATA%\dsh-desktop-notify\click.json
           └─ SW_SHOW/SW_RESTORE + 置顶（35~130ms）
      → 窗口恢复可见 → 浏览器半边 GET /pending
           ├─ Host 读 click.json → token → sessionId
           └─ openSession(sessionId)，成功后 POST /pending {token} 消费
```

关键点：

- **窗口收进托盘也能找回**。`Process.MainWindowHandle` 对隐藏窗口返回 0（DSH 关窗口就是 `hide()`），所以 exe 用 `EnumWindows` 按 PID **连隐藏窗口一起枚举**，取面积最大者再 `SW_SHOW`。实测：隐藏的 DSH 窗口 133ms 恢复并到前台。
- **没点通知就不会跳**。Host 只在 `click.json` 新鲜（30s）时才给 sessionId；你只是把窗口切回来，不会莫名换会话。
- **退路模式**：没有 `bin\focus-window.exe` 或协议没登记时，toast 退回 DSH 自己的 `dsh://open`（要启动第二个 Electron，慢），此时没有 token，`/pending` 只能按"最近一条"跳——会重新出现"自己切回窗口也跳"的老毛病，属于降级行为。

| 路径 | 到前台 |
| --- | --- |
| `dsh-notify://focus`（默认） | 35~133ms |
| `dsh://open`（退路） | 9000ms 量级，且旧进程没有前台权限常压在后面 |

## 为什么有 Host 和浏览器两半

渲染进程弹系统通知得走 Chromium `Notification`，而 Windows 上它依赖登记到开始菜单快捷方式的 AppUserModelID；DSH 窗口的源是 `dsh-app://app`（主进程转发到本机 Host），这个 ID 在渲染进程里拿不到也注册不了。所以：

- **浏览器半边**（`lib/client.js`）：判定该不该提醒、该不该跳，并完成导航；
- **Host 半边**（`lib/index.js`）：真正弹 toast（PowerShell + WinRT），并维护 token ↔ 会话的映射。

## 路由与信任边界

```
POST /plugins/dsh-desktop-notify/notify   弹通知（application/json）
POST /plugins/dsh-desktop-notify/log      浏览器侧诊断（字段白名单 + 独立配额）
GET  /plugins/dsh-desktop-notify/config   { trigger, sound, aumid, protocol }
GET  /plugins/dsh-desktop-notify/pending  只读：{ sessionId, token, source }
POST /plugins/dsh-desktop-notify/pending  消费：{ token } 或 { clear: true }
POST /plugins/dsh-desktop-notify/focus    把窗口提到最前
```

判据（比"是 loopback 就行"严）：

- `Host` 必须是 **IP 字面量或 localhost**（DNS rebinding 的 Host 是攻击者域名，直接挡掉；局域网 IP 放行，因为 DSH 可以绑 `192.168.x.x`）；
- 拒绝 `sec-fetch-site: cross-site`；
- **POST 必须 `application/json`** —— 浏览器在 `no-cors` 下无法设置这个头，这一条就堵死了"任意本机页面伪造通知"；
- 带了 `Origin` 时必须与 `Host` 同 authority（`dsh-app://app` 与 `null` 例外）。

## 配置

### 用户可见：设置 → 通用 →「任务完成提醒」

三档按钮，选中即生效：

| 值 | 什么时候弹 |
| --- | --- |
| `unfocused`（默认） | 只要 DSH 不在前台；在前台但停在别的会话上也弹 |
| `minimized` | 只有最小化 / 收进托盘 |
| `always` | 总是（含正盯着这条会话） |

存 `localStorage`（`dsh-desktop-notify:trigger`）。**本机选过的值优先于 profile 默认值**，而且启动后用户再改也不会被晚到的 `/config` 覆盖。

UI 整段包在 `try/catch` 且用 `ctx.inject(['slots','locale'], …)` 延迟注入：设置页出问题绝不影响提醒。

### profile 里的默认值

```yaml
- id: desktop-notify
  name: dsh-desktop-notify
  config:
    aumid: com.deepseek.dsh   # 通知署名；写错会静默丢 toast
    sound: true
    debug: true               # false 则不写 host.log
    trigger: unfocused        # 仅当用户没在设置里选过时生效
    protocol: true            # false 则不自动登记 dsh-notify:
```

### AUMID 是最容易踩的坑

Windows 通知绑定「开始菜单快捷方式登记的 AppUserModelID」。字符串写错时 `CreateToastNotifier` **不抛异常**，只把 toast 静默丢弃——现象是"路由 200、桌面一片安静"，很容易误判成插件没装。v0.1 就踩过（写成 `DeepSeek Harness`，实际是 `com.deepseek.dsh`）。

换品牌 / 不确定时先查真实值（默认读的就是 DSH 自己的快捷方式）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\read-aumid.ps1
```

## 安装

已安装形态是**目录联接**，不是副本——改项目里的代码就是改已安装的插件：

```
<profile>\node_modules\dsh-desktop-notify  →  D:\Projects\own\dsh-notify
<profile>\cordis.patch.yml                 →  末尾一段 - insert: [{ id: desktop-notify, name: dsh-desktop-notify }]
```

新机器：

1. `git clone <repo> D:\Projects\own\dsh-notify`
2. `npm run setup` —— 编译 `bin\focus-window.exe` 并登记 `dsh-notify:` 协议（两步也可以分开跑：`build:focus` / `protocol:install`）
3. 建联接：`New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target D:\Projects\own\dsh-notify`
4. `<profile>\cordis.patch.yml` 末尾追加上面那段 insert
5. 重启 DSH 桌面端（Host 插件和浏览器包都只在启动时装载）

`dsh-notify:` 协议在 Host 启动时也会自动登记（幂等，`config.protocol: false` 可关）；**挪动项目目录后要重跑 `npm run setup`**，否则注册表里指着旧路径。

> profile 实际路径：`D:\HarnessData\dsh\profiles\desktop`（`C:\Users\<用户>\.dsh` 是指向它的联接）。

## 卸载

1. 删掉 `cordis.patch.yml` 里那段 insert → 重启
2. `npm run protocol:uninstall` —— 删掉 `dsh-notify:` 登记（**必做**，否则操作中心里的旧 toast 点下去会去启动一个不存在的 exe）
3. `cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`（只删联接，不动源码）

## 开发流程

1. 改 `lib/index.js` / `lib/client.js` / `native/FocusWindow.cs`
2. 改 C# 后 `npm run build:focus`（产出 `bin\focus-window.exe`，`bin/` 不入库）
3. `npm test`（浏览器半边逻辑，不弹通知）/ `npm run test:live`（额外真弹一条）
4. 完全退出 DSH（托盘右键退出，不是关窗口）→ 重开 → 真机验证
5. 提交

> `.ps1` 一律存成 **UTF-8 with BOM**。Windows PowerShell 5.1 没有 BOM 时按 ANSI 读，中文注释会被读成乱码，运气不好直接变成语法错误；更坑的是 `Parser::ParseFile` **检不出来**（括号恰好仍平衡），必须直接看字节：
>
> ```powershell
> Get-ChildItem scripts\*.ps1 | ForEach-Object {
>   $b = [IO.File]::ReadAllBytes($_.FullName)
>   "$($_.Name): " + (($b[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' ')
> }
> ```
>
> 输出不是 `EF BB BF` 就是坏的。

## 自检

```bash
npm test              # 浏览器半边：判定、点击链路、设置行（不起 DSH、不弹通知）
npm run test:live     # 再加 Host 半边：路由、来源校验、去重、pending（会真弹通知）
```

浏览器半边自检喂的是**真实行形状**（`displayTitle` / `origin` / `parentId` / `retainedBy`）。早先用了不存在的 `parentSessionId` / `depth`，导致子智能体过滤完全失效而自检一直是绿的——这类"自证式测试"要避免。

## 排障

日志：`%LOCALAPPDATA%\dsh-desktop-notify\host.log`（超过 1MB 轮转成 `host.log.1`），一行一个 JSON。

| 日志 | 含义 |
| --- | --- |
| `"kind":"protocol"` | 启动时登记协议的结果（`registered` / `exe`） |
| `"kind":"client","event":"client-apply"` | 浏览器半边进图了 |
| `"kind":"client","event":"transition"` | 一次判定，`action` 是 `notify` / `skip-visible` / `skip-watching` / `skip-derived` |
| `"kind":"notify"` + `"token"` | 通知已发出，token 就是点击时回传的那一个 |
| `"kind":"notify-exit","code":0` | PowerShell 退出码；非 0 说明 toast 没弹出来 |
| `"kind":"notify-failed"` + HTTP 503 | 通知没发出去，浏览器半边已回退 `new Notification()` |
| `"kind":"client","event":"navigate"` | 点了通知并切到了对应会话 |
| `"kind":"client","event":"navigate-skip"` | 已经在该会话，只消费不跳 |
| `"kind":"focus-requested"` / `"focus-exit"` | 置顶请求与 exe 退出码（0 成功 / 2 被系统拒 / 3 转交 `dsh://open`） |

`bin\focus-window.exe` 也能手动跑（返回码同上），`scripts\focus-window.ps1` 是退路，会把结果写进 `focus.log`。

常见症状对照：

- **一条通知都没有** → 看有没有 `notify`；有 `notify` 没弹窗，多半是 AUMID 不对（跑 `read-aumid.ps1`）；
- **点了没反应** → `Get-ItemProperty HKCU:\Software\Classes\dsh-notify\shell\open\command` 看有没有指着当前 exe；
- **点了窗口起来但没跳会话** → 看 `source` 是不是 `none`（没读到 click.json）或 `legacy`（协议没登记，退路模式）。

## 路线（TODO）

- [x] **M1** 通知能弹、点通知能恢复窗口 / 切会话 / 置顶（含收进托盘）
- [x] **M3** 设置 → 通用三档开关
- [x] **M4** 排障日志（协议、通知、置顶、判定全覆盖）
- [ ] **M2 事件全覆盖**：失败与中断也提醒；同一轮多次交互合并
- [ ] **M5 分发**：`npm pack` + 安装说明，发到 DSH 插件仓库（`private: true` 届时去掉）
- [ ] **M6 静音与时间窗**：安静时段、按会话类型分别开关
- [ ] **M7 通知本身的延迟**：每条 toast 起一个 `powershell.exe` 再加载 WinRT（约 400~700ms）。
  体感是"任务完成后通知稍晚出现"，不影响点击速度。可选：常驻 PowerShell 走命名管道，或把 Toast 搬进 C#（要处理 winmd 引用）
