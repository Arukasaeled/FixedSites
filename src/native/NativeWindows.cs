using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class Win32
{
    internal const int GWL_STYLE = -16, GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
    internal const uint WS_CHILD = 0x40000000, WS_POPUP = 0x80000000;
    internal const uint WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000;
    internal const uint WS_SYSMENU = 0x00080000, WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
    internal const uint WS_MINIMIZE = 0x20000000, WS_MAXIMIZE = 0x01000000, WS_CLIPSIBLINGS = 0x04000000, WS_CLIPCHILDREN = 0x02000000;
    internal const uint WS_VISIBLE = 0x10000000;
    internal const uint WS_DISABLED = 0x08000000;
    internal const uint WS_EX_APPWINDOW = 0x00040000, WS_EX_TOPMOST = 0x00000008;
    internal const uint WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
    internal const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020, SWP_ASYNCWINDOWPOS = 0x4000;
    internal const uint SWP_SHOWWINDOW = 0x0040;
    internal const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;
    internal const uint GW_OWNER = 4;
    internal static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct WINDOWPLACEMENT
    {
        public int Length; public int Flags; public int ShowCmd;
        public POINT MinPosition, MaxPosition; public RECT NormalPosition;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct GUITHREADINFO
    {
        public int Size; public uint Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public RECT CaretRect;
    }
    internal delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetLastActivePopup(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] internal static extern bool RedrawWindow(IntPtr hwnd, IntPtr rect, IntPtr region, uint flags);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] internal static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetParent(IntPtr hwnd, IntPtr parent);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] internal static extern int MapWindowPoints(IntPtr from, IntPtr to, ref RECT rect, uint points);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] internal static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] internal static extern void SetLastError(uint error);
    [DllImport("user32.dll")] internal static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll")] internal static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr SetActiveWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool GetKeyboardState([Out] byte[] state);
    [DllImport("user32.dll")] internal static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    internal static uint Style(IntPtr hwnd, int index)
    {
        return unchecked((uint)GetWindowLongPtr(hwnd, index).ToInt64());
    }
    internal static void SetStyle(IntPtr hwnd, int index, uint style)
    {
        SetLastError(0);
        IntPtr previous = SetWindowLongPtr(hwnd, index, new IntPtr(unchecked((long)style)));
        int error = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && error != 0) throw new Win32Exception(error);
    }
    internal static void Parent(IntPtr hwnd, IntPtr parent)
    {
        SetLastError(0);
        IntPtr previous = SetParent(hwnd, parent);
        int error = Marshal.GetLastWin32Error();
        if (previous == IntPtr.Zero && error != 0) throw new Win32Exception(error);
        // With WS_CHILD still set, SetParent(NULL) can make GetParent return
        // the desktop HWND until the original top-level style is restored.
        if (parent != IntPtr.Zero && GetParent(hwnd) != parent) throw new InvalidOperationException("SetParent returned without the requested parent.");
    }
    internal static string Hex(IntPtr hwnd) { return "0x" + hwnd.ToInt64().ToString("X"); }
}

internal sealed class AgentWindow
{
    internal string Name;
    internal string Title, StartTicks, ProcessName, ExecutablePath, ProductName;
    internal int Pid;
    internal IntPtr Hwnd, OriginalParent, OriginalOwner, OriginalDpiContext, LastFocus, Container;
    internal uint OriginalStyle, OriginalExStyle;
    internal bool OriginalVisible, Mounted, Touched, NativeReady;
    internal Win32.RECT OriginalRect;
    internal Win32.WINDOWPLACEMENT OriginalPlacement;
    // FS owns the child/frame and taskbar/z-order flags only. The application's
    // live visibility, modal disabled state and rendering flags remain its own.
    private const uint EmbeddedStyleMask = Win32.WS_CHILD | Win32.WS_POPUP | Win32.WS_CAPTION | Win32.WS_THICKFRAME |
        Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX | Win32.WS_MAXIMIZEBOX | Win32.WS_MINIMIZE | Win32.WS_MAXIMIZE |
        Win32.WS_CLIPSIBLINGS | Win32.WS_CLIPCHILDREN;
    private const uint EmbeddedExStyleMask = Win32.WS_EX_APPWINDOW | Win32.WS_EX_TOPMOST;

