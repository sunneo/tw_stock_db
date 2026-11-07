// computer-use-safety.js —— computer use 的安全政策（純邏輯，不碰系統，可以單獨測試）。
// 原則（對應 DESIGN.TODO.four-directions.md §3「安全」）：
//   1. 預設關閉（desktop-settings.json 的 computerUseEnabled；開啟要使用者在原生視窗確認，見 computer-use-ipc.js）。
//   2. 每一批動作先產生預覽（做什麼、在哪裡、哪個視窗），使用者核准才執行；使用者本次工作階段自己打開「自動核准」才例外——
//      而且「無法確認焦點是不是密碼欄」的打字動作，即使在自動模式也一定要問。
//   3. 隨時可以中止（abort）：中止後整批停止、放開按住的滑鼠鍵與修飾鍵，之後一律拒絕，直到使用者重新啟用。
//   4. 範圍限定在使用者選的視窗：動作座標必須落在該視窗「現在的」矩形內，而且那一點最上面的視窗就是它（被別的視窗蓋住就拒絕）。
//   5. 絕不在密碼欄打字（AT-SPI role=password text／UIA IsPassword）；不碰系統設定、付款、驗證／提權視窗（依視窗標題／類別／行程名稱的拒絕清單）；
//      這個 app 自己的視窗也不碰（不然 AI 可以自己按下核准鈕）。
//   6. 速率限制：每批步數、每分鐘動作數、動作最小間隔、單次打字長度、整個工作階段總量、連續失敗次數。
"use strict";

// ---------- 封閉詞彙：動作（op） ----------
// kind：input＝送出滑鼠／鍵盤；window＝視窗管理；element＝透過無障礙 API 操作元件；clipboard；wait
const OPS = {
  move: { kind: "input", point: true }, click: { kind: "input", point: true }, double_click: { kind: "input", point: true },
  right_click: { kind: "input", point: true }, middle_click: { kind: "input", point: true },
  drag: { kind: "input", point: true, point2: true }, scroll: { kind: "input", point: true },
  hover_probe: { kind: "input", point: true }, // 探索用：把滑鼠移到這一點、拍照、比對游標形狀與周圍變化（只移動，不點擊）
  type: { kind: "input", typing: true }, key: { kind: "input", typing: true },
  window_focus: { kind: "window" }, window_move: { kind: "window" }, window_resize: { kind: "window" }, window_minimize: { kind: "window" },
  window_maximize: { kind: "window" }, window_restore: { kind: "window" }, window_close: { kind: "window", destructive: true },
  element_invoke: { kind: "element" }, element_set_value: { kind: "element", typing: true }, element_toggle: { kind: "element" },
  element_select: { kind: "element" }, element_focus: { kind: "element" },
  clipboard_set: { kind: "clipboard" }, wait: { kind: "wait" },
};
const BUTTONS = ["left", "right", "middle"];
const WINDOW_ACTIONS = ["focus", "move", "resize", "minimize", "maximize", "restore", "close"];
const ELEMENT_ACTIONS = ["invoke", "set_value", "toggle", "select", "focus"];

const DEFAULT_LIMITS = Object.freeze({ maxStepsPerBatch: 25, maxActionsPerMinute: 90, minIntervalMs: 40, maxTypeChars: 400, maxSessionActions: 1000, maxConsecutiveErrors: 5, maxWaitMs: 15000, maxDragPx: 5000, approvalTtlMs: 120000 });

