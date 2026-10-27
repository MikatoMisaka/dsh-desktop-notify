---
description: "DSH 桌面端（Windows）通知插件：任务完成或等待回答时弹系统通知，点通知直接回到对应会话。"
kind: "package-reference"
---

# dsh-desktop-notify

DeepSeek Harness 桌面端（Windows）的通知插件。

## 功能

- **任务完成提醒**：一轮任务结束时弹 Windows 通知，留在操作中心。
- **等待你回答时提醒**：提问、计划审阅、工具调用确认，各有独立文案（工具确认带工具名）。
- **点通知直达会话**：把 DSH 拉到前台，并切到**那条通知**对应的会话。
- **收进托盘也能找回**：DSH 关窗口即隐藏到托盘，插件按 PID 枚举隐藏窗口，照样能恢复并置顶。
- **不误打扰**：你看这条会话时不提醒；子智能体/派生会话不单独提醒；同一张交互卡重复挂载不重复弹；1.5 秒同键去重、10 秒最多 6 条。
- **可配**：三档触发时机，设置页里点选即生效。

## 配置

### 界面

「设置 → 通用 → 任务完成提醒」三档按钮，选择存本机（`localStorage`），优先于 profile 默认值。

| 档位 | 含义 |
| --- | --- |
| 不在前台就提醒（默认） | 切走、最小化、收进托盘、锁屏都提醒；在前台但停在别的会话上也提醒 |
| 仅最小化时 | 只有最小化 / 收进托盘才提醒 |
| 总是提醒 | 包括你正盯着这条会话 |

### profile

`<profile>\cordis.patch.yml` 里那条 insert 的 `config`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `aumid` | `com.deepseek.dsh` | 通知署名的 AppUserModelID。启动时会用 `Get-StartApps` 核一次登记状态。 |
| `fallbackAumid` | PowerShell 自己的 ID | 主署名的备用身份；显式给空串表示关闭兜底。 |
| `sound` | `true` | 是否带提示音。 |
| `trigger` | `unfocused` | `unfocused` / `minimized` / `always`；仅当用户没在设置里选过时生效。 |
| `protocol` | `true` | 是否登记 `dsh-notify:` 协议（点通知的快路径）。 |
| `debug` | `true` | 是否写日志 `%LOCALAPPDATA%\dsh-desktop-notify\host.log`。 |
| `dryRun` | `false` | 仅测试/CI：走完整通知流程但不真的弹窗（`selftest.mjs` 默认开）。 |
| `dataDir` | `%LOCALAPPDATA%\dsh-desktop-notify` | 日志与 `click.json` 的目录；仅测试时改用临时目录。 |
| `notifyWhenFocused` | — | 已弃用，`true` 等价于 `trigger: always`。 |

**AUMID 写错不会报错，只会把 toast 静默丢掉**。启动时若发现配置的 AUMID 不在开始菜单的 AppID 列表里，插件会记一条 `aumid-unregistered` 并改用备用身份；想用回 DSH 自己的署名，跑 `scripts\read-aumid.ps1` 取真实值。

## 安装

需要 Windows 10/11 + DSH 桌面端。下文把源码目录写作 `D:\Projects\own\dsh-notify`，把 profile 目录写作 `<profile>`——它不一定在默认位置，先确认：`$env:DSH_HOME` + `$env:DSH_PROFILE`（本机是 `D:\HarnessData\dsh\profiles\desktop`，而 `C:\Users\<你>\.dsh` 只是指向它的联接）。

### 从 npm（发布后可用）

包名以 npm 上的实际名为准（例如 `dsh-notify-focus`），`name` 必须与之一致：

1. 在 `<profile>\package.json` 的 `dependencies` 加该包，然后在 profile 目录跑一次包管理器安装（DSH 插件管理器装包时也会自动登记 `dsh.profile.bundles`）。
2. 在 `<profile>\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-notify-focus   # 改成实际包名
   ```

3. 装完仍需本地编译一次置顶程序：`npm run setup`（在包目录下，即 `<profile>\node_modules\<包名>`）。
4. 完全退出 DSH 桌面端（托盘右键退出，不是关窗口）再打开。

### 从源码

1. 取源码到固定位置：

   ```powershell
   git clone https://github.com/MikatoMisaka/dsh-desktop-notify D:\Projects\own\dsh-notify
   ```

2. 编译置顶程序并登记协议（`setup` = `build:focus` + `protocol:install`）：

   ```powershell
   cd D:\Projects\own\dsh-notify
   npm run setup
   ```

3. 链进 profile（目录联接；**父目录 `node_modules` 必须已存在**，否则会失败）：

   ```powershell
   New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target D:\Projects\own\dsh-notify
   ```

4. 改 patch 之前先备份，再追加：

   ```powershell
   Copy-Item <profile>\cordis.patch.yml <profile>\cordis.patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)
   ```

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-desktop-notify
   ```

5. 完全退出 DSH 桌面端后重新打开。

### 卸载

1. 删掉 `cordis.patch.yml` 里那段 insert（改前有备份的话可还原）。
2. `npm run protocol:uninstall` —— 删掉 `dsh-notify:` 登记，否则操作中心里的旧 toast 点下去会去找一个不存在的 exe。
3. `cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`（只删联接，不动源码）。
4. 重启 DSH。

### 两个容易踩的点

- **挪动源码目录**后，光重跑 `npm run setup` 不够：`node_modules` 里那个联接会悬空，要删掉重建，否则插件根本加载不到。
- **包内 `skills\` 不会被自动发现**：DSH 只扫 `.agents\skills`、`.dsh\skills`、`<dshHome>\skills` 等固定根目录，不扫 `node_modules` 里的嵌套 `SKILL.md`。想让 agent 用上这份技能，把 `skills\dsh-desktop-notify` 复制（或软链）到 `%USERPROFILE%\.agents\skills\`。
