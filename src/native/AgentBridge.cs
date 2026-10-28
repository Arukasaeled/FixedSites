using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Windows.Automation;

internal static class BridgeNative
{
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd, out Win32.RECT rect);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern int SetThreadDpiHostingBehavior(int behavior);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandle(string name);
    internal delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowsHookEx(int id, KeyboardProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    internal delegate void WindowEventProc(IntPtr hook, uint type, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WindowEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(Win32.POINT point);
}

internal sealed class AgentPane : Panel
{
    internal Action DpiChanged;
    internal Action FocusRequested;
    private readonly IntPtr nativeParent;
    protected override CreateParams CreateParams
    {
        get {
            CreateParams parameters = base.CreateParams;
            parameters.Caption = "Fixed Sites Agents";
            parameters.Parent = nativeParent;
            parameters.Style = unchecked((int)(Win32.WS_CHILD | Win32.WS_CLIPCHILDREN | Win32.WS_CLIPSIBLINGS));
            return parameters;
        }
    }
    internal AgentPane(IntPtr parent, bool mixed = false)
    {
        nativeParent = parent;
        Size = new System.Drawing.Size(1, 1);
        BackColor = System.Drawing.Color.FromArgb(21, 28, 37);
        int previousHosting = mixed ? BridgeNative.SetThreadDpiHostingBehavior(1) : 0;
        try { CreateHandle(); }
        finally { if (mixed) BridgeNative.SetThreadDpiHostingBehavior(previousHosting); }
    }
    internal new void DestroyHandle() { Dispose(); }
    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if ((message.Msg == 0x02E0 || message.Msg == 0x02E3) && DpiChanged != null) DpiChanged();
        if ((message.Msg == 0x0007 || message.Msg == 0x0021) && FocusRequested != null) FocusRequested();
    }
}

public sealed class WindowReference
{
    public string hwnd { get; set; }
    public int pid { get; set; }
    public string startTicks { get; set; }
    internal bool Matches(AgentWindow window)
    {
        return window.Pid == pid && window.StartTicks == startTicks &&
            String.Equals(Win32.Hex(window.Hwnd), hwnd, StringComparison.OrdinalIgnoreCase);
    }
}

public sealed class AgentPreset
{
    public string id { get; set; }
    public string name { get; set; }
    public string processName { get; set; }
    public string executableContains { get; set; }
    public string launchPath { get; set; }
    public WindowReference selectedWindow { get; set; }
    public WindowReference[] protectedWindows { get; set; }
}

public sealed class DiscoveryRequest
{
    public AgentPreset preset { get; set; }
    public WindowReference current { get; set; }
}

internal sealed class AgentBridge
{
    private readonly IntPtr parent;
    private readonly Control dispatcher = new Control();
    private readonly AgentPane pane;
    private readonly Dictionary<string, AgentWindow> windows = new Dictionary<string, AgentWindow>();
    private readonly Dictionary<string, AgentPane> agentPanes = new Dictionary<string, AgentPane>();
    private readonly Dictionary<string, string> errors = new Dictionary<string, string>();
    private readonly Dictionary<string, AgentPreset> presets = new Dictionary<string, AgentPreset>();
    private readonly Dictionary<string, object[]> choices = new Dictionary<string, object[]>();
    private readonly Dictionary<string, string> phases = new Dictionary<string, string>();
    private readonly JavaScriptSerializer output = new JavaScriptSerializer();
    private readonly HashSet<int> pressed = new HashSet<int>();
    private readonly BridgeNative.KeyboardProc keyboardCallback;
    private readonly BridgeNative.KeyboardProc mouseCallback;
    private readonly BridgeNative.WindowEventProc windowCallback;
    private readonly List<IntPtr> eventHooks = new List<IntPtr>();
    private IntPtr keyboardHook, mouseHook;
    private string active;
    private int leftDip = 224, topDip = 48, widthDip = 0, heightDip = 0;
    private bool visible, immersive, exited;
    private System.Windows.Forms.Timer waitTimer;
    private System.Windows.Forms.Timer switchTimer;
    private bool switchPending;
    private int switchRequest;
    private DateTime switchDeadline;
    private int waitRequest;
    private string waitAgent;
    private bool eventPending, focusPending, restoring;
    private bool accessibilityFocusPending;
    private Win32.POINT? focusPoint;
    private volatile AgentWindow selectedWindow;
    private bool pointerInside;
    private long lastPointerInput;
    private System.Drawing.Size activeSize;
    private readonly string recoveryPath;

    internal AgentBridge(IntPtr parentHandle, string journalPath = null)
    {
        parent = parentHandle;
        recoveryPath = journalPath;
        dispatcher.CreateControl();
        IntPtr dispatchHandle = dispatcher.Handle;
        pane = new AgentPane(parent, true);
        pane.DpiChanged = ApplyLayout;
        pane.FocusRequested = RequestFocus;
        keyboardCallback = OnKeyboard;
        mouseCallback = OnMouse;
        windowCallback = OnWindowEvent;
        keyboardHook = BridgeNative.SetWindowsHookEx(13, keyboardCallback, BridgeNative.GetModuleHandle(null), 0);
        mouseHook = BridgeNative.SetWindowsHookEx(14, mouseCallback, BridgeNative.GetModuleHandle(null), 0);
        eventHooks.Add(BridgeNative.SetWinEventHook(3, 3, IntPtr.Zero, windowCallback, 0, 0, 2));
        eventHooks.Add(BridgeNative.SetWinEventHook(10, 11, IntPtr.Zero, windowCallback, 0, 0, 2));
        eventHooks.Add(BridgeNative.SetWinEventHook(0x8001, 0x800B, IntPtr.Zero, windowCallback, 0, 0, 2));
        RecoverWindows();
    }

