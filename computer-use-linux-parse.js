// computer-use-linux-parse.js —— Linux 後端的純函式：桌面環境偵測、各工具輸出的解析、按鍵對照、截圖指令、能力矩陣。
// 全部不碰系統（輸入是字串或 table），所以可以用 fixture 測試；Wayland／GNOME／KDE 那些這台機器跑不了的路徑，
// 解析器是依各工具的文件輸出格式寫的，標示「未實測」，只有 fixture 測試。
"use strict";

// ---------- 桌面環境 ----------
// env：XDG_SESSION_TYPE、XDG_CURRENT_DESKTOP、WAYLAND_DISPLAY、DISPLAY、DESKTOP_SESSION
function detectSession(env) {
  env = env || {};
  const xdgType = String(env.XDG_SESSION_TYPE || "").toLowerCase(), wl = String(env.WAYLAND_DISPLAY || ""), disp = String(env.DISPLAY || "");
  const cur = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "").toLowerCase();
  let desktop = "other";
  if (/xfce/.test(cur)) desktop = "xfce"; else if (/kde|plasma/.test(cur)) desktop = "kde"; else if (/gnome|unity|ubuntu|budgie|pantheon/.test(cur) && !/xfce|kde/.test(cur)) desktop = "gnome";
  else if (/cinnamon/.test(cur)) desktop = "cinnamon"; else if (/mate/.test(cur)) desktop = "mate"; else if (/lxqt/.test(cur)) desktop = "lxqt"; else if (/lxde/.test(cur)) desktop = "lxde";
  else if (/sway|hyprland|wayfire|river|labwc/.test(cur)) desktop = "wlroots"; else if (!cur) desktop = "unknown";
  let type = "unknown";
  if (xdgType === "wayland" || (wl && xdgType !== "x11")) type = "wayland"; else if (xdgType === "x11" || disp) type = "x11"; else if (xdgType === "tty") type = "tty";
  // Wayland 工作階段但有 DISPLAY＝XWayland：X 工具只對 XWayland 的用戶端有效
  const xwayland = type === "wayland" && !!disp;
  return { type, desktop, rawDesktop: String(env.XDG_CURRENT_DESKTOP || ""), display: disp, waylandDisplay: wl, xwayland, hasX: !!disp, native: type === "wayland" ? "wayland" : type === "x11" ? "x11" : "none" };
}

// ---------- wmctrl -lGpx ----------
// 0x0060000c  0 89248  110  158  364  134  xterm.XTerm  host  title…
function parseWmctrl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const cls = m[8].split("."); const instance = cls.length > 1 ? cls[0] : ""; const klass = cls.length > 1 ? cls.slice(1).join(".") : cls[0];
    out.push({ id: normId(m[1]), desktop: Number(m[2]), pid: Number(m[3]), x: Number(m[4]), y: Number(m[5]), w: Number(m[6]), h: Number(m[7]), instance, class: klass, host: m[9], title: m[10] });
  }
  return out;
}
function normId(id) {
  const s = String(id == null ? "" : id).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return "0x" + s.slice(2).toLowerCase().padStart(8, "0");
  if (/^\d+$/.test(s)) return "0x" + Number(s).toString(16).padStart(8, "0");
  return s;
}

