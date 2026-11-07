// computer-use-windows.js —— Windows 後端：「類似 nircmd 的小工具」＋ PowerShell（C#／user32／GDI／UI Automation）。
// 兩條路：
//   1. PowerShell（預設，功能完整）：產生腳本 → powershell -NoProfile -NonInteractive -STA -EncodedCommand 執行 → 解析 JSON。
//      C# 部分（computer-use-win-cs.js）第一次執行時用 Add-Type 編成 DLL 放在 %TEMP%\fa-computer-use\，之後每個動作只是一小段「載入 DLL → 呼叫 → 印 JSON」，
//      短腳本走 -EncodedCommand；腳本太長（編譯那一步）自動改成暫存 .ps1 檔＋ -File（避免超過命令列 32767 字元上限）。
//   2. nircmd.exe（在 PATH 上、而且所有螢幕縮放都是 100% 時才用——nircmd 不是 DPI aware，縮放大於 100% 時座標會被虛擬化而點偏）：
//      滑鼠／按鍵／視窗動作／截圖走 nircmd，視窗清單、Unicode 輸入、UI Automation 一律還是 PowerShell。
// 這個檔案在 Linux 上只做得到：腳本產生與解析的單元測試（fixture）、C# 的編譯檢查——Windows 上實跑是「未實測」。
"use strict";
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CS = require("./computer-use-win-cs.js");
const PNG = require("./computer-png.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CS_HASH = crypto.createHash("sha1").update(CS.CS_ALL).digest("hex").slice(0, 12);
const DLL_REL = "fa-computer-use\\fa-cu-" + CS_HASH + ".dll";
const ENCODED_LIMIT = 16000; // -EncodedCommand 的 base64 長度上限（命令列總長 32767；留餘裕）

// ---------- PowerShell 腳本 ----------
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell 單引號字串
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
const paramsExpr = (o) => "$p = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" + psq(b64(JSON.stringify(o == null ? {} : o))) + ")))";
const HEADER = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $dll = Join-Path $env:TEMP " + psq(DLL_REL) + ";";
// 錯誤訊息不依賴 DLL（DLL 載入失敗時也要能回報）：非 ASCII 換成 ?、反斜線與雙引號換掉，確保是合法 JSON
const FOOTER_CATCH = "catch { $m = ($_.Exception.Message -replace '[^\\x20-\\x7e]', '?'); $m = $m.Replace('\\', '/').Replace('\"', \"'\"); [Console]::Out.Write('{\"ok\":false,\"error\":\"' + $m + '\"}') }";
// body：用 $p 取參數、把最後的 JSON 字串放在 $r
function wrapBody(body, params) { return HEADER + "\ntry {\nAdd-Type -Path $dll; [FaDpi]::Init()\n" + paramsExpr(params) + "\n" + body + "\n[Console]::Out.Write($r)\n} " + FOOTER_CATCH + "\n"; }
// 編譯 DLL 的腳本（很長；只在第一次或原始碼改版時跑）
function buildCompileScript() {
  return [
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$dll = Join-Path $env:TEMP " + psq(DLL_REL),
    "try {",
    "New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null",
    "if (-not (Test-Path $dll)) {",
    "  Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase",
    "  $refs = @('System.Drawing', 'System.Windows.Forms', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location)",
    "  $tmp = $dll -replace '\\.dll$', ('.' + $PID + '.dll')",
    "  Add-Type -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library -TypeDefinition @'",
    CS.CS_ALL,
    "'@",
    "  Move-Item -Force $tmp $dll",
    "}",
    "[Console]::Out.Write('{\"ok\":true,\"compiled\":true}')",
    "} catch { $m = ($_.Exception.Message -replace '[^\\x20-\\x7e]', '?'); $m = $m.Replace('\\', '/').Replace('\"', \"'\"); [Console]::Out.Write('{\"ok\":false,\"error\":\"' + $m + '\"}') }",
  ].join("\n");
}
function buildPowerShellInvocation(script, o) {
  o = o || {}; const exe = o.exe || "powershell.exe", enc = Buffer.from(script, "utf16le").toString("base64");
  if (enc.length <= (o.limit || ENCODED_LIMIT)) return { exe, args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", enc], mode: "encoded" };
  return { exe, args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", "<file>"], mode: "file", script };
}

// ---------- 各動作的 PowerShell 本體（回傳字串，放進 wrapBody） ----------
const SCRIPTS = {
  list: (all) => "$r = [FaWin]::ListWindows(" + (all ? "$true" : "$false") + ")",
  monitors: () => "$r = [FaWin]::Monitors()",
  foreground: () => "$r = [FaWin]::Foreground()",
  windowAction: () => "$r = [FaWin]::Action([long]$p.hwnd, [string]$p.action, [int]$p.x, [int]$p.y, [int]$p.w, [int]$p.h)",
  childTree: () => "$r = [FaWin]::ChildTree([long]$p.hwnd, [int]$p.depth, [int]$p.maxNodes)",
  screenshotRect: () => "$r = [FaShot]::Screen([int]$p.x, [int]$p.y, [int]$p.w, [int]$p.h)",
  screenshotWindow: () => "$r = [FaShot]::Window([long]$p.hwnd)",
  pointer: () => "$r = [FaInput]::Where()",
  cursor: () => "$r = [FaInput]::CursorShape()",
  releaseAll: () => "[FaInput]::ReleaseAll(); $r = '{\"ok\":true}'",
  // ops：[{op:'move'|'click'|'drag'|'wheel'|'chord'|'type'|'sleep', …}]，一個腳本做完一整批（省掉每個動作一次啟動 PowerShell）
  ops: () => [
    "$n = 0",
    "foreach ($o in @($p.ops)) {",
    "  switch ($o.op) {",
    "    'move'  { [FaInput]::Move([int]$o.x, [int]$o.y) }",
    "    'click' { [FaInput]::Click([int]$o.x, [int]$o.y, [int]$o.button, [int]$o.count) }",
    "    'drag'  { [FaInput]::Drag([int]$o.x, [int]$o.y, [int]$o.x2, [int]$o.y2, [int]$o.button, [int]$o.steps) }",
    "    'wheel' { [FaInput]::Wheel([int]$o.x, [int]$o.y, [int]$o.dx, [int]$o.dy) }",
    "    'chord' { [FaInput]::Chord([int[]]@($o.vks)) }",
    "    'type'  { [FaInput]::TypeText([string]$o.text, [int]$o.delay) }",
    "    'sleep' { Start-Sleep -Milliseconds ([int]$o.ms) }",
    "  }",
    "  $n++",
    "}",
    "$r = '{\"ok\":true,\"done\":' + $n + '}'",
  ].join("\n"),
  clipboardGet: () => "$t = Get-Clipboard -Raw; if ($t -eq $null) { $t = '' }; $r = '{\"ok\":true,\"text\":' + [FaJson]::Str([string]$t) + '}'",
  clipboardSet: () => "Set-Clipboard -Value ([string]$p.text); $r = '{\"ok\":true}'",
  uiaTree: () => "$r = [FaUia]::Tree([long]$p.hwnd, [int]$p.depth, [int]$p.maxNodes, [bool]$p.onlyVisible, [bool]$p.raw)",
  uiaPoint: () => "$r = [FaUia]::FromPoint([int]$p.x, [int]$p.y)",
  uiaFocused: () => "$r = [FaUia]::Focused()",
  uiaAct: () => "$r = [FaUia]::Act([long]$p.hwnd, [string]$p.path, [string]$p.fp, [string]$p.action, [string]$p.value)",
};
function buildScript(kind, params, opt) { const f = SCRIPTS[kind]; if (!f) throw new Error("沒有這種腳本：" + kind); return wrapBody(f(opt), params); }

// ---------- 按鍵 → 虛擬鍵碼 ----------
const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, super: 0x5b, return: 0x0d, escape: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, prior: 0x21, next: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28, space: 0x20, menu: 0x5d, print: 0x2c, pause: 0x13, caps_lock: 0x14, num_lock: 0x90, scroll_lock: 0x91, plus: 0xbb, equal: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, slash: 0xbf, backslash: 0xdc, semicolon: 0xba, apostrophe: 0xde, grave: 0xc0, bracketleft: 0xdb, bracketright: 0xdd };
function chordToVk(chord) {
  const parts = String(chord).split("+").filter(Boolean), out = [];
  for (const p of parts) {
    if (VK[p] != null) out.push(VK[p]); else if (/^f([1-9]|1\d|2[0-4])$/.test(p)) out.push(0x70 + Number(p.slice(1)) - 1); else if (/^[a-z]$/.test(p)) out.push(p.toUpperCase().charCodeAt(0)); else if (/^[0-9]$/.test(p)) out.push(p.charCodeAt(0)); else return null;
  }
  return out.length ? out : null;
}
// ---------- nircmd（未實測）：指令陣列 ----------
// 回傳 [args…]（一個 nircmd 行程一組參數）；缺少對應就回 null（呼叫端改走 PowerShell）
const NIR_KEY = { return: "enter", escape: "esc", backspace: "bksp", delete: "del", prior: "pgup", next: "pgdn", super: "lwin", space: "spc", caps_lock: "capslock" };
function nircmdCommands(op) {
  switch (op.op) {
    case "move": return [["setcursor", String(op.x), String(op.y)]];
    case "click": { const b = { 1: "left", 2: "middle", 3: "right" }[op.button || 1], cmd = op.count >= 2 ? "dblclick" : "click"; return [["setcursor", String(op.x), String(op.y)], ["sendmouse", b, cmd]].concat(op.count >= 3 ? [["sendmouse", b, "click"]] : []); }
    case "wheel": return [["setcursor", String(op.x), String(op.y)]].concat(op.dy ? [["sendmouse", "wheel", String(-120 * op.dy)]] : []);
    case "chord": { const parts = op.chord.split("+").map((p) => NIR_KEY[p] || p); return [["sendkeypress", parts.join("+")]]; }
    case "window": {
      const h = ["handle", String(op.hwnd)], m = { focus: ["win", "activate"], minimize: ["win", "min"], maximize: ["win", "max"], restore: ["win", "normal"], close: ["win", "close"] }[op.action];
      if (m) return [m.concat(h)];
      if (op.action === "move") return [["win", "move"].concat(h, [String(op.x), String(op.y)])];
      if (op.action === "resize") return [["win", "setsize"].concat(h, [String(op.x == null ? 0 : op.x), String(op.y == null ? 0 : op.y), String(op.w), String(op.h)])];
      return null;
    }
    case "screenshot": return [["savescreenshot", op.file, String(op.x), String(op.y), String(op.w), String(op.h)]];
    case "clipboard_set": return [["clipboard", "set", op.text]];
    default: return null;
  }
}

// ---------- 解析 ----------
function parseJsonOutput(stdout) {
  const t = String(stdout || "").replace(/^﻿/, "").trim(); if (!t) return null;
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) { const l = lines[i].trim(); if (l[0] === "{" || l[0] === "[") { try { return JSON.parse(l); } catch (_) { /* 往上找 */ } } }
  try { return JSON.parse(t); } catch (_) { return null; }
}
const hexId = (hwnd) => "0x" + Number(hwnd).toString(16).padStart(8, "0");
function parseWindowId(id) { const s = String(id == null ? "" : id).trim(); if (/^0x[0-9a-f]+$/i.test(s)) return String(parseInt(s, 16)); if (/^\d+$/.test(s)) return s; return null; }
function normalizeWindows(j) {
  if (!j || !j.ok) return [];
  const total = (j.windows || []).length;
  return j.windows.map((w) => ({
    id: hexId(w.hwnd), hwnd: w.hwnd, pid: w.pid, process: w.process, title: w.title, class: w.class, rect: w.rect, frame: w.frame, outer: w.outer,
    state: [w.minimized ? "minimized" : "", w.maximized ? "maximized" : "", w.focused ? "focused" : ""].filter(Boolean), minimized: !!w.minimized, maximized: !!w.maximized, fullscreen: false, focused: !!w.focused,
    visible: w.visible !== false, enabled: w.enabled !== false, type: w.type, owned: !!w.owned, workspace: w.desktopId || null, onCurrentDesktop: w.onCurrentDesktop !== false, z: total - w.index, source: "win32",
  }));
}

function createExec() {
  return function run(cmd, args, o) {
    o = o || {};
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: o.timeout || 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "", error: err ? (err.code === "ENOENT" ? "找不到 " + cmd : err.killed ? "逾時：" + cmd : String(err.message || err).split("\n")[0]) : "" }));
      if (o.input != null && child.stdin) { try { child.stdin.end(o.input); } catch (_) { /* */ } }
    });
  };
}
function findOnPath(name, envPath) { const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""]; for (const d of String(envPath || process.env.PATH || "").split(path.delimiter)) { if (!d) continue; for (const e of exts) { const f = path.join(d, name + (name.toLowerCase().endsWith(e.toLowerCase()) ? "" : e)); try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* */ } } } return ""; }

