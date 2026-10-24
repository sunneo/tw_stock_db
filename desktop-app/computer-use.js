// computer-use.js —— computer use 的門面（主行程，CommonJS）：把平台後端（Linux／Windows）、無障礙（AT-SPI／UI Automation）、遠端畫面（RFB）
// 與安全政策（computer-use-safety.js）接成一組 AI 工具要用的操作。所有操作都回傳可直接 JSON 化的物件，失敗回 { ok:false, error, why } 而不是丟例外。
// 座標空間：螢幕座標（實體像素，左上角 0,0；Windows 多螢幕可為負）。截圖回傳 origin 與 scale（影像像素／螢幕像素），影像上的框要換回螢幕座標：
//   screenX = origin.x + imageX / scale.x（computer-use-elements.js 的 imageBoxToScreen）。
// 流程：plan(steps)（驗證＋預覽）→ execute(planId)（需要時請使用者核准，原生視窗，見 computer-use-ipc.js；沒有核准函式＝一律拒絕）。
"use strict";
const E = require("./computer-use-elements.js");
const S = require("./computer-use-safety.js");
const PNG = require("./computer-png.js");
const R = require("./computer-remote.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (error, why, extra) => Object.assign({ ok: false, error, why: why || undefined }, extra || {});

// opts：{ platform, env, backend, atspi, uia, confirm(info)→{approved,auto?}, secrets:{get(name)→string|null}, selfPids, safety:{limits,extraDeny}, enabled, now,
//         rfbFactory(opts)→client（測試注入）, which(bin) }
function create(opts) {
  opts = opts || {}; const platform = opts.platform || process.platform, now = opts.now || (() => Date.now());
  const safety = opts.safetyInstance || S.createSafety({ enabled: !!opts.enabled, selfPids: opts.selfPids || [process.pid], limits: (opts.safety || {}).limits, extraDeny: (opts.safety || {}).extraDeny, now });
  let backend = opts.backend || null, atspi = opts.atspi || null, uia = opts.uia || null, backendErr = null;
  function ensureBackend() {
    if (backend) return backend;
    try {
      if (platform === "win32") { const W = require("./computer-use-windows.js"); backend = W.createWindowsBackend({ which: opts.which }); uia = uia || require("./computer-use-uia.js").createUia(backend); }
      else if (platform === "linux") { const L = require("./computer-use-linux.js"); backend = L.createLinuxBackend({ env: opts.env || process.env, which: opts.which }); atspi = atspi || require("./computer-use-atspi.js").createAtspi({ run: opts.exec || L.createExec(backend.env), env: backend.env }); }
      else backendErr = "這個平台（" + platform + "）沒有 computer use 後端（只支援 Windows 與 Linux）";
    } catch (e) { backendErr = String((e && e.message) || e); }
    return backend;
  }
  const noBackend = () => fail(backendErr || "沒有後端", "只支援 Windows 與 Linux 桌面");
  const cu = { safety, get backend() { return ensureBackend(); } };

  // ---------- 快取：視窗清單（短）、元件快照、截圖 ----------
  let winCache = null; const elCache = new Map(), shots = new Map(); let shotSeq = 0, planSeq = 0; const plans = new Map(); const sessions = new Map(); let rfbSeq = 0;
  let calibration = null;
  async function windows(o) {
    const b = ensureBackend(); if (!b) return noBackend(); o = o || {};
    if (!o.fresh && winCache && now() - winCache.t < 250) return winCache.v;
    const r = await b.listWindows({ all: true }); if (!r.ok) return r;
    const wins = r.windows.map((w) => Object.assign({}, w)); const v = { ok: true, windows: wins, activeId: r.activeId, backend: r.backend };
    winCache = { t: now(), v }; return v;
  }
  const winById = (list, id) => list.find((w) => String(w.id).toLowerCase() === String(id).toLowerCase());
  const decorate = (w) => { const cw = R.classifyWindow(w), d = safety.denyMatch(w); return Object.assign({}, w, { canvas: cw.canvas ? { kind: cw.kind, client: cw.client, capabilities: cw.capabilities } : null, denied: d ? { rule: d.rule, label: d.label } : null, inScope: safety.inScope(w.id), self: false }); };

  // ---------- 狀態 ----------
  cu.state = () => Object.assign(safety.state(), { remote: Array.from(sessions.keys()), calibration });
  cu.capabilities = async function () {
    const b = ensureBackend(); const st = safety.state();
    if (!b) return { ok: false, error: backendErr, platform, enabled: st.enabled, safety: st };
    const cap = await b.capabilities();
    const mons = b.monitors ? await b.monitors().catch(() => null) : null;
    return Object.assign({ ok: true, enabled: st.enabled, coordinateSpace: E.COORD_SPACE, monitors: mons && mons.ok ? mons.monitors : null, safety: { enabled: st.enabled, auto: st.auto, scope: st.scope, aborted: st.aborted, limits: S.DEFAULT_LIMITS, denyRules: S.DENY_RULES.map((r) => r.label), vocabulary: Object.keys(S.OPS) }, remote: { rfb: { ok: true, via: "內建 RFB 用戶端（rfb-client.js）", encodings: ["ZRLE", "Hextile", "RRE", "CopyRect", "Raw", "Cursor", "DesktopSize"], security: ["None", "VNC 驗證"], transports: ["tcp", "websocket（noVNC／websockify）"], objects: "protocol（損壞矩形、CopyRect、游標推出的候選區）", input: "protocol" }, rdp: { ok: false, detect: true, note: "RDP：協定可辨識（remote_probe），但需要完整 RDP 客戶端才能取得繪製物件；改走 VLM 慢路徑（xfreerdp 開視窗後當畫布）" }, nx: { ok: false, detect: true }, spice: { ok: false, detect: true } }, calibration }, cap);
  };
  cu.setEnabled = (on) => { safety.setEnabled(on); if (!on) { for (const id of Array.from(sessions.keys())) cu.remoteDisconnect(id); plans.clear(); } return cu.state(); };
  cu.setAuto = (on) => { safety.setAuto(on); return cu.state(); };
  cu.resume = () => { safety.resume(); return cu.state(); };
  // 範圍：{mode:'screen'} | {windowIds:[…]}（用現在的視窗清單補上標題等資訊）
  cu.setScope = async function (sc) {
    sc = sc || {};
    if (sc.mode === "screen") { safety.setScope({ mode: "screen" }); return Object.assign({ ok: true }, cu.state()); }
    const l = await windows({ fresh: true }); if (!l.ok) return l;
    const picked = [], missing = [];
    for (const id of sc.windowIds || []) { const w = winById(l.windows, id); if (!w) missing.push(id); else picked.push(w); }
    const selfWin = picked.filter((w) => (opts.selfPids || [process.pid]).includes(Number(w.pid))); if (selfWin.length) return fail("不能把助理自己的視窗放進範圍");
    const bad = picked.filter((w) => safety.denyMatch(w)); if (bad.length) return fail("這些視窗屬於拒絕清單，不能放進範圍：" + bad.map((w) => "「" + w.title + "」").join("、"));
    if (!picked.length) return fail("沒有可用的視窗" + (missing.length ? "（找不到：" + missing.join("、") + "）" : ""));
    safety.setScope({ mode: "windows", windows: picked, rfb: safety.scope().rfb }); return Object.assign({ ok: true, missing }, cu.state());
  };
  cu.abort = async function (reason) {
    safety.abort(reason || "使用者中止");
    const b = ensureBackend(); try { if (b && b.releaseAll) await b.releaseAll(); } catch (_) { /* */ }
    for (const s of sessions.values()) { try { s.client.releaseAll(); } catch (_) { /* */ } }
    plans.clear(); return Object.assign({ ok: true, aborted: true }, cu.state());
  };

  // ---------- 視窗 ----------
  cu.listWindows = async function (o) {
    o = o || {}; const l = await windows({ fresh: true }); if (!l.ok) return l;
    const visible = l.windows.filter((w) => o.all || !["desktop", "dock", "splash", "notification", "tooltip", "dnd", "menu", "dropdown_menu", "popup_menu", "combo", "utility", "tool", "noactivate"].includes(w.type) || w.focused);
    const out = visible.map((w) => { const d = decorate(w); if ((opts.selfPids || [process.pid]).includes(Number(w.pid))) { d.self = true; } return d; }).sort((a, b) => b.z - a.z);
    return { ok: true, windows: out.map((w) => (w.denied || w.self ? Object.assign({}, w, { title: w.denied ? "（受保護的視窗）" : w.title }) : w)), activeId: l.activeId, backend: l.backend, coordinateSpace: E.COORD_SPACE.space };
  };
  cu.findWindow = async function (m, timeoutMs) { const b = ensureBackend(); if (!b) return noBackend(); return b.waitForWindow(m || {}, timeoutMs || 0); };
  // 視窗動作（單步，經過 plan/execute）
  cu.windowAction = async function (action, id, args) { return cu.run([Object.assign({ op: "window_" + action, id }, args || {})]); };

  // ---------- 截圖 ----------
  function cacheShot(r, meta) { const id = "shot" + ++shotSeq; shots.set(id, { id, png: r.png, image: r.image || null, meta, t: now() }); while (shots.size > 10) shots.delete(shots.keys().next().value); return id; }
  async function getImage(id) { const sh = shots.get(id); if (!sh) return null; if (!sh.image) sh.image = PNG.decodePng(sh.png); return sh.image; }
  // what：{ target?:'rfb:1', windowId | rect | screen:true, maxSide, grid:{cols,rows}, pointer, cacheOnly }
  cu.screenshot = async function (w) {
    w = w || {}; const b = ensureBackend(); if (!b) return noBackend();
    if (w.target && /^rfb:/.test(w.target)) {
      const s = sessions.get(w.target); if (!s || !safety.rfbInScope(w.target)) return fail("沒有這個遠端連線（或不在範圍內）：" + w.target); if (!safety.state().enabled) return fail("電腦操作功能沒有啟用"); if (safety.isAborted()) return fail("已中止");
      const r = s.client.screenshot({ rect: w.rect, maxSide: w.maxSide, cursor: w.pointer, wantImage: true });
      return finishShot(r, { kind: "rfb", target: w.target }, w);
    }
    const l = await windows({ fresh: true }); if (!l.ok) return l;
    let what, rect = null, win = null;
    if (w.windowId) { what = { kind: "window", windowId: w.windowId }; win = winById(l.windows, w.windowId); if (win) rect = win.frame || win.rect; }
    else if (w.rect) { what = { kind: "rect", rect: w.rect }; rect = w.rect; }
    else { what = { kind: "screen" }; }
    const chk = safety.checkRead(what, { windows: l.windows }); if (!chk.ok) return fail(chk.reason, undefined, { code: chk.code });
    const r = await b.screenshot({ kind: what.kind === "window" ? "window" : what.kind === "rect" ? "rect" : "screen", rect, maxSide: w.maxSide, pointer: !!w.pointer, windowId: w.windowId, wantImage: true });
    if (!r.ok) return r; return finishShot(r, { kind: what.kind, windowId: w.windowId || null, rect }, w);
  };
  async function finishShot(r, meta, w) {
    let png = r.png, img = r.image, grid = null;
    const id = cacheShot(r, Object.assign({ origin: r.origin, scale: r.scale, width: r.width, height: r.height, tool: r.tool }, meta));
    if (w.grid && w.grid.cols && w.grid.rows) { img = img || (await getImage(id)); const g = PNG.drawGrid(img, w.grid.cols, w.grid.rows); png = PNG.encodePng(g.img); grid = { cols: w.grid.cols, rows: w.grid.rows, cells: g.cells.map((c) => ({ col: c.col, row: c.row, rect: E.imageBoxToScreen({ origin: r.origin, scale: r.scale }, c), imageRect: { x: c.x, y: c.y, w: c.w, h: c.h } })) }; }
    return { ok: true, shotId: id, dataUrl: PNG.toDataUrl(png), width: r.width, height: r.height, origin: r.origin, scale: r.scale, rect: r.rect, tool: r.tool, pointer: !!r.pointer, grid, coordinateSpace: "screen", mapBack: "screenX = origin.x + imageX / scale.x；screenY = origin.y + imageY / scale.y", warning: meta.kind === "window" ? "視窗截圖是「螢幕上看到的」範圍：被別的視窗蓋住的部分會是別的視窗的內容" : undefined };
  }
  // 從已拍的圖裁一塊（不重拍）：rect 用「螢幕座標」
  cu.cropShot = async function (shotId, rect, o) {
    o = o || {}; const sh = shots.get(shotId); if (!sh) return fail("找不到截圖 " + shotId + "（只保留最近 10 張）"); const img = await getImage(shotId), sc = E.scaleOf(sh.meta), box = E.screenBoxToImage(sh.meta, rect);
    let c; try { c = PNG.crop(img, box); } catch (e) { return fail("裁切範圍在截圖之外"); }
    let scale = sc.x; if (o.maxSide) { const fw = PNG.fitWithin(c, o.maxSide); c = fw.img; scale = sc.x * fw.scale; }
    const org = { x: sh.meta.origin.x + box.x / sc.x, y: sh.meta.origin.y + box.y / sc.y };
    return { ok: true, dataUrl: PNG.toDataUrl(PNG.encodePng(c)), width: c.width, height: c.height, origin: org, scale: { x: scale, y: scale } };
  };
  cu.diffShots = async function (a, b2, o) { const A = await getImage(a), B = await getImage(b2); if (!A || !B) return fail("找不到截圖"); return Object.assign({ ok: true }, PNG.diff(A, B, o), o && o.regions ? { regions: PNG.changedRegions(A, B, o) } : {}); };

  // ---------- 元件（物件） ----------
  // 元件快照：記下當時視窗的外框；之後視窗關了／移動了，這些座標就過期，不能再拿來點（見 elementStale）
  function remember(tree, windowId, frame) { for (const e of E.flatten(tree)) { if (e.id) { e.window = e.window || windowId || null; elCache.set(e.id, { e: E.bare(e), t: now(), frame: frame ? Object.assign({}, frame) : null }); } } while (elCache.size > 5000) elCache.delete(elCache.keys().next().value); }
  function elementStale(id, wins) {
    const c = elCache.get(String(id)); if (!c) return "找不到元件 " + id + "（要先用 ui_tree／find_element 取得；id 只在同一次快照內有效）";
    if (now() - c.t > 10 * 60 * 1000) return "元件快照太舊（超過 10 分鐘），請重新 ui_tree／find_element";
    if (c.e.window) { const w = wins.find((q) => String(q.id) === String(c.e.window)); if (!w) return "元件所屬的視窗已經不存在（快照過期）"; const f = w.frame || w.rect; if (c.frame && f && (Math.abs(f.x - c.frame.x) > 2 || Math.abs(f.y - c.frame.y) > 2 || Math.abs(f.w - c.frame.w) > 2 || Math.abs(f.h - c.frame.h) > 2)) return "視窗已經移動或改變大小，元件座標過期，請重新 ui_tree／find_element"; }
    return "";
  }
  const rectNear = (a, b) => a && b && Math.abs(a.x - b.x) <= 14 && Math.abs(a.y - b.y) <= 40 && Math.abs(a.w - b.w) <= 30 && Math.abs(a.h - b.h) <= 50;
  async function a11yTree(win, o) {
    o = o || {}; const b = ensureBackend();
    if (atspi) {
      const probe = (await b.capabilities()).features.a11y; if (probe && probe.ok) {
        const r = await atspi.tree({ app: win.pid != null ? win.pid : null, depth: o.depth, onlyVisible: o.onlyVisible, maxNodes: o.maxNodes }); if (!r.ok) return r;
        // 同一個應用程式可能有多個視窗：用標題與矩形挑出對應的那一棵
        const wr = win.frame || win.rect; let best = null, bs = -1;
        for (const root of r.roots) { let sc = 0; if (root.name && win.title && (root.name === win.title)) sc += 3; else if (root.name && win.title && (win.title.includes(root.name) || root.name.includes(win.title))) sc += 1; if (rectNear(root.rect, wr) || rectNear(root.rect, win.rect)) sc += 2; if (sc > bs) { bs = sc; best = root; } }
        if (!best || bs <= 0) return fail("這個視窗沒有無障礙樹（應用程式沒有啟用 AT-SPI／無障礙）", "Electron／Chrome 需要 --force-renderer-accessibility；Qt 需要 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1", { source: "atspi" });
        const root = Object.assign({}, best); remember(root, win.id, win.frame || win.rect); return { ok: true, source: "atspi", roots: [root], truncated: r.truncated };
      }
    }
    if (uia) { const r = await uia.tree(win.id, o); if (r.ok) { remember(r.roots, win.id, win.frame || win.rect); return Object.assign({ source: "uia" }, r); } return r; }
    return fail("沒有可用的無障礙後端（AT-SPI／UI Automation）", ((await b.capabilities()).features.a11y || {}).reason);
  }
  async function x11Tree(win, o) {
    const b = ensureBackend(); if (!b.x11Tree) return fail("沒有 X11 視窗樹"); const r = await b.x11Tree(win.id); if (!r.ok) return r;
    const conv = (n) => E.makeElement({ id: "x11:" + n.id, source: "x11", role: "window", rawRole: n.class || "", name: n.name || "", className: n.class || "", rect: { x: n.x, y: n.y, w: n.w, h: n.h }, visible: n.w > 1 && n.h > 1 && n.x > -30000, window: win.id, actions: [], children: (n.children || []).map(conv) });
    const roots = r.nodes.map(conv); remember(roots, win.id, win.frame || win.rect); return { ok: true, source: "x11", roots, truncated: false };
  }
  // o：{ windowId, depth, onlyVisible, maxNodes, source:'auto'|'a11y'|'x11'|'win32', flat }
  cu.uiTree = async function (o) {
    o = o || {}; const b = ensureBackend(); if (!b) return noBackend();
    if (o.target && /^rfb:/.test(o.target)) return cu.remoteObjects(o.target, o);
    const l = await windows({ fresh: true }); if (!l.ok) return l; if (!o.windowId) return fail("需要 windowId（先 list_windows）");
    const chk = safety.checkRead({ kind: "window", windowId: o.windowId }, { windows: l.windows }); if (!chk.ok) return fail(chk.reason, undefined, { code: chk.code });
    const win = winById(l.windows, o.windowId), cw = R.classifyWindow(win);
    let r = null; const src = o.source || "auto"; const tried = [];
    if (src === "auto" || src === "a11y") { r = await a11yTree(win, o); tried.push({ source: "a11y", ok: r.ok, error: r.error }); }
    if ((!r || !r.ok) && (src === "auto" || src === "win32") && b.win32Tree && uia) { const w = await uia.win32Tree(win.id, o); tried.push({ source: "win32", ok: w.ok, error: w.error }); if (w.ok) { remember(w.roots, win.id, win.frame || win.rect); r = Object.assign({ source: "win32" }, w); } }
    if ((!r || !r.ok) && (src === "auto" || src === "x11")) { const x = await x11Tree(win, o); tried.push({ source: "x11", ok: x.ok, error: x.error }); if (x.ok) r = x; }
    if (!r || !r.ok) return fail((r && r.error) || "取不到元件樹", undefined, { tried, canvas: cw.canvas ? cw : undefined, next: cw.canvas ? "這個視窗是遠端畫面的畫布（" + cw.client + "）：用 screenshot＋describe（視覺模型），或 remote_probe／remote_connect 走協定層" : "改用 screenshot＋describe（視覺模型慢路徑）" });
    const pr = E.pruneTree(r.roots, { depth: o.depth == null ? 6 : o.depth, onlyVisible: o.onlyVisible, maxNodes: o.maxNodes || 400 });
    const outTree = o.flat ? E.flatten(pr.tree).map(E.bare) : pr.tree;
    return { ok: true, source: r.source, windowId: win.id, tree: outTree, truncated: pr.truncated || !!r.truncated, nodes: pr.nodes, coordinateSpace: "screen", tried, canvas: cw.canvas ? cw : undefined, note: r.source === "x11" ? "只有 X11 視窗樹（沒有按鈕等元件）：要更細請改用視覺模型" : undefined };
  };
  cu.findElements = async function (o) {
    o = o || {}; const b = ensureBackend(); if (!b) return noBackend(); const l = await windows({ fresh: true }); if (!l.ok) return l;
    const targets = o.windowId ? [winById(l.windows, o.windowId)].filter(Boolean) : l.windows.filter((w) => safety.inScope(w.id) && !w.minimized && !safety.denyMatch(w)).sort((a, c) => c.z - a.z).slice(0, 6);
    if (!targets.length) return fail(o.windowId ? "找不到視窗 " + o.windowId : "範圍內沒有可搜尋的視窗");
    const found = []; const errors = [];
    for (const win of targets) {
      const chk = safety.checkRead({ kind: "window", windowId: win.id }, { windows: l.windows }); if (!chk.ok) { errors.push({ windowId: win.id, error: chk.reason }); continue; }
      const r = await a11yTree(win, { depth: 12, maxNodes: 1500 }); if (!r.ok) { const x = await x11Tree(win, {}); if (x.ok) { for (const e of E.findElements(x.roots, o, o.limit || 20)) found.push(Object.assign(e, { windowTitle: win.title })); } else errors.push({ windowId: win.id, error: r.error }); continue; }
      for (const e of E.findElements(r.roots, o, o.limit || 20)) found.push(Object.assign(e, { window: win.id, windowTitle: win.title }));
    }
    found.sort((a, c) => c.score - a.score); return { ok: true, elements: found.slice(0, o.limit || 20), coordinateSpace: "screen", errors: errors.length ? errors : undefined, hint: found.length ? undefined : "沒找到：可以放寬條件（只給 text）、先 ui_tree 看有哪些元件，或改用 screenshot＋describe" };
  };
  cu.elementAt = async function (o) {
    const b = ensureBackend(); if (!b) return noBackend(); const l = await windows({ fresh: true }); if (!l.ok) return l;
    const chk = safety.checkRead({ kind: "point", x: o.x, y: o.y }, { windows: l.windows }); if (!chk.ok) return fail(chk.reason, undefined, { code: chk.code });
    const win = chk.window; let el = null;
    if (atspi && (await b.capabilities()).features.a11y.ok) { const r = await atspi.elementAt(o.x, o.y, { app: win.pid }); if (r.ok && r.element) { el = r.element; el.window = win.id; remember(el, win.id, win.frame || win.rect); } }
    else if (uia) { const r = await uia.elementAt(o.x, o.y); if (r.ok && r.element) { el = r.element; el.window = win.id; } }
    return { ok: true, element: el ? E.bare(el) : null, window: { id: win.id, title: win.title, process: win.process }, coordinateSpace: "screen", note: el ? undefined : "這一點沒有無障礙元件資訊：改用 screenshot＋describe" };
  };
  cu.elementInfo = async function (id) { const c = elCache.get(String(id)); if (!c) return fail("找不到元件 " + id + "（元件 id 只在同一次 ui_tree／find_element 快照內有效；重新取得）"); return { ok: true, element: c.e, ageMs: now() - c.t }; };
  const cached = (id) => (elCache.get(String(id)) || {}).e || null;

  // ---------- 計畫與執行 ----------
  async function buildCtx(o) {
    o = o || {}; const l = await windows({ fresh: !!o.fresh }); if (!l.ok) return { error: l }; const b = ensureBackend();
    const act = l.activeId || (l.windows.find((w) => w.focused) || {}).id || null; let focus = { known: false }; const actWin = act ? winById(l.windows, act) : null;
    if (o.needFocus !== false) {
      // 無障礙回報的焦點元件必須屬於「現在作用中的視窗」所屬的行程，否則不採信（別的應用程式的焦點不能當作這個視窗的保證）
      const same = (f) => f.element && (f.element.pid == null || !actWin || actWin.pid == null || Number(f.element.pid) === Number(actWin.pid));
      try {
        if (atspi && (await b.capabilities()).features.a11y.ok) { const f = await atspi.focused(); if (f.ok && f.known && f.element && same(f)) focus = { known: true, isPassword: !!f.isPassword, role: f.element.role, name: f.element.name }; }
        else if (uia) { const f = await uia.focused(); if (f.ok && f.known && f.element && same(f)) focus = { known: true, isPassword: !!f.isPassword, role: f.element.role, name: f.element.name }; }
      } catch (_) { focus = { known: false }; }
    }
    const remote = {}; for (const [id, s] of sessions) remote[id] = { width: s.client.width, height: s.client.height };
    return { windows: l.windows, activeWindowId: act, focus, remote };
  }
  // 把步驟裡的 element 解成座標與視窗（元件 id 必須來自快照）
  function resolveSteps(steps, ctx) {
    const infos = [];
    const out = (steps || []).map((s0, i) => {
      const s = Object.assign({}, s0); const info = {}; infos[i] = info;
      if (s.element && S.OPS[s.op]) {
        const stale = elementStale(s.element, ctx.windows); if (stale) { s._error = stale; return s; }
        const e = cached(s.element);
        info.element = e; const win = e.window ? ctx.windows.find((w) => String(w.id) === String(e.window)) : null;
        s._resolved = { element: e, window: win || (e.rect ? S.topmostAt(ctx.windows, E.center(e.rect).x, E.center(e.rect).y) : null), point: e.rect ? E.center(e.rect) : null };
        if (S.OPS[s.op].point && s.x == null && s.y == null) { if (!s._resolved.point) { s._error = "元件沒有座標（看不見或沒有矩形）"; return s; } s.x = s._resolved.point.x; s.y = s._resolved.point.y; }
      }
      if (calibration && calibration.apply && S.OPS[s.op] && S.OPS[s.op].point && Number.isFinite(Number(s.x))) { const p = unmap(Number(s.x), Number(s.y)); s._xy = p; }
      return s;
    });
    return { steps: out, infos };
  }
  cu.plan = async function (steps, o) {
    o = o || {}; if (!safety.state().enabled) return fail("電腦操作功能沒有啟用（/computer enable）", undefined, { code: "disabled" });
    const b = ensureBackend(); if (!b) return noBackend();
    const ctx = await buildCtx({ fresh: true }); if (ctx.error) return ctx.error;
    const rs = resolveSteps(steps, ctx); const early = rs.steps.map((s, i) => (s._error ? { index: i, op: s.op, code: "no_element", reason: s._error } : null)).filter(Boolean);
    const ev = safety.evaluate(rs.steps.map((s) => (s._error ? { op: "wait", ms: 0 } : s)), ctx); // 先用 wait 佔位避免錯誤步驟干擾
    if (early.length) { ev.ok = false; ev.refused = early.concat(ev.refused || []); }
    const infos = rs.infos.map((inf, i) => { const st = ev.steps.find((x) => x.index === i); return Object.assign({}, inf, { window: (st && st.window) || inf.window }); });
    const preview = S.buildPreview(rs.steps, ev, infos);
    const id = "plan" + ++planSeq + "-" + now().toString(36); plans.set(id, { id, steps: rs.steps, ev, t: now(), source: o.source || "tool", preview, activeBefore: ctx.activeWindowId || null }); while (plans.size > 20) plans.delete(plans.keys().next().value);
    return { ok: ev.ok, planId: ev.ok ? id : undefined, preview, evaluation: { steps: ev.steps, refused: ev.refused }, needsApproval: ev.needsApproval, forceAsk: ev.forceAsk, auto: ev.auto, error: ev.ok ? undefined : "有動作被拒絕：" + (ev.refused || []).map((r) => (r.index >= 0 ? "第 " + (r.index + 1) + " 步 " : "") + r.reason).join("；"), refused: ev.refused, ttlMs: S.DEFAULT_LIMITS.approvalTtlMs };
  };
  cu.execute = async function (planId, o) {
    o = o || {}; const p = plans.get(planId); if (!p) return fail("找不到這個計畫（過期或已執行過）：" + planId, "重新 plan");
    plans.delete(planId); if (now() - p.t > safety.limits.approvalTtlMs) return fail("計畫已過期（超過 " + Math.round(safety.limits.approvalTtlMs / 1000) + " 秒），請重新 plan");
    if (!p.ev.ok) return fail("這個計畫含被拒絕的動作，不能執行");
    if (safety.isAborted()) return fail("已中止：" + safety.state().abortReason);
    if (p.ev.needsApproval) {
      if (typeof opts.confirm !== "function") return fail("需要使用者核准，但這個環境沒有核准視窗（拒絕執行）", undefined, { code: "no_confirm" });
      let ans; try { ans = await opts.confirm({ preview: p.preview, steps: p.steps.map(publicStep), forceAsk: !!p.ev.forceAsk, source: p.source }); } catch (e) { return fail("核准視窗失敗：" + String((e && e.message) || e), undefined, { code: "confirm_error" }); }
      if (!ans || !ans.approved) return fail("使用者拒絕了這批動作", undefined, { code: "user_denied", refused: true });
      if (ans.auto && !p.ev.forceAsk) safety.setAuto(true);
      await refocus(p.activeBefore); // 核准視窗會搶走焦點：把焦點還給核准前作用中的視窗（若它在範圍內）
    }
    return runPlan(p, o);
  };
  cu.run = async function (steps, o) { const p = await cu.plan(steps, o); if (!p.ok) return p; const r = await cu.execute(p.planId, o); return Object.assign({ preview: p.preview }, r); };
  const publicStep = (s) => { const { _resolved, _xy, _error, ...rest } = s; return rest; };

  // 把焦點還給某個視窗（只在它仍在範圍內、不在拒絕清單、不是助理自己的時候）
  async function refocus(id) {
    if (!id) return; try { const b = ensureBackend(), l = await windows({ fresh: true }); if (!l.ok) return; const w = winById(l.windows, id); if (!w || !safety.inScope(w.id) || safety.denyMatch(w) || (opts.selfPids || [process.pid]).includes(Number(w.pid))) return; await b.windowAction("focus", w.id, {}); winCache = null; await sleep(180); } catch (_) { /* 還不回焦點，後面的重新檢查會擋下 */ }
  }
  async function runPlan(p, o) {
    const b = ensureBackend(), results = []; safety.setRunning(true); let stopped = null; const approvedUnverified = new Set(); // 同一批裡，同一個視窗只問一次「看不出是不是密碼欄」
    try {
      for (let i = 0; i < p.steps.length; i++) {
        if (safety.isAborted()) { stopped = { code: "aborted", reason: "使用者中止：" + safety.state().abortReason }; break; }
        let step = p.steps[i];
        const rc = safety.rateCheck(); if (!rc.ok) { stopped = { code: "rate", reason: rc.reason }; break; } if (rc.waitMs) await sleep(rc.waitMs);
        // 每一步執行前重新驗證（視窗可能已移動、被蓋住、焦點變了）
        if (S.OPS[step.op].kind !== "wait") {
          const ctx = await buildCtx({ fresh: true, needFocus: !!S.OPS[step.op].typing }); if (ctx.error) { stopped = { code: "ctx", reason: ctx.error.error }; break; }
          const re = safety.evaluate([Object.assign({}, step)], ctx);
          if (!re.ok) { stopped = { code: "revalidate", reason: "執行前重新檢查沒通過：" + (re.refused[0] && re.refused[0].reason) }; results.push({ index: i, op: step.op, ok: false, error: stopped.reason }); break; }
          if (re.forceAsk && !p.ev.forceAsk) {
            // 計畫時還不知道焦點在哪（前面的步驟會改變焦點），現在看不出是不是密碼欄：一定要問使用者（自動模式也一樣）
            const wk = String(((re.steps[0] || {}).window || {}).id || "?"); let ans = approvedUnverified.has(wk) ? { approved: true } : null; if (!ans && typeof opts.confirm === "function") { try { ans = await opts.confirm({ preview: "這一步要打字，但看不出焦點元件是不是密碼欄（沒有無障礙資訊）：\n" + S.describeStep(step, {}) + "\n\n確定要輸入嗎？", steps: [publicStep(step)], forceAsk: true, source: "typing-unverified" }); } catch (_) { ans = null; } }
            if (!ans || !ans.approved) { stopped = { code: "revalidate", reason: "執行前看不出焦點是不是密碼欄，使用者沒有核准，已停止" }; results.push({ index: i, op: step.op, ok: false, error: stopped.reason }); break; }
            approvedUnverified.add(wk); await refocus(wk === "?" ? null : wk);
          }
        }
        safety.rateNote();
        const r = await execStep(step, b).catch((e) => fail(String((e && e.message) || e)));
        results.push(Object.assign({ index: i, op: step.op }, r)); if (!safety.noteResult(!!r.ok)) { stopped = { code: "errors", reason: "連續失敗，自動中止" }; break; }
        if (!r.ok) { stopped = { code: "step_failed", reason: "第 " + (i + 1) + " 步失敗：" + (r.error || "") }; break; }
      }
    } finally { safety.setRunning(false); if (b && b.releaseAll && (safety.isAborted() || stopped)) { try { await b.releaseAll(); } catch (_) { /* */ } } }
    const out = { ok: !stopped && results.every((r) => r.ok), steps: results, completed: results.filter((r) => r.ok).length, total: p.steps.length, stopped: stopped || undefined, preview: p.preview };
    if (o && o.screenshotAfter) { await sleep(o.settleMs == null ? 250 : o.settleMs); const sc = safety.scope(); const wid = sc.windows[0] && sc.windows[0].id; const shot = await cu.screenshot(wid && sc.mode === "windows" ? { windowId: wid, maxSide: o.maxSide || 1024 } : { rect: undefined, screen: true, maxSide: o.maxSide || 1024 }); if (shot.ok) out.after = shot; }
    return out;
  }
  // 校準補償：若量到座標比例不是 1，送出前反向修正
  function unmap(x, y) { const c = calibration; if (!c || !c.apply) return { x, y }; return { x: Math.round((x - c.offset.x) / c.scale.x), y: Math.round((y - c.offset.y) / c.scale.y) }; }

  async function execStep(s, b) {
    const x = s._xy ? s._xy.x : Number(s.x), y = s._xy ? s._xy.y : Number(s.y);
    if (s.target && /^rfb:/.test(String(s.target))) return remoteStep(s);
    switch (s.op) {
      case "wait": await sleep(Math.min(safety.limits.maxWaitMs, Number(s.ms) || 0)); return { ok: true };
      case "move": return b.pointerMove(x, y);
      case "click": return b.click(x, y, { button: s.button || "left", count: 1 });
      case "double_click": return b.click(x, y, { button: s.button || "left", count: 2 });
      case "right_click": return b.click(x, y, { button: "right", count: 1 });
      case "middle_click": return b.click(x, y, { button: "middle", count: 1 });
      case "drag": { const p2 = s._xy ? unmap(Number(s.x2), Number(s.y2)) : { x: Number(s.x2), y: Number(s.y2) }; return b.drag(x, y, p2.x, p2.y, { button: s.button || "left" }); }
      case "scroll": return b.scroll(x, y, Number(s.dx) || 0, Number(s.dy) || 0);
      case "type": return b.typeText(String(s.text), { mode: s.mode === "paste" ? "paste" : "type", delayMs: s.delayMs });
      case "key": return b.key(S.normalizeChord(s.keys));
      case "clipboard_set": return b.clipboardSet(String(s.text));
      case "hover_probe": return hoverProbe(s, b, x, y);
      case "window_focus": case "window_move": case "window_resize": case "window_minimize": case "window_maximize": case "window_restore": case "window_close": {
        const act = s.op.slice(7), r = await b.windowAction(act, s.id || s.window, { x: s.x, y: s.y, w: s.w, h: s.h }); winCache = null;
        if (r.ok && (act === "move" || act === "resize")) { await sleep(150); const l = await windows({ fresh: true }); const w = l.ok ? winById(l.windows, s.id || s.window) : null; if (w) r.rect = w.frame || w.rect; }
        return r;
      }
      case "element_invoke": case "element_toggle": case "element_select": case "element_focus": case "element_set_value": return elementAction(s, b);
      default: return fail("不支援的動作 " + s.op);
    }
  }
  // 元件動作：先用無障礙 API；不行再退回座標點擊（元件中心）
  async function elementAction(s, b) {
    const e = (s._resolved && s._resolved.element) || cached(s.element); if (!e) return fail("找不到元件");
    const action = s.op.replace("element_", ""), api = /^atspi:/.test(s.element) ? atspi : /^uia:/.test(s.element) ? uia : null;
    let r = api ? await api.act(s.element, action, s.value) : fail("這種元件 id 沒有無障礙後端：" + s.element);
    if (r.ok) return Object.assign({ ok: true, via: "a11y", did: r.did }, e.rect ? { rect: e.rect } : {});
    if (s.fallback === false || !e.rect || action === "set_value") return Object.assign(fail("無障礙動作失敗：" + (r.error || ""), action === "set_value" ? "set_value 不退回座標（沒有安全的等價動作）" : undefined), { via: "a11y" });
    // 退回座標點擊：重新走安全檢查（點擊的位置要在範圍內、最上面的視窗要是範圍內的）；先確認元件座標沒有過期
    const ctx = await buildCtx({ fresh: true, needFocus: false }); const stale = elementStale(s.element, ctx.windows); if (stale) return fail("無障礙動作失敗（" + (r.error || "") + "），而且不能退回座標點擊：" + stale);
    const c = E.center(e.rect); const ck = safety.evaluate([{ op: "click", x: c.x, y: c.y }], ctx);
    if (!ck.ok) return fail("無障礙動作失敗（" + (r.error || "") + "），退回座標點擊也被安全規則拒絕：" + ck.refused[0].reason);
    const cr = action === "focus" ? await b.pointerMove(c.x, c.y) : await b.click(c.x, c.y, {}); return Object.assign({ via: "click-fallback", a11yError: r.error }, cr);
  }

  // ---------- 探索：移動滑鼠 → 拍照 → 比對（游標形狀、周圍變化） ----------
  async function hoverProbe(s, b, x, y) {
    const radius = Math.max(8, Math.min(120, Number(s.radius) || 40)), settle = Math.max(60, Math.min(1500, Number(s.settleMs) || 250));
    const l = await windows({ fresh: true }); const win = l.ok ? S.topmostAt(l.windows, x, y) : null, fr = win && (win.frame || win.rect);
    let rect = { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }; if (fr) { const ix = E.intersect(rect, fr); if (ix) rect = ix; }
    const park = { x: Math.max(fr ? fr.x + 2 : 0, rect.x - 14), y: Math.max(fr ? fr.y + 2 : 0, rect.y - 14) };
    await b.pointerMove(park.x, park.y); await sleep(settle);
    const c0 = b.cursorShape ? await b.cursorShape() : null, A = await b.screenshot({ kind: "rect", rect, pointer: false, wantImage: true });
    await b.pointerMove(x, y); await sleep(settle);
    const c1 = b.cursorShape ? await b.cursorShape() : null, B = await b.screenshot({ kind: "rect", rect, pointer: false, wantImage: true });
    if (!A.ok || !B.ok) return fail("探索拍照失敗：" + ((A.ok ? B : A).error || ""));
    const d = PNG.diff(A.image, B.image, { cols: 4, rows: 4 }), cn0 = c0 && c0.ok ? c0.name : null, cn1 = c1 && c1.ok ? c1.name : null;
    const kind1 = c1 && c1.ok ? E.classifyCursor(cn1 || (c1.hash && c1.hash !== (c0 && c0.hash) ? "custom" : "")) : null, kind0 = c0 && c0.ok ? E.classifyCursor(cn0) : null;
    const cursorChanged = c0 && c1 && c0.ok && c1.ok ? (c0.hash !== c1.hash || cn0 !== cn1) : null;
    return { ok: true, probe: { x, y, rect, cursor: c1 && c1.ok ? { name: cn1, kind: kind1, hash: c1.hash } : null, parkCursor: c0 && c0.ok ? { name: cn0, kind: kind0 } : null, cursorChanged, regionChanged: d.comparable && d.ratio > 0.002, changeRatio: Math.round(d.ratio * 10000) / 10000, changeBox: d.bbox ? { x: rect.x + d.bbox.x, y: rect.y + d.bbox.y, w: d.bbox.w, h: d.bbox.h } : null, interactive: !!(kind1 && E.INTERACTIVE_CURSORS.includes(kind1)) || !!(d.comparable && d.ratio > 0.002) } };
  }
  // 校準滑鼠座標比例與速度：移動到幾個已知點、讀回實際位置（有 pointerLocation 用它，沒有就比對「有／無游標」兩張截圖）
  cu.calibrate = async function (o) {
    o = o || {}; const b = ensureBackend(); if (!b) return noBackend(); if (!safety.state().enabled) return fail("電腦操作功能沒有啟用"); if (safety.isAborted()) return fail("已中止");
    const l = await windows({ fresh: true }); if (!l.ok) return l; const sc = safety.scope(); const wins = l.windows.filter((w) => sc.mode === "screen" || sc.windows.some((q) => q.id === String(w.id))).filter((w) => !w.minimized && !safety.denyMatch(w));
    if (!wins.length) return fail("範圍內沒有可用的視窗可以校準（滑鼠只會在範圍視窗內移動）"); const fr = wins[0].frame || wins[0].rect;
    const pts = [[0.25, 0.25], [0.5, 0.5], [0.75, 0.6]].map(([a, c]) => ({ x: Math.round(fr.x + fr.w * a), y: Math.round(fr.y + fr.h * c) })); const obs = []; let method = "none", totalMs = 0;
    for (const p of pts) {
      const t0 = now(); const mv = await b.pointerMove(p.x, p.y); totalMs += now() - t0; if (!mv.ok) return fail("移動失敗：" + mv.error); await sleep(120);
      let loc = b.pointerLocation ? await b.pointerLocation() : { ok: false };
      if (loc && loc.ok) { method = "pointerLocation"; obs.push({ x: loc.x, y: loc.y }); }
      else { const withP = await b.screenshot({ kind: "rect", rect: { x: p.x - 40, y: p.y - 40, w: 80, h: 80 }, pointer: true, wantImage: true }), noP = await b.screenshot({ kind: "rect", rect: { x: p.x - 40, y: p.y - 40, w: 80, h: 80 }, pointer: false, wantImage: true }); if (withP.ok && noP.ok && withP.pointer) { const d = PNG.diff(withP.image, noP.image, {}); if (d.bbox) { method = "screenshot-diff"; obs.push({ x: withP.origin.x + d.bbox.x, y: withP.origin.y + d.bbox.y, approx: true }); } } }
    }
    if (obs.length < 2) return { ok: true, method, scale: { x: 1, y: 1 }, offset: { x: 0, y: 0 }, note: "這個 session 讀不到游標位置，無法校準（假設比例 1）", calibrated: false };
    const fit = (k) => { const n = obs.length, xs = pts.slice(0, n).map((p) => p[k]), ys = obs.map((p) => p[k]), mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n; let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; } const m = den ? num / den : 1; return { scale: m, offset: my - m * mx }; };
    const fx = fit("x"), fy = fit("y"), maxErr = Math.max.apply(null, obs.map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y)));
    calibration = { scale: { x: Math.round(fx.scale * 1000) / 1000, y: Math.round(fy.scale * 1000) / 1000 }, offset: { x: Math.round(fx.offset), y: Math.round(fy.offset) }, maxErrorPx: Math.round(maxErr), method, moveMs: Math.round(totalMs / pts.length), apply: false, t: now() };
    if (method === "pointerLocation" && (Math.abs(calibration.scale.x - 1) > 0.02 || Math.abs(calibration.scale.y - 1) > 0.02) && o.apply !== false) calibration.apply = true;
    return Object.assign({ ok: true, calibrated: true, requested: pts, observed: obs }, calibration);
  };
  // 連續取樣（動畫偵測）：同一個矩形拍 N 張，回報每張相對前一張的變化比例
  cu.sample = async function (o) {
    o = o || {}; const b = ensureBackend(); if (!b) return noBackend(); const frames = Math.max(2, Math.min(20, o.frames || 6)), interval = Math.max(50, Math.min(2000, o.intervalMs || 150));
    let rect = o.rect; if (!rect && o.windowId) { const l = await windows({ fresh: true }); const w = l.ok && winById(l.windows, o.windowId); if (w) rect = w.frame || w.rect; }
    if (!rect) return fail("需要 rect 或 windowId"); const chk = safety.checkRead({ kind: "rect", rect }, { windows: (await windows()).windows || [] }); if (!chk.ok) return fail(chk.reason);
    const imgs = [], times = []; for (let i = 0; i < frames; i++) { const t0 = now(); const s = await b.screenshot({ kind: "rect", rect, wantImage: true }); if (!s.ok) return s; imgs.push(s.image); times.push(t0); if (i < frames - 1) await sleep(Math.max(0, interval - (now() - t0))); }
    const ratios = []; for (let i = 1; i < imgs.length; i++) ratios.push(Math.round(PNG.diff(imgs[i - 1], imgs[i], {}).ratio * 10000) / 10000); const changed = ratios.filter((r) => r > 0.002).length;
    return { ok: true, rect, frames, intervalMs: interval, ratios, changedFrames: changed, animated: changed >= Math.max(2, Math.floor((frames - 1) * 0.6)), spanMs: times[times.length - 1] - times[0], hint: changed >= 2 ? "這個區塊持續在變：多半是動畫／影片／遠端畫面，改用連續取樣觀察串流，不要用單張截圖判斷" : "沒有持續變化" };
  };
  cu.wait = async function (o) {
    o = o || {}; const b = ensureBackend(); if (!b) return noBackend(); const timeout = Math.min(60000, Math.max(100, o.timeoutMs || 10000));
    if (o.window) { const r = await b.waitForWindow(o.window, timeout); if (r.ok) { winCache = null; return Object.assign({ ok: true, kind: "window" }, { window: decorate(r.window), waitedMs: r.waitedMs }); } return r; }
    let rect = o.rect; if (!rect && o.windowId) { const l = await windows({ fresh: true }); const w = l.ok && winById(l.windows, o.windowId); if (w) rect = w.frame || w.rect; } if (!rect) return fail("wait 需要 window（等視窗出現）、或 rect／windowId（等畫面變化或穩定）");
    const chk = safety.checkRead({ kind: "rect", rect }, { windows: (await windows()).windows || [] }); if (!chk.ok) return fail(chk.reason);
    const mode = o.mode === "stable" ? "stable" : "change", thr = o.threshold == null ? 0.0002 : o.threshold, t0 = now(); let prev = (await b.screenshot({ kind: "rect", rect, wantImage: true })); if (!prev.ok) return prev; let lastChange = now();
    for (;;) {
      await sleep(180); if (safety.isAborted()) return fail("已中止");
      const cur = await b.screenshot({ kind: "rect", rect, wantImage: true }); if (!cur.ok) return cur; const ratio = PNG.diff(prev.image, cur.image, {}).ratio;
      if (mode === "change" && ratio > thr) return { ok: true, kind: "change", ratio, waitedMs: now() - t0 };
      if (ratio > thr) lastChange = now(); if (mode === "stable" && now() - lastChange >= (o.quietMs || 600)) return { ok: true, kind: "stable", waitedMs: now() - t0 };
      prev = cur; if (now() - t0 >= timeout) return fail(mode === "change" ? "等不到畫面變化（逾時 " + timeout + " ms）" : "畫面一直在變，沒有穩定下來（逾時 " + timeout + " ms）", undefined, { timedOut: true });
    }
  };

  // ---------- 遠端畫面 ----------
  cu.remoteProbe = async function (target) {
    if (!safety.state().enabled) return fail("電腦操作功能沒有啟用（/computer enable）");
    if (safety.isAborted()) return fail("已中止");
    const which = opts.which || ((n) => { try { return require("./computer-use-linux.js").findBin(n); } catch (_) { return ""; } });
    return R.probeRemote(target, { which });
  };
  const remoteSecret = (name) => (name && opts.secrets && opts.secrets.get ? opts.secrets.get(String(name)) : null);
  // o：{ kind:'rfb', host, port, wsUrl, secretName, label, shared }
  cu.remoteConnect = async function (o) {
    o = o || {}; if (!safety.state().enabled) return fail("電腦操作功能沒有啟用（/computer enable）"); if (safety.isAborted()) return fail("已中止：" + safety.state().abortReason);
    if (o.kind && o.kind !== "rfb") return fail("remote_connect 只支援 kind:'rfb'", o.kind === "rdp" ? "RDP：協定可辨識（remote_probe），但沒有內建 RDP 用戶端；請用 xfreerdp／mstsc 開視窗，再 /computer scope 選那個視窗（canvas），走視覺模型慢路徑" : undefined);
    if (sessions.size >= 3) return fail("同時最多 3 個遠端連線");
    const t = o.wsUrl ? { wsUrl: o.wsUrl } : R.parseTarget({ host: o.host, port: o.port }); if (!t.wsUrl && !t.host) return fail("需要 host:port 或 wsUrl");
    const where = t.wsUrl || (t.host + ":" + (t.port || 5900)), hasSecret = !!remoteSecret(o.secretName);
    const preview = "連線到遠端畫面（RFB／VNC）：" + where + (o.secretName ? "，使用機密「" + o.secretName + "」" + (hasSecret ? "（已設定）" : "（尚未設定！）") : "，不使用密碼") + "\n之後這個連線會加入操作範圍：AI 可以看到整個遠端畫面並送出滑鼠／鍵盤（打字一律需要你核准）。";
    if (typeof opts.confirm !== "function") return fail("需要使用者核准，但這個環境沒有核准視窗（拒絕連線）", undefined, { code: "no_confirm" });
    const ans = await opts.confirm({ preview, steps: [{ op: "remote_connect", where }], forceAsk: true, source: "remote_connect" }); if (!ans || !ans.approved) return fail("使用者拒絕了這個連線", undefined, { code: "user_denied", refused: true });
    const mk = opts.rfbFactory || ((q) => new (require("./rfb-client.js").RfbClient)(q)), id = "rfb:" + ++rfbSeq;
    const client = mk({ host: t.host, port: t.port || 5900, wsUrl: t.wsUrl, password: hasSecret ? remoteSecret(o.secretName) : undefined, shared: o.shared !== false, connectTimeoutMs: o.timeoutMs || 10000 });
    try { const info = await client.connect(); await client.waitForFrame(5000); client.on("error", () => { /* 斷線由 close 事件處理 */ }); client.on("close", () => { sessions.delete(id); safety.removeRfbScope(id); });
      sessions.set(id, { id, client, where, label: o.label || where, t: now() }); safety.addRfbScope(id);
      const target = R.makeRemoteTarget({ id, kind: "rfb", label: o.label || where, capabilities: { objects: "protocol", input: "protocol" }, endpoint: where, notes: ["物件是從損壞矩形／CopyRect／游標推出的候選區（remote_objects）；內容由視覺模型命名"] });
      return { ok: true, id, target, width: info.width, height: info.height, name: info.name, version: info.version, security: info.security };
    } catch (e) { try { client.close(); } catch (_) { /* */ } return fail("RFB 連線失敗：" + String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 300)); }
  };
  cu.remoteDisconnect = function (id) { const s = sessions.get(String(id)); if (!s) return { ok: false, error: "沒有這個連線 " + id }; try { s.client.releaseAll(); s.client.close(); } catch (_) { /* */ } sessions.delete(String(id)); safety.removeRfbScope(id); return { ok: true }; };
  cu.remoteList = () => ({ ok: true, sessions: Array.from(sessions.values()).map((s) => ({ id: s.id, where: s.where, label: s.label, width: s.client.width, height: s.client.height, name: s.client.name, updates: s.client.updateCount, ageMs: now() - s.t })) });
  cu.remoteObjects = async function (id, o) {
    o = o || {}; const s = sessions.get(String(id)); if (!s || !safety.rfbInScope(id)) return fail("沒有這個遠端連線（或不在範圍內）：" + id); if (safety.isAborted()) return fail("已中止");
    if (o.waitMs) await s.client.waitForUpdate(o.waitMs);
    const objs = require("./rfb-client.js").deriveObjects(s.client.updates, { sessionId: id, sinceMs: o.sinceMs || 8000, screen: { w: s.client.width, h: s.client.height }, pointer: s.client.pointer, cursor: s.client.cursor, maxObjects: o.maxObjects || 30 });
    return { ok: true, source: "rfb", target: id, objects: objs, screen: { width: s.client.width, height: s.client.height }, cursor: s.client.cursor ? { w: s.client.cursor.w, h: s.client.cursor.h, hotX: s.client.cursor.hotX, hotY: s.client.cursor.hotY, hash: s.client.cursor.hash } : null, pointer: s.client.pointer, coordinateSpace: "遠端畫面像素（左上角 0,0）", note: "RFB 沒有繪圖物件：這些是從最近的損壞矩形、CopyRect 搬移與游標推出的候選區；請用 describe（視覺模型）命名，並用 hover_probe 驗證" };
  };
  async function remoteStep(s) {
    const sess = sessions.get(String(s.target)); if (!sess) return fail("遠端連線已經不在了 " + s.target); const c = sess.client;
    switch (s.op) {
      case "wait": await sleep(Math.min(safety.limits.maxWaitMs, Number(s.ms) || 0)); return { ok: true };
      case "move": await c.move(Number(s.x), Number(s.y)); return { ok: true, via: "rfb" };
      case "click": await c.click(Number(s.x), Number(s.y), s.button || "left", 1); return { ok: true, via: "rfb" };
      case "double_click": await c.click(Number(s.x), Number(s.y), s.button || "left", 2); return { ok: true, via: "rfb" };
      case "right_click": await c.click(Number(s.x), Number(s.y), "right", 1); return { ok: true, via: "rfb" };
      case "middle_click": await c.click(Number(s.x), Number(s.y), "middle", 1); return { ok: true, via: "rfb" };
      case "drag": await c.drag(Number(s.x), Number(s.y), Number(s.x2), Number(s.y2), s.button || "left"); return { ok: true, via: "rfb" };
      case "scroll": await c.scroll(Number(s.x), Number(s.y), Number(s.dx) || 0, Number(s.dy) || 0); return { ok: true, via: "rfb" };
      case "type": await c.typeText(String(s.text), s.delayMs); return { ok: true, via: "rfb" };
      case "key": await c.keyChord(S.normalizeChord(s.keys)); return { ok: true, via: "rfb" };
      case "hover_probe": {
        // 遠端畫面不知道哪裡是視窗：停靠點選「離目標最遠的角落」（多半是桌面，游標是預設箭頭），再兩步移到目標（有些伺服器要連續兩個移動事件才更新游標）
        const r = Number(s.radius) || 40, rect = { x: Math.max(0, Number(s.x) - r), y: Math.max(0, Number(s.y) - r), w: r * 2, h: r * 2 }, W = c.width, H = c.height, park = { x: Number(s.x) < W / 2 ? W - 6 : 5, y: Number(s.y) < H / 2 ? H - 6 : 5 };
        await c.move(park.x, park.y); await sleep(60); await c.move(park.x + (park.x > 10 ? -1 : 1), park.y + (park.y > 10 ? -1 : 1)); await c.waitIdle(200, 1500);
        const A = c.screenshot({ rect, wantImage: true }), cur0 = c.cursor && c.cursor.hash;
        await c.move(Number(s.x) - 2, Number(s.y) - 2); await sleep(80); await c.move(Number(s.x), Number(s.y)); await c.waitIdle(250, 1500);
        const B = c.screenshot({ rect, wantImage: true }), cur1 = c.cursor && c.cursor.hash, d = PNG.diff(A.image, B.image, {});
        return { ok: true, probe: { x: s.x, y: s.y, rect, cursor: c.cursor ? { hash: cur1, w: c.cursor.w, h: c.cursor.h } : null, cursorChanged: cur0 !== cur1, regionChanged: d.ratio > 0.002, changeRatio: Math.round(d.ratio * 10000) / 10000, changeBox: d.bbox ? { x: rect.x + d.bbox.x, y: rect.y + d.bbox.y, w: d.bbox.w, h: d.bbox.h } : null, interactive: cur0 !== cur1 || d.ratio > 0.002 } };
      }
      default: return fail("遠端 RFB 目標不支援 " + s.op);
    }
  }
  cu._sessions = sessions; cu._shots = shots;
  return cu;
}

module.exports = { create };
