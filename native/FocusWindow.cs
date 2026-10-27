// FocusWindow.exe - bring the running DSH window to the foreground.
//
// Launched by clicking the notification (via the dsh-notify: protocol), so this
// process gets the user's foreground right and SetForegroundWindow sticks.
//
// Precompiled on purpose: the PowerShell variant pays for a full powershell.exe
// start plus an Add-Type compile (measured ~1.3s end to end), which the user feels
// as "clicking takes a while". The exe is 35-100ms.
//
// Windows are found with EnumWindows by PID, NOT Process.MainWindowHandle: DSH
// hides its window to the tray on close, and .NET reports a hidden window's
// MainWindowHandle as 0 - which would send the most common case ("I closed the
// window, the task finished later") down the slow dsh://open path.
//
// Args: the protocol passes the URI, e.g. dsh-notify://focus?t=<token>. The token
// identifies which notification was clicked; it is recorded for the Host so the
// renderer can jump to that exact session.
//
// Exit: 0 focused, 2 focused attempt failed, 3 handed off to dsh://open,
//       1 no window after launching (kept for compatibility).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class FocusWindow
{
    private const int SW_SHOW = 5;
    private const int SW_RESTORE = 9;

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;

    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const uint GW_OWNER = 4;

    private const string ProcessName = "DeepSeek Harness";

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static int Main(string[] args)
    {
        try
        {
            var uri = args.Length > 0 ? args[0] : string.Empty;
            var token = ExtractToken(uri);
            if (token != null) WriteClick(token);

            var target = FindMainWindow();
            if (target == IntPtr.Zero)
            {
                // Nothing to focus: hand the launch to DSH and stop waiting. The
                // window appears seconds later on its own; blocking here would just
                // invent a misleading "no window" exit code.
                TryLaunchDsh();
                return 3;
            }

            if (!IsWindowVisible(target) || IsIconic(target))
            {
                ShowWindow(target, SW_SHOW);
                ShowWindow(target, SW_RESTORE);
                Thread.Sleep(80);
            }

            for (var attempt = 1; attempt <= 12; attempt++)
            {
                // A synthetic ALT makes the shell treat us as "just received input",
                // which is what actually grants the foreground right. Only the first
                // round does it: repeating 12 times would type ALT into whatever
                // fullscreen app currently holds the foreground.
                Attempt(target, attempt == 1);
                if (GetForegroundWindow() == target) return 0;
                Thread.Sleep(25);
            }

            return 2;
        }
        catch
        {
            // Never exit with a CLR crash code: the Host treats 0/2/3 as a contract.
            return 2;
        }
    }

    /// <summary>Pull the notification token out of dsh-notify://focus?t=...</summary>
    private static string ExtractToken(string uri)
    {
        if (string.IsNullOrEmpty(uri)) return null;
        var index = uri.IndexOf("t=", StringComparison.Ordinal);
        if (index < 0) return null;
        var value = uri.Substring(index + 2);
        var end = value.IndexOf('&');
        if (end >= 0) value = value.Substring(0, end);
        value = value.Trim();
        if (value.Length == 0 || value.Length > 64) return null;
        foreach (var c in value)
        {
            var ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            if (!ok) return null;
        }
        return value;
    }

    /// <summary>
    /// Record the clicked notification so the Host can map it to a session.
    /// Best effort: a failed write only loses the "jump to session" half.
    /// </summary>
    private static void WriteClick(string token)
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "dsh-desktop-notify"
        );
        Directory.CreateDirectory(dir);
        var json = "{\"t\":\"" + token + "\",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "}";
        File.WriteAllText(Path.Combine(dir, "click.json"), json, new UTF8Encoding(false));
    }

    private static void TryLaunchDsh()
    {
        try
        {
            Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
        }
        catch
        {
            // Nothing else we can do; the caller only cares about the exit code.
        }
    }

    /// <summary>
    /// Largest window owned by the process. Visible ones win; hidden ones are the
    /// tray case and still valid. Tool windows and owned popups are skipped.
    /// </summary>
    private static IntPtr FindMainWindow()
    {
        var pids = new HashSet<uint>();
        foreach (var process in Process.GetProcessesByName(ProcessName))
        {
            try
            {
                pids.Add((uint)process.Id);
            }
            catch
            {
                // A process that died between enumeration and the id read.
            }
            finally
            {
                process.Dispose();
            }
        }
        if (pids.Count == 0) return IntPtr.Zero;

        var bestVisible = IntPtr.Zero;
        var bestVisibleArea = -1L;
        var bestHidden = IntPtr.Zero;
        var bestHiddenArea = -1L;

        EnumWindows(
            (hwnd, _) =>
            {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (!pids.Contains(pid)) return true;
                if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
                var exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
                if ((exStyle & WS_EX_TOOLWINDOW) != 0) return true;

                RECT rect;
                if (!GetWindowRect(hwnd, out rect)) return true;
                var area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
                if (area <= 0) return true;

                if (IsWindowVisible(hwnd))
                {
                    if (area > bestVisibleArea)
                    {
                        bestVisibleArea = area;
                        bestVisible = hwnd;
                    }
                }
                else if (area > bestHiddenArea)
                {
                    bestHiddenArea = area;
                    bestHidden = hwnd;
                }
                return true;
            },
            IntPtr.Zero
        );

        return bestVisible != IntPtr.Zero ? bestVisible : bestHidden;
    }

    private static void Attempt(IntPtr target, bool nudgeInput)
    {
        if (nudgeInput)
        {
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        }

        var foreground = GetForegroundWindow();
        uint foregroundPid;
        var foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        var currentThread = GetCurrentThreadId();
        var attached = false;
        if (foregroundThread != 0 && foregroundThread != currentThread)
        {
            attached = AttachThreadInput(foregroundThread, currentThread, true);
        }
        try
        {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        }
        finally
        {
            if (attached) AttachThreadInput(foregroundThread, currentThread, false);
        }

        if (GetForegroundWindow() == target) return;

        SwitchToThisWindow(target, true);
        SetWindowPos(target, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE); // HWND_TOPMOST
        // Always try to undo it: a window stuck permanently on top is worse than
        // not being raised at all. One retry covers the hung-window case.
        if (!SetWindowPos(target, new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE))
        {
            Thread.Sleep(20);
            SetWindowPos(target, new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
        }
    }
}
