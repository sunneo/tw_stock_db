/* sqlitebrowser 視窗（DOM）：資料庫結構／瀏覽資料／執行 SQL／Pragmas。純瀏覽器程式，不依賴宿主內部——宿主只要給 host 物件：
 *   host.openDb(ref, {readonly}) -> Promise<{db, label, readonly, commit(), close()}>
 *   host.call(op, args)          -> Promise<引擎結果>（exec／query／schema／pragma／status／cancel）
 *   host.download(name, text, mime)  host.pickFile() -> Promise<{name, bytes}|null>
 * 編輯一律先在開著的交易裡暫存（粗體標示），按 Write Changes 才 COMMIT 並寫回來源；Revert 回滾。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./browser_core.js'));
    else root.FaSqliteBrowser = factory(typeof FaSqliteBrowserCore !== 'undefined' ? FaSqliteBrowserCore : root.FaSqliteBrowserCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
    'use strict';
    const SPLIT = typeof FaSqlSplit !== 'undefined' ? FaSqlSplit : (typeof require === 'function' ? require('./sql_split.js') : null);
    const Z = 2147482550; // 高於終端機、AIDoc 檢視器等浮動視窗，低於全域對話框
    const CSS = `.fsb{position:fixed;display:flex;flex-direction:column;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);font:13px/1.4 -apple-system,"Segoe UI","Noto Sans TC",sans-serif;overflow:hidden}
.fsb *{box-sizing:border-box}.fsb button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:3px 9px;cursor:pointer;font:inherit}.fsb button:hover{background:#30363d}.fsb button:disabled{opacity:.4;cursor:default}
.fsb button.pri{background:#238636;border-color:#2ea043}.fsb button.warn{background:#9e6a03;border-color:#bb8009}.fsb button.bad{background:#b62324;border-color:#da3633}
.fsb input,.fsb select,.fsb textarea{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:5px;padding:3px 6px;font:inherit}
.fsb .bar{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#161b22;cursor:move;user-select:none;flex:none}.fsb .bar b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fsb .badge{font-size:11px;padding:1px 7px;border-radius:9px;background:#1f6feb33;color:#79c0ff}.fsb .dirty{background:#bb800933;color:#e3b341}
.fsb .main{display:flex;flex:1;min-height:0}.fsb .tree{width:210px;overflow:auto;border-right:1px solid #30363d;padding:6px;flex:none;background:#0d1117}
.fsb .tree div{padding:2px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fsb .tree div:hover{background:#161b22}.fsb .tree div.on{background:#1f6feb44}.fsb .tree h4{margin:8px 0 3px;font-size:11px;color:#8b949e;text-transform:uppercase}
.fsb .right{flex:1;display:flex;flex-direction:column;min-width:0}.fsb .tabs{display:flex;gap:2px;padding:4px 6px 0;border-bottom:1px solid #30363d;flex:none}.fsb .tabs span{padding:5px 12px;cursor:pointer;border-radius:5px 5px 0 0;color:#8b949e}.fsb .tabs span.on{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-bottom-color:#161b22;margin-bottom:-1px}
.fsb .pane{flex:1;min-height:0;display:none;flex-direction:column;overflow:hidden}.fsb .pane.on{display:flex}.fsb .tool{display:flex;gap:6px;align-items:center;padding:6px;flex-wrap:wrap;flex:none}
.fsb .gridw{flex:1;overflow:auto;min-height:0}.fsb table{border-collapse:collapse;font-size:12.5px}.fsb th,.fsb td{border:1px solid #30363d;padding:2px 7px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;text-align:left}
.fsb th{background:#161b22;position:sticky;top:0;z-index:1;cursor:pointer}.fsb tr.flt th{top:25px;padding:1px}.fsb tr.flt input{width:100%;min-width:60px;border-radius:0;border:0;background:#0d1117}
.fsb td.null{color:#6e7681;font-style:italic}.fsb td.blob{color:#d2a8ff}.fsb td.num{text-align:right;color:#79c0ff}.fsb td.long{color:#ffa657}.fsb td.chg{font-weight:700;background:#bb800926}.fsb tr.sel td{background:#1f6feb33}
.fsb .stat{display:flex;gap:14px;padding:3px 8px;background:#161b22;border-top:1px solid #30363d;font-size:12px;color:#8b949e;flex:none}.fsb .stat span:first-child{flex:1}
.fsb textarea.sql{width:100%;height:150px;font-family:ui-monospace,Consolas,monospace;resize:vertical;flex:none}.fsb pre{margin:0;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,Consolas,monospace}
.fsb .res{flex:1;overflow:auto;padding:6px;min-height:0}.fsb .err{color:#ff7b72}.fsb .ok{color:#7ee787}.fsb .mut{color:#8b949e}
.fsb .modal{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:5}.fsb .modal>div{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;min-width:360px;max-width:80%;max-height:80%;overflow:auto;display:flex;flex-direction:column;gap:8px}
.fsb .rz{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#6e7681 50%)}`;
    function h(tag, attrs) { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v); } for (let i = 2; i < arguments.length; i++) { const c = arguments[i]; if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c))); } return e; }
    const reg = new Map();
    const cellStr = (v) => (v == null ? '' : (typeof v === 'object' && v.$int !== undefined ? String(v.$int) : String(v)));

    function open(host, ref, opts) {
        opts = opts || {}; const key = String(ref) + (opts.readonly ? '#ro' : ''); const prev = reg.get(key); if (prev && prev.win.isConnected) { prev.win.style.zIndex = String(Z); return prev.api; }
        if (!document.getElementById('fsb-css')) document.head.appendChild(h('style', { id: 'fsb-css', text: CSS }));
        const st = { handle: null, db: null, ro: !!opts.readonly, schema: null, table: null, tab: 'browse', page: 0, pageSize: 100, filters: {}, sort: [], total: null, cols: [], rows: [], hasRowid: false, inTxn: false, changes: 0, sel: new Set(), chg: new Set(), hist: [], lastRes: null };
        const win = h('div', { class: 'fsb' }); win.style.cssText = 'left:6vw;top:5vh;width:88vw;height:84vh;min-width:520px;min-height:340px;z-index:' + Z;
        const title = h('b', { text: '🗄 ' + ref }); const badge = h('span', { class: 'badge', text: '連線中…' }); const dirtyB = h('span', { class: 'badge dirty', text: '' }); dirtyB.style.display = 'none';
        const bWrite = h('button', { class: 'pri', title: 'COMMIT 並寫回來源 (Ctrl+S)', text: 'Write Changes' }), bRev = h('button', { title: '回滾所有暫存變更', text: 'Revert' }), bRef = h('button', { title: '重新載入', text: '↻' }), bMax = h('button', { text: '🗖' }), bX = h('button', { text: '✕' });
        const bar = h('div', { class: 'bar' }, title, badge, dirtyB, bWrite, bRev, bRef, bMax, bX);
        const tree = h('div', { class: 'tree' }); const tabs = h('div', { class: 'tabs' }); const panes = {};
        const TABS = [['struct', 'Database Structure'], ['browse', 'Browse Data'], ['sql', 'Execute SQL'], ['pragma', 'Pragmas']];
        for (const [id, label] of TABS) { tabs.append(h('span', { 'data-t': id, text: label, onclick: () => setTab(id) })); panes[id] = h('div', { class: 'pane' }); }
        const stat1 = h('span', { text: '' }), stat2 = h('span', { text: '' }); const stat = h('div', { class: 'stat' }, stat1, stat2);
        const right = h('div', { class: 'right' }, tabs, panes.struct, panes.browse, panes.sql, panes.pragma);
        win.append(bar, h('div', { class: 'main' }, tree, right), stat, h('div', { class: 'rz' }));
        document.body.appendChild(win);
        const say = (m, bad) => { stat1.textContent = m; stat1.style.color = bad ? '#ff7b72' : ''; };
        const q = C.quoteIdent;
        const call = async (op, args) => host.call(op, Object.assign({ db: st.db }, args || {}));
        const exec = async (sql, bind, o) => { const r = await call('exec', Object.assign({ sql, bind, limit: 1000 }, o || {})); return r.results; };
        const modal = (heading, body, buttons) => new Promise((resolve) => { const m = h('div', { class: 'modal' }); const box = h('div', null, h('b', { text: heading }), body); const row = h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }); for (const [id, label, cls] of buttons) row.append(h('button', { class: cls || '', text: label, onclick: () => { m.remove(); resolve(id); } })); box.append(row); m.append(box); win.append(m); const f = box.querySelector('input,textarea'); if (f) f.focus(); });
        const confirmSql = async (sql, why) => { const danger = C.isDangerous(sql); const pre = h('pre', { text: sql }); const body = h('div', null, h('div', { class: 'mut', text: why || '將執行下列 SQL：' }), pre); if (danger.length) body.append(h('div', { class: 'err', text: '⚠ ' + danger.join('；') })); return (await modal('確認', body, [['no', '取消'], ['yes', '執行', danger.length ? 'bad' : 'pri']])) === 'yes'; };
        function markDirty() { dirtyB.style.display = st.inTxn ? '' : 'none'; dirtyB.textContent = '● 有未寫回的變更' + (st.changes ? '（' + st.changes + '）' : ''); bWrite.disabled = !st.inTxn; bRev.disabled = !st.inTxn; }
        async function ensureTxn() { if (!st.inTxn) { const r = await exec('BEGIN'); if (r[0] && r[0].error) throw new Error(r[0].error); st.inTxn = true; } }
        async function run(sql, bind) { // 寫入類：先進交易暫存
            await ensureTxn(); const r = await exec(sql, bind); const e = r.find((x) => x.error); if (e) throw new Error(e.error); st.changes += r.reduce((n, x) => n + (x.changes || 0), 0); markDirty(); return r;
        }
        async function loadSchema() { st.schema = await call('schema'); const names = st.schema.tables.map((t) => t.name); if (!st.table || !names.includes(st.table)) st.table = names[0] || null; drawTree(); }
        function drawTree() {
            tree.textContent = ''; const sec = (label, items, fn) => { if (!items.length) return; tree.append(h('h4', { text: label + '（' + items.length + '）' })); for (const it of items) tree.append(h('div', { class: it.name === st.table && fn ? 'on' : '', title: it.name, text: it.name + (it.rows != null ? '  ' + it.rows : ''), onclick: fn ? () => { st.table = it.name; st.page = 0; st.filters = {}; st.sort = []; st.sel.clear(); drawTree(); if (st.tab === 'struct') drawStruct(); else setTab('browse'); } : () => { setTab('struct'); } })); };
            sec('Tables', st.schema.tables, true); sec('Views', st.schema.views.map((v) => ({ name: v.name })), true); sec('Indices', st.schema.indices); sec('Triggers', st.schema.triggers);
        }
        function setTab(id) { st.tab = id; for (const s of tabs.children) s.classList.toggle('on', s.dataset.t === id); for (const [k, p] of Object.entries(panes)) p.classList.toggle('on', k === id); ({ struct: drawStruct, browse: drawBrowse, sql: drawSql, pragma: drawPragma })[id](); }

        // ===== 結構 =====
        function drawStruct() {
            const p = panes.struct; p.textContent = ''; const tools = h('div', { class: 'tool' });
            const bNew = h('button', { text: '＋ 新增資料表', disabled: st.ro, onclick: newTable }); const bIdx = h('button', { text: '＋ 新增索引', disabled: st.ro || !st.table, onclick: newIndex }); const bAdd = h('button', { text: '＋ 加欄位', disabled: st.ro || !st.table, onclick: addColumn }); const bDrop = h('button', { class: 'bad', text: '🗑 刪除…', disabled: st.ro, onclick: dropObject });
            tools.append(bNew, bAdd, bIdx, bDrop); const w = h('div', { class: 'res' });
            for (const t of st.schema.tables) { w.append(h('h4', { text: t.name + (t.virtual ? '（虛擬）' : '') + (t.rows != null ? '  ' + t.rows + ' 列' : '') })); const tb = h('table'); tb.append(h('tr', null, ...['欄位', '型別', 'PK', 'NOT NULL', '預設'].map((x) => h('th', { text: x })))); for (const c of t.columns) tb.append(h('tr', null, h('td', { text: c.name }), h('td', { text: c.type }), h('td', { text: c.pk ? String(c.pk) : '' }), h('td', { text: c.notnull ? '✓' : '' }), h('td', { text: c.dflt == null ? '' : String(c.dflt) }))); w.append(tb, h('pre', { class: 'mut', text: t.sql || '' })); }
            for (const x of [].concat(st.schema.views.map((v) => ['View', v]), st.schema.indices.map((v) => ['Index', v]), st.schema.triggers.map((v) => ['Trigger', v]))) w.append(h('h4', { text: x[0] + '：' + x[1].name }), h('pre', { class: 'mut', text: x[1].sql || '' }));
            p.append(tools, w);
        }
        async function applyDdl(sql, why) { if (!(await confirmSql(sql, why))) return false; try { await run(sql); await loadSchema(); setTab(st.tab); say('已執行（暫存中，按 Write Changes 寫回）'); return true; } catch (e) { say(String(e.message || e), true); return false; } }
        async function newTable() {
            const name = h('input', { placeholder: '資料表名稱', style: 'width:100%' }); const cols = h('textarea', { rows: 6, style: 'width:100%;font-family:monospace', placeholder: '每行一個欄位：名稱 型別 [pk] [notnull] [unique] [default 值]\nid INTEGER pk\nname TEXT notnull' }); cols.value = 'id INTEGER pk\nname TEXT';
            if ((await modal('新增資料表', h('div', null, name, cols), [['no', '取消'], ['ok', '預覽 SQL', 'pri']])) !== 'ok' || !name.value.trim()) return;
            const defs = cols.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const w = l.split(/\s+/); const o = { name: w[0], type: /^(pk|notnull|unique|default)$/i.test(w[1] || '') ? '' : (w[1] || '') }; for (let i = 1; i < w.length; i++) { const f = w[i].toLowerCase(); if (f === 'pk') o.pk = true; else if (f === 'notnull') o.notnull = true; else if (f === 'unique') o.unique = true; else if (f === 'default') o.dflt = w[++i]; } return o; });
            await applyDdl(C.ddlCreateTable(name.value.trim(), defs)); setTab('struct');
        }
        async function addColumn() { const n = h('input', { placeholder: '欄位名稱' }), ty = h('input', { placeholder: '型別（如 TEXT）', value: 'TEXT' }); if ((await modal('在「' + st.table + '」加欄位', h('div', null, n, ty), [['no', '取消'], ['ok', '預覽 SQL', 'pri']])) === 'ok' && n.value.trim()) await applyDdl(C.ddlAddColumn(st.table, { name: n.value.trim(), type: ty.value.trim() })); }
        async function newIndex() { const t = st.schema.tables.find((x) => x.name === st.table); if (!t) return; const n = h('input', { placeholder: '索引名稱', value: 'idx_' + t.name + '_' }), c = h('input', { placeholder: '欄位，以逗號分隔' }), u = h('input', { type: 'checkbox' }); if ((await modal('在「' + t.name + '」建索引', h('div', null, n, c, h('label', null, u, ' UNIQUE')), [['no', '取消'], ['ok', '預覽 SQL', 'pri']])) === 'ok' && n.value.trim() && c.value.trim()) await applyDdl(C.ddlCreateIndex(n.value.trim(), t.name, c.value.split(',').map((x) => x.trim()).filter(Boolean), u.checked)); }
        async function dropObject() { const opts = [].concat(st.schema.tables.map((t) => ['table', t.name]), st.schema.views.map((t) => ['view', t.name]), st.schema.indices.map((t) => ['index', t.name]), st.schema.triggers.map((t) => ['trigger', t.name])); const sel = h('select', null, ...opts.map((o, i) => h('option', { value: String(i), text: o[0] + ' ' + o[1] }))); if ((await modal('刪除哪一個？', sel, [['no', '取消'], ['ok', '預覽 SQL', 'bad']])) === 'ok') { const o = opts[Number(sel.value)]; if (o) await applyDdl(C.ddlDrop(o[0], o[1])); } }

        // ===== 瀏覽資料 =====
        function cell(v, editable, ri, ci) {
            const d = C.cellDisplay(v); const td = h('td', { class: d.cls + (st.chg.has(ri + ':' + ci) ? ' chg' : ''), title: d.cls === 'long' || d.cls === 'blob' ? '雙擊檢視／編輯' : '雙擊編輯', text: d.text });
            td.addEventListener('dblclick', () => (editable ? editCell(td, v, ri, ci) : viewCell(v))); return td;
        }
        async function viewCell(v) { const d = C.cellDisplay(v, 1e9); const body = h('div'); if (v && v.$blob !== undefined) { const it = C.imageType(v.$blob); if (it) body.append(h('img', { src: 'data:' + it + ';base64,' + v.$blob, style: 'max-width:520px;max-height:320px' })); body.append(h('pre', { text: C.hexDump(v.$blob, 2048) })); } else body.append(h('pre', { text: d.full == null ? 'NULL' : String(d.full) })); await modal('儲存格內容', body, [['ok', '關閉']]); }
        function editCell(td, v, ri, ci) {
            const col = st.cols[ci]; if (col === '__rowid__') return; const info = (st.schema.tables.find((t) => t.name === st.table) || { columns: [] }).columns.find((c) => c.name === col); const d = C.cellDisplay(v, 1e9);
            if (v && v.$blob !== undefined) return editBlob(ri, ci);
            const long = d.cls === 'long' || (typeof d.full === 'string' && d.full.length > 60); const inp = long ? h('textarea', { rows: 6, style: 'width:100%' }) : h('input', { style: 'width:100%' }); inp.value = d.full == null ? '' : String(d.full);
            const setNull = h('button', { text: 'Set NULL' });
            (async () => { const choice = await Promise.race([modal('編輯 ' + st.table + '.' + col, h('div', null, inp, h('div', { class: 'mut', text: '型別：' + ((info && info.type) || '（無）') + (info && info.notnull ? '　NOT NULL' : '') })), [['no', '取消'], ['null', 'Set NULL'], ['ok', '確定', 'pri']])]); if (choice === 'no') return; await saveCell(ri, ci, choice === 'null' ? null : C.parseCellInput(inp.value, info && info.type)); })(); void setNull;
        }
        async function editBlob(ri, ci) { const f = await host.pickFile(); if (!f) return; let bin = ''; for (let i = 0; i < f.bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, f.bytes.subarray(i, i + 0x8000)); await saveCell(ri, ci, { $blob: btoa(bin) }); }
        async function saveCell(ri, ci, val) {
            const info = st.schema.tables.find((t) => t.name === st.table); const key = C.rowKey(info || { columns: [] }, st.cols, st.rows[ri], st.hasRowid); if (!key) return say('這個表沒有 rowid 或主鍵，不能編輯', true);
            try { await run('UPDATE ' + q(st.table) + ' SET ' + q(st.cols[ci]) + ' = ? WHERE ' + key.sql, [val].concat(key.bind)); st.chg.add(ri + ':' + ci); st.rows[ri][ci] = val; renderGrid(); } catch (e) { say(String(e.message || e), true); }
        }
        const gridHost = {};
        function drawBrowse() {
            const p = panes.browse; p.textContent = ''; if (!st.table) { p.append(h('div', { class: 'res mut', text: '（沒有資料表）' })); return; }
            const isView = !st.schema.tables.some((t) => t.name === st.table);
            const sel = h('select', { onchange: (e) => { st.table = e.target.value; st.page = 0; st.filters = {}; st.sort = []; st.sel.clear(); drawTree(); drawBrowse(); } }, ...st.schema.tables.concat(st.schema.views).map((t) => h('option', { value: t.name, selected: t.name === st.table ? '' : null, text: t.name })));
            const ps = h('select', { onchange: (e) => { st.pageSize = Number(e.target.value); st.page = 0; fetchPage(); } }, ...[50, 100, 500, 1000].map((n) => h('option', { value: n, selected: n === st.pageSize ? '' : null, text: n + ' 列/頁' })));
            const prev = h('button', { text: '◀', onclick: () => { if (st.page > 0) { st.page--; fetchPage(); } } }), next = h('button', { text: '▶', onclick: () => { st.page++; fetchPage(); } }); gridHost.pageLabel = h('span', { class: 'mut' });
            const bNewRow = h('button', { text: '＋ 新增列', disabled: st.ro || isView, onclick: newRecord }), bDel = h('button', { class: 'bad', text: '🗑 刪除選取列', disabled: st.ro || isView, onclick: delSelected }), bExp = h('button', { text: '⬇ 匯出', onclick: exportGrid });
            p.append(h('div', { class: 'tool' }, sel, ps, prev, gridHost.pageLabel, next, bNewRow, bDel, bExp)); gridHost.wrap = h('div', { class: 'gridw' }); p.append(gridHost.wrap); fetchPage();
        }
        let ftimer = null; let gen = 0;
        async function fetchPage() {
            const my = ++gen; if (!st.table) return; const { filters, local } = C.buildFilters(st.filters); st.local = local;
            try {
                const r = await call('query', { table: st.table, filters, sort: st.sort, offset: st.page * st.pageSize, limit: st.pageSize });
                if (my !== gen) return; st.cols = r.columns; st.rows = r.rows; st.total = r.total; st.hasRowid = r.hasRowid; st.sel.clear(); renderGrid();
            } catch (e) { say(String(e.message || e), true); }
        }
        function renderGrid() {
            const w = gridHost.wrap; if (!w) return; w.textContent = ''; const info = st.schema.tables.find((t) => t.name === st.table); const editable = !st.ro && !!info && !!C.rowKey(info, st.cols.length ? st.cols : [], st.rows[0] || [], st.hasRowid) || (!st.ro && !!info && st.rows.length === 0);
            const vis = st.cols.map((c, i) => i).filter((i) => st.cols[i] !== '__rowid__'); const tb = h('table'); const hr = h('tr'), fr = h('tr', { class: 'flt' });
            for (const i of vis) { const c = st.cols[i]; const s = st.sort.find((x) => x.col === c); hr.append(h('th', { title: '點擊排序（再點反向、第三次取消）', text: c + (s ? (s.desc ? ' ▼' : ' ▲') : ''), onclick: () => { const cur = st.sort.find((x) => x.col === c); st.sort = !cur ? [{ col: c, desc: false }] : (!cur.desc ? [{ col: c, desc: true }] : []); st.page = 0; fetchPage(); } })); const inp = h('input', { placeholder: '過濾', value: st.filters[c] || '', title: 'abc 含有｜=abc 相等｜<>x｜>5 >=5 <5 <=5｜a..b 範圍｜*.c GLOB｜NULL／!NULL｜/regex/（只過濾本頁）', oninput: (e) => { st.filters[c] = e.target.value; clearTimeout(ftimer); ftimer = setTimeout(() => { st.page = 0; fetchPage(); }, 300); } }); fr.append(h('th', null, inp)); }
            hr.prepend(h('th', { text: '#' })); fr.prepend(h('th')); tb.append(hr, fr);
            st.rows.forEach((r, ri) => { if (st.local && st.local.length && !st.local.every((f) => { const i = st.cols.indexOf(f.col); return i >= 0 && f.regex.test(cellStr(r[i])); })) return; const tr = h('tr', { class: st.sel.has(ri) ? 'sel' : '' }); tr.append(h('td', { class: 'mut', text: String(st.page * st.pageSize + ri + 1), onclick: (e) => { if (e.ctrlKey || e.metaKey) { if (st.sel.has(ri)) st.sel.delete(ri); else st.sel.add(ri); } else { st.sel.clear(); st.sel.add(ri); } renderGrid(); } })); for (const i of vis) tr.append(cell(r[i], editable, ri, i)); tb.append(tr); });
            w.append(tb); const total = st.total == null ? '?' : st.total; gridHost.pageLabel.textContent = (st.rows.length ? st.page * st.pageSize + 1 : 0) + '–' + (st.page * st.pageSize + st.rows.length) + ' / ' + total; stat2.textContent = st.table + (editable ? '' : st.ro ? '（唯讀）' : '（不可編輯：沒有 rowid 或主鍵）');
        }
        async function newRecord() {
            const info = st.schema.tables.find((t) => t.name === st.table); if (!info) return; const inputs = info.columns.filter((c) => !c.hidden).map((c) => ({ c, inp: h('input', { placeholder: (c.type || '') + (c.pk ? ' PK' : '') + (c.dflt != null ? ' 預設 ' + c.dflt : ''), style: 'width:100%' }) }));
            const grid = h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center' }); for (const x of inputs) grid.append(h('span', { text: x.c.name }), x.inp);
            if ((await modal('新增列到 ' + st.table, grid, [['no', '取消'], ['ok', '新增', 'pri']])) !== 'ok') return;
            const used = inputs.filter((x) => x.inp.value !== ''); const sql = used.length ? 'INSERT INTO ' + q(st.table) + ' (' + used.map((x) => q(x.c.name)).join(', ') + ') VALUES (' + used.map(() => '?').join(', ') + ')' : 'INSERT INTO ' + q(st.table) + ' DEFAULT VALUES';
            try { await run(sql, used.map((x) => C.parseCellInput(x.inp.value, x.c.type))); await loadSchema(); fetchPage(); } catch (e) { say(String(e.message || e), true); }
        }
        async function delSelected() {
            if (!st.sel.size) return say('先點左邊的列號選取（Ctrl 點可多選）', true); const info = st.schema.tables.find((t) => t.name === st.table); const keys = [...st.sel].map((ri) => C.rowKey(info, st.cols, st.rows[ri], st.hasRowid)); if (keys.some((k) => !k)) return say('這個表沒有 rowid 或主鍵，不能刪除', true);
            if (!(await confirmSql(keys.map((k) => 'DELETE FROM ' + q(st.table) + ' WHERE ' + k.sql + ';  -- ' + JSON.stringify(k.bind)).join('\n'), '將刪除 ' + keys.length + ' 列：'))) return;
            try { for (const k of keys) await run('DELETE FROM ' + q(st.table) + ' WHERE ' + k.sql, k.bind); await loadSchema(); fetchPage(); } catch (e) { say(String(e.message || e), true); }
        }
        async function exportGrid() { const cols = st.cols.filter((c) => c !== '__rowid__'); const idx = cols.map((c) => st.cols.indexOf(c)); const rows = st.rows.map((r) => idx.map((i) => r[i])); const which = await modal('匯出目前這一頁', h('div', { class: 'mut', text: cols.length + ' 欄 × ' + rows.length + ' 列' }), [['no', '取消'], ['csv', 'CSV'], ['json', 'JSON'], ['md', 'Markdown']]); if (which === 'csv') host.download(st.table + '.csv', C.toCsv(cols, rows), 'text/csv'); else if (which === 'json') host.download(st.table + '.json', C.toJson(cols, rows), 'application/json'); else if (which === 'md') host.download(st.table + '.md', C.toMarkdown(cols, rows), 'text/markdown'); }

        // ===== Execute SQL =====
        function drawSql() {
            const p = panes.sql; if (p.firstChild) return; const ta = h('textarea', { class: 'sql', placeholder: '輸入 SQL。Ctrl+Enter＝全部執行；選取一段只執行選取的部分。', spellcheck: 'false' }); const res = h('div', { class: 'res' });
            const go = async (explain) => { let sql = ta.value.slice(ta.selectionStart === ta.selectionEnd ? 0 : ta.selectionStart, ta.selectionStart === ta.selectionEnd ? undefined : ta.selectionEnd); if (!sql.trim()) return; if (explain) sql = sql.split(/;\s*\n?/)[0]; if (explain) sql = 'EXPLAIN QUERY PLAN ' + sql; const dg = C.isDangerous(sql); if (dg.length && !(await confirmSql(sql, '這段 SQL 有危險語句：'))) return; await runUser(sql, res, 1000); st.hist.unshift(sql); };
            ta.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); go(false); } });
            const hist = h('select', { onchange: (e) => { if (e.target.value) ta.value = st.hist[Number(e.target.value) - 1]; e.target.value = ''; } }, h('option', { value: '', text: '歷史…' })); hist.addEventListener('focus', () => { hist.textContent = ''; hist.append(h('option', { value: '', text: '歷史…' })); st.hist.slice(0, 30).forEach((s, i) => hist.append(h('option', { value: String(i + 1), text: s.replace(/\s+/g, ' ').slice(0, 80) }))); });
            const bStop = h('button', { text: '■ 取消', onclick: async () => { try { await call('cancel'); say('已取消（未提交的變更已自動回滾）', true); st.inTxn = false; st.changes = 0; markDirty(); } catch (e) { say(String(e.message || e), true); } } });
            const bEx = h('button', { text: '⬇ 匯出結果', onclick: async () => { const r = st.lastRes; if (!r) return; const w = await modal('匯出最後一個結果', h('div'), [['no', '取消'], ['csv', 'CSV'], ['json', 'JSON'], ['md', 'Markdown']]); if (w === 'csv') host.download('result.csv', C.toCsv(r.columns, r.rows), 'text/csv'); else if (w === 'json') host.download('result.json', C.toJson(r.columns, r.rows), 'application/json'); else if (w === 'md') host.download('result.md', C.toMarkdown(r.columns, r.rows), 'text/markdown'); } });
            p.append(h('div', { class: 'tool' }, h('button', { class: 'pri', text: '▶ 執行 (Ctrl+Enter)', onclick: () => go(false) }), h('button', { text: 'Explain', onclick: () => go(true) }), bStop, hist, bEx), h('div', { style: 'padding:0 6px;flex:none' }, ta), res);
            panes.sql._ta = ta;
        }
        async function runUser(sql, res, limit) {
            res.textContent = ''; const t0 = Date.now(); let out;
            const kinds = SPLIT.split(sql).map((s) => C.classify(s)); const needTxn = kinds.some((k) => k === 'write' || k === 'ddl') && !st.ro && !kinds.includes('txn');
            try { if (needTxn) await ensureTxn(); out = await exec(sql, undefined, { limit }); } catch (e) { res.append(h('div', { class: 'err', text: String(e.message || e) })); return; }
            if (kinds.includes('txn')) { const last = SPLIT.split(sql).map((s) => /^\s*(BEGIN|COMMIT|END|ROLLBACK)/i.exec(C.stripLead(s))).filter(Boolean).pop(); if (last) st.inTxn = /^BEGIN/i.test(last[1]); if (!st.inTxn) st.changes = 0; }
            let last = null;
            out.forEach((r, i) => {
                const box = h('div', { style: 'margin-bottom:12px' });
                if (r.error) box.append(h('div', { class: 'err', text: '語句 ' + (i + 1) + ' 失敗：' + r.error }), h('pre', { class: 'mut', text: r.sql || '' }));
                else if (r.columns && r.columns.length) { const tb = h('table'); tb.append(h('tr', null, ...r.columns.map((c) => h('th', { text: c })))); r.rows.forEach((row) => tb.append(h('tr', null, ...row.map((v) => { const d = C.cellDisplay(v); return h('td', { class: d.cls, title: d.cls === 'long' || d.cls === 'blob' ? '雙擊檢視' : '', text: d.text, ondblclick: () => viewCell(v) }); })))); box.append(h('div', { class: 'ok', text: r.rows.length + ' 列' + (r.truncated ? '（只顯示前 ' + limit + ' 列）' : '') + '　' + r.ms + ' ms' }), h('div', { style: 'overflow:auto;max-height:60vh' }, tb)); if (r.truncated) box.append(h('button', { text: 'Show 10× more', onclick: () => runUser(sql, res, Math.min(limit * 10, 1000000)) })); last = r; }
                else { box.append(h('div', { class: 'ok', text: '語句 ' + (i + 1) + '：影響 ' + (r.changes || 0) + ' 列　' + r.ms + ' ms' })); if (r.changes) st.changes += r.changes; }
                res.append(box);
            });
            if (last) st.lastRes = last; markDirty(); if (kinds.some((k) => k === 'ddl' || k === 'write')) { await loadSchema(); }
            say('完成　' + (Date.now() - t0) + ' ms');
        }

        // ===== Pragmas =====
        const PRAGMAS = ['foreign_keys', 'journal_mode', 'synchronous', 'cache_size', 'page_size', 'user_version', 'application_id', 'auto_vacuum', 'encoding', 'busy_timeout', 'temp_store', 'locking_mode', 'secure_delete', 'recursive_triggers'];
        async function drawPragma() {
            const p = panes.pragma; p.textContent = ''; const w = h('div', { class: 'res' }); const tb = h('table'); tb.append(h('tr', null, h('th', { text: 'PRAGMA' }), h('th', { text: '值' }), h('th'))); w.append(tb);
            for (const n of PRAGMAS) { let v = ''; try { const r = await call('pragma', { name: n }); v = r.rows[0] ? String(r.rows[0][0]) : ''; } catch (_) { v = '（讀取失敗）'; } const inp = h('input', { value: v, disabled: st.ro }); tb.append(h('tr', null, h('td', { text: n }), h('td', null, inp), h('td', null, h('button', { text: '設定', disabled: st.ro, onclick: async () => { try { await call('pragma', { name: n, value: /^-?\d+$/.test(inp.value) ? Number(inp.value) : inp.value }); say('已設定 ' + n); } catch (e) { say(String(e.message || e), true); } } })))); }
            const out = h('pre', { class: 'mut' }); const chk = h('button', { text: '整合性檢查 (integrity_check)', onclick: async () => { out.textContent = '檢查中…'; try { const r = await exec('PRAGMA integrity_check'); out.textContent = r[0].rows.map((x) => x[0]).join('\n'); } catch (e) { out.textContent = String(e.message || e); } } });
            p.append(h('div', { class: 'tool' }, chk), w, h('div', { class: 'res' }, out));
        }

        // ===== 視窗行為 =====
        const dispose = async () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); window.removeEventListener('beforeunload', bu); reg.delete(key); win.remove(); try { if (st.inTxn) await exec('ROLLBACK'); } catch (_) { /* 連線可能已斷 */ } try { await st.handle.close(); } catch (_) { /* 已關 */ } };
        const bu = (e) => { if (st.inTxn) { e.preventDefault(); e.returnValue = ''; } };
        async function commit() { if (!st.inTxn) return true; try { const r = await exec('COMMIT'); if (r[0] && r[0].error) throw new Error(r[0].error); st.inTxn = false; st.changes = 0; st.chg.clear(); await st.handle.commit(); markDirty(); say('已寫入'); return true; } catch (e) { say('寫入失敗：' + String(e.message || e), true); return false; } }
        async function revert() { try { await exec('ROLLBACK'); } catch (_) { /* 沒有交易 */ } st.inTxn = false; st.changes = 0; st.chg.clear(); markDirty(); await loadSchema(); setTab(st.tab); say('已還原'); }
        bWrite.onclick = commit; bRev.onclick = async () => { if (st.inTxn && (await modal('還原', h('div', { text: '放棄所有未寫回的變更？' }), [['no', '取消'], ['yes', '放棄變更', 'bad']])) !== 'yes') return; revert(); };
        bRef.onclick = async () => { await loadSchema(); setTab(st.tab); };
        bX.onclick = async () => { if (st.inTxn) { const c = await modal('有未寫回的變更', h('div', { text: '要寫入資料庫，還是放棄？' }), [['no', '取消'], ['drop', '放棄', 'bad'], ['yes', '寫入並關閉', 'pri']]); if (c === 'no') return; if (c === 'yes' && !(await commit())) return; } dispose(); };
        win.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); commit(); } });
        window.addEventListener('beforeunload', bu);
        let maxed = false, saved = ''; bMax.onclick = () => { maxed = !maxed; if (maxed) { saved = win.style.cssText; win.style.left = '0'; win.style.top = '0'; win.style.width = '100vw'; win.style.height = '100vh'; win.style.borderRadius = '0'; } else win.style.cssText = saved; };
        let ox = 0, oy = 0, drag = false, rz = false; bar.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON' || maxed) return; drag = true; const r = win.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; win.style.zIndex = String(Z); });
        win.querySelector('.rz').addEventListener('mousedown', (e) => { rz = true; e.preventDefault(); });
        const mv = (e) => { if (drag) { win.style.left = Math.max(0, e.clientX - ox) + 'px'; win.style.top = Math.max(0, e.clientY - oy) + 'px'; } else if (rz) { const r = win.getBoundingClientRect(); win.style.width = Math.max(520, e.clientX - r.left) + 'px'; win.style.height = Math.max(340, e.clientY - r.top) + 'px'; } }; const up = () => { drag = false; rz = false; };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
        const api = { win, state: st, close: dispose, commit, revert, refresh: bRef.onclick, setTab, ready: null };
        reg.set(key, { win, api });
        api.ready = (async () => {
            try {
                st.handle = await host.openDb(ref, { readonly: st.ro }); st.db = st.handle.db; st.ro = st.ro || !!st.handle.readonly; title.textContent = '🗄 ' + (st.handle.label || ref); badge.textContent = st.ro ? '唯讀' : '可寫'; markDirty(); await loadSchema(); setTab(st.table ? 'browse' : 'struct'); say('已開啟');
            } catch (e) { badge.textContent = '開啟失敗'; panes.browse.classList.add('on'); panes.browse.append(h('div', { class: 'res err', text: String((e && e.message) || e) })); }
            return api;
        })();
        return api;
    }
    return { open, Z };
});