// ---------- xwininfo -root -tree（絕對座標，含巢狀；也是 X11 視窗樹的來源） ----------
//      0x800003 "T1 Entry": ("zenity" "Zenity")  194x122+5+29  +548+368
function parseXwininfoTree(text) {
  const out = [], re = /^(\s*)(0x[0-9a-fA-F]+) (?:"((?:[^"\\]|\\.)*)"|\(has no name\)): \((?:"([^"]*)" "([^"]*)")?\)\s+(\d+)x(\d+)([+-]\d+)([+-]\d+)\s+([+-]\d+)([+-]\d+)\s*$/;
  for (const line of String(text || "").split("\n")) {
    const m = re.exec(line); if (!m) continue;
    const depth = Math.max(0, Math.round((m[1].length - 5) / 3));
    out.push({ id: normId(m[2]), depth, name: m[3] == null ? "" : m[3].replace(/\\(.)/g, "$1"), instance: m[4] || "", class: m[5] || "", w: Number(m[6]), h: Number(m[7]), relX: Number(m[8]), relY: Number(m[9]), x: Number(m[10]), y: Number(m[11]) });
  }
  return out;
}
// 把平面的 depth 清單還原成巢狀樹
function nestXwininfo(list) {
  const root = { children: [], depth: -1 }, stack = [root];
  for (const n of list) { const node = Object.assign({}, n, { children: [] }); while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop(); (stack[stack.length - 1] || root).children.push(node); stack.push(node); }
  return root.children;
}
// xwininfo -id：Absolute upper-left X／Y、Width、Height、Map State
function parseXwininfoId(text) {
  const g = (re) => { const m = re.exec(text || ""); return m ? Number(m[1]) : null; };
  const x = g(/Absolute upper-left X:\s+(-?\d+)/), y = g(/Absolute upper-left Y:\s+(-?\d+)/), w = g(/Width:\s+(\d+)/), h = g(/Height:\s+(\d+)/);
  const map = /Map State:\s+(\w+)/.exec(text || "");
  return x == null ? null : { x, y, w, h, mapState: map ? map[1] : "" };
}

