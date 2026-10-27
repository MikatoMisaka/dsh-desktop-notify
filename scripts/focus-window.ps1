# 把 DSH 主窗口拉到前台（restore + activate + 置顶），供"点通知"链路使用。
#
# 为什么需要它：点通知走的是协议激活 —— Windows 会启动一个新进程，单实例锁让那个进程
# 立刻退出，真正 show/focus 窗口的是**已经存在的旧进程**。旧进程没有前台权限
# （foreground right），所以窗口会被 restore 出来，却压在别的窗口下面。
#
# 这里用两步绕过前台锁：
#   1. Microsoft.VisualBasic 的 AppActivate（内部走 AttachThreadInput）；
#   2. 不行就自己 AttachThreadInput 到当前前台线程再 SetForegroundWindow。
#
# 输出一行 JSON（便于自检脚本判断成败）；没有窗口时退回 `dsh://open` 拉起应用。
# 注意：只用 Windows PowerShell 5.1 也支持的语法（枚举窗口靠 Process.MainWindowHandle，
# 不用 EnumWindows 的委托转换）。

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
'@

function Get-MainWindow {
  $candidates = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($candidates.Count -eq 0) { return $null }
  # 优先拿可见的那个（DSH 有多进程，只有主进程带主窗口）。
  $visible = $candidates | Where-Object { [DshNotify.Win32]::IsWindowVisible($_.MainWindowHandle) } | Select-Object -First 1
  if ($null -ne $visible) { return $visible }
  return $candidates[0]
}

$process = Get-MainWindow

if ($null -eq $process) {
  # 应用没在跑，或者窗口还没建出来：交给 DSH 自己的 dsh://open 启动逻辑。
  Start-Process 'dsh://open'
  Start-Sleep -Milliseconds 900
  $process = Get-MainWindow
}

if ($null -eq $process) {
  if (-not $Quiet) { '{"ok":false,"reason":"no-window"}' }
  exit 1
}

$hwnd = $process.MainWindowHandle
$minimized = [DshNotify.Win32]::IsIconic($hwnd)
$visible = [DshNotify.Win32]::IsWindowVisible($hwnd)
$foregroundBefore = [DshNotify.Win32]::GetForegroundWindow()

# 1) 先恢复：最小化状态下 SetForegroundWindow 是无效的。
if ($minimized -or -not $visible) {
  [DshNotify.Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 120
}

# 2) 首选 AppActivate：它自带 AttachThreadInput。
$activated = $false
try {
  [Microsoft.VisualBasic.Interaction]::AppActivate($process.Id) | Out-Null
  $activated = $true
} catch {
  $activated = $false
}

# 3) 兜底 / 补强：AttachThreadInput 到前台线程后 SetForegroundWindow。
if (-not $activated -or [DshNotify.Win32]::GetForegroundWindow() -ne $hwnd) {
  $foregroundPid = [uint32]0
  $foregroundThread = [DshNotify.Win32]::GetWindowThreadProcessId($foregroundBefore, [ref]$foregroundPid)
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
}

Start-Sleep -Milliseconds 150
$foregroundAfter = [DshNotify.Win32]::GetForegroundWindow()
$ok = $foregroundAfter -eq $hwnd

if (-not $Quiet) {
  [pscustomobject]@{
    ok               = $ok
    target           = $hwnd.ToInt64()
    minimized        = $minimized
    foregroundBefore = $foregroundBefore.ToInt64()
    foregroundAfter  = $foregroundAfter.ToInt64()
  } | ConvertTo-Json -Compress
}

if ($ok) { exit 0 } else { exit 2 }
