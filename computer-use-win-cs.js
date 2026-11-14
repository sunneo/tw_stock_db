// computer-use-win-cs.js —— Windows 後端要用的 C# 原始碼（user32／dwmapi／GDI／UI Automation 的薄包裝）。
// 用法：computer-use-windows.js 把這份原始碼用 PowerShell 的 Add-Type 編成一個 DLL（放在 %TEMP%\fa-computer-use\<內容雜湊>.dll，編一次以後重用），
// 之後每個動作只是一段很短的 PowerShell（Add-Type -Path 載入 DLL → 呼叫靜態方法 → 印 JSON），可以走 -EncodedCommand。
// 規矩：
//   * 只用 C# 5 語法（Windows PowerShell 5.1 的 Add-Type 內建 C# 5 編譯器）：不用 ?.、nameof、字串內插、運算式主體成員、out var。
//   * 所有輸出都是「純 ASCII 的 JSON 字串」（非 ASCII 字元一律 \uXXXX 跳脫）：不管主控台的字碼頁是什麼，Node 端都能正確讀回中文標題。
//   * 座標一律是實體像素（程式一開始宣告 per-monitor DPI aware）。
//   * 這份原始碼在 Linux 上用 mono 的 mcs 做過「編譯檢查」（user32 部分；UI Automation 部分用型別樁檢查語法），但沒有在 Windows 上實跑過——見 DESIGN.computer-use.md 的「未實測」。
"use strict";

const CS_USINGS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
`;

const CS_BASE = String.raw`
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

public static class FaJson {
  public static string Str(string s) {
    if (s == null) return "null";
    StringBuilder sb = new StringBuilder("\"");
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
          else sb.Append(c);
          break;
      }
    }
    return sb.Append('"').ToString();
  }
  public static string Rect(int x, int y, int w, int h) { return "{\"x\":" + x + ",\"y\":" + y + ",\"w\":" + w + ",\"h\":" + h + "}"; }
  public static string Bool(bool b) { return b ? "true" : "false"; }
  public static string Err(string m) { return "{\"ok\":false,\"error\":" + Str(m) + "}"; }
  public static string Fnv(string s) {
    byte[] b = Encoding.UTF8.GetBytes(s); uint h = 2166136261;
    int n = Math.Min(b.Length, 120);
    for (int i = 0; i < n; i++) { h ^= b[i]; h = unchecked(h * 16777619); }
    return h.ToString("x8").Substring(0, 6);
  }
}

