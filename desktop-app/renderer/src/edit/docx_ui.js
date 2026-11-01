// /edit-docx 的畫面，蓋在共用外框（edit_shell.js）上：中間是「預覽」（一個區塊一塊，單擊選取、雙擊就地改字；選一段字再按 粗／斜／底線／顏色 只改那段字）、
// 左邊的物件欄是文件的章節樹，屬性面板改區塊的型別／層級／清單／對齊／表格。
//   FaEditDocxUI.mount({ id, state, spec, host, container, restoring, store, windowApi }) -> element (el._ed)
//   host：jszip()? → Promise<JSZip>、origDocx()? → Promise<Uint8Array|null>（沒改過的檔案匯出原檔；改過的在原檔上只重寫 body）、keepOrig(bytes)?
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditDocxUI = factory((root.FaEditDocx || (typeof FaEditDocx !== 'undefined' ? FaEditDocx : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, Shell) {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var ICON = { heading: '🔠', para: '¶', li: '☰', table: '▦', pagebreak: '⤓', raw: '🧱' };
  var CSS = '.few .ddoc{flex:1;min-height:0;overflow:auto;max-height:62vh;padding:10px 16px;background:#fff;color:#1f2328}.few.fwin-pop .ddoc,.few.fwin-max .ddoc{max-height:none}.few .ddoc .blk{position:relative;border-radius:4px;padding:1px 6px;margin:1px 0;border:1px solid transparent}.few .ddoc .blk:hover{background:rgba(120,140,200,.08)}.few .ddoc .blk.sel{border-color:var(--acc);background:rgba(47,129,247,.08)}.few .ddoc .blk.hid{opacity:.4}'
    + '.few .ddoc p{margin:.3em 0}.few .ddoc h1,.few .ddoc h2,.few .ddoc h3,.few .ddoc h4,.few .ddoc h5,.few .ddoc h6{margin:.5em 0 .3em;line-height:1.3}.few .ddoc h1{font-size:1.7em}.few .ddoc h2{font-size:1.4em}.few .ddoc h3{font-size:1.2em}.few .ddoc table{border-collapse:collapse;margin:.4em 0}.few .ddoc td{border:1px solid #888;padding:.25em .6em;min-width:3em}.few .ddoc .pb{border-top:1px dashed #888;color:#888;text-align:center;font-size:12px}.few .ddoc .raw{border:1px dashed #aaa;color:#777;padding:4px 8px;border-radius:4px;font-size:12px}.few .ddoc textarea.ed,.few .ddoc td input{width:100%;box-sizing:border-box;font:inherit}.few .dfmt{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:4px 8px;border-bottom:1px solid var(--bd);background:var(--hd)}.few .dfmt button{min-width:2em}';
  function slug(s) { return String(s || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'document'; }
  function visibleOnly(spec) { var s = JSON.parse(JSON.stringify(spec)); s.objects = s.objects.filter(function (b) { return b.visible !== false; }); return s; }
  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  function mount(opt) {
    var host = opt.host || {}, W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    if (!document.getElementById('few-docx-css')) { var st = document.createElement('style'); st.id = 'few-docx-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
    return Shell.mount({
      id: opt.id, kind: 'edit-docx', title: '📄 Word 文件編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'doc', label: '👁 預覽' }],
      placeholder: '用說的改：「把第 2 段改成…」「把第 3 段改成粗體」「把「重點」變成紅色」「在最後加一段：…」「把最後一個改成編號清單」「把「舊」全部換成「新」」',
      intro: '我是 Word 文件編輯器：文件分成一個個區塊（標題、段落、清單、表格、分頁…），沒動到的區塊、圖片、頁首頁尾、樣式都原封不動地留在原檔裡，只重寫改過的部分。單擊選取、雙擊就地改字；選一段字再按上面的 B／I／U／顏色只改那段字；也可以對我說：「把第 2 段改成…」「把第 3 段改成粗體」「在最後加一段…」。編輯器不懂的內容（圖片、欄位、追蹤修訂…）會顯示成虛線方塊，原樣保留。每一步都能復原。',
      objectIcon: function (o) { return ICON[o.type] || '◻'; },
      objectInfo: function (o) { return o.type === 'heading' ? 'H' + o.level : o.type === 'li' ? (o.ordered ? '編號' : '項目') : o.type === 'table' ? o.rows.length + '×' + o.rows[0].length : ''; },
      treeRows: function (sp) { var d = 0, rows = []; sp.objects.forEach(function (b) { if (b.type === 'heading') { d = Math.min(5, b.level - 1); rows.push({ obj: b, depth: d }); d = Math.min(5, b.level); } else { rows.push({ obj: b, depth: d }); } }); return rows; },
      parseCommands: C.parseCommands,
      promptOf: function (sp, steps) { var L = ['請寫一份 Word 文件「' + sp.title + '」，共 ' + sp.objects.length + ' 個區塊。']; var heads = sp.objects.filter(function (b) { return b.type === 'heading'; }); if (heads.length) { L.push('', '大綱：'); heads.forEach(function (b) { L.push(new Array(b.level).join('  ') + '- ' + C.plain(b)); }); } var texts = steps.filter(function (s) { return s.text; }); if (texts.length) { L.push('', '修改過程：'); texts.forEach(function (s, i) { L.push((i + 1) + '. ' + s.text); }); } return L.join('\n'); },
      exports: [{ id: 'docx', label: 'Word 檔 (.docx)', chat: false }, { id: 'html', label: 'HTML 網頁' }, { id: 'txt', label: '純文字', chat: false }, { id: 'json', label: '專案（JSON）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'json') { return { blob: new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }), name: name + '.json', mime: 'application/json' }; }
        if (id === 'html') { return { blob: new Blob([C.toHtml(visibleOnly(spec))], { type: 'text/html' }), name: name + '.html', mime: 'text/html' }; }
        if (id === 'txt') { var t = visibleOnly(spec).objects.map(function (b) { return b.type === 'table' ? b.rows.map(function (r) { return r.join('\t'); }).join('\n') : b.type === 'raw' ? '' : C.plain(b); }).join('\n'); return { blob: new Blob([t], { type: 'text/plain' }), name: name + '.txt', mime: 'text/plain' }; }
        if (id === 'docx') {
          var orig = null; if (host.origDocx) { try { orig = await host.origDocx(); } catch (e) { orig = null; } }
          if (orig && spec.sig && C.sigOf(spec) === spec.sig) { return { blob: new Blob([orig], { type: MIME }), name: name + '.docx', mime: MIME }; }
          var Z = host.jszip ? await host.jszip() : null; if (!Z) { throw new Error('這裡還不能輸出 docx（JSZip 沒有載入）'); } var vs = visibleOnly(spec); var bytes = await C.build(vs, Z, orig || undefined); return { blob: new Blob([bytes], { type: MIME }), name: name + '.docx', mime: MIME };
        }
        return null;
      },
      build: function (ctx) {
        var spec = null, sel = null, editing = null, docEl = h('div', 'ddoc'), wrap = h('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;margin:-8px';
        // ───── 格式列：粗／斜／底線／顏色／對齊（有選字就只改那段字，沒有就改選取的區塊） ─────
        var fb = h('div', 'dfmt');
        function selText() { var s = window.getSelection && window.getSelection(); if (!s || s.isCollapsed) { return ''; } var t = String(s.toString()).replace(/\s+$/, ''); if (!t || t.indexOf('\n') >= 0) { return ''; } var n = s.anchorNode; while (n && n !== docEl) { n = n.parentNode; } return n === docEl ? t : ''; }
        function selBlockOfRange() { var s = window.getSelection && window.getSelection(); if (!s || s.isCollapsed) { return null; } var n = s.anchorNode; while (n && n !== docEl) { if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-id')) { return n.getAttribute('data-id'); } n = n.parentNode; } return null; }
        function fmt(f, label) {
          var txt = selText(), id = (txt && selBlockOfRange()) || sel; if (!id) { ctx.say('先選一個區塊（或選一段字）'); return; }
          var e = Object.assign({ op: 'set_style', id: id }, f); if (txt) { e.find = txt; e.all = false; } var r = ctx.apply([e], label + (txt ? '「' + txt.slice(0, 10) + '」' : ''), '', 'panel'); if (r && r.rejected && r.rejected.length) { ctx.say(r.rejected[0].error); }
        }
        function fbtn(t, title, f, label, style) { var b = h('button', null, t); b.title = title; if (style) { b.style.cssText = style; } b.onmousedown = function (ev) { ev.preventDefault(); }; b.onclick = function () { var o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null; var f2 = typeof f === 'function' ? f(o) : f; fmt(f2, label); }; fb.appendChild(b); return b; }
        var anyOn = function (o, tag) { return !!(o && (o.runs || []).length && o.runs.every(function (r) { return C.rprHas(r.rpr || '', tag); })); };
        fbtn('B', '粗體（有選字就只改那段字）', function (o) { return { bold: !anyOn(o, 'b') }; }, '粗體', 'font-weight:700'); fbtn('I', '斜體', function (o) { return { italic: !anyOn(o, 'i') }; }, '斜體', 'font-style:italic'); fbtn('U', '底線', function (o) { return { underline: !anyOn(o, 'u') }; }, '底線', 'text-decoration:underline'); fbtn('S', '刪除線', function (o) { return { strike: !anyOn(o, 'strike') }; }, '刪除線', 'text-decoration:line-through');
        var cs = h('select'); [['', '文字顏色…'], ['C00000', '紅'], ['0070C0', '藍'], ['00B050', '綠'], ['ED7D31', '橘'], ['7030A0', '紫'], ['7F7F7F', '灰'], ['000000', '黑（還原）']].forEach(function (x) { var o = h('option', null, x[1]); o.value = x[0]; cs.appendChild(o); }); cs.onmousedown = function () { /* 保留選取的字 */ }; cs.onchange = function () { var v = cs.value; cs.value = ''; if (v) { fmt({ color: v }, '文字顏色'); } }; fb.appendChild(cs);
        [['⇤', '靠左', 'left'], ['⇔', '置中', 'center'], ['⇥', '靠右', 'right'], ['☰', '左右對齊', 'both']].forEach(function (a) { var b = h('button', null, a[0]); b.title = a[1]; b.onmousedown = function (ev) { ev.preventDefault(); }; b.onclick = function () { if (!sel) { ctx.say('先選一個區塊'); return; } var r = ctx.apply([{ op: 'set_style', id: sel, align: a[2] }], '對齊：' + a[1], '', 'panel'); if (r && r.rejected && r.rejected.length) { ctx.say(r.rejected[0].error); } }; fb.appendChild(b); });
        var fnd = h('input'), rep = h('input'), fst = h('span', 'st'), bRep = h('button', null, '全部取代'), bFind = h('button', null, '找下一個'); fnd.placeholder = '尋找'; fnd.style.width = '7em'; rep.placeholder = '取代成'; rep.style.width = '7em'; [fnd, rep, bFind, bRep, fst].forEach(function (x) { fb.appendChild(x); });
        function matches() { var q = fnd.value.toLowerCase(); if (!q || !spec) { return []; } return spec.objects.filter(function (b) { return (C.plain(b) + ' ' + (b.rows || []).join(' ')).toLowerCase().indexOf(q) >= 0; }); }
        var fi = -1; fnd.oninput = function () { var m = matches(); fst.textContent = fnd.value ? m.length + ' 個區塊有' : ''; fi = -1; };
        bFind.onclick = function () { var m = matches(); if (!m.length) { fst.textContent = '找不到'; return; } fi = (fi + 1) % m.length; ctx.select(m[fi].id); fst.textContent = (fi + 1) + '／' + m.length; };
        fnd.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); bFind.onclick(); } }; rep.onkeydown = function (ev) { ev.stopPropagation(); };
        bRep.onclick = function () { if (!fnd.value) { return; } var r = ctx.apply([{ op: 'replace_all', find: fnd.value, repl: rep.value, scope: sel || undefined }], '取代「' + fnd.value.slice(0, 12) + '」→「' + rep.value.slice(0, 12) + '」' + (sel ? '（選取的區塊）' : ''), '', 'panel'); fst.textContent = r.applied.length ? '已取代' : (r.rejected[0] ? r.rejected[0].error : ''); };
        wrap.appendChild(fb); wrap.appendChild(docEl);
        // ───── 預覽 ─────
        function draw() {
          if (!spec) { return; } var keep = docEl.scrollTop; docEl.textContent = ''; editing = null;
          if (!spec.objects.length) { var em = h('div', 'st', '（空的文件：對 AI 說要寫什麼，或按上面的「＋ 區塊」）'); em.style.padding = '12px'; docEl.appendChild(em); }
          spec.objects.forEach(function (b) {
            var w = h('div', 'blk' + (b.id === sel ? ' sel' : '') + (b.visible === false ? ' hid' : '') + (b.locked ? ' lk' : '')); w.setAttribute('data-id', b.id); w.innerHTML = C.blockHtml(b);
            w.onclick = function (ev) { if (editing) { return; } if (ev.target && ev.target.closest && ev.target.closest('a')) { ev.preventDefault(); } if (window.getSelection && !window.getSelection().isCollapsed) { ctx.select(b.id); return; } ctx.select(b.id === sel ? null : b.id); };
            w.ondblclick = function (ev) { var td = ev.target && ev.target.closest ? ev.target.closest('td') : null, pos = null; if (td && b.type === 'table') { var tr0 = td.parentNode; pos = [Array.prototype.indexOf.call(tr0.parentNode.children, tr0), Array.prototype.indexOf.call(tr0.children, td)]; } ev.preventDefault(); ctx.select(b.id); if (pos) { var nb = docEl.querySelector('[data-id="' + b.id + '"]'), trs = nb ? nb.querySelectorAll('tr') : [], td2 = trs[pos[0]] ? trs[pos[0]].children[pos[1]] : null; if (td2) { editCell(b, td2); } } else { edit(b.id); } };
            docEl.appendChild(w);
          });
          docEl.scrollTop = keep;
        }
        function edit(id) {
          var i = C.find(spec, id); if (i < 0) { return; } var b = spec.objects[i]; if (b.locked) { ctx.say('「' + b.name + '」鎖住了'); return; } if (b.type !== 'heading' && b.type !== 'para' && b.type !== 'li') { ctx.say(b.type === 'raw' ? '這是編輯器不能改的內容（圖片、欄位等），原樣保留' : '這種區塊沒有文字可以改'); return; }
          var w = docEl.querySelector('[data-id="' + id + '"]'); if (!w) { return; } var ta = h('textarea', 'ed'), raw = C.plain(b); ta.value = raw; ta.rows = Math.max(1, Math.min(14, raw.split('\n').length + 1)); ta.spellcheck = false; ta.title = (b.runs || []).length > 1 ? '有多種格式的段落：沒動到的字保留原本的格式' : ''; w.textContent = ''; w.appendChild(ta); editing = id; ta.focus();
          var done = false; function finish(ok) { if (done) { return; } done = true; editing = null; var v = ta.value; if (ok && v !== raw) { var r = ctx.apply([{ op: 'set_text', id: id, text: v }], '改字 ' + b.name, '', 'panel'); if (r && r.rejected && r.rejected.length) { ctx.say(r.rejected[0].error); } if (!(r && r.applied && r.applied.length)) { draw(); } } else { draw(); } }
          ta.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { finish(false); } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey || !ev.shiftKey && b.type !== 'para')) { ev.preventDefault(); finish(true); } }; ta.onblur = function () { finish(true); }; ta.onclick = function (ev) { ev.stopPropagation(); };
        }
        function editCell(b, td) {
          if (b.locked) { return; } var tr = td.parentNode, ri = Array.prototype.indexOf.call(tr.parentNode.children, tr), ci = Array.prototype.indexOf.call(tr.children, td), old = b.rows[ri] ? b.rows[ri][ci] : ''; if (old == null) { return; } var inp = h('input'); inp.value = old; td.textContent = ''; td.appendChild(inp); editing = b.id; inp.focus(); inp.select();
          var done = false; function finish(ok) { if (done) { return; } done = true; editing = null; if (ok && inp.value !== old) { var r = ctx.apply([{ op: 'set_cell', id: b.id, row: ri, col: ci, text: inp.value }], '改儲存格', '', 'panel'); if (!(r && r.applied && r.applied.length)) { draw(); } } else { draw(); } }
          inp.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { finish(false); } else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); finish(true); } }; inp.onblur = function () { finish(true); }; inp.onclick = function (ev) { ev.stopPropagation(); };
        }
        // ───── 新增區塊／開啟檔案 ─────
        var addSel = h('select'), NEW = [['para', '段落'], ['heading', '標題'], ['li', '項目清單'], ['oli', '編號清單'], ['table', '表格'], ['pagebreak', '分頁']]; var a0 = h('option', null, '＋ 區塊'); a0.value = ''; addSel.appendChild(a0); NEW.forEach(function (x) { var o = h('option', null, x[1]); o.value = x[0]; addSel.appendChild(o); }); addSel.title = '在選取的區塊後面（沒選就在最後）加一個新區塊';
        addSel.onchange = function () { var t = addSel.value; addSel.value = ''; if (!t) { return; } var blk = t === 'oli' ? { type: 'li', ordered: true, text: '項目' } : t === 'li' ? { type: 'li', ordered: false, text: '項目' } : t === 'heading' ? { type: 'heading', level: 2, text: '標題' } : t === 'table' ? { type: 'table', rows: [['欄位 1', '欄位 2'], ['', '']] } : t === 'pagebreak' ? { type: 'pagebreak' } : { type: 'para', text: '新段落' }; var r = ctx.apply([{ op: 'add_block', after: sel || 'end', block: blk }], '新增' + (NEW.filter(function (x) { return x[0] === t; })[0] || [0, t])[1], '', 'panel'); if (r.added && r.added.length && (t === 'para' || t === 'heading' || t === 'li' || t === 'oli')) { setTimeout(function () { edit(r.added[r.added.length - 1]); }, 30); } };
        var openIn = h('input'); openIn.type = 'file'; openIn.accept = '.docx'; openIn.style.display = 'none'; var bOpen = h('button', null, '📂 開啟檔案'); bOpen.title = '把本機的 .docx 讀進來（取代目前的內容，可復原；沒改過再匯出就是原檔）'; bOpen.onclick = function () { openIn.click(); };
        openIn.onchange = function () { var f = openIn.files && openIn.files[0]; openIn.value = ''; if (!f) { return; } if (f.size > 30000000) { ctx.say('檔案太大（超過 30 MB）'); return; } f.arrayBuffer().then(async function (buf) { var Z = host.jszip ? await host.jszip() : null; if (!Z) { ctx.say('這裡還讀不了 docx（JSZip 沒有載入）'); return; } var ns = await C.read(new Uint8Array(buf), Z, f.name.replace(/\.[^.]+$/, '').slice(0, 60)); if (host.keepOrig) { try { host.keepOrig(new Uint8Array(buf)); } catch (e) { /* 原檔沒存到：匯出時由目前內容重新產生 */ } } ctx.commit(ns, '開啟 ' + f.name, '', 'panel'); ctx.say('已開啟 ' + f.name + (ns.notes && ns.notes.length ? '（' + ns.notes.length + ' 項注意事項，見屬性面板）' : '')); }).catch(function (e) { ctx.say('開不起來：' + String((e && e.message) || e).slice(0, 80)); }); };
        ctx.bar.appendChild(addSel); ctx.bar.appendChild(bOpen); ctx.bar.appendChild(openIn);
        // ───── 屬性 ─────
        function props() {
          var box = h('div'), o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null; box.style.cssText = 'display:flex;flex-direction:column;gap:6px';
          function lab(t, el) { var l = h('label'); l.appendChild(document.createTextNode(t)); l.appendChild(el); return l; } function btn(t, fn, title) { var b = h('button', null, t); if (title) { b.title = title; } b.onclick = fn; return b; }
          if (!o) {
            var ti = h('input'); ti.type = 'text'; ti.value = spec.title; ti.onchange = function () { if (ti.value.trim()) { ctx.apply([{ op: 'set_title', text: ti.value }], '標題改成「' + ti.value.trim().slice(0, 20) + '」', '', 'panel'); } }; var chars = spec.objects.reduce(function (n, b) { return n + (C.plain(b) || '').length + (b.rows || []).join('').length; }, 0);
            box.appendChild(h('div', 'st', '文件：' + spec.objects.length + ' 個區塊・' + chars + ' 字元')); box.appendChild(lab('名稱', ti)); box.appendChild(h('div', 'st', '沒有動到的區塊、圖片、頁首頁尾、樣式，輸出時一個位元組都不會變。'));
            (spec.notes || []).forEach(function (n) { var d = h('div', 'st', '⚠️ ' + n); d.style.color = '#9a6700'; box.appendChild(d); }); return box;
          }
          box.appendChild(h('div', 'st', o.name + '（' + o.type + '，' + o.id + '）'));
          if (o.type === 'raw') { box.appendChild(h('div', 'st', '編輯器不能改這個內容（圖片、欄位、追蹤修訂、文字方塊等），輸出時原樣保留。可以刪除、搬移它。')); return box; }
          if (o.type === 'heading' || o.type === 'para' || o.type === 'li') {
            box.appendChild(btn('✏️ 編輯文字（雙擊也行）', function () { edit(o.id); }));
            var cv = h('select'); [['', '轉成…'], ['para', '一般段落'], ['h1', '標題 1'], ['h2', '標題 2'], ['h3', '標題 3'], ['h4', '標題 4'], ['list', '項目清單'], ['olist', '編號清單']].forEach(function (x) { var op = h('option', null, x[1]); op.value = x[0]; cv.appendChild(op); }); cv.onchange = function () { var v = cv.value; cv.value = ''; if (!v) { return; } var e = /^h(\d)$/.test(v) ? { op: 'set_heading', id: o.id, level: Number(v[1]) } : v === 'para' ? { op: 'set_heading', id: o.id, level: 0 } : { op: 'list_toggle', id: o.id, ordered: v === 'olist' }; if (v === 'para' && o.type === 'li') { e = { op: 'list_toggle', id: o.id, off: true }; } var r = ctx.apply([e], '轉成' + cv.options[cv.selectedIndex].textContent, '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } }; box.appendChild(cv);
          }
          if (o.type === 'table') { var tb = h('div', 'row'); tb.appendChild(btn('＋列', function () { ctx.apply([{ op: 'table_rows', id: o.id, add: 'end' }], '表格加一列', '', 'panel'); })); tb.appendChild(btn('－列', function () { var r = ctx.apply([{ op: 'table_rows', id: o.id, del: o.rows.length - 1 }], '表格少一列', '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } })); box.appendChild(tb); box.appendChild(h('div', 'st', '雙擊儲存格改字；框線、欄寬、儲存格格式保持原樣。')); }
          var mv = h('div', 'row'); [['⤒ 最前', 'first'], ['↑', 'earlier'], ['↓', 'later'], ['⤓ 最後', 'last']].forEach(function (x) { mv.appendChild(btn(x[0], function () { ctx.apply([{ op: 'move_block', id: o.id, to: x[1] }], '移動 ' + o.name, '', 'panel'); })); }); box.appendChild(mv); return box;
        }
        return {
          tabs: { doc: wrap }, env: function () { return {}; },
          refresh: function (s, selId) { spec = s; sel = selId; if (!editing) { draw(); } ctx.setProps(props()); var el = selId ? docEl.querySelector('[data-id="' + selId + '"]') : null; if (el && el.scrollIntoView && !editing) { el.scrollIntoView({ block: 'nearest' }); } },
          showTab: function () { draw(); }, destroy: function () { /* 沒有要收的資源 */ },
        };
      }
    });
  }
  return { mount: mount, visibleOnly: visibleOnly };
});
