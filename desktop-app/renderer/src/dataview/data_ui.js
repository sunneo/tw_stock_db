/* 資料檢視器的畫面（DOM）：JSON／YAML／TOML／CSV。Source／Viewer 切換、行號＋上色、搜尋、Export 選單、Ask AI 面板。
 * 只依賴 FaDataCore 與 host：
 *   host.deps()                      -> Promise<{yamlLoad, yamlDump, yamlLoadAll, JSZip}>（需要時才載入）
 *   host.download(data, name, mime)  -> 下載（data 是字串／Uint8Array／Blob）
 *   host.askAI(question, ctx)        -> Promise<{text, sheet?:{columns,rows}}>（ctx：fmt、name、outline、getData()、getText()）
 *   host.palette()                   -> {dark, windowBg, windowBorder, detailBg, detailText, inputBg, inputText, inputBorder, ...}（選填）
 *   host.renderAnswer(text)          -> 已消毒的 HTML 字串（選填，沒有就用純文字）
 *   host.exportSqlite(sheets)        -> Promise<Uint8Array>（選填；有才會出現 SQLite3 匯出）
 * 設計見 DESIGN.data-viewers.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./data_core.js'));
    else root.FaDataView = factory(root.FaDataCore || (typeof FaDataCore !== 'undefined' ? FaDataCore : undefined));
})(typeof self !== 'undefined' ? self : this, function (C) {
    'use strict';
    const LH = 19, TH = 22, GUTTER = 56;
    const CSS = `.fdv{--bg:#0d1117;--fg:#e6edf3;--bd:#30363d;--hd:#161b22;--mut:#8b949e;--acc:#2f81f7;--k:#79c0ff;--s:#7ee787;--n:#ffa657;--b:#ff7b72;--z:#8b949e;--p:#8b949e;--c:#8b949e;--h:#d2a8ff;--d:#ffa657;--a:#d2a8ff;--hit:#bb800966;--cur:#f2cc6099;margin:6px 0;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);font:12.5px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;max-width:100%;position:relative}
.fdv.light{--bg:#fff;--fg:#1f2328;--bd:#d0d7de;--hd:#f6f8fa;--mut:#59636e;--acc:#0969da;--k:#0550ae;--s:#116329;--n:#953800;--b:#cf222e;--z:#6e7781;--p:#6e7781;--c:#6e7781;--h:#8250df;--d:#953800;--a:#8250df;--hit:#fff8c5;--cur:#ffd33d99}
.fdv *{box-sizing:border-box}.fdv button{background:var(--hd);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:2px 9px;cursor:pointer;font:12px system-ui,sans-serif}.fdv button:hover{border-color:var(--acc)}.fdv button.on{background:var(--acc);border-color:var(--acc);color:#fff}.fdv button:disabled{opacity:.45;cursor:not-allowed}
.fdv .bar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--hd);border-bottom:1px solid var(--bd);flex-wrap:wrap}.fdv .ttl{font:600 12px system-ui,sans-serif;color:var(--mut);margin-right:2px;white-space:nowrap}.fdv .sp{flex:1}
.fdv input.q{background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:2px 7px;font:12px system-ui,sans-serif;width:150px;min-width:90px}.fdv .cnt{font:11px system-ui,sans-serif;color:var(--mut);min-width:42px}
.fdv .seg{display:inline-flex}.fdv .seg button:first-child{border-radius:5px 0 0 5px}.fdv .seg button:last-child{border-radius:0 5px 5px 0;margin-left:-1px}
.fdv .sc{position:relative;height:var(--fh,340px);min-height:60px;max-height:80vh;overflow:hidden;resize:vertical;outline:none}.fdv .sc.act{overflow:auto}.fdv .sc .hint{position:absolute;right:8px;bottom:6px;font:11px system-ui,sans-serif;background:var(--hd);border:1px solid var(--bd);border-radius:10px;padding:1px 8px;color:var(--mut);pointer-events:none;opacity:0;transition:opacity .15s;z-index:3}.fdv .sc:not(.act):hover .hint{opacity:.95}
.fdv .win{position:absolute;left:0;right:0;top:0}.fdv .row{position:absolute;left:0;white-space:pre;display:flex}.fdv .ln{position:sticky;left:0;width:${GUTTER}px;flex:none;text-align:right;padding-right:10px;color:var(--mut);background:var(--bg);user-select:none;border-right:1px solid var(--bd);z-index:1}.fdv .row.err{background:#f8514926}.fdv .code{padding-left:10px}
.fdv .t-k{color:var(--k)}.fdv .t-s{color:var(--s)}.fdv .t-n{color:var(--n)}.fdv .t-b{color:var(--b)}.fdv .t-z{color:var(--z);font-style:italic}.fdv .t-p{color:var(--p)}.fdv .t-c{color:var(--c);font-style:italic}.fdv .t-h{color:var(--h);font-weight:600}.fdv .t-d{color:var(--d)}.fdv .t-a{color:var(--a)}
.fdv mark{background:var(--hit);color:inherit;border-radius:2px}.fdv mark.cur{background:var(--cur);outline:1px solid var(--acc)}
.fdv .trow{position:absolute;left:0;right:0;display:flex;align-items:center;white-space:nowrap;cursor:default;padding-right:8px}.fdv .trow:hover{background:var(--hd)}.fdv .trow.sel{background:var(--hit)}.fdv .arr{width:16px;flex:none;text-align:center;color:var(--mut);cursor:pointer;user-select:none}.fdv .cn{color:var(--mut);font-size:11px;margin-left:6px}
.fdv .grid{position:absolute;left:0;display:flex;white-space:nowrap}.fdv .grid.hd{position:sticky;top:0;background:var(--hd);font-weight:600;z-index:2;border-bottom:1px solid var(--bd)}.fdv .cell{flex:none;width:170px;padding:0 8px;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--bd)}.fdv .cell.rn{width:${GUTTER}px;text-align:right;color:var(--mut)}.fdv .cell.num{text-align:right;color:var(--n)}.fdv .grid.hd .cell{cursor:pointer}
.fdv .foot{display:flex;gap:8px;align-items:center;padding:3px 8px;border-top:1px solid var(--bd);background:var(--hd);font:11px system-ui,sans-serif;color:var(--mut);min-height:24px}.fdv .foot .path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}
.fdv .errbar{padding:4px 10px;background:#f8514926;color:var(--b);font:12px system-ui,sans-serif;border-bottom:1px solid var(--bd)}
.fdv .menu{position:absolute;z-index:9;right:8px;top:34px;background:var(--hd);border:1px solid var(--bd);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);min-width:190px;padding:3px 0;font:12px system-ui,sans-serif;max-height:300px;overflow:auto}.fdv .menu div{padding:5px 14px;cursor:pointer;white-space:nowrap}.fdv .menu div:hover{background:var(--acc);color:#fff}.fdv .menu hr{border:0;border-top:1px solid var(--bd);margin:3px 0}.fdv .menu .lbl{cursor:default;color:var(--mut);font-size:11px}.fdv .menu .lbl:hover{background:none;color:var(--mut)}
.fdv .ai{border-top:1px solid var(--bd);background:var(--hd);font:12px system-ui,sans-serif}.fdv .ai .ah{display:flex;gap:6px;align-items:center;padding:5px 8px}.fdv .ai .ah b{flex:1}.fdv .ai .list{max-height:300px;overflow:auto;padding:0 8px}.fdv .card{border:1px solid var(--bd);border-radius:6px;margin:5px 0;background:var(--bg)}.fdv .card .ch{display:flex;gap:6px;align-items:center;padding:4px 8px;cursor:pointer}.fdv .card .ch span.q{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fdv .card .cb{padding:4px 10px 8px;border-top:1px solid var(--bd);white-space:pre-wrap;word-break:break-word;font-family:system-ui,sans-serif;line-height:1.5}.fdv .card .cb table{border-collapse:collapse;font-size:11.5px;margin:4px 0}.fdv .card .cb td,.fdv .card .cb th{border:1px solid var(--bd);padding:1px 6px}.fdv .card .x{border:0;background:none;padding:0 4px;color:var(--mut)}.fdv .ai .qin{display:flex;gap:6px;padding:6px 8px}.fdv .ai .qin input{flex:1;background:var(--bg);color:inherit;border:1px solid var(--bd);border-radius:5px;padding:4px 8px;font:12px system-ui,sans-serif}.fdv .card.run .q::after{content:" …";opacity:.6}`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const kid of kids) if (kid) e.append(kid); return e; };
    const FMT_LABEL = { json: 'JSON', yaml: 'YAML', toml: 'TOML', csv: 'CSV', tsv: 'TSV' };
    const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
    const jsPath = (p) => '$' + p.split('/').slice(1).map((s) => { s = s.replace(/~1/g, '/').replace(/~0/g, '~'); return /^\d+$/.test(s) ? '[' + s + ']' : (/^[A-Za-z_]\w*$/.test(s) ? '.' + s : '["' + s + '"]'); }).join('');

    // 嵌在對話裡的檢視器：預設不吃滾輪（滾輪屬於對話），點一下才在檢視器內捲動；點到外面就放開。之後設計的檢視器直接用這個。
    function focusWheel(rootEl, scroller) {
        const hint = h('div', { class: 'hint', text: '點一下啟用滾輪' }); scroller.append(hint); scroller.tabIndex = 0;
        const on = () => scroller.classList.add('act'), off = () => scroller.classList.remove('act');
        scroller.addEventListener('mousedown', on); scroller.addEventListener('focus', on);
        scroller.addEventListener('keydown', (e) => { if (e.key === 'Escape') { off(); scroller.blur(); } });
        rootEl.addEventListener('focusout', (e) => { if (!rootEl.contains(e.relatedTarget)) off(); });
        document.addEventListener('mousedown', (e) => { if (!rootEl.contains(e.target)) off(); }, true);
        return { activate: on, deactivate: off };
    }

    function mount(opts) {
        const host = opts.host || {}; const text0 = String(opts.text == null ? '' : opts.text);
        const fmt = C.detectFormat(text0, opts.fmt);
        if (!document.getElementById('fdv-css')) document.head.appendChild(h('style', { id: 'fdv-css', text: CSS }));
        const pal = (host.palette && host.palette()) || {};
        const st = { fmt, mode: 'source', q: '', hits: [], hi: -1, expanded: null, sel: null, data: undefined, parsed: null, tables: null, tableSel: null, ai: [], aiOpen: false, sort: null, extraSheets: [] };
        const pre = C.prettyIfMinified(text0, fmt); const text = pre.text; const lines = text.split('\n').map((l) => l.replace(/\r$/, '')); if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const isTable = fmt === 'csv' || fmt === 'tsv';
        let tok = null; const getTokAll = () => tok || (tok = (lines.length <= 40000 ? C.highlight(lines.join('\n'), fmt) : C.highlight(lines.slice(0, 40000).join('\n'), fmt).concat(lines.slice(40000).map((l) => [{ c: 'x', t: l }]))));
        const rootEl = h('div', { class: 'fdv' + (pal.dark === false ? ' light' : '') });
        const title = h('span', { class: 'ttl', text: FMT_LABEL[fmt] + ' · ' + lines.length.toLocaleString() + ' 行 · ' + fmtSize(text0.length) + (pre.pretty ? ' · 已排版' : '') });
        const bSrc = h('button', { text: 'Source', class: 'on' }), bView = h('button', { text: 'Viewer' });
        const qin = h('input', { class: 'q', placeholder: '🔎 搜尋…', type: 'text' }); const cnt = h('span', { class: 'cnt' });
        const bPrev = h('button', { text: '◂', title: '上一個 (Shift+Enter)' }), bNext = h('button', { text: '▸', title: '下一個 (Enter)' });
        const bExp = h('button', { text: 'Export ▾', title: '匯出成別的格式' }), bAi = h('button', { text: '🤖 Ask AI', title: '用一句話問你想要什麼資料' });
        const bar = h('div', { class: 'bar' }, title, h('span', { class: 'seg' }, bSrc, bView), qin, bPrev, bNext, cnt, h('span', { class: 'sp' }), bExp, bAi);
        const errbar = h('div', { class: 'errbar' }); errbar.style.display = 'none';
        const sc = h('div', { class: 'sc' }); const winEl = h('div', { class: 'win' }); sc.append(winEl);
        const foot = h('div', { class: 'foot' }); const pathEl = h('span', { class: 'path' }); const bCopy = h('button', { text: '複製路徑' }); bCopy.style.display = 'none'; foot.append(pathEl, bCopy);
        const menu = h('div', { class: 'menu' }); menu.style.display = 'none';
        const aiPanel = h('div', { class: 'ai' }); aiPanel.style.display = 'none';
        rootEl.append(bar, errbar, sc, foot, aiPanel, menu);
        const small = lines.length <= 14; if (small) sc.style.setProperty('--fh', Math.max(60, lines.length * LH + 12) + 'px');
        focusWheel(rootEl, sc);

        // ---- 解析（Viewer、Export、Ask AI 才需要）
        let depsP = null; const deps = () => depsP || (depsP = Promise.resolve(host.deps ? host.deps() : {}).catch(() => ({})));
        async function ensureParsed() {
            if (st.parsed) return st.parsed;
            const d = fmt === 'yaml' ? await deps() : {}; st.parsed = C.parse(text0, fmt, d);
            if (st.parsed.ok) { st.data = st.parsed.data; if (!isTable) st.expanded = C.defaultExpanded(st.data, lines.length > 5000 ? 1 : 2, 3000); }
            else { errbar.style.display = ''; errbar.textContent = '⚠ ' + (st.parsed.error.line ? '第 ' + st.parsed.error.line + ' 行' + (st.parsed.error.col ? ' 第 ' + st.parsed.error.col + ' 欄' : '') + '：' : '') + st.parsed.error.message + '（仍可看 Source、搜尋；Viewer、Export 需要先修正格式）'; }
            return st.parsed;
        }
        ensureParsed().then(() => { if (st.parsed && !st.parsed.ok) { bView.disabled = true; bView.title = st.parsed.error.message; } render(); }).catch(() => {});

        // ---- 繪製（虛擬捲動：只畫看得到的列）
        function tokHtml(toks, ln) {
            const q = st.q.toLowerCase(); let out = ''; let col = 0; const cur = st.hits[st.hi];
            for (const t of toks) {
                const cls = 't-' + t.c; let s = t.t;
                if (q && s.toLowerCase().includes(q)) {
                    const low = s.toLowerCase(); let p = 0, i; let seg = '';
                    while ((i = low.indexOf(q, p)) >= 0) { const isCur = cur && cur.line === ln && cur.col === col + i; seg += esc(s.slice(p, i)) + '<mark' + (isCur ? ' class="cur"' : '') + '>' + esc(s.slice(i, i + q.length)) + '</mark>'; p = i + q.length; }
                    seg += esc(s.slice(p)); out += '<span class="' + cls + '">' + seg + '</span>';
                } else out += '<span class="' + cls + '">' + esc(s) + '</span>';
                col += t.t.length;
            }
            return out;
        }
        let treeRows = [], gridRows = null;
        function viewH() { return sc.clientHeight || 340; }
        function render() {
            const top = sc.scrollTop, vh = viewH();
            if (st.mode === 'source') {
                const all = getTokAll(); const total = lines.length; winEl.style.height = total * LH + 'px';
                const a = Math.max(0, Math.floor(top / LH) - 5), b = Math.min(total, Math.ceil((top + vh) / LH) + 5); let html = '';
                const errLine = st.parsed && !st.parsed.ok && st.parsed.error.line ? st.parsed.error.line - 1 : -1;
                for (let i = a; i < b; i++) html += '<div class="row' + (i === errLine ? ' err' : '') + '" style="top:' + i * LH + 'px;height:' + LH + 'px"><span class="ln">' + (i + 1) + '</span><span class="code">' + tokHtml(all[i] || [], i) + '</span></div>';
                winEl.innerHTML = html;
                const maxLen = lines.reduce((m, l) => (l.length > m ? l.length : m), 0); winEl.style.minWidth = 'calc(' + Math.min(maxLen, 4000) + 'ch + ' + (GUTTER + 30) + 'px)';
            } else if (isTable) renderGrid(top, vh);
            else {
                if (!st.data && st.data !== null) { winEl.innerHTML = '<div style="padding:10px;color:var(--mut)">解析中…</div>'; return; }
                treeRows = C.visibleRows(st.data, st.expanded, {}); winEl.style.height = treeRows.length * TH + 'px'; winEl.style.minWidth = '';
                const a = Math.max(0, Math.floor(top / TH) - 5), b = Math.min(treeRows.length, Math.ceil((top + vh) / TH) + 5); let html = ''; const q = st.q.toLowerCase();
                for (let i = a; i < b; i++) {
                    const r = treeRows[i]; const arrow = r.container ? (r.open ? '▾' : '▸') : '';
                    const keyHtml = r.depth === 0 ? '<span class="t-p">root</span>' : '<span class="t-k">' + hl(r.key, q) + '</span>';
                    let val; if (r.container) val = '<span class="cn">' + (r.type === 'array' ? '[' + r.count + ']' : '{' + r.count + '}') + '</span>';
                    else { const cls = r.type === 'string' ? 't-s' : r.type === 'number' ? 't-n' : r.type === 'boolean' ? 't-b' : 't-z'; val = '<span class="t-p">: </span><span class="' + cls + '">' + hl(r.preview, q) + '</span>'; }
                    html += '<div class="trow' + (st.sel === r.path ? ' sel' : '') + '" data-i="' + i + '" style="top:' + i * TH + 'px;height:' + TH + 'px;padding-left:' + (8 + r.depth * 16) + 'px"><span class="arr" data-t="1">' + arrow + '</span>' + keyHtml + val + '</div>';
                }
                winEl.innerHTML = html;
            }
        }
        const hl = (s, q) => { s = String(s); if (!q) return esc(s); const low = s.toLowerCase(); let p = 0, i, out = ''; while ((i = low.indexOf(q, p)) >= 0) { out += esc(s.slice(p, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>'; p = i + q.length; } return out + esc(s.slice(p)); };
        function activeSheet() { if (!isTable) return null; return st.tableSel === null ? null : null; }
        function tableData() { if (!st.parsed || !st.parsed.ok) return { columns: [], rows: [] }; const t = st.parsed.data; return { columns: t.columns, rows: t.rows }; }
        function gridView() {
            if (gridRows) return gridRows; const t = tableData(); let idx = t.rows.map((_, i) => i); const q = st.q.toLowerCase();
            if (q) idx = idx.filter((i) => t.rows[i].some((c) => String(c).toLowerCase().includes(q)));
            if (st.sort) { const { col, dir } = st.sort; idx.sort((x, y) => { const a = t.rows[x][col], b = t.rows[y][col]; const na = parseFloat(a), nb = parseFloat(b); const r = !isNaN(na) && !isNaN(nb) && String(na) === String(a).trim() ? na - nb : String(a == null ? '' : a).localeCompare(String(b == null ? '' : b)); return dir * r; }); }
            return (gridRows = idx);
        }
        function renderGrid(top, vh) {
            const t = tableData(); const idx = gridView(); winEl.style.height = (idx.length + 1) * LH + 'px'; winEl.style.minWidth = (GUTTER + t.columns.length * 170) + 'px';
            const a = Math.max(0, Math.floor(top / LH) - 5), b = Math.min(idx.length, Math.ceil((top + vh) / LH) + 5); const q = st.q.toLowerCase();
            let html = '<div class="grid hd" style="top:0;height:' + LH + 'px"><span class="cell rn">#</span>' + t.columns.map((c, i) => '<span class="cell" data-col="' + i + '" title="按一下排序">' + esc(c) + (st.sort && st.sort.col === i ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</span>').join('') + '</div>';
            for (let k = a; k < b; k++) { const r = t.rows[idx[k]]; html += '<div class="grid" style="top:' + (k + 1) * LH + 'px;height:' + LH + 'px"><span class="cell rn">' + (idx[k] + 1) + '</span>' + t.columns.map((_, i) => { const v = r[i] == null ? '' : r[i]; return '<span class="cell' + (v !== '' && !isNaN(+v) ? ' num' : '') + '" title="' + esc(v) + '">' + hl(v, q) + '</span>'; }).join('') + '</div>'; }
            winEl.innerHTML = html; cnt.textContent = idx.length + ' / ' + t.rows.length + ' 列';
        }
        let raf = 0; sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); });
        new ResizeObserver(() => render()).observe(sc);

        // ---- 切換模式
        function setMode(m) {
            if (m === 'viewer') { if (st.parsed && !st.parsed.ok) return; }
            st.mode = m; bSrc.classList.toggle('on', m === 'source'); bView.classList.toggle('on', m === 'viewer'); bCopy.style.display = 'none'; pathEl.textContent = '';
            gridRows = null; sc.scrollTop = 0; runSearch(true);
            ensureParsed().then(() => render());
        }
        bSrc.onclick = () => setMode('source'); bView.onclick = () => setMode('viewer');

        // ---- 搜尋
        function runSearch(keep) {
            st.q = qin.value; gridRows = null;
            if (!st.q) { st.hits = []; st.hi = -1; if (st.mode === 'viewer' && isTable) cnt.textContent = ''; else cnt.textContent = ''; render(); return; }
            if (st.mode === 'source') { st.hits = C.searchText(lines, st.q); st.hi = st.hits.length ? 0 : -1; cnt.textContent = st.hits.length ? '1/' + st.hits.length : '0'; if (st.hi >= 0) reveal(); else render(); }
            else if (isTable) { st.hits = []; render(); }
            else ensureParsed().then(() => { if (!st.parsed.ok) return; const r = C.searchTree(st.data, st.q); st.hits = r.hits; r.open.forEach((p) => st.expanded.add(p)); st.hi = r.hits.length ? 0 : -1; cnt.textContent = r.hits.length ? '1/' + r.hits.length + (r.hits.length >= 2000 ? '+' : '') : '0'; if (st.hi >= 0) reveal(); else render(); });
        }
        function reveal() {
            if (st.mode === 'source') { const hit = st.hits[st.hi]; if (!hit) return; const y = hit.line * LH; if (y < sc.scrollTop + 10 || y > sc.scrollTop + viewH() - LH * 2) sc.scrollTop = Math.max(0, y - viewH() / 3); }
            else { treeRows = C.visibleRows(st.data, st.expanded, {}); const path = st.hits[st.hi]; const i = treeRows.findIndex((r) => r.path === path); if (i >= 0) { const y = i * TH; if (y < sc.scrollTop + 10 || y > sc.scrollTop + viewH() - TH * 2) sc.scrollTop = Math.max(0, y - viewH() / 3); st.sel = path; showPath(path); } }
            render();
        }
        function step(d) { if (!st.hits.length) return; st.hi = (st.hi + d + st.hits.length) % st.hits.length; cnt.textContent = (st.hi + 1) + '/' + st.hits.length; reveal(); }
        let qt = 0; qin.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => runSearch(), 160); });
        qin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { qin.value = ''; runSearch(); } });
        bPrev.onclick = () => step(-1); bNext.onclick = () => step(1);

        // ---- 樹的互動
        function showPath(p) { pathEl.textContent = p === '' ? '$' : jsPath(p); bCopy.style.display = ''; }
        winEl.addEventListener('click', (e) => {
            const gh = e.target.closest('.grid.hd .cell[data-col]'); if (gh) { const col = +gh.dataset.col; st.sort = !st.sort || st.sort.col !== col ? { col, dir: 1 } : (st.sort.dir === 1 ? { col, dir: -1 } : null); gridRows = null; render(); return; }
            const row = e.target.closest('.trow'); if (!row) return; const r = treeRows[+row.dataset.i]; if (!r) return;
            if (r.container && (e.target.dataset.t || e.detail === 2 || true)) { if (r.open) st.expanded.delete(r.path); else st.expanded.add(r.path); }
            st.sel = r.path; showPath(r.path); render();
        });
        bCopy.onclick = () => { try { navigator.clipboard.writeText(pathEl.textContent); bCopy.textContent = '已複製'; setTimeout(() => { bCopy.textContent = '複製路徑'; }, 1200); } catch (_) { /* */ } };

        // ---- Export 選單
        const baseName = (opts.name || 'data').replace(/\.[^.]+$/, '') || 'data';
        const note = (m) => { foot.querySelector('.note') && foot.querySelector('.note').remove(); const s = h('span', { class: 'note', text: m }); foot.append(s); setTimeout(() => s.remove(), 4000); };
        async function doExport(kind, arg) {
            try {
                const p = await ensureParsed(); if (!p.ok) { note('格式有錯，先修正才能匯出'); return; } const d = await deps(); const data = p.data;
                if (kind === 'json') { host.download(isTable ? JSON.stringify(rowsToObjects(data), null, 2) : C.stringify(data, 'json'), baseName + '.json', 'application/json'); }
                else if (kind === 'yaml') { if (!d.yamlDump) { note('YAML 輸出器載入失敗'); return; } host.download(C.stringify(isTable ? rowsToObjects(data) : data, 'yaml', d), baseName + '.yaml', 'text/yaml'); }
                else if (kind === 'csv') { const sh = allSheets().find((s) => s.name === arg) || allSheets()[0]; host.download(C.sheetToCsv(sh), baseName + (allSheets().length > 1 ? '-' + sh.name : '') + '.csv', 'text/csv'); }
                else if (kind === 'xlsx') { if (!d.JSZip) { note('XLSX 工具載入失敗'); return; } const bytes = await C.buildXlsx(allSheets(), d); host.download(bytes, baseName + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
                else if (kind === 'sqlite') { const bytes = await host.exportSqlite(allSheets()); host.download(bytes, baseName + '.sqlite3', 'application/vnd.sqlite3'); }
                note('已匯出');
            } catch (e) { note('匯出失敗：' + (e && e.message || e)); }
        }
        const rowsToObjects = (t) => t.rows.map((r) => { const o = {}; t.columns.forEach((c, i) => { o[c] = r[i] === undefined ? '' : r[i]; }); return o; });
        function allSheets() {
            if (!st.tables) { const p = st.parsed; st.tables = p && p.ok ? (isTable ? { sheets: [{ name: baseName.slice(0, 31) || 'Sheet1', columns: p.data.columns, rows: p.data.rows, kind: 'rows' }] } : C.toTables(p.data, { rootName: 'data' })) : { sheets: [] }; }
            return st.tables.sheets.concat(st.extraSheets);
        }
        bExp.onclick = async (e) => {
            e.stopPropagation(); if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
            await ensureParsed(); const sheets = allSheets(); const items = [];
            items.push(['JSON', 'json']); if (!isTable) items.push(['YAML', 'yaml']);
            items.push('hr');
            if (sheets.length <= 1) items.push(['CSV', 'csv', sheets[0] && sheets[0].name]);
            else { items.push({ lbl: 'CSV（一次一張工作表）' }); for (const s of sheets) items.push(['　' + s.name + '（' + s.rows.length.toLocaleString() + ' 列）', 'csv', s.name]); }
            items.push(['XLSX' + (sheets.length > 1 ? '（' + sheets.length + ' 張工作表）' : ''), 'xlsx']); if (host.exportSqlite) items.push(['SQLite3', 'sqlite']);
            menu.innerHTML = ''; for (const it of items) { if (it === 'hr') menu.append(h('hr')); else if (it.lbl) menu.append(h('div', { class: 'lbl', text: it.lbl })); else menu.append(h('div', { text: it[0], onclick: (ev) => { ev.stopPropagation(); menu.style.display = 'none'; doExport(it[1], it[2]); } })); }
            menu.style.display = '';
        };
        document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.style.display = 'none'; });

        // ---- Ask AI
        function buildAiPanel() {
            aiPanel.innerHTML = '';
            const bClear = h('button', { text: '全部清除', onclick: () => { st.ai.length = 0; buildAiPanel(); } }), bFold = h('button', { text: st.aiFold ? '▸ 展開' : '▾ 收合', onclick: () => { st.aiFold = !st.aiFold; buildAiPanel(); } });
            aiPanel.append(h('div', { class: 'ah' }, h('b', { text: '🤖 AI 查詢（問你想要什麼資料，不用學查詢語法）' }), bClear, bFold));
            if (!st.aiFold) {
                const list = h('div', { class: 'list' });
                for (const c of st.ai) {
                    const body = h('div', { class: 'cb' }); if (c.collapsed) body.style.display = 'none';
                    if (c.status === 'run') body.textContent = '查詢中…（資料不會整份丟給模型，會用工具解析）'; else if (c.error) body.textContent = '⚠ ' + c.error;
                    else { if (host.renderAnswer) body.innerHTML = host.renderAnswer(c.text || ''); else body.textContent = c.text || ''; if (c.sheet) body.append(sheetTable(c.sheet, c)); }
                    const card = h('div', { class: 'card' + (c.status === 'run' ? ' run' : '') }, h('div', { class: 'ch', onclick: () => { c.collapsed = !c.collapsed; buildAiPanel(); } }, h('span', { text: c.collapsed ? '▸' : '▾' }), h('span', { class: 'q', text: 'Q：' + c.q }), h('button', { class: 'x', text: '✕', title: '刪除這則', onclick: (ev) => { ev.stopPropagation(); st.ai.splice(st.ai.indexOf(c), 1); buildAiPanel(); } })), body);
                    list.append(card);
                }
                const inp = h('input', { type: 'text', placeholder: '例如：哪些項目的授權是 GPL？列出名稱和版本', value: st.aiDraft || '' });
                const go = () => { const q = inp.value.trim(); if (!q) return; st.aiDraft = ''; ask(q); };
                inp.addEventListener('input', () => { st.aiDraft = inp.value; }); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
                aiPanel.append(list, h('div', { class: 'qin' }, inp, h('button', { text: '問', class: 'on', onclick: go })));
                if (!st.aiFold) setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
            }
        }
        function sheetTable(sheet, card) {
            const wrap = h('div'); const t = h('table'); const rows = sheet.rows.slice(0, 50);
            t.innerHTML = '<tr>' + sheet.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' + rows.map((r) => '<tr>' + sheet.columns.map((_, i) => '<td>' + esc(r[i] == null ? '' : r[i]) + '</td>').join('') + '</tr>').join('');
            wrap.append(t); if (sheet.rows.length > 50) wrap.append(h('div', { text: '… 共 ' + sheet.rows.length + ' 列，只顯示前 50 列', style: 'color:var(--mut)' }));
            const add = h('button', { text: '另存成工作表', onclick: () => { const name = 'AI：' + card.q.slice(0, 20); st.extraSheets.push({ name: name.slice(0, 31), columns: sheet.columns, rows: sheet.rows, kind: 'ai' }); add.textContent = '已加入（Export 可匯出）'; add.disabled = true; } });
            const dl = h('button', { text: '下載 CSV', onclick: () => host.download(C.sheetToCsv({ columns: sheet.columns, rows: sheet.rows }), baseName + '-ai.csv', 'text/csv') });
            wrap.append(h('div', { style: 'display:flex;gap:6px;margin-top:4px' }, add, dl)); return wrap;
        }
        async function ask(q) {
            const card = { q, status: 'run', collapsed: false, text: '' }; st.ai.push(card); buildAiPanel();
            try {
                await ensureParsed();
                const ctx = { fmt, name: opts.name || '', outline: st.parsed && st.parsed.ok ? (isTable ? 'columns: ' + JSON.stringify(st.parsed.data.columns) + '；rows: ' + st.parsed.data.rows.length : C.outline(st.parsed.data)) : '（格式有錯，只能當文字找）', getData: () => (st.parsed && st.parsed.ok ? st.parsed.data : null), getText: () => text0, lines: lines.length };
                const r = await host.askAI(q, ctx); card.text = (r && r.text) || ''; card.sheet = r && r.sheet || null; card.status = 'done';
            } catch (e) { card.error = (e && e.message) || String(e); card.status = 'done'; }
            buildAiPanel();
        }
        bAi.onclick = () => { st.aiOpen = !st.aiOpen; aiPanel.style.display = st.aiOpen ? '' : 'none'; bAi.classList.toggle('on', st.aiOpen); if (st.aiOpen) buildAiPanel(); };

        render();
        rootEl._fdv = { state: st, setMode, ask, render };
        return rootEl;
    }
    return { mount, focusWheel };
});
