'use strict';
/* 訓練交換空間（網頁版逐層訓練用，DESIGN.TODO.offline-training-studio.md §5.6）。
 *  為什麼要有：WebAssembly 只有 4GB 位址空間；逐層引擎把每層的圖（含該層凍結權重，約 15MB）存在這裡，
 *  需要時才取出建立工作階段，用完釋放，所以 WASM 記憶體只需容納「一層」。
 *  和 aiDoc 的 FileCache／KVStore 不同的地方（刻意）：
 *   - 專屬資料庫與物件庫（fa-train-swap），不和專案索引共用；
 *   - 沒有 LRU 淘汰：訓練中的層圖被悄悄淘汰會讓訓練在下一步失敗或用錯權重；
 *   - 有明確配額，超過就丟 SwapFullError（帶用量與配額）並停止，不靜默遺失；
 *   - 每筆記錄帶長度與 FNV-1a 校驗，讀回不符就丟 SwapCorruptError。
 *  後端：createIdbSwap({indexedDB, quotaBytes})（瀏覽器）與 createMemorySwap({quotaBytes})（測試／無 IndexedDB 時）。 */

class SwapFullError extends Error { constructor(used, add, quota) { super('交換空間已滿：已用 ' + mb(used) + '，要再存 ' + mb(add) + '，配額 ' + mb(quota) + '。訓練已停止（不會悄悄淘汰舊資料）；請調大配額或清理交換空間'); this.name = 'SwapFullError'; this.used = used; this.add = add; this.quota = quota; } }
class SwapCorruptError extends Error { constructor(key) { super('交換空間資料損毀：' + key + '（長度或校驗不符），請清理後重建'); this.name = 'SwapCorruptError'; this.key = key; } }
const mb = (x) => (x / 1048576).toFixed(0) + 'MB';
function fnv1a(u8) { let h = 0x811c9dc5; const step = u8.length > 4194304 ? 17 : 1; for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; } return (h ^ u8.length) >>> 0; }   // 大檔抽樣校驗（每 17 位元組取 1），小檔全檢；目的是抓截斷與寫壞，不是密碼學

function createMemorySwap(o) {
    o = o || {}; const quota = o.quotaBytes || 4 * 1073741824, m = new Map(); let used = 0; const stats = { puts: 0, gets: 0, deletes: 0, putMs: 0, getMs: 0 };
    return {
        kind: 'memory', stats, quota,
        async put(key, u8) { const t0 = Date.now(); const old = m.get(key); const delta = u8.length - (old ? old.u8.length : 0); if (used + delta > quota) throw new SwapFullError(used, delta, quota); m.set(key, { u8: Uint8Array.from(u8), sum: fnv1a(u8) }); used += delta; stats.puts++; stats.putMs += Date.now() - t0; },
        async get(key) { const t0 = Date.now(); const r = m.get(key); stats.gets++; stats.getMs += Date.now() - t0; if (!r) return null; if (fnv1a(r.u8) !== r.sum) throw new SwapCorruptError(key); return r.u8; },
        async has(key) { return m.has(key); },
        async delete(key) { const r = m.get(key); if (r) { used -= r.u8.length; m.delete(key); stats.deletes++; } },
        async clear() { m.clear(); used = 0; }, async usage() { return { used, quota, count: m.size }; },
        _corrupt(key) { const r = m.get(key); if (r) r.u8[0] ^= 1; },
    };
}

function createIdbSwap(o) {
    o = o || {}; const idb = o.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null); if (!idb) throw new Error('這個環境沒有 IndexedDB'); const quota = o.quotaBytes || 4 * 1073741824; const dbName = o.dbName || 'fa-train-swap', store = 'blobs', meta = 'meta';
    const stats = { puts: 0, gets: 0, deletes: 0, putMs: 0, getMs: 0 }; let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => { const r = idb.open(dbName, 1); r.onupgradeneeded = () => { const d = r.result; d.createObjectStore(store); d.createObjectStore(meta); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = async (names, mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(names, mode); let out; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('交易中止')); out = fn(t); }); };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    async function index() { const db = await open(); return new Promise((res, rej) => { const t = db.transaction([meta], 'readonly'); const r = t.objectStore(meta).getAll(); const k = t.objectStore(meta).getAllKeys(); t.oncomplete = () => { const o2 = {}; k.result.forEach((kk, i) => { o2[kk] = r.result[i]; }); res(o2); }; t.onerror = () => rej(t.error); }); }
    return {
        kind: 'indexeddb', stats, quota,
        async put(key, u8) {
            const t0 = Date.now(); const idx = await index(); let used = 0; for (const k of Object.keys(idx)) used += idx[k].len; const old = idx[key] ? idx[key].len : 0; const delta = u8.length - old;
            if (used + delta > quota) throw new SwapFullError(used, delta, quota);
            const sum = fnv1a(u8); const copy = u8.buffer && u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : Uint8Array.from(u8);
            await tx([store, meta], 'readwrite', (t) => { t.objectStore(store).put(copy, key); t.objectStore(meta).put({ len: u8.length, sum }, key); });
            stats.puts++; stats.putMs += Date.now() - t0;
        },
        async get(key) {
            const t0 = Date.now(); const db = await open(); const [data, m] = await new Promise((res, rej) => { const t = db.transaction([store, meta], 'readonly'); const a = t.objectStore(store).get(key), b = t.objectStore(meta).get(key); t.oncomplete = () => res([a.result, b.result]); t.onerror = () => rej(t.error); });
            stats.gets++; stats.getMs += Date.now() - t0; if (!data) return null;
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data); if (!m || u8.length !== m.len || fnv1a(u8) !== m.sum) throw new SwapCorruptError(key); return u8;
        },
        async has(key) { const idx = await index(); return !!idx[key]; },
        async delete(key) { await tx([store, meta], 'readwrite', (t) => { t.objectStore(store).delete(key); t.objectStore(meta).delete(key); }); stats.deletes++; },
        async clear() { await tx([store, meta], 'readwrite', (t) => { t.objectStore(store).clear(); t.objectStore(meta).clear(); }); },
        async usage() { const idx = await index(); let used = 0, count = 0; for (const k of Object.keys(idx)) { used += idx[k].len; count++; } return { used, quota, count }; },
        close() { if (dbp) dbp.then((d) => d.close()); dbp = null; },
    };
}

// 逐層引擎的 layerSource：第一次建圖並存入交換空間，之後直接從交換空間取位元組（不再讀 0.6B 模型、不再建圖）
function createSwapLayerSource(store, buildBytes, keyPrefix) {
    return async function layerSource(kind, layer) {
        const key = (keyPrefix || '') + kind + layer; let b = await store.get(key);
        if (!b) { b = await buildBytes(kind, layer); await store.put(key, b); }
        return b;
    };
}

module.exports = { SwapFullError, SwapCorruptError, fnv1a, createMemorySwap, createIdbSwap, createSwapLayerSource };
