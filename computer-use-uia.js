// computer-use-uia.js —— Windows 的「Spy++」：UI Automation 控制項樹（ControlType、Name、AutomationId、ClassName、BoundingRectangle、IsEnabled、IsOffscreen、
// 支援的模式 Value／Invoke／Toggle／Selection、值與文字）＋ Win32 子視窗樹（hwnd、類別、文字、矩形）。
// 實際工作在 computer-use-win-cs.js 的 C# 類別 FaUia／FaWin（編成 DLL 後由 PowerShell 呼叫），這裡只負責把它的 JSON 轉成共同的 element 格式。
// 元件 id＝"uia:<hwnd>:<從視窗根往下的 ControlView 兄弟索引路徑>:<ControlType|AutomationId|Name 指紋>"；指紋在 C# 端算（FaJson.Fnv）。
// 未實測（沒有 Windows 可以跑）：轉換函式有 fixture 測試。
"use strict";
const E = require("./computer-use-elements.js");

function buildId(hwnd, pathStr, fp) { return "uia:" + hwnd + ":" + pathStr + ":" + fp; }
function parseId(id) { const m = /^uia:(\d+):([\d.]+):([0-9a-f]{6})$/.exec(String(id || "")); return m ? { hwnd: m[1], path: m[2], fp: m[3] } : null; }

function patternActions(n) {
  const pats = new Set((n.patterns || []).map((p) => String(p).replace(/Pattern$/, ""))), acts = [];
  if (pats.has("Invoke")) acts.push("invoke");
  if (pats.has("Toggle")) acts.push("toggle");
  if (pats.has("SelectionItem")) acts.push("select");
  if (pats.has("Value") && !n.isPassword) acts.push("set_value");
  acts.push("focus");
  return acts;
}
// C# 節點 → element；ctx：{ hwnd, windowId, app }
function toElement(n, ctx) {
  ctx = ctx || {}; const hwnd = n.hwnd || ctx.hwnd;
  const rect = n.rect && n.rect.w > 0 && n.rect.h > 0 ? n.rect : null;
  const role = E.normalizeRole("uia", n.controlType);
  const el = E.makeElement({
    id: n.path ? buildId(hwnd, n.path, n.fp || "000000") : "", source: "uia", role: n.isPassword ? "password" : role, rawRole: n.controlType || "", name: n.name || "", description: "", value: n.value != null ? n.value : null, text: null,
    automationId: n.automationId || "", className: n.className || "", rect, enabled: n.enabled !== false, visible: !n.offscreen && !!rect, focused: !!n.focused, selected: !!n.selected,
    checked: n.toggle === "On" ? true : n.toggle === "Off" ? false : null, isPassword: !!n.isPassword,
    states: [n.enabled === false ? "disabled" : "enabled", n.offscreen ? "offscreen" : "onscreen", n.focused ? "focused" : "", n.selected ? "selected" : "", n.toggle ? "toggle:" + n.toggle : "", n.expand ? "expand:" + n.expand : ""].filter(Boolean),
    actions: patternActions(n), window: ctx.windowId || null, app: ctx.app || n.framework || "", pid: n.pid || ctx.pid || null,
  });
  if (n.patterns) el.patterns = n.patterns;
  if (n.children) el.children = n.children.map((c) => toElement(c, ctx));
  else if (n.hasChildren) el.childCount = 1; // 深度到了：有子節點但沒展開
  return el;
}
// Win32 子視窗 → element（source:'win32'；沒有 UIA 時的備案）
function win32ToElement(n, ctx) {
  ctx = ctx || {};
  const rect = n.rect && n.rect.w > 0 && n.rect.h > 0 ? n.rect : null;
  const el = E.makeElement({ id: "win32:" + n.hwnd, source: "win32", role: E.normalizeRole("win32", n.class), rawRole: n.class || "", name: n.text || "", className: n.class || "", automationId: n.ctrlId ? String(n.ctrlId) : "", rect, enabled: n.enabled !== false, visible: n.visible !== false && !!rect, window: ctx.windowId || null, pid: ctx.pid || null, actions: ["focus"] });
  el.hwnd = n.hwnd; if (n.children) el.children = n.children.map((c) => win32ToElement(c, ctx));
  return el;
}

// backend：computer-use-windows.js 的後端（有 call(kind, params)）。windowResolver(windowId) → { hwnd, pid, title }
function createUia(backend) {
  const api = {
    async tree(windowId, o) {
      o = o || {}; const hwnd = require("./computer-use-windows.js").parseWindowId(windowId); if (!hwnd) return { ok: false, error: "視窗 id 格式不對：" + windowId };
      const j = await backend.call("uiaTree", { hwnd, depth: o.depth == null ? 6 : o.depth, maxNodes: o.maxNodes || 500, onlyVisible: !!o.onlyVisible, raw: !!o.raw }, { timeout: 60000 });
      if (!j.ok) return { ok: false, error: j.error }; const ctx = { hwnd: j.hwnd, windowId };
      return { ok: true, roots: [toElement(j.root, ctx)], truncated: !!j.truncated, coords: "screen" };
    },
    async win32Tree(windowId, o) { const r = await backend.win32Tree(windowId, o); if (!r.ok) return r; return { ok: true, roots: [win32ToElement(r.root, { windowId })], truncated: !!r.truncated, coords: "screen" }; },
    async elementAt(x, y) { const j = await backend.call("uiaPoint", { x: Math.round(x), y: Math.round(y) }); if (!j.ok) return { ok: false, error: j.error }; return { ok: true, element: j.element ? toElement(Object.assign({ path: "" }, j.element, { hwnd: j.hwnd }), { hwnd: j.hwnd }) : null }; },
    async focused() { const j = await backend.call("uiaFocused", {}); if (!j.ok) return { ok: false, known: false, error: j.error }; return { ok: true, known: !!j.known, element: j.element ? toElement(j.element, {}) : null, isPassword: !!(j.element && j.element.isPassword), reason: j.reason }; },
    async act(id, action, value) { const ref = parseId(id); if (!ref) return { ok: false, error: "不是 UIA 元件 id：" + id }; const j = await backend.call("uiaAct", { hwnd: ref.hwnd, path: ref.path, fp: ref.fp, action, value: value == null ? "" : String(value) }); return j; },
  };
  return api;
}

module.exports = { createUia, toElement, win32ToElement, buildId, parseId, patternActions };