    private void Write(object message)
    {
        Console.WriteLine(output.Serialize(message));
        Console.Out.Flush();
    }

    private object[] States()
    {
        var result = new List<object>();
        foreach (AgentPreset preset in presets.Values)
        {
            string id = preset.id;
            AgentWindow entry;
            string error, phase;
            object[] candidates;
            bool present = windows.TryGetValue(id, out entry);
            bool attached = present && entry.NativeReady && entry.MountedCorrectly() && Win32.IsChild(parent, entry.Container);
            errors.TryGetValue(id, out error);
            phases.TryGetValue(id, out phase); choices.TryGetValue(id, out candidates);
            string stage = phase == "attaching" ? "attaching" : phase == "failed" || error != null ? "failed" : attached ? "connected" : "unselected";
            result.Add(new { id = id, name = preset.name, attached = attached, phase = phase, connectionStage = stage,
                restoreNeeded = present && entry.StillOurWindow() && (entry.Touched || entry.Mounted),
                window = present ? entry.Metadata(preset, entry.Mounted) : null, visualVerified = false,
                candidates = candidates ?? new object[0],
                error = error, pid = attached ? entry.Pid : 0, hwnd = attached ? Win32.Hex(entry.Hwnd) : null,
                startTicks = attached ? entry.StartTicks : null });
        }
        return result.ToArray();
    }

    private AgentWindow Attach(string id, bool freshLaunch, bool explicitSelection = false)
    {
        AgentPreset preset = presets[id];
        AgentWindow entry = null, previous;
        windows.TryGetValue(id, out previous);
        if (previous != null && previous.Mounted && previous.StillOurWindow() &&
            (!explicitSelection || (preset.selectedWindow != null && preset.selectedWindow.Matches(previous)))) return previous;
        if (explicitSelection) {
            // The preview card identifies one HWND, not one process. Inspect that
            // exact reference before touching a previously connected window.
            entry = AgentWindow.Inspect(preset, preset.selectedWindow);
            bool protectedWindow = false;
            if (entry != null && preset.protectedWindows != null)
                foreach (WindowReference excluded in preset.protectedWindows) if (excluded.Matches(entry)) protectedWindow = true;
            if (entry == null || !entry.Eligible() || protectedWindow)
                throw new InvalidOperationException("所选窗口已退出、重建、受保护或当前不可接入，请刷新预览后重新选择。");
        }
        if (previous != null && (previous.Mounted || previous.Touched)) {
            // Restore the previous selection before replacing its recovery record.
            // A failed restoration keeps the record and stops the new attachment.
            restoring = true;
            try { previous.Restore(); SaveWindows(); }
            finally { restoring = false; }
            if (active == id) { active = null; selectedWindow = null; visible = false; Win32.ShowWindow(pane.Handle, Win32.SW_HIDE); }
            windows.Remove(id);
        }
        if (!explicitSelection) {
            var candidates = AgentWindow.Candidates(preset.name, preset.processName, preset.executableContains);
            var all = candidates.ToArray();
            candidates.RemoveAll(delegate(AgentWindow candidate) {
                if (preset.protectedWindows != null)
                    foreach (WindowReference excluded in preset.protectedWindows) if (excluded.Matches(candidate)) return true;
                return !candidate.Eligible();
            });
            entry = candidates.Find(delegate(AgentWindow candidate) { return preset.selectedWindow != null && preset.selectedWindow.Matches(candidate); });
            if (entry == null && (preset.selectedWindow != null || id == "codex" || candidates.Count > 1) &&
                AgentWindow.ProcessIds(preset.processName, preset.executableContains).Count != 0)
            {
                // A vanished saved HWND must not silently become a different
                // window of the same process, including after window recreation.
                var rows = new List<object>();
                foreach (AgentWindow candidate in all) rows.Add(candidate.Metadata(preset, false));
                choices[id] = rows.ToArray();
                phases[id] = "selecting";
                return null;
            }
            if (entry == null && candidates.Count != 0) entry = candidates[0];
        }
        if (entry == null) return null;
        IntPtr container = pane.Handle;
        AgentPane obsolete;
        if (agentPanes.TryGetValue(id, out obsolete) &&
            Win32.AreDpiAwarenessContextsEqual(entry.OriginalDpiContext, Win32.GetWindowDpiAwarenessContext(pane.Handle))) {
            obsolete.DestroyHandle(); agentPanes.Remove(id);
        }
        if (!Win32.AreDpiAwarenessContextsEqual(entry.OriginalDpiContext, Win32.GetWindowDpiAwarenessContext(container)))
        {
            // Keep the Agent's process DPI unchanged. The outer helper pane
            // permits a nested pane created with the Agent's own DPI context.
            AgentPane inner;
            if (agentPanes.TryGetValue(id, out inner) && !Win32.AreDpiAwarenessContextsEqual(entry.OriginalDpiContext, Win32.GetWindowDpiAwarenessContext(inner.Handle))) {
                inner.DestroyHandle(); agentPanes.Remove(id);
            }
            if (!agentPanes.TryGetValue(id, out inner))
            {
                IntPtr previousContext = Win32.SetThreadDpiAwarenessContext(entry.OriginalDpiContext);
                try { inner = new AgentPane(pane.Handle); }
                finally { Win32.SetThreadDpiAwarenessContext(previousContext); }
                agentPanes[id] = inner;
            }
            container = inner.Handle;
        }
        windows[id] = entry;
        entry.Container = container;
        SaveWindows(entry);
        try { entry.Mount(container); }
        catch { try { entry.Restore(); } finally { SaveWindows(); } throw; }
        SaveWindows();
        errors.Remove(id);
        choices.Remove(id);
        return entry;
    }

