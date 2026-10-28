# 把插件发布到 npm —— 用 %TEMP% 里的暂存副本发布，不动工作区、不动本地已装的那份。
#
# 为什么不能直接在当前目录 npm publish：
#   1. 包名 dsh-desktop-notify 已被占用，必须改名；
#   2. 改名会让本地 profile 的目录联接与 cordis.patch.yml 的 name 对不上（重启后插件消失）。
#
# 改名不是只改 package.json：DSH 用**包名**当 client 模块的 entry id，bundle 里
# `window.__ModuleLoader__.load({ id })` 的 id 必须等于包名，否则 client-modules 会硬抛
# "loaded without registering ..."。所以 cordis.patch.yml 的 name 与 lib/client.js 的 id
# 都要一起改，脚本会改完再断言。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Name dsh-notify-focus
#   -DryRun   只预览（npm publish --dry-run），不真发
#   -SkipLive 跳过会真弹通知的 host 自检（默认会跑）
#   -Otp      账号开了 2FA 时，传入 6 位动态码（30 秒内有效，所以是运行时才要）

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Version = '',
  [switch]$DryRun,
  [switch]$SkipLive,
  [string]$Otp = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$oldName = 'dsh-desktop-notify'
$stage = Join-Path $env:TEMP ("dsh-notify-publish-{0}-{1}" -f $PID, (Get-Random -Maximum 99999))

function Write-Step([string]$Text) { Write-Output ("==> " + $Text) }

if ($Name -eq $oldName) {
  throw "包名不能用 $oldName：npm 上已被他人占用（1.4.1）。换一个名字或加 scope。"
}

# 1) 工作区必须干净：否则发出去的 tarball 与 GitHub 上的源码不一致
Write-Step '检查工作区'
Push-Location $root
try {
  $dirty = git status --porcelain
} finally {
  Pop-Location
}
if ($dirty) {
  throw ("工作区有未提交改动，先提交再发布：" + [Environment]::NewLine + ($dirty -join [Environment]::NewLine))
}

# 2) 必须已登录（把 npm 的原始输出一并带出来，别把网络/401 误判成"没登录"）
Write-Step '检查 npm 登录'
$whoRaw = (& npm whoami --silent 2>&1) -join ' '
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($whoRaw)) {
  throw ("还没登录 npm。原始输出：" + $whoRaw + [Environment]::NewLine + "先跑 npm login（或 npm config set //registry.npmjs.org/:_authToken=<token>）。")
}
Write-Output ("    npm 用户：" + $whoRaw)

# 3) 置顶程序：发布包里要带上，否则用户装完永远走慢路径
$exe = Join-Path $root 'bin\focus-window.exe'
if (-not (Test-Path $exe)) {
  Write-Step '编译 bin\focus-window.exe'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\build-focus.ps1')
  if (-not (Test-Path $exe)) { throw '编译失败，无法发布' }
}

# 4) 暂存副本
Write-Step ("准备暂存副本 " + $stage)
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$items = @(
  'package.json', 'lib', 'scripts', 'native', 'bin', 'skills',
  'cordis.patch.yml', 'README.md', 'LICENSE', 'selftest.mjs', 'client-selftest.mjs'
)
foreach ($item in $items) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "缺少 $item，无法打包" }
  Copy-Item $src (Join-Path $stage $item) -Recurse -Force
}

