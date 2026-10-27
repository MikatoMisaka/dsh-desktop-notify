---
name: dsh-desktop-notify
description: 在 DSH（DeepSeek Harness）里安装、检查或卸载桌面通知插件 dsh-desktop-notify。用户提到「完成通知」「桌面通知」「点通知回到会话」「装通知插件」时使用本技能。
---

# dsh-desktop-notify

给 DSH 桌面端（Windows）装一套通知：任务跑完、或 DSH 停下来等你回答时弹系统通知；点通知把窗口拉到前台并跳到那条会话。

## 先确认这份技能是怎么被读到的

DSH 只从固定根目录发现技能（`.agents\skills`、`.dsh\skills`、`<dshHome>\skills`、`<agentsHome>\skills`），**不会扫 `node_modules` 里的嵌套 `SKILL.md`**。所以随插件发布的这份文件，需要在安装时放到扫描根下：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item <源码>\skills\dsh-desktop-notify "$env:USERPROFILE\.agents\skills\dsh-desktop-notify" -Recurse -Force
```

放完要重启 DSH（或重新加载技能）才生效。不放也不影响通知功能，只是 agent 看不到这份说明。

## 它靠什么工作

- **Host 半边**（`lib/index.js`）：注册 `/plugins/dsh-desktop-notify/*` 路由，用 PowerShell 调 WinRT 发 toast，维护 `token → 会话` 映射。
- **浏览器半边**（`lib/client.js`）：判断该不该提醒，窗口恢复后问 Host「刚才被点的是哪条」，再调 `ctx.uiWorkspace.openSession` 切会话。
- **原生小工具**（`bin\focus-window.exe`）：点通知时被协议拉起，负责 restore + 置顶。它由 `native\FocusWindow.cs` 编译而来，**不在仓库里**，装完必须编译一次。

## 安装

先定位 profile 目录：读 `$env:DSH_HOME` 与 `$env:DSH_PROFILE`（本机是 `D:\HarnessData\dsh\profiles\desktop`；`C:\Users\<你>\.dsh` 只是指向它的联接）。

1. 取源码到固定目录，例如 `D:\Projects\own\dsh-notify`。
2. 编译并登记协议（**必须在包目录里执行**，否则 `npm run setup` 会报 Missing script）：

   ```powershell
   cd <源码目录>
   npm run setup
   ```

3. 建目录联接（父目录 `node_modules` 必须已存在）：

   ```powershell
   New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target <源码目录>
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

日志：`%LOCALAPPDATA%\dsh-desktop-notify\host.log`（一行一个 JSON）。

- `{"kind":"protocol","registered":true}` + `{"kind":"host-ready","pid":<DSH 的 pid>}`：Host 半边起来了。
- `{"kind":"client","event":"client-apply"}`：浏览器半边进图了。
- `{"kind":"aumid-checked","state":"primary"}`：通知署名核对通过；`aumid-unregistered` 说明配置的 AUMID 没登记，已改用备用身份。

> 自检脚本（`selftest.mjs`）也写同一个日志文件，会留下 `registered:false` 的记录。**核对时认最后一条 `host-ready` 的 pid**，别被自检的 `registered:false` 误导。

通道自测（不碰会话）：先取 DSH 的 web 端口（DSH 界面地址里的那个端口，或 host 启动日志里的监听端口），然后：

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:<端口>/plugins/dsh-desktop-notify/notify' -Method POST -ContentType 'application/json' -Body '{"title":"自检","body":"通道测试","key":"probe-1"}' -UseBasicParsing
```

没弹窗但日志有 `notify`：多半是 AUMID 不对，跑 `scripts\read-aumid.ps1` 核对（它只打印一个值，填进 insert 下的 `config.aumid`，别新增顶层条目）。

## 卸载

1. 删掉 `cordis.patch.yml` 里那段 insert（有备份就还原）。
2. `npm run protocol:uninstall`（**必做**，否则操作中心里的旧 toast 会去找一个不存在的 exe）。
3. `cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`（只删联接；别用 `rd /s`）。
4. 重启 DSH。

## 注意

- `protocol: false` 或协议登记失败时，点通知会退回 `dsh://open`：慢（要拉起一个完整 DSH 进程），且没有 token，只能按"最近一条通知"跳会话。日志里 `protocol` 的 `registered` 为 false 就是这个状态。
- 改过 `native\FocusWindow.cs` 要重跑 `npm run build:focus`，否则用的还是旧 exe。
- 挪动源码目录后要**同时**重建联接与重跑 `npm run setup`（注册表里的协议指向绝对路径）。
