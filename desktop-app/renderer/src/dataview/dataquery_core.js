/* 資料的離線精準查詢（FaDataQuery）：口語問題 → 穩定、精準的查詢，離線小模型也行。設計見 DESIGN.data-viewers.md 第八節。
 *
 * 弱模型寫查詢程式不穩，所以不讓模型寫查詢：
 *   ① profile：把 JSON（含 SPDX）或工作表轉成「資料的結構」——有哪些表（陣列裡的物件變成一張表、巢狀陣列變成子表）、每個欄位的型別與出現過的值。
 *   ② analyze／plan：程式讀問題（中英文詞彙對照、問題裡出現的值、比較與數字、要數量／平均／排序／分組），組出結構化的查詢計畫。
 *      有歧義的地方（哪張表、哪個欄位、哪個運算）變成封閉選擇題，模型只挑字母；挑不出來用程式的第一名，並且把「我假設了什麼」寫進回答。
 *   ③ check：欄位要真的存在、比較的值要真的在資料裡、型別要接得上；不合格就不執行並說明。
 *   ④ run：用計畫直接在資料上執行（結果以這個為準）；toSql：同一份計畫翻成 SQLite 查詢語法，附在答案裡讓使用者核對。
 *   ⑤ answer：整條串起來；沒有結果時先放寬（精確→包含）、再列出最接近的值，不編答案。
 * 純函式（UMD）；模型（generate）是注入的。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? (function () { try { return require('../recipe/recipe_core.js'); } catch (_) { return null; } })() : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaDataQuery = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';

    // ---------- 詞彙：中文說法 → 英文欄位字 ----------
    const GLOSSARY = {
        授權: ['license', 'licence'], 許可: ['license'], 版本: ['version', 'versioninfo'], 套件: ['package', 'packages'], 軟體: ['package'], 名稱: ['name'], 名字: ['name'], 姓名: ['name'], 檔案: ['file', 'files'], 檔名: ['filename', 'file'],
        雜湊: ['checksum', 'hash'], 校驗: ['checksum'], 演算法: ['algorithm'], 數值: ['value'], 相依: ['relationship', 'depends', 'dependency'], 依賴: ['relationship', 'depends', 'dependency'], 關係: ['relationship'], 類型: ['type', 'category'], 種類: ['type', 'category'],
        下載: ['download', 'downloadlocation'], 位置: ['location'], 網址: ['url', 'link', 'homepage', 'location'], 連結: ['url', 'link', 'reference'], 供應商: ['supplier'], 作者: ['originator', 'author', 'creator'], 說明: ['description', 'comment'], 描述: ['description'], 摘要: ['summary'],
        建立: ['created', 'creator'], 創建: ['created', 'creator'], 日期: ['date', 'created'], 時間: ['time', 'date', 'created'], 版權: ['copyright', 'copyrighttext'], 首頁: ['homepage'], 來源: ['source', 'sourceinfo'], 外部參照: ['externalref', 'reference'], 參照: ['reference'], 識別: ['id', 'spdxid'], 編號: ['id', 'number', 'no'],
        價格: ['price', 'cost'], 單價: ['price', 'unitprice'], 金額: ['amount', 'total', 'price'], 總額: ['total', 'amount'], 數量: ['quantity', 'qty', 'count'], 庫存: ['stock', 'inventory'], 地址: ['address'], 電話: ['phone', 'tel'], 信箱: ['email', 'mail'], 郵件: ['email', 'mail'], 年齡: ['age'], 性別: ['gender', 'sex'],
        城市: ['city'], 國家: ['country'], 地區: ['region', 'area'], 狀態: ['status', 'state'], 分類: ['category', 'class', 'type'], 部門: ['department', 'dept'], 薪水: ['salary', 'pay'], 薪資: ['salary', 'pay'], 公司: ['company', 'organization'], 產品: ['product', 'item'], 商品: ['product', 'item'], 客戶: ['customer', 'client'], 訂單: ['order'], 員工: ['employee', 'staff'], 學生: ['student'], 成績: ['score', 'grade'], 分數: ['score', 'grade'], 備註: ['note', 'remark', 'comment'], 標題: ['title'], 內容: ['content', 'text']
    };
    const STOP = new Set(['the', 'and', 'for', 'with', 'list', 'show', 'all', 'what', 'which', 'are', 'who', 'has', 'have', 'that', 'from', 'where', 'whose', 'how', 'many', 'much', 'any', 'not', 'without', 'each', 'per', 'top', 'name', 'names']);
    // 複數的 s 去掉（checksums → checksum），讓「checksum」對得上「checksums」
    const stem = (w) => (w.length > 3 && /[a-z]s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
    const wordsOf = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-/:]+/g, ' ').toLowerCase().split(/[^a-z0-9㐀-鿿]+/).filter(Boolean).map(stem);
    const cjkBigrams = (s) => { const out = new Set(); for (const run of String(s || '').match(/[㐀-鿿]+/g) || []) { if (run.length === 1) out.add(run); for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2)); } return out; };
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const toNum = (v) => { if (isNum(v)) return v; if (typeof v === 'string' && /^\s*-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i.test(v)) return Number(v.replace(/,/g, '')); return null; };
    const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    const lc = (v) => String(v === null || v === undefined ? '' : v).toLowerCase();
    const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

    // ---------- 結構（profile）----------
    // 一張表：{ id, label, parent, cols:[{name, type, values(distinct), nDistinct, words}], rows:[[…]]（前兩欄是 _id、_parent，不給使用者看）}
    function typeOf(vals) {
        const v = vals.filter((x) => !isEmpty(x)); if (!v.length) return 'text';
        if (v.every((x) => typeof x === 'boolean')) return 'bool';
        if (v.every((x) => isNum(x))) return 'number';
        if (v.every((x) => typeof x === 'string' && DATE_RE.test(x))) return 'date';
        if (v.length >= 3 && v.filter((x) => toNum(x) !== null).length / v.length >= 0.9) return 'number';
        if (v.some((x) => Array.isArray(x))) return 'list';
        return 'text';
    }
    function finishTable(t, maxValues) {
        t.cols = t.colNames.map((name, ci) => {
            const vals = t.rows.map((r) => r[ci + 2]); const type = typeOf(vals); const seen = new Map();
            for (const x of vals) { if (isEmpty(x)) continue; const items = Array.isArray(x) ? x : [x]; for (const it of items) { const k = String(it); if (!seen.has(k)) seen.set(k, 0); seen.set(k, seen.get(k) + 1); } }
            const distinct = [...seen.keys()]; const col = { name, type, nDistinct: distinct.length, words: wordsOf(name), index: ci + 2 };
            if (distinct.length <= (maxValues || 400)) col.values = distinct; else col.values = distinct.slice(0, maxValues || 400), col.truncated = true;
            if (type === 'number') { const ns = vals.map(toNum).filter((x) => x !== null); col.min = Math.min.apply(null, ns); col.max = Math.max.apply(null, ns); }
            return col;
        });
        t.words = wordsOf(t.label); return t;
    }
    // JSON → 一堆表：根物件的純量欄位成為「文件」表；陣列裡的物件成為一張表；物件裡的陣列成為子表（_parent 指向上一層那一列）
    function profileJson(data, opts) {
        opts = opts || {}; const tables = []; const byId = new Map();
        const flat = (o, prefix, depth, out, kids) => {
            for (const k of Object.keys(o)) {
                const v = o[k]; const name = prefix ? prefix + '.' + k : k;
                if (v === null || typeof v !== 'object') out[name] = v;
                else if (Array.isArray(v)) { if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) kids.push([name, v]); else if (v.length) out[name] = v.filter((x) => x === null || typeof x !== 'object'); }
                else if (depth < 2) flat(v, name, depth + 1, out, kids); else out[name] = JSON.stringify(v);
            }
        };
        const addTable = (id, label, items, parent, parentIds) => {
            let t = byId.get(id); if (!t) { t = { id, label, parent: parent || null, colNames: [], rows: [] }; byId.set(id, t); tables.push(t); }
            const kidsAll = [];
            items.forEach((it, i) => {
                const out = {}; const kids = []; flat(it, '', 0, out, kids); const rowId = t.rows.length;
                for (const k of Object.keys(out)) if (!t.colNames.includes(k)) t.colNames.push(k);
                t.rows.push({ _id: rowId, _parent: parentIds ? parentIds[i] : null, out }); kids.forEach(([k, arr]) => kidsAll.push([k, arr, rowId]));
            });
            const byKey = new Map(); for (const [k, arr, pid] of kidsAll) { if (!byKey.has(k)) byKey.set(k, { items: [], pids: [] }); const e = byKey.get(k); arr.forEach((x) => { e.items.push(x); e.pids.push(pid); }); }
            for (const [k, e] of byKey) addTable(id + '.' + k, label + '.' + k, e.items, id, e.pids);
        };
        const rootOut = {}; const rootKids = [];
        if (Array.isArray(data)) { if (data.length && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) addTable('rows', 'rows', data, null, null); }
        else if (data && typeof data === 'object') {
            // 工作簿形狀 {名稱: [每列一個物件]}、或一般文件
            flat(data, '', 0, rootOut, rootKids);
            for (const [k, arr] of rootKids) addTable(k, k, arr, null, null);
            if (Object.keys(rootOut).length) { const t = { id: '文件', label: '文件', parent: null, colNames: Object.keys(rootOut), rows: [{ _id: 0, _parent: null, out: rootOut }] }; byId.set(t.id, t); tables.unshift(t); }
        }
        for (const t of tables) { t.rows = t.rows.map((r) => [r._id, r._parent].concat(t.colNames.map((c) => (r.out[c] === undefined ? null : r.out[c])))); finishTable(t, opts.maxValues); }
        return { tables };
    }
    function profileSheets(sheets, opts) {
        const tables = (sheets || []).map((s) => { const cols = s.columns.map((c, i) => String(c === null || c === undefined || c === '' ? '欄' + (i + 1) : c)); const t = { id: s.name, label: s.name, parent: null, colNames: cols, rows: s.rows.map((r, i) => [i, null].concat(cols.map((_, ci) => (r[ci] === undefined ? null : r[ci])))) }; return finishTable(t, opts && opts.maxValues); });
        return { tables };
    }
    function profile(input, opts) {
        if (input && Array.isArray(input.sheets)) return profileSheets(input.sheets, opts);
        if (input && Array.isArray(input.columns) && Array.isArray(input.rows)) return profileSheets([{ name: input.name || 'sheet', columns: input.columns, rows: input.rows }], opts);
        return profileJson(input, opts);
    }
    const tableOf = (P, id) => P.tables.find((t) => t.id === id);
    const colOf = (t, name) => t.cols.find((c) => c.name === name);
    const childrenOf = (P, id) => P.tables.filter((t) => t.parent === id);

    // ---------- 讀問題 ----------
    function expand(q) {
        const words = new Set(); const text = String(q || '');
        for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []) { if (w.length >= 2 && !STOP.has(w)) wordsOf(w).forEach((x) => words.add(x)); }
        const gl = []; for (const k of Object.keys(GLOSSARY)) if (text.includes(k)) { gl.push(k); GLOSSARY[k].forEach((x) => words.add(stem(x))); }
        return { words, gloss: gl, bigrams: cjkBigrams(text) };
    }
    // 一個欄位跟問題有多相關
    function colScore(col, qi, text) {
        let s = 0; for (const w of col.words) if (qi.words.has(w) && w.length > 1) s += 2;
        if (qi.words.has(col.name.toLowerCase())) s += 3;
        const cb = cjkBigrams(col.name); for (const b of cb) if (qi.bigrams.has(b)) s += 2;
        if (/[㐀-鿿]/.test(col.name) && text.includes(col.name)) s += 4;
        return s;
    }
    function tableScore(t, qi, text) {
        let s = 0; for (const w of t.words) if (qi.words.has(w) && w.length > 1) s += 3; const lb = cjkBigrams(t.label); for (const b of lb) if (qi.bigrams.has(b)) s += 3; if (/[㐀-鿿]/.test(t.label) && text.includes(t.label)) s += 5;
        if (qi.words.has(t.label.toLowerCase())) s += 3;
        for (const c of t.cols) s += Math.min(colScore(c, qi, text), 4) * 0.5;
        return s;
    }
    // 問題裡出現的資料值：整個值出現在問題裡（最長優先、不重疊）→ eq；英文字詞是某些值的一部分 → contains
    function findValues(text, tables) {
        const hits = []; const low = text.toLowerCase(); const used = [];
        const cands = []; for (const t of tables) for (const c of t.cols) { if (c.type === 'bool' || !c.values) continue; for (const v of c.values) { const s = String(v); if (s.length >= 2 && s.length <= 60) cands.push({ t, c, v: s }); } }
        cands.sort((a, b) => b.v.length - a.v.length);
        for (const x of cands) { const lv = x.v.toLowerCase(); if (c_isPlainNumber(x.v) && x.c.type === 'number') continue; const i = low.indexOf(lv); if (i < 0) continue; if (/^[a-z0-9]+$/.test(lv) && (/[a-z0-9]/.test(low[i - 1] || ' ') || /[a-z0-9]/.test(low[i + lv.length] || ' '))) continue; if (used.some(([a, b]) => i < b && i + lv.length > a)) continue; hits.push({ t: x.t, c: x.c, value: x.v, op: 'eq', at: i, len: lv.length, span: [i, i + lv.length] }); }
        const bySpan = new Map(); for (const h of hits) { const k = h.span.join(','); if (!bySpan.has(k)) bySpan.set(k, []); bySpan.get(k).push(h); }
        for (const [k] of bySpan) { const [a, b] = k.split(',').map(Number); used.push([a, b]); }
        // 英文詞（不在上面已用的範圍）是某些值的一部分 → contains
        const re = /[A-Za-z][A-Za-z0-9._-]{1,}/g; let m; const containsHits = [];
        while ((m = re.exec(text))) { const w = m[0]; const a = m.index, b = a + w.length; if (STOP.has(w.toLowerCase()) || used.some(([x, y]) => a < y && b > x)) continue; const lw = w.toLowerCase(); if (lw.length < 3) continue;
            for (const t of tables) for (const c of t.cols) { if (!c.values || c.type === 'bool') continue; const n = c.values.filter((v) => lc(v).includes(lw)).length; const wr = wordRe(lw); const nw = c.values.filter((v) => wr.test(lc(v))).length; if (n && !colHasWord(c, lw) && !tableHasWord(t, lw)) containsHits.push({ t, c, value: w, op: nw && !/包含|含有|含|contain/i.test(text) ? 'word' : 'contains', at: a, len: w.length, span: [a, b], matches: nw || n, substringMatches: n }); } }
        return { eq: bySpan, contains: containsHits };
    }
    const c_isPlainNumber = (s) => /^-?\d+(?:\.\d+)?$/.test(String(s));
    const colHasWord = (c, w) => c.words.includes(stem(w)) || c.name.toLowerCase() === w;
    const tableHasWord = (t, w) => t.words.includes(stem(w));
    const wordRe = (w) => new RegExp('(^|[^a-z0-9])' + String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');

    // 比較：大於／小於／至少／以上…；回傳 [{op, value, at, before(前面的字)}]
    function findCompares(text) {
        const out = []; const pats = [
            [/(大於等於|不少於|至少|>=|≥)\s*(-?\d+(?:[.,]\d+)?)/g, 'gte'], [/(小於等於|不超過|至多|最多|<=|≤)\s*(-?\d+(?:[.,]\d+)?)/g, 'lte'], [/(大於|超過|高於|多於|多過|>)\s*(-?\d+(?:[.,]\d+)?)/g, 'gt'], [/(小於|少於|低於|少過|<)\s*(-?\d+(?:[.,]\d+)?)/g, 'lt'],
            [/(-?\d+(?:[.,]\d+)?)\s*[^\d\s,，。]{0,3}?\s*(以上)/g, 'gte', 1], [/(-?\d+(?:[.,]\d+)?)\s*[^\d\s,，。]{0,3}?\s*(以下|以內)/g, 'lte', 1]
        ];
        for (const [re, op, swap] of pats) { let m; while ((m = re.exec(text))) { const num = swap ? m[1] : m[2]; out.push({ op, value: Number(String(num).replace(/,/g, '')), at: m.index, span: [m.index, m.index + m[0].length], before: text.slice(Math.max(0, m.index - 12), m.index), after: text.slice(m.index + m[0].length, m.index + m[0].length + 6), raw: m[0] }); } }
        return out;
    }
    function detectOp(text, qi) {
        const t = text; const o = { kind: 'list' };
        const topM = /前\s*(\d+)\s*(?:個|筆|名|項)?|top\s*(\d+)/i.exec(t); if (topM) o.limit = Number(topM[1] || topM[2]);
        if (/哪[個種些]/.test(t) && /最多|最少/.test(t)) { o.kind = 'group'; o.limit = o.limit || 1; o.aggDir = /最少/.test(t) ? 'asc' : 'desc'; o.which = true; }
        else if (/(?:各|每個|每種|每一?[個種]|分別|依照?|按照?|group by|per )/i.test(t) && /(?:數量|幾個|幾筆|幾位|幾種|幾人|幾項|幾件|多少|統計|總和|平均|count|sum|avg|total)/i.test(t)) o.kind = 'group';
        else if (/平均|avg|average|mean/i.test(t)) o.kind = 'avg';
        else if (/總和|加總|總計|合計|\bsum\b|total of/i.test(t)) o.kind = 'sum';
        else if (/幾個|幾筆|幾種|幾位|多少(?:個|筆|種|位|套件)?|數量|總共有|共有幾|count|how many/i.test(t) && !/多少錢|價格是多少/.test(t)) o.kind = 'count';
        else if (/最(?:大|高|多|貴|新|晚)|最小|最低|最少|最便宜|最舊|最早|\bmax\b|\bmin\b|highest|lowest|latest|earliest|oldest|newest/i.test(t)) { o.kind = 'extreme'; o.dir = /最(?:小|低|少|便宜|舊|早)|\bmin\b|lowest|earliest|oldest/i.test(t) ? 'asc' : 'desc'; o.limit = o.limit || 1; }
        else if (topM) { o.kind = 'extreme'; o.dir = /最(?:小|低|少|便宜|舊|早)|lowest|bottom/i.test(t) ? 'asc' : 'desc'; }
        if (/排序|由高到低|由低到高|降序|升序|sorted?|order by/i.test(t)) { o.order = /由低到高|升序|asc/i.test(t) ? 'asc' : 'desc'; }
        if (/有哪些(?:不同|不一樣|種類)?|不重複|不同的|distinct|unique|種類/i.test(t)) o.distinct = true;
        return o;
    }

    // ---------- 計畫 ----------
    // plan：{ from, joins:[{table, kind:'child'|'parent'|'anti'}], where:[{t,c,op,value}], select:[{t,c}], group:[{t,c}], agg:{fn,t,c}|null, order:[{t,c,dir}], limit, distinct }
    // 歧義：questions:[{id, text, options:[{label, set(plan)}]}]；程式的第一個選項是預設
    const letter = (i) => String.fromCharCode(65 + i);
    function pickIndex(v, n) { let x = v && typeof v === 'object' ? v.choice : v; if (typeof x === 'string') { x = x.trim().replace(/["'.。、）)]/g, ''); if (/^[A-Za-z]$/.test(x)) x = x.toUpperCase().charCodeAt(0) - 64; else if (/^\d+$/.test(x)) x = Number(x); } return Number.isInteger(x) && x >= 1 && x <= n ? x - 1 : -1; }
    const NAME_COLS = ['name', 'title', 'filename', '名稱', '姓名', '名字', '標題', '檔名'];
    const nameColOf = (t) => { for (const p of NAME_COLS) { const c = t.cols.find((x) => x.name.toLowerCase() === p); if (c) return c; } return null; };
    const idCol = (t) => { const pri = ['name', 'title', '名稱', '姓名', '名字', '標題', 'id', 'spdxid', 'filename', 'fileName']; for (const p of pri) { const c = t.cols.find((x) => x.name.toLowerCase() === p.toLowerCase()); if (c) return c; } return t.cols.find((c) => c.type === 'text') || t.cols[0]; };
    const refOf = (t, c) => ({ t: t.id, c: c.name });

    function buildPlan(question, P, opts) {
        opts = opts || {}; const text = String(question || ''); const qi = expand(text); const notes = []; const questions = [];
        if (!P.tables.length || P.tables.every((t) => t.id === '文件')) return { ok: false, error: '這份資料裡找不到可以查的表格（沒有「陣列裡的物件」或工作表）' };
        const vals = findValues(text, P.tables);
        // ① 哪張表
        const tText = text.replace(/(?:沒有|沒|無|缺少|未填)\s*[A-Za-z0-9_.一-鿿]{1,20}/g, ' '); const qiT = expand(tText); // 「沒有 X」的 X 是條件，不拿來決定查哪張表
        const ranked = P.tables.map((t) => ({ t, s: tableScore(t, qiT, tText) - ((t.id === '文件' && !/文件|document/i.test(tText)) ? 2 : 0) - (t.parent ? 1.5 * t.words.filter((w) => !qiT.words.has(w) && !tableOf(P, t.parent).words.includes(w)).length : 0) })); const valueScore = new Map();
        for (const hs of vals.eq.values()) for (const h of hs) valueScore.set(h.t.id, (valueScore.get(h.t.id) || 0) + 2);
        for (const h of vals.contains) valueScore.set(h.t.id, (valueScore.get(h.t.id) || 0) + 1);
        for (const r of ranked) r.s += (valueScore.get(r.t.id) || 0) + (r.t.parent ? -0.2 : 0.1);
        ranked.sort((a, b) => b.s - a.s);
        const top = ranked[0]; const amb = ranked.filter((r) => r.s > 0 && top.s - r.s < 1.5).sort((a, b) => (a.t.parent ? 1 : 0) - (b.t.parent ? 1 : 0) || b.s - a.s).slice(0, 4); // 上下兩層都被提到：預設用上層（條件可以接到下層）
        { const par = top.t.parent && ranked.find((r) => r.t.id === top.t.parent); if (par && par.s > 1 && !amb.some((r) => r.t.id === par.t.id)) amb.unshift(par); } // 最高分是子表、但上層也被提到：問一下（預設上層）
        let base = amb.length ? amb[0].t : top.t;
        if (!(top.s > 0.5) && ranked.length > 1) return { ok: false, error: '看不出你問的是哪一張表', need: 'table', options: P.tables.slice(0, 8).map((t) => t.label), questions: [] };
        if (amb.length > 1) questions.push({ id: 'table', text: '你問的是哪一張表？', options: amb.map((r) => ({ label: r.t.label + '（' + r.t.rows.length + ' 列）', apply: (p) => { p.from = r.t.id; } })) });
        const plan = { from: base.id, joins: [], where: [], select: [], group: [], agg: null, order: [], limit: null, distinct: false, text };
        // 表的範圍：基本表 ＋ 它的子表與上一層（只往一層）
        const scopeOf = (id) => { const b = tableOf(P, id); return [b].concat(childrenOf(P, id), b.parent ? [tableOf(P, b.parent)] : []).filter(Boolean); };
        const scope = scopeOf(base.id);
        // ② 篩選：值 → 欄位
        const used = []; const addWhere = (h, col, t) => { plan.where.push({ t: t.id, c: col.name, op: h.op, value: h.value }); used.push(h.span); };
        const scopeIds = new Set(scope.map((t) => t.id));
        const eqGroups = [...vals.eq.values()].map((g) => g.filter((h) => scopeIds.has(h.t.id))).filter((g) => g.length);
        for (const g of eqGroups) { // 同一個值出現在好幾個欄位：挑跟問題最相關的欄位；平手就問
            const scored = g.map((h) => ({ h, s: colScore(h.c, qi, text) + (h.t.id === base.id ? 1 : 0) })).sort((a, b) => b.s - a.s);
            const best = scored.filter((x) => scored[0].s - x.s < 1).slice(0, 4);
            if (best.length > 1 && scored[0].s <= 1) questions.push({ id: 'value:' + g[0].value, text: '「' + g[0].value + '」是哪個欄位的值？', options: best.map((x) => ({ label: x.h.t.label + '.' + x.h.c.name, apply: (p) => { p.where = p.where.filter((w) => !(w.value === x.h.value && w.pending)); p.where.push({ t: x.h.t.id, c: x.h.c.name, op: 'eq', value: x.h.value }); } })), pendingDefault: { t: best[0].h.t.id, c: best[0].h.c.name, op: 'eq', value: g[0].value, pending: true } });
            else plan.where.push({ t: scored[0].h.t.id, c: scored[0].h.c.name, op: 'eq', value: scored[0].h.value });
            used.push(g[0].span);
        }
        for (const q of questions) if (q.pendingDefault) plan.where.push(q.pendingDefault);
        // 包含：英文詞是值的一部分（例如 GPL 在 GPL-2.0-only、LGPL-3.0 裡）
        const cByWord = new Map(); for (const h of vals.contains.filter((x) => scopeIds.has(x.t.id) && !used.some(([a, b]) => x.span[0] < b && x.span[1] > a))) { const k = h.value.toLowerCase(); if (!cByWord.has(k)) cByWord.set(k, []); cByWord.get(k).push(h); }
        for (const [k, g] of cByWord) {
            const cop = g[0].op; if (cop === 'word' && g[0].substringMatches > g[0].matches) notes.push('「' + g[0].value + '」比對的是完整的字（例如 ' + g[0].value + '-3.0），像 L' + g[0].value + ' 這種只是字裡面含有的不算；要連那些也算，請說「包含 ' + g[0].value + '」');
            const scored = g.map((h) => ({ h, s: colScore(h.c, qi, text) + (h.t.id === base.id ? 1 : 0) + Math.min(h.matches, 5) * 0.05 })).sort((a, b) => b.s - a.s); const best = scored.filter((x) => scored[0].s - x.s < 1).slice(0, 4);
            if (best.length > 1 && scored[0].s <= 1) questions.push({ id: 'cvalue:' + k, text: '「' + g[0].value + '」是想找哪個欄位裡包含它的值？', options: best.map((x) => ({ label: x.h.t.label + '.' + x.h.c.name, apply: (p) => { p.where = p.where.filter((w) => !(w.pending && w.value === x.h.value)); p.where.push({ t: x.h.t.id, c: x.h.c.name, op: cop, value: x.h.value }); } })), pendingDefault: { t: best[0].h.t.id, c: best[0].h.c.name, op: cop, value: g[0].value, pending: true } });
            else plan.where.push({ t: scored[0].h.t.id, c: scored[0].h.c.name, op: cop, value: g[0].value });
            used.push(g[0].span);
        }
        for (const q of questions) if (q.pendingDefault && !plan.where.includes(q.pendingDefault)) plan.where.push(q.pendingDefault);
        // 問題裡像識別字的詞（含大寫或數字、至少 3 個字元）沒有對到任何值：很可能是打錯字——還是當成條件（找不到會列出最接近的值），不要默默忽略
        { const re2 = /[A-Za-z][A-Za-z0-9._-]{2,}/g; let um; while ((um = re2.exec(text))) { const w = um[0], a = um.index, b = a + w.length; const lw = w.toLowerCase();
            if (!/[A-Z0-9]/.test(w) || STOP.has(lw) || used.some(([x, y]) => a < y && b > x) || scope.some((t) => t.words.includes(stem(lw)) || t.cols.some((c) => c.words.includes(stem(lw))))) continue;
            const before = text.slice(Math.max(0, a - 12), a); const qb = expand(before);
            const cs = scope.flatMap((t) => t.cols.filter((c) => c.type === 'text' && !/^_/.test(c.name)).map((c) => ({ t, c, s: colScore(c, qb, before) }))).sort((x, y) => y.s - x.s)[0];
            if (cs && cs.s >= 2) { plan.where.push({ t: cs.t.id, c: cs.c.name, op: 'eq', value: w }); used.push([a, b]); } } }
        // 數字比較：找跟它最近的欄位詞；找不到就用唯一的數值欄位
        for (const cp of findCompares(text)) {
            const numCols = scope.flatMap((t) => t.cols.filter((c) => c.type === 'number' && !/^_/.test(c.name)).map((c) => ({ t, c })));
            const near = (cp.before + ' ' + cp.after + ' ' + text).toLowerCase(); const qi2 = expand(cp.before + ' ' + cp.after);
            const sc = numCols.map((x) => ({ x, s: colScore(x.c, qi2, cp.before + cp.after) * 2 + colScore(x.c, qi, text) + (x.t.id === base.id ? 0.5 : 0) })).sort((a, b) => b.s - a.s);
            if (!sc.length) { notes.push('「' + cp.raw + '」要比較數字，但是這份資料裡沒有數值欄位，略過這個條件'); continue; }
            const best = sc.filter((x) => sc[0].s - x.s < 1).slice(0, 4);
            const w = { t: sc[0].x.t.id, c: sc[0].x.c.name, op: cp.op, value: cp.value };
            if (best.length > 1 && sc[0].s < 1) { questions.push({ id: 'num:' + cp.raw, text: '「' + cp.raw + '」是比較哪個欄位？', options: best.map((x) => ({ label: x.x.t.label + '.' + x.x.c.name, apply: (p) => { const i = p.where.findIndex((y) => y === w); if (i >= 0) { p.where[i] = { t: x.x.t.id, c: x.x.c.name, op: cp.op, value: cp.value }; } } })) }); }
            plan.where.push(w); used.push(cp.span);
        }
        // 日期：「2018 年到職」「2020 年以後」「2026-01-20 之前」→ 日期欄位的範圍（欄位挑問題裡提到的日期欄，沒有就用唯一的日期欄）
        { const dateCols = scope.flatMap((t) => t.cols.filter((c) => c.type === 'date').map((c) => ({ t, c })));
            const dre = /(\d{4}-\d{2}-\d{2})\s*(之後|以後|以前|之前|後|前)?|(\d{4})\s*年(?!代)\s*(以後|之後|以前|之前|以來)?/g; let dm;
            while ((dm = dre.exec(text))) { const a = dm.index, b = a + dm[0].length; if (used.some(([x, y]) => a < y && b > x)) continue;
                const sc = dateCols.map((x) => ({ x, s: colScore(x.c, expand(text.slice(Math.max(0, a - 12), b + 8)), text.slice(Math.max(0, a - 12), b + 8)) + colScore(x.c, qi, text) })).sort((p, q2) => q2.s - p.s)[0];
                if (!sc) { notes.push('「' + dm[0] + '」是日期條件，但這份資料沒有日期欄位，略過'); continue; }
                const dir = dm[2] || dm[4] || ''; const after = /後|以來/.test(dir), before = /前/.test(dir);
                const wh = (op, value) => plan.where.push({ t: sc.x.t.id, c: sc.x.c.name, op, value });
                if (dm[1]) { if (after) wh('gt', dm[1]); else if (before) wh('lt', dm[1]); else wh('prefix', dm[1]); }
                else { if (after) { wh('gte', dm[3] + '-01-01'); notes.push('「' + dm[0] + '」我當成 ' + dm[3] + '-01-01 起（含 ' + dm[3] + ' 年）'); } else if (before) wh('lt', dm[3] + '-01-01'); else wh('prefix', dm[3]); }
                used.push([a, b]); } }
        // 「年齡 30」「價格是 100」：數字前面緊接著數值欄位的名字 → 等於
        { const numRe = /-?\d+(?:\.\d+)?/g; let nmm; while ((nmm = numRe.exec(text))) { const a = nmm.index, b = a + nmm[0].length; if (used.some(([x, y]) => a < y && b > x)) continue; const before = text.slice(Math.max(0, a - 10), a); const qb = expand(before);
            const cs = scope.flatMap((t) => t.cols.filter((c) => c.type === 'number' && !/^_/.test(c.name)).map((c) => ({ t, c, s: colScore(c, qb, before) }))).sort((x, y) => y.s - x.s)[0];
            if (cs && cs.s >= 2 && !/前\s*$|top\s*$/i.test(before)) { plan.where.push({ t: cs.t.id, c: cs.c.name, op: 'eq', value: Number(nmm[0]) }); used.push([a, b]); } } }
        // 「沒有 X」：欄位是空的，或是沒有對應的子表資料
        const noRe = /(?:沒有|沒|無|缺少|未填|空白)\s*([A-Za-z0-9_.一-鿿]{1,20}?)(?:的|欄|，|,|。|$|\s)/g; let nm;
        while ((nm = noRe.exec(text))) {
            const phrase = nm[1]; const qp = expand(phrase); let hit = null;
            const kidScore = childrenOf(P, base.id).map((k) => ({ k, s: tableScore(k, qp, phrase) })).sort((a, b) => b.s - a.s)[0];
            const colScored = scope.flatMap((t) => t.cols.map((c) => ({ t, c, s: colScore(c, qp, phrase) }))).sort((a, b) => b.s - a.s)[0];
            if (kidScore && kidScore.s >= 3 && (!colScored || kidScore.s >= colScored.s)) hit = { anti: kidScore.k };
            else if (colScored && colScored.s >= 2) hit = { col: colScored };
            if (hit && hit.anti) { plan.joins.push({ table: hit.anti.id, kind: 'anti' }); notes.push('「沒有 ' + phrase + '」＝沒有任何 ' + hit.anti.label + ' 資料的列'); }
            else if (hit && hit.col) plan.where.push({ t: hit.col.t.id, c: hit.col.c.name, op: 'empty' });
        }
        // ③ 運算
        const op = detectOp(text, qi); plan.distinct = !!op.distinct;
        // 「數量」若是欄位名稱（訂單數量大於 8），不是在問「有幾個」
        if (op.kind === 'count' && !/幾個|幾筆|幾種|幾位|幾人|幾項|幾件|多少|how many/i.test(text) && scope.some((t) => t.cols.some((c) => /數量|count/i.test(c.name) && text.includes(c.name)))) op.kind = 'list';
        const numCandidates = scope.flatMap((t) => t.cols.filter((c) => (c.type === 'number' || c.type === 'date') && !/^_/.test(c.name)).map((c) => ({ t, c })));
        const pickNum = (label, kindDate) => {
            const pool = numCandidates.filter((x) => kindDate ? x.c.type === 'date' : x.c.type === 'number'); const pool2 = pool.length ? pool : numCandidates; if (!pool2.length) return null;
            const sc = pool2.map((x) => ({ x, s: colScore(x.c, qi, text) + (x.t.id === base.id ? 0.5 : 0) })).sort((a, b) => b.s - a.s); const best = sc.filter((x) => sc[0].s - x.s < 1).slice(0, 4);
            const chosen = sc[0].x; if (best.length > 1 && sc[0].s < 1) questions.push({ id: 'metric:' + label, text: '「' + label + '」要用哪個欄位？', options: best.map((x) => ({ label: x.x.t.label + '.' + x.x.c.name, apply: (p) => { if (p.agg) { p.agg.t = x.x.t.id; p.agg.c = x.x.c.name; } if (p.order.length) { p.order[0].t = x.x.t.id; p.order[0].c = x.x.c.name; } } })) });
            return chosen;
        };
        const mentioned = scope.flatMap((t) => t.cols.filter((c) => !/^_/.test(c.name)).map((c) => ({ t, c, s: colScore(c, qi, text) }))).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
        const filterCols = new Set(plan.where.map((w) => w.t + '\u0000' + w.c));
        if (op.kind === 'count') { plan.agg = { fn: 'count', t: base.id, c: null }; }
        else if (op.kind === 'avg' || op.kind === 'sum') { const c = pickNum(op.kind); if (!c) return { ok: false, error: '這份資料沒有數值欄位，不能算' + (op.kind === 'avg' ? '平均' : '總和') }; plan.agg = { fn: op.kind, t: c.t.id, c: c.c.name }; }
        else if (op.kind === 'group') {
            const gm = /(?:各|每個?|每種|依照?|按照?|分別|哪[個種些])\s*([A-Za-z0-9_.一-鿿]{1,12}?)(?:的|有|共|別|統計|之|$|\s|，|,)/.exec(text); const qg = expand(gm ? gm[1] : text);
            const cs = scope.flatMap((t) => t.cols.filter((c) => !/^_/.test(c.name)).map((c) => ({ t, c, s: colScore(c, qg, gm ? gm[1] : text) + (t.id === base.id ? 0.5 : 0) }))).sort((a, b) => b.s - a.s);
            if (!cs.length || cs[0].s < 1) return { ok: false, error: '看不出要依哪個欄位分組', need: 'group', options: scope.flatMap((t) => t.cols.filter((c) => !/^_/.test(c.name)).map((c) => t.label + '.' + c.name)).slice(0, 12) };
            const best = cs.filter((x) => cs[0].s - x.s < 1).slice(0, 4); plan.group = [{ t: cs[0].t.id, c: cs[0].c.name }];
            if (best.length > 1 && cs[0].s < 2) questions.push({ id: 'group', text: '要依哪個欄位分組？', options: best.map((x) => ({ label: x.t.label + '.' + x.c.name, apply: (p) => { p.group = [{ t: x.t.id, c: x.c.name }]; } })) });
            const m2 = /平均|avg|average/i.test(text) ? 'avg' : /總和|加總|總計|合計|sum/i.test(text) ? 'sum' : 'count';
            if (m2 === 'count') plan.agg = { fn: 'count', t: base.id, c: null }; else { const c = pickNum(m2); plan.agg = c ? { fn: m2, t: c.t.id, c: c.c.name } : { fn: 'count', t: base.id, c: null }; }
            plan.order = [{ agg: true, dir: op.aggDir || 'desc' }]; if (op.which) plan.limit = 1;
        } else if (op.kind === 'extreme') {
            const dateWanted = /最新|最晚|最舊|最早|latest|earliest|oldest|newest/i.test(text); const c = pickNum('排序依據', dateWanted); if (!c) return { ok: false, error: '看不出要依哪個欄位找最大／最小（資料裡沒有數值或日期欄位）' };
            plan.order = [{ t: c.t.id, c: c.c.name, dir: op.dir }]; plan.limit = op.limit || 1;
        }
        if (op.order && !plan.order.length) { const cs = mentioned.filter((x) => x.c.type === 'number' || x.c.type === 'date'); if (cs.length) plan.order = [{ t: cs[0].t.id, c: cs[0].c.name, dir: op.order }]; }
        if (op.limit && !plan.limit) plan.limit = op.limit;
        // ④ 顯示哪些欄位
        if (!plan.agg) {
            const sel = []; const addSel = (t, c) => { if (!sel.some((s) => s.t === t.id && s.c === c.name)) sel.push(refOf(t, c)); };
            const idc = idCol(base);
            const wants = mentioned.filter((x) => !(filterCols.has(x.t.id + '\u0000' + x.c.name) && x.s < 4));
            // 一律先顯示「這一列是誰」（名稱欄）；沒有名稱欄的表（關係、訂單這類）就顯示全部欄位（最多 6 個）
            const hasName = nameColOf(base);
            if (hasName) addSel(base, hasName); else if (!wants.length || wants.every((x) => x.t.id !== base.id)) for (const c of base.cols.filter((x) => !/^_/.test(x.name)).slice(0, 6)) addSel(base, c); else if (idc) addSel(base, idc);
            for (const x of wants.slice(0, 5)) addSel(x.t, x.c);
            for (const w of plan.where) { const t = tableOf(P, w.t), c = t && colOf(t, w.c); if (t && c && w.op !== 'empty' && sel.length < 6) addSel(t, c); }
            for (const w of plan.where) { if (w.t === base.id || w.op === 'empty') continue; const t = tableOf(P, w.t); if (!t) continue; for (const c of t.cols.filter((x) => x.name !== w.c && !/^_/.test(x.name)).slice(0, 2)) if (sel.length < 7) addSel(t, c); } // 條件在子表：連同那一列的其他欄位一起顯示（例如 purl 的內容）
            if (!sel.length && idc) addSel(base, idc); const antiIds = new Set(plan.joins.filter((j) => j.kind === 'anti').map((j) => j.table)); plan.select = sel.filter((x) => !antiIds.has(x.t));
        }
        // 用到子表／上層表的欄位 → 加 join
        const need = new Set([].concat(plan.where.map((w) => w.t), plan.select.map((s) => s.t), plan.group.map((g) => g.t), plan.agg && plan.agg.c ? [plan.agg.t] : [], plan.order.filter((o) => o.t).map((o) => o.t)));
        for (const id of need) { if (id === base.id || plan.joins.some((j) => j.table === id)) continue; const t = tableOf(P, id); if (!t) continue; if (t.parent === base.id) plan.joins.push({ table: id, kind: 'child' }); else if (base.parent === id) plan.joins.push({ table: id, kind: 'parent' }); }
        plan.notes = notes; return { ok: true, plan, questions, ranked: ranked.slice(0, 3).map((r) => ({ table: r.t.id, score: Math.round(r.s * 10) / 10 })) };
    }

    // ---------- 檢查 ----------
    // opts.strictValues：條件的值一定要在資料裡（預設不擋——打錯字時照樣執行，回報沒有結果並列出最接近的值，比直接拒絕有用）
    function check(plan, P, opts) {
        const errs = []; const t0 = tableOf(P, plan.from); if (!t0) return ['沒有這張表：' + plan.from];
        const okRef = (r, what) => { const t = tableOf(P, r.t); if (!t) { errs.push(what + '：沒有這張表 ' + r.t); return null; } const c = colOf(t, r.c); if (!c) { errs.push(what + '：' + t.label + ' 沒有欄位 ' + r.c); return null; } return { t, c }; };
        const inScope = new Set([plan.from].concat(plan.joins.map((j) => j.table)));
        for (const j of plan.joins) { const t = tableOf(P, j.table); if (!t) errs.push('沒有這張表：' + j.table); else if (!(t.parent === plan.from || t0.parent === j.table)) errs.push(j.table + ' 跟 ' + plan.from + ' 不是上下層，不能接'); }
        for (const w of plan.where) { const x = okRef(w, '條件'); if (!x) continue; if (!inScope.has(w.t)) errs.push('條件用到的表 ' + w.t + ' 沒有接進來'); if (['gt', 'gte', 'lt', 'lte'].includes(w.op) && x.c.type !== 'number' && x.c.type !== 'date') errs.push('條件：' + x.c.name + ' 不是數字或日期，不能比大小'); if (opts && opts.strictValues && w.op === 'eq' && x.c.values && !x.c.truncated && w.value !== undefined && x.c.type !== 'number' && !x.c.values.some((v) => lc(v) === lc(w.value))) errs.push('條件：' + x.c.name + ' 裡沒有「' + w.value + '」這個值'); }
        for (const s of plan.select) { okRef(s, '顯示'); if (!inScope.has(s.t)) errs.push('顯示的表 ' + s.t + ' 沒有接進來'); }
        for (const g of plan.group) okRef(g, '分組'); if (plan.agg && plan.agg.c) { const x = okRef(plan.agg, '統計'); if (x && x.c.type !== 'number' && plan.agg.fn !== 'count') errs.push('統計：' + x.c.name + ' 不是數字，不能算' + plan.agg.fn); }
        if (!plan.agg && !plan.select.length) errs.push('沒有要顯示的欄位');
        return errs;
    }

    // ---------- 執行 ----------
    function compare(op, a, b) {
        if (op === 'empty') return isEmpty(a); if (op === 'notempty') return !isEmpty(a);
        if (op === 'eq' || op === 'neq') { const na = toNum(a), nb = toNum(b); const eq = na !== null && nb !== null && typeof b !== 'string' ? na === nb : (Array.isArray(a) ? a.some((x) => lc(x) === lc(b)) : lc(a) === lc(b)); return op === 'eq' ? eq : !eq; }
        if (op === 'word') { const re = wordRe(lc(b)); return Array.isArray(a) ? a.some((x) => re.test(lc(x))) : re.test(lc(a)); }
        if (op === 'prefix') return lc(a).startsWith(lc(b));
        if (op === 'contains') return Array.isArray(a) ? a.some((x) => lc(x).includes(lc(b))) : lc(a).includes(lc(b));
        let x = a, y = b; const na = toNum(a), nb = toNum(b); if (na !== null && nb !== null) { x = na; y = nb; } else { x = String(a); y = String(b); }
        if (isEmpty(a)) return false;
        return op === 'gt' ? x > y : op === 'gte' ? x >= y : op === 'lt' ? x < y : op === 'lte' ? x <= y : false;
    }
    function run(plan, P, opts) {
        opts = opts || {}; const base = tableOf(P, plan.from); const get = (env, ref) => { const t = tableOf(P, ref.t); const row = env[ref.t]; if (!row) return null; return row[colOf(t, ref.c).index]; };
        let envs = base.rows.map((r) => ({ [base.id]: r }));
        for (const j of plan.joins) {
            const jt = tableOf(P, j.table); const next = [];
            if (j.kind === 'child' || j.kind === 'anti') { const by = new Map(); for (const r of jt.rows) { const k = r[1]; if (!by.has(k)) by.set(k, []); by.get(k).push(r); } for (const e of envs) { const kids = by.get(e[base.id][0]) || []; if (j.kind === 'anti') { if (!kids.length) next.push(e); } else for (const k of kids) next.push(Object.assign({}, e, { [jt.id]: k })); } }
            else { const byId = new Map(jt.rows.map((r) => [r[0], r])); for (const e of envs) { const p = byId.get(e[base.id][1]); if (p) next.push(Object.assign({}, e, { [jt.id]: p })); } }
            envs = next;
        }
        envs = envs.filter((e) => plan.where.every((w) => compare(w.op, get(e, w), w.value)));
        const label = (ref) => { const multi = plan.joins.some((j) => j.kind !== 'anti') || false; return multi && ref.t !== plan.from ? tableOf(P, ref.t).label + '.' + ref.c : ref.c; };
        let columns, rows;
        if (plan.agg) {
            const groups = new Map(); for (const e of envs) { const key = plan.group.map((g) => String(get(e, g))); const k = JSON.stringify(key); if (!groups.has(k)) groups.set(k, { key: plan.group.map((g) => get(e, g)), es: [] }); groups.get(k).es.push(e); }
            if (!plan.group.length && !groups.size) groups.set('[]', { key: [], es: [] });
            const aggOf = (es) => { const f = plan.agg.fn; if (f === 'count') { if (!plan.agg.c) { const seen = new Set(es.map((e) => e[plan.from][0])); return seen.size; } return es.filter((e) => !isEmpty(get(e, plan.agg))).length; } const ns = es.map((e) => toNum(get(e, plan.agg))).filter((x) => x !== null); if (!ns.length) return null; if (f === 'sum') return round(ns.reduce((a, b) => a + b, 0)); if (f === 'avg') return round(ns.reduce((a, b) => a + b, 0) / ns.length); if (f === 'max') return Math.max.apply(null, ns); return Math.min.apply(null, ns); };
            const aggName = { count: '數量', sum: '總和', avg: '平均', max: '最大', min: '最小' }[plan.agg.fn] + (plan.agg.c ? '（' + plan.agg.c + '）' : '');
            columns = plan.group.map(label).concat([aggName]); rows = [...groups.values()].map((g) => g.key.map((x) => (isEmpty(x) ? '（空）' : x)).concat([aggOf(g.es)]));
            if (plan.order.length && plan.order[0].agg) { const sg = plan.order[0].dir === 'asc' ? -1 : 1; rows.sort((a, b) => sg * ((b[b.length - 1] === null ? -Infinity : b[b.length - 1]) - (a[a.length - 1] === null ? -Infinity : a[a.length - 1])) || String(a[0]).localeCompare(String(b[0]))); }
        } else {
            if (plan.order.length) { const o = plan.order[0]; const dir = o.dir === 'asc' ? 1 : -1; envs = envs.map((e, i) => ({ e, i, v: get(e, o) })).sort((a, b) => { const x = toNum(a.v), y = toNum(b.v); const c = x !== null && y !== null ? x - y : String(a.v === null ? '' : a.v).localeCompare(String(b.v === null ? '' : b.v)); return (isEmpty(a.v) ? 1 : isEmpty(b.v) ? -1 : c * dir) || a.i - b.i; }).map((x) => x.e); }
            columns = plan.select.map(label); rows = envs.map((e) => plan.select.map((s) => { const v = get(e, s); return Array.isArray(v) ? v.join(', ') : v; }));
            if (plan.distinct) { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }); }
        }
        const total = rows.length; if (plan.limit) rows = rows.slice(0, plan.limit); else if (rows.length > (opts.maxRows || 1000)) rows = rows.slice(0, opts.maxRows || 1000);
        return { columns, rows, total };
    }
    const round = (x) => Math.round(x * 1e6) / 1e6;

    // ---------- SQLite 查詢語法（給使用者核對；表與欄位的名字就是 profile 裡的）----------
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lit = (v) => (typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
    function toSql(plan, P) {
        const base = tableOf(P, plan.from); const ref = (r) => q(r.t) + '.' + q(r.c); const numeric = (r) => { const c = colOf(tableOf(P, r.t), r.c); return c && c.type === 'number' ? 'CAST(' + ref(r) + ' AS REAL)' : ref(r); };
        const from = [q(base.id)];
        for (const j of plan.joins) { const jt = tableOf(P, j.table); if (j.kind === 'child') from.push('JOIN ' + q(jt.id) + ' ON ' + q(jt.id) + '."_parent" = ' + q(base.id) + '."_id"'); else if (j.kind === 'anti') from.push('LEFT JOIN ' + q(jt.id) + ' ON ' + q(jt.id) + '."_parent" = ' + q(base.id) + '."_id"'); else from.push('JOIN ' + q(jt.id) + ' ON ' + q(base.id) + '."_parent" = ' + q(jt.id) + '."_id"'); }
        const where = plan.where.map((w) => { const c = ref(w); const col = colOf(tableOf(P, w.t), w.c); const isList = col && col.type === 'list';
            if (w.op === 'eq') return typeof w.value === 'number' || (col && col.type === 'number') ? numeric(w) + ' = ' + (toNum(w.value) !== null ? toNum(w.value) : lit(w.value)) : 'LOWER(' + c + ') = LOWER(' + lit(w.value) + ')';
            if (w.op === 'prefix') return c + " LIKE '" + String(w.value).replace(/'/g, "''") + "%'";
            if (w.op === 'word') { const lw = lc(w.value); const lk = (p) => 'LOWER(' + c + ") GLOB '" + p.replace(/'/g, "''") + "'"; return '(' + [lk(lw), lk(lw + '[^a-z0-9]*'), lk('*[^a-z0-9]' + lw), lk('*[^a-z0-9]' + lw + '[^a-z0-9]*')].join(' OR ') + ')'; }
            if (w.op === 'contains') return 'LOWER(' + c + ') LIKE ' + lit('%' + lc(w.value) + '%') + (isList ? '' : '');
            if (w.op === 'empty') return '(' + c + ' IS NULL OR ' + c + " = '')"; if (w.op === 'notempty') return '(' + c + ' IS NOT NULL AND ' + c + " <> '')";
            const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=', neq: '<>' }[w.op]; return numeric(w) + ' ' + sym + ' ' + lit(w.value); });
        for (const j of plan.joins) if (j.kind === 'anti') where.push(q(j.table) + '."_id" IS NULL');
        let sel, tail = '';
        if (plan.agg) { const a = plan.agg; const f = a.fn === 'count' ? (a.c ? 'COUNT(' + ref(a) + ')' : 'COUNT(DISTINCT ' + q(base.id) + '."_id")') : a.fn.toUpperCase() + '(CAST(' + ref(a) + ' AS REAL))'; sel = plan.group.map(ref).concat([f + ' AS ' + q({ count: '數量', sum: '總和', avg: '平均', max: '最大', min: '最小' }[a.fn])]).join(', '); if (plan.group.length) tail += ' GROUP BY ' + plan.group.map(ref).join(', ') + ' ORDER BY ' + q({ count: '數量', sum: '總和', avg: '平均', max: '最大', min: '最小' }[a.fn]) + (plan.order.length && plan.order[0].dir === 'asc' ? ' ASC' : ' DESC'); }
        else { sel = (plan.distinct ? 'DISTINCT ' : '') + plan.select.map(ref).join(', '); if (plan.order.length && plan.order[0].t) tail += ' ORDER BY ' + numeric(plan.order[0]) + ' ' + plan.order[0].dir.toUpperCase(); }
        if (plan.limit) tail += ' LIMIT ' + plan.limit;
        return 'SELECT ' + sel + '\nFROM ' + from.join('\n  ') + (where.length ? '\nWHERE ' + where.join('\n  AND ') : '') + tail + ';';
    }

    // ---------- 計畫的白話說明 ----------
    function explain(plan, P) {
        const base = tableOf(P, plan.from); const L = ['查「' + base.label + '」'];
        const opName = { eq: '等於', prefix: '開頭是', word: '含有完整的字', contains: '包含', gt: '大於', gte: '大於等於', lt: '小於', lte: '小於等於', neq: '不等於', empty: '是空的', notempty: '不是空的' };
        for (const w of plan.where) L.push(w.c + ' ' + opName[w.op] + (w.op === 'empty' || w.op === 'notempty' ? '' : '「' + w.value + '」'));
        for (const j of plan.joins) if (j.kind === 'anti') L.push('沒有任何「' + tableOf(P, j.table).label + '」資料');
        if (plan.agg) L.push((plan.group.length ? '依 ' + plan.group.map((g) => g.c).join('、') + ' 分組，' : '') + '算' + { count: '數量', sum: '總和', avg: '平均', max: '最大', min: '最小' }[plan.agg.fn] + (plan.agg.c ? '（' + plan.agg.c + '）' : ''));
        else L.push('顯示 ' + plan.select.map((s) => s.c).join('、') + (plan.order.length && plan.order[0].t ? '，依 ' + plan.order[0].c + (plan.order[0].dir === 'asc' ? ' 由小到大' : ' 由大到小') : '') + (plan.limit ? '，取前 ' + plan.limit + ' 筆' : ''));
        return L.join('；');
    }

    function fixJoins(plan, P) {
        const base = tableOf(P, plan.from); if (!base) return plan;
        const need = new Set([].concat(plan.where.map((w) => w.t), plan.select.map((s) => s.t), plan.group.map((g) => g.t), plan.agg && plan.agg.c ? [plan.agg.t] : [], plan.order.filter((o) => o.t).map((o) => o.t)));
        const antis = plan.joins.filter((j) => j.kind === 'anti' && tableOf(P, j.table) && tableOf(P, j.table).parent === base.id); const joins = antis.slice();
        for (const id of need) { if (id === base.id || joins.some((j) => j.table === id)) continue; const t = tableOf(P, id); if (!t) continue; if (t.parent === base.id) joins.push({ table: id, kind: 'child' }); else if (base.parent === id) joins.push({ table: id, kind: 'parent' }); }
        plan.joins = joins; return plan;
    }
    // ---------- 整條 ----------
    // input：JSON 資料、{sheets:[{name,columns,rows}]}、或 {columns,rows}。opts：{ generate, profile }
    async function answer(question, input, opts) {
        opts = opts || {}; const P = opts.profile || profile(input, opts);
        const b = buildPlan(question, P, opts);
        if (!b.ok) return { ok: false, error: b.error, need: b.need, options: b.options, profile: summarize(P) };
        let plan = b.plan; const assumptions = []; const decisions = [];
        for (const qu of b.questions) {
            let idx = 0, by = 'program';
            if (opts.generate && qu.options.length > 1) {
                const menu = qu.options.map((o, i) => letter(i) + '. ' + o.label).join('\n');
                const r = R ? await R.jsonStep({ generate: opts.generate, messages: [{ role: 'system', content: '你替使用者的資料查詢挑選最合適的選項。只輸出一個 JSON 物件，格式：{"choice": "字母"}，字母只能是選單裡有的。' }, { role: 'user', content: '使用者的問題：' + String(question).slice(0, 300) + '\n' + qu.text + '\n選單：\n' + menu }], maxTokens: 40, maxTries: opts.maxTries || 2, prefill: '{"choice":', validate: (o) => (pickIndex(o, qu.options.length) >= 0 ? [] : ['「choice」必須是選單裡的字母 A～' + letter(qu.options.length - 1)]) }) : { ok: false };
                if (r.ok) { idx = pickIndex(r.value, qu.options.length); by = 'model'; }
            }
            qu.options[idx].apply(plan); decisions.push({ id: qu.id, picked: qu.options[idx].label, by });
            assumptions.push(qu.text + ' → 用「' + qu.options[idx].label + '」' + (by === 'model' ? '（小模型挑的）' : '（程式的第一個猜測）') + (qu.options.length > 1 ? '；其他可能：' + qu.options.filter((_, i) => i !== idx).map((o) => o.label).join('、') : ''));
        }
        plan.where = plan.where.map((w) => { const c = Object.assign({}, w); delete c.pending; return c; });
        // 套了選擇之後，基本表或條件的表可能變了：重新算要接哪些表（沒有、或不是上下層的就丟掉，交給 check 說明）
        fixJoins(plan, P);
        const errs = check(plan, P); if (errs.length) return { ok: false, error: '查詢計畫沒有通過檢查：' + errs.join('；'), plan, assumptions };
        let res = run(plan, P, opts); const relaxed = [];
        if (!res.total && plan.where.some((w) => w.op === 'eq' || w.op === 'word')) { const p2 = Object.assign({}, plan, { where: plan.where.map((w) => ((w.op === 'eq' || w.op === 'word') && typeof w.value === 'string' ? Object.assign({}, w, { op: 'contains' }) : w)) }); const r2 = run(p2, P, opts); if (r2.total) { res = r2; plan = p2; relaxed.push('精確比對查不到，改成「包含」比對'); } }
        const near = []; if (!res.total) for (const w of plan.where) { if (w.op !== 'eq' && w.op !== 'contains' && w.op !== 'word') continue; const t = tableOf(P, w.t), c = t && colOf(t, w.c); if (!c || !c.values) continue; const cs = c.values.map((v) => ({ v, d: editDistance(lc(v), lc(w.value)) })).sort((a, b) => a.d - b.d).slice(0, 3).filter((x) => x.d <= Math.max(2, Math.floor(String(w.value).length / 3))); if (cs.length) near.push(w.c + ' 裡最接近「' + w.value + '」的值：' + cs.map((x) => x.v).join('、')); }
        const sql = toSql(plan, P);
        const text = (res.total ? '找到 ' + res.total + (plan.agg ? ' 列結果。' : ' 筆。') + (plan.limit && res.total > plan.limit ? '（只列前 ' + plan.limit + ' 筆）' : '') : '沒有符合的資料。') + '\n\n**我怎麼查的：**' + explain(plan, P) + (plan.notes && plan.notes.length ? '\n' + plan.notes.map((n) => '- ' + n).join('\n') : '') + (relaxed.length ? '\n- ' + relaxed.join('；') : '') + (assumptions.length ? '\n\n**我做的假設（不對請告訴我）：**\n' + assumptions.map((a) => '- ' + a).join('\n') : '') + (near.length ? '\n\n' + near.map((n) => '- ' + n).join('\n') : '') + '\n\n```sql\n' + sql + '\n```';
        return { ok: true, plan, sql, columns: res.columns, rows: res.rows, total: res.total, text, sheet: res.rows.length ? { columns: res.columns, rows: res.rows } : null, assumptions, decisions, relaxed, near, ranked: b.ranked };
    }
    function editDistance(a, b) { if (a === b) return 0; if (Math.abs(a.length - b.length) > 6) return 99; const dp = []; for (let i = 0; i <= a.length; i++) { dp[i] = [i]; } for (let j = 1; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; }
    function summarize(P) { return P.tables.map((t) => ({ table: t.label, rows: t.rows.length, parent: t.parent, columns: t.cols.map((c) => c.name + ':' + c.type) })); }

    return { GLOSSARY, profile, profileJson, profileSheets, buildPlan, check, run, toSql, explain, answer, summarize, expand, findValues, findCompares, detectOp, pickIndex };
});
