---
name: dsh-desktop-notify
description: 在 DSH（DeepSeek Harness）里安装、检查或卸载桌面通知插件 dsh-desktop-notify。用户提到「完成通知」「桌面通知」「点通知回到会话」「装通知插件」时使用本技能。
---

# dsh-desktop-notify

给 DSH 桌面端（Windows）装一套通知：任务跑完、或 DSH 停下来等你回答时弹系统通知；点通知把窗口拉到前台并跳到那条会话。

## 它靠什么工作

- **Host 半边**（`lib/index.js`）：注册 `/plugins/dsh-desktop-notify/*` 路由，用 PowerShell 调 WinRT 发 toast，并维护 `token → 会话` 的映射。
- **浏览器半边**（`lib/client.js`）：判定该不该提醒（三档），窗口恢复后向 Host 问「刚才被点的是哪条」，再调 `ctx.uiWorkspace.openSession` 切会话。
- **原生小工具**（`bin\focus-window.exe`）：点通知时被协议拉起，负责 restore + 置顶。它由 `native/FocusWindow.cs` 编译而来，**不在仓库里**，安装后必须编译一次。

## 安装

1. 取源码到固定目录（示例 `D:\Projects\own\dsh-notify`）。
2. 编译并登记协议：`npm run setup`（等于 `build:focus` + `protocol:install`）。
3. 把目录链进 profile：在 `<profile>\node_modules\` 下建名为 `dsh-desktop-notify` 的目录联接，指向源码目录。
4. 在 `<profile>\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-desktop-notify
   ```

5. 让用户**完全退出** DSH 桌面端再打开（托盘右键退出，不是关窗口）——Host 插件和浏览器包只在启动时装载。

## 检查是否生效

- 日志：`%LOCALAPPDATA%\dsh-desktop-notify\host.log`。启动后应能看到 `protocol`（`registered:true`）和 `host-ready`；浏览器侧加载后会有 `client-apply`。
- 快速验通道（不碰会话）：向 `http://127.0.0.1:<端口>/plugins/dsh-desktop-notify/notify` 发一条 `POST`，body `{"title":"自检","body":"通道测试","key":"probe-1"}`，`Content-Type: application/json`。
- 没弹窗但日志有 `notify`：多半是 AUMID 不对，跑 `scripts\read-aumid.ps1` 核对，或把 `config.aumid` 指到真实值。

## 卸载

1. 删掉 `cordis.patch.yml` 里那段 `insert`。
2. `npm run protocol:uninstall`（必做，否则操作中心里的旧 toast 点下去会去找一个不存在的 exe）。
3. 删掉 `node_modules\dsh-desktop-notify` 联接。
4. 重启 DSH。

## 注意

- `.ps1` 必须存成 UTF-8 with BOM，否则 Windows PowerShell 5.1 按 ANSI 读中文注释会直接语法错误。
- 改过 `native/FocusWindow.cs` 要重跑 `npm run build:focus`，否则用的还是旧 exe。
- 挪动源码目录后要重跑 `npm run setup`，注册表里的协议指向的是绝对路径。