try {
  # 5) 改写清单（读时必须指定 UTF8：5.1 默认按 ANSI 读，中文 description 会变乱码）
  Write-Step '改写 package.json'
  $pkgPath = Join-Path $stage 'package.json'
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $pkg.name = $Name
  if ($Version -ne '') { $pkg.version = $Version }
  $pkg | Add-Member -NotePropertyName private -NotePropertyValue $false -Force
  $pkg | Add-Member -NotePropertyName author -NotePropertyValue 'MikatoMisaka' -Force
  $pkg | Add-Member -NotePropertyName repository -NotePropertyValue @{ type = 'git'; url = 'git+https://github.com/MikatoMisaka/dsh-desktop-notify.git' } -Force
  $pkg | Add-Member -NotePropertyName homepage -NotePropertyValue 'https://github.com/MikatoMisaka/dsh-desktop-notify#readme' -Force
  $pkg | Add-Member -NotePropertyName bugs -NotePropertyValue @{ url = 'https://github.com/MikatoMisaka/dsh-desktop-notify/issues' } -Force
  $pkg | Add-Member -NotePropertyName engines -NotePropertyValue @{ node = '>=18' } -Force
  $pkg | Add-Member -NotePropertyName publishConfig -NotePropertyValue @{ access = 'public' } -Force
  $json = $pkg | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

  # 6) 包名 = client 模块 id：patch 与 client.js 都要跟着改
  Write-Step '同步 cordis.patch.yml 与 lib/client.js 的包名'
  $patchPath = Join-Path $stage 'cordis.patch.yml'
  $patchText = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
  $patchText = $patchText.Replace("name: $oldName", "name: $Name")
  [System.IO.File]::WriteAllText($patchPath, $patchText, (New-Object System.Text.UTF8Encoding($true)))

  $clientPath = Join-Path $stage 'lib\client.js'
  $clientText = [System.IO.File]::ReadAllText($clientPath, [System.Text.Encoding]::UTF8)
  $clientText = $clientText.Replace("id: '$oldName'", "id: '$Name'")
  [System.IO.File]::WriteAllText($clientPath, $clientText, (New-Object System.Text.UTF8Encoding($false)))

  # 7) 断言：三处名字必须一致，否则发出去的包在别人机器上起不来
  Write-Step '断言改名一致性'
  $patchAfter = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
  $clientAfter = [System.IO.File]::ReadAllText($clientPath, [System.Text.Encoding]::UTF8)
  $pkgAfter = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pkgAfter.name -ne $Name) { throw 'package.json 的 name 没改成功' }
  if (-not $patchAfter.Contains("name: $Name")) { throw "cordis.patch.yml 里没有 name: $Name" }
  if (-not $clientAfter.Contains("id: '$Name'")) { throw "lib/client.js 里没有 id: '$Name'" }
  Write-Output "    ok：package.json / cordis.patch.yml / lib/client.js 都是 $Name"

  # 8) 自检：先跑客户端（安静），再跑 host（会真弹通知）
  Write-Step '跑自检'
  Push-Location $stage
  try {
    & node 'client-selftest.mjs' | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw 'client-selftest 失败' }
    if (-not $SkipLive) {
      & node 'selftest.mjs' '--live' | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) { throw 'selftest 失败' }
    } else {
      Write-Output '    （已跳过 host 自检：-SkipLive）'
    }
  } finally {
    Pop-Location
  }

  # 9) 打包断言：files 里声明的东西必须真的进 tarball（npm 对缺失项静默忽略）
  Write-Step '检查 tarball 内容'
  Push-Location $stage
  try {
    $packJson = (& npm pack --dry-run --json 2>$null) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'npm pack --dry-run 失败' }
    $pack = $packJson | ConvertFrom-Json
    $files = @($pack[0].files | ForEach-Object { $_.path })
    $required = @(
      'package.json', 'lib/index.js', 'lib/client.js', 'cordis.patch.yml',
      'bin/focus-window.exe', 'skills/dsh-desktop-notify/SKILL.md'
    )
    foreach ($need in $required) {
      if ($files -notcontains $need) { throw "tarball 里缺少 $need（files 声明了但没打进去）" }
    }
    Write-Output ("    ok：" + $files.Count + " 个文件，关键项齐全")
  } finally {
    Pop-Location
  }

  # 10) 发布
  Write-Step ($(if ($DryRun) { 'DryRun 预览' } else { '发布' }))
  $publishArgs = @('publish', '--access', 'public')
  if ($DryRun) { $publishArgs += '--dry-run' }
  if ($Otp -ne '') { $publishArgs += @('--otp', $Otp) }
  Push-Location $stage
  try {
    & npm @publishArgs
    $publishExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($publishExit -ne 0) { throw "npm publish 退出码 $publishExit" }

  if (-not $DryRun) {
    Write-Output ''
    Write-Output ("已发布：https://www.npmjs.com/package/" + $Name)
    Write-Output ("验收：npm view " + $Name + " dsh.client，并在干净机器上装一次")
    Write-Output '可选：https://dsh-plugin.org/zh/submit 填一次仓库地址（仓库已有 dsh-plugin topic）'
  }
} finally {
  # 11) 清理暂存目录（成功失败都清，别在 %TEMP% 留一份源码副本）
  if (Test-Path $stage) {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
