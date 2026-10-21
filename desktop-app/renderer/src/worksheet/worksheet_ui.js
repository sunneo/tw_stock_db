/* 學習單的互動編輯器（對話裡的 HTML 元件）：預覽（點一下選取一串／一個區塊）、屬性面板、AI 對話（可附圖）、復原／重做、編輯記錄、
 * 「摘要成 prompt」。狀態（每一步的 spec、復原／重做位置、對話紀錄）會存起來，重新開啟或重新整理後接著編輯。
 * 只依賴 FaWorksheet（排版、編輯動作、讀指令）與 host：
 *   host.ask({text, images:[{name,dataUrl}], spec}) -> Promise<{say, edits?:[…], refs?:[ref…], notes?:[…]}>（只在程式讀不懂、或有附圖時才會呼叫）
 *   host.pdf(spec)                -> Promise<Blob>（向量 PDF）
 *   host.download(blob, name, mime)
 *   host.save(state)              （每次變動後呼叫，host 自己決定怎麼存）
 *   host.regenerate(promptText)   -> 用摘要的 prompt 重新做一份（選填）
 *   host.polish(promptText)       -> Promise<string>（選填：請 AI 潤飾摘要）
 *   host.palette()                -> {dark}（選填）
 * mount({ id, state, spec, host, W }) 回傳 DOM 元素；el._ws = { getState(), reload(state), setSpec(spec, summary) }。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./worksheet_core.js')); else root.FaWorksheetUI = factory(root.FaWorksheet || (typeof FaWorksheet !== 'undefined' ? FaWorksheet : undefined));
})(typeof self !== 'undefined' ? self : this, function (WS) {
  'use strict';
  var MAXSTATES = 60;
  var CSS = '.fwk{--bg:#fff;--fg:#1f2328;--bd:#d0d7de;--hd:#f6f8fa;--mut:#59636e;--acc:#0969da;--ok:#1a7f37;--bad:#cf222e;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:13px system-ui,"Microsoft JhengHei",sans-serif;margin:6px 0;overflow:hidden;max-width:100%}.fwk.dark{--bg:#0d1117;--fg:#e6edf3;--bd:#30363d;--hd:#161b22;--mut:#8b949e;--acc:#2f81f7;--ok:#3fb950;--bad:#f85149}'
    + '.fwk *{box-sizing:border-box}.fwk button{background:var(--hd);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}.fwk button:hover:not(:disabled){border-color:var(--acc)}.fwk button:disabled{opacity:.4;cursor:default}.fwk button.pri{background:var(--acc);border-color:var(--acc);color:#fff}'
    + '.fwk input,.fwk select,.fwk textarea{background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:3px 6px;font:inherit;max-width:100%}.fwk textarea{width:100%;resize:vertical}.fwk input[type=color]{padding:0;width:26px;height:22px;border-radius:4px;cursor:pointer}.fwk input[type=number]{width:64px}'
    + '.fwk .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--hd);border-bottom:1px solid var(--bd);flex-wrap:wrap}.fwk .ttl{font-weight:600;margin-right:auto}.fwk .st{color:var(--mut);font-size:12px}'
    + '.fwk .main{display:flex;flex-wrap:wrap;align-items:stretch}.fwk .pv{flex:1 1 340px;min-width:260px;padding:10px;background:#e9ecef;display:flex;justify-content:center;align-items:flex-start;max-height:640px;overflow:auto}.fwk.dark .pv{background:#010409}.fwk .pv svg{width:100%;height:auto;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.35);cursor:pointer;display:block;max-width:520px}'
    + '.fwk .side{flex:1 1 300px;min-width:260px;display:flex;flex-direction:column;border-left:1px solid var(--bd);max-height:640px}.fwk .tabs{display:flex;border-bottom:1px solid var(--bd);background:var(--hd)}.fwk .tabs span{padding:6px 12px;cursor:pointer;color:var(--mut);border-bottom:2px solid transparent}.fwk .tabs span.on{color:var(--fg);border-bottom-color:var(--acc);font-weight:600}.fwk .pane{display:none;flex:1;overflow:auto;padding:8px;min-height:240px}.fwk .pane.on{display:flex;flex-direction:column;gap:6px}'
    + '.fwk .log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:120px}.fwk .msg{padding:5px 8px;border-radius:7px;max-width:92%;white-space:pre-wrap;word-break:break-word}.fwk .msg.u{align-self:flex-end;background:var(--acc);color:#fff}.fwk .msg.a{align-self:flex-start;background:var(--hd);border:1px solid var(--bd)}.fwk .chip{display:inline-block;margin:2px 3px 0 0;padding:0 6px;border-radius:9px;background:rgba(47,129,247,.15);font-size:11px}.fwk .chip.rej{background:rgba(248,81,73,.18)}'
    + '.fwk .sug{display:flex;gap:4px;flex-wrap:wrap}.fwk .sug button{font-size:12px;padding:1px 7px;border-radius:11px}.fwk .att{display:flex;gap:4px;flex-wrap:wrap}.fwk .att span{position:relative;display:inline-block}.fwk .att img{height:44px;border:1px solid var(--bd);border-radius:4px}.fwk .att b{position:absolute;top:-5px;right:-5px;background:var(--bad);color:#fff;border-radius:50%;width:15px;height:15px;font-size:10px;line-height:15px;text-align:center;cursor:pointer}'
    + '.fwk .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.fwk .row label{color:var(--mut)}.fwk .blk{border:1px solid var(--bd);border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:5px}.fwk .blk.sel{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}.fwk .blk h4{margin:0;font-size:12px;display:flex;gap:4px;align-items:center}.fwk .blk h4 span{margin-right:auto;cursor:pointer}'
    + '.fwk .chips{display:flex;gap:4px;flex-wrap:wrap}.fwk .cc{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--bd);border-radius:5px;padding:1px 3px}.fwk .cc.sel{border-color:var(--acc);background:rgba(47,129,247,.12)}.fwk .cc i{cursor:pointer;color:var(--bad);font-style:normal;padding:0 2px}'
    + '.fwk .hist div{padding:3px 6px;border-radius:5px;cursor:pointer;border:1px solid transparent}.fwk .hist div:hover{border-color:var(--bd)}.fwk .hist div.cur{background:rgba(47,129,247,.14);font-weight:600}.fwk .hist div.fut{opacity:.45}.fwk .sum{padding:8px;border-bottom:1px solid var(--bd);background:var(--hd);display:none;flex-direction:column;gap:6px}.fwk .sum.on{display:flex}'
    + '.fwk.full{position:fixed;inset:8px;z-index:100000;margin:0;display:flex;flex-direction:column;max-width:none;box-shadow:0 8px 40px rgba(0,0,0,.5)}.fwk.full .main{flex:1;min-height:0}.fwk.full .pv,.fwk.full .side{max-height:none}.fwk.full .pv svg{max-width:760px}';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var TYPE_NAME = { bead_rows: '串珠', number_bond: '數的組成', count_rows: '數一數', equations: '算式', ten_frames: '十格框', number_line: '數線', text: '文字', spacer: '空白' };
  var SUGGEST = ['附上答案', '改成橫式', '做成5串', '珠子大一點', '把第3串改成粉紅色'];

  function mount(opt) {
    var W = opt.W || WS, host = opt.host || {}, el = h('div', 'fwk'); var dark = false; try { dark = !!(host.palette && host.palette().dark); } catch (e) { dark = false; } if (dark) el.className += ' dark';
    if (!document.getElementById('fwk-css')) { var st = document.createElement('style'); st.id = 'fwk-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
    // ───── 狀態：每一步的 spec（可復原／重做）＋對話紀錄；重新開啟時從 state 接著來 ─────
    var S = { v: 1, ptr: 0, states: [], log: [] }, sel = null, tab = 'ai', pending = [], busy = false, saveT = null;
    function initState(state, spec) {
      if (state && Array.isArray(state.states) && state.states.length) { S = { v: 1, ptr: Math.max(0, Math.min(state.states.length - 1, state.ptr | 0)), states: state.states.slice(-MAXSTATES).map(function (x) { return { spec: W.validate(x.spec).spec, summary: x.summary || '', text: x.text || '', kind: x.kind || 'panel', t: x.t || 0 }; }), log: Array.isArray(state.log) ? state.log.slice(-80) : [] }; if (S.ptr >= S.states.length) S.ptr = S.states.length - 1; }
      else S = { v: 1, ptr: 0, states: [{ spec: W.validate(spec || {}).spec, summary: '開始', text: '', kind: 'start', t: Date.now() }], log: [] };
    }
    function cur() { return S.states[S.ptr].spec; }
    function persist() { clearTimeout(saveT); saveT = setTimeout(function () { try { if (host.save) host.save(getState()); } catch (e) { /* 存不了這次還是有效 */ } }, 350); }
    function getState() { return { v: 1, ptr: S.ptr, states: S.states, log: S.log.slice(-80) }; }
    function commit(spec, summary, text, kind) { S.states = S.states.slice(0, S.ptr + 1); S.states.push({ spec: W.validate(spec).spec, summary: summary || '', text: text || '', kind: kind || 'panel', t: Date.now() }); if (S.states.length > MAXSTATES) S.states.shift(); S.ptr = S.states.length - 1; render(); persist(); }
    function apply(edits, summary, text, kind) {
      var r = W.applyEdits(cur(), edits); if (!r.applied.length) return r;
      var words = summary || edits.filter(function (e, i) { return r.applied.indexOf(e.op) >= 0; }).map(W.editWords).filter(Boolean).join('；');
      commit(r.spec, words, text, kind); return r;
    }
    function undo() { if (S.ptr > 0) { S.ptr--; sel = null; render(); persist(); } }
    function redo() { if (S.ptr < S.states.length - 1) { S.ptr++; sel = null; render(); persist(); } }

    // ───── 版面骨架 ─────
    var bar = h('div', 'bar'), ttl = h('span', 'ttl', '📐 學習單編輯器'), bUndo = h('button', null, '↶ 復原'), bRedo = h('button', null, '↷ 重做'), bSum = h('button', null, '📝 摘要成 prompt'), bExp = h('select'), bFull = h('button', null, '⛶'), stat = h('span', 'st');
    bUndo.title = 'Ctrl+Z'; bRedo.title = 'Ctrl+Y'; bFull.title = '放大／還原';
    [['', '⬇ 匯出…'], ['pdf', 'PDF（向量）'], ['png', 'PNG 預覽圖'], ['html', 'HTML（可列印）'], ['json', '描述（JSON）']].forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; bExp.appendChild(op); });
    [ttl, stat, bUndo, bRedo, bSum, bExp, bFull].forEach(function (x) { bar.appendChild(x); });
    var sum = h('div', 'sum'), sumTa = h('textarea'); sumTa.rows = 8; var sumRow = h('div', 'row'), bCopy = h('button', null, '📋 複製'), bRegen = h('button', 'pri', '↻ 用這段重新生成'), bPol = h('button', null, '✨ 請 AI 潤飾'), bSumX = h('button', null, '✕'); [bCopy, bRegen, bPol, bSumX].forEach(function (x) { sumRow.appendChild(x); }); sumRow.insertBefore(h('span', 'st', '把目前的樣子與編輯過程整理成一段可以重用的描述'), bCopy); sum.appendChild(sumTa); sum.appendChild(sumRow);
    var main = h('div', 'main'), pv = h('div', 'pv'), side = h('div', 'side'), tabs = h('div', 'tabs');
    var panes = { ai: h('div', 'pane'), props: h('div', 'pane'), hist: h('div', 'pane hist') };
    [['ai', '🤖 AI 助手'], ['props', '⚙ 屬性'], ['hist', '🕘 記錄']].forEach(function (t) { var s = h('span', null, t[1]); s.setAttribute('data-t', t[0]); s.onclick = function () { tab = t[0]; showTab(); }; tabs.appendChild(s); });
    side.appendChild(tabs); ['ai', 'props', 'hist'].forEach(function (k) { side.appendChild(panes[k]); }); main.appendChild(pv); main.appendChild(side);
    el.appendChild(bar); el.appendChild(sum); el.appendChild(main);
    function showTab() { Array.prototype.forEach.call(tabs.children, function (s) { s.className = s.getAttribute('data-t') === tab ? 'on' : ''; }); Object.keys(panes).forEach(function (k) { panes[k].className = 'pane' + (k === 'hist' ? ' hist' : '') + (k === tab ? ' on' : ''); }); }

    // ───── 預覽：點一下選取 ─────
    var L = null;
    function renderPreview() {
      L = W.layout(cur()); pv.innerHTML = W.toSvg(L, { selected: sel }); var svg = pv.firstChild;
      if (svg && svg.addEventListener) svg.addEventListener('click', function (ev) { var r = svg.getBoundingClientRect(); var mx = (ev.clientX - r.left) / r.width * L.w, my = (ev.clientY - r.top) / r.height * L.h; var hit = W.hitTest(L, mx, my); sel = hit; tab = 'props'; render(); });
    }
    // ───── 屬性面板 ─────
    function numInput(v, min, max, onch) { var i = h('input'); i.type = 'number'; i.value = v; if (min != null) i.min = min; if (max != null) i.max = max; i.onchange = function () { onch(Number(i.value)); }; return i; }
    function colorInput(v, onch) { var i = h('input'); i.type = 'color'; i.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#999999'; i.onchange = function () { onch(i.value.toUpperCase()); }; return i; }
    function selectInput(v, opts, onch) { var s = h('select'); opts.forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; if (String(o[0]) === String(v)) op.selected = true; s.appendChild(op); }); s.onchange = function () { onch(s.value); }; return s; }
    function field(label, node) { var r = h('div', 'row'); r.appendChild(h('label', null, label)); r.appendChild(node); return r; }
    function answerEditor(b, bi) {
      var a = b.answer || {}, r = h('div', 'row'); r.appendChild(selectInput(a.side || 'right', [['right', '答案線在右側'], ['below', '答案線在下方'], ['none', '沒有答案線']], function (v) { apply([{ op: 'set_block', index: bi, patch: { answer: Object.assign({}, a, { side: v }) } }]); }));
      var cb = h('input'); cb.type = 'checkbox'; cb.checked = a.show === true; cb.onchange = function () { apply([{ op: 'set_block', index: bi, patch: { answer: Object.assign({}, a, { show: cb.checked }) } }]); }; var lb = h('label'); lb.appendChild(cb); lb.appendChild(document.createTextNode(' 寫出答案（教師版）')); r.appendChild(lb); return r;
    }
    function countsEditor(b, bi) {
      var box = h('div', 'chips'), colors = b.colors || {};
      b.counts.forEach(function (c, i) {
        var cc = h('span', 'cc' + (sel && sel.kind === 'row' && sel.b === bi && sel.r === i ? ' sel' : '')); cc.appendChild(h('span', null, c + (b.type === 'bead_rows' ? '顆' : '')));
        if (b.type === 'bead_rows') cc.appendChild(colorInput(colors[c] || (W.BEAD_COLORS[c] || '#999999'), function (v) { apply([{ op: 'set_color', count: c, color: v }]); }));
        var x = h('i', null, '✕'); x.title = '刪掉這一串'; x.onclick = function () { if (b.counts.length > 1) apply([{ op: 'set_block', index: bi, patch: { counts: b.counts.filter(function (_, k) { return k !== i; }) } }]); }; cc.appendChild(x); box.appendChild(cc);
      });
      var add = h('button', null, '＋ 一串'); add.onclick = function () { var next = (Math.max.apply(null, b.counts) || 0) + 1; apply([{ op: 'set_block', index: bi, patch: { counts: b.counts.concat([next]) } }]); }; box.appendChild(add); return box;
    }
    function blockEditor(b, bi) {
      var w = h('div', 'blk' + (sel && sel.b === bi && sel.kind !== 'title' && sel.kind !== 'header' ? ' sel' : ''));
      var hd = h('h4'), nm = h('span', null, (bi + 1) + '. ' + (TYPE_NAME[b.type] || b.type)); nm.onclick = function () { sel = { kind: 'block', b: bi }; render(); }; hd.appendChild(nm);
      var up = h('button', null, '▲'), dn = h('button', null, '▼'), rm = h('button', null, '✕'); up.disabled = bi === 0; dn.disabled = bi === cur().blocks.length - 1; up.onclick = function () { apply([{ op: 'move_block', index: bi, to: bi - 1 }]); }; dn.onclick = function () { apply([{ op: 'move_block', index: bi, to: bi + 1 }]); }; rm.onclick = function () { apply([{ op: 'remove_block', index: bi }]); }; [up, dn, rm].forEach(function (x) { hd.appendChild(x); }); w.appendChild(hd);
      var patch = function (p) { return function (v) { var o = {}; o[p] = v; apply([{ op: 'set_block', index: bi, patch: o }]); }; };
      if (b.type === 'bead_rows') { w.appendChild(field('每串金珠', numInput(b.base, 2, 20, patch('base')))); w.appendChild(field('金珠顏色', colorInput(b.baseColor, function (v) { apply([{ op: 'set_base_color', color: v }]); }))); w.appendChild(h('div', 'st', '每一串彩色珠的顆數與顏色（點色塊改顏色）：')); w.appendChild(countsEditor(b, bi)); w.appendChild(field('珠子大小', (function () { var r = h('input'); r.type = 'range'; r.min = 0.4; r.max = 1.4; r.step = 0.05; r.value = b.size; r.onchange = function () { patch('size')(Number(r.value)); }; return r; })())); w.appendChild(answerEditor(b, bi)); }
      else if (b.type === 'count_rows') { w.appendChild(countsEditor(b, bi)); w.appendChild(field('形狀', selectInput(b.shape, [['circle', '圓'], ['square', '方塊'], ['star', '星星']], patch('shape')))); w.appendChild(field('顏色', colorInput(b.color, patch('color')))); w.appendChild(answerEditor(b, bi)); }
      else if (b.type === 'number_bond') {
        w.appendChild(field('每格積木數', numInput(b.total, 2, 12, patch('total'))));
        var ct = h('input'); ct.value = b.cells.map(function (c) { return c.a == null ? '_' : c.a + '+' + (c.b == null ? '_' : c.b); }).join(', '); ct.placeholder = '每格的拆法，例如 1+4, 2+3, 3+2（空白格寫 _）'; ct.style.width = '100%';
        ct.onchange = function () { var cs = ct.value.split(/[,，;；\s]+/).filter(Boolean).slice(0, 12).map(function (x) { var m = /^(\d+)\s*\+\s*(\d+)$/.exec(x); return m ? { a: Number(m[1]), b: Number(m[2]) } : { a: null, b: null }; }); if (cs.length) patch('cells')(cs); };
        w.appendChild(h('div', 'st', '每一格的拆法（用逗號分開，空白格寫 _）：')); w.appendChild(ct); w.appendChild(field('欄數', numInput(b.cols, 1, 3, patch('cols'))));
        var chk = function (label, key) { var c = h('input'); c.type = 'checkbox'; c.checked = b[key] === true; c.onchange = function () { patch(key)(c.checked); }; var lb = h('label'); lb.appendChild(c); lb.appendChild(document.createTextNode(' ' + label)); return lb; };
        var r1 = h('div', 'row'); r1.appendChild(chk('兒子圈裡寫出數字', 'showNumbers')); r1.appendChild(chk('教師版（積木上色、樹根寫總數）', 'fill')); w.appendChild(r1);
        w.appendChild(field('樹根圈顏色', colorInput(b.rootColor, patch('rootColor')))); w.appendChild(field('兒子圈顏色', colorInput(b.childColor, patch('childColor'))));
        w.appendChild(field('積木上色', (function () { var r = h('span'); r.appendChild(colorInput(b.cubeColors[0], function (v) { patch('cubeColors')([v, b.cubeColors[1]]); })); r.appendChild(colorInput(b.cubeColors[1], function (v) { patch('cubeColors')([b.cubeColors[0], v]); })); return r; })()));
      }
      else if (b.type === 'ten_frames') { w.appendChild(h('div', 'st', '每個十格框的點數：')); w.appendChild(countsEditor(b, bi)); w.appendChild(field('顏色', colorInput(b.color, patch('color')))); w.appendChild(field('每列', numInput(b.columns, 1, 3, patch('columns')))); w.appendChild(answerEditor(b, bi)); }
      else if (b.type === 'equations') { w.appendChild(field('種類', selectInput(b.items.join('').indexOf('−') >= 0 ? 'sub' : 'add', [['add', '加法'], ['sub', '減法']], function (v) { apply([{ op: 'set_block', index: bi, patch: { items: W.makeEquations(v, 10 * Math.max(1, Math.round(b.items.length / 5)), b.items.length || 10, Date.now() % 1000) } }]); }))); w.appendChild(field('欄數', numInput(b.columns, 1, 4, patch('columns')))); var re = h('button', null, '🎲 重新出題'); re.onclick = function () { var sub = b.items.join('').indexOf('−') >= 0; apply([{ op: 'set_block', index: bi, patch: { items: W.makeEquations(sub ? 'sub' : 'add', 20, b.items.length || 10, Date.now() % 100000) } }]); }; w.appendChild(re); var ta = h('textarea'); ta.rows = Math.min(8, b.items.length + 1); ta.value = b.items.join('\n'); ta.onchange = function () { patch('items')(ta.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean)); }; w.appendChild(ta); }
      else if (b.type === 'number_line') { w.appendChild(field('從', numInput(b.from, -50, 50, patch('from')))); w.appendChild(field('到', numInput(b.to, -50, 90, patch('to')))); var bl = h('input'); bl.value = b.blanks.join(','); bl.placeholder = '空格的數字，用逗號分開'; bl.onchange = function () { patch('blanks')(bl.value.split(/[,，\s]+/).filter(Boolean).map(Number)); }; w.appendChild(field('空格', bl)); }
      else if (b.type === 'text') { var t2 = h('textarea'); t2.rows = 3; t2.value = b.lines.join('\n'); t2.onchange = function () { patch('lines')(t2.value.split('\n')); }; w.appendChild(t2); w.appendChild(field('置中', (function () { var c = h('input'); c.type = 'checkbox'; c.checked = b.align === 'center'; c.onchange = function () { patch('align')(c.checked ? 'center' : 'left'); }; return c; })())); }
      else if (b.type === 'spacer') w.appendChild(field('高度(mm)', numInput(b.mm, 1, 80, patch('mm'))));
      return w;
    }
    function renderProps() {
      var p = panes.props; p.textContent = ''; var sp = cur();
      var t = h('input'); t.value = sp.title; t.placeholder = '標題'; t.onchange = function () { apply([{ op: 'set_title', text: t.value }]); }; p.appendChild(field('標題', t));
      var st2 = h('input'); st2.value = sp.subtitle; st2.placeholder = '說明文字'; st2.onchange = function () { apply([{ op: 'set_subtitle', text: st2.value }]); }; p.appendChild(field('說明', st2));
      var pr = h('div', 'row'); pr.appendChild(selectInput(sp.page.size, [['A4', 'A4'], ['A5', 'A5'], ['Letter', 'Letter']], function (v) { apply([{ op: 'set_page', size: v }]); })); pr.appendChild(selectInput(sp.page.orient, [['portrait', '直式'], ['landscape', '橫式']], function (v) { apply([{ op: 'set_page', orient: v }]); }));
      [['name', '姓名'], ['date', '日期'], ['score', '分數']].forEach(function (f) { var c = h('input'); c.type = 'checkbox'; c.checked = !!sp.header[f[0]]; c.onchange = function () { var o = { op: 'set_header' }; o[f[0]] = c.checked; apply([o]); }; var lb = h('label'); lb.appendChild(c); lb.appendChild(document.createTextNode(' ' + f[1])); pr.appendChild(lb); }); p.appendChild(pr);
      sp.blocks.forEach(function (b, i) { p.appendChild(blockEditor(b, i)); });
      var addr = h('div', 'row'), sa = selectInput('bead_rows', Object.keys(TYPE_NAME).map(function (k) { return [k, TYPE_NAME[k]]; }), function () { }), ab = h('button', null, '＋ 新增區塊');
      ab.onclick = function () { var ty = sa.value; var d = { bead_rows: { type: 'bead_rows' }, number_bond: { type: 'number_bond' }, count_rows: { type: 'count_rows' }, equations: { type: 'equations' }, ten_frames: { type: 'ten_frames' }, number_line: { type: 'number_line' }, text: { type: 'text', lines: ['在這裡寫說明'] }, spacer: { type: 'spacer' } }[ty]; apply([{ op: 'add_block', block: d }]); };
      addr.appendChild(sa); addr.appendChild(ab); p.appendChild(addr);
    }
    // ───── 記錄 ─────
    function renderHist() {
      var p = panes.hist; p.textContent = ''; p.appendChild(h('div', 'st', '點一步就回到那一步（之後的步驟還在，可以重做）：'));
      S.states.forEach(function (s, i) { var d = h('div', i === S.ptr ? 'cur' : (i > S.ptr ? 'fut' : ''), (i + 1) + '. ' + (s.summary || '（沒有說明）') + (s.text ? '　— 「' + s.text.slice(0, 30) + '」' : '')); d.onclick = function () { S.ptr = i; sel = null; render(); persist(); }; p.appendChild(d); });
    }
    // ───── AI 對話（可附圖）─────
    var logEl = h('div', 'log'), sugEl = h('div', 'sug'), attEl = h('div', 'att'), inRow = h('div', 'row'), ta = h('textarea'), bAtt = h('button', null, '📎'), bSend = h('button', 'pri', '送出'), file = h('input'); file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.style.display = 'none';
    ta.rows = 2; ta.placeholder = '說說想怎麼改，例如「把第3串改成粉紅色」「附上答案」；也可以附一張圖片叫我照它的顏色與串數'; bAtt.title = '附圖（也可以直接貼上、拖進來）'; inRow.appendChild(bAtt); inRow.appendChild(bSend);
    SUGGEST.forEach(function (q) { var b = h('button', null, q); b.onclick = function () { ta.value = q; send(); }; sugEl.appendChild(b); });
    panes.ai.appendChild(logEl); panes.ai.appendChild(sugEl); panes.ai.appendChild(attEl); panes.ai.appendChild(ta); panes.ai.appendChild(inRow); panes.ai.appendChild(file);
    function addMsg(role, text, chips, rejected) {
      var m = h('div', 'msg ' + (role === 'user' ? 'u' : 'a')); m.appendChild(document.createTextNode(text || '')); (chips || []).forEach(function (c) { m.appendChild(h('span', 'chip', c)); }); (rejected || []).forEach(function (c) { m.appendChild(h('span', 'chip rej', c)); }); logEl.appendChild(m); logEl.scrollTop = logEl.scrollHeight; return m;
    }
    function renderLog() { logEl.textContent = ''; if (!S.log.length) addMsg('ai', '我在這裡幫你改這份學習單。直接說就好（改顏色、串數、答案、紙張、標題…），改錯了可以按「復原」。附一張圖片，我會照它的串數與顏色調整。'); S.log.forEach(function (m) { addMsg(m.role, m.text, m.chips, m.rejected); }); }
    function readFile(f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res({ name: f.name || 'image', dataUrl: String(r.result) }); }; r.onerror = function () { res(null); }; r.readAsDataURL(f); }); }
    function addFiles(files) { Promise.all(Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); }).slice(0, 4).map(readFile)).then(function (list) { list.filter(Boolean).forEach(function (x) { if (pending.length < 4) pending.push(x); }); renderAtt(); }); }
    function renderAtt() { attEl.textContent = ''; pending.forEach(function (x, i) { var s = h('span'), im = h('img'); im.src = x.dataUrl; im.alt = x.name; var rm = h('b', null, '×'); rm.onclick = function () { pending.splice(i, 1); renderAtt(); }; s.appendChild(im); s.appendChild(rm); attEl.appendChild(s); }); }
    bAtt.onclick = function () { file.click(); }; file.onchange = function () { addFiles(file.files); file.value = ''; };
    ta.addEventListener('paste', function (ev) { var items = ev.clipboardData && ev.clipboardData.files; if (items && items.length) { addFiles(items); ev.preventDefault(); } });
    ['dragover', 'drop'].forEach(function (n) { panes.ai.addEventListener(n, function (ev) { ev.preventDefault(); if (n === 'drop' && ev.dataTransfer) addFiles(ev.dataTransfer.files); }); });
    ta.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); } });
    async function send() {
      var text = ta.value.trim(), imgs = pending.slice(); if (busy || (!text && !imgs.length)) return; busy = true; bSend.disabled = true; ta.value = ''; pending = []; renderAtt(); tab = 'ai'; showTab();
      var um = { role: 'user', text: (text || '（附圖）') + (imgs.length ? '　📎×' + imgs.length : '') }; S.log.push(um); addMsg('user', um.text);
      var think = addMsg('ai', '…'); var chips = [], rej = [], say = '', spec0 = cur(), applied = 0, edits = [], refs = [];
      try {
        // 1) 程式先讀（不呼叫模型）：每一小句各自判斷
        var pr = text ? W.parseEditRequest(text, spec0) : { edits: [], matched: [], unmatched: [] }; edits = pr.edits.slice(); var rest = pr.unmatched.join('，');
        // 2) 讀不懂的句子、或有附圖：才問 host（模型／視覺模型）；host 只能回封閉的結果（edits 或 refs），再由 applyEdits／mergeRef 驗證
        if ((rest || imgs.length) && host.ask) {
          var ans = await host.ask({ text: rest, images: imgs, spec: spec0 }); say = (ans && ans.say) || ''; if (ans && ans.edits) edits = edits.concat(ans.edits); refs = (ans && ans.refs) || []; if (ans && ans.notes) ans.notes.forEach(function (n) { chips.push(n); });
        } else if (rest) say = '我沒聽懂：「' + rest.slice(0, 40) + '」。可以改說得明確一點（例如「把第3串改成粉紅色」），或用右邊的屬性面板直接改。';
        // 3) 套用：附圖的參考資料先併進來，再套編輯動作；一次說的話算一步（復原一次就全部回去）
        var next = spec0, words = [];
        refs.forEach(function (rf) { var m = W.mergeRef(next, rf); next = m.spec; m.notes.forEach(function (n) { words.push(n); }); });
        var r = W.applyEdits(next, edits); if (r.applied.length) { next = r.spec; edits.forEach(function (e) { if (r.applied.indexOf(e.op) >= 0) words.push(W.editWords(e)); }); }
        (r.rejected || []).forEach(function (x) { rej.push('✗ ' + x.op + '：' + x.error); });
        if (JSON.stringify(next) !== JSON.stringify(spec0)) { commit(next, words.filter(Boolean).join('；'), text || '（附圖）', imgs.length ? 'image' : 'chat'); applied = words.length; words.filter(Boolean).forEach(function (w) { chips.push('✓ ' + w); }); }
        if (!say) say = applied ? '改好了：' : (rej.length ? '有幾個動作沒辦法做：' : (pr.unmatched.length ? '' : '這樣已經是目前的樣子了。'));
      } catch (e) { say = '這次沒成功：' + String((e && e.message) || e).slice(0, 160); }
      think.remove(); var am = { role: 'ai', text: say, chips: chips.slice(0, 12), rejected: rej.slice(0, 6) }; S.log.push(am); addMsg('ai', am.text, am.chips, am.rejected); persist(); busy = false; bSend.disabled = false;
    }
    bSend.onclick = send;
    // ───── 摘要成 prompt ─────
    bSum.onclick = function () { sumTa.value = W.specToPrompt(cur(), S.states.slice(0, S.ptr + 1).filter(function (s) { return s.kind !== 'start'; })); sum.className = 'sum on'; sumTa.focus(); };
    bSumX.onclick = function () { sum.className = 'sum'; };
    bCopy.onclick = function () { try { navigator.clipboard.writeText(sumTa.value); bCopy.textContent = '✓ 已複製'; setTimeout(function () { bCopy.textContent = '📋 複製'; }, 1500); } catch (e) { sumTa.select(); document.execCommand && document.execCommand('copy'); } };
    bRegen.style.display = host.regenerate ? '' : 'none'; bRegen.onclick = function () { if (host.regenerate) { bRegen.disabled = true; Promise.resolve(host.regenerate(sumTa.value)).then(function () { bRegen.disabled = false; sum.className = 'sum'; }, function () { bRegen.disabled = false; }); } };
    bPol.style.display = host.polish ? '' : 'none'; bPol.onclick = function () { bPol.disabled = true; var old = bPol.textContent; bPol.textContent = '潤飾中…'; Promise.resolve(host.polish(sumTa.value)).then(function (t) { if (t) sumTa.value = t; }, function () { /* 用原本的 */ }).then(function () { bPol.disabled = false; bPol.textContent = old; }); };
    // ───── 匯出、放大、鍵盤 ─────
    function safeName() { return String(cur().title || '學習單').replace(/[\\/:*?"<>|｜]/g, '_').replace(/\s+/g, '').slice(0, 40) || 'worksheet'; }
    bExp.onchange = async function () {
      var k = bExp.value; bExp.value = ''; if (!k || !host.download) return; stat.textContent = '匯出中…';
      try { var sp = cur(), Lx = W.layout(sp);
        if (k === 'pdf') { if (!host.pdf) throw new Error('這個環境不能輸出 PDF'); await host.download(await host.pdf(sp), safeName() + '.pdf', 'application/pdf'); }
        else if (k === 'png') { var cv = document.createElement('canvas'); cv.width = Math.round(Lx.w * 6); cv.height = Math.round(Lx.h * 6); W.drawCanvas(cv.getContext('2d'), Lx, 6); await host.download(await new Promise(function (r) { cv.toBlob(r, 'image/png'); }), safeName() + '.png', 'image/png'); }
        else if (k === 'html') await host.download(new Blob([W.toHtml(Lx)], { type: 'text/html' }), safeName() + '.html', 'text/html');
        else await host.download(new Blob([JSON.stringify(sp, null, 1)], { type: 'application/json' }), safeName() + '.json', 'application/json');
        stat.textContent = '已匯出';
      } catch (e) { stat.textContent = '匯出失敗：' + String((e && e.message) || e).slice(0, 80); }
      setTimeout(function () { stat.textContent = ''; }, 3000);
    };
    bFull.onclick = function () { var on = el.className.indexOf(' full') >= 0; el.className = el.className.replace(' full', '') + (on ? '' : ' full'); bFull.textContent = on ? '⛶' : '🗗'; };
    bUndo.onclick = undo; bRedo.onclick = redo;
    el.addEventListener('keydown', function (ev) { if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) && ev.target !== el) { if (!(ev.ctrlKey || ev.metaKey)) return; if (ev.target.tagName === 'TEXTAREA' || ev.target.type === 'text') return; } if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); } else if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); } else if (ev.key === 'Escape' && el.className.indexOf(' full') >= 0) bFull.onclick(); });
    el.tabIndex = 0;
    function render() { renderPreview(); renderProps(); renderHist(); bUndo.disabled = S.ptr === 0; bRedo.disabled = S.ptr >= S.states.length - 1; stat.textContent = '第 ' + (S.ptr + 1) + '／' + S.states.length + ' 步'; showTab(); }
    initState(opt.state, opt.spec); renderLog(); render();
    el._ws = { getState: getState, reload: function (state) { initState(state, null); sel = null; renderLog(); render(); }, setSpec: function (spec, summary) { commit(spec, summary || '由對話修改', '', 'chat'); }, undo: undo, redo: redo, send: function (t) { ta.value = t; return send(); }, select: function (s) { sel = s; render(); } };
    return el;
  }
  return { mount: mount, CSS: CSS };
});