    private void Select(string id, AgentWindow entry, int request, bool forceLayout = false)
    {
        errors.Remove(id);
        if (!forceLayout && active == id && visible && entry.NativeReady && DisplayLayoutConfirmed(entry)) {
            phases[id] = "connected"; RequestFocus(); Reply(request, null); return;
        }
        StopSwitchTimer();
        AgentWindow previous;
        if (active != null && windows.TryGetValue(active, out previous)) previous.RememberFocus();
        active = id;
        selectedWindow = entry; pointerInside = false;
        switchPending = true;
        switchRequest = request;
        switchDeadline = DateTime.UtcNow.AddMilliseconds(1600);
        entry.NativeReady = false;
        phases[id] = "attaching";
        Write(new { eventName = "state", agents = States() });
        ApplyLayout(true);
        AgentPane inner;
        if (agentPanes.TryGetValue(id, out inner) && entry.Container == inner.Handle) {
            if (!Win32.SetWindowPos(inner.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0003 | Win32.SWP_NOACTIVATE))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            Win32.ShowWindow(inner.Handle, Win32.SW_SHOW);
        }
        // Raise/show the incoming child without hiding the outgoing window or
        // the shared pane. Preserve its last frame while Chromium wakes up.
        if ((Win32.Style(pane.Handle, Win32.GWL_STYLE) & Win32.WS_VISIBLE) == 0) Win32.ShowWindow(pane.Handle, Win32.SW_SHOW);
        entry.ShowInside(activeSize);
        visible = true;
        Win32.SetForegroundWindow(parent);
        var timer = new System.Windows.Forms.Timer(); timer.Interval = 80;
        switchTimer = timer;
        timer.Tick += delegate {
            if (!switchPending || entry != selectedWindow) { StopSwitchTimer(); return; }
            if (!entry.StillOurWindow()) FailSwitch("所选窗口在接入时退出或重建，请刷新预览后重新选择。", false);
            else if (Win32.GetParent(entry.Hwnd) != entry.Container) FailSwitch("所选窗口的父级在接入时发生变化，已尝试还原，请重新选择。", false);
            else if (DisplayLayoutConfirmed(entry)) FinishSwitch();
            else if (DateTime.UtcNow >= switchDeadline) FailSwitch("未确认窗口的父级、显示状态和内容区域尺寸；已尝试还原，请刷新后重选。", false);
        };
        timer.Start();
    }

    private void StopSwitchTimer()
    {
        if (switchTimer == null) return;
        switchTimer.Stop(); switchTimer.Dispose(); switchTimer = null;
    }

    private void FinishSwitch()
    {
        AgentWindow entry = selectedWindow;
        if (entry == null || !DisplayLayoutConfirmed(entry)) return;
        StopSwitchTimer();
        switchPending = false;
        entry.NativeReady = true;
        phases[active] = "connected";
        foreach (var pair in windows) {
            if (pair.Value == entry || !pair.Value.Mounted || !pair.Value.StillOurWindow()) continue;
            pair.Value.Activate(false);
            Win32.ShowWindowAsync(pair.Value.Hwnd, Win32.SW_HIDE);
            AgentPane inner;
            if (agentPanes.TryGetValue(pair.Key, out inner)) Win32.ShowWindow(inner.Handle, Win32.SW_HIDE);
        }
        entry.Focus();
        RequestAccessibleFocus();
        int request = switchRequest; switchRequest = 0;
        if (request != 0) Reply(request, null);
        else Write(new { eventName = "state", agents = States() });
    }

    private bool DisplayLayoutConfirmed(AgentWindow entry)
    {
        if (!entry.LayoutConfirmed(activeSize) || !Win32.IsChild(parent, entry.Container) || !Win32.IsWindowVisible(pane.Handle)) return false;
        Win32.RECT area;
        if (!Win32.GetWindowRect(pane.Handle, out area)) return false;
        // Check native siblings above the pane. Visibility alone does not say
        // whether Electron's renderer HWND covers the entire Agent region.
        for (IntPtr sibling = Win32.GetWindow(pane.Handle, 3); sibling != IntPtr.Zero; sibling = Win32.GetWindow(sibling, 3)) {
            if (!Win32.IsWindowVisible(sibling)) continue;
            Win32.RECT rect;
            if (Win32.GetWindowRect(sibling, out rect) && rect.Left < area.Right && rect.Right > area.Left && rect.Top < area.Bottom && rect.Bottom > area.Top) return false;
        }
        return true;
    }

    private void FailSwitch(string message, bool cancelled)
    {
        StopSwitchTimer(); switchPending = false;
        int request = switchRequest; switchRequest = 0;
        string id = active;
        AgentWindow entry = selectedWindow;
        if (entry != null) {
            entry.NativeReady = false;
            restoring = true;
            try { entry.Restore(); SaveWindows(); }
            catch (Exception error) { message += " 还原未完成：" + error.Message + "。请使用断开并还原，勿结束目标进程。"; cancelled = false; }
            finally { restoring = false; }
        }
        visible = false; selectedWindow = null; active = null;
        Win32.ShowWindow(pane.Handle, Win32.SW_HIDE);
        if (id != null) { phases[id] = cancelled ? "unselected" : "failed"; if (!cancelled) errors[id] = message; }
        if (request != 0) Write(new { id = request, ok = cancelled, cancelled = cancelled, error = cancelled ? null : message, agents = States() });
    }

