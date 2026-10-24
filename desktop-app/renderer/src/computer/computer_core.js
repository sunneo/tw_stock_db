// computer use 的純邏輯（renderer 端，UMD；node 與瀏覽器都能跑，嵌入成 FaComputerCore）：
// 動作詞彙與參數整理、座標換算（影像 ↔ 螢幕）、格線切塊、視覺模型答案的封閉詞彙解析、候選元件的整併與評分、`/computer` 指令解析、給使用者看的文字。
// 不碰 DOM、不碰 window.desktopAPI；真正的操作在主行程（computer-use*.js），這裡只負責「把弱模型的輸出變成可驗證的資料」。
// 詞彙（OPS 等）與主行程 computer-use-safety.js 必須一致——scripts/computer-tests/computer_core.test.js 會比對兩邊。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaComputerCore = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ===== 封閉詞彙 =====
    const OPS = ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'hover_probe', 'type', 'key', 'window_focus', 'window_move', 'window_resize', 'window_minimize', 'window_maximize', 'window_restore', 'window_close', 'element_invoke', 'element_set_value', 'element_toggle', 'element_select', 'element_focus', 'clipboard_set', 'wait'];
    const WINDOW_ACTIONS = ['focus', 'move', 'resize', 'minimize', 'maximize', 'restore', 'close'];
    const ELEMENT_ACTIONS = ['invoke', 'set_value', 'toggle', 'select', 'focus'];
    const BUTTONS = ['left', 'right', 'middle'];
    const ROLES = ['button', 'checkbox', 'radio', 'textbox', 'password', 'label', 'link', 'image', 'menu', 'menuitem', 'menubar', 'tab', 'tablist', 'list', 'listitem', 'tree', 'treeitem', 'table', 'row', 'cell', 'combobox', 'slider', 'spinbutton', 'scrollbar', 'progressbar', 'toolbar', 'statusbar', 'titlebar', 'window', 'dialog', 'pane', 'group', 'separator', 'tooltip', 'document', 'heading', 'canvas', 'app', 'unknown'];
    const REMOTE_KINDS = ['window', 'rfb', 'rdp', 'nx', 'spice', 'canvas'];
    // 給弱模型問的「封閉問題」的答案詞彙（一個字就能答）。key＝正規化後的角色，value＝同義詞
    const WIDGET_VOCAB = {
        button: ['button', 'btn', 'push button', 'pushbutton', '按鈕', '按鍵'],
        textbox: ['textbox', 'text box', 'text field', 'textfield', 'input', 'edit', 'entry', 'search box', 'searchbox', 'field', '輸入框', '文字框', '搜尋框', '欄位'],
        checkbox: ['checkbox', 'check box', 'toggle', 'switch', '核取方塊', '勾選'],
        radio: ['radio', 'radio button', '單選'],
        menu: ['menu', 'menu bar', 'menubar', 'dropdown', 'drop-down', 'context menu', 'start menu', '選單', '功能表', '開始功能表'],
        tab: ['tab', 'tabs', 'tab bar', 'browser tab', '分頁', '頁籤'],
        toolbar: ['toolbar', 'tool bar', 'ribbon', '工具列'],
        titlebar: ['title bar', 'titlebar', 'window title', '標題列'],
        scrollbar: ['scrollbar', 'scroll bar', '捲軸'],
        sash: ['sash', 'splitter', 'divider', 'resize handle', 'separator', '分隔條'],
        icon: ['icon', 'icons', 'logo', 'symbol', '圖示'],
        link: ['link', 'hyperlink', 'url', '連結'],
        image: ['image', 'picture', 'photo', 'thumbnail', 'video', '圖片', '影像'],
        label: ['text', 'label', 'caption', 'heading', 'title', 'paragraph', '文字', '標籤'],
        list: ['list', 'table', 'tree', 'grid', 'file list', '清單', '表格'],
        slider: ['slider', 'progress bar', 'progress', '滑桿', '進度'],
        dialog: ['dialog', 'popup', 'pop-up', 'message box', 'alert', '對話框', '視窗'],
        none: ['none', 'nothing', 'empty', 'blank', 'background', 'no', 'unknown', '沒有', '空白', '背景'],
    };
    const WIDGET_TO_ROLE = { button: 'button', textbox: 'textbox', checkbox: 'checkbox', radio: 'radio', menu: 'menu', tab: 'tab', toolbar: 'toolbar', titlebar: 'titlebar', scrollbar: 'scrollbar', sash: 'separator', icon: 'image', link: 'link', image: 'image', label: 'label', list: 'list', slider: 'slider', dialog: 'dialog' };
    const INTERACTIVE_WIDGETS = ['button', 'textbox', 'checkbox', 'radio', 'menu', 'tab', 'link', 'sash', 'slider', 'icon', 'scrollbar'];
    // 游標形狀（主行程 computer-use-elements.js 的 classifyCursor 輸出）→ 這個位置的互動性
    const CURSOR_TO_WIDGET = { clickable: 'button', text: 'textbox', 'sash-horizontal': 'sash', 'sash-vertical': 'sash', 'resize-corner': 'sash', move: 'titlebar', crosshair: 'canvas', busy: null, 'default': null };

    // ===== 工具函式 =====
    const isNum = (v) => typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
    const num = (v) => Number(v);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const area = (r) => (r ? Math.max(0, r.w) * Math.max(0, r.h) : 0);
    const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
    const inside = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const intersect = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h); return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null; };
    const iou = (a, b) => { const i = intersect(a, b); if (!i) return 0; const u = area(a) + area(b) - area(i); return u ? area(i) / u : 0; };
    const union = (a, b) => { const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

    // ===== 座標換算（影像 ↔ 螢幕）。shot＝{ origin:{x,y}, scale:{x,y}|number }（影像像素／螢幕像素）=====
    const scaleOf = (shot) => { const s = shot && shot.scale; return typeof s === 'number' ? { x: s, y: s } : { x: (s && s.x) || 1, y: (s && s.y) || 1 }; };
    const originOf = (shot) => (shot && shot.origin) || { x: 0, y: 0 };
    function imagePointToScreen(shot, p) { const s = scaleOf(shot), o = originOf(shot); return { x: Math.round(o.x + p.x / s.x), y: Math.round(o.y + p.y / s.y) }; }
    function imageBoxToScreen(shot, b) { const s = scaleOf(shot), o = originOf(shot); return { x: Math.round(o.x + b.x / s.x), y: Math.round(o.y + b.y / s.y), w: Math.round(b.w / s.x), h: Math.round(b.h / s.y) }; }
    function screenBoxToImage(shot, b) { const s = scaleOf(shot), o = originOf(shot); return { x: Math.round((b.x - o.x) * s.x), y: Math.round((b.y - o.y) * s.y), w: Math.round(b.w * s.x), h: Math.round(b.h * s.y) }; }
    // 視覺模型回的框可能是「0~1 的比例」「0~1000 的座標（Florence loc 記號）」「影像像素」：統一成影像像素 {x,y,w,h}
    function normalizeBox(box, imgW, imgH, hint) {
        if (!box) return null; let x0, y0, x1, y1;
        if (Array.isArray(box)) { [x0, y0, x1, y1] = box.map(Number); } else if ('x1' in box) { x0 = +box.x1; y0 = +box.y1; x1 = +box.x2; y1 = +box.y2; } else { x0 = +box.x; y0 = +box.y; x1 = x0 + (+box.w || +box.width || 0); y1 = y0 + (+box.h || +box.height || 0); }
        if (![x0, y0, x1, y1].every(Number.isFinite)) return null; if (x1 < x0) { const t = x0; x0 = x1; x1 = t; } if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
        const mx = Math.max(x0, y0, x1, y1); let mode = hint || (mx <= 1.0001 ? 'unit' : (mx <= 1000 && (imgW > 1000 || imgH > 1000) ? 'k' : 'px'));
        if (mode === 'unit') { x0 *= imgW; x1 *= imgW; y0 *= imgH; y1 *= imgH; } else if (mode === 'k') { x0 = x0 / 1000 * imgW; x1 = x1 / 1000 * imgW; y0 = y0 / 1000 * imgH; y1 = y1 / 1000 * imgH; }
        x0 = clamp(x0, 0, imgW); x1 = clamp(x1, 0, imgW); y0 = clamp(y0, 0, imgH); y1 = clamp(y1, 0, imgH);
        const w = x1 - x0, h = y1 - y0; return w > 1 && h > 1 ? { x: Math.round(x0), y: Math.round(y0), w: Math.round(w), h: Math.round(h) } : null;
    }
    // 從一段文字裡抓框：JSON 陣列／物件、"x1,y1,x2,y2"、Florence 的 label<loc_123><loc_45>… 序列（每個框四個 loc，0~999）
    function parseBoxes(text, imgW, imgH) {
        const out = []; const t = String(text || '');
        const loc = /([A-Za-z][\w \-]{0,30})?((?:<loc_\d+>){4})/g; let m;
        while ((m = loc.exec(t))) { const n = (m[2].match(/\d+/g) || []).map(Number); const b = normalizeBox([n[0], n[1], n[2], n[3]], imgW, imgH, 'k'); if (b) out.push({ label: (m[1] || '').trim(), box: b }); }
        if (out.length) return out;
        try { const j = JSON.parse(t.slice(t.search(/[\[{]/)).replace(/[\]}][^\]}]*$/, (s) => s[0])); const arr = Array.isArray(j) ? j : (j && (j.boxes || j.objects || j.detections)) || [j]; for (const o of arr) { const b = normalizeBox(o.bbox || o.box || o.rect || o, imgW, imgH); if (b) out.push({ label: String(o.label || o.name || o.text || ''), box: b }); } } catch (_) { /* 不是 JSON */ }
        if (out.length) return out;
        const re = /\(?\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?\)?/g;
        while ((m = re.exec(t))) { const b = normalizeBox([m[1], m[2], m[3], m[4]], imgW, imgH); if (b) out.push({ label: '', box: b }); }
        return out;
    }

    // ===== 格線 =====
    // 依影像大小挑格數：每格約 maxCellPx（弱模型看小圖比較準）；至少 1x1、至多 maxCells 格
    function chooseGrid(w, h, o) {
        o = o || {}; const cell = o.maxCellPx || 256, maxCells = o.maxCells || 24; let cols = Math.max(1, Math.round(w / cell)), rows = Math.max(1, Math.round(h / cell));
        while (cols * rows > maxCells) { if (cols >= rows) cols--; else rows--; }
        return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
    }
    function gridCells(w, h, cols, rows) { const out = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const x0 = Math.floor((c * w) / cols), x1 = Math.floor(((c + 1) * w) / cols), y0 = Math.floor((r * h) / rows), y1 = Math.floor(((r + 1) * h) / rows); out.push({ col: c, row: r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); } return out; }
    const cellAt = (cells, x, y) => cells.find((c) => inside(c, x, y)) || null;
    // 子格：把一格再切 n×n（找到有東西的格之後，再縮小範圍問一次）
    const subCells = (cell, n) => gridCells(cell.w, cell.h, n, n).map((c) => Object.assign({}, c, { x: cell.x + c.x, y: cell.y + c.y, parent: { col: cell.col, row: cell.row } }));

    // ===== 視覺模型答案 → 封閉詞彙 =====
    // 回傳 { widget, role, confidence, raw }；答案裡找不到詞彙就是 null（不亂猜）
    function parseWidget(text) {
        const raw = String(text == null ? '' : text).trim(), t = raw.toLowerCase(); if (!t) return { widget: null, role: null, confidence: 0, raw };
        // 找出答案裡所有詞彙；挑「最長」的同義詞（"browser tab" 比後面才出現的 "picture" 更具體），同長度取最早出現的；沒有其他詞彙時才採用 none
        let best = null, bestNone = null;
        for (const [w, syns] of Object.entries(WIDGET_VOCAB)) for (const s of syns) {
            const re = /^[\x00-\x7f]+$/.test(s) ? new RegExp('(^|[^a-z])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(s|es)?($|[^a-z])') : null; const idx = re ? t.search(re) : t.indexOf(s); if (idx < 0) continue;
            const cand = { widget: w, len: s.length, at: idx };
            if (w === 'none') { if (!bestNone || idx < bestNone.at) bestNone = cand; continue; }
            if (!best || cand.len > best.len || (cand.len === best.len && cand.at < best.at)) best = cand;
        }
        const pick = best || bestNone; if (!pick) return { widget: null, role: null, confidence: 0, raw };
        const short = t.split(/\s+/).length <= 3; return { widget: pick.widget, role: WIDGET_TO_ROLE[pick.widget] || null, confidence: pick.widget === 'none' ? 0.6 : (short ? 0.7 : 0.5), raw };
    }
    function parseYesNo(text) { const t = String(text || '').trim().toLowerCase(); if (!t) return null; const head = t.slice(0, 24); if (/^(yes|yeah|yep|y\b|true|是|有|對|可以|能)/.test(head)) return true; if (/^(no\b|nope|none|false|not\b|否|沒有|不是|沒|無)/.test(head)) return false; if (/\b(no|not|none|nothing|cannot|can't|don't see|isn't|aren't|without)\b/.test(t)) return false; if (/\b(yes|there is|there are|i can see|visible)\b/.test(t)) return true; return null; }

    // ===== 候選元件 =====
    // 視覺模型／RFB／游標探索找到的框，統一成跟 AT-SPI／UIA 同一種 element（source:'vlm'）
    function makeVlmElement(o) {
        const rect = o.rect, w = o.widget || null;
        return { id: 'vlm:' + (o.shotId || 'shot') + ':' + (o.n != null ? o.n : 0), source: o.source || 'vlm', role: ROLES.includes(o.role) ? o.role : (WIDGET_TO_ROLE[w] || 'unknown'), rawRole: w || '', name: String(o.name || '').slice(0, 120), description: String(o.description || '').slice(0, 200), value: null, text: o.text == null ? null : String(o.text).slice(0, 400), automationId: '', className: '', rect, enabled: true, visible: true, focused: false, selected: false, checked: null, isPassword: false, states: o.states || [], actions: [], window: o.window || null, app: '', pid: null, confidence: Math.round(clamp(o.confidence == null ? 0.3 : o.confidence, 0, 1) * 100) / 100, verified: o.verified || null, cell: o.cell || null };
    }
    // 去重：重疊度高的合併（保留信心高的、補上另一個的名稱／文字）
    function mergeCandidates(list, thr) {
        thr = thr == null ? 0.5 : thr; const out = [];
        for (const c of list.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
            const hit = out.find((o) => iou(o.rect, c.rect) >= thr);
            if (hit) { if (!hit.name && c.name) hit.name = c.name; if (hit.text == null && c.text != null) hit.text = c.text; if (hit.role === 'unknown' && c.role !== 'unknown') { hit.role = c.role; hit.rawRole = c.rawRole; } hit.confidence = Math.min(0.95, Math.max(hit.confidence, c.confidence) + 0.05); }
            else out.push(Object.assign({}, c));
        }
        return out;
    }
    // 驗證結果（主行程 hover_probe 的 probe 物件）→ 對候選的判定與信心調整
    // probe：{ cursor:{kind,name}, cursorChanged, regionChanged, changeRatio, interactive }
    function applyProbe(cand, probe) {
        if (!probe) return Object.assign({}, cand, { verified: cand.verified || { by: 'none' } });
        const kind = probe.cursor && probe.cursor.kind, w = kind && CURSOR_TO_WIDGET[kind] !== undefined ? CURSOR_TO_WIDGET[kind] : null; let conf = cand.confidence || 0.3, role = cand.role, rawRole = cand.rawRole, notes = [];
        if (kind === 'text') { conf += 0.3; if (role === 'unknown' || role === 'label') { role = 'textbox'; rawRole = 'textbox'; } notes.push('游標變成文字輸入形狀'); }
        else if (kind === 'clickable') { conf += 0.3; if (role === 'unknown' || role === 'label') { role = 'button'; rawRole = 'button'; } notes.push('游標變成手形（可點擊）'); }
        else if (kind === 'sash-horizontal' || kind === 'sash-vertical') { conf += 0.35; role = 'separator'; rawRole = 'sash'; notes.push('游標變成調整大小形狀（分隔條／sash）'); }
        else if (kind === 'busy') notes.push('游標顯示忙碌');
        else if (probe.cursorChanged) { conf += 0.15; notes.push('游標形狀有變'); }
        if (probe.regionChanged) { conf += 0.2; notes.push('滑鼠移上去周圍有變化（hover 效果）'); }
        if (!probe.interactive && !probe.cursorChanged && !probe.regionChanged) { conf -= 0.2; notes.push('移上去沒有任何反應：可能只是文字或背景'); }
        const verdict = probe.interactive ? 'interactive' : 'inert';
        return Object.assign({}, cand, { role, rawRole, confidence: Math.round(clamp(conf, 0.05, 0.98) * 100) / 100, verified: { by: 'hover_probe', verdict, cursor: probe.cursor || null, cursorChanged: !!probe.cursorChanged, regionChanged: !!probe.regionChanged, changeRatio: probe.changeRatio, notes } });
    }
    // 把動作會碰到的元件挑出來優先驗證：互動類的角色、信心中等（太低不值得、太高不用驗）、面積不要太大
    function pickForProbe(cands, max) {
        const score = (c) => { let s = 0; if (INTERACTIVE_WIDGETS.includes(c.rawRole) || ['button', 'textbox', 'checkbox', 'radio', 'tab', 'link', 'menu', 'slider', 'scrollbar'].includes(c.role)) s += 2; else if (c.role === 'unknown') s += 1; if (s > 0 && c.confidence >= 0.3 && c.confidence <= 0.8) s += 1; if (c.verified && c.verified.by === 'hover_probe') s -= 5; if (area(c.rect) > 200000) s -= 2; return s; };
        return cands.slice().sort((a, b) => score(b) - score(a)).filter((c) => score(c) > 0).slice(0, max || 8);
    }

    // ===== 動作整理 =====
    // 把工具參數（弱模型可能寫成各種樣子）整理成主行程要的 steps；回傳 { ok, steps, errors }
    const STEP_ALIASES = { tap: 'click', press: 'key', keypress: 'key', hotkey: 'key', write: 'type', input: 'type', dblclick: 'double_click', doubleclick: 'double_click', rightclick: 'right_click', context_click: 'right_click', mousemove: 'move', hover: 'move', scroll_down: 'scroll', scroll_up: 'scroll', sleep: 'wait', delay: 'wait', focus_window: 'window_focus', close_window: 'window_close', probe: 'hover_probe' };
    function normalizeStep(raw) {
        if (!raw || typeof raw !== 'object') return { error: '動作要是物件' }; const s = Object.assign({}, raw); let op = String(s.op || s.action || s.type_ || '').toLowerCase().trim(); delete s.action;
        if (op === 'type' && !('text' in s) && 'keys' in s) op = 'key'; if (STEP_ALIASES[op]) { if (op === 'scroll_down') s.dy = s.dy || 3; if (op === 'scroll_up') s.dy = -Math.abs(s.dy || 3); op = STEP_ALIASES[op]; }
        if (op === 'click' && (s.button === 'right')) op = 'right_click'; else if (op === 'click' && s.button === 'middle') op = 'middle_click'; else if (op === 'click' && (s.count === 2 || s.double)) op = 'double_click';
        if (!OPS.includes(op)) return { error: '不認得的動作 ' + JSON.stringify(raw.op || raw.action) + '；可用：' + OPS.join('、') };
        s.op = op; delete s.double; delete s.count;
        for (const k of ['x', 'y', 'x2', 'y2', 'dx', 'dy', 'w', 'h', 'ms', 'radius', 'settleMs']) if (k in s && isNum(s[k])) s[k] = num(s[k]);
        if ('keys' in s) s.keys = String(s.keys); if ('window' in s && !('id' in s)) s.id = s.window; if ('window_id' in s && !('id' in s)) { s.id = s.window_id; delete s.window_id; } if ('element_id' in s && !('element' in s)) { s.element = s.element_id; delete s.element_id; }
        if (/^window_/.test(op) && !s.id) return { error: op + ' 需要 id（視窗 id，從 computer_list_windows 取得）' };
        if (/^element_/.test(op) && !s.element) return { error: op + ' 需要 element（元件 id，從 computer_ui_tree／computer_find_element 取得）' };
        if (['move', 'click', 'double_click', 'right_click', 'middle_click', 'scroll', 'hover_probe'].includes(op) && !s.element && !(isNum(s.x) && isNum(s.y))) return { error: op + ' 需要數字座標 x、y（螢幕座標），或 element（元件 id）' };
        if (op === 'drag' && !(isNum(s.x) && isNum(s.y) && isNum(s.x2) && isNum(s.y2))) return { error: 'drag 需要 x、y、x2、y2' };
        if (op === 'type' && typeof s.text !== 'string') return { error: 'type 需要 text（字串）' };
        if (op === 'key' && !s.keys) return { error: 'key 需要 keys（例如 ctrl+s、Enter、alt+Left）' };
        if (op === 'wait' && !isNum(s.ms)) s.ms = 500;
        if (op === 'scroll' && !isNum(s.dy) && !isNum(s.dx)) s.dy = 3;
        const out = {}; for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== null && v !== '') out[k] = v; return { step: out };
    }
    function normalizeSteps(list) {
        const errors = [], steps = []; if (!Array.isArray(list) || !list.length) return { ok: false, steps: [], errors: ['steps 要是非空陣列'] };
        list.forEach((r, i) => { const n = normalizeStep(r); if (n.error) errors.push('第 ' + (i + 1) + ' 步：' + n.error); else steps.push(n.step); });
        return { ok: !errors.length, steps, errors };
    }

    // ===== /computer 指令解析 =====
    // 回傳 { cmd, args } ；cmd：status|enable|disable|scope|auto|abort|resume|windows|probe|connect|disconnect|secret|deny|help
    function parseCommand(argsText) {
        const a = String(argsText || '').trim(), parts = a.split(/\s+/).filter(Boolean), head = (parts[0] || 'status').toLowerCase(), rest = parts.slice(1);
        const alias = { on: 'enable', start: 'enable', '啟用': 'enable', off: 'disable', stop: 'disable', '停用': 'disable', '關閉': 'disable', '範圍': 'scope', '中止': 'abort', stop_: 'abort', cancel: 'abort', '視窗': 'windows', list: 'windows', '狀態': 'status', '自動': 'auto', '說明': 'help', '?': 'help', '連線': 'connect', '探測': 'probe', '斷線': 'disconnect' };
        const cmd = alias[head] || head;
        if (!['status', 'enable', 'disable', 'scope', 'auto', 'abort', 'resume', 'windows', 'probe', 'connect', 'disconnect', 'secret', 'deny', 'help', 'calibrate'].includes(cmd)) return { cmd: 'help', args: [], unknown: head };
        if (cmd === 'auto') { const v = (rest[0] || 'on').toLowerCase(); return { cmd, args: [/^(off|0|false|關|關閉)$/.test(v) ? 'off' : 'on'] }; }
        if (cmd === 'scope') return { cmd, args: rest.map((x) => x.toLowerCase()) };
        return { cmd, args: rest };
    }
    function parseSecretCommand(args) { const [sub, name, ...pw] = args || []; if (!/^(set|delete|list)$/.test(sub || '')) return { error: '用法：/computer secret set <名稱> <密碼>、/computer secret delete <名稱>、/computer secret list' }; if (sub === 'list') return { sub }; if (!name) return { error: '需要名稱' }; if (sub === 'delete') return { sub, name }; const password = pw.join(' '); if (!password) return { error: '需要密碼（密碼只會送到主行程儲存，不會留在對話裡；建議改用設定畫面或環境變數 FA_VNC_PASSWORD_<名稱>）' }; return { sub, name, password }; }

    // ===== 給使用者看的文字 =====
    function statusText(st, cap) {
        if (!st) return '電腦操作：這個環境沒有桌面版（只有桌面版支援）。';
        const L = []; L.push('**電腦操作**：' + (st.enabled ? '✅ 已啟用' : '⛔ 未啟用（預設關閉；/computer enable）') + (st.aborted ? '｜🛑 已中止（' + (st.abortReason || '') + '）' : '') + (st.auto ? '｜自動核准：開' : ''));
        const sc = st.scope || { mode: 'none', windows: [], rfb: [] };
        L.push('範圍：' + (sc.mode === 'screen' ? '整個螢幕' : sc.mode === 'windows' ? (sc.windows.map((w) => '「' + w.title + '」').join('、') || '（只有遠端連線）') + (sc.rfb && sc.rfb.length ? '＋遠端 ' + sc.rfb.join('、') : '') : '尚未指定（/computer scope）'));
        if (st.limits) L.push('限制：每批最多 ' + st.limits.maxStepsPerBatch + ' 步、每分鐘 ' + st.limits.maxActionsPerMinute + ' 個動作、單次打字 ' + st.limits.maxTypeChars + ' 字；中止鍵 ' + (st.abortHotkey || 'Ctrl+Alt+Shift+Esc') + ' 或 Esc。');
        if (cap && cap.ok) L.push('這台機器：' + cap.summary + (cap.notes && cap.notes.length ? '\n注意：' + cap.notes.join('；') : '') + (cap.hints && cap.hints.length ? '\n建議安裝：' + cap.hints.join('；') : ''));
        if (st.remote && st.remote.length) L.push('遠端連線：' + st.remote.join('、'));
        return L.join('\n');
    }
    function helpText() {
        return ['**/computer** — 讓 AI 操作這台電腦（只有桌面版；預設關閉）', '',
            '- `/computer` 或 `/computer status`：目前狀態、範圍、這台機器能做什麼（以及為什麼有些不能）',
            '- `/computer enable`／`disable`：啟用（要在原生視窗確認）／停用',
            '- `/computer scope`：開視窗選 AI 可以操作的視窗（`/computer scope screen` 是整個螢幕，不建議）',
            '- `/computer auto on|off`：本次工作階段自動核准已驗證的點擊與按鍵（打字看不出焦點時仍會問）',
            '- `/computer abort`／`resume`：中止全部動作（也可按 Esc 或 Ctrl+Alt+Shift+Esc）／恢復',
            '- `/computer windows`：列出視窗（受保護的視窗會標示）',
            '- `/computer probe <host:port|ws://…>`：探測遠端桌面協定（RFB／RDP／NX／SPICE）',
            '- `/computer connect <host:port|ws://…> [機密名稱]`、`/computer disconnect <id>`：用內建 VNC（RFB）用戶端連線',
            '- `/computer secret set|delete|list …`：遠端連線的密碼（只存在主行程）',
            '- `/computer deny <regex>`：自己追加不能碰的視窗（標題／類別／行程）',
            '- `/computer calibrate`：量滑鼠座標比例與速度',
            '', '安全：每一批動作先預覽、你核准才執行；只在你指定的視窗範圍內；不會在密碼欄打字、不碰系統設定／付款／驗證視窗。'].join('\n');
    }
    // 計畫結果轉成給模型看的精簡文字（避免整段 JSON 太長）
    function summarizeRun(r) {
        if (!r) return { ok: false, error: '沒有結果' };
        const out = { ok: !!r.ok, completed: r.completed, total: r.total };
        if (r.error) out.error = r.error; if (r.code) out.code = r.code; if (r.refused && !Array.isArray(r.refused)) out.refused = true; if (Array.isArray(r.refused)) out.refused = r.refused.map((x) => (x.index >= 0 ? '第' + (x.index + 1) + '步：' : '') + x.reason);
        if (r.stopped) out.stopped = r.stopped; if (r.preview) out.preview = r.preview;
        if (Array.isArray(r.steps)) out.steps = r.steps.map((s) => { const o = { op: s.op, ok: !!s.ok }; if (s.via) o.via = s.via; if (s.error) o.error = s.error; if (s.rect) o.rect = s.rect; if (s.probe) o.probe = s.probe; return o; });
        return out;
    }

    return { OPS, WINDOW_ACTIONS, ELEMENT_ACTIONS, BUTTONS, ROLES, REMOTE_KINDS, WIDGET_VOCAB, WIDGET_TO_ROLE, INTERACTIVE_WIDGETS, CURSOR_TO_WIDGET, isNum, clamp, area, center, inside, intersect, iou, union, scaleOf, originOf, imagePointToScreen, imageBoxToScreen, screenBoxToImage, normalizeBox, parseBoxes, chooseGrid, gridCells, cellAt, subCells, parseWidget, parseYesNo, makeVlmElement, mergeCandidates, applyProbe, pickForProbe, normalizeStep, normalizeSteps, parseCommand, parseSecretCommand, statusText, helpText, summarizeRun };
});
