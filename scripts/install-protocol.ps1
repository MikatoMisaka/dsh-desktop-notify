# 把 dsh-notify: 协议登记到当前用户（HKCU），让通知的点击动作走我们自己的
# focus-window.exe，而不是再启动一个完整的 Electron 进程。
#
# 为什么值得：`dsh://open` 的落地是启动一个新的 DSH 进程，它要跑完 Electron 启动
# 才走到单实例检查然后退出——用户感受到的"点通知后要等一会儿"主要就是这段。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-protocol.ps1
#      加 -Uninstall 删除登记。

param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'bin\focus-window.exe'
$key = 'HKCU:\Software\Classes\dsh-notify'

if ($Uninstall) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force }
  Write-Output '已删除 dsh-notify: 协议登记'
  exit 0
}

if (-not (Test-Path $exe)) {
  throw "找不到 $exe，先跑 scripts\build-focus.ps1"
}

New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name '(default)' -Value 'URL:dsh-notify' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path (Join-Path $key 'shell\open\command') -Force | Out-Null
New-ItemProperty -Path (Join-Path $key 'shell\open\command') -Name '(default)' -Value ('"' + $exe + '" "%1"') -PropertyType String -Force | Out-Null

$command = (Get-ItemProperty -Path (Join-Path $key 'shell\open\command')).'(default)'
Write-Output "已登记 dsh-notify: -> $command"