    internal static Dictionary<int, string> ProcessIds(string processName, string executableContains)
    {
        var pids = new Dictionary<int, string>();
        foreach (Process process in Process.GetProcessesByName(processName))
        {
            try
            {
                // A killed Electron app may leave a same-name child without a
                // readable executable module. It is not a usable desktop app.
                if (process.HasExited) continue;
                var module = process.MainModule;
                if (module == null) continue;
                if (String.IsNullOrEmpty(executableContains) || module.FileName.IndexOf(executableContains, StringComparison.OrdinalIgnoreCase) >= 0)
                    pids[process.Id] = process.StartTime.ToUniversalTime().Ticks.ToString();
            }
            catch (Win32Exception) { /* Exiting or inaccessible leftover process. */ }
            catch (InvalidOperationException) { /* Process exited during the snapshot. */ }
            finally { process.Dispose(); }
        }
        return pids;
    }

    internal static List<AgentWindow> Candidates(string name, string processName, string executableContains)
    {
        var pids = ProcessIds(processName, executableContains);
        var candidates = new List<AgentWindow>();
        Win32.EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
        {
            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            if (!pids.ContainsKey((int)pid) || Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;
            if ((Win32.Style(hwnd, Win32.GWL_STYLE) & Win32.WS_CHILD) != 0) return true;
            var className = new StringBuilder(128);
            Win32.GetClassName(hwnd, className, className.Capacity);
            if (className.ToString() != "Chrome_WidgetWin_1") return true;
            var title = new StringBuilder(512);
            Win32.GetWindowText(hwnd, title, title.Capacity);
            if (title.Length == 0) return true;
            try {
                var entry = Capture(name, hwnd, (int)pid);
                if (entry.StartTicks != pids[(int)pid] || !entry.StillOurWindow()) return true;
                entry.Title = title.ToString();
                candidates.Add(entry);
            } catch (ArgumentException) { } catch (InvalidOperationException) { } catch (Win32Exception) { }
            return true;
        }, IntPtr.Zero);
        candidates.Sort(delegate(AgentWindow a, AgentWindow b) {
            int usable = b.Eligible().CompareTo(a.Eligible());
            if (usable != 0) return usable;
            int minimized = Win32.IsIconic(a.Hwnd).CompareTo(Win32.IsIconic(b.Hwnd));
            return minimized != 0 ? minimized : b.NormalArea().CompareTo(a.NormalArea());
        });
        return candidates;
    }

    private long NormalArea()
    {
        var rect = OriginalPlacement.NormalPosition;
        return (long)Math.Max(0, rect.Right - rect.Left) * Math.Max(0, rect.Bottom - rect.Top);
    }

