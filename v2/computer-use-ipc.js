// computer-use-ipc.js —— computer use 的主行程接線：IPC（fa:computer:*）、原生核准視窗、範圍選擇視窗、中止快捷鍵、遠端連線機密。
// 由 main-ext.js 的 register() 呼叫（main.js 傳進 getDesktopSettings／patchDesktopSettings／secretsFile 等）。renderer 只能經過 preload 的 window.desktopAPI.computer.* 到這裡。
// 安全模型（細節見 computer-use-safety.js 與 DESIGN.computer-use.md）：
//   * 預設關閉；開啟、自動核准、指定範圍這三件「提高權限」的事一律由主行程的原生視窗讓使用者親自確認（renderer 無法自己核准自己）。
//   * 每一批動作先預覽、使用者在原生視窗核准才執行（沒有核准視窗＝拒絕）。
//   * 執行期間註冊全域快捷鍵 Ctrl+Alt+Shift+Esc 中止（只在執行期間註冊，不會長期佔用按鍵）；renderer 也有 abort IPC（Esc）。
//   * 這個 app 自己的視窗永遠不能放進範圍（避免 AI 自己按核准鈕）。
"use strict";
const path = require("path");

const ABORT_HOTKEY = "CommandOrControl+Alt+Shift+Escape";
// 這個 app 自己的視窗（核准視窗、範圍選擇視窗、主視窗）：除了 pid 比對，再加標題比對（雙保險）
const SELF_DENY = [/AI\s*要求操作電腦|AI要求執行程式|Floating\s*Assistant|FloatingAssistantApp/i];

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CSS = `body{font-family:-apple-system,"Segoe UI","Noto Sans CJK TC",sans-serif;background:#161b22;color:#e5e7eb;margin:0;padding:18px;box-sizing:border-box}h3{margin:0 0 10px 0}
.detail{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px 12px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;margin-bottom:14px}
.note{font-size:12px;color:#9ca3af;margin-bottom:12px}.buttons{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}button{padding:7px 16px;border-radius:6px;cursor:pointer;font-size:13px}
#deny{background:#21262d;color:#e5e7eb;border:1px solid #30363d}#allow{background:#c0392b;color:#fff;border:none}#auto{background:#7a4a00;color:#fff;border:none}
.row{display:flex;gap:8px;align-items:center;padding:4px 2px;font-size:13px}.row.off{opacity:.45}.dim{color:#9ca3af;font-size:11px}`;

// 範圍的保存格式：{ mode:'screen' } | { mode:'windows', windows:[{ title, process, class }] }（沒有視窗代號、沒有行程號碼：那些每次開機都不一樣）
function scopeToSaved(scope) {
  if (!scope) return null; if (scope.mode === "screen") return { mode: "screen" };
  if (scope.mode === "windows" && Array.isArray(scope.windows) && scope.windows.length) return { mode: "windows", windows: scope.windows.map((w) => ({ title: String(w.title || ""), process: String(w.process || ""), class: String(w.class || "") })) };
  return null;
}
function sanitizeSavedScope(x) {
  if (!x || typeof x !== "object") return null; if (x.mode === "screen") return { mode: "screen" };
  if (x.mode === "windows" && Array.isArray(x.windows)) { const ws = x.windows.slice(0, 20).filter((w) => w && typeof w === "object").map((w) => ({ title: String(w.title || "").slice(0, 200), process: String(w.process || "").slice(0, 100), class: String(w.class || "").slice(0, 100) })); return ws.length ? { mode: "windows", windows: ws } : null; }
  return null;
}
// 用保存的描述在現有視窗裡找：標題完全相同優先；否則同行程＋同類別而且只有一個。受保護的與助理自己的視窗不會被選（setScope 還會再擋一次）
function matchSavedWindows(saved, wins) {
  const ids = [], low = (v) => String(v || "").toLowerCase();
  for (const d of saved || []) {
    const same = (wins || []).filter((w) => !w.denied && !w.self && low(w.process) === low(d.process) && (!d.class || low(w.class) === low(d.class)));
    const exact = same.filter((w) => String(w.title) === d.title), pick = exact.length ? exact[0] : (same.length === 1 ? same[0] : null);
    if (pick && !ids.includes(String(pick.id))) ids.push(String(pick.id));
  }
  return ids;
}

