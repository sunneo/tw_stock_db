/* 歷史呼叫逆向推論器（UMD，純函式，不碰 DOM／網路）：從過去「成功的工具呼叫」留下的實際回傳值，反推回傳的 JSON 結構，
 * 把單元目錄裡「回傳型別不明（json／any，或欄位只有 any）」的單元補成具體型別（type_src:'observed'）。
 * 資料來源兩種：
 *   ① 對話紀錄：assistant 的 tool_calls ＋ 後面 role:'tool' 的完整回傳 JSON（完整樣本，可以長出巢狀結構與清單元素型別）
 *   ② 離線訓練器的 turns：calls[].res 只有第一層的純量欄位（部分樣本，只能確認那幾個欄位的型別，不能判斷「沒有其他欄位」）
 * 規則：失敗的呼叫（ok:false、有 error）不採用；多次樣本合併（int＋number→number、字串細分型別退回共同上層、缺的欄位標成選填、
 * 衝突不大的聯集、太雜就退回 any）；樣本數與選填欄位記在 returns 上，規劃時可以看信心。模型不參與。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogShape = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';
    const MAX_FIELDS = 16, MAX_DEPTH = 3, MAX_ELEMS = 20;
    // 具體型別 → 上一層（跟 catalog_core 的 SPECIAL 一致）
    const PARENT = { path: 'text', url: 'text', file_id: 'text', yaml: 'text', code: 'text', query: 'text', pdf_file: 'file_id', video_file: 'file_id', audio_file: 'file_id', image_file: 'file_id', gif_file: 'image_file', subtitle_file: 'file_id' };
    const chain = (k) => { const c = [k]; while (PARENT[c[c.length - 1]]) c.push(PARENT[c[c.length - 1]]); return c; };
    const isTextFamily = (k) => k === 'text' || !!PARENT[k] && chain(k).includes('text');
    function commonText(a, b) { const ca = chain(a); for (const x of chain(b)) if (ca.includes(x)) return x; return 'text'; }
    const SPECIAL_BY_KEY = new Set(Object.keys(PARENT));

    // ===== 單一值 → 型別樹 =====
    function typeOfValue(v, key, depth) {
        depth = depth || 0;
        if (v === null || v === undefined) return { k: 'null' };
        if (typeof v === 'boolean') return { k: 'bool' };
        if (typeof v === 'number') return { k: Number.isInteger(v) ? 'int' : 'number' };
        if (typeof v === 'string') {
            if (/^https?:\/\/\S+$/i.test(v)) return { k: 'url' };
            const hint = key ? Cat.fieldType(key) : 'any';
            if (v && SPECIAL_BY_KEY.has(hint) && hint !== 'query') { if (hint === 'path' && /[\r\n]/.test(v)) return { k: 'text' }; if (hint === 'url' && !/^https?:\/\//i.test(v)) return { k: 'text' }; return { k: hint }; }
            return { k: 'text' };
        }
        if (Array.isArray(v)) {
            if (!v.length) return { k: 'list', of: { k: 'unknown' } };
            if (depth >= MAX_DEPTH) return { k: 'list', of: { k: 'any' } };
            let el = null; for (const x of v.slice(0, MAX_ELEMS)) { const t = typeOfValue(x, key && key.replace(/s$/, ''), depth + 1); el = el ? merge(el, t) : t; } return { k: 'list', of: el };
        }
        if (typeof v === 'object') {
            const ks = Object.keys(v); if (!ks.length) return { k: 'dict' };
            if (ks.length > MAX_FIELDS || depth >= MAX_DEPTH) return { k: 'dict' };
            const fields = {}; const opt = {}; for (const k of ks) { if (!/^[A-Za-z_][\w]*$/.test(k)) return { k: 'dict' }; fields[k] = typeOfValue(v[k], k, depth + 1); } return { k: 'object', fields, opt };
        }
        return { k: 'any' };
    }

    // ===== 合併兩個型別樹（兩個樣本看到的型別）=====
    function unionOf(a, b) {
        const items = []; const add = (t) => { if (t.k === 'union') t.of.forEach(add); else if (!items.some((x) => Cat.typeToString(x) === Cat.typeToString(t))) items.push(t); }; add(a); add(b);
        if (items.length > 3) return { k: 'any' }; return items.length === 1 ? items[0] : { k: 'union', of: items };
    }
    function merge(a, b) {
        if (a.k === 'unknown') return b; if (b.k === 'unknown') return a;
        if (a.k === 'null') return b.k === 'null' ? a : Object.assign({}, b, { nullable: true }); if (b.k === 'null') return Object.assign({}, a, { nullable: true });
        const nul = !!(a.nullable || b.nullable); const done = (t) => (nul ? Object.assign(t, { nullable: true }) : t);
        if (a.k === b.k) {
            if (a.k === 'list') return done({ k: 'list', of: merge(a.of, b.of) });
            if (a.k === 'object') {
                const fields = {}; const opt = {}; const ks = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
                for (const k of ks) { const fa = a.fields[k], fb = b.fields[k]; fields[k] = fa && fb ? merge(fa, fb) : (fa || fb); if (!fa || !fb || (a.opt && a.opt[k]) || (b.opt && b.opt[k])) opt[k] = true; }
                return done({ k: 'object', fields, opt });
            }
            if (a.k === 'union' || a.k === 'enum') return done(unionOf(a, b));
            return done({ k: a.k });
        }
        if ((a.k === 'int' && b.k === 'number') || (a.k === 'number' && b.k === 'int')) return done({ k: 'number' });
        if (isTextFamily(a.k) && isTextFamily(b.k)) return done({ k: commonText(a.k, b.k) });
        if (a.k === 'object' && b.k === 'dict') return done({ k: 'dict' }); if (a.k === 'dict' && b.k === 'object') return done({ k: 'dict' });
        return done(unionOf(a, b));
    }
    // 部分樣本（只有第一層純量欄位）：只更新已知的那幾個欄位，不新增「必有」也不標選填
    function mergePartial(a, partialFields) {
        if (a.k !== 'object') return a; const fields = Object.assign({}, a.fields); const opt = Object.assign({}, a.opt || {});
        for (const [k, v] of Object.entries(partialFields)) { const t = (v && typeof v === 'object' && typeof v.k === 'string') ? v : typeOfValue(v, k, 1); if (fields[k]) fields[k] = merge(fields[k], t); else { fields[k] = t; opt[k] = true; } }
        return Object.assign({}, a, { fields, opt });
    }

    // ===== 型別樹 → 型別字串（跟 catalog_core 的語法一致；unknown 退成 any）=====
    function toTypeString(t) {
        if (!t) return 'any'; const strip = (x) => {
            if (x.k === 'unknown' || x.k === 'null') return { k: 'any' };
            if (x.k === 'list') return { k: 'list', of: strip(x.of) };
            if (x.k === 'object') { const f = {}; for (const [k, v] of Object.entries(x.fields)) f[k] = strip(v); return { k: 'object', fields: f }; }
            if (x.k === 'union') return { k: 'union', of: x.of.map(strip) };
            return x;
        };
        try { return Cat.typeToString(strip(t)); } catch (_) { return 'any'; }
    }
    const isLoose = (t) => !t || t.k === 'any' || t.k === 'unknown' || t.k === 'json' || t.k === 'dict' || t.k === 'null';

    // ===== 取樣本 =====
    const failed = (j) => !!j && typeof j === 'object' && !Array.isArray(j) && (j.ok === false || (typeof j.error === 'string' && j.error) || (j.error && typeof j.error === 'object'));
    function parseResult(c) { if (c && typeof c === 'object') return { value: c }; try { const j = JSON.parse(String(c)); return j !== null && typeof j === 'object' ? { value: j } : { scalar: j }; } catch (_) { return null; } }
    // messages: OpenAI 風格的對話紀錄；回傳 [{ tool, value, args }]
    function samplesFromMessages(messages) {
        const out = []; const byId = new Map();
        for (const m of messages || []) {
            if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { const name = tc && tc.function && tc.function.name; if (name && tc.id) byId.set(tc.id, { name, args: tc.function.arguments }); }
            else if (m && m.role === 'tool' && m.tool_call_id && byId.has(m.tool_call_id)) { const c = byId.get(m.tool_call_id); const r = parseResult(m.content); if (!r || r.scalar !== undefined || failed(r.value)) continue; out.push({ tool: c.name, value: r.value }); }
        }
        return out;
    }
    // turns: 離線訓練器的 turns（calls[].res 只有第一層純量）；回傳部分樣本 [{ tool, partial:{…} }]
    function samplesFromTurns(turns) {
        const out = []; for (const t of turns || []) for (const c of (t && t.calls) || []) { if (!c || c.ok === false || !c.res || typeof c.res !== 'object' || failed(c.res)) continue; if (!Object.keys(c.res).length) continue; out.push({ tool: c.name, partial: c.res }); }
        return out;
    }

    // ===== 推論：樣本 → 每個工具的型別 =====
    // 狀態（可以直接 JSON 存檔、下次接著累積）：{ [tool]: { tree, full, partial, pend:[部分樣本最近幾筆] } }
    const MAX_PEND = 30;
    function accumulate(state, samples) {
        state = state || {};
        for (const s of samples || []) {
            if (!s || !s.tool) continue; const e = state[s.tool] || (state[s.tool] = { tree: null, full: 0, partial: 0, pend: [] });
            if (s.value !== undefined) { const t = typeOfValue(s.value, null, 0); e.tree = e.tree ? merge(e.tree, t) : t; e.full++; } else if (s.partial) { e.partial++; e.pend.push(Object.fromEntries(Object.entries(s.partial).map(([k, v]) => [k, typeOfValue(v, k, 1)]))); if (e.pend.length > MAX_PEND) e.pend.shift(); }
        }
        return state;
    }
    // 回傳 { [tool]: { type, samples, partial_samples, optional:[欄位], conflicts:[欄位], nullable:[欄位], loose } }
    function summarize(state) {
        const res = {};
        for (const [tool, e] of Object.entries(state || {})) {
            let tree = e.tree;
            if (!tree && e.pend.length) { tree = { k: 'object', fields: {}, opt: {} }; for (const p of e.pend) tree = mergePartial(tree, p); for (const k of Object.keys(tree.fields)) tree.opt[k] = true; } else if (tree) for (const p of e.pend) tree = mergePartial(tree, p);
            if (!tree) continue; const optional = [], conflicts = [], nullable = [];
            if (tree.k === 'object') for (const [k, v] of Object.entries(tree.fields)) { if (tree.opt && tree.opt[k]) optional.push(k); if (v.k === 'union') conflicts.push(k); if (v.nullable) nullable.push(k); }
            res[tool] = { type: toTypeString(tree), samples: e.full, partial_samples: e.partial, optional, conflicts, nullable, loose: isLoose(tree) };
        }
        return res;
    }
    function infer(samples) { return summarize(accumulate({}, samples)); }

    // ===== 套進單元目錄：只補「不明」的，不蓋掉文件寫的／人工補的 =====
    // 規則：returns 是 json／any（type_src:none）→ 整個換成觀察到的；是 doc／name 推的 object，且某些欄位只有 any／list<any> → 只換那些欄位
    // 要求至少 minSamples 次完整樣本（部分樣本只能補欄位，不能憑空決定整個型別）。
    function refineReturns(unit, obs, opts) {
        opts = Object.assign({ minSamples: 1 }, opts || {}); const cur = unit.returns || { type: 'any', type_src: 'none' }; if (!obs || obs.loose) return null;
        if (cur.type_src === 'curated' || cur.type_src === 'probe' || cur.type_src === 'annotation' || cur.type_src === 'stub') return null;
        const ct = Cat.parseType(cur.type); const ot = Cat.parseType(obs.type);
        if (ct.k === 'json' || ct.k === 'any' || ct.k === 'dict') { if (obs.samples < opts.minSamples) return null; return { type: obs.type, type_src: 'observed', samples: obs.samples, optional: obs.optional }; }
        if (ct.k === 'object' && ot.k === 'object') {
            const fields = Object.assign({}, ct.fields); let changed = 0;
            for (const [k, ft] of Object.entries(ct.fields)) { const o = ot.fields[k]; if (!o) continue; const loose = ft.k === 'any' || (ft.k === 'list' && (ft.of.k === 'any' || ft.of.k === 'json')) || ft.k === 'dict'; if (loose && !(o.k === 'any' || o.k === 'dict' && ft.k === 'dict') && Cat.typeToString(o) !== Cat.typeToString(ft)) { fields[k] = o; changed++; } }
            if (!changed) return null; return { type: Cat.typeToString({ k: 'object', fields }), type_src: cur.type_src === 'doc' ? 'doc' : cur.type_src, samples: obs.samples, refined_fields: changed, optional: obs.optional };
        }
        return null;
    }
    // 產生 overrides：{ 工具名稱: { type, type_src:'observed', samples, optional } }，給 buildCatalog 的 returnsOverrides
    function buildOverrides(units, observed, opts) {
        const out = {}; const report = { refined: [], skipped_loose: [], no_samples: [], unchanged: 0 };
        for (const u of units || []) {
            if (u.runtime !== 'app') continue; const obs = observed[u.name]; const cur = u.returns || {}; const unknown = cur.type === 'json' || cur.type === 'any' || cur.type === 'dict';
            if (!obs) { if (unknown) report.no_samples.push(u.name); continue; }
            if (obs.loose) { if (unknown) report.skipped_loose.push(u.name); continue; }
            const r = refineReturns(u, obs, opts); if (r) { out[u.name] = r; report.refined.push({ name: u.name, from: cur.type, to: r.type, samples: r.samples }); } else report.unchanged++;
        }
        return { overrides: out, report };
    }

    return { typeOfValue, merge, mergePartial, toTypeString, samplesFromMessages, samplesFromTurns, accumulate, summarize, infer, refineReturns, buildOverrides };
});
