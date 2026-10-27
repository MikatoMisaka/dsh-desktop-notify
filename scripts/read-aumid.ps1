# 读出开始菜单快捷方式登记的 AppUserModelID —— 也就是 Windows 通知的署名。
#
# Windows 的通知绑定到这个 ID：字符串写错时 CreateToastNotifier 不报错，
# 只是把 toast 静默丢弃。所以换品牌/换构筑后先跑这个脚本核对。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\read-aumid.ps1
#   powershell ... -File scripts\read-aumid.ps1 -Shortcut "C:\path\to\Your App.lnk"

param(
  [string]$Shortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\WorkBuddy.lnk"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Shortcut)) {
  Write-Output "找不到快捷方式：$Shortcut"
  Write-Output '提示：开始菜单里的 .lnk 才是登记点；直接看 exe 的属性通常为空。'
  exit 1
}

$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace((Split-Path $Shortcut))
$item = $folder.ParseName((Split-Path $Shortcut -Leaf))

$id = $item.ExtendedProperty('System.AppUserModel.ID')
Write-Output "快捷方式：$Shortcut"
Write-Output "AppUserModelID：[$id]"

if ([string]::IsNullOrWhiteSpace($id)) {
  Write-Output '这个快捷方式没有登记 AUMID —— 通知会因为找不到署名而被丢弃。'
  exit 1
}

Write-Output ''
Write-Output '把它填进 profile 的 cordis.patch.yml：'
Write-Output ''
Write-Output '- id: desktop-notify'
Write-Output '  name: dsh-desktop-notify'
Write-Output '  config:'
Write-Output "    aumid: $id"
