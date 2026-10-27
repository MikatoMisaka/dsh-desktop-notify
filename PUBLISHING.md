# 发布清单

## 状态

| 项 | 状态 |
| --- | --- |
| GitHub 仓库 | <https://github.com/MikatoMisaka/dsh-desktop-notify>（public，`main`） |
| 目录收录 | 仓库已打 `dsh-plugin` / `dsh` / `deepseek-harness` / `desktop-notification` / `windows`，[dsh-plugin.org](https://dsh-plugin.org) 靠 topic 自动发现 |
| 插件规范 | `dsh.bundle.patch`、`dsh.client.platform: "web"`、`exports["./client"]` 齐备；client 模块 id 与包名一致（`client-selftest.mjs` 会校验） |
| 许可证 | MIT（`LICENSE` + `package.json`） |
| 发布脚本 | 已重写并自测（见下）；**尚未在真实登录态下跑过 publish** |
| npm | **未登录**，这是唯一的前置动作 |

## 发布前

```powershell
npm login
# 或用 token：npm config set //registry.npmjs.org/:_authToken=<token>
```

工作区必须干净——脚本第一步就会检查 `git status --porcelain`，因为发布包是从工作区拷的，脏工作区会让 npm 用户和 `git clone` 用户拿到不同代码。

## 发布

```powershell
cd D:\Projects\own\dsh-notify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Name dsh-notify-focus
```

参数：`-Name`（必填）、`-Version`（可选，覆盖版本号）、`-DryRun`（只预览）、`-SkipLive`（跳过会弹通知的 host 自检）。

脚本做的事：

1. 检查工作区干净 → 检查 `npm whoami`；
2. 缺 `bin\focus-window.exe` 就先编译；
3. 拷一份暂存副本到 `%TEMP%\dsh-notify-publish-<pid>-<rand>`（不动工作区、不动本地已装的那份）；
4. 改写副本的 `package.json`（name / version / private / author / repository / homepage / bugs / engines / publishConfig），**读取时显式用 UTF-8**（5.1 默认 ANSI 会把中文 description 读成乱码）；
5. **同步改名**：`cordis.patch.yml` 的 `name:` 与 `lib/client.js` 的 `id:` 一起改成新包名，然后断言三处一致——DSH 用包名当 client 模块 entry id，漏改会硬抛 `loaded without registering`；
6. 跑 `client-selftest.mjs`（安静）+ `selftest.mjs --live`（真弹通知，验证通道；`-SkipLive` 可跳过）；
7. 用 `npm pack --dry-run --json` 断言关键文件真的进了 tarball（`package.json` / `lib/*` / `cordis.patch.yml` / `bin/focus-window.exe` / `skills/.../SKILL.md`）——npm 对 `files` 里不存在的项是**静默忽略**的；
8. `npm publish --access public`，检查退出码；
9. 无论成败都清掉暂存目录。

## 发布后验收

```powershell
npm view <新包名> version
npm view <新包名> dsh.client      # 应当能看到 platform/inject
```

再在一台干净机器（或删掉联接重建）上按 README 的「从 npm」一节装一次，确认三件事：通知能弹、点通知能到前台并跳会话、设置里有那一行。

可选：<https://dsh-plugin.org/zh/submit> 填一次仓库地址，加速人工审核（topic 已能被自动发现，审核本身可能滞后）。

## 包名

`dsh-desktop-notify` 已被他人占用（`crazy-L118`，1.4.1，跨平台版本）。以下也已被占：`dsh-notify-win`、`dsh-turn-notify`、`dsh-notify-desktop`、`dsh-desktop-notifier`、`dsh-notify-windows`、`dsh-desktop-toast`、`dsh-notify-tray`、`dsh-win-notify`。

截至 2026-10-28 仍空闲、语义贴切的：

| 候选 | 含义 |
| --- | --- |
| `dsh-notify-focus`（推荐） | 强调差异点：点通知把窗口拉到前台并落到会话 |
| `dsh-click-notify` | 同上，更直白 |
| `dsh-desktop-notify-win` | 明确是那款跨平台插件的 Windows 特化版 |

用 scope 也可以（`@<npm 用户名>/dsh-desktop-notify`），脚本会自动加 `--access public`；注意 client 模块 id 也要等于**全名**（含 scope），脚本已按同一规则改写。

## 维护注记

- `bin/` 被 `.gitignore` 忽略：仓库里没有 exe，npm 包里有（脚本保证），所以从源码装必须跑一次 `npm run setup`。
- 本地已装的那份用包名 `dsh-desktop-notify` + 目录联接；**发布走副本，不影响它**。若想让本地也切到 npm 版，改联接名和 patch 里的 `name` 即可。
- `.ps1` 一律存 UTF-8 **with BOM**：Windows PowerShell 5.1 无 BOM 时按 ANSI 读，中文注释会直接把语法读坏；`Parser::ParseFile` 检不出来（括号恰好仍平衡），要直接看前 3 字节是否为 `EF BB BF`。
- 发出去的 `README.md` 里「从源码」一节仍写 `name: dsh-desktop-notify`，这是有意的——那节讲源码安装，包名就是仓库名；「从 npm」一节已写成"改成实际包名"。