    private void Reply(int id, string error)
    {
        Write(new { id = id, ok = error == null, error = error, agents = States(), pane = Win32.Hex(pane.Handle) });
    }

    private void SaveWindows(AgentWindow mounting = null)
    {
        if (String.IsNullOrEmpty(recoveryPath)) return;
        var saved = new List<WindowRecovery>();
        foreach (var pair in windows)
            if (pair.Value.Touched || pair.Value.Mounted || pair.Value == mounting) saved.Add(pair.Value.Recovery(pair.Key));
        if (saved.Count == 0) { if (File.Exists(recoveryPath)) File.Delete(recoveryPath); return; }
        using (Process helper = Process.GetCurrentProcess()) {
            string text = output.Serialize(new WindowJournal { helperPid = helper.Id,
                helperStartTicks = helper.StartTime.ToUniversalTime().Ticks.ToString(), windows = saved.ToArray() });
            File.WriteAllText(recoveryPath + ".tmp", text, new UTF8Encoding(false));
            if (File.Exists(recoveryPath)) File.Replace(recoveryPath + ".tmp", recoveryPath, null);
            else File.Move(recoveryPath + ".tmp", recoveryPath);
        }
    }

    private void RecoverWindows()
    {
        if (String.IsNullOrEmpty(recoveryPath) || !File.Exists(recoveryPath)) return;
        WindowJournal journal = output.Deserialize<WindowJournal>(File.ReadAllText(recoveryPath));
        bool ownerAlive = false;
        try { using (Process previous = Process.GetProcessById(journal.helperPid))
            ownerAlive = !previous.HasExited && previous.StartTime.ToUniversalTime().Ticks.ToString() == journal.helperStartTicks;
        } catch (ArgumentException) { }
        if (ownerAlive) throw new InvalidOperationException("旧原生宿主仍在运行，请先正常关闭旧版 Fixed Sites。");
        foreach (WindowRecovery saved in journal.windows) {
            AgentWindow entry = null;
            try { entry = AgentWindow.Recover(saved); } catch (ArgumentException) { }
            if (entry != null) entry.Restore();
        }
        File.Delete(recoveryPath);
    }

    private void FocusActive()
    {
        AgentWindow entry;
        if (!visible || active == null || !windows.TryGetValue(active, out entry) || !entry.Mounted || !entry.StillOurWindow()) return;
        IntPtr foreground = BridgeNative.GetForegroundWindow();
        if (foreground != parent && !Win32.IsChild(parent, foreground)) return;
        if (!Win32.IsWindowVisible(entry.Hwnd)) return;
        if (!Win32.IsWindowEnabled(entry.Hwnd)) {
            IntPtr popup = Win32.GetLastActivePopup(entry.Hwnd);
            if (popup != entry.Hwnd && Win32.IsWindow(popup)) { Win32.ShowWindowAsync(popup, Win32.SW_SHOW); Win32.SetForegroundWindow(popup); }
            return;
        }
        uint focusPid; uint focusThread = Win32.GetWindowThreadProcessId(entry.Hwnd, out focusPid);
        var focusInfo = new Win32.GUITHREADINFO(); focusInfo.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
        if (Win32.GetGUIThreadInfo(focusThread, ref focusInfo) && (focusInfo.Flags & 0x1C) != 0) return;
        // Electron can raise its own renderer HWND after focus/compositor work.
        // Restore the native pane's child z-order as well as editing focus.
        ApplyLayout();
        entry.Focus();
        RequestAccessibleFocus();
    }

