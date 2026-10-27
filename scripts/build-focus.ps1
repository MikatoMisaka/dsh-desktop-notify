# 编译 native\FocusWindow.cs -> bin\focus-window.exe（GUI 子系统，不闪控制台）。
#
# 为什么要预编译：PowerShell 版每次启动都要 Add-Type 现场编译 P/Invoke，300-700ms，
# 用户点通知会觉得"卡一下"。编成 exe 后启动开销只剩进程创建本身。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-focus.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'native\FocusWindow.cs'
$binDir = Join-Path $root 'bin'
$output = Join-Path $binDir 'focus-window.exe'

if (-not (Test-Path $source)) {
  throw "找不到源码：$source"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
if (Test-Path $output) { Remove-Item $output -Force }

Add-Type -Path $source -OutputAssembly $output -OutputType WindowsApplication -ReferencedAssemblies 'System.dll'

if (-not (Test-Path $output)) {
  throw "编译失败，没有产出 $output"
}

$size = [math]::Round((Get-Item $output).Length / 1KB, 1)
Write-Output "已生成 $output ($size KB)"