public static class FaDpi {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public static void Init() {
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
    catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
  }
}
`;

const CS_WIN = String.raw`
[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
  [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out bool on);
  [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
}
[ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")] public class VirtualDesktopManagerCom { }

public static class FaWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint x, out uint y);

  static string Text(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  static IVirtualDesktopManager vdm;
  static bool vdmTried;
  static Dictionary<uint, string> procNames = new Dictionary<uint, string>();
  static string ProcName(uint pid) {
    string n;
    if (procNames.TryGetValue(pid, out n)) return n;
    try { n = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { n = ""; }
    procNames[pid] = n; return n;
  }
  static string RectJson(RECT r) { return FaJson.Rect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top); }

  // 所有頂層視窗（z 順序：index 0 在最上面）。all=false 時略過不可見、沒標題、cloaked（被系統藏起來的 UWP）的視窗。
  public static string ListWindows(bool all) {
    List<string> items = new List<string>();
    IntPtr fg = GetForegroundWindow();
    if (!vdmTried) { vdmTried = true; try { vdm = (IVirtualDesktopManager)new VirtualDesktopManagerCom(); } catch (Exception) { vdm = null; } }
    int z = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      int myZ = z++;
      bool visible = IsWindowVisible(h);
      string title = Text(h);
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch (Exception) { }
      if (!all && (!visible || title.Length == 0 || cloaked != 0)) return true;
      RECT outer; GetWindowRect(h, out outer);
      RECT frame; bool haveFrame = false;
      try { haveFrame = DwmGetWindowAttribute(h, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0; } catch (Exception) { frame = outer; }
      if (!haveFrame) frame = outer;
      RECT cr; GetClientRect(h, out cr);
      POINT cp = new POINT(); cp.X = 0; cp.Y = 0; ClientToScreen(h, ref cp);
      uint pid; GetWindowThreadProcessId(h, out pid);
      int ex = GetWindowLong(h, -20);
      string type = (ex & 0x80) != 0 ? "tool" : (ex & 0x08000000) != 0 ? "noactivate" : "normal";
      bool owned = GetWindow(h, 4) != IntPtr.Zero;
      bool onCur = true; string deskId = "";
      if (vdm != null) { try { vdm.IsWindowOnCurrentVirtualDesktop(h, out onCur); Guid g; if (vdm.GetWindowDesktopId(h, out g) == 0) deskId = g.ToString(); } catch (Exception) { } }
      StringBuilder sb = new StringBuilder();
      sb.Append("{\"hwnd\":").Append(h.ToInt64());
      sb.Append(",\"pid\":").Append(pid);
      sb.Append(",\"process\":").Append(FaJson.Str(ProcName(pid)));
      sb.Append(",\"title\":").Append(FaJson.Str(title));
      sb.Append(",\"class\":").Append(FaJson.Str(Cls(h)));
      sb.Append(",\"rect\":").Append(FaJson.Rect(cp.X, cp.Y, cr.Right - cr.Left, cr.Bottom - cr.Top));
      sb.Append(",\"frame\":").Append(RectJson(frame));
      sb.Append(",\"outer\":").Append(RectJson(outer));
      sb.Append(",\"visible\":").Append(FaJson.Bool(visible));
      sb.Append(",\"minimized\":").Append(FaJson.Bool(IsIconic(h)));
      sb.Append(",\"maximized\":").Append(FaJson.Bool(IsZoomed(h)));
      sb.Append(",\"focused\":").Append(FaJson.Bool(h == fg));
      sb.Append(",\"enabled\":").Append(FaJson.Bool(IsWindowEnabled(h)));
      sb.Append(",\"cloaked\":").Append(cloaked);
      sb.Append(",\"owned\":").Append(FaJson.Bool(owned));
      sb.Append(",\"type\":").Append(FaJson.Str(type));
      sb.Append(",\"index\":").Append(myZ);
      sb.Append(",\"onCurrentDesktop\":").Append(FaJson.Bool(onCur));
      sb.Append(",\"desktopId\":").Append(FaJson.Str(deskId));
      sb.Append("}");
      items.Add(sb.ToString());
      return true;
    }, IntPtr.Zero);
    return "{\"ok\":true,\"foreground\":" + fg.ToInt64() + ",\"windows\":[" + string.Join(",", items.ToArray()) + "]}";
  }

  public static string Monitors() {
    List<string> items = new List<string>();
    foreach (Screen s in Screen.AllScreens) {
      uint dx = 96, dy = 96;
      try { POINT p = new POINT(); p.X = s.Bounds.X + 1; p.Y = s.Bounds.Y + 1; IntPtr hm = MonitorFromPoint(p, 2); GetDpiForMonitor(hm, 0, out dx, out dy); } catch (Exception) { }
      items.Add("{\"name\":" + FaJson.Str(s.DeviceName) + ",\"primary\":" + FaJson.Bool(s.Primary) + ",\"rect\":" + FaJson.Rect(s.Bounds.X, s.Bounds.Y, s.Bounds.Width, s.Bounds.Height) + ",\"work\":" + FaJson.Rect(s.WorkingArea.X, s.WorkingArea.Y, s.WorkingArea.Width, s.WorkingArea.Height) + ",\"dpi\":" + dx + ",\"scale\":" + (dx / 96.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "}");
    }
    return "{\"ok\":true,\"monitors\":[" + string.Join(",", items.ToArray()) + "]}";
  }

  public static string Action(long hwnd, string action, int x, int y, int w, int h) {
    IntPtr hh = new IntPtr(hwnd);
    switch (action) {
      case "focus":
        if (IsIconic(hh)) ShowWindow(hh, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // 輕點 Alt，繞過前景鎖定
        return SetForegroundWindow(hh) ? "{\"ok\":true}" : FaJson.Err("SetForegroundWindow 失敗（前景鎖定？）");
      case "minimize": ShowWindow(hh, 6); return "{\"ok\":true}";
      case "maximize": ShowWindow(hh, 3); return "{\"ok\":true}";
      case "restore": ShowWindow(hh, 9); return "{\"ok\":true}";
      case "close": return PostMessage(hh, 0x10, IntPtr.Zero, IntPtr.Zero) ? "{\"ok\":true}" : FaJson.Err("PostMessage WM_CLOSE 失敗");
      case "move":
      case "resize": {
        RECT outer; GetWindowRect(hh, out outer);
        RECT frame; bool ok = false;
        try { ok = DwmGetWindowAttribute(hh, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0; } catch (Exception) { frame = outer; }
        if (!ok) frame = outer;
        // 看得見的外框跟 GetWindowRect 差一圈隱形邊框：用差值換算，讓「可見外框」落在要的位置與大小
        int offL = frame.Left - outer.Left, offT = frame.Top - outer.Top, offR = outer.Right - frame.Right, offB = outer.Bottom - frame.Bottom;
        int nx = action == "move" ? x : frame.Left, ny = action == "move" ? y : frame.Top;
        int nw = action == "resize" ? w : frame.Right - frame.Left, nh = action == "resize" ? h : frame.Bottom - frame.Top;
        bool r = MoveWindow(hh, nx - offL, ny - offT, nw + offL + offR, nh + offT + offB, true);
        return r ? "{\"ok\":true}" : FaJson.Err("MoveWindow 失敗");
      }
    }
    return FaJson.Err("不認得的視窗動作 " + action);
  }

  // Win32 子視窗樹（類別、文字、矩形）
  public static string ChildTree(long hwnd, int depth, int budget) {
    int[] left = new int[] { budget };
    bool[] trunc = new bool[] { false };
    string t = Child(new IntPtr(hwnd), depth, left, trunc, "0");
    return "{\"ok\":true,\"truncated\":" + FaJson.Bool(trunc[0]) + ",\"root\":" + t + "}";
  }
  static string Child(IntPtr h, int depth, int[] left, bool[] trunc, string path) {
    left[0]--;
    RECT r; GetWindowRect(h, out r);
    StringBuilder sb = new StringBuilder();
    sb.Append("{\"hwnd\":").Append(h.ToInt64()).Append(",\"path\":").Append(FaJson.Str(path));
    sb.Append(",\"class\":").Append(FaJson.Str(Cls(h))).Append(",\"text\":").Append(FaJson.Str(Text(h)));
    sb.Append(",\"ctrlId\":").Append(GetDlgCtrlID(h)).Append(",\"rect\":").Append(RectJson(r));
    sb.Append(",\"visible\":").Append(FaJson.Bool(IsWindowVisible(h))).Append(",\"enabled\":").Append(FaJson.Bool(IsWindowEnabled(h)));
    if (depth > 0) {
      List<string> kids = new List<string>();
      IntPtr c = GetWindow(h, 5); int i = 0;
      while (c != IntPtr.Zero) {
        if (left[0] <= 0) { trunc[0] = true; break; }
        kids.Add(Child(c, depth - 1, left, trunc, path + "." + i));
        i++; c = GetWindow(c, 2);
      }
      sb.Append(",\"children\":[").Append(string.Join(",", kids.ToArray())).Append("]");
    }
    sb.Append("}");
    return sb.ToString();
  }
  public static string Foreground() { return "{\"ok\":true,\"hwnd\":" + GetForegroundWindow().ToInt64() + "}"; }
}
`;

const CS_INPUT = String.raw`
public static class FaInput {
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr inst, IntPtr name);

  // 目前的游標形狀：跟系統標準游標（IDC_*）比對 handle，不在標準清單裡的叫 custom（用 handle 值判斷「有沒有變」）
  public static string CursorShape() {
    CURSORINFO ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci)) return FaJson.Err("GetCursorInfo 失敗");
    int[] ids = new int[] { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651 };
    string[] names = new string[] { "arrow", "ibeam", "wait", "cross", "uparrow", "sizenwse", "sizenesw", "sizewe", "sizens", "sizeall", "no", "hand", "appstarting", "help" };
    string name = "custom";
    for (int i = 0; i < ids.Length; i++) { if (LoadCursor(IntPtr.Zero, new IntPtr(ids[i])) == ci.hCursor) { name = names[i]; break; } }
    return "{\"ok\":true,\"name\":" + FaJson.Str(name) + ",\"handle\":" + ci.hCursor.ToInt64() + ",\"visible\":" + FaJson.Bool((ci.flags & 1) != 0) + ",\"x\":" + ci.pt.X + ",\"y\":" + ci.pt.Y + "}";
  }

  static void Send(params INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static bool Ext(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F; }
  static void Sleep(int ms) { if (ms > 0) Thread.Sleep(ms); }

  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static string Where() { POINT p; GetCursorPos(out p); return "{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}"; }

  // button：1=左 2=中 3=右
  static void Down(int b) { Send(Mouse(b == 3 ? 0x8u : b == 2 ? 0x20u : 0x2u, 0)); }
  static void Up(int b) { Send(Mouse(b == 3 ? 0x10u : b == 2 ? 0x40u : 0x4u, 0)); }
  public static void Click(int x, int y, int button, int count) {
    SetCursorPos(x, y); Sleep(40);
    for (int i = 0; i < count; i++) { Down(button); Sleep(35); Up(button); if (i < count - 1) Sleep(60); }
  }
  public static void Drag(int x, int y, int x2, int y2, int button, int steps) {
    SetCursorPos(x, y); Sleep(60); Down(button); Sleep(100);
    for (int i = 1; i <= steps; i++) { SetCursorPos(x + (x2 - x) * i / steps, y + (y2 - y) * i / steps); Sleep(15); }
    Sleep(80); Up(button);
  }
  // 正 dy＝往下捲（滾輪向使用者，delta 為負）；正 dx＝往右
  public static void Wheel(int x, int y, int dx, int dy) {
    SetCursorPos(x, y); Sleep(30);
    if (dy != 0) Send(Mouse(0x800u, -120 * dy));
    if (dx != 0) Send(Mouse(0x1000u, 120 * dx));
  }
  public static void Chord(int[] vks) {
    foreach (int vk in vks) { Send(Key((ushort)vk, 0, Ext(vk) ? 1u : 0u)); Sleep(10); }
    for (int i = vks.Length - 1; i >= 0; i--) { Send(Key((ushort)vks[i], 0, (Ext(vks[i]) ? 1u : 0u) | 2u)); Sleep(10); }
  }
  // Unicode 文字：每個 UTF-16 單元用 KEYEVENTF_UNICODE 送（中文、emoji 代理對都行）；換行＝Enter、Tab＝Tab
  public static void TypeText(string s, int delayMs) {
    foreach (char c in s) {
      if (c == '\n') { Chord(new int[] { 0x0D }); Sleep(delayMs); continue; }
      if (c == '\r') continue;
      if (c == '\t') { Chord(new int[] { 0x09 }); Sleep(delayMs); continue; }
      Send(Key(0, c, 4u)); Send(Key(0, c, 4u | 2u)); Sleep(delayMs);
    }
  }
  // 中止時：放開滑鼠鍵與修飾鍵
  public static void ReleaseAll() {
    Send(Mouse(0x4u, 0), Mouse(0x10u, 0), Mouse(0x40u, 0));
    foreach (int vk in new int[] { 0x10, 0xA0, 0xA1, 0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x5B, 0x5C }) Send(Key((ushort)vk, 0, (Ext(vk) ? 1u : 0u) | 2u));
  }
}
`;

const CS_SHOT = String.raw`
public static class FaShot {
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Screen(int x, int y, int w, int h) { return Grab(x, y, w, h, 0); }
  // hwnd<>0：用 PrintWindow（PW_RENDERFULLCONTENT）抓整個視窗外框，被別的視窗蓋住也抓得到；座標是 GetWindowRect 的範圍
  public static string Window(long hwnd) {
    RECT r; if (!GetWindowRect(new IntPtr(hwnd), out r)) return FaJson.Err("GetWindowRect 失敗");
    return Grab(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, hwnd);
  }
  static string Grab(int x, int y, int w, int h, long hwnd) {
    if (w <= 0 || h <= 0) return FaJson.Err("範圍大小為 0");
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bmp)) {
        bool done = false;
        if (hwnd != 0) { IntPtr hdc = g.GetHdc(); try { done = PrintWindow(new IntPtr(hwnd), hdc, 2); } finally { g.ReleaseHdc(hdc); } }
        if (!done) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      }
      using (MemoryStream ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        return "{\"ok\":true,\"width\":" + w + ",\"height\":" + h + ",\"origin\":{\"x\":" + x + ",\"y\":" + y + "},\"base64\":\"" + Convert.ToBase64String(ms.ToArray()) + "\"}";
      }
    }
  }
}
`;

// ---------- UI Automation（System.Windows.Automation；等同 Windows 上的 Spy++／Inspect） ----------
const CS_UIA_USINGS = String.raw`
using System.Windows.Automation;
`;
const CS_UIA = String.raw`
public static class FaUia {
  static string ControlTypeName(AutomationElement e) { try { return e.Current.ControlType.ProgrammaticName; } catch (Exception) { return "ControlType.Custom"; } }
  static string Fp(AutomationElement e) {
    try { return FaJson.Fnv(ControlTypeName(e) + "|" + e.Current.AutomationId + "|" + e.Current.Name); } catch (Exception) { return "000000"; }
  }
  static string PatternNames(AutomationElement e) {
    List<string> l = new List<string>();
    try { foreach (AutomationPattern p in e.GetSupportedPatterns()) l.Add(FaJson.Str(p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", ""))); } catch (Exception) { }
    return "[" + string.Join(",", l.ToArray()) + "]";
  }
  static string Node(AutomationElement e, string path, long hwnd, bool withChildren, int depth, int[] budget, bool[] trunc, bool onlyVisible, TreeWalker walker) {
    budget[0]--;
    string name = "", aid = "", cls = "", fw = ""; bool enabled = true, offscreen = false, focus = false, isPwd = false; System.Windows.Rect br = System.Windows.Rect.Empty; int pid = 0;
    try { AutomationElement.AutomationElementInformation c = e.Current; name = c.Name; aid = c.AutomationId; cls = c.ClassName; fw = c.FrameworkId; enabled = c.IsEnabled; offscreen = c.IsOffscreen; focus = c.HasKeyboardFocus; isPwd = c.IsPassword; br = c.BoundingRectangle; pid = c.ProcessId; } catch (Exception) { }
    StringBuilder sb = new StringBuilder();
    sb.Append("{\"path\":").Append(FaJson.Str(path)).Append(",\"fp\":").Append(FaJson.Str(Fp(e)));
    sb.Append(",\"controlType\":").Append(FaJson.Str(ControlTypeName(e)));
    sb.Append(",\"name\":").Append(FaJson.Str(name)).Append(",\"automationId\":").Append(FaJson.Str(aid)).Append(",\"className\":").Append(FaJson.Str(cls)).Append(",\"framework\":").Append(FaJson.Str(fw));
    if (br.IsEmpty || double.IsInfinity(br.Width) || double.IsInfinity(br.X)) sb.Append(",\"rect\":null");
    else sb.Append(",\"rect\":").Append(FaJson.Rect((int)br.X, (int)br.Y, (int)br.Width, (int)br.Height));
    sb.Append(",\"enabled\":").Append(FaJson.Bool(enabled)).Append(",\"offscreen\":").Append(FaJson.Bool(offscreen)).Append(",\"focused\":").Append(FaJson.Bool(focus)).Append(",\"isPassword\":").Append(FaJson.Bool(isPwd)).Append(",\"pid\":").Append(pid);
    sb.Append(",\"patterns\":").Append(PatternNames(e));
    object po;
    if (!isPwd && e.TryGetCurrentPattern(ValuePattern.Pattern, out po)) { try { string v = ((ValuePattern)po).Current.Value; sb.Append(",\"value\":").Append(FaJson.Str(v == null ? null : (v.Length > 400 ? v.Substring(0, 400) : v))); } catch (Exception) { } }
    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out po)) { try { sb.Append(",\"toggle\":").Append(FaJson.Str(((TogglePattern)po).Current.ToggleState.ToString())); } catch (Exception) { } }
    if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out po)) { try { sb.Append(",\"selected\":").Append(FaJson.Bool(((SelectionItemPattern)po).Current.IsSelected)); } catch (Exception) { } }
    if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out po)) { try { sb.Append(",\"expand\":").Append(FaJson.Str(((ExpandCollapsePattern)po).Current.ExpandCollapseState.ToString())); } catch (Exception) { } }
    if (withChildren && depth > 0) {
      List<string> kids = new List<string>();
      AutomationElement c = null;
      try { c = walker.GetFirstChild(e); } catch (Exception) { }
      int i = 0;
      while (c != null) {
        if (budget[0] <= 0) { trunc[0] = true; break; }
        bool skip = false;
        if (onlyVisible) { try { skip = c.Current.IsOffscreen; } catch (Exception) { } }
        if (!skip) kids.Add(Node(c, path + "." + i, hwnd, true, depth - 1, budget, trunc, onlyVisible, walker));
        i++;
        try { c = walker.GetNextSibling(c); } catch (Exception) { c = null; }
      }
      sb.Append(",\"children\":[").Append(string.Join(",", kids.ToArray())).Append("]");
    } else if (withChildren) { try { if (walker.GetFirstChild(e) != null) sb.Append(",\"hasChildren\":true"); } catch (Exception) { } }
    sb.Append("}");
    return sb.ToString();
  }
  // 視窗的 UIA 樹。path 以 "0" 為視窗根，子節點為 "0.i.j…"（i 是 ControlView 兄弟順序）
  public static string Tree(long hwnd, int depth, int maxNodes, bool onlyVisible, bool raw) {
    AutomationElement root;
    try { root = AutomationElement.FromHandle(new IntPtr(hwnd)); } catch (Exception ex) { return FaJson.Err("FromHandle：" + ex.Message); }
    if (root == null) return FaJson.Err("找不到視窗的 UIA 元素");
    int[] budget = new int[] { maxNodes }; bool[] trunc = new bool[] { false };
    string t = Node(root, "0", hwnd, true, depth, budget, trunc, onlyVisible, raw ? TreeWalker.RawViewWalker : TreeWalker.ControlViewWalker);
    return "{\"ok\":true,\"hwnd\":" + hwnd + ",\"truncated\":" + FaJson.Bool(trunc[0]) + ",\"root\":" + t + "}";
  }
  public static string FromPoint(int x, int y) {
    try {
      AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      if (e == null) return "{\"ok\":true,\"element\":null}";
      int[] b = new int[] { 1 }; bool[] t = new bool[] { false };
      return "{\"ok\":true,\"hwnd\":" + e.Current.NativeWindowHandle + ",\"element\":" + Node(e, "", 0, false, 0, b, t, false, TreeWalker.ControlViewWalker) + "}";
    } catch (Exception ex) { return FaJson.Err(ex.Message); }
  }
  // 焦點元件（檢查是不是密碼欄用）
  public static string Focused() {
    try {
      AutomationElement e = AutomationElement.FocusedElement;
      if (e == null) return "{\"ok\":true,\"known\":false,\"element\":null}";
      int[] b = new int[] { 1 }; bool[] t = new bool[] { false };
      return "{\"ok\":true,\"known\":true,\"element\":" + Node(e, "", 0, false, 0, b, t, false, TreeWalker.ControlViewWalker) + "}";
    } catch (Exception ex) { return "{\"ok\":true,\"known\":false,\"element\":null,\"reason\":" + FaJson.Str(ex.Message) + "}"; }
  }
  static AutomationElement Resolve(long hwnd, string path, string fp) {
    AutomationElement cur = AutomationElement.FromHandle(new IntPtr(hwnd));
    string[] parts = path.Split('.');
    TreeWalker w = TreeWalker.ControlViewWalker;
    bool ok = true;
    for (int k = 1; k < parts.Length; k++) {
      int idx = int.Parse(parts[k]);
      AutomationElement c = w.GetFirstChild(cur);
      for (int i = 0; i < idx && c != null; i++) c = w.GetNextSibling(c);
      if (c == null) { ok = false; break; }
      cur = c;
    }
    if (ok && Fp(cur) == fp) return cur;
    // 路徑對不上：廣度優先找指紋相同的（最多 4000 個節點）
    Queue<AutomationElement> q = new Queue<AutomationElement>();
    q.Enqueue(AutomationElement.FromHandle(new IntPtr(hwnd)));
    int n = 0;
    while (q.Count > 0 && n < 4000) {
      AutomationElement e = q.Dequeue(); n++;
      if (Fp(e) == fp) return e;
      AutomationElement c = w.GetFirstChild(e);
      while (c != null) { q.Enqueue(c); c = w.GetNextSibling(c); }
    }
    return null;
  }
  // action：invoke | toggle | select | focus | set_value | expand | collapse
  public static string Act(long hwnd, string path, string fp, string action, string value) {
    AutomationElement e;
    try { e = Resolve(hwnd, path, fp); } catch (Exception ex) { return FaJson.Err("解析元件失敗：" + ex.Message); }
    if (e == null) return FaJson.Err("元件已經不在了（路徑與指紋都對不上）");
    object po;
    try {
      if (!e.Current.IsEnabled) return FaJson.Err("元件目前是停用的（IsEnabled=false）");
      switch (action) {
        case "invoke":
          if (e.TryGetCurrentPattern(InvokePattern.Pattern, out po)) { ((InvokePattern)po).Invoke(); return "{\"ok\":true,\"did\":\"Invoke\"}"; }
          if (e.TryGetCurrentPattern(TogglePattern.Pattern, out po)) { ((TogglePattern)po).Toggle(); return "{\"ok\":true,\"did\":\"Toggle\"}"; }
          if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out po)) { ((SelectionItemPattern)po).Select(); return "{\"ok\":true,\"did\":\"Select\"}"; }
          return FaJson.Err("這個元件沒有 Invoke／Toggle／SelectionItem 模式");
        case "toggle":
          if (e.TryGetCurrentPattern(TogglePattern.Pattern, out po)) { ((TogglePattern)po).Toggle(); return "{\"ok\":true,\"did\":\"Toggle\"}"; }
          return FaJson.Err("這個元件沒有 Toggle 模式");
        case "select":
          if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out po)) { ((SelectionItemPattern)po).Select(); return "{\"ok\":true,\"did\":\"Select\"}"; }
          return FaJson.Err("這個元件沒有 SelectionItem 模式");
        case "focus": e.SetFocus(); return "{\"ok\":true,\"did\":\"SetFocus\"}";
        case "expand":
          if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out po)) { ((ExpandCollapsePattern)po).Expand(); return "{\"ok\":true,\"did\":\"Expand\"}"; }
          return FaJson.Err("這個元件沒有 ExpandCollapse 模式");
        case "collapse":
          if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out po)) { ((ExpandCollapsePattern)po).Collapse(); return "{\"ok\":true,\"did\":\"Collapse\"}"; }
          return FaJson.Err("這個元件沒有 ExpandCollapse 模式");
        case "set_value":
          if (e.Current.IsPassword) return FaJson.Err("不在密碼欄輸入文字");
          if (e.TryGetCurrentPattern(ValuePattern.Pattern, out po)) {
            ValuePattern vp = (ValuePattern)po;
            if (vp.Current.IsReadOnly) return FaJson.Err("元件是唯讀的");
            vp.SetValue(value); return "{\"ok\":true,\"did\":\"SetValue\"}";
          }
          return FaJson.Err("這個元件沒有 Value 模式");
      }
    } catch (Exception ex) { return FaJson.Err(action + " 失敗：" + ex.Message); }
    return FaJson.Err("不認得的動作 " + action);
  }
}
`;

const CS_ALL = CS_USINGS + CS_UIA_USINGS + CS_BASE + CS_WIN + CS_INPUT + CS_SHOT + CS_UIA;
// 只含 user32／GDI 的部分（不需要 UIAutomation 組件；mcs 可編譯檢查）
const CS_NO_UIA = CS_USINGS + CS_BASE + CS_WIN + CS_INPUT + CS_SHOT;

module.exports = { CS_USINGS, CS_UIA_USINGS, CS_BASE, CS_WIN, CS_INPUT, CS_SHOT, CS_UIA, CS_ALL, CS_NO_UIA };
