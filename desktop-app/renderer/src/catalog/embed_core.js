/* 單元的神經嵌入檢索（UMD，純函式，不碰模型、DOM、網路）：模型本身（multilingual-e5-small）在頁面端載入，這裡只管
 * ① 單元文字怎麼組（名稱＋說明＋必填參數＋中文用途說明）、② 向量怎麼打包存檔（Float32 → base64，附文字雜湊，單元文字變了就失效）、
 * ③ 餘弦排名、④ 跟 BM25 的排名融合（RRF）。實測依據見 DESIGN.unit-catalog.md 第二十二節：加上中文用途說明時，融合讓
 * 第 1 名 73.7% → 84.2%、前 5 名 92.1% → 97.4%（38 題，樣本小）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogEmbed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MODEL = { repo: 'Xenova/multilingual-e5-small', dtype: 'q8', dim: 384, approxMB: 118, queryPrefix: 'query: ', passagePrefix: 'passage: ' };

    // ===== 單元 → 文字 =====
    // 名稱（底線、點換成空白）＋說明＋必填參數名稱＋中文用途說明（沒有就不接）
    function docText(u, intent) {
        const name = String(u.name || '').replace(/^[a-z]+:/, '').replace(/[._]/g, ' '); const ps = (u.params || []).filter((p) => p.required).map((p) => String(p.name).replace(/_/g, ' ')).join(', ');
        return name + '. ' + (u.summary || '') + (ps ? ' (' + ps + ')' : '') + (intent ? ' ' + intent : '');
    }
    function hash(s) { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

    // ===== 向量存檔：{ model, dim, items: { 單元id: { h: 文字雜湊, v: base64 } } } =====
    function pack(vec) { const f = vec instanceof Float32Array ? vec : Float32Array.from(vec); const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); }
    function unpack(b64) { const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Float32Array(u8.buffer); }
    function emptyStore() { return { version: 1, model: MODEL.repo, dtype: MODEL.dtype, dim: MODEL.dim, items: {} }; }
    // 哪些單元需要（重新）嵌入：沒有向量、或文字雜湊變了
    function pending(store, units, intents) {
        const out = []; for (const u of units) { const t = docText(u, intents && intents[u.id]); const e = store && store.items && store.items[u.id]; const h = hash(t); if (!e || e.h !== h) out.push({ id: u.id, text: t, h }); } return out;
    }
    function putMany(store, items, vecs) { items.forEach((it, i) => { store.items[it.id] = { h: it.h, v: pack(vecs[i]) }; }); return store; }
    // 取出目前有效的向量 Map（id → Float32Array），文字雜湊對不上的略過；也順便清掉已不在目錄裡的
    function vectorsFor(store, units, intents) {
        const m = new Map(); if (!store || !store.items) return m; for (const u of units) { const e = store.items[u.id]; if (!e) continue; if (e.h !== hash(docText(u, intents && intents[u.id]))) continue; m.set(u.id, unpack(e.v)); } return m;
    }
    function coverage(store, units, intents) { const n = units.length; const ok = vectorsFor(store, units, intents).size; return { units: n, embedded: ok, pct: n ? Math.round((ok / n) * 1000) / 10 : 0 }; }

    // ===== 排名 =====
    function dot(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
    function normalize(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; }
    // 向量都已正規化時，內積＝餘弦
    function rankDense(qvec, vecs, k) { const out = []; for (const [id, v] of vecs) out.push({ id, score: dot(qvec, v) }); out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)); return out.slice(0, k || out.length); }
    // 倒數排名融合：每個清單裡排第 r 名（從 0）得 1/(k+r+1)，加總
    function rrf(lists, k) { k = k || 60; const m = new Map(); for (const l of lists) l.forEach((x, r) => { const e = m.get(x.id) || { id: x.id, score: 0, ranks: [] }; e.score += 1 / (k + r + 1); e.ranks.push(r + 1); if (x.u) e.u = x.u; m.set(x.id, e); }); return Array.from(m.values()).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)); }

    return { MODEL, docText, hash, pack, unpack, emptyStore, pending, putMany, vectorsFor, coverage, dot, normalize, rankDense, rrf };
});