// ---------- 拒絕清單（視窗標題／類別／行程名稱） ----------
// fields：要比對的欄位。刻意偏保守——寧可誤擋也不要碰到系統設定、付款、驗證視窗。
const DENY_RULES = Object.freeze([
  { id: "system-settings", label: "系統設定", fields: ["process", "class"], re: /(gnome-control-center|systemsettings5?|systemsettings\b|xfce4-settings-(manager|editor)|xfce4-(power|session|display)-?(manager)?-?settings|cinnamon-settings|mate-control-center|lxqt-config|SystemSettings\.exe|control\.exe|mmc\.exe|regedit\.exe|msconfig|gpedit|secpol|lusrmgr|compmgmt|sysdm\.cpl|ms-settings|Windows\.UI\.Core\.CoreWindow.*Settings|dconf-editor|nm-connection-editor|nm-applet|gnome-initial-setup|software-properties|synaptic|gparted|timeshift|ufw|gufw|firewall-config)/i },
  { id: "auth-elevation", label: "驗證／提權視窗", fields: ["title", "class", "process"], re: /(polkit|pkexec|gksu|kdesu|lxpolkit|policykit|consent\.exe|LogonUI|CredentialUIBroker|CredentialUI|User Account Control|使用者帳戶控制|Authentication Required|需要驗證|需要認證|請輸入.{0,6}密碼|輸入密碼|authenticate|sudo\b|unlock (your )?(keyring|login|screen)|解鎖|Windows 安全性|Windows Security|lockapp|screensaver|xscreensaver|light-locker|gnome-screensaver|swaylock)/i },
  { id: "password", label: "密碼／憑證", fields: ["title", "process"], re: /(password|passwd|passphrase|密碼|口令|憑證管理|credential manager|keepass|bitwarden|1password|lastpass|dashlane|keychain|seahorse|gnome-keyring|kwalletmanager|passwords and keys|密碼與金鑰|enpass|pass-?word-?manager)/i },
  { id: "payment", label: "付款／金融", fields: ["title", "process"], re: /(付款|結帳|結算|收銀|checkout|payment|paypal|credit card|信用卡|wire transfer|轉帳|匯款|網路銀行|網銀|行動銀行|e-?banking|online banking|internet banking|stripe|綠界|藍新|街口|line ?pay|apple ?pay|google ?pay|alipay|支付寶|wechat ?pay|metamask|ledger live|trezor|binance|coinbase|錢包|wallet|股票下單|下單)/i },
]);

// 不准送出的按鍵組合（切換虛擬終端、鎖定、叫出系統層功能、切到範圍外的視窗…）。chord 已正規化為小寫、以 + 連接。
const DENY_CHORDS = Object.freeze([
  { re: /^ctrl\+alt\+(delete|del|backspace)$/, why: "系統層組合鍵（登出／重開）" },
  { re: /^ctrl\+alt\+f([1-9]|1[0-2])$/, why: "切換虛擬終端機" },
  { re: /^ctrl\+shift\+escape$/, why: "叫出工作管理員" },
  { re: /^ctrl\+escape$/, why: "叫出系統功能表" },
  { re: /(^|\+)(super|win|meta|cmd)(\+|$)/, why: "Super／Windows 鍵會叫出範圍外的系統功能" },
  { re: /^alt\+(tab|escape|f2|f1)$|^alt\+shift\+tab$/, why: "會把焦點切到範圍外的視窗或叫出執行對話框" },
  { re: /^ctrl\+alt\+(t|l)$/, why: "開新終端機／鎖定畫面" },
  { re: /^(xf86|sysrq|print)/, why: "系統媒體／偵錯鍵" },
]);
// 會「輸入字元」的組合：單一可印字元、shift+字元、貼上
function isTypingChord(chord) {
  const c = String(chord || "").toLowerCase(), parts = c.split("+"), last = parts[parts.length - 1], mods = parts.slice(0, -1);
  if (/^(ctrl\+v|shift\+insert|ctrl\+shift\+v)$/.test(c)) return true; // 貼上也會把字送進欄位
  const plain = !mods.some((m) => m === "ctrl" || m === "alt" || m === "super");
  return plain && (last.length === 1 || last === "space");
}