    private void RequestAccessibleFocus()
    {
        AgentWindow entry;
        if (accessibilityFocusPending || !visible || active == null || !windows.TryGetValue(active, out entry)) return;
        Win32.POINT? point = focusPoint; focusPoint = null;
        accessibilityFocusPending = true;
        // Chromium needs its own editing view focused as well as the Win32 HWND.
        // UI Automation asks its existing provider to do this; no Agent code or
        // DOM is injected, and the helper's layout/exit thread stays responsive.
        ThreadPool.QueueUserWorkItem(delegate {
            try {
                AutomationElement root = AutomationElement.FromHandle(entry.Hwnd);
                if (root == null) return;
                AutomationElement target = null;
                if (point.HasValue) {
                    target = AutomationElement.FromPoint(new System.Windows.Point(point.Value.X, point.Value.Y));
                    while (target != null && !target.Current.IsKeyboardFocusable) target = TreeWalker.RawViewWalker.GetParent(target);
                }
                if (target == null) target = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.HasKeyboardFocusProperty, true));
                if (target == null) target = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
                IntPtr foreground = BridgeNative.GetForegroundWindow();
                if (target != null && selectedWindow == entry && visible && !restoring && !exited && entry.Mounted && Win32.IsWindowVisible(entry.Hwnd) &&
                    (foreground == parent || Win32.IsChild(parent, foreground))) {
                    // Do not focus a sibling Agent or a protected Codex window.
                    AutomationElement ancestor = target;
                    while (ancestor != null && ancestor.Current.NativeWindowHandle != unchecked((int)entry.Hwnd.ToInt64())) ancestor = TreeWalker.RawViewWalker.GetParent(ancestor);
                    if (ancestor != null && !target.Current.HasKeyboardFocus) target.SetFocus();
                }
            } catch (ElementNotAvailableException) { }
              catch (ArgumentException) { }
              catch (InvalidOperationException) { }
              catch (COMException) { }
            finally {
                accessibilityFocusPending = false;
                if (visible && !restoring && !exited && selectedWindow != entry) RequestFocus();
            }
        });
    }

    private void RequestFocus()
    {
        if (focusPending || restoring || exited) return;
        focusPending = true;
        dispatcher.BeginInvoke(new Action(delegate {
            focusPending = false;
            try { FocusActive(); }
            catch (Exception error) { if (active != null) errors[active] = error.Message; Write(new { eventName = "state", agents = States() }); }
        }));
    }

    private IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        int type = message.ToInt32();
        IntPtr foreground = BridgeNative.GetForegroundWindow();
        if (code >= 0 && visible && active != null && !restoring && (foreground == parent || Win32.IsChild(parent, foreground)) &&
            (type == 0x0200 || type == 0x0201 || type == 0x0204 || type == 0x0207 || type == 0x020A || type == 0x020E)) {
            AgentWindow entry;
            if (windows.TryGetValue(active, out entry) && entry.Mounted && entry.StillOurWindow()) {
                var point = new Win32.POINT { X = Marshal.ReadInt32(data), Y = Marshal.ReadInt32(data, 4) };
                IntPtr target = BridgeNative.WindowFromPoint(point);
                Win32.RECT area;
                Win32.GetWindowRect(pane.Handle, out area);
                bool contentHit = point.X >= area.Left && point.X < area.Right && point.Y >= area.Top && point.Y < area.Bottom &&
                    (target == parent || Win32.IsChild(parent, target));
                if (target == entry.Hwnd || Win32.IsChild(entry.Hwnd, target) || contentHit) {
                    long now = DateTime.UtcNow.Ticks;
                    bool wake = !pointerInside || now - lastPointerInput > TimeSpan.FromSeconds(2).Ticks || type != 0x0200;
                    pointerInside = true; lastPointerInput = now;
                    if (!wake) return BridgeNative.CallNextHookEx(mouseHook, code, message, data);
                    if (type == 0x0201 || type == 0x0204) Write(new { eventName = "canvas-focus" });
                    entry.Activate(true, true);
                    if (type == 0x0201) focusPoint = point;
                    RequestFocus();
                } else pointerInside = false;
            }
        }
        return BridgeNative.CallNextHookEx(mouseHook, code, message, data);
    }

    private void OnWindowEvent(IntPtr hook, uint type, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (restoring || exited) return;
        if (visible && type == 0x8004 && hwnd == parent) { RequestFocus(); return; }
        if (type == 3) {
            if (hwnd == parent || Win32.IsChild(parent, hwnd)) RequestFocus();
            else if (active != null && visible) {
                AgentWindow entry;
                if (windows.TryGetValue(active, out entry)) {
                    IntPtr owner = hwnd;
                    while (owner != IntPtr.Zero && owner != entry.Hwnd) owner = Win32.GetWindow(owner, Win32.GW_OWNER);
                    if (owner != entry.Hwnd) entry.Activate(false);
                }
            }
            return;
        }
        AgentWindow watched = null;
        foreach (AgentWindow entry in windows.Values)
            if (entry.Mounted && entry.Hwnd == hwnd) { watched = entry; break; }
        if (watched != null && type == 0x8005 && watched == selectedWindow && visible) RequestFocus();
        if (watched == null || objectId != 0 || childId != 0) return;
        if (type == 10) Win32.PostMessage(hwnd, 0x001F, IntPtr.Zero, IntPtr.Zero); // cancel the foreign window's move/resize loop
        if (eventPending) return;
        eventPending = true;
        dispatcher.BeginInvoke(new Action(delegate {
            eventPending = false;
            if (restoring || exited) return;
            bool changed = false;
            foreach (var pair in windows) {
                AgentWindow entry = pair.Value;
                if (!entry.Mounted) continue;
                if (!entry.StillOurWindow()) {
                    entry.Mounted = false; entry.Touched = false; entry.NativeReady = false;
                    if (switchPending && entry == selectedWindow) { FailSwitch("所选窗口在接入时退出或重建，请刷新预览。", false); continue; }
                    if (pair.Key == active) { Hide(); active = null; selectedWindow = null; }
                    phases[pair.Key] = "failed";
                    errors[pair.Key] = "接入窗口已退出或重建，请刷新预览后重新选择；不会自动接管同进程的其他窗口。";
                    changed = true;
                    continue;
                }
                if (!Win32.IsWindow(entry.Container) || Win32.GetParent(entry.Hwnd) != entry.Container) {
                    if (switchPending && entry == selectedWindow) { FailSwitch("所选窗口的宿主关系已变化，已尝试还原，请重新选择。", false); continue; }
                    entry.NativeReady = false;
                    phases[pair.Key] = "failed";
                    errors[pair.Key] = "接入窗口的宿主关系已变化，请断开还原后重新选择。";
                    continue;
                }
                if (pair.Key != active || !visible) continue;
                try {
                    activeSize = entry.ContainerClientSize();
                    if (entry.NeedsLayout(activeSize)) entry.Constrain(activeSize);
                    if (switchPending) {
                        // ShowWindowAsync completes on the Agent's UI thread.
                        // A delayed SHOW event completes the same handoff; no
                        // permanent visibility polling is needed.
                        if (DisplayLayoutConfirmed(entry)) FinishSwitch();
                        continue;
                    }
                    // IsWindowVisible includes the parent. Hiding that parent
                    // then testing the same API permanently latched the pane off.
                    if (!entry.OwnVisible()) {
                        phases[pair.Key] = "hidden";
                        if ((Win32.Style(pane.Handle, Win32.GWL_STYLE) & Win32.WS_VISIBLE) != 0) Win32.ShowWindow(pane.Handle, Win32.SW_HIDE);
                    }
                    else {
                        if ((Win32.Style(pane.Handle, Win32.GWL_STYLE) & Win32.WS_VISIBLE) == 0) Win32.ShowWindow(pane.Handle, Win32.SW_SHOW);
                        if (phases.ContainsKey(pair.Key) && phases[pair.Key] == "hidden") phases.Remove(pair.Key);
                        if (hwnd == entry.Hwnd && type == 0x8002) RequestFocus();
                    }
                } catch (Exception error) {
                    if (switchPending && entry == selectedWindow) FailSwitch(error.Message, false);
                    else { errors[pair.Key] = error.Message; phases[pair.Key] = "failed"; entry.NativeReady = false; }
                }
            }
            if (changed) SaveWindows();
            Write(new { eventName = "state", agents = States() });
        }));
    }

    private void BeginAttach(int request, string id, bool select, bool allowLaunch, bool explicitSelection = false)
    {
        if (!presets.ContainsKey(id)) throw new InvalidOperationException("Unsupported agent.");
        phases.Remove(id);
        AgentWindow entry;
        try { entry = Attach(id, false, explicitSelection); }
        catch { phases[id] = "failed"; if (select) Hide(); throw; }
        if (entry != null) {
            if (select) {
                try { Select(id, entry, request); } catch (Exception error) { FailSwitch(error.Message, false); }
            } else Reply(request, null);
            return;
        }
        if (phases.ContainsKey(id) && phases[id] == "selecting") {
            if (select) Hide(); Reply(request, null); return;
        }
        // No live window: reveal the explicit connection/start state instead.
        if (select) Hide();
        AgentPreset preset = presets[id];
        bool launch = AgentWindow.ProcessIds(preset.processName, preset.executableContains).Count == 0;
        if (!allowLaunch)
        {
            // A normal selection is a single lookup, never a 30-second wait.
            // Leftover/background processes must not block every other entry.
            phases[id] = launch ? "stopped" : "no-window";
            errors.Remove(id); choices.Remove(id);
            Reply(request, null);
            return;
        }
        if (launch || id != "codex")
        {
            phases[id] = "stopped";
            var start = new ProcessStartInfo(preset.launchPath);
            start.UseShellExecute = true;
            if (!preset.launchPath.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)) start.WorkingDirectory = Path.GetDirectoryName(preset.launchPath);
            using (Process process = Process.Start(start)) { }
        }
        phases[id] = launch ? "starting" : "waiting";
        errors.Remove(id);
        Write(new { eventName = "state", agents = States() });
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        var timer = new System.Windows.Forms.Timer(); timer.Interval = 250;
        waitTimer = timer; waitRequest = request; waitAgent = id;
        timer.Tick += delegate
        {
            try
            {
                entry = Attach(id, launch);
                if (phases.ContainsKey(id) && phases[id] == "selecting") {
                    timer.Stop(); timer.Dispose(); waitTimer = null; Reply(request, null); return;
                }
                if (entry == null)
                {
                    if (DateTime.UtcNow < deadline) return;
                    throw new InvalidOperationException(preset.name + " 已启动或正在运行，但暂时没有可连接的主窗口。请等待应用完成启动、处理启动对话框后重试。");
                }
                timer.Stop(); timer.Dispose(); waitTimer = null;
                if (select) {
                    try { Select(id, entry, request); } catch (Exception error) { FailSwitch(error.Message, false); }
                } else Reply(request, null);
            }
            catch (Exception error)
            {
                timer.Stop(); timer.Dispose(); waitTimer = null; phases[id] = "failed";
                errors[id] = error.Message; Reply(request, error.Message);
            }
        };
        timer.Start();
    }

    private void CancelWait()
    {
        if (switchPending) FailSwitch("接入已取消，目标进程继续运行。", true);
        if (waitTimer == null) return;
        waitTimer.Stop(); waitTimer.Dispose(); waitTimer = null;
        phases.Remove(waitAgent);
        Write(new { id = waitRequest, ok = true, cancelled = true, agents = States() });
        // The application may still be starting. Leave its process alone.
    }

    private void Hide()
    {
        StopSwitchTimer(); switchPending = false;
        foreach (AgentWindow entry in windows.Values)
        {
            if (!entry.Mounted || !entry.StillOurWindow()) continue;
            entry.RememberFocus();
            entry.Activate(false);
            Win32.ShowWindowAsync(entry.Hwnd, Win32.SW_HIDE);
        }
        Win32.ShowWindow(pane.Handle, Win32.SW_HIDE);
        foreach (AgentPane inner in agentPanes.Values) Win32.ShowWindow(inner.Handle, Win32.SW_HIDE);
        visible = false;
    }

    private void ApplyLayout() { ApplyLayout(false); }

    private void ApplyLayout(bool synchronous)
    {
        if (Win32.IsIconic(parent)) return;
        Win32.RECT client;
        if (!Win32.GetClientRect(parent, out client)) throw new Win32Exception(Marshal.GetLastWin32Error());
        double scale = Win32.GetDpiForWindow(parent) / 96.0;
        int x = Math.Max(0, (int)Math.Round(leftDip * scale));
        int y = Math.Max(0, (int)Math.Round(topDip * scale));
        int width = Math.Max(1, Math.Min(client.Right - x, widthDip > 0 ? (int)Math.Round(widthDip * scale) : client.Right - x));
        int height = Math.Max(1, Math.Min(client.Bottom - y, heightDip > 0 ? (int)Math.Round(heightDip * scale) : client.Bottom - y));
        // HWND_TOP affects child z-order only. The pane is clipped to this rect.
        if (!Win32.SetWindowPos(pane.Handle, IntPtr.Zero, x, y, width, height, Win32.SWP_NOACTIVATE))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        AgentWindow entry;
        if (active != null && windows.TryGetValue(active, out entry) && entry.Mounted)
        {
            if (!entry.StillOurWindow() || !Win32.IsWindow(entry.Container) || Win32.GetParent(entry.Hwnd) != entry.Container)
                throw new InvalidOperationException(entry.Name + " 的窗口或宿主关系已变化，请断开还原后重新选择。");
            AgentPane inner;
            if (agentPanes.TryGetValue(active, out inner) && entry.Container == inner.Handle && !Win32.SetWindowPos(inner.Handle, IntPtr.Zero, 0, 0, width, height,
                Win32.SWP_NOACTIVATE | Win32.SWP_NOZORDER)) throw new Win32Exception(Marshal.GetLastWin32Error());
            activeSize = entry.ContainerClientSize();
            if (entry.NeedsLayout(activeSize)) entry.Constrain(activeSize, synchronous);
        }
    }

    private void Restore()
    {
        restoring = true;
        try {
        CancelWait();
        Hide();
        var failures = new List<string>();
        foreach (AgentWindow entry in windows.Values)
        {
            try { entry.Restore(); }
            catch (Exception error) { failures.Add(entry.Name + ": " + error.Message); }
        }
        SaveWindows();
        if (failures.Count != 0) throw new InvalidOperationException(String.Join("; ", failures.ToArray()));
        active = null;
        selectedWindow = null;
        } finally { restoring = false; }
    }

    private void Exit()
    {
        Restore(); // Never destroy the pane while an Agent still belongs to it.
        if (keyboardHook != IntPtr.Zero) BridgeNative.UnhookWindowsHookEx(keyboardHook);
        if (mouseHook != IntPtr.Zero) BridgeNative.UnhookWindowsHookEx(mouseHook);
        foreach (IntPtr hook in eventHooks) if (hook != IntPtr.Zero) BridgeNative.UnhookWinEvent(hook);
        foreach (AgentPane inner in agentPanes.Values) inner.DestroyHandle();
        pane.DestroyHandle();
        exited = true;
        Application.ExitThread();
    }

    private void Command(Dictionary<string, object> command)
    {
        int id = Convert.ToInt32(command["id"]);
        string operation = (string)command["cmd"];
        string agent = command.ContainsKey("agent") ? (string)command["agent"] : null;
        try
        {
            switch (operation)
            {
                case "configure":
                    foreach (AgentPreset preset in output.Deserialize<AgentPreset[]>(output.Serialize(command["presets"])))
                    {
                        if (preset.id != "dsh" && preset.id != "antigravity" && preset.id != "claude" && preset.id != "codex")
                            throw new InvalidOperationException("Unsupported agent preset.");
                        presets[preset.id] = preset;
                    }
                    break;
                case "attach":
                case "switch":
                    if (command.ContainsKey("window")) presets[agent].selectedWindow = output.Deserialize<WindowReference>(output.Serialize(command["window"]));
                    BeginAttach(id, agent, operation == "switch", false, command.ContainsKey("window")); return;
                case "launch":
                    BeginAttach(id, agent, true, true); return;
                case "cancel-wait": CancelWait(); break;
                case "resize":
                    leftDip = Convert.ToInt32(command["x"]); topDip = Convert.ToInt32(command["y"]);
                    widthDip = command.ContainsKey("width") ? Convert.ToInt32(command["width"]) : 0;
                    heightDip = command.ContainsKey("height") ? Convert.ToInt32(command["height"]) : 0;
                    immersive = command.ContainsKey("immersive") && Convert.ToBoolean(command["immersive"]);
                    ApplyLayout(); break;
                case "hide": Hide(); break;
                case "show":
                    AgentWindow showing;
                    if (active != null && windows.TryGetValue(active, out showing) && showing.NativeReady && showing.StillOurWindow()) {
                        ApplyLayout();
                        Win32.ShowWindow(pane.Handle, Win32.SW_SHOW);
                        Win32.ShowWindow(showing.Container, Win32.SW_SHOW);
                        showing.Activate(true);
                        showing.ShowInside(activeSize);
                        visible = true;
                    }
                    break;
                case "focus":
                    FocusActive();
                    break;
                case "sync":
                    AgentWindow syncing;
                    if (!windows.TryGetValue(agent, out syncing) || !syncing.Mounted || !syncing.StillOurWindow())
                        throw new InvalidOperationException("没有可同步的接入窗口，请重新选择。");
                    try { Select(agent, syncing, id, true); } catch (Exception error) { FailSwitch(error.Message, false); }
                    return;
                case "detach":
                    CancelWait();
                    AgentWindow detached;
                    if (windows.TryGetValue(agent, out detached)) {
                        restoring = true;
                        try { detached.Restore(); SaveWindows(); }
                        finally { restoring = false; }
                        if (detached.StillOurWindow() && command.ContainsKey("show") && Convert.ToBoolean(command["show"])) {
                            Win32.ShowWindowAsync(detached.Hwnd, detached.OriginalPlacement.ShowCmd == 3 ? 3 : Win32.SW_RESTORE);
                            Win32.SetForegroundWindow(detached.Hwnd);
                        }
                    }
                    if (active == agent) { visible = false; active = null; selectedWindow = null; Win32.ShowWindow(pane.Handle, Win32.SW_HIDE); }
                    phases[agent] = "detached"; errors.Remove(agent); choices.Remove(agent);
                    break;
                case "restore": Restore(); break;
                case "exit":
                    Exit();
                    Write(new { id = id, ok = true, agents = States(), exited = true });
                    return;
                default: throw new InvalidOperationException("Unsupported command.");
            }
            Write(new { id = id, ok = true, agents = States(), pane = Win32.Hex(pane.Handle) });
        }
        catch (Exception error)
        {
            string failedAgent = agent ?? (operation == "resize" ? active : null);
            if (failedAgent != null) {
                errors[failedAgent] = error.Message; phases[failedAgent] = "failed";
                AgentWindow failed;
                if (windows.TryGetValue(failedAgent, out failed)) failed.NativeReady = false;
            }
            Write(new { id = id, ok = false, error = error.Message, agents = States() });
        }
    }

    private IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            int key = Marshal.ReadInt32(data);
            int type = message.ToInt32();
            bool up = type == 0x0101 || type == 0x0105;
            if (up && pressed.Remove(key)) return new IntPtr(1);
            IntPtr foreground = BridgeNative.GetForegroundWindow();
            if (!up && visible && (foreground == parent || Win32.IsChild(parent, foreground)))
            {
                bool control = BridgeNative.GetAsyncKeyState(0x11) < 0;
                bool alt = BridgeNative.GetAsyncKeyState(0x12) < 0;
                bool shift = BridgeNative.GetAsyncKeyState(0x10) < 0;
                AgentWindow selected;
                if (active == null || !windows.TryGetValue(active, out selected) || !selected.StillOurWindow())
                    return BridgeNative.CallNextHookEx(keyboardHook, code, message, data);
                uint selectedPid; uint selectedThread = Win32.GetWindowThreadProcessId(selected.Hwnd, out selectedPid);
                var focusedInfo = new Win32.GUITHREADINFO(); focusedInfo.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
                bool agentFocus = Win32.GetGUIThreadInfo(selectedThread, ref focusedInfo) &&
                    (focusedInfo.Focus == selected.Hwnd || Win32.IsChild(selected.Hwnd, focusedInfo.Focus));
                // Keep Chromium's activation in agreement with native child focus.
                // Ordinary shortcuts (including copy/paste) are passed unchanged.
                if (agentFocus && (focusedInfo.Flags & 0x1C) == 0) selected.Activate(true);
                string shortcut = key == 0x7A && !control && !alt && !shift ? "immersive" :
                    key == 0x1B && immersive ? "leave-immersive" :
                    key == 0xDC && control && !alt && !shift ? "sidebar" : null;
                if (shortcut != null)
                {
                    uint pid;
                    uint thread = Win32.GetWindowThreadProcessId(parent, out pid);
                    var info = new Win32.GUITHREADINFO(); info.Size = Marshal.SizeOf(typeof(Win32.GUITHREADINFO));
                    Win32.GetGUIThreadInfo(thread, ref info);
                    // Only the selected foreign Agent's focus qualifies. Other
                    // applications, Electron's own UI and native menus pass through.
                    bool focused = info.Focus == selected.Hwnd || Win32.IsChild(selected.Hwnd, info.Focus);
                    if (focused && (info.Flags & 0x1C) == 0)
                    {
                        if (pressed.Add(key)) Write(new { eventName = "shortcut", shortcut = shortcut });
                        return new IntPtr(1);
                    }
                }
            }
        }
        return BridgeNative.CallNextHookEx(keyboardHook, code, message, data);
    }

    internal void Run()
    {
        Write(new { eventName = "ready", pane = Win32.Hex(pane.Handle), agents = States() });
        var reader = new Thread(delegate()
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                var command = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                dispatcher.BeginInvoke(new Action(delegate { Command(command); }));
            }
            if (!exited) dispatcher.BeginInvoke(new Action(delegate
            {
                try { Exit(); } catch (Exception error) { Write(new { eventName = "restore-error", error = error.Message }); }
            }));
        });
        reader.IsBackground = true; reader.Start();
        Application.Run();
    }
}

