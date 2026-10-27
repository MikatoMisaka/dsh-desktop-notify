# 把 DSH 主窗口拉到前台（restore + activate + 置顶），供"点通知"链路使用。
#
# 为什么需要它：点通知走协议激活 —— Windows 启动一个新进程，单实例锁让那个进程立刻
# 退出，真正 show/focus 窗口的是**已经存在的旧进程**。旧进程没有前台权限
# （foreground right），所以窗口能恢复可见，却压在别的窗口后面。
#
# Windows 只在特定条件下放行 SetForegroundWindow。这里几条一起上，并且重试：
#   1. keybd_event 打一次 ALT 的按下/抬起 —— 让本进程"刚刚收到过输入"，拿到前台资格；
#   2. Interaction.AppActivate（内部走 AttachThreadInput）；
#   3. 自己 AttachThreadInput 到当前前台线程，再 BringWindowToTop + SetForegroundWindow；
#   4. SwitchToThisWindow + SetWindowPos 的 topmost 抖动，强制改变 z 序。
# 每轮用 GetForegroundWindow 核对，最多 5 轮；结果写进 focus.log 便于复盘。
#
# 没有窗口时退回 `dsh://open` 把应用启起来（那条路径是 DSH 自己的启动逻辑）。
# 注意：只用 Windows PowerShell 5.1 也支持的语法；文件必须存成 UTF-8 with BOM。

param(
  [string]$ProcessName = 'DeepSeek Harness',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction SilentlyContinue

Add-Type -Namespace DshNotify -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
'@

$logDir = Join-Path $env:LOCALAPPDATA 'dsh-desktop-notify'
$logFile = Join-Path $logDir 'focus.log'

function Write-FocusLog([hashtable]$Entry) {
  try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    # 和 host.log 一样轮转，免得常年累积。
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1000000)) {
      Move-Item -Path $logFile -Destination "$logFile.1" -Force
    }
    $Entry['t'] = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -Path $logFile -Value ($Entry | ConvertTo-Json -Compress) -Encoding UTF8
  } catch {
    # 日志失败不能影响置顶。
  }
}

# 退路局限：Process.MainWindowHandle 对"收进托盘"的隐藏窗口返回 0，
# 这条分支只能处理可见窗口。真正的隐藏窗口要靠 bin\focus-window.exe（EnumWindows）。
function Get-MainWindow {
  $candidates = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($candidates.Count -eq 0) { return $null }
  $visible = $candidates | Where-Object { [DshNotify.Win32]::IsWindowVisible($_.MainWindowHandle) } | Select-Object -First 1
  if ($null -ne $visible) { return $visible }
  return $candidates[0]
}

function Invoke-ForegroundAttempt([IntPtr]$hwnd, [int]$ownerPid, [bool]$nudgeInput) {
  # 只在第一轮制造"本进程刚收到输入"的假象：每轮都打 ALT 会把按键注入到
  # 当前占用前台的全屏程序里（菜单被唤起、游戏快捷键误触）。
  if ($nudgeInput) {
    [DshNotify.Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)    # ALT down
    [DshNotify.Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)    # ALT up
  }

  # 2) AppActivate：失败不算错，后面还有兜底。
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($ownerPid) | Out-Null } catch {}

  # 3) AttachThreadInput 到当前前台线程后强推。
  $foreground = [DshNotify.Win32]::GetForegroundWindow()
  $foregroundPid = [uint32]0
  $foregroundThread = [DshNotify.Win32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  $currentThread = [DshNotify.Win32]::GetCurrentThreadId()
  $attached = $false
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
    $attached = [DshNotify.Win32]::AttachThreadInput($foregroundThread, $currentThread, $true)
  }
  try {
    [DshNotify.Win32]::BringWindowToTop($hwnd) | Out-Null
    [DshNotify.Win32]::SetForegroundWindow($hwnd) | Out-Null
  } finally {
    if ($attached) {
      [DshNotify.Win32]::AttachThreadInput($foregroundThread, $currentThread, $false) | Out-Null
    }
  }

  # 4) 老 API + topmost 抖动：上一步被拒时这一招通常还能改 z 序。
  if ([DshNotify.Win32]::GetForegroundWindow() -ne $hwnd) {
    [DshNotify.Win32]::SwitchToThisWindow($hwnd, $true)
    $SWP_NOSIZE = 0x0001
    $SWP_NOMOVE = 0x0002
    [DshNotify.Win32]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE)) | Out-Null  # HWND_TOPMOST
    [DshNotify.Win32]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE)) | Out-Null  # HWND_NOTOPMOST
  }
}

$process = Get-MainWindow

if ($null -eq $process) {
  Start-Process 'dsh://open'
  Start-Sleep -Milliseconds 900
  $process = Get-MainWindow
}

if ($null -eq $process) {
  Write-FocusLog @{ event = 'focus'; ok = $false; reason = 'no-window' }
  if (-not $Quiet) { '{"ok":false,"reason":"no-window"}' }
  exit 1
}

$ownerPid = $process.Id
$hwnd = $process.MainWindowHandle
$minimized = [DshNotify.Win32]::IsIconic($hwnd)
$visible = [DshNotify.Win32]::IsWindowVisible($hwnd)
$before = [DshNotify.Win32]::GetForegroundWindow()

if ($minimized -or -not $visible) {
  [DshNotify.Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 150
}

$ok = $false
$tried = 0
for ($attempt = 1; $attempt -le 5; $attempt++) {
  $tried = $attempt
  Invoke-ForegroundAttempt $hwnd $ownerPid ($attempt -eq 1)
  Start-Sleep -Milliseconds 120
  if ([DshNotify.Win32]::GetForegroundWindow() -eq $hwnd) {
    $ok = $true
    break
  }
  Start-Sleep -Milliseconds 200
}

$after = [DshNotify.Win32]::GetForegroundWindow()
Write-FocusLog @{
  event = 'focus'
  ok = $ok
  rounds = $tried
  target = $hwnd.ToInt64()
  minimized = $minimized
  before = $before.ToInt64()
  after = $after.ToInt64()
}

if (-not $Quiet) {
  [pscustomobject]@{
    ok        = $ok
    rounds    = $tried
    target    = $hwnd.ToInt64()
    minimized = $minimized
    before    = $before.ToInt64()
    after     = $after.ToInt64()
  } | ConvertTo-Json -Compress
}

if ($ok) { exit 0 } else { exit 2 }
