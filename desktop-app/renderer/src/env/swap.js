/* 模擬 swap（UMD、儲存層可注入）：把大塊的中間資料（解碼後的音訊、圖片、網格…）放到 IndexedDB（瀏覽器把 Blob 存成磁碟檔），
 * 記憶體裡只留「最近用的」一小部分；用到時再讀回來。記憶體少的環境（手機）因此跑得慢一點，但不會因為同時握著太多大塊資料被殺掉。
 *   const swap = FaSwap.create({ store, hotBytes, now })    store：{ put(id, blob), get(id), del(id), clear() }（非同步；預設用 IndexedDB 'fa_swap'）；hotBytes：記憶體裡最多留多少（超過就把最久沒用的寫出去）
 *   const h = await swap.put(blob|ArrayBuffer|Uint8Array)   → handle { id, size, type }
 *   await swap.get(h) → Blob（在記憶體就直接給，不在就從 store 讀回來並算成「最近用的」）      await swap.drop(h)      swap.stats()      await swap.clear()（啟動時清掉上次沒清乾淨的） */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaSwap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const toBlob = (x, type) => (typeof Blob !== 'undefined' && x instanceof Blob ? x : new Blob([x], { type: type || 'application/octet-stream' }));
    function idbStore(name) {
        let db = null; const open = () => db || (db = new Promise((res, rej) => { const rq = indexedDB.open(name || 'fa_swap', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('kv'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }));
        const tx = (mode, fn) => open().then((d) => new Promise((res, rej) => { const t = d.transaction('kv', mode), rq = fn(t.objectStore('kv')); t.oncomplete = () => res(rq && rq.result !== undefined ? rq.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
        return { put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)), get: (id) => tx('readonly', (s) => s.get(id)), del: (id) => tx('readwrite', (s) => s.delete(id)), clear: () => tx('readwrite', (s) => s.clear()) };
    }
    function create(o) {
        o = o || {}; const store = o.store || idbStore(), now = o.now || (() => Date.now()); let hotBytes = o.hotBytes == null ? 32 * 1048576 : o.hotBytes, seq = 0;
        const hot = new Map(), meta = new Map();   // id → Blob（在記憶體）／id → { size, type, last, onDisk }
        const hotSize = () => { let n = 0; for (const id of hot.keys()) n += meta.get(id).size; return n; };
        async function evict(except) {
            while (hotSize() > hotBytes) {
                const cands = [...hot.keys()].filter((id) => id !== except).sort((a, b) => meta.get(a).last - meta.get(b).last); if (!cands.length) break;
                const id = cands[0], m = meta.get(id); if (!m.onDisk) { await store.put(id, hot.get(id)); m.onDisk = true; } hot.delete(id);
            }
        }
        return {
            async put(x, type) { const blob = toBlob(x, type), id = 'sw' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6); meta.set(id, { size: blob.size, type: blob.type || type || '', last: now(), onDisk: false }); hot.set(id, blob); await evict(id); return { id, size: blob.size, type: blob.type || type || '' }; },
            async get(h) {
                const m = meta.get(h.id); if (!m) throw new Error('swap：這份資料已經被丟掉了'); m.last = now(); if (hot.has(h.id)) return hot.get(h.id);
                const blob = await store.get(h.id); if (!blob) throw new Error('swap：讀不回來（儲存空間被清掉了）'); hot.set(h.id, blob); await evict(h.id); return blob;
            },
            async drop(h) { const m = meta.get(h.id); if (!m) return; hot.delete(h.id); meta.delete(h.id); if (m.onDisk) { try { await store.del(h.id); } catch (_) { /* 殘留的啟動時會清 */ } } },
            async clear() { hot.clear(); meta.clear(); try { await store.clear(); } catch (_) { /* */ } },
            setHotBytes(n) { hotBytes = n; return evict(); },
            stats() { let disk = 0; for (const m of meta.values()) if (m.onDisk) disk += m.size; return { items: meta.size, hotBytes: hotSize(), diskBytes: disk, limit: hotBytes }; },
        };
    }
    return { create, idbStore };
});
