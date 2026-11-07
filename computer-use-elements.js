// computer-use-elements.js —— 「物件」（控制項／元件）的共同格式與純函式：角色對照、搜尋、座標。
// AT-SPI（Linux）、UI Automation（Windows）、X11 視窗樹、RFB 損壞區域、視覺模型找到的框，都轉成同一種 element：
//   {
//     id        同一次快照內穩定、之後可重新解析（"atspi:<pid>:<路徑>:<指紋>"、"uia:<hwnd>:<路徑>:<指紋>"、"x11:0x…"、"vlm:<shot>:<n>"、"rfb:<session>:<n>"）
//     source    atspi | uia | win32 | x11 | rfb | vlm
//     role      正規化後的角色（封閉詞彙，見 ROLES）；rawRole 是原本平台的名稱
//     name, description, value, text, automationId, className
//     rect      {x,y,w,h}，座標空間固定為「螢幕座標，像素，左上角為 0,0（Windows 多螢幕可為負）」，見 COORD_SPACE
//     enabled, visible（不是 offscreen）, focused, selected, checked, isPassword
//     states    平台的狀態名稱陣列；actions  可直接用無障礙 API 做的動作（invoke／toggle／select／set_value／focus／expand／collapse）
//     window    所屬視窗 id；app／pid；children（巢狀樹時）
//     confidence（只有 vlm／rfb 來源有，0~1）
//   }
"use strict";

// 座標空間：所有回傳給 AI 的座標都是 screen（實體像素）。截圖另外帶 origin 與 scale，才能把影像上的框換回來：
//   screenX = origin.x + imageX / scale.x
const COORD_SPACE = { space: "screen", unit: "px", origin: "top-left of the (virtual) screen", note: "Windows 為實體像素（程式會宣告 DPI aware）；X11 為 root 視窗座標；Wayland 原生視窗拿不到螢幕座標時 coordsReliable=false" };

const ROLES = ["button", "checkbox", "radio", "textbox", "password", "label", "link", "image", "menu", "menuitem", "menubar", "tab", "tablist", "list", "listitem", "tree", "treeitem", "table", "row", "cell", "combobox", "slider", "spinbutton", "scrollbar", "progressbar", "toolbar", "statusbar", "titlebar", "window", "dialog", "pane", "group", "separator", "tooltip", "document", "heading", "canvas", "app", "unknown"];

const ATSPI_ROLE = { "push button": "button", "toggle button": "button", button: "button", "check box": "checkbox", "check menu item": "menuitem", "radio button": "radio", "radio menu item": "menuitem", text: "textbox", entry: "textbox", "password text": "password", "text box": "textbox", "terminal": "textbox", label: "label", "static": "label", link: "link", image: "image", icon: "image", menu: "menu", "menu item": "menuitem", "menu bar": "menubar", "page tab": "tab", "page tab list": "tablist", list: "list", "list item": "listitem", "list box": "list", tree: "tree", "tree item": "treeitem", "tree table": "tree", table: "table", "table row": "row", "table cell": "cell", "table column header": "cell", "table row header": "cell", "column header": "cell", "combo box": "combobox", slider: "slider", "spin button": "spinbutton", "scroll bar": "scrollbar", "progress bar": "progressbar", "tool bar": "toolbar", "status bar": "statusbar", "title bar": "titlebar", frame: "window", window: "window", dialog: "dialog", "file chooser": "dialog", "alert": "dialog", "color chooser": "dialog", "font chooser": "dialog", panel: "pane", "scroll pane": "pane", viewport: "pane", filler: "group", "layered pane": "pane", "split pane": "pane", "tool tip": "tooltip", "document frame": "document", "document web": "document", "document text": "document", "document spreadsheet": "document", "document presentation": "document", heading: "heading", paragraph: "label", section: "group", separator: "separator", application: "app", canvas: "canvas", "drawing area": "canvas", "redundant object": "group", "form": "group", "level bar": "progressbar", "calendar": "group", "date editor": "textbox", "editbar": "textbox", "embedded": "pane", "header": "group", "footer": "group", "notification": "label", "info bar": "pane", "popup menu": "menu", "grouping": "group" };
const UIA_ROLE = { Button: "button", CheckBox: "checkbox", RadioButton: "radio", Edit: "textbox", Text: "label", Hyperlink: "link", Image: "image", Menu: "menu", MenuItem: "menuitem", MenuBar: "menubar", TabItem: "tab", Tab: "tablist", List: "list", ListItem: "listitem", Tree: "tree", TreeItem: "treeitem", Table: "table", DataGrid: "table", DataItem: "row", HeaderItem: "cell", Header: "row", ComboBox: "combobox", Slider: "slider", Spinner: "spinbutton", ScrollBar: "scrollbar", ProgressBar: "progressbar", ToolBar: "toolbar", StatusBar: "statusbar", TitleBar: "titlebar", Window: "window", Pane: "pane", Group: "group", Separator: "separator", ToolTip: "tooltip", Document: "document", SplitButton: "button", Thumb: "pane", Calendar: "group", Custom: "unknown", AppBar: "toolbar", SemanticZoom: "pane" };

