# 发布清单

> 状态：**代码、仓库、目录收录都已就绪，只剩 npm 登录**。

## 已就绪

| 项 | 状态 |
| --- | --- |
| GitHub 仓库 | <https://github.com/MikatoMisaka/dsh-desktop-notify>（public，`main`） |
| 目录收录 | 仓库已打 `dsh-plugin` / `dsh` / `deepseek-harness` / `desktop-notification` / `windows` 五个 topic，[dsh-plugin.org](https://dsh-plugin.org) 靠 topic 自动发现 |
| 插件规范 | `dsh.bundle.patch`、`dsh.client.platform: "web"`、`exports["./client"]` 齐备 |
| 许可证 | MIT（`LICENSE`） |
| 包内容 | `lib` / `scripts` / `native` / `bin` / `selftest.mjs` / `client-selftest.mjs` / `cordis.patch.yml` / `README.md` |
| 自检 | `npm test`（不弹通知）、`npm run test:live`（真弹一条） |

## 明天唯一的动作：登录 npm

```powershell
npm login
# 或用 token：
# npm config set //registry.npmjs.org/:_authToken=<token>
```

## 然后发布

```powershell
cd D:\Projects\own\dsh-notify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Name dsh-notify-focus
```

脚本会：编译（若缺）`bin\focus-window.exe` → 在 `%TEMP%` 里拷一份**暂存副本** → 只改副本的 `name`/`private`/`repository`/`engines`/`publishConfig` → 跑 `npm test` → `npm publish --access public`。

> 为什么用暂存副本：改包名会让本地已装的插件（目录联接 + `cordis.patch.yml` 里的 `name`）对不上，重启后插件会消失。发布走副本，工作区和本地安装都不受影响。

## 包名说明

`dsh-desktop-notify` 已被他人占用（`crazy-L118`，1.4.1），且 `dsh-notify-win` / `dsh-turn-notify` / `dsh-notify-desktop` / `dsh-desktop-notifier` / `dsh-notify-windows` / `dsh-desktop-toast` / `dsh-notify-tray` / `dsh-win-notify` 也都已被占。

截至 2026-10-28 仍空着、且语义贴切的：

| 候选 | 含义 |
| --- | --- |
| `dsh-notify-focus`（推荐） | 强调差异点：点通知把窗口拉到前台并落到会话 |
| `dsh-click-notify` | 同上，更直白 |
| `dsh-desktop-notify-win` | 明确是那款跨平台插件的 Windows 特化版 |

想用 scope 也可以：`@<npm 用户名>/dsh-desktop-notify`（发布时 `--access public`）。

## 发布后（可选，两步人工）

1. <https://dsh-plugin.org/zh/submit> 填一次仓库地址（topic 已能自动发现，这是加速人工审核）。
2. 若想让本地也改用 npm 版：把联接改成 `node_modules\<新包名>`，并把 `cordis.patch.yml` 里的 `name` 同步改成新包名，重启 DSH。

## 留在本机的东西

- 源码：`D:\Projects\own\dsh-notify`
- 已装形态：`<profile>\node_modules\dsh-desktop-notify` → 该目录的目录联接，`cordis.patch.yml` 末尾一段 insert
- 协议：`HKCU\Software\Classes\dsh-notify` → `bin\focus-window.exe`（`npm run protocol:uninstall` 可删）
