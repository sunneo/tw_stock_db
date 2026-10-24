// computer-use-linux.js —— Linux 後端（X11／XWayland 用 xdotool＋wmctrl＋xprop＋xwininfo；Wayland 用 kdotool／gdbus／ydotool／wtype／grim…）。
// 所有指令都用「明確傳入的 env」執行（env.DISPLAY 決定要操作哪個螢幕）——測試時就是靠這點只碰自己起的 Xvfb，絕不碰真實畫面。
// 任何工具缺少或不被允許時都回 { ok:false, error, why }，不丟例外；capabilities() 會精確說明「現在這個 session 什麼能用、為什麼不能」。
// 實測狀況見 DESIGN.computer-use.md：X11（xfce／Xvfb）真的跑過；Wayland／KDE／GNOME 路徑是依工具文件寫的，只有解析器的 fixture 測試（未實測）。
"use strict";
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("./computer-use-linux-parse.js");
const PNG = require("./computer-png.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function createExec(env, defaults) {
  defaults = defaults || {};
  return function run(cmd, args, o) {
    o = o || {};
    return new Promise((resolve) => {
      const child = execFile(cmd, args || [], { env: o.env || env, timeout: o.timeout || defaults.timeout || 10000, maxBuffer: 64 * 1024 * 1024, encoding: o.binary ? "buffer" : "utf8" }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: stdout == null ? "" : stdout, stderr: stderr == null ? "" : String(stderr), error: err ? (err.code === "ENOENT" ? "找不到指令 " + cmd : err.killed ? "逾時：" + cmd : String(err.message || err).split("\n")[0]) : "" });
      });
      if (o.input != null && child.stdin) { try { child.stdin.end(o.input); } catch (_) { /* */ } }
    });
  };
}
// 在 PATH 裡找執行檔（同步、很快）
function findBin(name, envPath) {
  for (const d of String(envPath || process.env.PATH || "").split(path.delimiter)) { if (!d) continue; const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch (_) { /* */ } }
  return "";
}
// 讀目前游標形狀（X11 的 XFixes，用 python3 ctypes 呼叫 libX11／libXfixes）：回傳游標名稱（left_ptr／xterm／hand2／left_side…）與影像雜湊
// 用途：探索時「移動滑鼠 → 游標變成手／I 字／調整大小」可以直接分辨可點擊、可輸入、sash（分隔條）。XWayland 下只反映 X 用戶端的游標。
const PY_CURSOR = String.raw`import ctypes, ctypes.util, json, sys, hashlib
try:
    x11 = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    xf = ctypes.CDLL(ctypes.util.find_library('Xfixes') or 'libXfixes.so.3')
except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": "載入 libX11／libXfixes 失敗：" + str(e)}))
    sys.exit(0)
class Img(ctypes.Structure):
    _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short), ('width', ctypes.c_ushort), ('height', ctypes.c_ushort), ('xhot', ctypes.c_ushort), ('yhot', ctypes.c_ushort), ('cursor_serial', ctypes.c_ulong), ('pixels', ctypes.POINTER(ctypes.c_ulong)), ('atom', ctypes.c_ulong), ('name', ctypes.c_char_p)]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
xf.XFixesGetCursorImage.restype = ctypes.POINTER(Img)
xf.XFixesGetCursorImage.argtypes = [ctypes.c_void_p]
d = x11.XOpenDisplay(None)
if not d:
    sys.stdout.write(json.dumps({"ok": False, "error": "XOpenDisplay 失敗（DISPLAY 不對？）"}))
    sys.exit(0)
p = xf.XFixesGetCursorImage(d)
if not p:
    sys.stdout.write(json.dumps({"ok": False, "error": "XFixesGetCursorImage 失敗（伺服器沒有 XFIXES？）"}))
    sys.exit(0)
c = p.contents
n = c.width * c.height
raw = b''.join((c.pixels[i] & 0xffffffff).to_bytes(4, 'little') for i in range(n))
nm = c.name.decode('latin1') if c.name else ''
sys.stdout.write(json.dumps({"ok": True, "name": nm, "x": c.x, "y": c.y, "w": c.width, "h": c.height, "xhot": c.xhot, "yhot": c.yhot, "serial": int(c.cursor_serial), "hash": hashlib.md5(raw).hexdigest()[:12]}))
`;
const TOOL_NAMES = ["xdotool", "wmctrl", "xprop", "xwininfo", "xrandr", "xrdb", "xclip", "xsel", "wl-copy", "wl-paste", "scrot", "import", "maim", "xwd", "xfce4-screenshooter", "gnome-screenshot", "spectacle", "grim", "kdotool", "qdbus", "qdbus6", "qdbus-qt5", "gdbus", "ydotool", "wtype", "dotool", "python3", "xdpyinfo"];

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function createLinuxBackend(opts) {
  opts = opts || {};
  const env = Object.assign({}, opts.env || process.env);
  const run = opts.exec || createExec(env);
  const which = opts.which || ((n) => findBin(n, env.PATH));
  const session = P.detectSession(env);
  const be = { kind: "linux", session, env };
  let toolCache = null, probeCache = null, probeAt = 0;
  const tools = () => { if (!toolCache) { toolCache = {}; for (const n of TOOL_NAMES) toolCache[n] = which(n) || ""; } return toolCache; };
  const has = (n) => !!tools()[n];
  const fail = (error, why) => ({ ok: false, error, why: why || undefined });
  const procName = (pid) => { if (!pid) return ""; try { return fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim(); } catch (_) { return ""; } };

  // ---------- 探測（各種「這個 session 能不能用」的檢查，結果快取 30 秒） ----------
  async function probes(force) {
    if (!force && probeCache && Date.now() - probeAt < 30000) return probeCache;
    const t = tools(), p = {};
    if (opts.probes) { probeCache = opts.probes; probeAt = Date.now(); return probeCache; }
    if (t.python3) { const r = await run("python3", ["-c", "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi"], { timeout: 8000 }); p.atspi = r.ok; }
    else p.atspi = false;
    try { fs.accessSync("/dev/uinput", fs.constants.W_OK); p.uinput = true; } catch (_) { p.uinput = false; }
    p.ydotoold = [env.YDOTOOL_SOCKET, "/tmp/.ydotool_socket", "/run/user/" + (process.getuid ? process.getuid() : 0) + "/.ydotool_socket"].filter(Boolean).some((s) => { try { return fs.existsSync(s); } catch (_) { return false; } });
    if (session.type === "wayland" && session.desktop === "gnome" && t.gdbus) {
      const r = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Extensions/Windows", "--method", "org.gnome.Shell.Extensions.Windows.List"], { timeout: 5000 });
      p.gnomeWindowsExt = r.ok && !!P.parseGnomeWindowsJson(r.stdout);
      if (!p.gnomeWindowsExt) { const e = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", P.GNOME_EVAL_LIST], { timeout: 5000 }); p.gnomeEval = e.ok && !!P.parseGnomeWindowsJson(e.stdout); }
    }
    if (session.type === "wayland" && t.gdbus) { const r = await run("gdbus", ["introspect", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"], { timeout: 5000 }); p.portalRemoteDesktop = r.ok && /org\.freedesktop\.portal\.RemoteDesktop/.test(r.stdout); }
    probeCache = p; probeAt = Date.now(); return p;
  }
  let capCache = null;
  be.capabilities = async function (force) {
    if (!force && capCache && Date.now() - capCache.t < 30000) return capCache.v;
    const v = P.buildCapabilities(session, Object.assign({}, tools()), await probes(force));
    capCache = { t: Date.now(), v }; return v;
  };
  const cap = async () => (await be.capabilities()).features;

  // ---------- X11 視窗 ----------
  const x11 = () => session.hasX && has("wmctrl") && has("xwininfo");
  async function xprops(id) { if (!has("xprop")) return {}; const r = await run("xprop", ["-id", id, "_NET_WM_STATE", "_NET_FRAME_EXTENTS", "_GTK_FRAME_EXTENTS", "_NET_WM_PID", "WM_CLASS", "_NET_WM_WINDOW_TYPE", "_NET_WM_DESKTOP"], { timeout: 4000 }); return r.ok ? P.parseXprop(r.stdout) : {}; }
  async function listX11() {
    const [wm, tree, root] = await Promise.all([run("wmctrl", ["-lGpx"]), run("xwininfo", ["-root", "-tree"]), has("xprop") ? run("xprop", ["-root", "_NET_CLIENT_LIST_STACKING", "_NET_CURRENT_DESKTOP", "_NET_NUMBER_OF_DESKTOPS", "_NET_ACTIVE_WINDOW", "_NET_WORKAREA"]) : Promise.resolve({ ok: false, stdout: "" })]);
    if (!wm.ok) return fail("wmctrl 失敗：" + (wm.stderr || wm.error).trim().slice(0, 200), "可能是沒有支援 EWMH 的視窗管理員（wmctrl 需要 _NET_CLIENT_LIST）");
    const rows = P.parseWmctrl(wm.stdout), absById = new Map(P.parseXwininfoTree(tree.stdout).map((n) => [n.id, n])), info = P.parseXpropRoot(root.stdout), stack = info.stacking;
    const props = await mapLimit(rows, 8, (r) => xprops(r.id));
    const wins = rows.map((r, i) => {
      const abs = absById.get(r.id), pr = props[i] || {}, rect = abs ? { x: abs.x, y: abs.y, w: abs.w, h: abs.h } : { x: r.x, y: r.y, w: r.w, h: r.h };
      const fe = pr.frame || { left: 0, right: 0, top: 0, bottom: 0 }, frame = { x: rect.x - fe.left, y: rect.y - fe.top, w: rect.w + fe.left + fe.right, h: rect.h + fe.top + fe.bottom };
      const state = pr.state || [], pid = r.pid || pr.pid || null;
      const zi = stack.indexOf(r.id);
      return { id: r.id, pid, process: procName(pid), title: r.title, class: (pr.wmClass && pr.wmClass[1]) || r.class, instance: (pr.wmClass && pr.wmClass[0]) || r.instance, rect, frame, state, minimized: state.includes("hidden"), maximized: state.includes("maximized_vert") && state.includes("maximized_horz"), fullscreen: state.includes("fullscreen"), focused: info.active === r.id || state.includes("focused"), workspace: r.desktop, onCurrentDesktop: r.desktop === -1 || info.currentDesktop == null || r.desktop === info.currentDesktop, type: (pr.type && pr.type[0]) || "normal", z: zi >= 0 ? zi : -1, host: r.host, source: "x11" };
    });
    return { ok: true, windows: wins, activeId: info.active, workarea: info.workarea, currentDesktop: info.currentDesktop, desktops: info.desktops };
  }
  // ---------- KDE Wayland：kdotool（未實測） ----------
  async function listKdotool() {
    const ids = await run("kdotool", ["search", "--name", "."]); if (!ids.ok) return fail("kdotool search 失敗：" + (ids.stderr || ids.error).trim().slice(0, 200));
    const list = P.parseKdotoolIds(ids.stdout), act = await run("kdotool", ["getactivewindow"]), activeId = (act.stdout || "").trim();
    const wins = await mapLimit(list, 6, async (id) => {
      const [n, g, c, pid] = await Promise.all([run("kdotool", ["getwindowname", id]), run("kdotool", ["getwindowgeometry", id]), run("kdotool", ["getwindowclassname", id]), run("kdotool", ["getwindowpid", id])]);
      const geo = P.parseKdotoolGeometry(g.stdout), pn = Number((pid.stdout || "").trim()) || null;
      return { id, pid: pn, process: procName(pn), title: (n.stdout || "").trim(), class: (c.stdout || "").trim(), rect: geo, frame: geo, state: [], minimized: false, focused: id === activeId, z: -1, type: "normal", source: "kdotool" };
    });
    return { ok: true, windows: wins.filter((w) => w.rect), activeId };
  }
  // ---------- GNOME Wayland：Window Calls 擴充／Shell.Eval（未實測） ----------
  async function listGnome() {
    const p = await probes(); let arr = null;
    if (p.gnomeWindowsExt !== false) { const r = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Extensions/Windows", "--method", "org.gnome.Shell.Extensions.Windows.List"]); if (r.ok) arr = P.parseGnomeWindowsJson(r.stdout); }
    if (!arr) { const r = await run("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell", "--method", "org.gnome.Shell.Eval", P.GNOME_EVAL_LIST]); if (r.ok) arr = P.parseGnomeWindowsJson(r.stdout); }
    if (!arr) return fail("GNOME Shell 不給列出視窗（Shell.Eval 已被停用，也沒有裝 Window Calls 擴充）");
    const wins = arr.filter((w) => w.w != null).map((w, i) => { const rect = { x: w.x, y: w.y, w: w.w, h: w.h }; return { id: w.id, pid: w.pid, process: procName(w.pid), title: w.title, class: w.class, rect, frame: rect, state: [], minimized: w.minimized, focused: w.focused, z: i, type: "normal", onCurrentDesktop: w.inCurrentWorkspace, source: "gnome" }; });
    return { ok: true, windows: wins, activeId: (wins.find((w) => w.focused) || {}).id };
  }
  const winBackend = async () => { const f = await cap(); return f.windows && f.windows.backend; };
  be.listWindows = async function (o) {
    o = o || {}; const b = await winBackend(); let r;
    if (b === "x11") r = await listX11(); else if (b === "kdotool") r = await listKdotool(); else if (b === "gnome") r = await listGnome();
    else return fail("這個 session 沒有可用的視窗列表", ((await cap()).windows.list || {}).reason);
    if (!r.ok) return r;
    let wins = r.windows; if (!o.all) wins = wins.filter((w) => !["desktop", "dock", "splash", "notification", "tooltip", "dnd", "menu", "dropdown_menu", "popup_menu", "combo", "utility"].includes(w.type) || w.focused);
    return Object.assign({}, r, { windows: wins, backend: b });
  };
  be.activeWindowId = async function () {
    if (session.hasX && has("xprop") && session.type !== "wayland") { const r = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]); return P.parseXpropRoot(r.stdout).active; }
    const l = await be.listWindows({ all: true }); return l.ok ? l.activeId || null : null;
  };

  // ---------- 視窗動作 ----------
  be.windowAction = async function (action, id, a) {
    a = a || {}; const f = await cap(), b = f.windows.backend, wid = b === "x11" ? P.normId(id) : String(id);
    const featName = { restore: "maximize" }[action] || action, feat = f.windows[featName];
    if (!feat || !feat.ok) return fail("視窗動作 " + action + " 在這個 session 不可用", feat && feat.reason);
    let r;
    if (b === "x11") {
      switch (action) {
        case "focus": r = await run("wmctrl", ["-i", "-a", wid]); break;
        case "move": r = await run("wmctrl", ["-i", "-r", wid, "-e", "0," + Math.round(a.x) + "," + Math.round(a.y) + ",-1,-1"]); break;
        case "resize": r = await run("wmctrl", ["-i", "-r", wid, "-e", "0,-1,-1," + Math.round(a.w) + "," + Math.round(a.h)]); break;
        case "minimize": r = await run("xdotool", ["windowminimize", wid]); break;
        case "maximize": r = await run("wmctrl", ["-i", "-r", wid, "-b", "add,maximized_vert,maximized_horz"]); break;
        case "restore": r = await run("wmctrl", ["-i", "-r", wid, "-b", "remove,maximized_vert,maximized_horz,hidden"]); if (r.ok) r = await run("wmctrl", ["-i", "-a", wid]); break;
        case "close": r = await run("wmctrl", ["-i", "-c", wid]); break;
        default: return fail("不認得的視窗動作 " + action);
      }
    } else if (b === "kdotool") {
      const m = { focus: ["windowactivate", wid], move: ["windowmove", wid, String(Math.round(a.x)), String(Math.round(a.y))], resize: ["windowsize", wid, String(Math.round(a.w)), String(Math.round(a.h))], minimize: ["windowminimize", wid], maximize: ["windowstate", "--add", "MAXIMIZED_VERT", "--add", "MAXIMIZED_HORZ", wid], restore: ["windowstate", "--remove", "MAXIMIZED_VERT", "--remove", "MAXIMIZED_HORZ", wid], close: ["windowclose", wid] }[action];
      r = await run("kdotool", m);
    } else if (b === "gnome") {
      const base = ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Extensions/Windows", "--method"], n = Number(wid);
      const m = { focus: ["org.gnome.Shell.Extensions.Windows.Activate", String(n)], move: ["org.gnome.Shell.Extensions.Windows.Move", String(n), String(Math.round(a.x)), String(Math.round(a.y))], resize: ["org.gnome.Shell.Extensions.Windows.Resize", String(n), String(Math.round(a.w)), String(Math.round(a.h))], minimize: ["org.gnome.Shell.Extensions.Windows.Minimize", String(n)], maximize: ["org.gnome.Shell.Extensions.Windows.Maximize", String(n)], restore: ["org.gnome.Shell.Extensions.Windows.Unmaximize", String(n)], close: ["org.gnome.Shell.Extensions.Windows.Close", String(n)] }[action];
      r = await run("gdbus", base.concat(m));
    } else return fail("沒有視窗後端");
    if (!r.ok) return fail(action + " 失敗：" + (r.stderr || r.error).trim().slice(0, 200));
    return { ok: true, via: b };
  };

  // ---------- 滑鼠與鍵盤 ----------
  const inBackend = async () => (await cap()).input.backend;
  const BTN = { left: 1, middle: 2, right: 3 };
  const YBTN = { left: "0xC0", right: "0xC1", middle: "0xC2" };
  async function needInput(kind) { const f = await cap(), feat = f.input[kind]; if (!feat || !feat.ok) return fail("這個 session 不能送出" + (kind === "mouse" ? "滑鼠" : "鍵盤") + "事件", feat && feat.reason); return null; }
  const ixy = (x, y) => [String(Math.round(x)), String(Math.round(y))];
  be.pointerLocation = async function () {
    if (session.hasX && has("xdotool") && (session.type === "x11" || session.xwayland)) { const r = await run("xdotool", ["getmouselocation", "--shell"]); const loc = P.parseMouseLocation(r.stdout); return loc ? Object.assign({ ok: true }, loc) : fail("讀不到滑鼠位置"); }
    if (has("kdotool") && session.desktop === "kde") { const r = await run("kdotool", ["getmouselocation"]); const m = /x:(-?\d+)\s+y:(-?\d+)/.exec(r.stdout || ""); return m ? { ok: true, x: +m[1], y: +m[2] } : fail("讀不到滑鼠位置"); }
    return fail("這個 session 沒有查詢滑鼠位置的方法", "Wayland 不開放全域游標位置；可用「游標載入截圖」比對");
  };
  be.pointerMove = async function (x, y) {
    const bad = await needInput("mouse"); if (bad) return bad; const b = await inBackend();
    const r = b === "ydotool" ? await run("ydotool", ["mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))]) : await run("xdotool", ["mousemove", ...ixy(x, y)]); // 刻意不用 --sync：游標已經在那一點時 xdotool 會永遠等不到移動事件而卡住
    return r.ok ? { ok: true } : fail("移動滑鼠失敗：" + (r.stderr || r.error).trim().slice(0, 160));
  };
  be.click = async function (x, y, o) {
    o = o || {}; const bad = await needInput("mouse"); if (bad) return bad; const b = await inBackend(), btn = o.button || "left", n = Math.max(1, Math.min(3, o.count || 1));
    let r;
    if (b === "ydotool") {
      r = await run("ydotool", ["mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))]); if (r.ok) { await sleep(40); for (let i = 0; i < n && r.ok; i++) { r = await run("ydotool", ["click", YBTN[btn]]); if (i < n - 1) await sleep(70); } }
    } else r = await run("xdotool", ["mousemove", ...ixy(x, y), "click", "--repeat", String(n), "--delay", "70", String(BTN[btn])]);
    return r.ok ? { ok: true } : fail("點擊失敗：" + (r.stderr || r.error).trim().slice(0, 160));
  };
  be.drag = async function (x, y, x2, y2, o) {
    o = o || {}; const bad = await needInput("mouse"); if (bad) return bad; const b = await inBackend(), steps = Math.max(2, Math.min(40, o.steps || Math.ceil(Math.hypot(x2 - x, y2 - y) / 25))), btn = BTN[o.button || "left"];
    if (b !== "xdotool") return fail("拖曳目前只有 xdotool 後端實作", "ydotool 需要 mousedown/up（尚未實作）");
    const args = ["mousemove", ...ixy(x, y), "mousedown", String(btn), "sleep", "0.12"];
    for (let i = 1; i <= steps; i++) { args.push("mousemove", ...ixy(x + ((x2 - x) * i) / steps, y + ((y2 - y) * i) / steps), "sleep", "0.02"); }
    args.push("sleep", "0.1", "mouseup", String(btn));
    const r = await run("xdotool", args, { timeout: 20000 }); return r.ok ? { ok: true } : fail("拖曳失敗：" + (r.stderr || r.error).trim().slice(0, 160));
  };
  be.scroll = async function (x, y, dx, dy) {
    const bad = await needInput("mouse"); if (bad) return bad; const b = await inBackend(); dx = Math.round(dx || 0); dy = Math.round(dy || 0);
    if (b === "ydotool") { const r = await run("ydotool", ["mousemove", "--absolute", "-x", String(Math.round(x)), "-y", String(Math.round(y))]); if (!r.ok) return fail("移動失敗"); await run("ydotool", ["mousemove", "--wheel", "-x", String(dx), "-y", String(-dy)]); return { ok: true, unverified: true }; }
    const args = ["mousemove", ...ixy(x, y)];
    if (dy) args.push("click", "--repeat", String(Math.min(50, Math.abs(dy))), "--delay", "20", dy > 0 ? "5" : "4");
    if (dx) args.push("click", "--repeat", String(Math.min(50, Math.abs(dx))), "--delay", "20", dx > 0 ? "7" : "6");
    const r = await run("xdotool", args); return r.ok ? { ok: true } : fail("捲動失敗：" + (r.stderr || r.error).trim().slice(0, 160));
  };
  be.key = async function (chord) {
    const bad = await needInput("keyboard"); if (bad) return bad; const b = await inBackend();
    let r;
    if (b === "ydotool") { const seq = P.chordToYdotool(chord); if (!seq) return fail("ydotool 不認得這個組合鍵：" + chord); r = await run("ydotool", ["key", ...seq]); }
    else if (b === "wtype") { const a = P.chordToWtype(chord); if (!a) return fail("wtype 不認得這個組合鍵：" + chord); r = await run("wtype", a); }
    else { const k = P.chordToXdotool(chord); if (!k) return fail("xdotool 不認得這個組合鍵：" + chord, "支援：ctrl／alt／shift／super＋字母數字、F1~F24、Return、Escape、Tab、BackSpace、Delete、方向鍵…"); r = await run("xdotool", ["key", "--clearmodifiers", k]); }
    return r.ok ? { ok: true } : fail("按鍵失敗：" + (r.stderr || r.error).trim().slice(0, 160));
  };
  // 文字輸入：預設 xdotool type（Unicode 可），太長就分段；mode:'paste' 走剪貼簿（先備份再還原）＋ ctrl+v
  be.typeText = async function (text, o) {
    o = o || {}; const bad = await needInput("keyboard"); if (bad) return bad; const b = await inBackend(); text = String(text);
    if (o.mode === "paste") {
      const old = await be.clipboardGet(), s = await be.clipboardSet(text); if (!s.ok) return s; await sleep(80);
      const k = await be.key("ctrl+v"); await sleep(150); if (old.ok && typeof old.text === "string") await be.clipboardSet(old.text); return k.ok ? { ok: true, via: "paste" } : k;
    }
    if (b === "wtype") { const r = await run("wtype", ["-d", String(o.delayMs == null ? 12 : o.delayMs), "--", text]); return r.ok ? { ok: true } : fail("wtype 失敗：" + (r.stderr || r.error).trim().slice(0, 160)); }
    if (b === "ydotool") { if (/[^\x00-\x7f]/.test(text)) return fail("ydotool 只能輸入 ASCII", "請用 mode:'paste'（剪貼簿貼上）輸入中文"); const r = await run("ydotool", ["type", "--key-delay", String(o.delayMs == null ? 12 : o.delayMs), "--", text]); return r.ok ? { ok: true } : fail("ydotool type 失敗：" + (r.stderr || r.error).trim().slice(0, 160)); }
    for (let i = 0; i < text.length; i += 120) {
      const r = await run("xdotool", ["type", "--clearmodifiers", "--delay", String(o.delayMs == null ? 12 : o.delayMs), "--", text.slice(i, i + 120)], { timeout: 30000 });
      if (!r.ok) return fail("輸入文字失敗：" + (r.stderr || r.error).trim().slice(0, 160));
    }
    return { ok: true, via: "type" };
  };
  // 中止時放開所有可能按住的東西
  be.releaseAll = async function () {
    if (session.hasX && has("xdotool") && (session.type === "x11" || session.xwayland)) await run("xdotool", ["mouseup", "1", "mouseup", "2", "mouseup", "3", "keyup", "Control_L", "Control_R", "Alt_L", "Alt_R", "Shift_L", "Shift_R", "Super_L", "Super_R"]);
    return { ok: true };
  };

  // ---------- 剪貼簿 ----------
  async function clipTool() { const f = await cap(); return f.clipboard.get.ok ? f.clipboard.get.via : null; }
  be.clipboardGet = async function () {
    const t = await clipTool(); if (!t) return fail("沒有剪貼簿工具", (await cap()).clipboard.get.reason);
    const r = t === "wl-clipboard" ? await run("wl-paste", ["--no-newline"]) : t === "xclip" ? await run("xclip", ["-selection", "clipboard", "-o"]) : await run("xsel", ["--clipboard", "--output"]);
    return r.ok ? { ok: true, text: r.stdout, via: t } : { ok: true, text: "", via: t, empty: true };
  };
  be.clipboardSet = async function (text) {
    const t = await clipTool(); if (!t) return fail("沒有剪貼簿工具", (await cap()).clipboard.set.reason);
    // xclip／xsel 設定後會留一個常駐行程持有選取區，所以不能等它結束：用 spawn 寫完 stdin 就放著
    if (opts.exec) { const r = t === "wl-clipboard" ? await run("wl-copy", [], { input: text }) : t === "xclip" ? await run("xclip", ["-selection", "clipboard", "-i"], { input: text }) : await run("xsel", ["--clipboard", "--input"], { input: text }); return r.ok ? { ok: true, via: t } : fail("設定剪貼簿失敗"); }
    return new Promise((resolve) => {
      const { spawn } = require("child_process"), cmd = t === "wl-clipboard" ? ["wl-copy", []] : t === "xclip" ? ["xclip", ["-selection", "clipboard", "-i"]] : ["xsel", ["--clipboard", "--input"]];
      let child; try { child = spawn(cmd[0], cmd[1], { env, stdio: ["pipe", "ignore", "ignore"], detached: true }); } catch (e) { return resolve(fail("設定剪貼簿失敗：" + e.message)); }
      child.on("error", (e) => resolve(fail("設定剪貼簿失敗：" + e.message))); child.stdin.on("error", () => { /* */ }); child.stdin.end(text); child.unref();
      setTimeout(() => resolve({ ok: true, via: t }), 120);
    });
  };

  be.cursorShape = async function () {
    if (!(session.hasX && has("python3") && (session.type === "x11" || session.xwayland))) return fail("這個 session 讀不到游標形狀", session.type === "wayland" ? "Wayland 不開放全域游標資訊" : "需要 X11、python3 與 libXfixes");
    const r = await run("python3", ["-c", PY_CURSOR], { timeout: 8000 }); let j = null; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (_) { /* */ }
    return j && j.ok ? { ok: true, name: j.name || "", hash: j.hash, w: j.w, h: j.h, xhot: j.xhot, yhot: j.yhot, serial: j.serial } : fail((j && j.error) || "讀游標失敗：" + (r.stderr || r.error || "").slice(0, 160));
  };

  // ---------- 螢幕與截圖 ----------
  be.monitors = async function () {
    if (session.hasX && has("xrandr") && session.type !== "wayland") {
      const r = await run("xrandr", ["--query"]); let mons = P.parseXrandr(r.stdout), dpi = null;
      if (has("xrdb")) { const x = await run("xrdb", ["-query"]); dpi = P.parseXrdbDpi(x.stdout); }
      if (!mons.length) { const g = await run("xdotool", ["getdisplaygeometry"]); const m = /(\d+)\s+(\d+)/.exec(g.stdout || ""); if (m) mons = [{ name: "screen", primary: true, rect: { x: 0, y: 0, w: +m[1], h: +m[2] }, mm: null, dpi: null }]; }
      return { ok: true, monitors: mons.map((m) => Object.assign({ scale: Math.round(((dpi || m.dpi || 96) / 96) * 100) / 100 }, m)), xftDpi: dpi };
    }
    if (session.hasX && has("xdpyinfo")) { const r = await run("xdpyinfo"); const m = /dimensions:\s+(\d+)x(\d+)/.exec(r.stdout || ""); if (m) return { ok: true, monitors: [{ name: "screen", primary: true, rect: { x: 0, y: 0, w: +m[1], h: +m[2] }, scale: 1 }] }; }
    return fail("沒辦法查詢螢幕配置", session.type === "wayland" ? "Wayland 沒有跨合成器的螢幕查詢（需要 wlr-randr／gnome-randr／kscreen-doctor）" : "缺 xrandr");
  };
  // 回傳 { ok, png:Buffer, width, height, origin:{x,y}, scale:{x,y}, tool, rect }
  be.screenshot = async function (o) {
    o = o || {}; const f = await cap(); if (!f.screenshot.screen.ok) return fail("沒有截圖工具", f.screenshot.screen.reason);
    const tool = f.screenshot.tool, file = path.join(os.tmpdir(), "fa-shot-" + process.pid + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ".png");
    const cmd = P.screenshotCommand(tool, { file, pointer: !!o.pointer && f.screenshot.pointer.ok }); if (!cmd) return fail("不認得的截圖工具 " + tool);
    const r = await run(cmd.cmd, cmd.args, { timeout: 15000 });
    let buf = null; try { buf = fs.readFileSync(file); } catch (_) { /* 下面處理 */ } try { fs.unlinkSync(file); } catch (_) { /* */ }
    if (!buf || !buf.length) return fail("截圖失敗：" + ((r.stderr || r.error || "").trim().slice(0, 200) || "沒有輸出檔"), tool);
    let img; try { img = cmd.format === "xwd" ? P.decodeXwd(buf) : PNG.decodePng(buf); } catch (e) { return fail("截圖解碼失敗：" + e.message, tool); }
    let rect = { x: 0, y: 0, w: img.width, h: img.height };
    if (o.kind === "window" && o.rect) rect = o.rect; else if (o.kind === "rect" && o.rect) rect = o.rect;
    if (rect.w !== img.width || rect.h !== img.height || rect.x || rect.y) { const cr = PNG.clampRect(img, rect); if (!cr.w || !cr.h) return fail("範圍在螢幕之外"); img = PNG.crop(img, cr); rect = cr; }
    let scale = 1; if (o.maxSide) { const fw = PNG.fitWithin(img, o.maxSide); img = fw.img; scale = fw.scale; }
    return { ok: true, png: PNG.encodePng(img), width: img.width, height: img.height, origin: { x: rect.x, y: rect.y }, scale: { x: scale, y: scale }, rect, tool, pointer: !!o.pointer && f.screenshot.pointer.ok, image: o.wantImage ? img : undefined };
  };

  // ---------- X11 視窗樹（沒有無障礙資訊時的備案） ----------
  be.x11Tree = async function (id, o) {
    o = o || {}; if (!(session.hasX && has("xwininfo"))) return fail("沒有 X11 視窗樹", "Wayland 或缺 xwininfo");
    const r = await run("xwininfo", id ? ["-id", P.normId(id), "-tree"] : ["-root", "-tree"]); if (!r.ok) return fail("xwininfo 失敗：" + (r.stderr || r.error).trim().slice(0, 200));
    return { ok: true, nodes: P.nestXwininfo(P.parseXwininfoTree(r.stdout)), root: id || "root" };
  };
  // 等視窗出現
  be.waitForWindow = async function (match, timeoutMs) {
    const t0 = Date.now(), re = match.regex ? new RegExp(String(match.regex), "i") : null;
    for (;;) {
      const l = await be.listWindows({ all: true });
      if (l.ok) { const w = l.windows.find((x) => (!match.title || String(x.title).toLowerCase().includes(String(match.title).toLowerCase())) && (!match.class || String(x.class).toLowerCase().includes(String(match.class).toLowerCase())) && (!match.pid || Number(x.pid) === Number(match.pid)) && (!re || re.test(x.title) || re.test(x.class))); if (w) return { ok: true, window: w, waitedMs: Date.now() - t0 }; }
      if (Date.now() - t0 >= (timeoutMs || 10000)) return fail("等不到符合的視窗（" + (timeoutMs || 10000) + " ms）");
      await sleep(250);
    }
  };
  return be;
}

module.exports = { createLinuxBackend, createExec, findBin, TOOL_NAMES, mapLimit, PY_CURSOR };