// 按鍵名稱正規化：把各種寫法收斂成小寫 + 連接、固定的別名（Enter→return…）
const KEY_ALIASES = { enter: "return", esc: "escape", del: "delete", ins: "insert", pgup: "prior", pageup: "prior", page_up: "prior", pgdn: "next", pagedown: "next", page_down: "next", control: "ctrl", ctl: "ctrl", option: "alt", opt: "alt", command: "super", cmd: "super", win: "super", windows: "super", meta: "super", spacebar: "space", " ": "space", back_space: "backspace", bksp: "backspace", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", return_: "return" };
function normalizeChord(keys) {
  const raw = String(keys == null ? "" : keys).trim(); if (!raw) return "";
  const parts = raw.split(/\s*\+\s*/).filter((p) => p !== ""); const hadPlusKey = /\+\s*\+$/.test(raw) || raw === "+";
  if (hadPlusKey) parts.push("plus");
  return parts.map((p) => { const k = p.trim().toLowerCase(); return KEY_ALIASES[k] || k; }).join("+");
}
const MODIFIERS = ["ctrl", "alt", "shift", "super"];

function denyMatch(win, extra) {
  if (!win) return null;
  const fields = { title: String(win.title || ""), class: String(win.class || win.className || ""), process: String(win.process || win.processName || "") };
  for (const r of DENY_RULES.concat((extra || []).map((x, i) => ({ id: "user-" + i, label: "使用者自訂", fields: ["title", "class", "process"], re: x.re || x })))) {
    for (const f of r.fields) if (fields[f] && r.re.test(fields[f])) return { rule: r.id, label: r.label, field: f, value: fields[f].slice(0, 60) };
  }
  return null;
}

// 這一點最上面的視窗（windows 內含 z：越大越上面；沒有 z 就用陣列順序「後面的在上面」）。最小化／隱藏的不算。
function topmostAt(windows, x, y) {
  let best = null, bz = -Infinity;
  (windows || []).forEach((w, i) => {
    if (!w || w.minimized || w.hidden) return;
    const r = w.frame || w.rect; if (!r || !(x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h)) return;
    const z = w.z != null ? w.z : i; if (z >= bz) { bz = z; best = w; }
  });
  return best;
}

function createSafety(opts) {
  opts = opts || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {}), now = opts.now || (() => Date.now()), extraDeny = (opts.extraDeny || []).slice();
  const selfPids = new Set((opts.selfPids || []).map(Number));
  const st = { enabled: !!opts.enabled, auto: false, scope: { mode: "none", windows: [], rfb: [] }, aborted: false, abortReason: "", sessionActions: 0, consecutiveErrors: 0, recent: [], lastActionAt: 0, running: false, log: [] };
  const logEv = (ev) => { st.log.push(Object.assign({ t: now() }, ev)); if (st.log.length > 200) st.log.shift(); };

  const api = {
    limits, DENY_RULES, OPS,
    state() { return { enabled: st.enabled, auto: st.auto, scope: JSON.parse(JSON.stringify(st.scope)), aborted: st.aborted, abortReason: st.abortReason, sessionActions: st.sessionActions, running: st.running, limits }; },
    setEnabled(on) { st.enabled = !!on; if (!on) { st.auto = false; st.scope = { mode: "none", windows: [], rfb: [] }; } if (on) { st.aborted = false; st.abortReason = ""; st.sessionActions = 0; st.consecutiveErrors = 0; } logEv({ ev: "enabled", on: !!on }); },
    setAuto(on) { st.auto = !!on && st.enabled; logEv({ ev: "auto", on: st.auto }); return st.auto; },
    // scope：{ mode:'windows', windows:[{id,title,pid,class,process}] } | { mode:'screen' } | { rfb:[sessionId…] }
    setScope(sc) {
      sc = sc || {}; const mode = sc.mode === "screen" ? "screen" : (sc.windows && sc.windows.length) || (sc.rfb && sc.rfb.length) ? "windows" : "none";
      st.scope = { mode, windows: (sc.windows || []).map((w) => ({ id: String(w.id), title: String(w.title || ""), pid: w.pid == null ? null : Number(w.pid), class: String(w.class || ""), process: String(w.process || "") })), rfb: (sc.rfb || []).map(String) };
      logEv({ ev: "scope", mode, n: st.scope.windows.length });
    },
    addRfbScope(id) { if (!st.scope.rfb.includes(String(id))) st.scope.rfb.push(String(id)); if (st.scope.mode === "none") st.scope.mode = "windows"; },
    removeRfbScope(id) { st.scope.rfb = st.scope.rfb.filter((x) => x !== String(id)); },
    scope() { return JSON.parse(JSON.stringify(st.scope)); },
    inScope(winId) { return st.scope.mode === "screen" || st.scope.windows.some((w) => w.id === String(winId)); },
    rfbInScope(id) { return st.scope.rfb.includes(String(id)); },
    // ----- 中止 -----
    abort(reason) { st.aborted = true; st.abortReason = String(reason || "使用者中止"); st.auto = false; logEv({ ev: "abort", reason: st.abortReason }); return { aborted: true }; },
    isAborted() { return st.aborted; },
    resume() { st.aborted = false; st.abortReason = ""; st.consecutiveErrors = 0; logEv({ ev: "resume" }); },
    setRunning(on) { st.running = !!on; },
    // ----- 速率 -----
    // 回傳 { ok, waitMs, reason }：呼叫端在每一個動作「之前」呼叫；ok:true 時 waitMs>0 代表要先等這麼久
    rateCheck() {
      const t = now(); st.recent = st.recent.filter((x) => t - x < 60000);
      if (st.sessionActions >= limits.maxSessionActions) return { ok: false, reason: "本次工作階段的動作總量已達上限（" + limits.maxSessionActions + "），請重新啟用" };
      if (st.recent.length >= limits.maxActionsPerMinute) return { ok: false, reason: "每分鐘動作數已達上限（" + limits.maxActionsPerMinute + "）", waitMs: 60000 - (t - st.recent[0]) };
      const wait = Math.max(0, limits.minIntervalMs - (t - st.lastActionAt));
      return { ok: true, waitMs: wait };
    },
    rateNote() { const t = now(); st.recent.push(t); st.lastActionAt = t; st.sessionActions++; },
    noteResult(ok) { st.consecutiveErrors = ok ? 0 : st.consecutiveErrors + 1; if (st.consecutiveErrors >= limits.maxConsecutiveErrors) { api.abort("連續失敗 " + st.consecutiveErrors + " 次，自動中止"); return false; } return true; },
    denyMatch(win) { return denyMatch(win, extraDeny); },
    addDeny(re) { extraDeny.push(re instanceof RegExp ? re : new RegExp(String(re), "i")); },
    log() { return st.log.slice(); },

    // ----- 唯讀操作（螢幕截圖、控制項樹、元素搜尋）的檢查 -----
    // what：{ kind:'window'|'rect'|'point'|'screen', windowId, rect, x, y }；ctx：{ windows:[…] }
    checkRead(what, ctx) {
      if (!st.enabled) return refuse("disabled", "電腦操作功能沒有啟用（/computer enable）");
      if (st.aborted) return refuse("aborted", "已中止：" + st.abortReason);
      if (st.scope.mode === "none") return refuse("no_scope", "還沒有指定範圍視窗（/computer scope）");
      const wins = (ctx && ctx.windows) || [];
      if (what.kind === "screen") return st.scope.mode === "screen" ? ok() : refuse("scope", "範圍不是整個螢幕：請改指定視窗，或請使用者把範圍設成「整個螢幕」");
      if (what.kind === "window") {
        const w = wins.find((x) => String(x.id) === String(what.windowId)); if (!w) return refuse("no_window", "找不到視窗 " + what.windowId);
        if (!api.inScope(w.id)) return refuse("scope", "視窗「" + (w.title || w.id) + "」不在使用者指定的範圍內");
        const d = api.denyMatch(w); if (d) return refuse("denied", "視窗「" + (w.title || w.id) + "」屬於拒絕清單（" + d.label + "）");
        if (isSelf(w)) return refuse("denied", "不碰助理自己的視窗");
        return ok({ window: w });
      }
      if (what.kind === "point") {
        const w = topmostAt(wins, what.x, what.y); if (!w) return refuse("no_window", "這個座標沒有任何視窗（桌面）");
        const r = api.checkRead({ kind: "window", windowId: w.id }, ctx); return r.ok ? ok({ window: w }) : r;
      }
      if (what.kind === "rect") {
        const corners = [[what.rect.x, what.rect.y], [what.rect.x + what.rect.w - 1, what.rect.y + what.rect.h - 1], [what.rect.x + what.rect.w / 2, what.rect.y + what.rect.h / 2]];
        for (const [x, y] of corners) { const r = api.checkRead({ kind: "point", x, y }, ctx); if (!r.ok) return r; }
        return ok({});
      }
      return refuse("bad_request", "不認得的讀取種類");
    },

    // ----- 動作批次的檢查（核心） -----
    // steps：[{op,…, _resolved?:{point?,point2?,window?}}]；ctx：{ windows, activeWindowId, focus:{known,isPassword,role}, remote:{[id]:{…}} }
    // 回傳 { ok, refused:[…], steps:[{index, op, ok, code, reason, warnings, description?}], needsApproval, forceAsk, summary }
    evaluate(steps, ctx) {
      ctx = ctx || {}; let wins = (ctx.windows || []).slice(); const out = []; let allOk = true, forceAsk = false, zTop = wins.reduce((m, w, i) => Math.max(m, w && w.z != null ? w.z : i), 0); // wins 在批次裡會被模擬：window_focus／restore 會把視窗拉到最上面，後面的點擊才看得到它
      const fail = (i, op, code, reason) => { allOk = false; out.push({ index: i, op, ok: false, code, reason, warnings: [] }); };
      if (!st.enabled) { return { ok: false, steps: [], refused: [{ code: "disabled", reason: "電腦操作功能沒有啟用（/computer enable）" }], needsApproval: true, forceAsk: true }; }
      if (st.aborted) { return { ok: false, steps: [], refused: [{ code: "aborted", reason: "已中止：" + st.abortReason + "（/computer enable 重新啟用）" }], needsApproval: true, forceAsk: true }; }
      if (st.scope.mode === "none") { return { ok: false, steps: [], refused: [{ code: "no_scope", reason: "還沒有指定範圍視窗，請使用者先用 /computer scope 選視窗" }], needsApproval: true, forceAsk: true }; }
      if (!Array.isArray(steps) || !steps.length) return { ok: false, steps: [], refused: [{ code: "empty", reason: "沒有動作" }], needsApproval: true, forceAsk: true };
      if (steps.length > limits.maxStepsPerBatch) return { ok: false, steps: [], refused: [{ code: "too_many", reason: "一批最多 " + limits.maxStepsPerBatch + " 個動作（收到 " + steps.length + "）" }], needsApproval: true, forceAsk: true };
      let typedTotal = 0, activeId = ctx.activeWindowId != null ? String(ctx.activeWindowId) : null, focusStale = false; // 同一批裡前面的點擊／切換焦點會改變「接下來打字的對象」：計畫階段模擬，真正的密碼欄檢查延到執行前
      steps.forEach((s, i) => {
        const op = s && s.op, def = OPS[op];
        if (!def) return fail(i, op, "bad_op", "不認得的動作 " + JSON.stringify(op) + "；可用：" + Object.keys(OPS).join("、"));
        const warnings = [];
        // 遠端（RFB）目標：範圍是連線本身
        if (s.target && /^rfb:/.test(String(s.target))) {
          if (!api.rfbInScope(s.target)) return fail(i, op, "scope", "遠端連線 " + s.target + " 不在範圍內（要先 remote_connect 並由使用者核准）");
          if (def.kind === "window" || def.kind === "element" || def.kind === "clipboard") { return fail(i, op, "unsupported", "遠端 RFB 目標只支援滑鼠、鍵盤、等待"); }
          if (def.typing) { forceAsk = true; warnings.push("遠端畫面看不出焦點是不是密碼欄：打字一律需要你親自核准（自動模式也一樣）"); }
          const bad = checkParams(s, def, ctx.remote && ctx.remote[s.target]); if (bad) return fail(i, op, "bad_param", bad);
          if (def.typing) typedTotal += String(s.text || s.keys || "").length;
          out.push({ index: i, op, ok: true, warnings, target: s.target }); return;
        }
        const bad = checkParams(s, def, null); if (bad) return fail(i, op, "bad_param", bad);
        if (def.kind === "wait") { out.push({ index: i, op, ok: true, warnings }); return; }
        if (def.kind === "clipboard") {
          warnings.push("會改掉剪貼簿內容（之後貼上才會用到）"); out.push({ index: i, op, ok: true, warnings }); return;
        }
        // 找出這個動作作用的視窗
        let win = null;
        if (def.kind === "window") {
          win = wins.find((x) => String(x.id) === String(s.id || s.window));
          if (!win) return fail(i, op, "no_window", "找不到視窗 " + (s.id || s.window));
        } else if (def.kind === "element") {
          const r = s._resolved || {}; win = r.window || (r.element && r.element.window ? wins.find((x) => String(x.id) === String(r.element.window)) : null);
          if (!win && r.point) win = topmostAt(wins, r.point.x, r.point.y);
          if (!win) return fail(i, op, "no_window", "找不到這個元件所屬的視窗");
          if (r.element && r.element.isPassword && (op === "element_set_value")) return fail(i, op, "password", "不在密碼欄輸入文字");
          if (op === "element_set_value") { typedTotal += String(s.value == null ? "" : s.value).length; if (r.element && r.element.role === "password") return fail(i, op, "password", "不在密碼欄輸入文字"); }
          // 無障礙動作沒有座標，但元件的矩形一樣要落在視窗內
          if (r.element && r.element.rect && win && !(win.frame || win.rect)) warnings.push("看不到視窗矩形，無法確認元件位置");
        } else if (op === "type" || op === "key") {
          win = activeId != null ? wins.find((x) => String(x.id) === activeId) : null;
          if (!win) return fail(i, op, "no_focus", "目前沒有焦點視窗（請先 window_focus 範圍內的視窗）");
        } else if (def.point) {
          const px = Number(s.x), py = Number(s.y); win = topmostAt(wins, px, py);
          if (!win) return fail(i, op, "no_window", "座標 (" + px + "," + py + ") 沒有任何視窗（桌面或螢幕外）");
          if (def.point2) {
            const w2 = topmostAt(wins, Number(s.x2), Number(s.y2));
            if (!w2) return fail(i, op, "no_window", "拖曳終點 (" + s.x2 + "," + s.y2 + ") 沒有任何視窗");
            if (!api.inScope(w2.id)) return fail(i, op, "scope", "拖曳終點落在範圍外的視窗「" + (w2.title || w2.id) + "」");
            const d2 = api.denyMatch(w2); if (d2) return fail(i, op, "denied", "拖曳終點的視窗「" + (w2.title || w2.id) + "」屬於拒絕清單（" + d2.label + "）");
            if (isSelf(w2)) return fail(i, op, "denied", "不碰助理自己的視窗");
            if (Math.hypot(Number(s.x2) - px, Number(s.y2) - py) > limits.maxDragPx) return fail(i, op, "bad_param", "拖曳距離過大");
          }
        }
        if (!win) return fail(i, op, "no_window", "找不到作用的視窗");
        if (!api.inScope(win.id)) return fail(i, op, "scope", "視窗「" + (win.title || win.id) + "」不在使用者指定的範圍內" + (def.point ? "（這個座標最上面的視窗是它，可能被別的視窗蓋住）" : ""));
        const d = api.denyMatch(win); if (d) return fail(i, op, "denied", "視窗「" + (win.title || win.id) + "」屬於拒絕清單（" + d.label + "：" + d.field + "＝" + d.value + "）");
        if (isSelf(win)) return fail(i, op, "denied", "不碰助理自己的視窗（避免自己按下核准鈕）");
        if (win.minimized && op !== "window_restore" && op !== "window_focus") return fail(i, op, "minimized", "視窗「" + (win.title || win.id) + "」是最小化的，先 window_restore");
        if (def.destructive) warnings.push("會關閉視窗，未存檔的內容可能遺失");
        if (def.typing) {
          if (op === "key") {
            const chord = normalizeChord(s.keys); const dc = DENY_CHORDS.find((c) => c.re.test(chord)); if (dc) return fail(i, op, "denied_key", "不送出 " + chord + "：" + dc.why);
            if (chord === "alt+f4") warnings.push("Alt+F4 會關閉視窗");
          }
          const typingLike = op === "type" || op === "element_set_value" || isTypingChord(normalizeChord(s.keys));
          if (typingLike) {
            const f = ctx.focus;
            if (focusStale) warnings.push("前面的步驟會改變焦點：執行前才會檢查焦點是不是密碼欄（看不出來就會停下來問你）");
            else {
              if (f && f.known && f.isPassword) return fail(i, op, "password", "目前焦點是密碼欄，不輸入文字");
              if (!f || !f.known) { forceAsk = true; warnings.push("看不出焦點元件是不是密碼欄（沒有無障礙資訊）：打字需要你親自核准，自動模式也一樣"); }
            }
          }
          if (op === "type") typedTotal += String(s.text || "").length;
        }
        out.push({ index: i, op, ok: true, warnings, window: { id: win.id, title: win.title, class: win.class, process: win.process, pid: win.pid } });
        if (op === "window_focus" || op === "window_restore") { const wid = String(win.id); wins = wins.map((w) => (String(w.id) === wid ? Object.assign({}, w, { z: ++zTop, minimized: false }) : w)); }
        if (op === "window_focus" || (def.point && op !== "move" && op !== "scroll" && op !== "hover_probe")) { activeId = String(win.id); focusStale = true; }
        else if ((op === "window_close" || op === "window_minimize") && String(win.id) === activeId) { activeId = null; }
      });
      if (typedTotal > limits.maxTypeChars * 3) { allOk = false; out.push({ index: -1, op: "type", ok: false, code: "too_much_text", reason: "一批的打字總量過大", warnings: [] }); }
      const refused = out.filter((x) => !x.ok).map((x) => ({ index: x.index, op: x.op, code: x.code, reason: x.reason }));
      return { ok: allOk, steps: out, refused, forceAsk, needsApproval: !(st.auto && !forceAsk), auto: st.auto };
    },
  };

  function isSelf(w) { return !!w && w.pid != null && selfPids.has(Number(w.pid)); }
  function ok(extra) { return Object.assign({ ok: true }, extra || {}); }
  function refuse(code, reason) { return { ok: false, code, reason }; }
  // 參數檢查（型別、範圍、詞彙）
  function checkParams(s, def, remote) {
    const num = (v) => typeof v === "number" ? Number.isFinite(v) : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
    if (def.point) { if (!num(s.x) || !num(s.y)) return "需要數字座標 x、y（螢幕座標，像素）"; if (def.point2 && (!num(s.x2) || !num(s.y2))) return "拖曳需要 x2、y2"; if (remote && remote.width && (Number(s.x) < 0 || Number(s.y) < 0 || Number(s.x) >= remote.width || Number(s.y) >= remote.height)) return "座標超出遠端畫面（" + remote.width + "×" + remote.height + "）"; }
    if (s.op === "scroll" && !(num(s.dy || 0) && num(s.dx || 0))) return "scroll 需要數字 dx／dy（格數，正＝下／右）";
    if (s.op === "type") { if (typeof s.text !== "string" || !s.text) return "type 需要 text"; if (s.text.length > limits.maxTypeChars) return "一次最多輸入 " + limits.maxTypeChars + " 個字元（收到 " + s.text.length + "）；請分批"; }
    if (s.op === "key") { const c = normalizeChord(s.keys); if (!c) return "key 需要 keys（例如 ctrl+s、Enter、alt+Left）"; if (!/^[a-z0-9_+\-]+$/.test(c) || c.length > 60) return "按鍵名稱格式不對：" + String(s.keys).slice(0, 30); }
    if (s.op === "wait") { if (!num(s.ms) || Number(s.ms) < 0 || Number(s.ms) > limits.maxWaitMs) return "wait 的 ms 要在 0～" + limits.maxWaitMs; }
    if (s.button != null && !BUTTONS.includes(s.button)) return "button 只能是 " + BUTTONS.join("／");
    if (def.kind === "window") { if (!(s.id || s.window)) return "視窗動作需要 id"; if (s.op === "window_move" && (!num(s.x) || !num(s.y))) return "window_move 需要 x、y"; if (s.op === "window_resize" && (!num(s.w) || !num(s.h) || Number(s.w) < 50 || Number(s.h) < 50)) return "window_resize 需要 w、h（至少 50）"; }
    if (def.kind === "element") { if (!s.element) return "元件動作需要 element（元件 id）"; if (s.op === "element_set_value" && typeof s.value !== "string" && typeof s.value !== "number") return "element_set_value 需要 value"; if (s.op === "element_set_value" && String(s.value).length > limits.maxTypeChars) return "value 太長"; }
    if (s.op === "clipboard_set") { if (typeof s.text !== "string") return "clipboard_set 需要 text"; if (s.text.length > 20000) return "剪貼簿文字過長"; }
    return "";
  }
  return api;
}