    private static AgentWindow Capture(string name, IntPtr best, int bestPid)
    {
        var entry = new AgentWindow();
        entry.Name = name; entry.Pid = bestPid; entry.Hwnd = best;
        var title = new StringBuilder(512);
        Win32.GetWindowText(best, title, title.Capacity); entry.Title = title.ToString();
        using (Process process = Process.GetProcessById(bestPid)) {
            entry.ProcessName = process.ProcessName;
            entry.StartTicks = process.StartTime.ToUniversalTime().Ticks.ToString();
            try { entry.ExecutablePath = process.MainModule.FileName; entry.ProductName = process.MainModule.FileVersionInfo.ProductName; } catch (Win32Exception) { }
        }
        entry.OriginalStyle = Win32.Style(best, Win32.GWL_STYLE);
        entry.OriginalExStyle = Win32.Style(best, Win32.GWL_EXSTYLE);
        entry.OriginalParent = (entry.OriginalStyle & Win32.WS_CHILD) != 0 ? Win32.GetParent(best) : IntPtr.Zero;
        entry.OriginalOwner = Win32.GetWindow(best, Win32.GW_OWNER);
        entry.OriginalDpiContext = Win32.GetWindowDpiAwarenessContext(best);
        entry.OriginalVisible = Win32.IsWindowVisible(best);
        IntPtr previousContext = Win32.SetThreadDpiAwarenessContext(entry.OriginalDpiContext);
        try
        {
            if (!Win32.GetWindowRect(best, out entry.OriginalRect)) throw new Win32Exception(Marshal.GetLastWin32Error());
            entry.OriginalPlacement.Length = Marshal.SizeOf(typeof(Win32.WINDOWPLACEMENT));
            if (!Win32.GetWindowPlacement(best, ref entry.OriginalPlacement)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Win32.SetThreadDpiAwarenessContext(previousContext); }
        entry.RememberFocus();
        return entry;
    }

    internal static AgentWindow Inspect(AgentPreset preset, WindowReference reference)
    {
        if (reference == null) return null;
        var pids = ProcessIds(preset.processName, preset.executableContains);
        string ticks;
        if (!pids.TryGetValue(reference.pid, out ticks) || ticks != reference.startTicks) return null;
        IntPtr hwnd = new IntPtr(Convert.ToInt64(reference.hwnd.Substring(2), 16));
        uint pid;
        if (!Win32.IsWindow(hwnd) || Win32.GetWindowThreadProcessId(hwnd, out pid) == 0 || pid != reference.pid) return null;
        AgentWindow entry;
        try { entry = Capture(preset.name, hwnd, reference.pid); }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (Win32Exception) { return null; }
        return reference.Matches(entry) && entry.StillOurWindow() ? entry : null;
    }

    internal bool Eligible()
    {
        int cloaked;
        Win32.DwmGetWindowAttribute(Hwnd, 14, out cloaked, sizeof(int));
        var className = new StringBuilder(128);
        Win32.GetClassName(Hwnd, className, className.Capacity);
        uint style = Win32.Style(Hwnd, Win32.GWL_STYLE), exStyle = Win32.Style(Hwnd, Win32.GWL_EXSTYLE);
        return StillOurWindow() && Win32.IsWindowVisible(Hwnd) && cloaked == 0 && Win32.IsWindowEnabled(Hwnd) &&
            className.ToString() == "Chrome_WidgetWin_1" && Win32.GetWindow(Hwnd, Win32.GW_OWNER) == IntPtr.Zero &&
            (style & Win32.WS_CHILD) == 0 && (exStyle & (Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE)) == 0 &&
            OriginalRect.Right > OriginalRect.Left && OriginalRect.Bottom > OriginalRect.Top;
    }

    internal object Metadata(AgentPreset preset, bool current)
    {
        int cloaked;
        Win32.DwmGetWindowAttribute(Hwnd, 14, out cloaked, sizeof(int));
        bool alive = StillOurWindow(), shown = alive && Win32.IsWindowVisible(Hwnd);
        bool minimized = alive && Win32.IsIconic(Hwnd);
        bool locked = false;
        if (preset.protectedWindows != null)
            foreach (WindowReference excluded in preset.protectedWindows) if (excluded.Matches(this)) locked = true;
        bool eligible = !locked && alive && (current || Eligible());
        string reason = locked ? "已保护的开发窗口，不能接管" : !alive ? "窗口已退出或重建" : current ? null :
            !shown ? "隐藏窗口，不作为可接入的桌面窗口" : cloaked != 0 ? "系统隐藏的窗口，可能位于其他桌面" :
            !Win32.IsWindowEnabled(Hwnd) ? "窗口被原应用对话框禁用，请先处理该对话框" :
            (Win32.Style(Hwnd, Win32.GWL_EXSTYLE) & (Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE)) != 0 ? "辅助窗口，不作为可接入的主窗口" :
            !eligible ? "窗口尺寸或类型不适合接入" : null;
        return new { hwnd = Win32.Hex(Hwnd), pid = Pid, startTicks = StartTicks, title = Title,
            processName = ProcessName, executablePath = ExecutablePath, productName = ProductName,
            width = OriginalRect.Right - OriginalRect.Left, height = OriginalRect.Bottom - OriginalRect.Top,
            visible = shown, minimized = minimized, cloaked = cloaked != 0, current = current,
            protectedWindow = locked, eligible = eligible, unavailableReason = reason };
    }

    internal bool MountedCorrectly()
    {
        return Mounted && StillOurWindow() && Win32.IsWindow(Container) && Win32.GetParent(Hwnd) == Container &&
            (Win32.Style(Hwnd, Win32.GWL_STYLE) & (Win32.WS_CHILD | Win32.WS_POPUP | Win32.WS_CAPTION | Win32.WS_THICKFRAME)) == Win32.WS_CHILD;
    }

    internal bool LayoutConfirmed(Size size)
    {
        return size.Width > 1 && size.Height > 1 && MountedCorrectly() && Win32.IsWindowVisible(Hwnd) && !Win32.IsIconic(Hwnd) && !NeedsLayout(size);
    }

    internal bool StillOurWindow()
    {
        uint pid;
        return Win32.IsWindow(Hwnd) && Win32.GetWindowThreadProcessId(Hwnd, out pid) != 0 && pid == (uint)Pid;
    }

    private void RequireResponse()
    {
        IntPtr result;
        if (Win32.SendMessageTimeout(Hwnd, 0, IntPtr.Zero, IntPtr.Zero, 0x22, 600, out result) == IntPtr.Zero)
            throw new InvalidOperationException(Name + " 暂未响应，窗口和进程保持原状。请待应用恢复后重试。");
    }

    private uint ChildStyle(uint style)
    {
        return (style & ~EmbeddedStyleMask) |
            Win32.WS_CHILD | Win32.WS_CLIPSIBLINGS | Win32.WS_CLIPCHILDREN;
    }

    internal void Mount(IntPtr container)
    {
        if (!Eligible()) throw new InvalidOperationException(Name + " 所选窗口已失效、隐藏或不再是可接入的主窗口，请刷新后重选。");
        RequireResponse();
        if (!Win32.AreDpiAwarenessContextsEqual(OriginalDpiContext, Win32.GetWindowDpiAwarenessContext(container)))
            throw new InvalidOperationException(Name + " DPI awareness differs from host; this PoC will not force a DPI reset.");
        IntPtr previousContext = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try
        {
        Touched = true;
        Win32.ShowWindow(Hwnd, Win32.SW_RESTORE);
        Win32.ShowWindow(Hwnd, Win32.SW_HIDE);
        Win32.SetStyle(Hwnd, Win32.GWL_STYLE, ChildStyle(Win32.Style(Hwnd, Win32.GWL_STYLE)));
        // Preserve actual layered/transparency/redirection flags. Replacing them
        // or setting layered opacity can disrupt the application's compositor.
        Win32.SetStyle(Hwnd, Win32.GWL_EXSTYLE, Win32.Style(Hwnd, Win32.GWL_EXSTYLE) & ~EmbeddedExStyleMask);
        Win32.Parent(Hwnd, container);
        Container = container;
        Mounted = true;
        NativeReady = false;
        // Refresh the non-client frame without creating a temporary 1x1 renderer
        // viewport. Select/ShowInside will apply the actual container bounds.
        if (!Win32.SetWindowPos(Hwnd, IntPtr.Zero, 0, 0, 0, 0,
            0x0003 | Win32.SWP_FRAMECHANGED | Win32.SWP_NOACTIVATE | Win32.SWP_NOZORDER))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Win32.SetThreadDpiAwarenessContext(previousContext); }
    }

    internal Size ContainerClientSize()
    {
        // Read and use the slot in the Agent's DPI coordinate space. The outer
        // Electron client rectangle is not interchangeable with this rectangle.
        IntPtr previous = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try {
            Win32.RECT rect;
            if (!Win32.GetClientRect(Container, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new Size(rect.Right - rect.Left, rect.Bottom - rect.Top);
        } finally { Win32.SetThreadDpiAwarenessContext(previous); }
    }

    internal bool OwnVisible()
    {
        return StillOurWindow() && (Win32.Style(Hwnd, Win32.GWL_STYLE) & Win32.WS_VISIBLE) != 0;
    }

    internal void ShowInside(Size size)
    {
        if (!MountedCorrectly() || size.Width <= 1 || size.Height <= 1)
            throw new InvalidOperationException(Name + " 的原生容器或内容区域不可用，未完成接入。");
        RequireResponse();
        IntPtr previous = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try {
            // Initial bounds, child z-order and visibility commit together on
            // the target UI thread, as in the working WinForms PoC.
            if (!Win32.SetWindowPos(Hwnd, IntPtr.Zero, 0, 0, size.Width, size.Height,
                Win32.SWP_FRAMECHANGED | Win32.SWP_NOACTIVATE | Win32.SWP_SHOWWINDOW))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            // One paint request, without synchronous WM_PAINT or a show/focus loop.
            Win32.RedrawWindow(Hwnd, IntPtr.Zero, IntPtr.Zero, 0x0001 | 0x0080 | 0x0400);
        } finally { Win32.SetThreadDpiAwarenessContext(previous); }
    }

    internal void Resize(Size size, bool synchronous = false)
    {
        if (!Mounted || !StillOurWindow() || !Win32.IsWindow(Container) || Win32.GetParent(Hwnd) != Container)
            throw new InvalidOperationException(Name + " 的窗口或宿主关系已变化，请断开还原后重新选择。");
        IntPtr previousContext = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try
        {
            if (!Win32.SetWindowPos(Hwnd, IntPtr.Zero, 0, 0, Math.Max(1, size.Width), Math.Max(1, size.Height),
                Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE | (synchronous ? 0 : Win32.SWP_ASYNCWINDOWPOS))) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Win32.SetThreadDpiAwarenessContext(previousContext); }
    }

    internal bool NeedsLayout(Size size)
    {
        if (!Mounted || !StillOurWindow()) return false;
        if (Win32.GetParent(Hwnd) != Container || (Win32.Style(Hwnd, Win32.GWL_STYLE) & (Win32.WS_CHILD | Win32.WS_POPUP | Win32.WS_CAPTION | Win32.WS_THICKFRAME | Win32.WS_MINIMIZE | Win32.WS_MAXIMIZE)) != Win32.WS_CHILD) return true;
        IntPtr previous = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try {
            Win32.RECT rect;
            if (!Win32.GetWindowRect(Hwnd, out rect)) return true;
            Win32.MapWindowPoints(IntPtr.Zero, Container, ref rect, 2);
            // Chromium can retain a few pixels of invisible frame padding.
            int margin = Math.Max(2, (int)(Win32.GetDpiForWindow(Hwnd) / 48));
            return Math.Abs(rect.Left) > margin || Math.Abs(rect.Top) > margin ||
                Math.Abs(rect.Right - rect.Left - size.Width) > margin || Math.Abs(rect.Bottom - rect.Top - size.Height) > margin;
        } finally { Win32.SetThreadDpiAwarenessContext(previous); }
    }

    internal void Constrain(Size size, bool synchronous = false)
    {
        if (!Mounted || !StillOurWindow() || !Win32.IsWindow(Container) || Win32.GetParent(Hwnd) != Container)
            throw new InvalidOperationException(Name + " 的窗口或宿主关系已变化，请断开还原后重新选择。");
        uint style = Win32.Style(Hwnd, Win32.GWL_STYLE);
        if ((style & (Win32.WS_CHILD | Win32.WS_POPUP | Win32.WS_CAPTION | Win32.WS_THICKFRAME | Win32.WS_MINIMIZE | Win32.WS_MAXIMIZE)) != Win32.WS_CHILD) {
            RequireResponse();
            Win32.SetStyle(Hwnd, Win32.GWL_STYLE, ChildStyle(style));
            if (!Win32.SetWindowPos(Hwnd, IntPtr.Zero, 0, 0, size.Width, size.Height, Win32.SWP_FRAMECHANGED | Win32.SWP_NOZORDER | Win32.SWP_NOACTIVATE |
                (synchronous ? 0 : Win32.SWP_ASYNCWINDOWPOS))) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        Resize(size, synchronous);
    }

    internal void Activate(bool value, bool wake = false)
    {
        if (StillOurWindow()) {
            if (value && wake && Win32.IsWindowVisible(Hwnd)) Win32.PostMessage(Hwnd, 0x0018, new IntPtr(1), IntPtr.Zero);
            Win32.PostMessage(Hwnd, 0x0006, new IntPtr(value ? 1 : 0), IntPtr.Zero);
        }
    }

    internal void RememberFocus()
    {
        uint pid;
        uint thread = Win32.GetWindowThreadProcessId(Hwnd, out pid);
        var info = new Win32.GUITHREADINFO();
        info.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
        if (Win32.GetGUIThreadInfo(thread, ref info) && (info.Focus == Hwnd || Win32.IsChild(Hwnd, info.Focus))) LastFocus = info.Focus;
    }

    internal void Focus()
    {
        if (!Mounted || !StillOurWindow()) return;
        Win32.SetActiveWindow(Hwnd);
        Activate(true, true);
        uint pid;
        uint targetThread = Win32.GetWindowThreadProcessId(Hwnd, out pid);
        var current = new Win32.GUITHREADINFO(); current.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
        if (Win32.GetGUIThreadInfo(targetThread, ref current) && (current.Focus == Hwnd || Win32.IsChild(Hwnd, current.Focus))) {
            LastFocus = current.Focus;
            return;
        }
        uint ownThread = Win32.GetCurrentThreadId();
        var keyboard = new byte[256]; Win32.GetKeyboardState(keyboard);
        bool attached = targetThread != ownThread && Win32.AttachThreadInput(ownThread, targetThread, true);
        try
        {
            IntPtr target = LastFocus != IntPtr.Zero && Win32.IsWindow(LastFocus) && Win32.IsChild(Hwnd, LastFocus) ? LastFocus : Hwnd;
            if (attached) Win32.SetKeyboardState(keyboard);
            Win32.SetActiveWindow(Hwnd);
            Win32.SetFocus(target);
        }
        finally { if (attached) { Win32.AttachThreadInput(ownThread, targetThread, false); Win32.SetKeyboardState(keyboard); } }
    }

    internal void Restore()
    {
        if (!Touched && !Mounted) return;
        if (!StillOurWindow()) { Mounted = false; Touched = false; NativeReady = false; return; }
        RequireResponse();
        IntPtr previousContext = Win32.SetThreadDpiAwarenessContext(OriginalDpiContext);
        try
        {
        Win32.ShowWindow(Hwnd, Win32.SW_HIDE);
        Win32.Parent(Hwnd, OriginalParent);
        // Restore only what FS changed, retaining runtime rendering flags and
        // any modal disabled state established while the window was embedded.
        Win32.SetStyle(Hwnd, Win32.GWL_STYLE,
            (Win32.Style(Hwnd, Win32.GWL_STYLE) & ~EmbeddedStyleMask) | (OriginalStyle & EmbeddedStyleMask));
        Win32.SetStyle(Hwnd, Win32.GWL_EXSTYLE,
            (Win32.Style(Hwnd, Win32.GWL_EXSTYLE) & ~EmbeddedExStyleMask) | (OriginalExStyle & EmbeddedExStyleMask));
        if (OriginalOwner != IntPtr.Zero) Win32.SetWindowLongPtr(Hwnd, Win32.GWLP_HWNDPARENT, OriginalOwner);
        if (!Win32.SetWindowPos(Hwnd, (OriginalExStyle & Win32.WS_EX_TOPMOST) != 0 ? new IntPtr(-1) : Win32.HWND_NOTOPMOST,
            OriginalRect.Left, OriginalRect.Top, OriginalRect.Right - OriginalRect.Left, OriginalRect.Bottom - OriginalRect.Top,
            Win32.SWP_FRAMECHANGED | Win32.SWP_NOACTIVATE)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!Win32.SetWindowPlacement(Hwnd, ref OriginalPlacement)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!OriginalVisible) Win32.ShowWindow(Hwnd, Win32.SW_HIDE);
        if (Win32.GetParent(Hwnd) != OriginalParent) throw new InvalidOperationException(Name + " original parent was not restored.");
        Mounted = false;
        Touched = false;
        NativeReady = false;
        }
        finally { Win32.SetThreadDpiAwarenessContext(previousContext); }
    }

    internal string Describe()
    {
        Win32.RECT rect;
        Win32.GetWindowRect(Hwnd, out rect);
        var info = new Win32.GUITHREADINFO(); info.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
        uint pid; uint thread = Win32.GetWindowThreadProcessId(Hwnd, out pid);
        Win32.GetGUIThreadInfo(thread, ref info);
        var className = new StringBuilder(128); Win32.GetClassName(Hwnd, className, className.Capacity);
        return String.Format("{0} PID={1} HWND={2} parent={3} style=0x{4:X8} exstyle=0x{5:X8} rect={6},{7},{8},{9} visible={10} dpi={11} awareness={12} class={13} focus={14}",
            Name, Pid, Win32.Hex(Hwnd), Win32.Hex(Win32.GetParent(Hwnd)), Win32.Style(Hwnd, Win32.GWL_STYLE),
            Win32.Style(Hwnd, Win32.GWL_EXSTYLE), rect.Left, rect.Top, rect.Right, rect.Bottom,
            Win32.IsWindowVisible(Hwnd), Win32.GetDpiForWindow(Hwnd), Win32.GetAwarenessFromDpiAwarenessContext(Win32.GetWindowDpiAwarenessContext(Hwnd)),
            className, Win32.Hex(info.Focus));
    }

    internal WindowRecovery Recovery(string agentId)
    {
        var p = OriginalPlacement;
        return new WindowRecovery { agent = agentId, name = Name, pid = Pid, startTicks = StartTicks,
            hwnd = Hwnd.ToInt64(), parent = OriginalParent.ToInt64(), owner = OriginalOwner.ToInt64(),
            style = OriginalStyle, exstyle = OriginalExStyle, visible = OriginalVisible,
            rect = new int[] { OriginalRect.Left, OriginalRect.Top, OriginalRect.Right, OriginalRect.Bottom },
            placement = new int[] { p.Flags, p.ShowCmd, p.MinPosition.X, p.MinPosition.Y, p.MaxPosition.X, p.MaxPosition.Y,
                p.NormalPosition.Left, p.NormalPosition.Top, p.NormalPosition.Right, p.NormalPosition.Bottom } };
    }

    internal static AgentWindow Recover(WindowRecovery saved)
    {
        using (Process process = Process.GetProcessById(saved.pid))
            if (process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString() != saved.startTicks) return null;
        var entry = new AgentWindow { Name = saved.name, Pid = saved.pid, StartTicks = saved.startTicks,
            Hwnd = new IntPtr(saved.hwnd), OriginalParent = new IntPtr(saved.parent), OriginalOwner = new IntPtr(saved.owner),
            OriginalStyle = saved.style, OriginalExStyle = saved.exstyle, OriginalVisible = saved.visible, Touched = true };
        if (!entry.StillOurWindow()) return null;
        entry.OriginalDpiContext = Win32.GetWindowDpiAwarenessContext(entry.Hwnd);
        entry.OriginalRect = new Win32.RECT { Left = saved.rect[0], Top = saved.rect[1], Right = saved.rect[2], Bottom = saved.rect[3] };
        entry.OriginalPlacement = new Win32.WINDOWPLACEMENT { Length = Marshal.SizeOf(typeof(Win32.WINDOWPLACEMENT)),
            Flags = saved.placement[0], ShowCmd = saved.placement[1],
            MinPosition = new Win32.POINT { X = saved.placement[2], Y = saved.placement[3] },
            MaxPosition = new Win32.POINT { X = saved.placement[4], Y = saved.placement[5] },
            NormalPosition = new Win32.RECT { Left = saved.placement[6], Top = saved.placement[7], Right = saved.placement[8], Bottom = saved.placement[9] } };
        return entry;
    }
}

public sealed class WindowRecovery
{
    public string agent, name, startTicks;
    public int pid;
    public long hwnd, parent, owner;
    public uint style, exstyle;
    public bool visible;
    public int[] rect, placement;
}

public sealed class WindowJournal
{
    public int helperPid;
    public string helperStartTicks;
    public WindowRecovery[] windows;
}