function normalizeRole(source, raw) {
  const s = String(raw == null ? "" : raw);
  if (source === "atspi") return ATSPI_ROLE[s.toLowerCase()] || "unknown";
  if (source === "uia" || source === "win32") {
    const k = s.replace(/^ControlType\./, ""); if (UIA_ROLE[k]) return UIA_ROLE[k];
    const w = k.toLowerCase(); // Win32 類別名稱
    if (/^button$/.test(w)) return "button"; if (/^edit$|^richedit|^scintilla/.test(w)) return "textbox"; if (/^static$/.test(w)) return "label";
    if (/^combobox|^comboboxex/.test(w)) return "combobox"; if (/^syslistview|^listbox$/.test(w)) return "list"; if (/^systreeview/.test(w)) return "tree";
    if (/^systabcontrol/.test(w)) return "tablist"; if (/^toolbarwindow/.test(w)) return "toolbar"; if (/^msctls_statusbar/.test(w)) return "statusbar"; if (/^#32770$/.test(w)) return "dialog";
    return "unknown";
  }
  return ROLES.includes(s) ? s : "unknown";
}

const rectValid = (r) => !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0;
const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
const inside = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const area = (r) => (r ? Math.max(0, r.w) * Math.max(0, r.h) : 0);
const intersect = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h); return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null; };
const iou = (a, b) => { const i = intersect(a, b); if (!i) return 0; const u = area(a) + area(b) - area(i); return u ? area(i) / u : 0; };

// 補齊 element 的預設欄位（不同來源給的欄位不一樣）
function makeElement(o) {
  const e = Object.assign({ id: "", source: "", role: "unknown", rawRole: "", name: "", description: "", value: null, text: null, automationId: "", className: "", rect: null, enabled: true, visible: true, focused: false, selected: false, checked: null, isPassword: false, states: [], actions: [], window: null, app: "", pid: null }, o || {});
  if (e.role === "password") e.isPassword = true;
  if (!e.rect || !rectValid(e.rect)) e.visible = e.rect ? false : e.visible;
  return e;
}
function flatten(tree, out) {
  out = out || [];
  const list = Array.isArray(tree) ? tree : [tree];
  for (const n of list) { if (!n) continue; out.push(n); if (n.children && n.children.length) flatten(n.children, out); }
  return out;
}
// 去掉 children 的淺拷貝（回給 AI 的扁平清單用，省 token）
const bare = (e) => { const { children, ...rest } = e; return rest; };