function createWindowsBackend(opts) {
  opts = opts || {};
  const run = opts.exec || createExec(), which = opts.which || ((n) => findOnPath(n)), be = { kind: "windows" };
  let psExe = null, dllReady = false, monitorsCache = null;
  const fail = (error, why) => ({ ok: false, error, why: why || undefined });
  async function psPath() { if (psExe !== null) return psExe; psExe = (opts.psExe || which("powershell") || which("pwsh") || ""); return psExe; }
  // 執行一段腳本（自動選 -EncodedCommand 或暫存檔）
  async function runScript(script, timeout) {
    const exe = await psPath(); if (!exe) return fail("找不到 PowerShell（powershell.exe／pwsh）", "Windows 內建 powershell.exe；請確認它在 PATH 上");
    const inv = buildPowerShellInvocation(script, { exe });
    let r, tmp = null;
    if (inv.mode === "file") { tmp = path.join(os.tmpdir(), "fa-cu-" + process.pid + "-" + crypto.randomBytes(4).toString("hex") + ".ps1"); fs.writeFileSync(tmp, "﻿" + script, "utf8"); r = await run(exe, inv.args.map((a) => (a === "<file>" ? tmp : a)), { timeout }); try { fs.unlinkSync(tmp); } catch (_) { /* */ } }
    else r = await run(exe, inv.args, { timeout });
    const j = parseJsonOutput(r.stdout);
    if (!j) return fail("PowerShell 沒有輸出 JSON：" + ((r.stderr || r.error || r.stdout || "").trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300)), r.error || undefined);
    return j;
  }
  async function ensureDll(force) { if (dllReady && !force) return { ok: true }; const j = await runScript(buildCompileScript(), 120000); if (j.ok) dllReady = true; return j; }
  // 跑一個動作：DLL 還沒有就先編一次；載入失敗（DLL 被清掉）就重編再試
  async function call(kind, params, o) {
    o = o || {}; if (!dllReady) { const e = await ensureDll(); if (!e.ok) return fail("編譯 Windows 輔助 DLL 失敗：" + (e.error || ""), e.error); }
    let j = await runScript(buildScript(kind, params, o.opt), o.timeout || 30000);
    if (!j.ok && /Add-Type|Cannot find path|找不到路徑|FaWin|FaDpi|無法載入/i.test(String(j.error || ""))) { dllReady = false; const e = await ensureDll(true); if (e.ok) j = await runScript(buildScript(kind, params, o.opt), o.timeout || 30000); }
    return j;
  }
  be.call = call; be.runScript = runScript; be.ensureDll = ensureDll;

  async function nirOk() {
    if (opts.nircmd === false) return false; const bin = which("nircmd"); if (!bin) return false;
    if (monitorsCache === null) { const m = await be.monitors(); monitorsCache = m.ok ? m.monitors : []; }
    return monitorsCache.length > 0 && monitorsCache.every((m) => !m.scale || m.scale === 1); // nircmd 不是 DPI aware
  }
  async function nir(op) { const cmds = nircmdCommands(op); if (!cmds) return null; const bin = which("nircmd"); for (const a of cmds) { const r = await run(bin, a, { timeout: 8000 }); if (!r.ok) return fail("nircmd 失敗：" + (r.stderr || r.error).trim().slice(0, 160)); } return { ok: true, via: "nircmd" }; }

  be.capabilities = async function () {
    const ps = await psPath(), nirBin = which("nircmd"), has = !!ps, yes = (via, extra) => Object.assign({ ok: true, via, unverified: true }, extra || {}), no = (r) => ({ ok: false, reason: r });
    const why = has ? "" : "找不到 PowerShell";
    const f = {
      windows: { list: has ? yes("PowerShell／C#（EnumWindows、DWM 外框、虛擬桌面 COM）", { geometry: "screen" }) : no(why), focus: has ? yes("SetForegroundWindow＋Alt 技巧") : no(why), move: has ? yes("MoveWindow（用 DWM 外框換算）") : no(why), resize: has ? yes("MoveWindow") : no(why), minimize: has ? yes("ShowWindow") : no(why), maximize: has ? yes("ShowWindow") : no(why), close: has ? yes("PostMessage WM_CLOSE") : no(why), backend: "win32" },
      input: { mouse: has ? yes("SendInput／SetCursorPos（DPI aware）") : no(why), keyboard: has ? yes("SendInput") : no(why), typeText: has ? yes("SendInput KEYEVENTF_UNICODE（中文、emoji 可）") : no(why), backend: "sendinput" },
      screenshot: { screen: has ? yes("GDI CopyFromScreen") : no(why), window: has ? yes("CopyFromScreen／PrintWindow（被蓋住也能抓）") : no(why), rect: has ? yes("CopyFromScreen") : no(why), pointer: no("Windows 後端目前不畫游標"), tool: "gdi" },
      clipboard: { get: has ? yes("Get-Clipboard") : no(why), set: has ? yes("Set-Clipboard") : no(why) },
      a11y: has ? { ok: true, via: "UI Automation（System.Windows.Automation）＋ Win32 子視窗樹", coords: "screen", unverified: true, note: "Chromium／Electron 需要啟用無障礙（--force-renderer-accessibility）才有網頁內容；UWP／WinUI 也可" } : no(why),
      x11tree: no("Windows 沒有 X11 視窗樹（改用 Win32 子視窗樹）"),
    };
    const notes = ["Windows 路徑全部是依文件與 API 簽章寫的（C# 有用 mono 編譯檢查），沒有在 Windows 上實跑過：未實測。"];
    if (nirBin) notes.push("找到 nircmd（" + nirBin + "）：只在所有螢幕縮放 100% 時用它做滑鼠／按鍵／視窗動作（nircmd 不是 DPI aware）。");
    return { platform: "windows", session: { type: "windows", desktop: "windows" }, features: f, tools: { powershell: ps, nircmd: nirBin }, missingTools: has ? [] : ["powershell"], summary: has ? "Windows：可用 視窗管理、滑鼠、鍵盤、截圖、元件樹（UI Automation）（未實測）" : "Windows：找不到 PowerShell，沒有可用的功能", notes, hints: has ? [] : ["確認 powershell.exe 在 PATH 上"] };
  };
  be.listWindows = async function (o) { const j = await call("list", {}, { opt: !!(o && o.all) }); if (!j.ok) return j; const wins = normalizeWindows(j); return { ok: true, windows: wins, activeId: j.foreground ? hexId(j.foreground) : null, backend: "win32" }; };
  be.activeWindowId = async function () { const j = await call("foreground", {}); return j.ok && j.hwnd ? hexId(j.hwnd) : null; };
  be.monitors = async function () { const j = await call("monitors", {}); if (!j.ok) return j; monitorsCache = j.monitors; return { ok: true, monitors: j.monitors }; };
  be.cursorShape = async function () { const j = await call("cursor", {}); return j.ok ? { ok: true, name: j.name, hash: String(j.handle), visible: j.visible } : fail(j.error || "讀不到游標形狀"); };
  be.pointerLocation = async function () { const j = await call("pointer", {}); return j.ok ? j : fail(j.error || "讀不到滑鼠位置"); };
  async function ops(list) { const j = await call("ops", { ops: list }, { timeout: 60000 }); return j.ok ? { ok: true, via: "powershell" } : fail(j.error || "輸入失敗"); }
  be.pointerMove = async function (x, y) { if (await nirOk()) { const r = await nir({ op: "move", x, y }); if (r) return r; } return ops([{ op: "move", x, y }]); };
  be.click = async function (x, y, o) {
    o = o || {}; const button = { left: 1, middle: 2, right: 3 }[o.button || "left"], count = Math.max(1, Math.min(3, o.count || 1));
    if (await nirOk()) { const r = await nir({ op: "click", x, y, button, count }); if (r) return r; } return ops([{ op: "click", x, y, button, count }]);
  };
  be.drag = async function (x, y, x2, y2, o) { o = o || {}; return ops([{ op: "drag", x, y, x2, y2, button: { left: 1, middle: 2, right: 3 }[o.button || "left"], steps: Math.max(2, Math.min(40, o.steps || Math.ceil(Math.hypot(x2 - x, y2 - y) / 25))) }]); };
  be.scroll = async function (x, y, dx, dy) { if (!dx || dx === 0) { if (await nirOk()) { const r = await nir({ op: "wheel", x, y, dy }); if (r) return r; } } return ops([{ op: "wheel", x, y, dx: dx || 0, dy: dy || 0 }]); };
  be.key = async function (chord) { const vks = chordToVk(chord); if (!vks) return fail("不認得的按鍵組合：" + chord); if (await nirOk()) { const r = await nir({ op: "chord", chord }); if (r) return r; } return ops([{ op: "chord", vks }]); };
  be.typeText = async function (text, o) { o = o || {}; if (o.mode === "paste") { const s = await be.clipboardSet(text); if (!s.ok) return s; await sleep(80); return be.key("ctrl+v"); } return ops([{ op: "type", text: String(text), delay: o.delayMs == null ? 10 : o.delayMs }]); };
  be.releaseAll = async function () { const j = await call("releaseAll", {}); return j.ok ? { ok: true } : j; };
  be.clipboardGet = async function () { const j = await call("clipboardGet", {}); return j.ok ? { ok: true, text: j.text, via: "Get-Clipboard" } : fail(j.error || "讀剪貼簿失敗"); };
  be.clipboardSet = async function (text) { const j = await call("clipboardSet", { text: String(text) }); return j.ok ? { ok: true, via: "Set-Clipboard" } : fail(j.error || "寫剪貼簿失敗"); };
  be.windowAction = async function (action, id, a) {
    a = a || {}; const hwnd = parseWindowId(id); if (!hwnd) return fail("視窗 id 格式不對：" + id);
    if (await nirOk()) { const r = await nir({ op: "window", action, hwnd, x: a.x, y: a.y, w: a.w, h: a.h }); if (r) return r; }
    const j = await call("windowAction", { hwnd, action, x: Math.round(a.x || 0), y: Math.round(a.y || 0), w: Math.round(a.w || 0), h: Math.round(a.h || 0) }); return j.ok ? { ok: true, via: "powershell" } : fail(j.error || action + " 失敗");
  };
  // 截圖：回傳與 Linux 後端同樣的形狀
  be.screenshot = async function (o) {
    o = o || {}; let j;
    if (o.kind === "window" && o.windowId && o.occluded) j = await call("screenshotWindow", { hwnd: parseWindowId(o.windowId) });
    else {
      let r = o.rect; if (!r) { const m = await be.monitors(); if (!m.ok) return m; const x0 = Math.min.apply(null, m.monitors.map((q) => q.rect.x)), y0 = Math.min.apply(null, m.monitors.map((q) => q.rect.y)), x1 = Math.max.apply(null, m.monitors.map((q) => q.rect.x + q.rect.w)), y1 = Math.max.apply(null, m.monitors.map((q) => q.rect.y + q.rect.h)); r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
      j = await call("screenshotRect", { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    }
    if (!j.ok) return fail(j.error || "截圖失敗");
    let png = Buffer.from(j.base64, "base64"), width = j.width, height = j.height, scale = 1;
    if (o.maxSide) { const img = PNG.decodePng(png), fw = PNG.fitWithin(img, o.maxSide); if (fw.scale !== 1) { png = PNG.encodePng(fw.img); width = fw.img.width; height = fw.img.height; scale = fw.scale; } }
    return { ok: true, png, width, height, origin: j.origin, scale: { x: scale, y: scale }, rect: { x: j.origin.x, y: j.origin.y, w: j.width, h: j.height }, tool: "gdi", pointer: false };
  };
  be.win32Tree = async function (id, o) { o = o || {}; const hwnd = parseWindowId(id); if (!hwnd) return fail("視窗 id 格式不對"); const j = await call("childTree", { hwnd, depth: o.depth == null ? 4 : o.depth, maxNodes: o.maxNodes || 300 }); return j.ok ? j : fail(j.error || "讀子視窗樹失敗"); };
  be.waitForWindow = async function (match, timeoutMs) {
    const t0 = Date.now(), re = match.regex ? new RegExp(String(match.regex), "i") : null;
    for (;;) {
      const l = await be.listWindows({ all: false });
      if (l.ok) { const w = l.windows.find((x) => (!match.title || String(x.title).toLowerCase().includes(String(match.title).toLowerCase())) && (!match.class || String(x.class).toLowerCase().includes(String(match.class).toLowerCase())) && (!match.pid || Number(x.pid) === Number(match.pid)) && (!re || re.test(x.title) || re.test(x.class))); if (w) return { ok: true, window: w, waitedMs: Date.now() - t0 }; }
      if (Date.now() - t0 >= (timeoutMs || 10000)) return fail("等不到符合的視窗（" + (timeoutMs || 10000) + " ms）");
      await sleep(400);
    }
  };
  return be;
}

module.exports = { createWindowsBackend, buildScript, buildCompileScript, buildPowerShellInvocation, wrapBody, SCRIPTS, HEADER, chordToVk, VK, nircmdCommands, parseJsonOutput, normalizeWindows, parseWindowId, hexId, psq, b64, CS_HASH, DLL_REL, ENCODED_LIMIT };
