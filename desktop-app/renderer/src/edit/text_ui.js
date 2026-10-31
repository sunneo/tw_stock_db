// /edit-markdown 與 /edit-text 的畫面，蓋在共用外框（edit_shell.js）上：中間是「預覽」（一個區塊一塊，單擊選取、雙擊用原本的語法就地改）與「原始碼」（整份文字，套用時沒變的區塊沿用 id），
// 左邊的物件欄是文件的章節樹（區塊依文件順序），屬性面板改區塊的型別／層級／清單／表格／空行，底部的 AI 對話與記錄是外框的。
//   FaEditTextUI.mount({ id, state, spec, host, container, restoring, store, windowApi }) -> element (el._ed)
//   host 除了外框要的以外：openFile?(file) 由 UI 自己讀（FileReader），不需要 host
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditTextUI = factory((root.FaEditText || (typeof FaEditText !== 'undefined' ? FaEditText : undefined)), (root.FaEditShell || (typeof FaEditShell !== 'undefined' ? FaEditShell : undefined))); })(typeof self !== 'undefined' ? self : this, function (C, Shell) {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  var ICON = { heading: '🔠', para: '¶', line: '≡', quote: '❝', list: '☰', code: '⌨', table: '▦', hr: '―', raw: '🧱' };
  var CSS = '.few .tdoc{flex:1;min-height:0;overflow:auto;max-height:62vh;padding:6px 10px}.few.fwin-pop .tdoc,.few.fwin-max .tdoc{max-height:none}.few .tdoc .blk{position:relative;border-radius:5px;padding:1px 6px;margin:1px 0;border:1px solid transparent;cursor:default}.few .tdoc .blk:hover{background:rgba(120,140,200,.08)}.few .tdoc .blk.sel{border-color:var(--acc);background:rgba(47,129,247,.08)}.few .tdoc .blk.hid{opacity:.4;text-decoration:line-through}.few .tdoc .blk.lk::after{content:"🔒";position:absolute;right:4px;top:2px;font-size:11px}'
    + '.few .tdoc h1,.few .tdoc h2,.few .tdoc h3,.few .tdoc h4,.few .tdoc h5,.few .tdoc h6{margin:.5em 0 .3em;line-height:1.3}.few .tdoc h1{font-size:1.7em}.few .tdoc h2{font-size:1.4em}.few .tdoc h3{font-size:1.2em}.few .tdoc p{margin:.4em 0;line-height:1.65}.few .tdoc blockquote{margin:.4em 0;padding:0 .9em;border-left:4px solid var(--bd);color:var(--mut)}.few .tdoc pre{margin:.4em 0;padding:.6em;background:var(--hd);border:1px solid var(--bd);border-radius:5px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace}.few .tdoc code{background:var(--hd);padding:0 .25em;border-radius:3px}.few .tdoc pre code{padding:0;background:none}.few .tdoc pre.raw{opacity:.75;border-style:dashed}'
    + '.few .tdoc table{border-collapse:collapse;margin:.4em 0}.few .tdoc td,.few .tdoc th{border:1px solid var(--bd);padding:.25em .6em}.few .tdoc th{background:var(--hd)}.few .tdoc ul,.few .tdoc ol{margin:.3em 0;padding-left:1.6em}.few .tdoc .ln{white-space:pre-wrap;word-break:break-word;font:13px/1.55 ui-monospace,Consolas,monospace}.few .tdoc .img{color:var(--mut)}.few .tdoc textarea.ed{font:13px/1.5 ui-monospace,Consolas,monospace;min-height:3em;white-space:pre-wrap;resize:vertical}'
    + '.few .tfind{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:4px 8px;border-bottom:1px solid var(--bd);background:var(--hd)}.few .tfind input{width:9em}';
  function slug(s) { return String(s || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'document'; }
  function visibleOnly(spec) { var s = JSON.parse(JSON.stringify(spec)); if (!s.objects.some(function (b) { return b.visible === false; })) { return s; } s.objects = s.objects.filter(function (b) { return b.visible !== false; }); if (s.objects.length) { s.objects[s.objects.length - 1].gap = spec.objects[spec.objects.length - 1].gap; } return s; }
  function rawOf(b, fmt) { return fmt === 'txt' ? b.text : (b.src != null && b.src !== '' ? b.src : C.render(b)); }
  function words(spec) { var t = spec.objects.map(function (b) { return b.type === 'list' ? b.items.join(' ') : b.type === 'table' ? b.rows.map(function (r) { return r.join(' '); }).join(' ') : (b.text || ''); }).join(' '); var cjk = (t.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length, lat = (t.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ').match(/[^\s]+/g) || []).length; return { chars: t.length, words: cjk + lat }; }

  function mount(opt) {
    var host = opt.host || {}, spec0 = C.validate(opt.spec || {}).spec, fmt = spec0.format === 'txt' ? 'txt' : 'md', kind = fmt === 'txt' ? 'edit-text' : 'edit-markdown';
    var W = { validate: C.validate, applyEdits: C.applyEdits, editWords: C.editWords, list: C.list, find: C.find };
    if (!document.getElementById('few-text-css')) { var st = document.createElement('style'); st.id = 'few-text-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
    return Shell.mount({
      id: opt.id, kind: kind, title: fmt === 'txt' ? '📄 純文字編輯器' : '📝 Markdown 編輯器', W: W, spec: opt.spec, state: opt.state, host: host, container: opt.container, restoring: opt.restoring, windowApi: opt.windowApi,
      tabs: [{ id: 'doc', label: fmt === 'txt' ? '📄 文件' : '👁 預覽' }, { id: 'source', label: '🧩 原始碼' }],
      placeholder: fmt === 'txt' ? '用說的改：「把 abc 全部換成 xyz」「刪掉第 3 行」「在最後加一行：結尾」「把全文整理得簡潔一點」' : '用說的改：「把第 2 段改成…」「在最後加一段：…」「把最後一個改成編號清單」「把「舊」全部換成「新」」「幫我寫一個安裝章節」；雙擊任何區塊可以直接改。',
      intro: fmt === 'txt'
        ? '我是純文字編輯器：檔案的每一行是一個區塊，沒動到的行會原封不動（換行、空白、結尾換行都保留）。你可以直接改，也可以用說的：換字、加一行、刪一行、移動、整理全文。每一步都能復原。'
        : '我是 Markdown 編輯器：文件分成一個個區塊（標題、段落、清單、表格、程式碼…），沒動到的區塊會原封不動，不會把你的檔案重新排版。單擊選取、雙擊就地改，也可以對我說：「把第 2 段改成…」「在最後加一段…」「把這段整理成清單」「寫一個安裝章節」。AI 做的每一步都是封閉的動作，可以隨時復原。',
      objectIcon: function (o) { return ICON[o.type] || '◻'; },
      objectInfo: function (o) { return o.type === 'heading' ? 'H' + o.level : o.type === 'list' ? (o.ordered ? '編號 ' : '項目 ') + o.items.length : o.type === 'table' ? o.rows.length + '×' + o.rows[0].length : o.type === 'code' ? (o.lang || '程式碼') : fmt === 'txt' ? '' : o.type; },
      treeRows: function (sp) { var d = 0, rows = []; sp.objects.forEach(function (b) { if (b.type === 'heading') { d = Math.min(5, b.level - 1); rows.push({ obj: b, depth: d }); d = Math.min(5, b.level); } else { rows.push({ obj: b, depth: fmt === 'txt' ? 0 : d }); } }); return rows; },
      parseCommands: C.parseCommands,
      promptOf: function (sp, steps) { var L = ['請寫一份' + (fmt === 'txt' ? '純文字' : ' Markdown ') + '文件「' + sp.title + '」，共 ' + sp.objects.length + ' 個區塊。']; var ol = C.outline(sp); if (ol) { L.push('', '大綱：', ol); } var texts = steps.filter(function (s) { return s.text; }); if (texts.length) { L.push('', '（有效的指示，依序）：'); texts.forEach(function (s, i) { L.push((i + 1) + '. ' + s.text + (s.summary ? ' → ' + s.summary : '')); }); } return L.join('\n'); },
      exports: fmt === 'txt' ? [{ id: 'txt', label: '純文字檔 (.txt)', chat: false }, { id: 'json', label: '專案（JSON）', chat: false }] : [{ id: 'md', label: 'Markdown 檔 (.md)' }, { id: 'html', label: 'HTML 網頁' }, { id: 'txt', label: '純文字', chat: false }, { id: 'json', label: '專案（JSON）', chat: false }],
      runExport: async function (id, spec) {
        var name = slug(spec.title);
        if (id === 'json') { return { blob: new Blob([JSON.stringify(spec, null, 1)], { type: 'application/json' }), name: name + '.json', mime: 'application/json' }; }
        if (id === 'html') { return { blob: new Blob([C.toHtml(spec)], { type: 'text/html' }), name: name + '.html', mime: 'text/html' }; }
        if (id === 'md' || id === 'txt') { var out = C.serialize(visibleOnly(spec)); return { blob: new Blob([out], { type: id === 'md' ? 'text/markdown' : 'text/plain' }), name: name + '.' + id, mime: id === 'md' ? 'text/markdown' : 'text/plain' }; }
        return null;
      },
      build: function (ctx) {
        var spec = null, sel = null, editing = null, docEl = h('div', 'tdoc'), wrap = h('div'), srcWrap = h('div'), fnd = h('input'), rep = h('input'), fstat = h('span', 'st');
        wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;margin:-8px'; srcWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1';
        // ───── 找／取代（取代是一個動作，可復原；選了區塊就只動那個區塊） ─────
        var fbar = h('div', 'tfind'), bRep = h('button', null, '全部取代'), bFind = h('button', null, '找下一個'); fnd.placeholder = '尋找'; rep.placeholder = '取代成'; [fnd, rep, bFind, bRep, fstat].forEach(function (x) { fbar.appendChild(x); });
        function matches() { var q = fnd.value; if (!q || !spec) { return []; } var low = q.toLowerCase(); return spec.objects.filter(function (b) { return (b.text || (b.items || []).join('\n') || (b.rows || []).join('\n') || '').toLowerCase().indexOf(low) >= 0; }); }
        var fi = -1; fnd.oninput = function () { var m = matches(); fstat.textContent = fnd.value ? m.length + ' 個區塊有' : ''; fi = -1; };
        bFind.onclick = function () { var m = matches(); if (!m.length) { fstat.textContent = '找不到'; return; } fi = (fi + 1) % m.length; ctx.select(m[fi].id); fstat.textContent = (fi + 1) + '／' + m.length; var el = docEl.querySelector('[data-id="' + m[fi].id + '"]'); if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); } };
        fnd.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); bFind.onclick(); } };
        bRep.onclick = function () { if (!fnd.value) { return; } var r = ctx.apply([{ op: 'replace_all', find: fnd.value, repl: rep.value, scope: sel || undefined }], '取代「' + fnd.value.slice(0, 12) + '」→「' + rep.value.slice(0, 12) + '」' + (sel ? '（選取的區塊）' : ''), '', 'panel'); fstat.textContent = r.applied && r.applied.length ? '已取代' : (r.rejected && r.rejected[0] ? r.rejected[0].error : '沒有取代'); };
        wrap.appendChild(fbar); wrap.appendChild(docEl);
        // ───── 預覽：一個區塊一塊 ─────
        function draw() {
          if (!spec) { return; } var keepScroll = docEl.scrollTop; docEl.textContent = ''; editing = null;
          if (!spec.objects.length) { var em = h('div', 'st', '（空的文件：對 AI 說要寫什麼，或按上面的「＋ 區塊」）'); em.style.padding = '12px'; docEl.appendChild(em); }
          spec.objects.forEach(function (b) {
            var w = h('div', 'blk' + (b.id === sel ? ' sel' : '') + (b.visible === false ? ' hid' : '') + (b.locked ? ' lk' : '')); w.setAttribute('data-id', b.id); w.innerHTML = C.blockHtml(b);
            w.onclick = function (ev) { if (editing) { return; } if (ev.target && ev.target.closest && ev.target.closest('a')) { ev.preventDefault(); } ctx.select(b.id === sel ? null : b.id); };
            w.ondblclick = function (ev) { ev.preventDefault(); ctx.select(b.id); edit(b.id); };
            docEl.appendChild(w);
          });
          docEl.scrollTop = keepScroll;
        }
        // 雙擊：用文件原本的語法就地改，Ctrl+Enter 或離開輸入框就套用，Esc 取消
        // 輸入框的換行一律是 LF；存回去時 replace_block 會換成文件自己的換行
        function edit(id) {
          var i = C.find(spec, id); if (i < 0) { return; } var b = spec.objects[i]; if (b.locked) { ctx.say('「' + b.name + '」鎖住了'); return; } var w = docEl.querySelector('[data-id="' + id + '"]'); if (!w) { return; }
          var ta = h('textarea', 'ed'), raw = rawOf(b, fmt).replace(/\r\n/g, '\n'); ta.value = raw; ta.rows = Math.max(2, Math.min(18, raw.split('\n').length + 1)); ta.spellcheck = false; w.textContent = ''; w.appendChild(ta); editing = id; ta.focus();
          var done = false; function finish(ok) { if (done) { return; } done = true; editing = null; var v = ta.value; if (ok && v !== raw) { var r = ctx.apply([{ op: 'replace_block', id: id, text: v }], '改寫 ' + b.name, '', 'panel'); if (r && r.rejected && r.rejected.length) { ctx.say(r.rejected[0].error); } if (!(r && r.applied && r.applied.length)) { draw(); } } else { draw(); } }
          ta.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { finish(false); } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true); } };
          ta.onblur = function () { finish(true); }; ta.onclick = function (ev) { ev.stopPropagation(); };
        }
        // ───── 新增區塊／開啟檔案 ─────
        var addSel = h('select'), NEW = fmt === 'txt' ? [['line', '一行']] : [['para', '段落'], ['heading', '標題'], ['list', '清單'], ['olist', '編號清單'], ['quote', '引用'], ['code', '程式碼'], ['table', '表格'], ['hr', '分隔線']];
        var a0 = h('option', null, '＋ 區塊'); a0.value = ''; addSel.appendChild(a0); NEW.forEach(function (x) { var o = h('option', null, x[1]); o.value = x[0]; addSel.appendChild(o); });
        addSel.title = '在選取的區塊後面（沒選就在最後）加一個新區塊，並直接開始打字';
        addSel.onchange = function () {
          var t = addSel.value; addSel.value = ''; if (!t) { return; } var blk = t === 'olist' ? { type: 'list', ordered: true, items: [''] } : t === 'heading' ? { type: 'heading', level: 2, text: '標題' } : t === 'table' ? { type: 'table', rows: [['欄位 1', '欄位 2'], ['', '']] } : t === 'code' ? { type: 'code', text: '', lang: '' } : { type: t, text: t === 'para' ? '新的段落' : t === 'quote' ? '引用' : '', items: t === 'list' ? [''] : undefined };
          var r = ctx.apply([{ op: 'add_block', after: sel || 'end', block: blk }], '新增' + (NEW.filter(function (x) { return x[0] === t; })[0] || [0, t])[1], '', 'panel'); if (r.added && r.added.length && t !== 'hr') { setTimeout(function () { edit(r.added[r.added.length - 1]); }, 30); }
        };
        var openIn = h('input'); openIn.type = 'file'; openIn.accept = '.md,.markdown,.txt,.log,.text,.csv,.tsv,.json,.yaml,.yml,.ini,.conf,.cfg,text/*'; openIn.style.display = 'none';
        var bOpen = h('button', null, '📂 開啟檔案'); bOpen.title = '把本機的 ' + (fmt === 'txt' ? '文字' : 'Markdown／文字') + '檔讀進來（取代目前的內容，可復原）'; bOpen.onclick = function () { openIn.click(); };
        function decode(buf) { var u = new Uint8Array(buf); try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { try { return new TextDecoder('big5').decode(u); } catch (e2) { return new TextDecoder('utf-8').decode(u); } } }
        openIn.onchange = function () { var f = openIn.files && openIn.files[0]; openIn.value = ''; if (!f) { return; } if (f.size > 4000000) { ctx.say('檔案太大（超過 4 MB）'); return; } f.arrayBuffer().then(function (buf) { var text = decode(buf), ns = C.parse(text, fmt); ns.title = f.name.replace(/\.[^.]+$/, '').slice(0, 80) || spec.title; ctx.commit(ns, '開啟檔案 ' + f.name + '（' + ns.objects.length + ' 個區塊）', '', 'panel'); ctx.say('已開啟 ' + f.name); }, function () { ctx.say('讀不了這個檔案'); }); };
        ctx.bar.appendChild(addSel); ctx.bar.appendChild(bOpen); ctx.bar.appendChild(openIn);
        // ───── 屬性：選到的區塊（沒選＝文件） ─────
        function props() {
          var box = h('div'), o = sel ? spec.objects.filter(function (x) { return x.id === sel; })[0] : null; box.style.cssText = 'display:flex;flex-direction:column;gap:6px';
          function lab(t, el) { var l = h('label'); l.appendChild(document.createTextNode(t)); l.appendChild(el); return l; }
          function btn(t, fn, title) { var b = h('button', null, t); if (title) { b.title = title; } b.onclick = fn; return b; }
          if (!o) {
            var wc = words(spec), ti = h('input'); ti.type = 'text'; ti.value = spec.title; ti.onchange = function () { if (ti.value.trim()) { ctx.apply([{ op: 'set_title', text: ti.value }], '標題改成「' + ti.value.trim().slice(0, 20) + '」', '', 'panel'); } };
            box.appendChild(h('div', 'st', '文件：' + spec.objects.length + ' 個區塊・' + wc.chars + ' 字元・約 ' + wc.words + ' 字／詞')); box.appendChild(lab('名稱', ti));
            var es = h('select'); [['\n', '換行：LF（Unix）'], ['\r\n', '換行：CRLF（Windows）']].forEach(function (x) { var op = h('option', null, x[1]); op.value = x[0]; es.appendChild(op); }); es.value = spec.eol === '\r\n' ? '\r\n' : '\n'; es.onchange = function () { ctx.apply([{ op: 'set_doc', eol: es.value }], '換行改成 ' + (es.value === '\r\n' ? 'CRLF' : 'LF'), '', 'panel'); }; box.appendChild(es);
            var bom = h('input'); bom.type = 'checkbox'; bom.checked = !!spec.bom; bom.onchange = function () { ctx.apply([{ op: 'set_doc', bom: bom.checked }], 'BOM ' + (bom.checked ? '加上' : '拿掉'), '', 'panel'); }; box.appendChild(lab('UTF-8 BOM', bom));
            box.appendChild(h('div', 'st', '沒有動到的區塊，輸出時一個位元組都不會變。')); return box;
          }
          box.appendChild(h('div', 'st', o.name + '（' + o.type + '，' + o.id + '）'));
          box.appendChild(btn('✏️ 編輯內容（雙擊也行）', function () { edit(o.id); }));
          if (fmt !== 'txt') {
            var cv = h('select'), CV = [['', '轉成…'], ['para', '段落'], ['h1', '標題 H1'], ['h2', '標題 H2'], ['h3', '標題 H3'], ['h4', '標題 H4'], ['quote', '引用'], ['code', '程式碼'], ['list', '清單'], ['olist', '編號清單'], ['raw', '原樣保留']]; CV.forEach(function (x) { var op = h('option', null, x[1]); op.value = x[0]; cv.appendChild(op); });
            cv.onchange = function () { var v = cv.value; cv.value = ''; if (!v) { return; } var e = /^h(\d)$/.test(v) ? (o.type === 'heading' ? { op: 'set_heading', id: o.id, level: Number(v[1]) } : { op: 'convert_block', id: o.id, to: 'heading', level: Number(v[1]) }) : { op: 'convert_block', id: o.id, to: v }; var r = ctx.apply([e], '轉成 ' + (CV.filter(function (x) { return x[0] === v; })[0] || [0, v])[1], '', 'panel'); if (r.rejected && r.rejected[0]) { ctx.say(r.rejected[0].error); } };
            box.appendChild(cv);
          }
          if (o.type === 'code') { var lg = h('input'); lg.type = 'text'; lg.value = o.lang || ''; lg.onchange = function () { ctx.apply([{ op: 'update_block', id: o.id, props: { lang: lg.value } }], '程式碼語言：' + (lg.value || '（無）'), '', 'panel'); }; box.appendChild(lab('語言', lg)); }
          if (o.type === 'list') { var od = h('input'); od.type = 'checkbox'; od.checked = !!o.ordered; od.onchange = function () { ctx.apply([{ op: 'list_toggle', id: o.id, ordered: od.checked }], od.checked ? '改成編號清單' : '改成項目符號清單', '', 'panel'); }; box.appendChild(lab('編號', od)); }
          if (o.type === 'table') {
            var tb = h('div', 'row'); function tset(rows, words2) { ctx.apply([{ op: 'update_block', id: o.id, props: { rows: rows } }], words2, '', 'panel'); }
            tb.appendChild(btn('＋列', function () { tset(o.rows.concat([o.rows[0].map(function () { return ''; })]), '表格加一列'); })); tb.appendChild(btn('＋欄', function () { tset(o.rows.map(function (r) { return r.concat(['']); }), '表格加一欄'); }));
            tb.appendChild(btn('－列', function () { if (o.rows.length > 1) { tset(o.rows.slice(0, -1), '表格少一列'); } })); tb.appendChild(btn('－欄', function () { if (o.rows[0].length > 1) { tset(o.rows.map(function (r) { return r.slice(0, -1); }), '表格少一欄'); } })); box.appendChild(tb);
          }
          if (fmt !== 'txt') { var gp = h('input'); gp.type = 'number'; gp.min = 0; gp.max = 5; gp.value = Math.max(0, o.gap); gp.title = '這個區塊後面的空白行數（最後一個區塊：結尾換行數）'; gp.onchange = function () { ctx.apply([{ op: 'update_block', id: o.id, props: { gap: Math.max(0, Math.min(5, Number(gp.value) || 0)) } }], o.name + ' 後面的空白行 ' + gp.value, '', 'panel'); }; if (C.find(spec, o.id) < spec.objects.length - 1) { box.appendChild(lab('後面空白行', gp)); } }
          return box;
        }
        // ───── 原始碼：整份文字；套用時沒變的區塊沿用 id ─────
        var srcTa = h('textarea', 'code'); srcTa.rows = 18; srcTa.spellcheck = false; srcTa.style.flex = '1'; srcTa.style.whiteSpace = 'pre'; var srcRow = h('div', 'row'), bApply = h('button', 'pri', '▶ 套用原始碼'), bRe = h('button', null, '↻ 重新產生'), srcSt = h('span', 'st'); [bApply, bRe, srcSt].forEach(function (x) { srcRow.appendChild(x); });
        srcWrap.appendChild(h('div', 'st', '整份文件的原始文字（含隱藏的區塊）。改完按「套用原始碼」：沒改到的區塊保持原樣、沿用原本的 id。')); srcWrap.appendChild(srcTa); srcWrap.appendChild(srcRow);
        function srcText() { return C.serialize(spec); }
        function eolOf(t) { return String(t).replace(/\r\n|\n/g, spec.eol === '\r\n' ? '\r\n' : '\n'); }   // 輸入框給的是 LF，換回文件自己的換行再比對／解析
        function refreshSource() { if (document.activeElement !== srcTa) { srcTa.value = srcText(); } }
        bRe.onclick = function () { srcTa.value = srcText(); srcSt.textContent = ''; };
        bApply.onclick = function () { var t = eolOf(srcTa.value); if (t === srcText()) { srcSt.className = 'st'; srcSt.textContent = '沒有改動'; return; } var ns = C.reparse(spec, t); ctx.commit(ns, '改寫原始碼（' + ns.objects.length + ' 個區塊）', '', 'panel'); srcSt.className = 'st'; srcSt.textContent = '已套用'; };
        return {
          tabs: { doc: wrap, source: srcWrap },
          env: function () { return {}; },
          refresh: function (s, selId) { spec = s; sel = selId; if (!editing) { draw(); } ctx.setProps(props()); refreshSource(); var el = selId ? docEl.querySelector('[data-id="' + selId + '"]') : null; if (el && el.scrollIntoView && !editing) { el.scrollIntoView({ block: 'nearest' }); } },
          showTab: function (t) { if (t === 'source') { srcTa.value = srcText(); } else { draw(); } },
          destroy: function () { /* 沒有要收的資源 */ }
        };
      }
    });
  }
  return { mount: mount, visibleOnly: visibleOnly };
});