internal static class BridgeProgram
{
    [STAThread]
    private static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 0 && args[0] == "--discover") {
                // No AgentBridge, HWND container, hooks, journal recovery or window mutation.
                var serializer = new JavaScriptSerializer();
                var request = serializer.Deserialize<DiscoveryRequest>(Console.ReadLine());
                var candidates = AgentWindow.Candidates(request.preset.name, request.preset.processName, request.preset.executableContains);
                var current = AgentWindow.Inspect(request.preset, request.current);
                if (current != null && !candidates.Exists(delegate(AgentWindow item) { return item.Hwnd == current.Hwnd; })) candidates.Insert(0, current);
                var rows = new List<object>();
                foreach (AgentWindow candidate in candidates) rows.Add(candidate.Metadata(request.preset, current != null && candidate.Hwnd == current.Hwnd));
                Console.WriteLine(serializer.Serialize(new { ok = true, windows = rows.ToArray() }));
                return;
            }
            IntPtr parent = new IntPtr(Convert.ToInt64(args[0], 16));
            uint pid;
            if (!Win32.IsWindow(parent) || Win32.GetWindowThreadProcessId(parent, out pid) == 0 || pid != UInt32.Parse(args[1]))
                throw new InvalidOperationException("Electron parent window is no longer valid.");
            Win32.SetThreadDpiAwarenessContext(Win32.GetWindowDpiAwarenessContext(parent));
            new AgentBridge(parent, args.Length > 2 ? args[2] : null).Run();
        }
        catch (Exception error)
        {
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { eventName = "fatal", error = error.Message }));
            Console.Out.Flush();
        }
    }
}
