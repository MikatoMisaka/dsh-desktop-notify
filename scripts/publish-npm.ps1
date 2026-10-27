# 把插件发布到 npm —— 在 %TEMP% 里用一份暂存副本发布，不动工作区、不动本地已装的那份。
#
# 为什么不能直接 npm publish：包名 dsh-desktop-notify 已被占用，必须改名；而改名会让
# 本地 profile 的目录联接与 cordis.patch.yml 的 name 对不上（重启后插件消失）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-npm.ps1 -Name dsh-notify-focus
#   加 -DryRun 只打预览，不真正发布。

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Version = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:TEMP 'dsh-notify-publish'

# 1) 必须先登录
$who = (& npm whoami --silent 2>$null) -join ' '
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($who)) {
  throw '还没登录 npm：先跑 npm login（或 npm config set //registry.npmjs.org/:_authToken=<token>），再重试。'
}
Write-Output "npm 用户：$who"

# 2) 需要 exe：发布包里带上它，用户装完就是快路径
$exe = Join-Path $root 'bin\focus-window.exe'
if (-not (Test-Path $exe)) {
  Write-Output 'bin\focus-window.exe 不存在，先编译…'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\build-focus.ps1')
  if (-not (Test-Path $exe)) { throw '编译失败，无法发布' }
}

# 3) 暂存副本
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($item in 'lib', 'scripts', 'native', 'bin', 'cordis.patch.yml', 'README.md', 'LICENSE', 'selftest.mjs', 'client-selftest.mjs') {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "缺少 $item，无法打包" }
  Copy-Item $src (Join-Path $stage $item) -Recurse -Force
}

# 4) 只改副本的清单
$pkgPath = Join-Path $stage 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.name = $Name
if ($Version -ne '') { $pkg.version = $Version }
$pkg | Add-Member -NotePropertyName private -NotePropertyValue $false -Force
$pkg | Add-Member -NotePropertyName repository -NotePropertyValue @{ type = 'git'; url = 'git+https://github.com/MikatoMisaka/dsh-desktop-notify.git' } -Force
$pkg | Add-Member -NotePropertyName homepage -NotePropertyValue 'https://github.com/MikatoMisaka/dsh-desktop-notify#readme' -Force
$pkg | Add-Member -NotePropertyName bugs -NotePropertyValue @{ url = 'https://github.com/MikatoMisaka/dsh-desktop-notify/issues' } -Force
$pkg | Add-Member -NotePropertyName engines -NotePropertyValue @{ node = '>=18' } -Force
$pkg | Add-Member -NotePropertyName publishConfig -NotePropertyValue @{ access = 'public' } -Force
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding utf8NoBOM

Write-Output "暂存目录：$stage"
Write-Output ("发布名：{0}@{1}" -f $pkg.name, $pkg.version)

# 5) 先跑安静那套自检
Push-Location $stage
try {
  & node 'client-selftest.mjs' | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) { throw '自检失败，已中止发布' }

  if ($DryRun) {
    Write-Output '--- DryRun：只打预览 ---'
    npm publish --access public --dry-run
  } else {
    Write-Output '--- 发布 ---'
    npm publish --access public
    if ($LASTEXITCODE -ne 0) { throw 'npm publish 失败' }
    Write-Output ''
    Write-Output "已发布：https://www.npmjs.com/package/$($pkg.name)"
    Write-Output '下一步（可选）：https://dsh-plugin.org/zh/submit 填一次仓库地址'
  }
} finally {
  Pop-Location
}