// ---------- xprop ----------
function parseXprop(text) {
  const t = String(text || ""), out = { state: [], type: [], frame: null, pid: null, wmClass: [], desktop: null };
  const st = /_NET_WM_STATE(?:\(ATOM\))?[ \t]*=[ \t]*(.*)/.exec(t); if (st && st[1].trim()) out.state = st[1].split(",").map((s) => s.trim().replace(/^_NET_WM_STATE_/, "").toLowerCase()).filter(Boolean);
  const ty = /_NET_WM_WINDOW_TYPE(?:\(ATOM\))?[ \t]*=[ \t]*(.*)/.exec(t); if (ty && ty[1].trim()) out.type = ty[1].split(",").map((s) => s.trim().replace(/^_NET_WM_WINDOW_TYPE_/, "").toLowerCase()).filter(Boolean);
  const fe = /_NET_FRAME_EXTENTS(?:\(CARDINAL\))?\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(t); if (fe) out.frame = { left: +fe[1], right: +fe[2], top: +fe[3], bottom: +fe[4] };
  const gf = /_GTK_FRAME_EXTENTS(?:\(CARDINAL\))?\s*=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(t); if (gf) out.gtkFrame = { left: +gf[1], right: +gf[2], top: +gf[3], bottom: +gf[4] };
  const pid = /_NET_WM_PID(?:\(CARDINAL\))?\s*=\s*(\d+)/.exec(t); if (pid) out.pid = Number(pid[1]);
  const cl = /WM_CLASS(?:\(STRING\))?\s*=\s*"([^"]*)",\s*"([^"]*)"/.exec(t); if (cl) out.wmClass = [cl[1], cl[2]];
  const dk = /_NET_WM_DESKTOP(?:\(CARDINAL\))?\s*=\s*(\d+)/.exec(t); if (dk) out.desktop = Number(dk[1]);
  return out;
}
function parseXpropWindowList(text) { const m = /#\s*(.*)$/m.exec(String(text || "")); return m ? m[1].split(",").map((s) => normId(s.trim())).filter((s) => /^0x/.test(s) && s !== "0x00000000") : []; }
function parseXpropRoot(text) {
  const t = String(text || ""), g = (re) => { const m = re.exec(t); return m ? m[1] : null; };
  const wa = /_NET_WORKAREA(?:\(CARDINAL\))?\s*=\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(t);
  return { stacking: parseXpropWindowList((/_NET_CLIENT_LIST_STACKING[^\n]*\n?/.exec(t) || [""])[0]), currentDesktop: g(/_NET_CURRENT_DESKTOP(?:\(CARDINAL\))?\s*=\s*(\d+)/) == null ? null : Number(g(/_NET_CURRENT_DESKTOP(?:\(CARDINAL\))?\s*=\s*(\d+)/)), desktops: g(/_NET_NUMBER_OF_DESKTOPS(?:\(CARDINAL\))?\s*=\s*(\d+)/) == null ? null : Number(g(/_NET_NUMBER_OF_DESKTOPS(?:\(CARDINAL\))?\s*=\s*(\d+)/)), active: (() => { const m = /_NET_ACTIVE_WINDOW(?:\(WINDOW\))?:\s*window id #\s*(0x[0-9a-f]+)/i.exec(t); return m ? normId(m[1]) : null; })(), workarea: wa ? { x: +wa[1], y: +wa[2], w: +wa[3], h: +wa[4] } : null };
}

// ---------- xrandr --query ----------
// HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 527mm x 296mm
function parseXrandr(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(\S+) connected(?: (primary))? (\d+)x(\d+)\+(-?\d+)\+(-?\d+)(?: \([^)]*\))?(?: (?:normal|left|right|inverted))?(?: \([^)]*\))?\s*(?:(\d+)mm x (\d+)mm)?/.exec(line);
    if (!m) continue;
    const w = Number(m[3]), h = Number(m[4]), mmW = m[7] ? Number(m[7]) : 0, mmH = m[8] ? Number(m[8]) : 0;
    out.push({ name: m[1], primary: !!m[2], rect: { x: Number(m[5]), y: Number(m[6]), w, h }, mm: mmW ? { w: mmW, h: mmH } : null, dpi: mmW ? Math.round((w / mmW) * 25.4) : null });
  }
  if (out.length && !out.some((o) => o.primary)) out[0].primary = true;
  return out;
}
function parseXrdbDpi(text) { const m = /Xft\.dpi:\s*(\d+(?:\.\d+)?)/.exec(String(text || "")); return m ? Number(m[1]) : null; }
function parseMouseLocation(text) { const g = (k) => { const m = new RegExp("^" + k + "=(-?\\d+)", "m").exec(String(text || "")); return m ? Number(m[1]) : null; }; const x = g("X"), y = g("Y"); return x == null ? null : { x, y, screen: g("SCREEN"), window: g("WINDOW") == null ? null : normId(String(g("WINDOW"))) }; }

// ---------- KDE：kdotool（未實測；格式依 kdotool README） ----------
function parseKdotoolGeometry(text) {
  const p = /Position:\s*(-?\d+),\s*(-?\d+)/.exec(text || ""), g = /Geometry:\s*(\d+)x(\d+)/.exec(text || "");
  return p && g ? { x: Number(p[1]), y: Number(p[2]), w: Number(g[1]), h: Number(g[2]) } : null;
}
const parseKdotoolIds = (text) => String(text || "").split("\n").map((s) => s.trim()).filter((s) => /^\{?[0-9a-f-]{8,}\}?$/i.test(s));

// ---------- GNOME：Window Calls 擴充（org.gnome.Shell.Extensions.Windows）與 Shell.Eval（未實測） ----------
// gdbus 輸出是 GVariant 文字：('[{"id":1,...}]',)；Shell.Eval 是 (true, '[...]')
function unwrapGVariantString(text) {
  const t = String(text || "").trim(); let m = /^\((?:true|false),\s*'([\s\S]*)'\s*\)$/.exec(t) || /^\(\s*'([\s\S]*)'\s*,?\s*\)$/.exec(t) || /^\(\s*"([\s\S]*)"\s*,?\s*\)$/.exec(t);
  if (!m) return null;
  return m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function parseGnomeWindowsJson(text) {
  const s = unwrapGVariantString(text); if (s == null) return null;
  let arr; try { arr = JSON.parse(s); } catch (_) { return null; } if (!Array.isArray(arr)) return null;
  return arr.map((w) => ({ id: String(w.id), title: String(w.title || ""), class: String(w.wm_class || w.cls || ""), instance: String(w.wm_class_instance || ""), pid: w.pid == null ? null : Number(w.pid), x: w.x == null ? null : Number(w.x), y: w.y == null ? null : Number(w.y), w: w.width != null ? Number(w.width) : (w.w != null ? Number(w.w) : null), h: w.height != null ? Number(w.height) : (w.h != null ? Number(w.h) : null), minimized: !!(w.minimized || w.min), focused: !!(w.focus || w.has_focus), workspace: w.workspace == null ? null : Number(w.workspace), inCurrentWorkspace: w.in_current_workspace !== false }));
}
const GNOME_EVAL_LIST = "JSON.stringify(global.get_window_actors().map(a=>{let w=a.meta_window,r=w.get_frame_rect();return{id:w.get_id(),title:w.get_title(),cls:w.get_wm_class(),pid:w.get_pid(),x:r.x,y:r.y,w:r.width,h:r.height,min:w.minimized,focus:w.has_focus()}}))";

// ---------- 按鍵對照 ----------
const XK = { return: "Return", escape: "Escape", tab: "Tab", backspace: "BackSpace", delete: "Delete", insert: "Insert", home: "Home", end: "End", prior: "Prior", next: "Next", up: "Up", down: "Down", left: "Left", right: "Right", space: "space", menu: "Menu", print: "Print", pause: "Pause", plus: "plus", minus: "minus", comma: "comma", period: "period", slash: "slash", backslash: "backslash", equal: "equal", semicolon: "semicolon", apostrophe: "apostrophe", grave: "grave", bracketleft: "bracketleft", bracketright: "bracketright", caps_lock: "Caps_Lock", capslock: "Caps_Lock", num_lock: "Num_Lock", scroll_lock: "Scroll_Lock", kp_enter: "KP_Enter", page_up: "Prior", page_down: "Next" };
const XMOD = { ctrl: "ctrl", alt: "alt", shift: "shift", super: "super" };
// 正規化後的 chord（見 computer-use-safety.normalizeChord）→ xdotool key 的參數
function chordToXdotool(chord) {
  const parts = String(chord).split("+").filter(Boolean); if (!parts.length) return null;
  return parts.map((p) => { if (XMOD[p]) return XMOD[p]; if (XK[p]) return XK[p]; if (/^f([1-9]|1\d|2[0-4])$/.test(p)) return p.toUpperCase(); if (/^kp_/.test(p)) return "KP_" + p.slice(3); if (/^[a-z0-9]$/.test(p)) return p; if (/^[^\x00-\x7f]$/.test(p)) return p; return null; }).filter((x) => x !== null).join("+") || null;
}
// Linux input-event-codes（ydotool key 用；格式 code:1 按下、code:0 放開）
const EVDEV = { esc: 1, escape: 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11, minus: 12, equal: 13, backspace: 14, tab: 15, q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, bracketleft: 26, bracketright: 27, return: 28, ctrl: 29, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, semicolon: 39, apostrophe: 40, grave: 41, shift: 42, backslash: 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, comma: 51, period: 52, slash: 53, alt: 56, space: 57, caps_lock: 58, f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88, home: 102, up: 103, prior: 104, left: 105, right: 106, end: 107, down: 108, next: 109, insert: 110, delete: 111, super: 125, menu: 127 };
function chordToYdotool(chord) {
  const parts = String(chord).split("+").filter(Boolean), codes = parts.map((p) => EVDEV[p === "plus" ? "equal" : p]); if (!codes.length || codes.some((c) => c == null)) return null;
  const down = codes.map((c) => c + ":1"), up = codes.slice().reverse().map((c) => c + ":0"); return down.concat(up);
}
// wtype：修飾鍵用 -M／-m，按鍵用 -k（XKB 名稱）
function chordToWtype(chord) {
  const parts = String(chord).split("+").filter(Boolean), mods = parts.filter((p) => XMOD[p] && parts.indexOf(p) < parts.length - 1), key = parts[parts.length - 1]; if (!key) return null;
  const wmod = { ctrl: "ctrl", alt: "alt", shift: "shift", super: "logo" }, args = [];
  for (const m of mods) args.push("-M", wmod[m]);
  const name = XK[key] || (/^f\d+$/.test(key) ? key.toUpperCase() : key); args.push("-k", name);
  for (const m of mods.slice().reverse()) args.push("-m", wmod[m]); return args;
}

// ---------- 截圖指令（回傳 {cmd, args}；file 是輸出 PNG 路徑） ----------
// 一律抓整個螢幕再自己裁切（行為在各工具之間一致）；pointer＝要不要畫上游標（偵測游標形狀用）
function screenshotCommand(tool, o) {
  const file = o.file;
  switch (tool) {
    case "scrot": return { cmd: "scrot", args: ["-o", ...(o.pointer ? ["-p"] : []), file] };
    case "import": return { cmd: "import", args: ["-window", "root", "png:" + file] };
    case "xwd": return { cmd: "xwd", args: ["-root", "-silent", "-out", file], format: "xwd" };
    case "grim": return { cmd: "grim", args: [...(o.pointer ? ["-c"] : []), "-t", "png", file] };
    case "spectacle": return { cmd: "spectacle", args: ["-b", "-n", "-f", ...(o.pointer ? ["-p"] : []), "-o", file] };
    case "gnome-screenshot": return { cmd: "gnome-screenshot", args: [...(o.pointer ? ["-p"] : []), "-f", file] };
    case "xfce4-screenshooter": return { cmd: "xfce4-screenshooter", args: ["-f", ...(o.pointer ? ["-m"] : []), "-s", file] };
    case "maim": return { cmd: "maim", args: [...(o.pointer ? [] : ["--hidecursor"]), file] };
    default: return null;
  }
}
// 依 session 排好「優先順序」，沒有的工具會被略過
function screenshotPreference(session) {
  if (session.type === "wayland") {
    if (session.desktop === "kde") return ["spectacle", "grim", "gnome-screenshot"];
    if (session.desktop === "gnome") return ["gnome-screenshot", "grim", "spectacle"];
    return ["grim", "gnome-screenshot", "spectacle"];
  }
  return ["scrot", "import", "maim", "xwd", "xfce4-screenshooter", "gnome-screenshot", "spectacle", "grim"];
}

// ---------- XWD 解碼（xwd -root 的輸出；32／24 bpp ZPixmap，沒有 xwd 以外工具時的備案） ----------
function decodeXwd(buf) {
  if (buf.length < 100) throw new Error("XWD 太短");
  const u32 = (o) => buf.readUInt32BE(o), hdrSize = u32(0), version = u32(4), format = u32(8), w = u32(16), h = u32(20), byteOrder = u32(28), bitsPP = u32(44), bytesPerLine = u32(48), ncolors = u32(76);
  if (version !== 7) throw new Error("不支援的 XWD 版本 " + version);
  if (format !== 2) throw new Error("XWD 只支援 ZPixmap");
  const redMask = u32(56), greenMask = u32(60), blueMask = u32(64), pixOff = hdrSize + ncolors * 12, bpp = bitsPP >> 3, out = new Uint8Array(w * h * 4);
  const shift = (m) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } return s; }, rs = shift(redMask), gs = shift(greenMask), bs = shift(blueMask);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = pixOff + y * bytesPerLine + x * bpp; let v = 0;
    if (byteOrder === 0) for (let i = bpp - 1; i >= 0; i--) v = v * 256 + buf[o + i]; else for (let i = 0; i < bpp; i++) v = v * 256 + buf[o + i];
    const q = (y * w + x) * 4; out[q] = (v >>> rs) & 0xff; out[q + 1] = (v >>> gs) & 0xff; out[q + 2] = (v >>> bs) & 0xff; out[q + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

// ---------- 能力矩陣 ----------
// tools：{ name: path|"" }；probes：{ atspi, uinput, ydotoold, gnomeWindowsExt, gnomeEval, portalRemoteDesktop, kwinScripting, xwaylandClientsOnly }
const INSTALL_HINT = { xdotool: "sudo apt install xdotool", wmctrl: "sudo apt install wmctrl", xprop: "sudo apt install x11-utils", xwininfo: "sudo apt install x11-utils", scrot: "sudo apt install scrot", xclip: "sudo apt install xclip", xsel: "sudo apt install xsel", ydotool: "sudo apt install ydotool（並啟動 ydotoold、/dev/uinput 要有寫入權限）", wtype: "sudo apt install wtype（僅 wlroots 類合成器）", grim: "sudo apt install grim（wlroots）", kdotool: "cargo install kdotool（KDE Wayland）", "wl-clipboard": "sudo apt install wl-clipboard", python3: "sudo apt install python3 python3-gi gir1.2-atspi-2.0" };
function buildCapabilities(session, tools, probes) {
  tools = tools || {}; probes = probes || {}; const has = (n) => !!tools[n], f = {}, notes = [], hints = [];
  const ok = (via, extra) => Object.assign({ ok: true, via }, extra || {});
  const no = (reason, hint) => { const r = { ok: false, reason }; if (hint) r.hint = hint; return r; };
  const x11Usable = session.hasX && (session.type === "x11" || session.xwayland);
  const xOnlyXwayland = session.xwayland;
  // ----- 視窗 -----
  if (x11Usable && has("wmctrl") && has("xwininfo")) {
    const via = "wmctrl+xwininfo" + (has("xprop") ? "+xprop" : "");
    f.windows = { list: ok(via, { geometry: "screen", xwaylandOnly: xOnlyXwayland || undefined }), focus: ok(has("xdotool") ? "wmctrl/xdotool" : "wmctrl"), move: ok("wmctrl"), resize: ok("wmctrl"), minimize: has("xdotool") ? ok("xdotool") : no("缺 xdotool", INSTALL_HINT.xdotool), maximize: ok("wmctrl"), close: ok("wmctrl"), backend: "x11" };
    if (!has("xprop")) notes.push("沒有 xprop：視窗狀態（最大化／最小化）與框架範圍抓不到，z 順序也不準。");
    if (xOnlyXwayland) notes.push("這是 Wayland 工作階段，X 工具只看得到 XWayland 視窗（Electron／Chrome 的 Ozone Wayland 模式、GTK4、Qt Wayland 原生視窗看不到）。");
  } else if (session.type === "wayland" && session.desktop === "kde" && has("kdotool")) {
    f.windows = { list: ok("kdotool", { geometry: "screen", unverified: true }), focus: ok("kdotool"), move: ok("kdotool"), resize: ok("kdotool"), minimize: ok("kdotool"), maximize: ok("kdotool"), close: ok("kdotool"), backend: "kdotool" };
  } else if (session.type === "wayland" && session.desktop === "gnome" && (probes.gnomeWindowsExt || probes.gnomeEval) && has("gdbus")) {
    f.windows = { list: ok(probes.gnomeWindowsExt ? "gdbus→Window Calls 擴充" : "gdbus→Shell.Eval", { geometry: "screen", unverified: true }), focus: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("Shell.Eval 只能讀不能控制；裝 Window Calls 擴充"), move: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("需要 Window Calls 擴充"), resize: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("需要 Window Calls 擴充"), minimize: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("需要 Window Calls 擴充"), maximize: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("需要 Window Calls 擴充"), close: probes.gnomeWindowsExt ? ok("gdbus→Window Calls") : no("需要 Window Calls 擴充"), backend: "gnome" };
  } else if (probes.atspi) {
    f.windows = { list: ok("AT-SPI（只有名稱與應用程式；Wayland 下沒有螢幕座標）", { geometry: "none" }), focus: no("Wayland 不允許其他程式切換焦點" + (session.desktop === "gnome" ? "（GNOME 需 Window Calls 擴充）" : session.desktop === "kde" ? "（KDE 請裝 kdotool）" : "")), move: no("Wayland 不允許其他程式移動視窗"), resize: no("Wayland 不允許其他程式調整視窗"), minimize: no("Wayland 不允許"), maximize: no("Wayland 不允許"), close: no("Wayland 不允許"), backend: "atspi" };
  } else {
    const why = session.type === "wayland" ? "Wayland 沒有列出其他程式視窗的標準協定" + (session.desktop === "gnome" ? "；GNOME 要用 Window Calls 擴充（gdbus）" : session.desktop === "kde" ? "；KDE 請安裝 kdotool" : "") : "缺 wmctrl／xwininfo";
    f.windows = { list: no(why, session.type === "wayland" ? INSTALL_HINT.kdotool : INSTALL_HINT.wmctrl), focus: no(why), move: no(why), resize: no(why), minimize: no(why), maximize: no(why), close: no(why), backend: "none" };
    if (!x11Usable && has("wmctrl")) { hints.push("沒有 DISPLAY：X 工具無法連線"); }
  }
  // ----- 輸入 -----
  if (session.type === "x11" && has("xdotool")) {
    f.input = { mouse: ok("xdotool"), keyboard: ok("xdotool"), typeText: ok("xdotool type", { unicode: "xdotool 會暫時重新對應按鍵；少數應用程式（例如某些遠端桌面）收不到，可改用剪貼簿貼上" }), backend: "xdotool" };
  } else if (session.type === "wayland" && has("ydotool")) {
    const ydoOk = probes.ydotoold !== false && probes.uinput !== false;
    f.input = { mouse: ydoOk ? ok("ydotool", { unverified: true, note: "絕對座標在多螢幕／加速度下可能偏移，要先用 pointer 校準" }) : no("ydotool 需要 ydotoold 在跑、且 /dev/uinput 可寫入", INSTALL_HINT.ydotool), keyboard: ydoOk ? ok("ydotool", { unverified: true }) : no("ydotool 需要 ydotoold 與 /dev/uinput 權限"), typeText: has("wtype") ? ok("wtype（Unicode）", { unverified: true }) : ok("ydotool type（只有 ASCII；中文請改剪貼簿貼上）", { unverified: true }), backend: "ydotool" };
  } else if (session.type === "wayland" && has("wtype")) {
    f.input = { mouse: no("wtype 只送鍵盤；滑鼠需要 ydotool", INSTALL_HINT.ydotool), keyboard: ok("wtype", { unverified: true, note: "需要合成器支援 virtual-keyboard（sway／Hyprland 等；GNOME 與 KDE 不支援）" }), typeText: ok("wtype", { unverified: true }), backend: "wtype" };
  } else if (xOnlyXwayland && has("xdotool")) {
    f.input = { mouse: ok("xdotool（只對 XWayland 視窗有效）", { xwaylandOnly: true }), keyboard: ok("xdotool（只對 XWayland 視窗有效）", { xwaylandOnly: true }), typeText: ok("xdotool type（XWayland）", { xwaylandOnly: true }), backend: "xdotool" };
    notes.push("Wayland 原生視窗收不到 XTEST 事件；要操作它們需要 ydotool（/dev/uinput）或 xdg-desktop-portal RemoteDesktop。");
  } else {
    const why = session.type === "wayland" ? "Wayland 不允許其他程式送出輸入事件" + (probes.portalRemoteDesktop ? "；xdg-desktop-portal 有 RemoteDesktop，但需要互動式授權流程，這個版本沒有實作（建議改用 ydotool）" : "；請裝 ydotool（需要 /dev/uinput 權限）") : "缺 xdotool";
    f.input = { mouse: no(why, INSTALL_HINT.xdotool), keyboard: no(why), typeText: no(why), backend: "none" };
  }
  // ----- 截圖 -----
  const prefs = screenshotPreference(session), shotTool = prefs.find((t) => has(t));
  if (shotTool) {
    const pointerOk = ["scrot", "grim", "spectacle", "gnome-screenshot"].includes(shotTool);
    f.screenshot = { screen: ok(shotTool), window: ok(shotTool + "（整個螢幕裁切）"), rect: ok(shotTool + "（整個螢幕裁切）"), pointer: pointerOk ? ok(shotTool) : no(shotTool + " 不能畫上游標"), tool: shotTool };
    if (shotTool === "gnome-screenshot" || shotTool === "spectacle") notes.push(shotTool + " 每次截圖可能有閃光／快門聲或通知。");
    if (session.type === "wayland" && shotTool === "gnome-screenshot") notes.push("GNOME Wayland 的截圖要經過 Shell／portal，第一次可能彈出授權對話框。");
  } else {
    f.screenshot = { screen: no("沒有可用的截圖工具", INSTALL_HINT.scrot), window: no("沒有截圖工具"), rect: no("沒有截圖工具"), pointer: no("沒有截圖工具") };
  }
  // ----- 剪貼簿 -----
  const clipTool = session.type === "wayland" && has("wl-paste") && has("wl-copy") ? "wl-clipboard" : x11Usable && has("xclip") ? "xclip" : x11Usable && has("xsel") ? "xsel" : has("wl-paste") && has("wl-copy") ? "wl-clipboard" : null;
  f.clipboard = clipTool ? { get: ok(clipTool), set: ok(clipTool) } : { get: no("沒有 xclip／xsel／wl-clipboard", INSTALL_HINT.xclip), set: no("沒有 xclip／xsel／wl-clipboard") };
  // ----- 無障礙／物件 -----
  if (probes.atspi) f.a11y = { ok: true, via: "AT-SPI（python3 gi.Atspi）", coords: session.type === "wayland" && !session.xwayland ? "window-relative" : "screen", note: session.type === "wayland" ? "Wayland 下元件座標常是視窗相對座標，換算到螢幕要靠視窗位置（可能不可得）；Electron／Chrome 需要 --force-renderer-accessibility 才有網頁內容的樹" : "Electron／Chrome 需要 --force-renderer-accessibility（或設 ACCESSIBILITY_ENABLED=1）才有網頁內容的樹；Qt 需要 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1" };
  else f.a11y = no(has("python3") ? "python3 缺 gi.repository.Atspi（sudo apt install python3-gi gir1.2-atspi-2.0）或 AT-SPI 匯流排沒有在跑" : "沒有 python3", INSTALL_HINT.python3);
  f.x11tree = x11Usable && has("xwininfo") ? ok("xwininfo -root -tree") : no(session.type === "wayland" ? "Wayland 沒有 X11 視窗樹（XWayland 視窗除外）" : "缺 xwininfo", INSTALL_HINT.xwininfo);
  // ----- 摘要 -----
  const usable = [];
  if (f.windows.list.ok) usable.push("視窗管理"); if (f.input.mouse.ok) usable.push("滑鼠"); if (f.input.keyboard.ok) usable.push("鍵盤"); if (f.screenshot.screen.ok) usable.push("截圖"); if (f.a11y.ok) usable.push("元件樹（無障礙）");
  const missing = []; for (const k of ["xdotool", "wmctrl", "xprop", "xwininfo"]) if (!has(k) && x11Usable) missing.push(k);
  for (const m of missing) if (INSTALL_HINT[m]) hints.push(INSTALL_HINT[m]);
  const sessLabel = session.type === "wayland" ? (session.xwayland ? "Wayland（含 XWayland）" : "Wayland") : session.type === "x11" ? "X11" : session.type;
  const summary = sessLabel + " / " + session.desktop + "：" + (usable.length ? "可用 " + usable.join("、") : "目前沒有可用的功能") + (session.type === "wayland" && !(f.input.mouse.ok && f.windows.focus.ok) ? "；Wayland 的限制讓部分功能不可用，見 notes" : "");
  return { platform: "linux", session, features: f, tools: Object.fromEntries(Object.entries(tools).filter(([, v]) => v)), missingTools: missing, summary, notes, hints: Array.from(new Set(hints)) };
}

module.exports = { detectSession, parseWmctrl, normId, parseXwininfoTree, nestXwininfo, parseXwininfoId, parseXprop, parseXpropRoot, parseXpropWindowList, parseXrandr, parseXrdbDpi, parseMouseLocation, parseKdotoolGeometry, parseKdotoolIds, unwrapGVariantString, parseGnomeWindowsJson, GNOME_EVAL_LIST, chordToXdotool, chordToYdotool, chordToWtype, EVDEV, XK, screenshotCommand, screenshotPreference, decodeXwd, buildCapabilities, INSTALL_HINT };
