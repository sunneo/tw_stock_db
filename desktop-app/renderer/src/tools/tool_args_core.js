/* 工具參數消毒核心（UMD，純函式）：所有工具呼叫在進到工具之前，先依該工具的參數 schema 把「明顯是同一個意思、只是寫法不對」的參數整理好。
 * 2026-11-12 使用者：「參數消毒的部分，我希望是所有tool call都有做到」——簡報工具一再因為參數寫法出錯（chapters 放錯層、字串／陣列型別錯、跳脫字元）。
 * 原則：只做「不會改變意思」的整理，每一處都回報（fixes），絕不丟例外；整理不了就原樣交給工具（由工具自己的驗證報錯）。
 *  - parse      ：字串化的 JSON（含雙重字串化、```json 圍欄、BOM）→ 物件；{arguments/parameters/args/input:{…}} 外包一層且 schema 沒這個欄位 → 拆掉
 *  - 欄位名      ：大小寫／連字號／空白不同但正規化後唯一對應 schema 欄位 → 改成 schema 的名字
 *  - 型別        ："5"→5、"true"→true、5→"5"、'["a","b"]'→陣列、'{"k":1}'→物件、單一值→[值]（陣列欄位）、逗號／換行分隔→陣列（字串陣列欄位）
 *  - enum       ：大小寫或前後空白不同 → 換成標準值
 *  - 字串        ：去掉控制字元（保留換行、tab）與落單的代理對；null 且非必填 → 拿掉
 *  - stash      ：每次呼叫的整理後參數存進暫存（args_id），工具失敗時回 args_id，下一次可只送 {args_id, patch:{欄位:新值}}，不必整份重送
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaToolArgs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const WRAP = ['arguments', 'parameters', 'args', 'input'];
    const norm = (k) => String(k).toLowerCase().replace(/[\s_\-]+/g, '');
    function tryJson(s) { try { return { v: JSON.parse(s) }; } catch (_) { return null; } }
    function unfence(s) {
        let t = String(s).replace(/^﻿/, '').trim();
        const m = t.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/); if (m) t = m[1].trim();
        return t;
    }
    function parseArgs(raw, fixes) {
        if (raw && typeof raw === 'object') return raw;
        let t = unfence(raw == null ? '' : raw); if (t === '') return {};
        let r = tryJson(t); if (!r) return null;
        if (typeof r.v === 'string') { const r2 = tryJson(unfence(r.v)); if (r2) { r = r2; fixes.push('參數被字串化了兩次：已還原'); } }
        if (t !== String(raw).trim()) fixes.push('參數外面包了程式碼圍欄或雜字元：已去掉');
        return r.v;
    }
    function cleanStr(s) {
        let o = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
        o = o.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (m, p) => p || '');
        return o;
    }
    function typesOf(sc) { const t = sc && sc.type; return Array.isArray(t) ? t : (t ? [t] : []); }
    function coerce(v, sc, path, fixes, req) {
        if (!sc || typeof sc !== 'object') return v;
        const ts = typesOf(sc);
        if (v === null) { if (!req && !ts.includes('null')) { fixes.push(path + ' 是 null：已拿掉'); return undefined; } return v; }
        const has = (t) => ts.includes(t);
        if (typeof v === 'string') {
            if (has('string')) {
                let s = cleanStr(v); if (s !== v) fixes.push(path + ' 含控制字元：已去掉');
                if (Array.isArray(sc.enum) && !sc.enum.includes(s)) { const e = sc.enum.find((x) => typeof x === 'string' && x.trim().toLowerCase() === s.trim().toLowerCase()); if (e !== undefined) { fixes.push(path + ' 的值大小寫／空白不同：已換成 "' + e + '"'); s = e; } }
                return s;
            }
            const t = v.trim();
            if ((has('number') || has('integer')) && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) { const n = Number(t); if (!has('integer') || Number.isInteger(n)) { fixes.push(path + ' 是字串 "' + t.slice(0, 20) + '"：已轉成數字'); return n; } }
            if (has('boolean') && /^(true|false|yes|no|1|0)$/i.test(t)) { fixes.push(path + ' 是字串：已轉成布林'); return /^(true|yes|1)$/i.test(t); }
            if (has('array')) {
                if (t[0] === '[') { const r = tryJson(t); if (r && Array.isArray(r.v)) { fixes.push(path + ' 是字串化的陣列：已還原'); return r.v.map((x, i) => coerce(x, sc.items, path + '[' + i + ']', fixes, true)); } }
                const it = sc.items && typesOf(sc.items);
                if (it && it.includes('string') && /[,\n，、;；]/.test(t)) { fixes.push(path + ' 是用分隔符串起來的字串：已拆成陣列'); return t.split(/[,\n，、;；]+/).map((x) => x.trim()).filter(Boolean); }
                if (t !== '' && (!it || it.includes('string')) && !has('string')) { fixes.push(path + ' 是單一字串：已包成陣列'); return [t]; }
            }
            if (has('object') && t[0] === '{') { const r = tryJson(t); if (r && r.v && typeof r.v === 'object' && !Array.isArray(r.v)) { fixes.push(path + ' 是字串化的物件：已還原'); return coerceObj(r.v, sc, path, fixes); } }
            return v;
        }
        if (typeof v === 'number' || typeof v === 'boolean') {
            if (has('string') && !has('number') && !has('integer') && !has('boolean')) { fixes.push(path + ' 是' + typeof v + '：已轉成字串'); return String(v); }
            if (typeof v === 'number' && has('integer') && !has('number') && !Number.isInteger(v)) { fixes.push(path + ' 不是整數：已四捨五入'); return Math.round(v); }
            if (has('array') && !has('number') && !has('boolean') && typeof v !== 'string') { fixes.push(path + ' 是單一值：已包成陣列'); return [v]; }
            return v;
        }
        if (Array.isArray(v)) {
            if (has('array')) return v.map((x, i) => coerce(x, sc.items, path + '[' + i + ']', fixes, true));
            if (has('string') && v.every((x) => typeof x === 'string')) { fixes.push(path + ' 是陣列但這個欄位要字串：已用換行接起來'); return v.join('\n'); }
            return v;
        }
        if (typeof v === 'object') {
            if (has('object') || sc.properties) return coerceObj(v, sc, path, fixes);
            if (has('array') && !has('object')) { fixes.push(path + ' 是單一物件：已包成陣列'); return [coerce(v, sc.items, path + '[0]', fixes, true)]; }
        }
        return v;
    }
    function coerceObj(o, sc, path, fixes) {
        const props = (sc && sc.properties) || null; if (!props) return o;
        const out = {}, byNorm = {}; for (const k of Object.keys(props)) byNorm[norm(k)] = k;
        const req = new Set((sc && sc.required) || []);
        for (const k of Object.keys(o)) {
            let key = k;
            if (!(k in props)) { const m = byNorm[norm(k)]; if (m && !(m in o) && !(m in out)) { fixes.push((path ? path + '.' : '') + k + ' 欄位名寫法不同：已改成 ' + m); key = m; } }
            const val = coerce(o[k], props[key], (path ? path + '.' : '') + key, fixes, req.has(key));
            if (val !== undefined) out[key] = val;
        }
        return out;
    }
    // 主函式：schema 可為空（只做 parse 與外包拆除）。回 { args(物件), raw(字串), fixes, parsed(是否解析成功) }
    function sanitize(schema, rawArgs) {
        const fixes = [];
        try {
            let a = parseArgs(rawArgs, fixes);
            if (a == null || typeof a !== 'object' || Array.isArray(a)) return { args: a, raw: rawArgs, fixes, parsed: false };
            const props = (schema && schema.properties) || {};
            for (let i = 0; i < 2; i++) { // 外包一層：{arguments:{…}}
                const ks = Object.keys(a);
                if (ks.length === 1 && WRAP.includes(ks[0]) && !(ks[0] in props)) {
                    let inner = a[ks[0]]; if (typeof inner === 'string') { const r = tryJson(unfence(inner)); if (r) inner = r.v; }
                    if (inner && typeof inner === 'object' && !Array.isArray(inner)) { fixes.push('參數外面多包了一層 "' + ks[0] + '"：已拆掉'); a = inner; continue; }
                }
                break;
            }
            if (schema && schema.properties) a = coerceObj(a, schema, '', fixes);
            return { args: a, raw: fixes.length || typeof rawArgs !== 'string' ? JSON.stringify(a) : rawArgs, fixes, parsed: true };
        } catch (e) { return { args: null, raw: rawArgs, fixes: [], parsed: false }; }
    }
    // 暫存：args_id → 整理後的參數物件（每個工具的最近幾份）
    function createStash(max) {
        const m = new Map(); let n = 0; max = max || 60;
        return {
            put(tool, args) { const id = 'a' + (++n); m.set(id, { tool, args }); while (m.size > max) m.delete(m.keys().next().value); return id; },
            get(id) { return m.get(String(id)) || null; },
            // 若這次的參數是 {args_id, patch} → 取回暫存、合併；回 { args, note } 或 { error }
            resolve(tool, a) {
                if (!a || typeof a !== 'object' || !a.args_id) return { args: a };
                const e = m.get(String(a.args_id)); if (!e) return { error: '不認得 args_id ' + JSON.stringify(String(a.args_id)) + '（這個任務裡沒有存過）：請把完整參數重送一次' };
                if (e.tool !== tool) return { error: 'args_id ' + a.args_id + ' 是 ' + e.tool + ' 的參數，不是 ' + tool };
                const merged = Object.assign({}, e.args, a.patch && typeof a.patch === 'object' ? a.patch : {});
                const rest = Object.assign({}, a); delete rest.args_id; delete rest.patch; Object.assign(merged, rest);
                return { args: merged, note: '用暫存的參數 ' + a.args_id + ' 合併你送的修改' };
            },
        };
    }
    function failureHint(id) { return '你的參數已存成 args_id "' + id + '"。不要整份重送：用 {"args_id":"' + id + '","patch":{"要改的欄位":"新值"}} 只改有問題的欄位（跳脫字元的問題也就不會再出現）。'; }
    return { sanitize, createStash, failureHint, norm };
});