// ---------- 預覽文字 ----------
// 每個步驟一行，說清楚「做什麼、在哪裡、哪個視窗」；給原生確認視窗與 AI 工具的回傳用。
function describeStep(s, info) {
  info = info || {}; const w = info.window, where = w ? "，視窗「" + String(w.title || w.id).slice(0, 50) + "」" + (w.process ? "（" + w.process + "）" : "") : "";
  const pt = (x, y) => "(" + Math.round(Number(x)) + ", " + Math.round(Number(y)) + ")";
  const tgt = s.target ? "［遠端 " + s.target + "］" : "";
  const el = info.element ? "，元件：" + info.element.role + (info.element.name ? "「" + String(info.element.name).slice(0, 30) + "」" : "") : "";
  switch (s.op) {
    case "hover_probe": return tgt + "探索：移動滑鼠到 " + pt(s.x, s.y) + " 並拍照比對游標形狀與周圍變化（不點擊）" + where;
    case "move": return tgt + "移動滑鼠到 " + pt(s.x, s.y) + where + el;
    case "click": return tgt + (s.button && s.button !== "left" ? s.button + " 鍵" : "") + "點擊 " + pt(s.x, s.y) + where + el;
    case "double_click": return tgt + "雙擊 " + pt(s.x, s.y) + where + el;
    case "right_click": return tgt + "右鍵點擊 " + pt(s.x, s.y) + where + el;
    case "middle_click": return tgt + "中鍵點擊 " + pt(s.x, s.y) + where + el;
    case "drag": return tgt + "從 " + pt(s.x, s.y) + " 拖曳到 " + pt(s.x2, s.y2) + where;
    case "scroll": return tgt + "在 " + pt(s.x, s.y) + " 捲動 dx=" + (s.dx || 0) + " dy=" + (s.dy || 0) + where;
    case "type": return tgt + "輸入文字（" + String(s.text).length + " 字）：「" + String(s.text).replace(/\n/g, "↵").slice(0, 60) + (String(s.text).length > 60 ? "…" : "") + "」" + where;
    case "key": return tgt + "按鍵 " + normalizeChord(s.keys) + where;
    case "window_focus": case "window_minimize": case "window_maximize": case "window_restore": case "window_close":
      return { window_focus: "把焦點切到", window_minimize: "最小化", window_maximize: "最大化", window_restore: "還原", window_close: "關閉" }[s.op] + "視窗「" + String((w && w.title) || s.id).slice(0, 50) + "」";
    case "window_move": return "移動視窗「" + String((w && w.title) || s.id).slice(0, 40) + "」到 " + pt(s.x, s.y);
    case "window_resize": return "調整視窗「" + String((w && w.title) || s.id).slice(0, 40) + "」大小為 " + Math.round(s.w) + "×" + Math.round(s.h);
    case "element_invoke": return "（無障礙 API）啟動元件 " + (info.element ? info.element.role + "「" + String(info.element.name || "").slice(0, 30) + "」" : s.element) + where;
    case "element_toggle": return "（無障礙 API）切換元件 " + (info.element ? info.element.role + "「" + String(info.element.name || "").slice(0, 30) + "」" : s.element) + where;
    case "element_select": return "（無障礙 API）選取元件 " + (info.element ? info.element.role + "「" + String(info.element.name || "").slice(0, 30) + "」" : s.element) + where;
    case "element_focus": return "（無障礙 API）把焦點給元件 " + (info.element ? info.element.role + "「" + String(info.element.name || "").slice(0, 30) + "」" : s.element) + where;
    case "element_set_value": return "（無障礙 API）設定元件 " + (info.element ? info.element.role + "「" + String(info.element.name || "").slice(0, 30) + "」" : s.element) + " 的值（" + String(s.value).length + " 字）" + where;
    case "clipboard_set": return "設定剪貼簿文字（" + String(s.text).length + " 字）";
    case "wait": return "等待 " + Math.round(Number(s.ms)) + " ms";
    default: return String(s.op);
  }
}
function buildPreview(steps, evalResult, infos) {
  const lines = (steps || []).map((s, i) => { const r = evalResult && evalResult.steps ? evalResult.steps.find((x) => x.index === i) : null; const d = describeStep(s, (infos && infos[i]) || {}); return (i + 1) + ". " + d + (r && r.warnings && r.warnings.length ? "\n   ⚠ " + r.warnings.join("；") : "") + (r && !r.ok ? "\n   ✖ 拒絕：" + r.reason : ""); });
  return lines.join("\n");
}

module.exports = { OPS, BUTTONS, WINDOW_ACTIONS, ELEMENT_ACTIONS, DEFAULT_LIMITS, DENY_RULES, DENY_CHORDS, KEY_ALIASES, MODIFIERS, normalizeChord, isTypingChord, denyMatch, topmostAt, createSafety, describeStep, buildPreview };
