---
description: "DSH 桌面端（Windows）通知插件：任务完成或等待回答时弹系统通知，点通知直接回到对应会话。"
kind: "package-reference"
---

# dsh-desktop-notify

DeepSeek Harness 桌面端（Windows）的通知插件。

## 作用

- **任务完成提醒**：一轮任务结束时弹 Windows 通知，**正文预览这轮回复的最后一段**，留在操作中心。
- **等待你回答时提醒**：提问、计划审阅、工具调用确认各有文案（工具确认带工具名）。
- **点通知直达会话**：把 DSH 拉到前台，并切到**那条通知**对应的会话。
- **收进托盘也能找回**：DSH 关窗口即隐藏到托盘，插件按 PID 枚举隐藏窗口，照样恢复并置顶。
- **不误打扰**：你看这条会话时不提醒；子智能体不单独提醒；1.5 秒同键去重、10 秒最多 6 条。
- **可配**：三档触发时机，设置页里点选即生效。

## 安装

需要 Windows 10/11 + DSH 桌面端。下文 `<profile>` 指 profile 目录（看 `$env:DSH_HOME` 与 `$env:DSH_PROFILE`，不一定在默认位置），`<包名>` 指实际安装名（npm 上是 `dsh-notify-focus`）。

### 从 npm

1. 把包加进 profile 的依赖（或用 DSH 的插件管理器安装）：

   ```powershell
   npm --prefix <profile> install dsh-notify-focus
   ```

2. `<profile>\cordis.patch.yml` 末尾追加（改前先备份）：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-notify-focus
   ```

3. 在包目录里做一次本地初始化（编译置顶程序 + 登记协议）：

   ```powershell
   cd <profile>\node_modules\dsh-notify-focus
   npm run setup
   ```

4. 完全退出 DSH 桌面端（托盘右键退出，不是关窗口）再打开。

### 从源码

1. 取源码到固定目录：

   ```powershell
   git clone https://github.com/MikatoMisaka/dsh-desktop-notify D:\Projects\own\dsh-notify
   ```

2. 编译并登记协议：

   ```powershell
   cd D:\Projects\own\dsh-notify
   npm run setup
   ```

3. 链进 profile（父目录 `node_modules` 必须已存在）：

   ```powershell
   New-Item -ItemType Junction -Path <profile>\node_modules\dsh-desktop-notify -Target D:\Projects\own\dsh-notify
   ```

4. `<profile>\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-desktop-notify
   ```

5. 完全退出 DSH 桌面端再打开。

**卸载**：删掉那段 insert → `npm run protocol:uninstall` → `cmd /c rmdir <profile>\node_modules\<包名>` → 重启 DSH。

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
| `aumid` | `com.deepseek.dsh` | 通知署名的 AppUserModelID；启动时会用 `Get-StartApps` 核一次登记状态。 |
| `fallbackAumid` | PowerShell 自己的 ID | 主署名的备用身份；显式给空串表示关闭兜底。 |
| `sound` | `true` | 是否带提示音。 |
| `trigger` | `unfocused` | `unfocused` / `minimized` / `always`；仅当用户没在设置里选过时生效。 |
| `protocol` | `true` | 是否登记 `dsh-notify:` 协议（点通知的快路径）。 |
| `debug` | `true` | 是否写日志 `%LOCALAPPDATA%\dsh-desktop-notify\host.log`。 |

`aumid` 写错**不会报错**，只会让 toast 被静默丢掉；启动日志里看到 `aumid-unregistered` 就说明配置的 ID 没登记，跑 `scripts\read-aumid.ps1` 取真实值。