// 把 { text, role, name, automationId, regex, enabled, visible, className, limit } 對上元素；回傳依分數排序的清單
function matchScore(e, q) {
  let score = 0;
  const lc = (s) => String(s == null ? "" : s).toLowerCase();
  if (q.role) { const want = lc(q.role); if (lc(e.role) !== want && lc(e.rawRole) !== want) return 0; score += 1; }
  if (q.automationId) { if (lc(e.automationId) !== lc(q.automationId)) return 0; score += 6; }
  if (q.className) { if (!lc(e.className).includes(lc(q.className))) return 0; score += 1; }
  if (q.name) { const n = lc(q.name), en = lc(e.name); if (en === n) score += 5; else if (en.includes(n)) score += 2; else return 0; }
  if (q.text) {
    const t = lc(q.text), fields = [e.name, e.description, e.value, e.text].map(lc);
    if (fields[0] === t) score += 5; else if (fields.some((f) => f && f.includes(t))) score += 2; else return 0;
  }
  if (q.regex) {
    let re; try { const src = String(q.regex); if (src.length > 200) return 0; re = new RegExp(src, "i"); } catch (_) { return 0; }
    if ([e.name, e.description, e.value, e.text, e.automationId].some((f) => f && re.test(String(f)))) score += 2; else return 0;
  }
  if (q.enabled === true && !e.enabled) return 0;
  if (q.visible === true && !e.visible) return 0;
  if (!(q.role || q.automationId || q.className || q.name || q.text || q.regex)) return 0;
  if (e.visible) score += 0.5; if (e.enabled) score += 0.25; if (rectValid(e.rect)) score += 0.1;
  return score;
}
function findElements(tree, q, limit) {
  q = q || {}; const hits = [];
  for (const e of flatten(tree)) { const s = matchScore(e, q); if (s > 0) hits.push({ e, s }); }
  hits.sort((a, b) => b.s - a.s || area(a.e.rect) - area(b.e.rect));
  return hits.slice(0, limit || q.limit || 20).map((h) => Object.assign(bare(h.e), { score: Math.round(h.s * 100) / 100 }));
}
// 座標下最深（面積最小）的可見元素
function elementAtPoint(tree, x, y) {
  let best = null;
  for (const e of flatten(tree)) { if (!e.visible || !inside(e.rect, x, y)) continue; if (!best || area(e.rect) <= area(best.rect)) best = e; }
  return best ? bare(best) : null;
}
// 限制深度／只留可見的（回給 AI 的樹要小）
function pruneTree(node, o) {
  o = o || {}; const maxDepth = o.depth == null ? 6 : o.depth, onlyVisible = !!o.onlyVisible; let budget = o.maxNodes || 400; let truncated = false;
  const walk = (n, d) => {
    if (budget <= 0) { truncated = true; return null; }
    if (onlyVisible && !n.visible && d > 0) return null;
    budget--; const out = Object.assign({}, n); delete out.children;
    if (n.children && n.children.length) {
      if (d >= maxDepth) { out.childCount = n.children.length; truncated = true; }
      else { const ch = []; for (const c of n.children) { const w = walk(c, d + 1); if (w) ch.push(w); } if (ch.length) out.children = ch; }
    }
    return out;
  };
  const roots = Array.isArray(node) ? node : [node];
  const res = roots.map((r) => walk(r, 0)).filter(Boolean);
  return { tree: res, truncated, nodes: (o.maxNodes || 400) - budget };
}
// 影像座標 → 螢幕座標。shot = { origin:{x,y}, scale:{x,y} 或數字 }（影像像素／螢幕像素）
function scaleOf(shot) { const s = shot && shot.scale; return typeof s === "number" ? { x: s, y: s } : { x: (s && s.x) || 1, y: (s && s.y) || 1 }; }
function imagePointToScreen(shot, p) { const s = scaleOf(shot), o = (shot && shot.origin) || { x: 0, y: 0 }; return { x: Math.round(o.x + p.x / s.x), y: Math.round(o.y + p.y / s.y) }; }
function imageBoxToScreen(shot, b) { const s = scaleOf(shot), o = (shot && shot.origin) || { x: 0, y: 0 }; return { x: Math.round(o.x + b.x / s.x), y: Math.round(o.y + b.y / s.y), w: Math.round(b.w / s.x), h: Math.round(b.h / s.y) }; }
function screenBoxToImage(shot, b) { const s = scaleOf(shot), o = (shot && shot.origin) || { x: 0, y: 0 }; return { x: Math.round((b.x - o.x) * s.x), y: Math.round((b.y - o.y) * s.y), w: Math.round(b.w * s.x), h: Math.round(b.h * s.y) }; }

// 游標名稱 → 語意（X11 游標名／Windows IDC 名／CSS cursor 名）。sash＝可以拖曳調整大小的分隔條。
function classifyCursor(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return "custom";
  if (/^(hand|hand1|hand2|pointer|pointing_hand|pointinghand|link|grab|grabbing|openhand|closedhand)$/.test(n)) return "clickable";
  if (/^(xterm|text|ibeam|vertical-text)$/.test(n)) return "text";
  if (/^(sb_h_double_arrow|col-resize|ew-resize|size_hor|sizewe|split_h|e-resize|w-resize|h_double_arrow|left_side|right_side)$/.test(n)) return "sash-horizontal";
  if (/^(sb_v_double_arrow|row-resize|ns-resize|size_ver|sizens|split_v|n-resize|s-resize|v_double_arrow|top_side|bottom_side)$/.test(n)) return "sash-vertical";
  if (/^(top_left_corner|bottom_right_corner|top_right_corner|bottom_left_corner|nwse-resize|nesw-resize|size_bdiag|size_fdiag|sizenwse|sizenesw)$/.test(n)) return "resize-corner";
  if (/^(fleur|move|all-scroll|sizeall|size_all)$/.test(n)) return "move";
  if (/^(watch|wait|progress|appstarting|left_ptr_watch)$/.test(n)) return "busy";
  if (/^(crosshair|cross|tcross|plus)$/.test(n)) return "crosshair";
  if (/^(question_arrow|help|whats_this)$/.test(n)) return "help";
  if (/^(not-allowed|no|crossed_circle|circle|forbidden|dnd-none)$/.test(n)) return "forbidden";
  if (/^(left_ptr|arrow|default|top_left_arrow|right_ptr|uparrow)$/.test(n)) return "default";
  return "other";
}
const INTERACTIVE_CURSORS = ["clickable", "text", "sash-horizontal", "sash-vertical", "resize-corner", "move", "crosshair"];

module.exports = { classifyCursor, INTERACTIVE_CURSORS, COORD_SPACE, ROLES, normalizeRole, rectValid, center, inside, area, intersect, iou, makeElement, flatten, bare, findElements, elementAtPoint, pruneTree, matchScore, scaleOf, imagePointToScreen, imageBoxToScreen, screenBoxToImage };
