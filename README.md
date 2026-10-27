---
description: "DSH 桌面端（Windows）通知插件：任务完成或等待回答时弹系统通知，点通知直接回到对应会话。"
kind: "package-reference"
---

# dsh-desktop-notify

DeepSeek Harness 桌面端（Windows）的通知插件。

## 功能

- **任务完成提醒**：一轮任务结束时弹 Windows 通知，留在操作中心。
- **等待你回答时提醒**：提问、计划审阅、工具调用确认，各有一条对应文案（工具确认带工具名）。
- **点通知直达会话**：把 DSH 拉到前台，并切到**那条通知**对应的会话。
- **收进托盘也能找回**：DSH 关窗口即隐藏到托盘，插件按 PID 枚举隐藏窗口，照样能恢复并置顶。
- **不误打扰**：你在看这条会话时不提醒；子智能体/派生会话不单独提醒；同一张交互卡重复挂载不重复弹；1.5 秒同键去重、10 秒内最多 6 条。
- **可配**：三档触发时机，设置页里点选即生效。

## 配置

### 界面

「设置 → 通用 → 任务完成提醒」三档按钮，选择存在本机（`localStorage`），优先于 profile 默认值。

| 档位 | 含义 |
| --- | --- |
| 不在前台就提醒（默认） | 切走、最小化、收进托盘、锁屏都提醒；在前台但停在别的会话上也提醒 |
| 仅最小化时 | 只有最小化 / 收进托盘才提醒 |
| 总是提醒 | 包括你正盯着这条会话 |

### profile

`<profile>\cordis.patch.yml` 里给这条 insert 加 `config`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `aumid` | `com.deepseek.dsh` | 通知署名的 AppUserModelID。写错会静默丢 toast。 |
| `fallbackAumid` | Windows PowerShell 自己的 ID | 主署名抛错时用它再发一次，保证通知不会彻底消失（署名会显示成 Windows PowerShell）。 |
| `sound` | `true` | 是否带提示音。 |
| `trigger` | `unfocused` | `unfocused` / `minimized` / `always`；仅当用户没在设置里选过时生效。 |
| `protocol` | `true` | 是否在启动时登记 `dsh-notify:` 协议（点通知的快路径）。 |
| `debug` | `true` | 是否写排障日志 `%LOCALAPPDATA%\dsh-desktop-notify\host.log`。 |

## 安装

需要 Windows 10/11 + DSH 桌面端。

1. 取源码到固定位置（下文以 `D:\Projects\own\dsh-notify` 为例）：

   ```powershell
   git clone https://github.com/MikatoMisaka/dsh-desktop-notify D:\Projects\own\dsh-notify
   ```

2. 编译置顶程序并登记协议：

   ```powershell
   cd D:\Projects\own\dsh-notify
   npm run setup
   ```

3. 链进 profile（目录联接，改代码即改已装插件）：

   ```powershell
   New-Item -ItemType Junction -Path D:\HarnessData\dsh\profiles\desktop\node_modules\dsh-desktop-notify -Target D:\Projects\own\dsh-notify
   ```

4. 在 `D:\HarnessData\dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: desktop-notify
         name: dsh-desktop-notify
   ```

5. 完全退出 DSH 桌面端（托盘右键退出，不是关窗口）后重新打开。

卸载：删掉上面的 insert → 重启 → `npm run protocol:uninstall` → `cmd /c rmdir <profile>\node_modules\dsh-desktop-notify`。

> 挪动项目目录后要重跑 `npm run setup`，否则 `dsh-notify:` 协议仍指向旧路径。
