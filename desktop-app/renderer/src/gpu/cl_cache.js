/* OpenCL 程式的多層快取（FaClCache，UMD）：source → IL（SPIR-V）→ 最終產物（binary）。
 *   第一次：source 要編譯（慢）；之後同一份 source＋選項＋同一種裝置目標：直接拿 binary（不經前端）。clCreateProgramWithSource 的程式在命中時等於改寫成 clCreateProgramWithBinary。
 * 三層（都可獨立開關）：
 *   bin：最終產物，依「裝置目標」不同（cpu→JS／wasm，GPU→KIR＋shader…；驅動自己決定怎麼序列化，見 drv.target／serialize／deserialize）。鍵＝H(程式基底鍵, 選項, 目標, 各編譯器版本)。
 *   il ：SPIR-V 位元組（IL 程式本身，或外掛的 source→IL 前端 frontends.toIL 的產物）。鍵＝H(source, 選項) → IL 雜湊。
 *   src：不存內容，只存「這份 source 有哪些 bin／il」的連結，讓命中檢查只看記憶體裡的索引。
 * 檢查碼：小而快、不用等非同步。預設 fast64（兩條 32 位元乘法雜湊＋長度；以 32 位元字為單位；字串直接吃 charCode，不配置記憶體），可選 md5。
 * 儲存：IndexedDB（瀏覽器；結構化複製，可直接存 Uint8Array）／檔案（node，跨行程測試）／記憶體；介面一致。開啟時把「索引」整個讀進記憶體，所以「有沒有」是同步的，只有真的要取內容才可能非同步。
 * 排入佇列（enqueue）與沖出（flush）：
 *   讀：createProgram 時 prefetch（排入背景讀取）；build 才需要結果——內容已在記憶體（同步）就直接用，否則 yield 等（載入器的 build 是「能同步就同步」的 generator，遇到 Promise 才非同步）。
 *   寫：寫後不等（write-behind）：先放進「待寫表」（讀得到自己剛寫的），排入寫入佇列；kick() 在背景沖出，flush() 回傳 Promise 等到全部落地。
 *   沖出的位置（載入器與各層呼叫）：clFinish（kick）、釋放程式／context／佇列（kick）、取 binary／createProgramWithBinary（讀待寫表，不需沖）、結束（loader.close／H.close／Python atexit：flush）、
 *   頁面 pagehide／visibilitychange（kick）、待寫量超過門檻（自動 kick）。
 * 沒有開關：快取永遠開著、對呼叫者無痕——原本的 clCreateProgramWithSource／cl.Program(ctx, src) 寫法第二次起自動拿 binary。快取的任何錯誤（儲存體壞了、配額滿、內容損毀、版本不合）都當作沒命中，絕不影響建置結果；
 * 儲存體開不起來（無痕視窗等）就悄悄退成記憶體。容量與期限是自動管理的上限（maxBytes、maxEntries、ttlDays，LRU 淘汰），不是開關；compat（backend｜strict｜none）決定裝置目標納入多少 GPU 身分，給想調整相容範圍的人用（configure）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaClCache = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const VERSION = 1;
    const DEFAULTS = { maxBytes: 64 * 1024 * 1024, maxEntries: 512, ttlDays: 30, compat: 'backend', hash: 'fast64', minBuildMs: 0, pendingKickBytes: 1 << 20 };

    // ---------------------------------------------------------------- 檢查碼
    const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
    function fast64(x) {
        let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0, n;
        if (typeof x === 'string') {
            n = x.length;
            for (let i = 0; i < n; i++) { const c = x.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 15; }
        } else {
            n = x.length; const w = n >>> 2, dv = new DataView(x.buffer, x.byteOffset, n);
            for (let i = 0; i < w; i++) { const v = dv.getUint32(i * 4, true); h1 = Math.imul(h1 ^ v, 16777619); h1 ^= h1 >>> 13; h2 = Math.imul(h2 ^ v, 0x5bd1e995); h2 ^= h2 >>> 15; }
            for (let i = w * 4; i < n; i++) { h1 = Math.imul(h1 ^ x[i], 16777619); h2 = Math.imul(h2 ^ x[i], 0x5bd1e995); h2 ^= h2 >>> 15; }
        }
        h1 ^= h1 >>> 16; h1 = Math.imul(h1, 0x85ebca6b); h1 ^= n; h2 ^= h2 >>> 13; h2 = Math.imul(h2, 0xc2b2ae35); h2 ^= h1;
        return hex8(h1) + hex8(h2) + ':' + n.toString(36);
    }
    function md5(input) {   // 標準 MD5（RFC 1321），回傳 32 位十六進位字串
        const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input, n = bytes.length;
        const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
        const total = ((n + 8) >> 6) + 1, m = new Int32Array(total * 16);
        for (let i = 0; i < n; i++) m[i >> 2] |= bytes[i] << ((i & 3) * 8);
        m[n >> 2] |= 0x80 << ((n & 3) * 8); m[total * 16 - 2] = (n << 3) | 0; m[total * 16 - 1] = Math.floor(n / 536870912) | 0;
        let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
        const rol = (x, c) => (x << c) | (x >>> (32 - c));
        for (let blk = 0; blk < total; blk++) {
            let A = a0, B = b0, C = c0, D = d0;
            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
                F = (F + A + K[i] + m[blk * 16 + g]) | 0; A = D; D = C; C = B; B = (B + rol(F, S[(i >> 4) * 4 + (i & 3)])) | 0;
            }
            a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
        }
        const le = (x) => { let s = ''; for (let i = 0; i < 4; i++) s += ((x >>> (i * 8)) & 255).toString(16).padStart(2, '0'); return s; };
        return le(a0) + le(b0) + le(c0) + le(d0);
    }
    const HASHES = { fast64, md5 };

    // ---------------------------------------------------------------- 儲存介面卡
    // 介面：getSync?(store,key)（有就代表同步可取）、get(store,key)→Promise、put(store,key,value)、del(store,key)、clear()、flush?()
    function memoryAdapter() {
        const m = { meta: new Map(), il: new Map(), bin: new Map() };
        return { name: 'memory', getSync: (s, k) => m[s].get(k), get: (s, k) => Promise.resolve(m[s].get(k)), put: (s, k, v) => { m[s].set(k, v); }, del: (s, k) => { m[s].delete(k); }, clear: () => { for (const k of Object.keys(m)) m[k].clear(); }, _m: m };
    }
    // 檔案（node）：整份 JSON，flush 時寫出（Uint8Array 存成 base64）。給跨行程的測試用。
    function fileAdapter(fs, file) {
        const m = { meta: new Map(), il: new Map(), bin: new Map() }; let dirty = false;
        const enc = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? { $u8: Buffer.from(x).toString('base64') } : x));
        const dec = (s) => JSON.parse(s, (k, x) => (x && typeof x === 'object' && x.$u8 !== undefined ? new Uint8Array(Buffer.from(x.$u8, 'base64')) : x));
        try { const j = dec(fs.readFileSync(file, 'utf8')); for (const s of Object.keys(m)) for (const [k, v] of Object.entries(j[s] || {})) m[s].set(k, v); } catch (_) { /* 沒有檔案：空的 */ }
        return { name: 'file', getSync: (s, k) => m[s].get(k), get: (s, k) => Promise.resolve(m[s].get(k)), put: (s, k, v) => { m[s].set(k, v); dirty = true; }, del: (s, k) => { m[s].delete(k); dirty = true; }, clear: () => { for (const k of Object.keys(m)) m[k].clear(); dirty = true; },
            flush: () => { if (!dirty) return; const o = {}; for (const s of Object.keys(m)) o[s] = Object.fromEntries(m[s]); fs.writeFileSync(file, enc(o)); dirty = false; } };
    }
    // IndexedDB（瀏覽器）：三個物件儲存體 meta／il／bin；全部非同步
    function idbAdapter(idb, dbName) {
        let dbp = null;
        const open = () => dbp || (dbp = new Promise((res, rej) => { const r = idb.open(dbName || 'fa-cl-cache', 1); r.onupgradeneeded = () => { const db = r.result; for (const s of ['meta', 'il', 'bin']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('IndexedDB 被另一個連線擋住')); }));
        const tx = (store, mode, fn) => open().then((db) => new Promise((res, rej) => { const t = db.transaction(store, mode), os = t.objectStore(store), rq = fn(os); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
        return { name: 'indexeddb', get: (s, k) => tx(s, 'readonly', (os) => os.get(k)), put: (s, k, v) => tx(s, 'readwrite', (os) => os.put(v, k)), del: (s, k) => tx(s, 'readwrite', (os) => os.delete(k)), clear: () => Promise.all(['meta', 'il', 'bin'].map((s) => tx(s, 'readwrite', (os) => os.clear()))), close: () => open().then((db) => db.close()) };
    }

    // ---------------------------------------------------------------- 快取
    function createCache(o) {
        o = o || {}; const now = o.now || (() => Date.now()), warn = o.warn || (() => {}); let adapter = o.storage || memoryAdapter();
        let config = JSON.parse(JSON.stringify(DEFAULTS)); const merge = (c, p) => { for (const k of Object.keys(p || {})) { if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) c[k] = Object.assign({}, c[k], p[k]); else c[k] = p[k]; } return c; };
        merge(config, o.config);
        const frontends = { toIL: o.toIL || null };   // 選用：source→SPIR-V 的前端（例如 clang＋llvm-spirv 的服務）。內建的 clc 直接產 JS，沒有這一步。
        let idx = { src: {}, il: {}, bin: {} }, idxDirty = false, ready = false, readyP = null;
        const hot = new Map(), pending = new Map(), inflight = new Map(), queue = [], tomb = new Set();   // 熱快取（含剛讀的）、待寫表（讀得到自己剛寫的）、進行中的讀取、寫入佇列
        let pendingBytes = 0, draining = null;
        const stats = { hits: { bin: 0, il: 0 }, misses: { bin: 0, il: 0 }, puts: { bin: 0, il: 0 }, evicted: 0, flushes: 0, kicks: 0, bytes: 0, entries: 0, errors: 0, skippedFast: 0, hashMs: 0 };
        const H = () => HASHES[config.hash] || fast64;
        const hk = (x) => { const t0 = typeof performance !== 'undefined' ? performance.now() : 0; const r = H()(x); stats.hashMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0; return config.hash + ':' + r; };
        const sk = (store, key) => store + '\u0000' + key;

        // ---- 開啟：讀索引與設定（同步介面卡立刻完成）
        function applyOpen(index, saved) {
            if (saved && saved.config) { const base = JSON.parse(JSON.stringify(DEFAULTS)); merge(base, saved.config); merge(base, o.config); config = base; }
            if (index && index.v === VERSION) idx = { src: index.src || {}, il: index.il || {}, bin: index.bin || {} };
            ready = true; ttlSweep(); recount();
        }
        function open() {
            if (readyP) return readyP;
            if (adapter.getSync) { applyOpen(adapter.getSync('meta', 'index'), adapter.getSync('meta', 'config')); readyP = Promise.resolve(true); return readyP; }
            readyP = Promise.all([adapter.get('meta', 'index'), adapter.get('meta', 'config')]).then(([i, c]) => { applyOpen(i, c); return true; }, (e) => { stats.errors++; adapter = memoryAdapter(); stats.fallbackMemory = 1; ready = true; return true; });   // 儲存體開不起來：悄悄退成記憶體（行程內仍然有快取）
            return readyP;
        }
        const recount = () => { let b = 0, n = 0; for (const s of ['il', 'bin']) for (const k of Object.keys(idx[s])) { b += idx[s][k][0]; n++; } stats.bytes = b; stats.entries = n; };
        function ttlSweep() { const lim = now() - config.ttlDays * 86400000; for (const s of ['il', 'bin']) for (const k of Object.keys(idx[s])) if (idx[s][k][1] < lim) dropEntry(s, k, false); }

        // ---- 鍵
        const key = {
            src: (text) => hk(text), il: (bytes) => hk(bytes),
            options: (s) => hk(String(s || '')),
            bin: (base, opts, target, vers) => hk(base + '|' + opts + '|' + target + '|' + (vers || '')),
            ilOf: (srcKey, opts) => hk(srcKey + '|il|' + opts),
        };
        const enabled = () => ready;   // 沒有開關：開啟完成就一直在用
        const layerOn = () => ready;

        // ---- 有沒有（同步，只看索引）
        const has = (store, k) => layerOn(store) && !!idx[store][k];
        const linkedIl = (srcKey, opts) => { const r = idx.src[srcKey]; return r && r.il && r.il[opts] ? r.il[opts] : null; };
        // ---- 取內容：待寫表 → 熱快取 → 介面卡（同步或 Promise）
        function fetchValue(store, k) {
            const kk = sk(store, k);
            if (pending.has(kk)) { stats.hits[store]++; touch(store, k); return pending.get(kk); }
            if (hot.has(kk)) { stats.hits[store]++; touch(store, k); return hot.get(kk); }
            if (!idx[store][k]) { stats.misses[store]++; return undefined; }
            const done = (v) => { if (v === undefined) { dropEntry(store, k, true); stats.misses[store]++; return undefined; } hot.set(kk, v); stats.hits[store]++; touch(store, k); return v; };
            if (adapter.getSync) return done(adapter.getSync(store, k));
            if (inflight.has(kk)) return inflight.get(kk).then(done);
            const p = adapter.get(store, k).then((v) => { inflight.delete(kk); return v; }, (e) => { inflight.delete(kk); stats.errors++; return undefined; });
            inflight.set(kk, p); return p.then(done);
        }
        const touch = (store, k) => { const e = idx[store][k]; if (e) { e[1] = now(); idxDirty = true; } };
        // 背景預取（createProgram 時排入）：把這份 source 對應目前目標的 bin 讀進熱快取，build 時就是同步命中
        function prefetch(srcKey, target) {
            if (!layerOn('bin')) return;
            const r = idx.src[srcKey]; if (!r) return;
            for (const bk of Object.keys(r.bins)) if (r.bins[bk][0] === target) { const v = fetchValue('bin', bk); if (v && typeof v.then === 'function') v.then(() => {}, () => {}); stats.hits.bin--; }   // 預取不算命中
        }

        // ---- 寫入（write-behind）
        function put(store, k, value, size, link) {
            if (!ready) return false;
            const kk = sk(store, k); size = size || 0; tomb.delete(kk);
            if (!pending.has(kk)) { pendingBytes += size; }
            pending.set(kk, value); hot.set(kk, value); queue.push({ op: 'put', store, key: k, value });
            const old = idx[store][k]; idx[store][k] = [size, now()]; if (!old) { stats.entries++; stats.bytes += size; } else stats.bytes += size - old[0];
            if (link) { const r = idx.src[link.src] || (idx.src[link.src] = { t: 0, bins: {}, il: {} }); r.t = now(); if (store === 'bin') r.bins[k] = [link.target, link.opts, size]; else r.il[link.opts] = k; }
            idxDirty = true; stats.puts[store]++;
            if (pendingBytes >= config.pendingKickBytes) kick();
            return true;
        }
        function dropEntry(store, k, persist) {
            const e = idx[store][k]; if (!e) return; delete idx[store][k]; stats.entries--; stats.bytes -= e[0]; stats.evicted += persist === 'count' ? 1 : 0;
            hot.delete(sk(store, k)); pending.delete(sk(store, k));
            for (const sr of Object.keys(idx.src)) { const r = idx.src[sr]; if (store === 'bin') delete r.bins[k]; else for (const op of Object.keys(r.il)) if (r.il[op] === k) delete r.il[op]; if (!Object.keys(r.bins).length && !Object.keys(r.il).length) delete idx.src[sr]; }
            queue.push({ op: 'del', store, key: k }); tomb.add(sk(store, k)); idxDirty = true;
        }
        function evict() {
            const over = () => stats.bytes > config.maxBytes || stats.entries > config.maxEntries;
            if (!over()) return;
            const all = []; for (const s of ['il', 'bin']) for (const k of Object.keys(idx[s])) all.push([s, k, idx[s][k][1]]);
            all.sort((a, b) => a[2] - b[2]);
            for (const [s, k] of all) { if (!over()) break; dropEntry(s, k, 'count'); }
        }
        // 多個載入器（頁面、Worker、別的分頁）共用同一個儲存體：寫索引前先讀回別人寫的，合併後再寫（聯集；我這邊刪掉的不復活）
        async function mergedIndex() {
            let cur = null; try { cur = await adapter.get('meta', 'index'); } catch (_) { cur = null; }
            if (cur && cur.v === VERSION) {
                for (const s of ['il', 'bin']) for (const k of Object.keys(cur[s] || {})) if (!idx[s][k] && !tomb.has(sk(s, k))) { idx[s][k] = cur[s][k]; stats.entries++; stats.bytes += cur[s][k][0]; }
                for (const sr of Object.keys(cur.src || {})) { const a = cur.src[sr], b = idx.src[sr] || (idx.src[sr] = { t: 0, bins: {}, il: {} }); b.t = Math.max(b.t, a.t || 0); for (const bk of Object.keys(a.bins || {})) if (idx.bin[bk] && !b.bins[bk]) b.bins[bk] = a.bins[bk]; for (const op of Object.keys(a.il || {})) if (idx.il[a.il[op]] && !b.il[op]) b.il[op] = a.il[op]; }
            }
            return { v: VERSION, src: idx.src, il: idx.il, bin: idx.bin };
        }
        function drainOnce() {
            evict();
            const run = async () => {
                try {
                    while (queue.length) {
                        const op = queue.shift();
                        if (op.op === 'put') { await adapter.put(op.store, op.key, op.value); pending.delete(sk(op.store, op.key)); pendingBytes = Math.max(0, pendingBytes - ((idx[op.store][op.key] || [0])[0])); }
                        else await adapter.del(op.store, op.key);
                    }
                    if (idxDirty) { idxDirty = false; await adapter.put('meta', 'index', await mergedIndex()); }
                    if (adapter.flush) await adapter.flush();
                } catch (e) { stats.errors++; warn('快取寫入失敗：' + e.message + '\n'); }
            };
            // 同步介面卡：直接做完（呼叫者不必等）；非同步：排成一個 Promise 鏈
            if (adapter.getSync) {
                while (queue.length) { const op = queue.shift(); if (op.op === 'put') { adapter.put(op.store, op.key, op.value); pending.delete(sk(op.store, op.key)); } else adapter.del(op.store, op.key); }
                pendingBytes = 0; if (idxDirty) { idxDirty = false; adapter.put('meta', 'index', { v: VERSION, src: idx.src, il: idx.il, bin: idx.bin }); }
                if (adapter.flush) { try { adapter.flush(); } catch (e) { stats.errors++; } }
                return Promise.resolve();
            }
            return run();
        }
        // kick：在背景沖出（不等）；flush：回傳 Promise，等到佇列清空、索引落地
        function kick() { if (!ready || (!queue.length && !idxDirty)) return; stats.kicks++; if (!draining) { draining = drainOnce().finally(() => { draining = null; }); } }
        async function flush() { stats.flushes++; await open(); for (let i = 0; i < 4; i++) { if (draining) await draining; if (!queue.length && !idxDirty) break; draining = drainOnce().finally(() => { draining = null; }); await draining; } }
        function configure(patch) { merge(config, patch || {}); adapter.put ? Promise.resolve(adapter.put('meta', 'config', { config })).catch(() => {}) : null; if (patch && (patch.maxBytes || patch.maxEntries || patch.ttlDays)) { ttlSweep(); evict(); kick(); } return config; }
        async function clear() { queue.length = 0; pending.clear(); hot.clear(); idx = { src: {}, il: {}, bin: {} }; idxDirty = true; stats.bytes = 0; stats.entries = 0; await open(); await adapter.clear(); await adapter.put('meta', 'config', { config }); }
        open();   // 所有函式都定義好之後才開啟（同步儲存體會立刻完成）
        const bump = (name, n) => { stats[name] = (stats[name] || 0) + (n || 1); };
        const snapshot = () => Object.assign({}, stats, { hits: Object.assign({}, stats.hits), misses: Object.assign({}, stats.misses), puts: Object.assign({}, stats.puts), pending: queue.length, pendingBytes, storage: adapter.name, config: JSON.parse(JSON.stringify(config)), ready });

        return { mod: { packBinary: (h, a, s, i) => packBinary(h, a, s, i), unpackBinary: (u) => unpackBinary(u), MAGIC: 'FAKIRBN1' }, VERSION, bump, key, has, linkedIl, fetch: fetchValue, put, prefetch, kick, flush, open, configure, clear, stats: snapshot, frontends, get config() { return config; }, get enabled() { return enabled(); }, layerOn, get ready() { return ready; }, whenReady: open, adapter, _idx: () => idx };
    }

    // ---------------------------------------------------------------- binary 容器（clCreateProgramWithBinary／clGetProgramInfo(BINARIES) 用）
    // 'FAKIRBN1'｜u32 標頭長度｜標頭 JSON｜各區段原始位元組（標頭裡 sections 依序給名字與長度）。產物裡的 Uint8Array 取出成區段，其餘是 JSON。
    const MAGIC = 'FAKIRBN1';
    function packBinary(header, art, src, il) {
        const blobs = []; const meta = JSON.stringify(art, (k, v) => { if (v instanceof Uint8Array) { blobs.push(v); return { $blob: blobs.length - 1 }; } return v; });
        const te = new TextEncoder(), secs = [{ name: 'art', bytes: te.encode(meta) }].concat(src ? [{ name: 'src', bytes: te.encode(src) }] : [], il ? [{ name: 'il', bytes: il }] : [], blobs.map((b, i) => ({ name: 'blob' + i, bytes: b })));
        const head = te.encode(JSON.stringify(Object.assign({}, header, { sections: secs.map((s) => [s.name, s.bytes.length]) })));
        const total = 12 + head.length + secs.reduce((a, s) => a + s.bytes.length, 0), out = new Uint8Array(total), dv = new DataView(out.buffer);
        out.set(te.encode(MAGIC), 0); dv.setUint32(8, head.length, true); out.set(head, 12); let p = 12 + head.length; for (const s of secs) { out.set(s.bytes, p); p += s.bytes.length; }
        return out;
    }
    function unpackBinary(u8) { try { return unpackBinaryRaw(u8); } catch (_) { return null; } }   // 損毀的容器一律回 null（呼叫端回 INVALID_BINARY）
    function unpackBinaryRaw(u8) {
        const td = new TextDecoder(); if (u8.length < 12 || td.decode(u8.subarray(0, 8)) !== MAGIC) return null;
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), hl = dv.getUint32(8, true), header = JSON.parse(td.decode(u8.subarray(12, 12 + hl)));
        let p = 12 + hl; const secs = {}; for (const [name, len] of header.sections) { secs[name] = u8.subarray(p, p + len); p += len; }
        const art = JSON.parse(td.decode(secs.art), (k, v) => (v && typeof v === 'object' && v.$blob !== undefined ? new Uint8Array(secs['blob' + v.$blob]) : v));
        return { header, art, src: secs.src ? td.decode(secs.src) : null, il: secs.il ? new Uint8Array(secs.il) : null };
    }
    return { VERSION, createCache, fast64, md5, memoryAdapter, fileAdapter, idbAdapter, packBinary, unpackBinary, MAGIC, DEFAULTS };
});
