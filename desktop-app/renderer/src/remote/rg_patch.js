/* 遠端共筆的「patch」同步模式（UMD、純函式）。設計見 DESIGN.edit-remote.md §6：沒有封閉動作集、但文件是「以 id 定址的 JSON」的編輯器（video 的專案、webedit 的檔案集）
 * 用結構差異當一筆 commit：
 *   FaRemotePatch.diff(a, b, keys) → ops        keys：{ 路徑名: 鍵欄位 }，沒列的陣列若每個元素都是有 id 的物件就用 'id'，否則整個陣列當一個值
 *   FaRemotePatch.apply(doc, ops, keys) → { doc, applied, rejected:[{op,error}], conflicts:[路徑] }   不改傳入的 doc；對象不存在就略過並回報（同 applyEdits 的 rejected）
 *   FaRemotePatch.merge3(base, mine, theirs) → { text, conflict }   逐行 diff3：沒重疊的修改都保留，重疊的以 theirs（後到者）為準並標 conflict
 * ops：{op:'set', at, value} | {op:'del', at} | {op:'ins', at, value, after} | {op:'order', at, ids} | {op:'text', at, base, value}
 * at：路徑陣列，元素是物件鍵（字串）或 {id: 值}（有鍵的陣列元素；鍵欄位名稱記在 {k:'name', v:值}）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemotePatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
    const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const TEXT_MIN = 80;   // 字串夠長或有換行才用文字合併；短字串直接 set
    // 這個陣列有沒有鍵：keys 用路徑名（最後一段的鍵名）指定；沒指定就看是不是「每個元素都是有 id 的物件且不重複」
    function keyOf(arr, name, keys) {
        const k = keys && keys[name] ? keys[name] : 'id';
        if (!arr.length) return keys && keys[name] ? k : null;
        const seen = new Set(); for (const e of arr) { if (!isObj(e) || e[k] === undefined || e[k] === null || seen.has(e[k])) return null; seen.add(e[k]); }
        return k;
    }
    // ───────── diff
    function diff(a, b, keys) {
        const ops = []; walk(a, b, [], '', keys || {}, ops); return ops;
    }
    function walk(a, b, at, name, keys, ops) {
        if (eq(a, b)) return;
        if (isObj(a) && isObj(b)) {
            for (const k of Object.keys(a)) if (!(k in b)) ops.push({ op: 'del', at: at.concat([k]) });
            for (const k of Object.keys(b)) { if (!(k in a)) ops.push({ op: 'set', at: at.concat([k]), value: clone(b[k]) }); else walk(a[k], b[k], at.concat([k]), k, keys, ops); }
            return;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            const ka = keyOf(a, name, keys), kb = keyOf(b, name, keys);
            if (ka && kb && ka === kb) { diffKeyed(a, b, at, name, ka, keys, ops); return; }
        }
        if (typeof a === 'string' && typeof b === 'string' && (a.length >= TEXT_MIN || a.indexOf('\n') >= 0 || b.indexOf('\n') >= 0)) { ops.push({ op: 'text', at, base: a, value: b }); return; }
        ops.push({ op: 'set', at, value: clone(b) });
    }
    function diffKeyed(a, b, at, name, k, keys, ops) {
        const ia = new Map(a.map((e) => [e[k], e])), ib = new Map(b.map((e) => [e[k], e]));
        for (const e of a) if (!ib.has(e[k])) ops.push({ op: 'del', at: at.concat([{ k, v: e[k] }]) });
        let prev = null;
        for (const e of b) { if (!ia.has(e[k])) ops.push({ op: 'ins', at, k, value: clone(e), after: prev }); prev = e[k]; }
        for (const e of b) if (ia.has(e[k])) walk(ia.get(e[k]), e, at.concat([{ k, v: e[k] }]), name, keys, ops);
        const common = (arr) => arr.filter((e) => ib.has(e[k]) && ia.has(e[k])).map((e) => e[k]);
        if (!eq(common(a), common(b))) ops.push({ op: 'order', at, k, ids: b.map((e) => e[k]) });
    }
    // ───────── apply
    function step(node, seg) {
        if (typeof seg === 'string') return isObj(node) ? { parent: node, key: seg, val: node[seg], ok: true } : { ok: false };
        if (!Array.isArray(node)) return { ok: false };
        const i = node.findIndex((e) => isObj(e) && e[seg.k] === seg.v); return i < 0 ? { ok: false } : { parent: node, key: i, val: node[i], ok: true, arr: true };
    }
    function resolve(doc, at) {   // 回傳 at 指到的「父節點與鍵」；中間找不到就 null
        let node = doc;
        for (let i = 0; i < at.length - 1; i++) { const s = step(node, at[i]); if (!s.ok || s.val === undefined) return null; node = s.val; }
        return { node };
    }
    function apply(doc0, ops, keys) {
        const doc = clone(doc0), applied = [], rejected = [], conflicts = [];
        for (const op of ops || []) {
            try {
                if (op.op === 'ins') {
                    const r = op.at.length ? resolveFull(doc, op.at) : { val: doc, ok: true }; if (!r.ok || !Array.isArray(r.val)) { rejected.push({ op: 'ins', error: '找不到要插入的陣列' }); continue; }
                    const arr = r.val, ex = arr.findIndex((e) => isObj(e) && e[op.k] === op.value[op.k]); if (ex >= 0) { arr[ex] = clone(op.value); applied.push(op); continue; }
                    const ai = op.after == null ? -1 : arr.findIndex((e) => isObj(e) && e[op.k] === op.after); arr.splice(ai < 0 ? (op.after == null ? 0 : arr.length) : ai + 1, 0, clone(op.value)); applied.push(op); continue;
                }
                if (op.op === 'order') {
                    const r = op.at.length ? resolveFull(doc, op.at) : { val: doc, ok: true }; if (!r.ok || !Array.isArray(r.val)) { rejected.push({ op: 'order', error: '找不到要排序的陣列' }); continue; }
                    const arr = r.val, pos = new Map(op.ids.map((id, i) => [id, i])); const known = arr.filter((e) => pos.has(e[op.k])).sort((x, y) => pos.get(x[op.k]) - pos.get(y[op.k])), rest = arr.filter((e) => !pos.has(e[op.k]));
                    arr.length = 0; known.concat(rest).forEach((e) => arr.push(e)); applied.push(op); continue;
                }
                const last = op.at[op.at.length - 1], par = op.at.length > 1 ? resolveFull(doc, op.at.slice(0, -1)) : { val: doc, ok: true };
                if (!par.ok) { rejected.push({ op: op.op, error: '對象已經不存在了' }); continue; }
                const P = par.val;
                if (typeof last === 'string') {
                    if (!isObj(P)) { rejected.push({ op: op.op, error: '父層不是物件' }); continue; }
                    if (op.op === 'del') { delete P[last]; applied.push(op); }
                    else if (op.op === 'set') { P[last] = clone(op.value); applied.push(op); }
                    else if (op.op === 'text') { const cur = P[last]; const r = textApply(cur, op); if (r.conflict) conflicts.push(op.at.map((x) => (typeof x === 'string' ? x : x.v)).join('/')); P[last] = r.text; applied.push(op); }
                } else {   // 最後一段是「有鍵的陣列元素」
                    if (!Array.isArray(P)) { rejected.push({ op: op.op, error: '父層不是陣列' }); continue; }
                    const i = P.findIndex((e) => isObj(e) && e[last.k] === last.v);
                    if (op.op === 'del') { if (i >= 0) P.splice(i, 1); applied.push(op); }
                    else if (i < 0) { rejected.push({ op: op.op, error: '這一項已經被刪掉了' }); }
                    else if (op.op === 'set') { P[i] = clone(op.value); applied.push(op); }
                    else if (op.op === 'text') { rejected.push({ op: 'text', error: '文字不能直接放在陣列元素上' }); }
                }
            } catch (e) { rejected.push({ op: op && op.op, error: String((e && e.message) || e) }); }
        }
        return { doc, applied, rejected, conflicts };
    }
    function resolveFull(doc, at) { let node = doc; for (const seg of at) { const s = step(node, seg); if (!s.ok || s.val === undefined) return { ok: false }; node = s.val; } return { ok: true, val: node }; }
    function textApply(cur, op) {
        if (typeof cur !== 'string') return { text: op.value, conflict: false };
        if (cur === op.base) return { text: op.value, conflict: false };
        if (cur === op.value) return { text: cur, conflict: false };
        const m = merge3(op.base, cur, op.value); return { text: m.text, conflict: m.conflict };
    }
    // ───────── 逐行 diff3
    function lcsHunks(a, b) {   // a→b 的修改區塊：[{ s, e, lines }]（取代 a[s..e) 為 lines）
        const n = a.length, m = b.length; let p = 0; while (p < n && p < m && a[p] === b[p]) p++;
        let q = 0; while (q < n - p && q < m - p && a[n - 1 - q] === b[m - 1 - q]) q++;
        const A = a.slice(p, n - q), B = b.slice(p, m - q); if (!A.length && !B.length) return [];
        if (A.length * B.length > 4e6) return [{ s: p, e: n - q, lines: B }];   // 太大：整段當一個修改
        const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
        for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        const hunks = []; let i = 0, j = 0, cur = null;
        const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
        while (i < A.length || j < B.length) {
            if (i < A.length && j < B.length && A[i] === B[j]) { flush(); i++; j++; }
            else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { if (!cur) cur = { s: p + i, e: p + i, lines: [] }; cur.lines.push(B[j]); j++; }
            else { if (!cur) cur = { s: p + i, e: p + i, lines: [] }; cur.e = p + i + 1; i++; }
        }
        flush(); return hunks;
    }
    function merge3(base, mine, theirs) {
        base = String(base == null ? '' : base); mine = String(mine == null ? '' : mine); theirs = String(theirs == null ? '' : theirs);
        if (mine === base) return { text: theirs, conflict: false }; if (theirs === base || mine === theirs) return { text: mine, conflict: false };
        const bl = base.split('\n'), hm = lcsHunks(bl, mine.split('\n')), ht = lcsHunks(bl, theirs.split('\n'));
        const out = []; let pos = 0, conflict = false, im = 0, it = 0;
        const overlap = (x, y) => x.s < y.e && y.s < x.e || (x.s === y.s && x.e === y.e) || (x.s === x.e && y.s === y.e && x.s === y.s) || (x.s === x.e && y.s < x.s && x.s < y.e) || (y.s === y.e && x.s < y.s && y.s < x.e);
        while (im < hm.length || it < ht.length) {
            const a = hm[im], b = ht[it];
            let h, from;
            if (a && b && overlap(a, b)) {   // 重疊：以 theirs（後到者）為準
                conflict = true; const s = Math.min(a.s, b.s); let e = Math.max(a.e, b.e);
                while (im + 1 < hm.length && hm[im + 1].s < e) { e = Math.max(e, hm[++im].e); } while (it + 1 < ht.length && ht[it + 1].s < e) { e = Math.max(e, ht[++it].e); }
                for (; pos < s; pos++) out.push(bl[pos]); out.push(...b.lines); pos = e; im++; it++; continue;
            }
            if (a && (!b || a.s <= b.s)) { h = a; im++; } else { h = b; it++; }
            for (; pos < h.s; pos++) out.push(bl[pos]); out.push(...h.lines); pos = Math.max(pos, h.e);
        }
        for (; pos < bl.length; pos++) out.push(bl[pos]);
        return { text: out.join('\n'), conflict };
    }
    return { diff, apply, merge3, keyOf };
});
