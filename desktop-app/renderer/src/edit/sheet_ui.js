// /edit-csv 與 /edit-xlsx 的畫面，蓋在共用外框（edit_shell.js）上：中間是「表格」（虛擬捲動：只畫看得到的列，兩萬列也順；單擊選格、雙擊或直接打字改、Enter／Tab 移動、Delete 清空、可貼上試算表的區塊）、
// CSV 另有「原始碼」分頁；左邊的物件欄是工作表清單，屬性面板改選到的格／列／欄（排序、插入、刪除、欄寬）與工作表（標題列、凍結、檔案設定）。
//   FaEditSheetUI.mount({ id, state, spec, host, container, restoring, store, windowApi }) -> element (el._ed)
//   host：jszip()? → Promise<JSZip>（讀寫 xlsx）、origXlsx()? → Promise<Uint8Array|null>（沒改過的 xlsx 匯出原檔）
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditSheetUI = factory((root.FaEditSheet || (typeof FaEditSheet !== 'undefined' ? FaEditSheet : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined)), (root.FaSheetFormula || (typeof FaSheetFormula !== 'undefined' ? FaSheetFormula : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, Shell, FX) {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var RH = 24, HEADH = 24, RNW = 46, CSS = '.few .sgrid{flex:1;min-height:0;overflow:auto;max-height:62vh;position:relative;outline:none}.few.fwin-pop .sgrid,.few.fwin-max .sgrid{max-height:none}'
    + '.few .sgrid table{border-collapse:separate;border-spacing:0;table-layout:fixed;font:12px system-ui,"Microsoft JhengHei",sans-serif}.few .sgrid td,.few .sgrid th{height:' + RH + 'px;box-sizing:border-box;border-right:1px solid var(--bd);border-bottom:1px solid var(--bd);padding:0 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--bg)}'
    + '.few .sgrid th{position:sticky;top:0;z-index:2;background:var(--hd);font-weight:600;text-align:center;cursor:pointer;color:var(--mut)}.few .sgrid th.rn{left:0;z-index:3}.few .sgrid td.rn{position:sticky;left:0;z-index:1;background:var(--hd);color:var(--mut);text-align:center;cursor:pointer}'
    + '.few .sgrid td.hd{font-weight:700;background:var(--hd)}.few .sgrid td.num{text-align:right}.few .sgrid td.fx{color:#0969da}.few .sgrid td.err{color:#cf222e}.few .sgrid td.sel{outline:2px solid var(--acc);outline-offset:-2px;background:rgba(47,129,247,.12)}.few .sgrid td.rsel,.few .sgrid th.csel{background:rgba(47,129,247,.14)}'
    + '.few .sgrid td input{width:100%;height:100%;box-sizing:border-box;border:0;outline:2px solid var(--acc);padding:0 4px;font:inherit;background:var(--bg);color:inherit}.few .sbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:4px 8px;border-bottom:1px solid var(--bd);background:var(--hd)}.few .sbar input.fx{flex:1;min-width:8em}.few .sbar .ad{font-weight:700;min-width:3.2em}';
  function slug(s) { return String(s || 'table').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'table'; }
  function decode(buf) { var u = new Uint8Array(buf); try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(u); } catch (e) { try { return new TextDecoder('big5').decode(u); } catch (e2) { return new TextDecoder('utf-8').decode(u); } } }
  function colPx(c) { return c && c.w ? Math.max(40, Math.round(c.w * 7 + 12)) : 110; }

  function mount(opt) {
    var host = opt.host || {}, spec0 = C.validate(opt.spec || {}).spec, fmt = spec0.format === 'xlsx' ? 'xlsx' : 'csv', kind = fmt === 'xlsx' ? 'edit-xlsx' : 'edit-csv', curSheetId = null;
    var W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    if (!document.getElementById('few-sheet-css')) { var st = document.createElement('style'); st.id = 'few-sheet-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
    return Shell.mount({
      id: opt.id, kind: kind, title: fmt === 'xlsx' ? '📊 試算表編輯器' : '🧾 CSV 編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: fmt === 'csv' ? [{ id: 'grid', label: '▦ 表格' }, { id: 'source', label: '🧩 原始碼' }] : [{ id: 'grid', label: '▦ 表格' }],
      placeholder: '用說的改：「把 qty 由大到小排序」「刪掉空白列」「B2 改成 99」「在最後加一欄「總價」」「刪掉 name 是 banana 的列」「把價格都加 10%」',
      intro: (fmt === 'xlsx' ? '我是試算表編輯器：工作表在左邊的清單，公式（SUM、AVERAGE、IF、VLOOKUP…）會算，修改前後的公式與算好的值都保留。' : '我是 CSV 編輯器：你的檔案沒動到的地方一個位元組都不會變（分隔符號、換行、引號習慣、BOM 都保留）。')
        + '單擊選格、雙擊或直接打字改、Enter／Tab 移動，也可以貼上試算表的區塊。用說的也行：排序、刪空白列／重複列、加欄加列、取代、條件式刪列；讀不懂的才請 AI，AI 只看欄位概要，不會把整份資料送出去。每一步都能復原。',
      objectIcon: function () { return '▦'; },
      objectInfo: function (o) { return o.rows.length + '×' + o.cols.length + (C.isF && o.rows.some(function (r) { return Object.keys(r.c).some(function (k) { return C.isF(r.c[k]); }); }) ? ' ƒ' : ''); },
      parseCommands: C.parseCommands,
      file: { exportId: fmt === 'xlsx' ? 'xlsx' : 'csv', types: fmt === 'xlsx' ? [{ description: 'Excel 活頁簿', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] : [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv', '.txt'] } }],
        importBytes: async function (bytes, name) { var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), title = String(name || '').replace(/\.[^.]+$/, '').slice(0, 60) || spec0.title, ns; if (fmt === 'xlsx') { var Z = host.jszip ? await host.jszip() : null; if (!Z) { throw new Error('這裡還讀不了 xlsx（JSZip 沒有載入）'); } ns = await C.readXlsx(u, Z, title); if (host.keepOrig) { try { host.keepOrig(u); } catch (e) { /* 匯出時重新產生 */ } } } else { ns = C.parseCsv(decode(u), title); } if (ns.format !== fmt) { throw new Error('這個檔案不是' + (fmt === 'xlsx' ? '試算表' : 'CSV')); } return ns; } },
      promptOf: function (sp, steps) { var sh = sp.objects[0], L = ['請做一份' + (fmt === 'xlsx' ? '試算表' : ' CSV 表格') + '「' + sp.title + '」，共 ' + sp.objects.length + ' 張工作表；第一張 ' + sh.rows.length + ' 列 × ' + sh.cols.length + ' 欄。']; var p = C.profile(sh, 3); L.push('', '欄位：'); p.cols.forEach(function (c) { L.push('- ' + c.letter + (c.name ? '「' + c.name + '」' : '') + '（' + c.type + '）'); }); var texts = steps.filter(function (s) { return s.text; }); if (texts.length) { L.push('', '修改過程：'); texts.forEach(function (s, i) { L.push((i + 1) + '. ' + s.text); }); } return L.join('\n'); },
      exports: fmt === 'xlsx' ? [{ id: 'xlsx', label: 'Excel 檔 (.xlsx)', chat: false }, { id: 'csv', label: '目前工作表（CSV）', chat: false }, { id: 'json', label: '專案（JSON）', chat: false }] : [{ id: 'csv', label: 'CSV 檔 (.csv)' }, { id: 'xlsx', label: 'Excel 檔 (.xlsx)', chat: false }, { id: 'json', label: '專案（JSON）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'json') { return { blob: new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }), name: name + '.json', mime: 'application/json' }; }
        if (id === 'csv') { var out = C.serializeCsv(spec, fmt === 'xlsx' ? curSheetId : null); return { blob: new Blob([out], { type: 'text/csv' }), name: name + '.csv', mime: 'text/csv' }; }
        if (id === 'xlsx') {
          if (fmt === 'xlsx' && spec.sig && C.sigOf(spec) === spec.sig && host.origXlsx) { var ob = null; try { ob = await host.origXlsx(); } catch (e) { ob = null; } if (ob) { return { blob: new Blob([ob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: name + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }; } }
          var Z = host.jszip ? await host.jszip() : null; if (!Z) { throw new Error('這裡還不能輸出 xlsx（JSZip 沒有載入）'); } var bytes = await C.buildXlsx(spec, Z); return { blob: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: name + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
        }
        return null;
      },
      build: function (ctx) {
        var spec = null, selId = null, sh = null, vals = null, cur = { r: 0, c: 0 }, selRow = null, selCol = null, editing = null, scrollEl = h('div', 'sgrid'), wrap = h('div'), srcWrap = h('div'), raf = 0;
        wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;margin:-8px'; scrollEl.tabIndex = 0;
        var bar = h('div', 'sbar'), ad = h('span', 'ad', 'A1'), fxIn = h('input', 'fx'); fxIn.type = 'text'; fxIn.placeholder = fmt === 'xlsx' ? '值，或以 = 開頭的公式' : '值'; fxIn.spellcheck = false; var fnd = h('input'), rep = h('input'), fst = h('span', 'st'), bRep = h('button', null, '全部取代'), bFind = h('button', null, '找下一個'); fnd.placeholder = '尋找'; fnd.style.width = '8em'; rep.placeholder = '取代成'; rep.style.width = '8em';
        [ad, fxIn, fnd, rep, bFind, bRep, fst].forEach(function (x) { bar.appendChild(x); }); wrap.appendChild(bar); wrap.appendChild(scrollEl);
        function sheetNow() { var i = selId ? C.find(spec, selId) : -1; return spec.objects[i >= 0 ? i : 0]; }
        function disp(r, c) { var x = sh.rows[r] && sh.rows[r].c[sh.cols[c].id]; if (fmt === 'xlsx' && C.isF(x)) { return FX.show(vals[r][c]); } return C.cellStr(x); }
        function rawText(r, c) { var x = sh.rows[r] && sh.rows[r].c[sh.cols[c].id]; return C.isF(x) ? '=' + x.f : C.cellStr(x); }
        function setCell(r, c, text, move) {
          var row = sh.rows[r], col = sh.cols[c]; if (!row || !col) { return; } if (rawText(r, c) === text) { return; } var e = { op: 'set_cell', sheet: sh.id, row: row.id, col: col.id }; if (fmt === 'xlsx' && /^=/.test(text)) { e.f = text; } else { e.v = text; }
          var res = ctx.apply([e], '改 ' + FX.colLetter(c) + (r + 1), '', 'panel'); if (res && res.rejected && res.rejected.length) { ctx.say(res.rejected[0].error); }
        }
        function status() { var x = sh.rows[cur.r] ? FX.colLetter(cur.c) + (cur.r + 1) : ''; ad.textContent = x; if (document.activeElement !== fxIn) { fxIn.value = sh.rows[cur.r] ? rawText(cur.r, cur.c) : ''; } }
        // ───── 虛擬捲動：只畫看得到的列 ─────
        function draw() {
          if (!sh) { return; } var keep = scrollEl.scrollTop, vh = scrollEl.clientHeight || 400, first = Math.max(0, Math.floor(keep / RH) - 6), count = Math.ceil(vh / RH) + 14, last = Math.min(sh.rows.length, first + count), cols = sh.cols;
          var tb = h('table'), cg = h('colgroup'), rn = h('col'); rn.style.width = RNW + 'px'; cg.appendChild(rn); cols.forEach(function (c) { var cc = h('col'); cc.style.width = colPx(c) + 'px'; cg.appendChild(cc); }); tb.appendChild(cg); tb.style.width = (RNW + cols.reduce(function (s, c) { return s + colPx(c); }, 0)) + 'px';
          var hr = h('tr'), corner = h('th', 'rn', ''); hr.appendChild(corner); cols.forEach(function (c, j) { var th = h('th', j === selCol ? 'csel' : '', FX.colLetter(j)); th.onclick = function () { selCol = j; selRow = null; cur.c = j; draw(); ctx.setProps(props()); status(); }; hr.appendChild(th); }); var thead = h('thead'); thead.appendChild(hr); tb.appendChild(thead);
          var tbody = h('tbody'); if (first > 0) { var sp = h('tr'); sp.style.height = first * RH + 'px'; var std = h('td'); std.colSpan = cols.length + 1; std.style.cssText = 'height:' + first * RH + 'px;padding:0;border:0'; sp.appendChild(std); tbody.appendChild(sp); }
          for (var r = first; r < last; r++) {
            (function (r) {
              var tr = h('tr'), rnc = h('td', 'rn' + (r === selRow ? ' rsel' : ''), String(r + 1)); rnc.onclick = function () { selRow = r; selCol = null; cur.r = r; draw(); ctx.setProps(props()); status(); }; tr.appendChild(rnc);
              cols.forEach(function (c, j) {
                var v = disp(r, j), x = sh.rows[r].c[c.id], isH = sh.header && r === 0, cl = (isH ? 'hd ' : '') + (r === cur.r && j === cur.c ? 'sel ' : '') + (r === selRow ? 'rsel ' : '') + (fmt === 'xlsx' && C.isF(x) ? (FX.isErr(vals[r][j]) ? 'err ' : 'fx ') : '') + (typeof (C.raw(x)) === 'number' ? 'num' : ''), td = h('td', cl.trim(), v); td.title = fmt === 'xlsx' && C.isF(x) ? '=' + x.f : '';
                td.onclick = function () { if (editing) { return; } cur = { r: r, c: j }; selRow = null; selCol = null; draw(); ctx.setProps(props()); status(); scrollEl.focus(); }; td.ondblclick = function () { startEdit(r, j); };
                tr.appendChild(td);
              });
              tbody.appendChild(tr);
            })(r);
          }
          if (last < sh.rows.length) { var sp2 = h('tr'), st2 = h('td'); st2.colSpan = cols.length + 1; st2.style.cssText = 'height:' + (sh.rows.length - last) * RH + 'px;padding:0;border:0'; sp2.appendChild(st2); tbody.appendChild(sp2); }
          tb.appendChild(tbody); scrollEl.textContent = ''; scrollEl.appendChild(tb); scrollEl.scrollTop = keep; editing = null;
        }
        scrollEl.onscroll = function () { if (raf || editing) { return; } raf = requestAnimationFrame(function () { raf = 0; draw(); }); };
        function cellEl(r, c) { var trs = scrollEl.querySelectorAll('tbody tr'); for (var i = 0; i < trs.length; i++) { var rn = trs[i].firstChild; if (rn && rn.textContent === String(r + 1)) { return trs[i].children[c + 1]; } } return null; }
        function ensureVisible() { var top = cur.r * RH + HEADH, bot = top + RH; if (top < scrollEl.scrollTop + HEADH) { scrollEl.scrollTop = Math.max(0, cur.r * RH); } else if (bot > scrollEl.scrollTop + scrollEl.clientHeight) { scrollEl.scrollTop = bot - scrollEl.clientHeight + 4; } }
        function startEdit(r, c, init) {
          if (sh.locked) { ctx.say('「' + sh.name + '」鎖住了'); return; } if (editing) { return; } cur = { r: r, c: c }; ensureVisible(); draw(); var td = cellEl(r, c); if (!td) { return; }
          var inp = h('input'); inp.type = 'text'; inp.value = init != null ? init : rawText(r, c); td.textContent = ''; td.appendChild(inp); editing = { r: r, c: c }; inp.focus(); if (init == null) { inp.select(); }
          var done = false; function finish(ok, dr, dc) { if (done) { return; } done = true; editing = null; var v = inp.value; if (ok) { setCell(r, c, v); } cur = { r: Math.max(0, Math.min(sh.rows.length - 1, r + (dr || 0))), c: Math.max(0, Math.min(sh.cols.length - 1, c + (dc || 0))) }; draw(); status(); scrollEl.focus(); }
          inp.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { finish(false); } else if (ev.key === 'Enter') { ev.preventDefault(); finish(true, ev.shiftKey ? -1 : 1, 0); } else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, 0, ev.shiftKey ? -1 : 1); } }; inp.onblur = function () { finish(true, 0, 0); }; inp.onclick = function (ev) { ev.stopPropagation(); };
        }
        scrollEl.onkeydown = function (ev) {
          if (editing || !sh) { return; } var k = ev.key, mv = null; ev.stopPropagation();
          if (k === 'ArrowDown') { mv = [1, 0]; } else if (k === 'ArrowUp') { mv = [-1, 0]; } else if (k === 'ArrowLeft') { mv = [0, -1]; } else if (k === 'ArrowRight') { mv = [0, 1]; } else if (k === 'Tab') { mv = [0, ev.shiftKey ? -1 : 1]; } else if (k === 'Enter') { mv = [ev.shiftKey ? -1 : 1, 0]; } else if (k === 'PageDown') { mv = [20, 0]; } else if (k === 'PageUp') { mv = [-20, 0]; }
          if (mv && !(k === 'Enter' && false)) { ev.preventDefault(); cur = { r: Math.max(0, Math.min(sh.rows.length - 1, cur.r + mv[0])), c: Math.max(0, Math.min(sh.cols.length - 1, cur.c + mv[1])) }; selRow = selCol = null; ensureVisible(); draw(); status(); return; }
          if (k === 'F2') { ev.preventDefault(); startEdit(cur.r, cur.c); return; }
          if (k === 'Delete' || k === 'Backspace') { ev.preventDefault(); setCell(cur.r, cur.c, ''); return; }
          if (k === 'z' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ctx.undo(); return; } if ((k === 'y' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); ctx.redo(); return; }
          if (k === 'c' && (ev.ctrlKey || ev.metaKey)) { try { navigator.clipboard.writeText(disp(cur.r, cur.c)); } catch (e) { /* 沒有權限就算了 */ } return; }
          if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); startEdit(cur.r, cur.c, k); }
        };
        scrollEl.addEventListener('paste', function (ev) {   // 貼上試算表的區塊（Tab 分欄、換行分列）：一次動作、可復原
          if (editing || !sh) { return; } var t = (ev.clipboardData && ev.clipboardData.getData('text')) || ''; if (!t) { return; } ev.preventDefault(); var rows = t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(function (l) { return l.split('\t'); }); if (rows.length * (rows[0] || []).length > 5000) { ctx.say('一次貼太多（超過 5000 格）'); return; }
          var es = []; rows.forEach(function (rw, i) { rw.forEach(function (v, j) { var r = cur.r + i, c = cur.c + j; if (c >= C.MAXCOLS || r >= C.MAXROWS) { return; } var e = { op: 'set_cell', sheet: sh.id, row: r + 1, col: FX.colLetter(c) }; if (fmt === 'xlsx' && /^=/.test(v)) { e.f = v; } else { e.v = v; } es.push(e); }); });
          var res = ctx.apply(es, '貼上 ' + rows.length + '×' + (rows[0] || []).length + ' 格', '', 'panel'); if (res && res.rejected && res.rejected.length) { ctx.say(res.rejected[0].error); }
        });
        fxIn.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); setCell(cur.r, cur.c, fxIn.value); scrollEl.focus(); } else if (ev.key === 'Escape') { fxIn.value = rawText(cur.r, cur.c); scrollEl.focus(); } };
        // ───── 找／取代 ─────
        var fi = -1; function hits() { var q = fnd.value.toLowerCase(), out = []; if (!q || !sh) { return out; } for (var r = 0; r < sh.rows.length && out.length < 5000; r++) { for (var c = 0; c < sh.cols.length; c++) { if (disp(r, c).toLowerCase().indexOf(q) >= 0) { out.push({ r: r, c: c }); } } } return out; }
        fnd.oninput = function () { var m = hits(); fst.textContent = fnd.value ? m.length + ' 格' : ''; fi = -1; };
        bFind.onclick = function () { var m = hits(); if (!m.length) { fst.textContent = '找不到'; return; } fi = (fi + 1) % m.length; cur = m[fi]; selRow = selCol = null; ensureVisible(); draw(); status(); fst.textContent = (fi + 1) + '／' + m.length; };
        fnd.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); bFind.onclick(); } }; rep.onkeydown = function (ev) { ev.stopPropagation(); };
        bRep.onclick = function () { if (!fnd.value) { return; } var r = ctx.apply([{ op: 'replace_all', find: fnd.value, repl: rep.value, sheet: sh.id }], '取代「' + fnd.value.slice(0, 12) + '」→「' + rep.value.slice(0, 12) + '」', '', 'panel'); fst.textContent = r.applied.length ? '已取代' : (r.rejected[0] ? r.rejected[0].error : ''); };
        // ───── 工具列：加列、加欄、開啟檔案 ─────
        var bAddRow = h('button', null, '＋列'), bAddCol = h('button', null, '＋欄'); bAddRow.title = '在選到的列後面（沒選就在最後）加一列'; bAddCol.title = '在選到的欄後面（沒選就在最後）加一欄';
        bAddRow.onclick = function () { ctx.apply([{ op: 'add_row', sheet: sh.id, after: String(cur.r + 1) }], '加一列', '', 'panel'); }; bAddCol.onclick = function () { ctx.apply([{ op: 'add_col', sheet: sh.id, after: sh.cols[cur.c].id }], '加一欄', '', 'panel'); };
        var openIn = h('input'); openIn.type = 'file'; openIn.accept = '.csv,.tsv,.txt,.xlsx,text/csv'; openIn.style.display = 'none'; var bOpen = h('button', null, '📂 開啟檔案'); bOpen.title = '把本機的 CSV 或 Excel 檔讀進來（取代目前的內容，可復原）'; bOpen.onclick = function () { openIn.click(); };
        openIn.onchange = function () {
          var f = openIn.files && openIn.files[0]; openIn.value = ''; if (!f) { return; } if (f.size > 20000000) { ctx.say('檔案太大（超過 20 MB）'); return; } var isX = /\.xlsx$/i.test(f.name), title = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
          f.arrayBuffer().then(async function (buf) { var ns; if (isX) { var Z = host.jszip ? await host.jszip() : null; if (!Z) { ctx.say('這裡還讀不了 xlsx（JSZip 沒有載入）'); return; } ns = await C.readXlsx(new Uint8Array(buf), Z, title); if (host.keepOrig) { try { host.keepOrig(new Uint8Array(buf)); } catch (e) { /* 原檔沒存到就是匯出時重新產生 */ } } } else { ns = C.parseCsv(decode(buf), title); } if (ns.format !== fmt) { ctx.say('這是' + (fmt === 'xlsx' ? '試算表' : 'CSV') + '編輯器：請用 /edit-' + (ns.format === 'xlsx' ? 'xlsx' : 'csv') + ' 開這個檔案'); return; } ctx.commit(ns, '開啟 ' + f.name, '', 'panel'); ctx.say('已開啟 ' + f.name + (ns.notes && ns.notes.length ? '（' + ns.notes.length + ' 項注意事項，見屬性面板）' : '')); }).catch(function (e) { ctx.say('開不起來：' + String((e && e.message) || e).slice(0, 80)); });
        };
        ctx.bar.appendChild(bAddRow); ctx.bar.appendChild(bAddCol); ctx.bar.appendChild(bOpen); ctx.bar.appendChild(openIn);
        // ───── 屬性：選到的格／列／欄；沒選＝工作表與檔案 ─────
        function props() {
          var box = h('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:6px'; function lab(t, el) { var l = h('label'); l.appendChild(document.createTextNode(t)); l.appendChild(el); return l; } function btn(t, fn, title) { var b = h('button', null, t); if (title) { b.title = title; } b.onclick = fn; return b; } function row(list) { var d = h('div', 'row'); list.forEach(function (x) { d.appendChild(x); }); return d; }
          if (selCol != null) {
            var c = sh.cols[selCol]; box.appendChild(h('div', 'st', '欄 ' + FX.colLetter(selCol) + (sh.header && sh.rows[0] ? '「' + C.cellStr(sh.rows[0].c[c.id]) + '」' : '')));
            box.appendChild(row([btn('↑ 由小到大', function () { var r = ctx.apply([{ op: 'sort', sheet: sh.id, col: c.id, dir: 'asc' }], '依 ' + FX.colLetter(selCol) + ' 欄排序', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } }), btn('↓ 由大到小', function () { var r = ctx.apply([{ op: 'sort', sheet: sh.id, col: c.id, dir: 'desc' }], '依 ' + FX.colLetter(selCol) + ' 欄由大到小排序', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } })]));
            box.appendChild(row([btn('← 左邊加欄', function () { ctx.apply([{ op: 'add_col', sheet: sh.id, after: selCol === 0 ? 'start' : sh.cols[selCol - 1].id }], '加一欄', '', 'panel'); }), btn('右邊加欄 →', function () { ctx.apply([{ op: 'add_col', sheet: sh.id, after: c.id }], '加一欄', '', 'panel'); })]));
            var w = h('input'); w.type = 'number'; w.min = 3; w.max = 80; w.value = c.w || 14; w.onchange = function () { ctx.apply([{ op: 'set_width', sheet: sh.id, col: c.id, w: Number(w.value) }], '欄寬', '', 'panel'); }; box.appendChild(lab('欄寬（字元）', w));
            box.appendChild(row([btn('🧹 去前後空白', function () { ctx.apply([{ op: 'trim', sheet: sh.id, col: c.id }], '去空白', '', 'panel'); }), btn('🗑 刪掉這欄', function () { var r = ctx.apply([{ op: 'del_col', sheet: sh.id, col: c.id }], '刪掉 ' + FX.colLetter(selCol) + ' 欄', '', 'panel'); selCol = null; if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } })])); return box;
          }
          if (selRow != null) {
            var rw = sh.rows[selRow]; box.appendChild(h('div', 'st', '第 ' + (selRow + 1) + ' 列'));
            box.appendChild(row([btn('↑ 上面加列', function () { ctx.apply([{ op: 'add_row', sheet: sh.id, after: selRow === 0 ? 'start' : String(selRow) }], '加一列', '', 'panel'); }), btn('下面加列 ↓', function () { ctx.apply([{ op: 'add_row', sheet: sh.id, after: String(selRow + 1) }], '加一列', '', 'panel'); })]));
            box.appendChild(btn('🗑 刪掉這列', function () { ctx.apply([{ op: 'del_rows', sheet: sh.id, rows: [rw.id] }], '刪掉第 ' + (selRow + 1) + ' 列', '', 'panel'); selRow = null; })); return box;
          }
          var nf = sh.rows.reduce(function (n, r) { return n + Object.keys(r.c).filter(function (k) { return C.isF(r.c[k]); }).length; }, 0), ti = h('input'); ti.type = 'text'; ti.value = spec.title; ti.onchange = function () { if (ti.value.trim()) { ctx.apply([{ op: 'set_title', text: ti.value }], '標題改成「' + ti.value.trim().slice(0, 20) + '」', '', 'panel'); } };
          box.appendChild(h('div', 'st', '工作表「' + sh.name + '」：' + sh.rows.length + ' 列 × ' + sh.cols.length + ' 欄' + (nf ? '・' + nf + ' 個公式' : '') + (fmt === 'xlsx' ? '・共 ' + spec.objects.length + ' 張' : ''))); box.appendChild(lab('檔名', ti));
          var hd = h('input'); hd.type = 'checkbox'; hd.checked = !!sh.header; hd.onchange = function () { ctx.apply([{ op: 'set_header', sheet: sh.id, header: hd.checked }], hd.checked ? '第一列當標題' : '第一列不當標題', '', 'panel'); }; box.appendChild(lab('第一列是標題', hd));
          box.appendChild(row([btn('🧹 刪空白列', function () { var r = ctx.apply([{ op: 'del_rows', sheet: sh.id, blank: true }], '刪掉空白列', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } }), btn('♊ 去重複列', function () { var r = ctx.apply([{ op: 'del_rows', sheet: sh.id, duplicates: {} }], '去掉重複的列', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } }), btn('🧹 去空白', function () { var r = ctx.apply([{ op: 'trim', sheet: sh.id }], '去前後空白', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } })]));
          if (fmt === 'csv') {
            var ds = h('select'); [[',', '分隔：逗號'], [';', '分隔：分號'], ['\t', '分隔：Tab'], ['|', '分隔：直線']].forEach(function (x) { var o = h('option', null, x[1]); o.value = x[0]; ds.appendChild(o); }); ds.value = spec.delim; ds.onchange = function () { ctx.apply([{ op: 'set_doc', delim: ds.value }], '分隔符號改成 ' + ds.options[ds.selectedIndex].textContent, '', 'panel'); }; box.appendChild(ds);
            var es = h('select'); [['\n', '換行：LF'], ['\r\n', '換行：CRLF']].forEach(function (x) { var o = h('option', null, x[1]); o.value = x[0]; es.appendChild(o); }); es.value = spec.eol === '\r\n' ? '\r\n' : '\n'; es.onchange = function () { ctx.apply([{ op: 'set_doc', eol: es.value }], '換行改成 ' + (es.value === '\r\n' ? 'CRLF' : 'LF'), '', 'panel'); }; box.appendChild(es);
            var bm = h('input'); bm.type = 'checkbox'; bm.checked = !!spec.bom; bm.onchange = function () { ctx.apply([{ op: 'set_doc', bom: bm.checked }], 'BOM ' + (bm.checked ? '加上' : '拿掉'), '', 'panel'); }; box.appendChild(lab('UTF-8 BOM（Excel 開中文用）', bm));
            var qa = h('input'); qa.type = 'checkbox'; qa.checked = !!spec.quoteAll; qa.onchange = function () { ctx.apply([{ op: 'set_doc', quoteAll: qa.checked }], qa.checked ? '全部加引號' : '只在需要時加引號', '', 'panel'); }; box.appendChild(lab('每格都加引號', qa));
            box.appendChild(h('div', 'st', '沒有動到的檔案，輸出時一個位元組都不會變。'));
          }
          (spec.notes || []).forEach(function (n) { var d = h('div', 'st', '⚠️ ' + n); d.style.color = '#9a6700'; box.appendChild(d); }); return box;
        }
        // ───── CSV 的原始碼分頁 ─────
        var srcTa = h('textarea', 'code'); srcTa.rows = 18; srcTa.spellcheck = false; srcTa.style.flex = '1'; srcTa.style.whiteSpace = 'pre'; srcWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1';
        var bApply = h('button', 'pri', '▶ 套用原始碼'), bRe = h('button', null, '↻ 重新產生'), srcSt = h('span', 'st'), srow = h('div', 'row'); [bApply, bRe, srcSt].forEach(function (x) { srow.appendChild(x); });
        srcWrap.appendChild(h('div', 'st', '整份 CSV 的原始文字。改完按「套用原始碼」（會整份重新解析；欄列的 id 重新編）。')); srcWrap.appendChild(srcTa); srcWrap.appendChild(srow);
        function srcText() { return C.serializeCsv(spec); }
        bRe.onclick = function () { srcTa.value = srcText(); srcSt.textContent = ''; };
        bApply.onclick = function () { var t = srcTa.value.replace(/\r\n|\n/g, spec.eol === '\r\n' ? '\r\n' : '\n'); if (t === srcText()) { srcSt.textContent = '沒有改動'; return; } var ns = C.parseCsv((spec.bom ? '﻿' : '') + t, spec.title); ctx.commit(ns, '改寫原始碼（' + ns.objects[0].rows.length + ' 列）', '', 'panel'); srcSt.textContent = '已套用'; };
        var ret = {
          tabs: fmt === 'csv' ? { grid: wrap, source: srcWrap } : { grid: wrap }, env: function () { return { selection: selId }; },
          refresh: function (s, id) {
            spec = s; selId = id; var prev = sh; sh = sheetNow(); curSheetId = sh.id; if (prev && prev.id !== sh.id) { cur = { r: 0, c: 0 }; selRow = selCol = null; scrollEl.scrollTop = 0; } vals = fmt === 'xlsx' ? C.computed(sh) : null; cur = { r: Math.min(cur.r, Math.max(0, sh.rows.length - 1)), c: Math.min(cur.c, Math.max(0, sh.cols.length - 1)) };
            if (selRow != null && selRow >= sh.rows.length) { selRow = null; } if (selCol != null && selCol >= sh.cols.length) { selCol = null; } if (!editing) { draw(); } ctx.setProps(props()); status(); if (fmt === 'csv' && document.activeElement !== srcTa) { srcTa.value = srcText(); }
          },
          showTab: function (t) { if (t === 'source') { srcTa.value = srcText(); } else { draw(); } }, destroy: function () { /* 沒有要收的資源 */ },
        };
        return ret;
      }
    });
  }
  return { mount: mount, colPx: colPx };
});