function register(ipcMain, ctx) {
  ctx = ctx || {};
  const electron = ctx.electron || {};
  const BrowserWindow = ctx.BrowserWindow || electron.BrowserWindow;
  const globalShortcut = electron.globalShortcut || null;
  const userDataDir = ctx.userDataDir || (() => (electron.app ? electron.app.getPath("userData") : require("os").tmpdir()));
  const secretsFile = ctx.secretsFile || (() => path.join(userDataDir(), "secrets.json"));
  const fsSync = require("fs");
  let cu = null, initPromise = null, hotkeyOn = false, savedScope = null, scopeTriedAt = 0;
  // 設定檔（desktop-settings.json）的讀寫：舊版安裝的 main.js 沒有把 getDesktopSettings／patchDesktopSettings 傳進來（那個接線在入口檔，只能靠重新安裝更新），
  // 結果「啟用」只存在記憶體，重開就沒了（Linux 版回報過）。所以沒有傳進來時，這裡直接讀寫 userData 底下同一份檔案（淺層合併，不洗掉別的欄位）。
  const settingsPath = () => path.join(userDataDir(), "desktop-settings.json");
  const readSettings = async () => { if (ctx.getDesktopSettings) return ctx.getDesktopSettings(); try { return JSON.parse(String(fsSync.readFileSync(settingsPath(), "utf8")).replace(/^﻿/, "")) || {}; } catch (_) { return {}; } };
  const patchSettings = async (patch) => {
    if (ctx.patchDesktopSettings) return ctx.patchDesktopSettings(patch);
    const cur = await readSettings(), next = Object.assign({}, cur, patch), f = settingsPath(); fsSync.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp"; fsSync.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8"); fsSync.renameSync(tmp, f); return next;
  };
  const mainWin = () => (ctx.getMainWindow ? ctx.getMainWindow() : null);
  const emit = (type, extra) => { try { const w = mainWin(); if (w && !w.isDestroyed()) w.webContents.send("fa:computer:event", Object.assign({ type }, extra || {})); } catch (_) { /* */ } };

  // ---------- 遠端連線機密（VNC 密碼）：只存在主行程，renderer 只能「設定」不能「讀回」 ----------
  const REMOTE_KEY = "COMPUTER_REMOTE_SECRETS";
  let remoteSecrets = {};
  const loadRemoteSecrets = () => { try { const j = JSON.parse(String(fsSync.readFileSync(secretsFile(), "utf8")).replace(/^﻿/, "")); remoteSecrets = (j && typeof j[REMOTE_KEY] === "object" && j[REMOTE_KEY]) || {}; } catch (_) { remoteSecrets = {}; } };
  const saveRemoteSecrets = () => { let cur = {}; try { cur = JSON.parse(String(fsSync.readFileSync(secretsFile(), "utf8")).replace(/^﻿/, "")) || {}; } catch (_) { cur = {}; } cur[REMOTE_KEY] = remoteSecrets; fsSync.mkdirSync(path.dirname(secretsFile()), { recursive: true }); fsSync.writeFileSync(secretsFile(), JSON.stringify(cur, null, 2), { encoding: "utf8", mode: 0o600 }); try { fsSync.chmodSync(secretsFile(), 0o600); } catch (_) { /* Windows 沒有 POSIX 權限 */ } };
  const secretName = (n) => String(n || "").trim().replace(/[^\w.\-]/g, "_").slice(0, 60);
  const secrets = { get: (name) => { const n = secretName(name); if (!n) return null; const env = process.env["FA_VNC_PASSWORD_" + n.toUpperCase().replace(/[^A-Z0-9_]/g, "_")]; if (env) return env; const v = remoteSecrets[n]; return v && typeof v.password === "string" ? v.password : null; } };

  // ---------- 原生視窗 ----------
  function openWindow(html, size, title, onMsg) {
    return new Promise((resolve) => {
      if (!BrowserWindow) return resolve(null);
      const ch = "fa:computer:win:" + Date.now() + ":" + Math.random().toString(36).slice(2);
      const parent = mainWin();
      const win = new BrowserWindow(Object.assign({ width: size[0], height: size[1], modal: !!parent, resizable: true, minimizable: false, maximizable: false, title, alwaysOnTop: true, webPreferences: { nodeIntegration: true, contextIsolation: false } }, parent && !parent.isDestroyed() ? { parent } : {}));
      try { win.setMenuBarVisibility(false); } catch (_) { /* */ }
      let settled = false; const finish = (v) => { if (settled) return; settled = true; clearTimeout(tm); resolve(v); try { if (!win.isDestroyed()) win.close(); } catch (_) { /* */ } };
      const tm = setTimeout(() => finish(null), 180000); // 3 分鐘沒人理＝拒絕
      ipcMain.once(ch, (_e, v) => finish(v)); win.on("closed", () => finish(null));
      win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html.replace(/__CH__/g, JSON.stringify(ch))));
    });
  }
  // 核准視窗。回傳 { approved, auto }；allowAuto：顯示「執行並在本次工作階段不再詢問」
  async function nativeConfirm(info) {
    info = info || {}; const title = info.title || "AI 要求操作電腦";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
      <h3>⚠️ ${esc(title)}</h3>
      ${info.note ? `<div class="note">${esc(info.note)}</div>` : ""}
      <div class="detail">${esc(info.preview || "")}</div>
      <div class="note">隨時可以中止：${esc(ABORT_HOTKEY.replace("CommandOrControl", "Ctrl/Cmd"))}（全域）或在助理視窗按 Esc。範圍只限你指定的視窗；不會在密碼欄打字、不碰系統設定與付款視窗。</div>
      <div class="buttons"><button id="deny">取消</button>${info.allowAuto ? '<button id="auto">執行，且本次不再詢問（自動）</button>' : ""}<button id="allow">${esc(info.okLabel || "執行這批動作")}</button></div>
      <script>const { ipcRenderer } = require("electron"); const ch = __CH__;
        document.getElementById("deny").onclick = () => ipcRenderer.send(ch, { approved: false });
        document.getElementById("allow").onclick = () => ipcRenderer.send(ch, { approved: true });
        const a = document.getElementById("auto"); if (a) a.onclick = () => ipcRenderer.send(ch, { approved: true, auto: true });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") ipcRenderer.send(ch, { approved: false }); });
        document.getElementById("deny").focus();
      </script></body></html>`;
    const r = await openWindow(html, [640, info.tall ? 520 : 460], title);
    return r && r.approved ? { approved: true, auto: !!r.auto } : { approved: false };
  }
  // 範圍選擇視窗：列出視窗讓使用者勾選。回傳 { mode:'windows', windowIds } | { mode:'screen' } | null
  async function pickScope(list) {
    const rows = list.map((w) => { const off = w.denied || w.self; return `<label class="row ${off ? "off" : ""}"><input type="checkbox" value="${esc(w.id)}" ${off ? "disabled" : ""}> <span>${esc(w.self ? "（助理自己的視窗）" : w.denied ? "（受保護的視窗：" + w.denied.label + "）" : w.title || "（沒有標題）")}</span> <span class="dim">${esc(w.process || "")}${w.canvas ? "｜遠端畫面／畫布：" + esc(w.canvas.client) : ""}｜${w.frame ? w.frame.w + "×" + w.frame.h : ""}${w.minimized ? "｜最小化" : ""}</span></label>`; }).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
      <h3>選擇 AI 可以操作的視窗</h3><div class="note">AI 只能在這些視窗的範圍內看、點、打字；其他視窗（包含被這些視窗蓋住的位置）一律拒絕。灰色的視窗是受保護的（系統設定、驗證、密碼、付款…）或是助理自己，不能選。</div>
      <div class="detail" style="max-height:300px">${rows || "找不到可選的視窗"}</div>
      <label class="row"><input type="checkbox" id="screen"> <span>整個螢幕（不建議：AI 可以看到所有視窗的內容）</span></label>
      <div class="buttons"><button id="deny">取消</button><button id="allow">確定</button></div>
      <script>const { ipcRenderer } = require("electron"); const ch = __CH__;
        document.getElementById("deny").onclick = () => ipcRenderer.send(ch, null);
        document.getElementById("allow").onclick = () => { if (document.getElementById("screen").checked) return ipcRenderer.send(ch, { mode: "screen" }); const ids = Array.from(document.querySelectorAll("input[type=checkbox][value]")).filter((c) => c.checked).map((c) => c.value); ipcRenderer.send(ch, ids.length ? { mode: "windows", windowIds: ids } : null); };
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") ipcRenderer.send(ch, null); });
      </script></body></html>`;
    return openWindow(html, [680, 560], "AI 要求操作電腦：選擇範圍");
  }

  // ---------- 門面 ----------
  async function getCu() {
    if (cu) return cu;
    if (!initPromise) initPromise = (async () => {
      loadRemoteSecrets();
      let enabled = false, extraDeny = [];
      try { const st = await readSettings(); enabled = st && st.computerUseEnabled === true; savedScope = enabled ? sanitizeSavedScope(st && st.computerUseScope) : null; extraDeny = ((st && st.computerUseExtraDeny) || []).filter((x) => typeof x === "string" && x.length < 200).map((x) => { try { return new RegExp(x, "i"); } catch (_) { return null; } }).filter(Boolean); } catch (_) { /* 沒有設定就是預設關閉 */ }
      cu = require("./computer-use.js").create(Object.assign({ platform: process.platform, enabled, selfPids: [process.pid], safety: { extraDeny: SELF_DENY.concat(extraDeny) }, secrets, confirm: (info) => nativeConfirm({ preview: info.preview, allowAuto: !info.forceAsk && info.source !== "remote_connect", okLabel: info.source === "remote_connect" ? "連線" : info.forceAsk ? "我確認，執行" : "執行這批動作", note: info.forceAsk ? "這一步需要你親自確認（看不出焦點是不是密碼欄／遠端畫面／連線）；自動模式也一樣。" : "", tall: true }) }, ctx.cuOptions || {})); // cuOptions：測試用（注入假後端）
      if (enabled && savedScope) { try { await restoreScope(cu); } catch (_) { /* 還原不了就維持沒有範圍，使用者再選一次 */ } }
      return cu;
    })();
    return initPromise;
  }
  // ---------- 範圍的保存與還原：視窗代號每次開機都會變，所以存「標題＋行程＋類別」，開機後與之後的每次呼叫再用現有視窗對回去 ----------
  const persistScope = async (scope) => { savedScope = sanitizeSavedScope(scopeToSaved(scope)); try { await patchSettings({ computerUseScope: savedScope }); } catch (e) { console.warn("[computer-use] 存不下範圍設定：" + ((e && e.message) || e)); } };
  async function restoreScope(c) {
    if (!savedScope || !c.state().enabled) return false; scopeTriedAt = Date.now();
    if (savedScope.mode === "screen") { await c.setScope({ mode: "screen" }); return true; }
    const l = await c.listWindows({ all: true }); if (!l.ok) return false;
    const ids = matchSavedWindows(savedScope.windows, l.windows); if (!ids.length) return false;
    const r = await c.setScope({ windowIds: ids }); return !!(r && r.ok);
  }
  // 範圍是「有保存、但現在是空的」（視窗還沒開、或剛開機）→ 每隔幾秒再對一次；使用者按 /computer disable 之後 savedScope 會被清掉
  async function refreshScope(c) { try { if (savedScope && c.state().enabled && c.state().scope.mode === "none" && Date.now() - scopeTriedAt > 4000) { await restoreScope(c); emit("state"); } } catch (_) { /* */ } }
  const persistEnabled = async (on) => { try { await patchSettings({ computerUseEnabled: !!on }); } catch (e) { console.warn("[computer-use] 存不下啟用設定：" + ((e && e.message) || e)); } };
  const registerHotkey = (c) => { if (!globalShortcut || hotkeyOn) return; try { hotkeyOn = globalShortcut.register(ABORT_HOTKEY, () => { c.abort("使用者按下全域中止快捷鍵"); emit("abort", { by: "hotkey" }); }); } catch (_) { hotkeyOn = false; } };
  const unregisterHotkey = () => { if (globalShortcut && hotkeyOn) { try { globalShortcut.unregister(ABORT_HOTKEY); } catch (_) { /* */ } } hotkeyOn = false; };
  async function withRun(fn) { const c = await getCu(); emit("run-start"); registerHotkey(c); try { return await fn(c); } finally { unregisterHotkey(); emit("run-end", { aborted: c.safety.isAborted() }); } }
  const handle = (name, fn) => ipcMain.handle("fa:computer:" + name, async (evt, args) => { try { const c0 = await getCu(); if (!/^(setEnabled|setScope|pickScope|abort)$/.test(name)) await refreshScope(c0); return await fn(c0, args || {}, evt); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });

  // ----- 狀態與權限 -----
  handle("status", async (c) => Object.assign({ ok: true, platform: process.platform, abortHotkey: ABORT_HOTKEY, supported: process.platform === "win32" || process.platform === "linux" }, c.state()));
  handle("capabilities", async (c) => c.capabilities());
  handle("setEnabled", async (c, a) => {
    if (a.on) {
      const ok = await nativeConfirm({ title: "AI 要求操作電腦：啟用", okLabel: "啟用", preview: "要讓 AI 助理使用「電腦操作」功能嗎？\n\n啟用之後：\n• AI 可以在你指定的視窗內截圖、讀取元件、點擊與打字（每一批動作都會先給你預覽、等你核准）\n• 你可以隨時中止；不會在密碼欄打字、不碰系統設定與付款視窗\n• 重新啟動助理後仍是啟用狀態，但範圍（哪些視窗）每次都要重新指定\n\n你可以隨時用 /computer disable 關閉。" });
      if (!ok.approved) return { ok: false, error: "使用者沒有啟用", refused: true };
      await persistEnabled(true); c.setEnabled(true); emit("state"); return Object.assign({ ok: true }, c.state());
    }
    c.setEnabled(false); await persistEnabled(false); await persistScope(null); unregisterHotkey(); emit("state"); return Object.assign({ ok: true }, c.state());
  });
  handle("setAuto", async (c, a) => {
    if (!c.state().enabled) return { ok: false, error: "先啟用電腦操作功能" };
    if (a.on) { const ok = await nativeConfirm({ title: "AI 要求操作電腦：自動核准", okLabel: "開啟自動核准", preview: "要在「本次工作階段」開啟自動核准嗎？\n\n開啟後，範圍內、焦點已驗證的點擊／滑鼠／按鍵不再逐批詢問。\n仍然會問你：看不出焦點是不是密碼欄的打字、遠端畫面的打字、連線到遠端。\n仍然有效：範圍限制、拒絕清單、速率限制、中止。\n重新啟動助理或中止之後會自動關閉。" }); if (!ok.approved) return { ok: false, error: "使用者沒有開啟自動核准", refused: true }; }
    c.setAuto(!!a.on); emit("state"); return Object.assign({ ok: true }, c.state());
  });
  handle("pickScope", async (c) => {
    if (!c.state().enabled) return { ok: false, error: "先啟用電腦操作功能（/computer enable）" };
    const l = await c.listWindows({ all: false }); if (!l.ok) return l;
    const pick = await pickScope(l.windows); if (!pick) return { ok: false, error: "使用者沒有選擇範圍", refused: true };
    const r = await c.setScope(pick.mode === "screen" ? { mode: "screen" } : { windowIds: pick.windowIds }); if (r && r.ok) await persistScope(c.state().scope); emit("state"); return r;
  });
  handle("setScope", async (c, a) => {
    if (!c.state().enabled) return { ok: false, error: "先啟用電腦操作功能（/computer enable）" };
    let desc = "整個螢幕（AI 可以看到所有視窗）"; if (a.mode !== "screen") { const l = await c.listWindows({ all: true }); desc = (a.windowIds || []).map((id) => { const w = l.ok && l.windows.find((x) => String(x.id) === String(id)); return "• " + (w ? (w.denied ? "（受保護的視窗）" : w.title) + "（" + w.process + "）" : id); }).join("\n"); }
    const ok = await nativeConfirm({ title: "AI 要求操作電腦：指定範圍", okLabel: "允許這些視窗", preview: "AI 想把操作範圍設成：\n" + desc });
    if (!ok.approved) return { ok: false, error: "使用者拒絕了這個範圍", refused: true };
    const r = await c.setScope(a.mode === "screen" ? { mode: "screen" } : { windowIds: a.windowIds || [] }); if (r && r.ok) await persistScope(c.state().scope); emit("state"); return r;
  });
  handle("abort", async (c, a) => { const r = await c.abort(a.reason || "使用者中止"); emit("abort", { by: "renderer" }); return r; });
  handle("resume", async (c) => { if (!c.state().enabled) return { ok: false, error: "尚未啟用" }; c.resume(); emit("state"); return Object.assign({ ok: true }, c.state()); });
  handle("addDeny", async (c, a) => { const pat = String(a.pattern || "").slice(0, 200); if (!pat) return { ok: false, error: "缺少 pattern" }; try { new RegExp(pat, "i"); } catch (e) { return { ok: false, error: "不是合法的正規表示式" }; } c.safety.addDeny(pat); try { const st = await readSettings(); const list = Array.from(new Set(((st && st.computerUseExtraDeny) || []).concat(pat))); await patchSettings({ computerUseExtraDeny: list }); } catch (_) { /* */ } return { ok: true }; });

  // ----- 唯讀 -----
  handle("listWindows", (c, a) => c.listWindows(a));
  handle("screenshot", (c, a) => c.screenshot(a));
  handle("cropShot", (c, a) => c.cropShot(a.shotId, a.rect, a));
  handle("diffShots", (c, a) => c.diffShots(a.a, a.b, a));
  handle("uiTree", (c, a) => c.uiTree(a));
  handle("findElements", (c, a) => c.findElements(a));
  handle("elementAt", (c, a) => c.elementAt(a));
  handle("elementInfo", (c, a) => c.elementInfo(a.id));
  handle("wait", (c, a) => c.wait(a));
  handle("sample", (c, a) => c.sample(a));
  handle("calibrate", (c, a) => c.calibrate(a));
  // ----- 動作 -----
  handle("plan", (c, a) => c.plan(a.steps, { source: "tool" }));
  handle("execute", (_c, a) => withRun((c) => c.execute(a.planId, { screenshotAfter: !!a.screenshotAfter, maxSide: a.maxSide })));
  handle("run", (_c, a) => withRun((c) => c.run(a.steps, { source: "tool", screenshotAfter: !!a.screenshotAfter, maxSide: a.maxSide })));
  // ----- 遠端畫面 -----
  handle("remoteProbe", (c, a) => c.remoteProbe(a.target));
  handle("remoteConnect", (_c, a) => withRun((c) => c.remoteConnect(a)));
  handle("remoteDisconnect", (c, a) => c.remoteDisconnect(a.id));
  handle("remoteList", (c) => c.remoteList());
  handle("remoteObjects", (c, a) => c.remoteObjects(a.id, a));
  // ----- 機密：只能設定／刪除／列名稱，絕不回傳值 -----
  handle("setRemoteSecret", async (_c, a) => { const n = secretName(a.name); if (!n) return { ok: false, error: "需要名稱" }; if (typeof a.password !== "string" || !a.password) return { ok: false, error: "需要密碼" }; remoteSecrets[n] = { password: a.password, updated: Date.now() }; saveRemoteSecrets(); return { ok: true, name: n }; });
  handle("deleteRemoteSecret", async (_c, a) => { const n = secretName(a.name); delete remoteSecrets[n]; saveRemoteSecrets(); return { ok: true }; });
  handle("listRemoteSecrets", async () => ({ ok: true, names: Object.keys(remoteSecrets), env: "也可用環境變數 FA_VNC_PASSWORD_<名稱大寫>" }));

  if (electron.app && electron.app.on) electron.app.on("will-quit", () => { unregisterHotkey(); if (cu) { try { cu.setEnabled(false); } catch (_) { /* */ } } });
  return { getCu, nativeConfirm, secrets, ABORT_HOTKEY };
}

module.exports = { register, ABORT_HOTKEY, SELF_DENY, scopeToSaved, sanitizeSavedScope, matchSavedWindows };
