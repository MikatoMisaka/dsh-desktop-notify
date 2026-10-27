// FocusWindow.exe - bring the running DSH window to the foreground.
//
// Launched by clicking the notification (via the dsh-notify: protocol), so this
// process gets the user's foreground right and SetForegroundWindow sticks.
// Kept as a precompiled exe on purpose: the PowerShell variant spends 300-700ms
// in Add-Type compiling the same P/Invoke declarations, which the user feels as
// "clicking takes a while".
//
// Args: optional process name (default "DeepSeek Harness"); the protocol passes
// the URI, which is ignored when it looks like dsh-notify:...
// Exit: 0 focused, 1 no window (and launched dsh://open), 2 focused attempt failed.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

internal static class FocusWindow
{
    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

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

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;

    private static int Main(string[] args)
    {
        var processName = "DeepSeek Harness";
        if (args.Length > 0 && !string.IsNullOrEmpty(args[0]) && !args[0].StartsWith("dsh-notify:", StringComparison.OrdinalIgnoreCase))
        {
            processName = args[0];
        }

        var target = FindMainWindow(processName);
        if (target == IntPtr.Zero)
        {
            // App not running (or no window yet): let DSH's own protocol start it.
            try
            {
                Process.Start(new ProcessStartInfo("dsh://open") { UseShellExecute = true });
            }
            catch
            {
                return 1;
            }
            Thread.Sleep(900);
            target = FindMainWindow(processName);
            if (target == IntPtr.Zero) return 1;
        }

        if (IsIconic(target) || !IsWindowVisible(target))
        {
            ShowWindow(target, SW_RESTORE);
            Thread.Sleep(60);
        }

        for (var attempt = 0; attempt < 12; attempt++)
        {
            Attempt(target);
            if (GetForegroundWindow() == target) return 0;
            Thread.Sleep(25);
        }

        return 2;
    }

    private static IntPtr FindMainWindow(string processName)
    {
        var fallback = IntPtr.Zero;
        foreach (var process in Process.GetProcessesByName(processName))
        {
            try
            {
                var handle = process.MainWindowHandle;
                if (handle == IntPtr.Zero) continue;
                if (IsWindowVisible(handle)) return handle;
                if (fallback == IntPtr.Zero) fallback = handle;
            }
            catch
            {
                // A process that died between enumeration and the handle read.
            }
            finally
            {
                process.Dispose();
            }
        }
        return fallback;
    }

    private static void Attempt(IntPtr target)
    {
        // Claim the foreground right by looking like "we just received input".
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);

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
        SetWindowPos(target, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
        SetWindowPos(target, new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
    }
}
