// The frame that /edit-svg and /edit-picture share (the screen of /edit-web is its own, ported from the desktop assistant): a title bar (undo / redo, export, prompt), the OBJECTS view (layers: show / hide,
// lock, rename, reorder, duplicate, delete, select) with the editor's properties panel under it, the middle viewer tabs of the editor, and on the right the AI chat (pictures can be pasted or dropped into
// it) and the history of steps. Every state of the document is a step (undo / redo, click a step to go back); the project is saved by the host after each change; the whole thing is a window
// (AiChatWindow: pop out, maximise) and a message of the conversation.
//
//   FaEditShell.mount({ id, kind, title, W, spec, state, host, container, restoring, tabs:[{id,label}], build(ctx) -> { tabs:{id:element}, properties?:element, refresh(spec, selectedId), bar?:[elements] },
//                       objectInfo?(obj) -> small text, objectIcon?(obj) -> glyph, parseCommands?(text, spec) -> { edits, unmatched }, exports:[{id,label,chat?:true}], runExport(id, spec) -> Promise<{blob,name}>,
//                       build's result may have env() -> { view:{x,y,w,h} } (where the user is looking: 'place relative to the view'),
//                       promptOf?(spec, steps) -> text, placeholder, intro, extraPrompt?, windowKey?,
//                       previewEdits?({spec0, next, edits, words, rejected}) -> Promise<boolean> (what the AI changed is shown first; true = apply, false = take it back), confirmRemove?(obj, spec) -> boolean,
//                       treeRows?(spec, collapsed) -> [{obj, depth}] (a TREE in the objects view, parents before children; groups fold), onObjectOpen?(obj) (double click on a row: the editor opens the object by itself instead of renaming it) }) -> element with el._ed = { getState, reload, setSpec, undo, redo, send(text), select(id), getSpec, ctx }
//   host: { ask({text, images, spec, selection, onStatus}) -> Promise<{say, edits, notes}>, save(state), download(blob,name), toChat?(blob, name, {title, prompt}), polish?(text) -> Promise<text>, palette?() }
//   W (the document core, from FaEditObjects.make): validate, applyEdits, editWords, list, find, bounds?
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditShell = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAXSTATES = 40;
  var CSS = '.few{--bg:#fff;--fg:#1f2328;--bd:#d0d7de;--hd:#f6f8fa;--mut:#59636e;--acc:#0969da;--ok:#1a7f37;--bad:#cf222e;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:13px system-ui,"Microsoft JhengHei",sans-serif;margin:6px 0;overflow:hidden;max-width:100%;display:flex;flex-direction:column}.few.dark{--bg:#0d1117;--fg:#e6edf3;--bd:#30363d;--hd:#161b22;--mut:#8b949e;--acc:#2f81f7;--ok:#3fb950;--bad:#f85149}'
    + '.few *{box-sizing:border-box}.few button{background:var(--hd);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}.few button:hover:not(:disabled){border-color:var(--acc)}.few button:disabled{opacity:.4;cursor:default}.few button.pri{background:var(--acc);border-color:var(--acc);color:#fff}'
    + '.few input,.few select,.few textarea{background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 6px;font:inherit;max-width:100%}.few textarea{width:100%;resize:vertical}.few textarea.code{font:12px/1.45 ui-monospace,Consolas,monospace;tab-size:2;white-space:pre;overflow:auto}'
    + '.few .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--hd);border-bottom:1px solid var(--bd);flex-wrap:wrap}.few .ttl{font-weight:600;margin-right:auto}.few .st{color:var(--mut);font-size:12px}.few .bad{color:var(--bad)}.few .good{color:var(--ok)}'
    + '.few .main{display:flex;flex-wrap:wrap;align-items:stretch;flex:1;min-height:0}.few .dock{border-top:1px solid var(--bd);padding:6px 8px;display:flex;flex-direction:column;gap:4px;background:var(--hd)}.few .dock .say{font-size:12px;color:var(--mut);max-height:3.4em;overflow:auto;white-space:pre-wrap;word-break:break-word}.few .dock .say:empty{display:none}.few .dock .in{display:flex;gap:6px;align-items:flex-end}.few .dock textarea{flex:1;min-width:0;resize:vertical;min-height:2.6em;max-height:9em}.few .objs{flex:0 0 224px;min-width:200px;display:flex;flex-direction:column;border-right:1px solid var(--bd);max-height:640px;overflow:auto}.few .mid{flex:1.6 1 380px;min-width:300px;display:flex;flex-direction:column;min-height:420px}.few .side{flex:1 1 300px;min-width:260px;min-height:200px;display:flex;flex-direction:column;border-left:1px solid var(--bd);max-height:640px}'
    + '.few .sp{flex:0 0 6px;background:transparent;position:relative;z-index:2;touch-action:none}.few .sp.v{cursor:col-resize;border-left:1px solid transparent}.few .sp.h{cursor:row-resize;flex:0 0 6px;border-top:1px solid var(--bd)}.few .sp:hover,.few .sp.drag{background:var(--acc);opacity:.45}.few .main:not(.nw) .sp.v{display:none}.few .main.nw{flex-wrap:nowrap}.few .main.nw .objs{flex:0 0 var(--lw,224px);width:var(--lw,224px);min-width:0}.few .main.nw .side{flex:0 0 var(--rw,321px);width:var(--rw,321px);min-width:0}.few .main.nw .mid{flex:1 1 0;min-width:160px}.few .hidden-p{display:none!important}'
    + '.few .tabs{display:flex;border-bottom:1px solid var(--bd);background:var(--hd)}.few .tabs span{padding:6px 12px;cursor:pointer;color:var(--mut);border-bottom:2px solid transparent}.few .tabs span.on{color:var(--fg);border-bottom-color:var(--acc);font-weight:600}.few .pane{display:none;flex:1;overflow:auto;padding:8px;min-height:240px;flex-direction:column;gap:6px}.few .pane.on{display:flex}.few .pane.vp{padding:0;overflow:hidden;height:460px;flex:0 0 auto;min-height:0}.few.fwin-pop .pane.vp,.few.fwin-max .pane.vp{height:auto;flex:1 1 0}.few.fwin-pop .main,.few.fwin-max .main{flex:1;min-height:0;overflow:hidden}.few.fwin-pop .mid,.few.fwin-max .mid{min-height:0;overflow:hidden}.few .dock{flex:0 0 auto}.few.fwin-pop .objs,.few.fwin-max .objs,.few.fwin-pop .side,.few.fwin-max .side{max-height:none}'
    + '.few .oh{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--bd);background:var(--hd);font-weight:600}.few .ol{display:flex;flex-direction:column}.few .ob{display:flex;align-items:center;gap:4px;padding:3px 6px;border-bottom:1px solid transparent;cursor:pointer}.few .ob:hover{background:rgba(120,140,200,.10)}.few .ob.sel{background:rgba(47,129,247,.18)}.few .ob.hid .nm{opacity:.45;text-decoration:line-through}.few .ob.new{animation:fewnew 1.6s ease-out}@keyframes fewnew{from{background:rgba(26,127,55,.35)}to{background:transparent}}'
    + '.few .ob .ic{width:20px;text-align:center}.few .ob .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.few .ob .nm small{color:var(--mut);margin-left:4px}.few .ob .tb{display:none;gap:2px}.few .ob:hover .tb,.few .ob.sel .tb{display:inline-flex}.few .ob .tb button{padding:0 4px;font-size:12px;line-height:18px}.few .ob input.rn{flex:1;min-width:0}'
    + '.few .prop{border-top:1px solid var(--bd);padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}.few .prop label{display:flex;align-items:center;gap:6px;color:var(--mut)}.few .prop label input[type=number]{width:72px}.few .prop label input[type=text]{flex:1}.few .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}'
    + '.few .log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:120px}.few .msg{padding:5px 8px;border-radius:7px;max-width:92%;white-space:pre-wrap;word-break:break-word}.few .msg.u{align-self:flex-end;background:var(--acc);color:#fff}.few .msg.a{align-self:flex-start;background:var(--hd);border:1px solid var(--bd)}.few .chip{display:inline-block;margin:2px 3px 0 0;padding:0 6px;border-radius:9px;background:rgba(47,129,247,.15);font-size:11px}.few .chip.rej{background:rgba(248,81,73,.18)}'
    + '.few .att{display:flex;gap:4px;flex-wrap:wrap}.few .att span{position:relative;display:inline-block}.few .att img{height:44px;border:1px solid var(--bd);border-radius:4px}.few .att b{position:absolute;top:-5px;right:-5px;background:var(--bad);color:#fff;border-radius:50%;width:15px;height:15px;font-size:10px;line-height:15px;text-align:center;cursor:pointer}'
    + '.few .hist div{padding:3px 6px;border-radius:5px;cursor:pointer;border:1px solid transparent}.few .hist div:hover{border-color:var(--bd)}.few .hist div.cur{background:rgba(47,129,247,.14);font-weight:600}.few .hist div.fut{opacity:.45}.few .sum{padding:8px;border-bottom:1px solid var(--bd);background:var(--hd);display:none;flex-direction:column;gap:6px}.few .sum.on{display:flex}';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mount(opt) {
    var W = opt.W, host = opt.host || {}, el = h('div', 'few'), dark = false;
    try { dark = !!(host.palette && host.palette().dark); } catch (e) { dark = false; }
    if (dark) { el.className += ' dark'; }
    if (!document.getElementById('few-css')) { var st0 = document.createElement('style'); st0.id = 'few-css'; st0.textContent = CSS; (document.head || document.documentElement).appendChild(st0); }
    var S = { v: 1, ptr: 0, states: [], log: [] }, midTab = (opt.tabs[0] || {}).id, rightTab = 'ai', selected = null, pending = [], busy = false, saveT = null, newIds = {}, editor = null, selFns = [];
    function initState(state, spec) {
      if (state && Array.isArray(state.states) && state.states.length) {
        S = { v: 1, ptr: Math.max(0, Math.min(state.states.length - 1, state.ptr | 0)), states: state.states.slice(-MAXSTATES).map(function (x) { return { spec: W.validate(x.spec).spec, summary: x.summary || '', text: x.text || '', kind: x.kind || 'panel', t: x.t || 0, by: x.by || undefined }; }), log: Array.isArray(state.log) ? state.log.slice(-60) : [] };
        if (S.ptr >= S.states.length) { S.ptr = S.states.length - 1; }
      } else { S = { v: 1, ptr: 0, states: [{ spec: W.validate(spec || {}).spec, summary: '開始', text: '', kind: 'start', t: Date.now() }], log: [] }; }
    }
    function cur() { return S.states[S.ptr].spec; }
    function getState() { var st = { v: 1, ptr: S.ptr, states: S.states, log: S.log.slice(-60) }; try { while (JSON.stringify(st).length > 3000000 && st.states.length > 2) { st.states = st.states.slice(1); st.ptr = Math.max(0, st.ptr - 1); } } catch (e) { /* keep */ } return st; }
    function persist() { clearTimeout(saveT); saveT = setTimeout(function () { try { if (host.save) { host.save(getState()); } } catch (e) { /* this change still counts */ } }, 400); }
    function commit(spec, summary, text, kind, by) { S.states = S.states.slice(0, S.ptr + 1); S.states.push({ spec: W.validate(spec).spec, summary: summary || '', text: text || '', kind: kind || 'panel', t: Date.now(), by: by || undefined }); if (S.states.length > MAXSTATES) { S.states.shift(); } S.ptr = S.states.length - 1; render(); persist(); }
    function env() { var e = {}; try { e = editor && editor.env ? (editor.env() || {}) : {}; } catch (x) { e = {}; } e.selection = selected; return e; }
    function apply(edits, summary, text, kind) {
      var r = W.applyEdits(cur(), edits, env()); if (!r.applied.length) { return r; }
      var words = summary || r.appliedEdits.map(W.editWords).filter(Boolean).join('；');
      (r.added || []).forEach(function (id) { newIds[id] = 1; });
      commit(r.spec, words, text, kind); if (r.added && r.added.length) { select(r.added[r.added.length - 1]); }
      return r;
    }
    function undo() { if (S.ptr > 0) { S.ptr--; render(); persist(); } }
    function redo() { if (S.ptr < S.states.length - 1) { S.ptr++; render(); persist(); } }
    function select(id) { selected = id || null; renderObjects(); if (editor && editor.refresh) { editor.refresh(cur(), selected); } selFns.forEach(function (f) { try { f(selected); } catch (e) { /* editor's problem */ } }); }

    // ───── frame ─────
    var bar = h('div', 'bar'), ttl = h('span', 'ttl', opt.title), stat = h('span', 'st'), bUndo = h('button', null, '↶ 復原'), bRedo = h('button', null, '↷ 重做'), bSum = h('button', null, '📝 整理成 prompt'), bExp = h('select');
    bUndo.title = 'Ctrl+Z'; bRedo.title = 'Ctrl+Y';
    var eo = h('option', null, '📤 輸出…'); eo.value = ''; bExp.appendChild(eo);
    (opt.exports || []).forEach(function (x) { var o1 = h('option', null, '⬇ 下載 ' + x.label); o1.value = 'dl:' + x.id; bExp.appendChild(o1); if (x.chat !== false && host.toChat) { var o2 = h('option', null, '💬 放進對話 ' + x.label); o2.value = 'chat:' + x.id; bExp.appendChild(o2); } });
    var bStar = h('button', null, '⭐ 存成案例'); bStar.title = '把這次做好的結果存成案例（進離線訓練器的知識）：下次相似的需求會拿它當參考，弱模型與離線模型會直接用它當起點；/edit-svg、/edit-3d、/edit-game-2d 後面接一句話也會用到'; if (!host.saveCase) { bStar.style.display = 'none'; }
    [ttl, stat, bUndo, bRedo, bSum, bStar, bExp].forEach(function (x) { bar.appendChild(x); });
    // 「🛰️ AI 在：本機／別台機器」：這個編輯器裡的 AI 請求交給群組裡哪台做（host.aiWhere 由桌面版的遠端橋接提供；沒有就不顯示）
    var aiSel = null;
    function refreshAi() {
      var w = host.aiWhere; if (!w) { return; } var vis = true; try { vis = w.visible ? !!w.visible() : true; } catch (e) { vis = true; }
      if (!aiSel) { aiSel = h('select'); aiSel.title = '這個編輯器裡的 AI 請求（說話改、找圖、生圖…）交給群組裡哪台機器做；文件與素材會傳過去，改動傳回來。選「本機」就跟以前一樣。'; aiSel.onchange = function () { try { var r = w.set(aiSel.value); if (r && r.then) { r.then(refreshAi); } } catch (e) { /* 選擇失敗就維持原樣 */ } }; bar.insertBefore(aiSel, bExp); }
      aiSel.style.display = vis ? '' : 'none'; if (!vis) { return; }
      var cur = ''; try { cur = w.get() || ''; } catch (e) { cur = ''; } aiSel.textContent = '';
      var opts = []; try { opts = w.options() || []; } catch (e) { opts = []; } if (cur && !opts.some(function (x) { return x.value === cur; })) { opts.push({ value: cur, label: '（離線的機器）' }); }
      opts.forEach(function (x) { var o2 = h('option', null, '🛰️ AI 在：' + x.label); o2.value = x.value; if (x.disabled) { o2.disabled = true; } aiSel.appendChild(o2); }); aiSel.value = cur;
    }
    refreshAi(); bar.addEventListener('mouseenter', refreshAi);
    var sum = h('div', 'sum'), sumTa = h('textarea'); sumTa.rows = 9; var sumRow = h('div', 'row'), bCopy = h('button', null, '📋 複製'), bPol = h('button', null, '✨ 請 AI 潤飾'), bSumX = h('button', null, '✕');
    sumRow.appendChild(h('span', 'st', '只收沒被復原、而且真的改變了成品的那幾輪對話；可以貼到別處重現')); [bCopy, bPol, bSumX].forEach(function (x) { sumRow.appendChild(x); }); sum.appendChild(sumTa); sum.appendChild(sumRow);
    var main = h('div', 'main'), objs = h('div', 'objs'), mid = h('div', 'mid'), mTabs = h('div', 'tabs'), side = h('div', 'side'), rTabs = h('div', 'tabs');
    var oh = h('div', 'oh', '🗂 物件'), ol = h('div', 'ol'), prop = h('div', 'prop'); objs.appendChild(oh); objs.appendChild(ol); objs.appendChild(prop);
    var mp = {}, rp = { ai: h('div', 'pane'), hist: h('div', 'pane hist') };
    opt.tabs.forEach(function (t) { var s = h('span', null, t.label); s.setAttribute('data-t', t.id); s.onclick = function () { midTab = t.id; showTabs(); if (editor && editor.showTab) { editor.showTab(t.id); } }; mTabs.appendChild(s); mp[t.id] = h('div', 'pane' + (t.viewer ? ' vp' : '')); });
    [['ai', '🤖 AI 助手'], ['hist', '🕘 記錄']].forEach(function (t) { var s = h('span', null, t[1]); s.setAttribute('data-t', t[0]); s.onclick = function () { rightTab = t[0]; showTabs(); }; rTabs.appendChild(s); });
    mid.appendChild(mTabs); opt.tabs.forEach(function (t) { mid.appendChild(mp[t.id]); }); side.appendChild(rTabs); ['ai', 'hist'].forEach(function (k) { side.appendChild(rp[k]); });
    main.appendChild(objs); main.appendChild(mid); main.appendChild(side); el.appendChild(bar); el.appendChild(sum); el.appendChild(main);
    // ───── layout: left / right panels and the chat box at the bottom can be dragged to any size, and the left and right panels can be hidden (the choice is remembered per editor kind) ─────
    var spL = h('div', 'sp v'), spR = h('div', 'sp v'), spD = h('div', 'sp h'), LAY = { lw: 224, rw: 321, dh: 0, lc: false, rc: false }, layKey = 'fa_few_layout:' + (opt.kind || 'x');
    try { var savedLay = JSON.parse(localStorage.getItem(layKey) || 'null'); if (savedLay && typeof savedLay === 'object') { ['lw', 'rw', 'dh'].forEach(function (k) { if (isFinite(savedLay[k])) { LAY[k] = Number(savedLay[k]); } }); LAY.lc = !!savedLay.lc; LAY.rc = !!savedLay.rc; } } catch (e) { /* no storage: defaults */ }
    spL.title = '拖曳調整左邊寬度（連點兩下＝隱藏）'; spR.title = '拖曳調整右邊寬度（連點兩下＝隱藏）'; spD.title = '拖曳調整下面輸入框的高度';
    var bL = h('button', null, '◧'), bR = h('button', null, '◨'); bL.title = '隱藏／顯示左邊的物件欄'; bR.title = '隱藏／顯示右邊的 AI 助手'; bar.insertBefore(bR, bar.firstChild); bar.insertBefore(bL, bar.firstChild);
    function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function saveLay() { try { localStorage.setItem(layKey, JSON.stringify(LAY)); } catch (e) { /* not saved */ } }
    function applyLay() {
      var wide = el.clientWidth >= 760; main.classList.toggle('nw', wide);
      main.style.setProperty('--lw', clampN(LAY.lw, 120, Math.max(160, el.clientWidth * 0.5)) + 'px'); main.style.setProperty('--rw', clampN(LAY.rw, 160, Math.max(200, el.clientWidth * 0.6)) + 'px');
      [objs, spL].forEach(function (x) { x.classList.toggle('hidden-p', LAY.lc); }); [side, spR].forEach(function (x) { x.classList.toggle('hidden-p', LAY.rc); });
      bL.classList.toggle('on', !LAY.lc); bR.classList.toggle('on', !LAY.rc); bL.style.opacity = LAY.lc ? '.55' : ''; bR.style.opacity = LAY.rc ? '.55' : '';
      if (LAY.dh > 0) { ta.style.height = LAY.dh + 'px'; ta.style.maxHeight = 'none'; } else { ta.style.height = ''; ta.style.maxHeight = ''; }
    }
    function dragSp(sp, which) {
      sp.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) { return; } ev.preventDefault();
        var x0 = ev.clientX, y0 = ev.clientY, w0 = which === 'L' ? objs.getBoundingClientRect().width : which === 'R' ? side.getBoundingClientRect().width : ta.getBoundingClientRect().height; sp.classList.add('drag'); try { sp.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
        function mv(e) { var dx = e.clientX - x0, dy = e.clientY - y0; if (which === 'L') { LAY.lw = clampN(w0 + dx, 120, Math.max(160, el.clientWidth * 0.5)); } else if (which === 'R') { LAY.rw = clampN(w0 - dx, 160, Math.max(200, el.clientWidth * 0.6)); } else { LAY.dh = clampN(w0 - dy, 40, Math.max(120, (window.innerHeight || 800) * 0.6)); } applyLay(); }
        function up() { sp.classList.remove('drag'); sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); saveLay(); }
        sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
      });
    }
    dragSp(spL, 'L'); dragSp(spR, 'R'); dragSp(spD, 'D');
    bL.onclick = function () { LAY.lc = !LAY.lc; applyLay(); saveLay(); }; bR.onclick = function () { LAY.rc = !LAY.rc; applyLay(); saveLay(); };
    spL.addEventListener('dblclick', function () { LAY.lc = true; applyLay(); saveLay(); }); spR.addEventListener('dblclick', function () { LAY.rc = true; applyLay(); saveLay(); }); spD.addEventListener('dblclick', function () { LAY.dh = 0; applyLay(); saveLay(); });
    if (typeof ResizeObserver === 'function') { new ResizeObserver(function () { applyLay(); }).observe(el); }
    main.insertBefore(spL, mid); main.insertBefore(spR, side);
    function showTabs() {
      Array.prototype.forEach.call(mTabs.children, function (s) { s.className = s.getAttribute('data-t') === midTab ? 'on' : ''; }); Array.prototype.forEach.call(rTabs.children, function (s) { s.className = s.getAttribute('data-t') === rightTab ? 'on' : ''; });
      Object.keys(mp).forEach(function (k) { mp[k].className = mp[k].className.replace(/ on\b/, '') + (k === midTab ? ' on' : ''); }); Object.keys(rp).forEach(function (k) { rp[k].className = 'pane' + (k === 'hist' ? ' hist' : '') + (k === rightTab ? ' on' : ''); });
    }

    // ───── objects view (layers) ─────
    var rnId = null, collapsed = {};
    function renderObjects() {
      var s = cur(), sp = W.validate(s).spec; ol.textContent = ''; oh.textContent = '🗂 物件（' + sp.objects.length + '）';
      if (!sp.objects.length) { ol.appendChild(h('div', 'st', '（還沒有物件：對 AI 說要加什麼，或從上面的起手式開始）')); ol.lastChild.style.padding = '8px'; }
      var treeRows = opt.treeRows ? opt.treeRows(sp, collapsed) : null, rowsList = treeRows || sp.objects.slice().reverse().map(function (x) { return { obj: x, depth: 0 }; });
      rowsList.forEach(function (rr, k) {
        var o = rr.obj;
        var row = h('div', 'ob' + (o.id === selected ? ' sel' : '') + (o.visible ? '' : ' hid') + (newIds[o.id] ? ' new' : '')), ic = h('span', 'ic', opt.objectIcon ? opt.objectIcon(o) : '◻'), nm = h('span', 'nm');
        row.setAttribute('data-id', o.id); nm.appendChild(document.createTextNode(o.name)); var info = opt.objectInfo ? opt.objectInfo(o) : o.type; if (info) { nm.appendChild(h('small', null, info)); }
        var eye = h('button', null, o.visible ? '👁' : '—'), lock = h('button', null, o.locked ? '🔒' : '🔓'), tb = h('span', 'tb'), up = h('button', null, '▲'), dn = h('button', null, '▼'), dup = h('button', null, '⧉'), del = h('button', null, '🗑');
        eye.title = '顯示／隱藏'; lock.title = '鎖定／解鎖'; up.title = treeRows ? '往上移' : '往上一層'; dn.title = treeRows ? '往下移' : '往下一層'; dup.title = '複製'; del.title = '刪除';
        if (treeRows) { row.style.paddingLeft = (6 + rr.depth * 14) + 'px'; if (o.type === 'group') { ic.textContent = collapsed[o.id] ? '▸' : '▾'; ic.style.cursor = 'pointer'; ic.title = '收合／展開'; ic.onclick = function (ev) { ev.stopPropagation(); collapsed[o.id] = !collapsed[o.id]; renderObjects(); }; } }
        function act(e, fn) { return function (ev) { ev.stopPropagation(); fn(); }; }
        function moved(r, o) { if (r && r.applied && r.applied.length && opt.orderNote) { var n = ''; try { n = opt.orderNote(o, cur()) || ''; } catch (e) { n = ''; } if (n) { stat.textContent = n; setTimeout(function () { stat.textContent = ''; }, 5000); } } return r; }
        // 面板上的按鈕沒做成（例如已經在最前面）要說原因，不能默默沒反應
        function said(r) { if (r && !(r.applied && r.applied.length) && r.rejected && r.rejected.length) { stat.textContent = r.rejected[0].error || '這個動作沒有做成'; setTimeout(function () { stat.textContent = ''; }, 3000); } return r; }
        eye.onclick = act(0, function () { said(apply([{ op: 'set_visible', id: o.id, visible: !o.visible }], (o.visible ? '隱藏 ' : '顯示 ') + o.name, '', 'panel')); });
        lock.onclick = act(0, function () { apply([{ op: 'set_locked', id: o.id, locked: !o.locked }], (o.locked ? '解鎖 ' : '鎖定 ') + o.name, '', 'panel'); });
        up.onclick = act(0, function () { moved(said(apply([{ op: 'move_object', id: o.id, to: treeRows ? 'earlier' : 'up' }], o.name + ' 往上一層', '', 'panel')), o); });
        dn.onclick = act(0, function () { moved(said(apply([{ op: 'move_object', id: o.id, to: treeRows ? 'later' : 'down' }], o.name + ' 往下一層', '', 'panel')), o); });
        dup.onclick = act(0, function () { apply([{ op: 'duplicate_object', id: o.id }], '複製 ' + o.name, '', 'panel'); });
        del.onclick = act(0, function () { if (opt.confirmRemove && !opt.confirmRemove(o, cur())) { return; } var r = apply([{ op: 'remove_object', id: o.id }], '刪掉 ' + o.name, '', 'panel'); if (r.rejected && r.rejected.length) { stat.textContent = r.rejected[0].error; setTimeout(function () { stat.textContent = ''; }, 3000); } else if (selected === o.id) { selected = null; } });
        [up, dn, dup, del].forEach(function (b) { tb.appendChild(b); });
        row.onclick = function () { select(o.id === selected ? null : o.id); };
        row.ondblclick = function (ev) { ev.stopPropagation(); if (opt.onObjectOpen) { opt.onObjectOpen(o); return; } rnId = o.id; var inp = h('input', 'rn'); inp.value = o.name; nm.textContent = ''; nm.appendChild(inp); inp.focus(); inp.select(); var done = function (ok) { var v = inp.value.trim(); rnId = null; if (ok && v && v !== o.name) { apply([{ op: 'rename_object', id: o.id, name: v }], o.name + ' 改名為 ' + v, '', 'panel'); } else { renderObjects(); } }; inp.onkeydown = function (e2) { e2.stopPropagation(); if (e2.key === 'Enter') { done(true); } else if (e2.key === 'Escape') { done(false); } }; inp.onblur = function () { done(true); }; inp.onclick = function (e3) { e3.stopPropagation(); }; };
        [ic, nm, tb, eye, lock].forEach(function (x) { row.appendChild(x); }); ol.appendChild(row);
      });
      newIds = {};
    }

    // ───── history ─────
    function renderHist() { var p = rp.hist; p.textContent = ''; p.appendChild(h('div', 'st', '點一步就回到那一步（之後的步驟還在，可以重做）：')); S.states.forEach(function (s, i) { var d = h('div', i === S.ptr ? 'cur' : (i > S.ptr ? 'fut' : ''), (i + 1) + '. ' + (byLabel(s.by) ? '[' + byLabel(s.by) + '] ' : '') + (s.summary || '（沒有說明）') + (s.text ? '　— 「' + s.text.slice(0, 30) + '」' : '')); d.onclick = function () { S.ptr = i; render(); persist(); }; p.appendChild(d); }); }

    // ───── AI chat (pictures can be pasted / dropped in) ─────
    var logEl = h('div', 'log'), attEl = h('div', 'att'), inRow = h('div', 'row'), ta = h('textarea'), bAtt = h('button', null, '📎'), bSend = h('button', 'pri', '送出'), file = h('input'); file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.style.display = 'none';
    ta.rows = 2; ta.placeholder = opt.placeholder || ''; bAtt.title = '附圖（也可以直接貼上、拖進來）'; inRow.appendChild(bAtt); inRow.appendChild(bSend);
    var dock = h('div', 'dock'), dockSay = h('div', 'say'), dockIn = h('div', 'in');   // the AI chat box: always at the bottom of the editor, whatever the width, so it is always in sight
    rp.ai.appendChild(logEl); dockIn.appendChild(ta); dockIn.appendChild(inRow); inRow.style.flexDirection = 'column'; inRow.style.alignItems = 'stretch'; dock.appendChild(dockSay); dock.appendChild(attEl); dock.appendChild(dockIn); dock.appendChild(file); el.appendChild(spD); el.appendChild(dock); applyLay();
    // 這則/這一步是誰做的：AI 由別台執行時標「🛰️ 機器名稱 · AI」（請求者不是自己時再加「應 X 要求」）；人做的別人的步驟標「🖥️ 名稱」。自己做的不加標籤
    function byLabel(by) { if (!by) { return ''; } var me = (host.selfName && host.selfName()) || ''; if (by.src === 'ai' && by.exec) { return '🛰️ ' + by.exec.name + ' · AI' + (by.req && by.req.name && by.req.name !== me ? '　應 ' + by.req.name + ' 要求' : ''); } if (by.name && by.name !== me) { return (by.kind === 'web' ? '🌐 ' : '🖥️ ') + by.name; } return ''; }
    function addMsg(role, text, chips, rejected, by) { var m = h('div', 'msg ' + (role === 'user' ? 'u' : 'a')); var bl = byLabel(by); if (bl) { var bs = h('span', 'chip by', bl); bs.title = '這一則是誰做的'; m.appendChild(bs); } m.appendChild(document.createTextNode(text || '')); (chips || []).forEach(function (c) { m.appendChild(h('span', 'chip', c)); }); (rejected || []).forEach(function (c) { m.appendChild(h('span', 'chip rej', c)); }); logEl.appendChild(m); logEl.scrollTop = logEl.scrollHeight; return m; }
    function renderLog() { logEl.textContent = ''; if (!S.log.length && opt.intro) { addMsg('ai', opt.intro); } var lastAi = S.log.slice().reverse().filter(function (m) { return m.role === 'ai'; })[0]; dockSay.textContent = lastAi ? lastAi.text : ''; S.log.forEach(function (m) { addMsg(m.role, m.text, m.chips, m.rejected, m.by); }); }
    function readFile(f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res({ name: f.name || 'image', dataUrl: String(r.result) }); }; r.onerror = function () { res(null); }; r.readAsDataURL(f); }); }
    function addFiles(files) { Promise.all(Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); }).slice(0, 3).map(readFile)).then(function (list) { list.filter(Boolean).forEach(function (x) { if (pending.length < 3) { pending.push(x); } }); renderAtt(); }); }
    function renderAtt() { attEl.textContent = ''; pending.forEach(function (x, i) { var s = h('span'), im = h('img'); im.src = x.dataUrl; im.alt = x.name; var rm = h('b', null, '×'); rm.onclick = function () { pending.splice(i, 1); renderAtt(); }; s.appendChild(im); s.appendChild(rm); attEl.appendChild(s); }); }
    bAtt.onclick = function () { file.click(); }; file.onchange = function () { addFiles(file.files); file.value = ''; };
    ta.addEventListener('paste', function (ev) { var items = ev.clipboardData && ev.clipboardData.files; if (items && items.length) { addFiles(items); ev.preventDefault(); } });
    [rp.ai, dock].forEach(function (zone) { ['dragover', 'drop'].forEach(function (n) { zone.addEventListener(n, function (ev) { ev.preventDefault(); if (n === 'drop' && ev.dataTransfer) { addFiles(ev.dataTransfer.files); } }); }); });
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); } });
    async function send() {
      var text = ta.value.trim(), imgs = pending.slice(); if (busy || (!text && !imgs.length)) { return; }
      busy = true; bSend.disabled = true; ta.value = ''; pending = []; renderAtt(); rightTab = 'ai'; showTabs();
      var um = { role: 'user', text: (text || '（附圖）') + (imgs.length ? '　📎×' + imgs.length : '') }; S.log.push(um); addMsg('user', um.text, imgs.length ? [] : []); var think = addMsg('ai', '…'); dockSay.textContent = '…';
      var chips = [], rej = [], byAns = null, say = '', spec0 = cur(), edits = [], applied = 0, words = [], ans0 = null;
      try {
        var pr = text && opt.parseCommands ? opt.parseCommands(text, spec0) : { edits: [], unmatched: text ? [text] : [] }; edits = pr.edits.slice(); var rest = pr.unmatched.join('，');
        if ((rest || imgs.length) && host.ask) {
          var ans = ans0 = await host.ask({ text: rest, images: imgs, spec: spec0, selection: selected, fresh: effectiveSteps().length === 0, onStatus: function (t) { think.textContent = t; dockSay.textContent = t; } });
          say = (ans && ans.say) || ''; byAns = ans && ans.by ? ans.by : null; if (ans && ans.edits) { edits = edits.concat(ans.edits); } if (ans && ans.notes) { ans.notes.forEach(function (n) { chips.push(n); }); }
        } else if (rest) { say = '我沒聽懂：「' + rest.slice(0, 40) + '」。這個環境沒有 AI 可以幫忙，可以直接在物件欄與屬性面板改。'; }
        var r = W.applyEdits(spec0, edits, env()), next = spec0;
        if (r.applied.length) { next = r.spec; r.appliedEdits.forEach(function (e) { words.push(W.editWords(e)); }); }
        (r.rejected || []).forEach(function (x) { rej.push('✗ ' + x.op + '：' + x.error); });
        var aiMade = !!(rest && ans0 && ans0.edits && ans0.edits.length), accepted = true;
        if (opt.previewEdits && aiMade && JSON.stringify(next) !== JSON.stringify(spec0)) { think.textContent = '改動先放在預覽(綠＝新增、黃＝修改、紅虛線＝刪除),按「接受」才套用…'; dockSay.textContent = think.textContent; try { accepted = await opt.previewEdits({ spec0: spec0, next: next, edits: r.appliedEdits || [], words: words.slice(), rejected: r.rejected || [] }); } catch (pe) { accepted = true; } if (!accepted) { next = spec0; say = '已退回這一輪的改動(沒有套用)。'; words = []; chips = []; } }
        if (JSON.stringify(next) !== JSON.stringify(spec0)) {
          (r.added || []).forEach(function (id) { newIds[id] = 1; }); commit(next, words.filter(Boolean).join('；'), text || '（附圖）', imgs.length ? 'image' : 'chat', aiMade && byAns ? byAns : undefined); applied = words.length; words.forEach(function (w) { chips.push('✓ ' + w); });
          if (r.added && r.added.length) { select(r.added[r.added.length - 1]); } else if (selected && W.find(cur(), selected) < 0) { select(null); }
        }
        if (!applied && (rej.length || chips.length)) { say = say && !rej.length && chips.length ? say : '這次沒有改成：'; }
        if (!say) { say = applied ? '改好了：' : '這樣已經是目前的樣子了。'; }
      } catch (e) { say = '這次沒成功：' + String((e && e.message) || e).slice(0, 160); }
      think.remove(); var am = { role: 'ai', text: say, chips: chips.slice(0, 14), rejected: rej.slice(0, 6), by: byAns || undefined }; S.log.push(am); addMsg('ai', am.text, am.chips, am.rejected, am.by); dockSay.textContent = am.text + (am.chips.length ? '  ' + am.chips.slice(0, 4).join('  ') : '') + (am.rejected.length ? '  ' + am.rejected.slice(0, 2).join('  ') : ''); persist(); busy = false; bSend.disabled = false;
    }
    bSend.onclick = send;

    // ───── prompt, export ─────
    // the steps that count: the ones up to the current position (an undone step is never in it) that really changed the document and carry what the user said
    function effectiveSteps() { return S.states.slice(0, S.ptr + 1).filter(function (s) { return s.kind !== 'start' && s.kind !== 'undo' && (s.text || s.summary); }); }
    function defaultPrompt(spec, steps) {
      var L = ['請做一份「' + spec.title + '」，畫布 ' + spec.canvas.w + '×' + spec.canvas.h + '，背景 ' + spec.canvas.bg + '。', '', '物件（由下到上）：'];
      spec.objects.forEach(function (o, i) { L.push((i + 1) + '. ' + o.name + '（' + o.type + '）' + (opt.objectInfo ? ' ' + opt.objectInfo(o) : '')); });
      var texts = steps.filter(function (s) { return s.text; });
      if (texts.length) { L.push('', '（有效的指示，依序）：'); texts.forEach(function (s, i) { L.push((i + 1) + '. ' + s.text + (s.summary ? ' → ' + s.summary : '')); }); }
      return L.join('\n');
    }
    bSum.onclick = function () { var sp = W.validate(cur()).spec, steps = effectiveSteps(); sumTa.value = opt.promptOf ? opt.promptOf(sp, steps) : defaultPrompt(sp, steps); sum.className = 'sum on'; sumTa.focus(); }; bSumX.onclick = function () { sum.className = 'sum'; };
    bCopy.onclick = function () { try { navigator.clipboard.writeText(sumTa.value); bCopy.textContent = '✓ 已複製'; setTimeout(function () { bCopy.textContent = '📋 複製'; }, 1500); } catch (e) { sumTa.select(); } };
    bPol.style.display = host.polish ? '' : 'none'; bPol.onclick = function () { bPol.disabled = true; var old = bPol.textContent; bPol.textContent = '潤飾中…'; Promise.resolve(host.polish(sumTa.value)).then(function (t) { if (t) { sumTa.value = t; } }, function () { /* keep */ }).then(function () { bPol.disabled = false; bPol.textContent = old; }); };
    bExp.onchange = async function () {
      var v = bExp.value; bExp.value = ''; if (!v) { return; } var p = v.split(':'), kind = p[0], id = p[1]; stat.textContent = '產生中…';
      try {
        var out = await opt.runExport(id, W.validate(cur()).spec); if (!out) { stat.textContent = ''; return; }
        var steps = effectiveSteps(), spec = W.validate(cur()).spec;
        if (kind === 'chat') { await host.toChat(out.blob, out.name, { title: spec.title, prompt: opt.promptOf ? opt.promptOf(spec, steps) : defaultPrompt(spec, steps) }); stat.textContent = '已放進對話'; }
        else { host.download(out.blob, out.name, out.mime); stat.textContent = '已匯出'; }
        if (host.saveCase && host.autoCase !== false && steps.length) { try { host.saveCase(caseInfo(), { auto: true }).catch(function () { /* 自動存不到不影響匯出 */ }); } catch (e2) { /* same */ } }
      } catch (e) { stat.textContent = '匯出失敗：' + String((e && e.message) || e).slice(0, 80); }
      setTimeout(function () { stat.textContent = ''; }, 4000);
    };
    bUndo.onclick = undo; bRedo.onclick = redo;
    function caseInfo() { var sp = W.validate(cur()).spec, steps = effectiveSteps(); return { spec: sp, prompt: opt.promptOf ? opt.promptOf(sp, steps) : defaultPrompt(sp, steps), title: sp.title, requests: steps.filter(function (x) { return x.kind === 'chat' && x.text; }).map(function (x) { return x.text; }) }; }
    bStar.onclick = async function () { if (!host.saveCase) { return; } stat.textContent = '存成案例…'; try { var r = await host.saveCase(caseInfo(), { auto: false }); stat.textContent = r && r.ok ? '⭐ 已存成案例「' + (r.title || r.kept || '') + '」' + (r.updated ? '（更新了舊的）' : '') : '存不了：' + ((r && r.error) || ''); } catch (e) { stat.textContent = '存不了：' + String((e && e.message) || e).slice(0, 60); } };
    el.addEventListener('keydown', function (ev) { var tag = ev.target && ev.target.tagName; if ((tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') && ev.target !== el) { return; } if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); } else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected && tag !== 'TEXTAREA' && tag !== 'INPUT') { ev.preventDefault(); apply([{ op: 'remove_object', id: selected }], '刪掉物件 ' + selected, '', 'panel'); } });
    el.tabIndex = 0;
    function render() {
      renderObjects(); renderHist(); bUndo.disabled = S.ptr === 0; bRedo.disabled = S.ptr >= S.states.length - 1; stat.textContent = '第 ' + (S.ptr + 1) + '／' + S.states.length + ' 步';
      if (selected && W.find(cur(), selected) < 0) { selected = null; renderObjects(); }
      showTabs(); if (editor && editor.refresh) { editor.refresh(cur(), selected); }
    }
    var ctx = { el: el, W: W, host: host, getSpec: function () { return cur(); }, commit: commit, apply: apply, select: select, selected: function () { return selected; }, onSelect: function (f) { selFns.push(f); }, say: function (t) { stat.textContent = t; setTimeout(function () { if (stat.textContent === t) { stat.textContent = ''; } }, 3500); }, undo: undo, redo: redo, bar: bar, setTab: function (id) { midTab = id; showTabs(); }, setProps: function (e) { prop.textContent = ''; if (e) { prop.appendChild(e); } prop.style.display = e ? '' : 'none'; } };
    initState(opt.state, opt.spec); renderLog();
    editor = opt.build(ctx) || {}; opt.tabs.forEach(function (t) { if (editor.tabs && editor.tabs[t.id]) { mp[t.id].appendChild(editor.tabs[t.id]); } }); (editor.bar || []).forEach(function (x) { bar.insertBefore(x, bUndo); });
    if (opt.container) { opt.container.appendChild(el); }
    var WIN = opt.windowApi || (typeof FaWin !== 'undefined' ? FaWin : null), win = WIN && WIN.decorate ? WIN.decorate(el, { id: opt.kind + ':' + (opt.id || ''), title: opt.title, bar: bar, minW: 720, minH: 460 }) : null; el._win = win;
    render();
    el._ed = { editor: editor, getState: getState, reload: function (state) { initState(state, null); renderLog(); render(); }, setSpec: function (spec, summary) { commit(spec, summary || '由對話修改', '', 'chat'); }, undo: undo, redo: redo, send: function (t) { ta.value = t; return send(); }, select: select, getSpec: function () { return cur(); }, env: env, ctx: ctx, effectiveSteps: effectiveSteps, addImages: function (list) { list.forEach(function (x) { if (pending.length < 3) { pending.push(x); } }); renderAtt(); }, snapshot: function () { return opt.runExport ? opt.runExport('png', W.validate(cur()).spec) : Promise.resolve(null); }, destroy: function () { try { if (editor && editor.destroy) { editor.destroy(); } } catch (e) { /* gone */ } } };
    return el;
  }
  return { mount: mount, CSS: CSS };
});
