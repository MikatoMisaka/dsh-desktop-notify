# 读出开始菜单快捷方式登记的 AppUserModelID —— 也就是 Windows 通知的署名。
#
# Windows 的通知绑定到这个 ID：字符串写错时 CreateToastNotifier 不报错，
# 只是把 toast 静默丢弃（"路由 200、桌面一片安静"）。所以换品牌/换构筑后先跑它核对。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\read-aumid.ps1
#   powershell ... -File scripts\read-aumid.ps1 -Shortcut "C:\path\to\Your App.lnk"

param(
  # 默认就是 DSH 自己的快捷方式；换品牌时显式传别的。
  [string]$Shortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Shortcut)) {
  Write-Output "找不到快捷方式：$Shortcut"
  Write-Output ''
  Write-Output '开始菜单里现有的候选（挑一个用 -Shortcut 传进去）：'
  Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter *.lnk -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Output ("  " + $_.FullName) }
  Write-Output ''
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
Write-Output '填进 profile 的 cordis.patch.yml 里那条 insert 下的 config.aumid：'
Write-Output ''
Write-Output '- insert:'
Write-Output '    - id: desktop-notify'
Write-Output '      name: dsh-desktop-notify'
Write-Output '      config:'
Write-Output "        aumid: $id"
Write-Output ''
Write-Output '（profile 里还没有这条 insert 的话，整段贴到 cordis.patch.yml 末尾即可；'
Write-Output '  已有时候只改 aumid 那一行，别再加一条同 id 的顶层条目。）'
