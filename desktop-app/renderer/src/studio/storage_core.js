/* 訓練資產的儲存層（UMD，用依賴注入，不直接碰 window／indexedDB／檔案系統）。設計見 DESIGN.TODO.offline-training-studio.md §3、§12。
 * 儲存後端（store）介面，全部非同步，鍵是正斜線相對路徑：
 *    get(key) → Uint8Array|null、put(key, u8)、delete(key)、list(prefix) → [key]
 *    fap 後端可再多一個 permission() → 'granted'|'prompt'|'denied'|'none'
 * 提供：
 *  - createMemoryStore()：Map 實作（測試、網頁版記憶體層的底）
 *  - createChunkedStore(kv, {chunkBytes})：包一層，讓任何單筆都 ≤ chunkBytes（預設 4MB）。§12 的教訓：FileCache 有 LRU 淘汰，大檔不可整筆放，也不可放 FileCache；
 *    呼叫端要把 kv 接到 KVStore／專屬 IndexedDB store，不是 FileCache。某個分塊被淘汰時 get 回 null（視為不存在），由 fap 補回。
 *  - createNodeFsStore({fs, path, root})：用注入的 Node fs 實作（桌面版 rawfs／fap 絕對路徑也可照樣接）；原子寫入（先寫暫存檔再改名）
 *  - createStorage({memory, fap})：兩處同步。寫入同時寫記憶體與 fap（權威）；沒授權或 fap 寫入失敗就只寫記憶體，回 dataMayBeLost:true 與原因。
 *    資產路徑 <kind>/<name>/…（fap 端的根目錄應是 <fap>/.floating-assistant/training/，首次寫入會放 .gitignore）。 */
(function (root, factory) {
    const dep = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    if (typeof module === 'object' && module.exports) module.exports = factory(dep);
    else root.FaStudioStorage = factory(dep);
})(typeof self !== 'undefined' ? self : this, function (Asset) {
    'use strict';
    const FAP_PREFIX = '.floating-assistant/training/';
    const CHUNK_BYTES = 4 * 1048576;
    const enc = (s) => new TextEncoder().encode(s), dec = (u) => new TextDecoder('utf-8').decode(u);
    function checkKey(k) { if (!Asset.safePath(k)) throw new Error('儲存鍵不合法：' + JSON.stringify(k)); return k; }

    function createMemoryStore() {
        const m = new Map();
        return {
            kind: 'memory', size: () => m.size,
            async get(k) { const v = m.get(checkKey(k)); return v ? v.slice() : null; },
            async put(k, u8) { m.set(checkKey(k), u8.slice()); },
            async delete(k) { m.delete(checkKey(k)); },
            async list(prefix) { prefix = prefix || ''; return Array.from(m.keys()).filter((k) => k.indexOf(prefix) === 0).sort(); },
            _raw: m
        };
    }

    function createChunkedStore(kv, o) {
        const cb = Math.max(1024, (o && o.chunkBytes) || CHUNK_BYTES); const SEP = '.~c';
        const isChunk = (k) => /\.~c\d{5}$/.test(k);
        const ck = (k, i) => k + SEP + String(i).padStart(5, '0');
        async function dropChunks(k, n) { for (let i = 0; i < n; i++) await kv.delete(ck(k, i)); }
        return {
            kind: 'chunked', chunkBytes: cb,
            async get(k) {
                const meta = await kv.get(checkKey(k)); if (!meta) return null;
                let mt; try { mt = JSON.parse(dec(meta)); } catch (_) { return null; }
                if (mt && mt.fa_chunked === 1) {
                    const out = new Uint8Array(mt.size); let off = 0;
                    for (let i = 0; i < mt.chunks; i++) { const c = await kv.get(ck(k, i)); if (!c) return null; out.set(c, off); off += c.length; } // 有分塊被淘汰 → 視為不存在
                    return off === mt.size ? out : null;
                }
                return null;
            },
            async put(k, u8) {
                checkKey(k); const old = await kv.get(k); if (old) { try { const o0 = JSON.parse(dec(old)); if (o0 && o0.fa_chunked === 1) await dropChunks(k, o0.chunks); } catch (_) { /* 舊資料不是分塊格式 */ } }
                const n = Math.max(1, Math.ceil(u8.length / cb));
                for (let i = 0; i < n; i++) await kv.put(ck(k, i), u8.slice(i * cb, Math.min(u8.length, (i + 1) * cb)));
                await kv.put(k, enc(JSON.stringify({ fa_chunked: 1, size: u8.length, chunks: n }))); // 最後才寫 meta，寫到一半不會出現半個檔
            },
            async delete(k) { const old = await kv.get(checkKey(k)); if (old) { try { const o0 = JSON.parse(dec(old)); if (o0 && o0.fa_chunked === 1) await dropChunks(k, o0.chunks); } catch (_) { /* */ } } await kv.delete(k); },
            async list(prefix) { return (await kv.list(prefix || '')).filter((k) => !isChunk(k)); },
            maxEntryBytes: async () => { let mx = 0; for (const k of await kv.list('')) { const v = await kv.get(k); if (v && v.length > mx) mx = v.length; } return mx; }
        };
    }

    function createNodeFsStore(o) {
        const fs = o.fs.promises || o.fs, path = o.path, rootDir = o.root;
        const abs = (k) => path.join(rootDir, ...checkKey(k).split('/'));
        let tmpN = 0;
        async function walk(dir, rel, out) {
            let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
            for (const d of ents) { const r = rel ? rel + '/' + d.name : d.name; if (d.isDirectory()) await walk(path.join(dir, d.name), r, out); else if (!/\.tmp-\d+$/.test(d.name)) out.push(r); }
        }
        return {
            kind: 'node-fs', root: rootDir,
            async permission() { try { await fs.mkdir(rootDir, { recursive: true }); return 'granted'; } catch (_) { return 'denied'; } },
            async get(k) { try { const b = await fs.readFile(abs(k)); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
            async put(k, u8) { const f = abs(k); await fs.mkdir(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + (++tmpN); await fs.writeFile(t, u8); await fs.rename(t, f); },
            async delete(k) { try { await fs.unlink(abs(k)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
            async list(prefix) { const out = []; await walk(rootDir, '', out); prefix = prefix || ''; return out.filter((k) => k.indexOf(prefix) === 0).sort(); }
        };
    }

    // ===== 兩處同步 =====
    function createStorage(o) {
        const memory = o.memory; let fap = o.fap || null; let gitignored = false;
        async function fapState() {
            if (!fap) return { ok: false, reason: 'no-fap', message: '沒有授權資料夾（fap），資料只存在記憶體；瀏覽器資料被清掉會遺失，請授權資料夾或匯出 .fatrain' };
            const p = fap.permission ? await fap.permission() : 'granted';
            if (p !== 'granted') return { ok: false, reason: 'permission-' + p, message: 'fap 資料夾目前沒有寫入權限（' + p + '），資料只存在記憶體，可能遺失；需要使用者手勢重新授權' };
            return { ok: true };
        }
        async function write(key, u8) {
            await memory.put(key, u8); const st = await fapState(); const r = { ok: true, memory: true, fap: false, dataMayBeLost: true, reason: st.reason, warning: st.message };
            if (!st.ok) return r;
            try {
                if (!gitignored) { await fap.put('.gitignore', enc('*\n')); gitignored = true; }
                await fap.put(key, u8); r.fap = true; r.dataMayBeLost = false; delete r.reason; delete r.warning;
            } catch (e) { r.reason = 'fap-write-failed'; r.warning = 'fap 寫入失敗（' + String(e.message || e) + '），只寫到記憶體，資料可能遺失'; r.fapError = String(e.message || e); }
            return r;
        }
        async function read(key) {
            const st = await fapState();
            if (st.ok) { try { const v = await fap.get(key); if (v) { try { await memory.put(key, v); } catch (_) { /* 記憶體配額滿了不影響讀取 */ } return v; } } catch (_) { /* 讀 fap 失敗就退回記憶體 */ } }
            return memory.get(key);
        }
        async function listKeys(prefix) {
            const set = new Set(await memory.list(prefix)); const st = await fapState();
            if (st.ok) { try { for (const k of await fap.list(prefix)) if (k !== '.gitignore') set.add(k); } catch (_) { /* */ } }
            return Array.from(set).sort();
        }
        const dir = (kind, name) => { if (Asset.KINDS.indexOf(kind) < 0) throw new Error('kind 不合法：' + kind); if (!Asset.safeName(name)) throw new Error('名稱不合法：' + name); return kind + '/' + name + '/'; };
        return {
            setFap(f) { fap = f || null; gitignored = false; }, fapState, write, read, list: listKeys,
            async remove(key) { await memory.delete(key); if ((await fapState()).ok) { try { await fap.delete(key); } catch (_) { /* */ } } },
            async loadManifest(kind, name) { const b = await read(dir(kind, name) + 'manifest.json'); if (!b) return null; try { return JSON.parse(dec(b)); } catch (_) { return null; } },
            async saveAsset(asset, opts) {
                const m = asset.manifest; const d = dir(m.kind, m.name); const v = Asset.verifyFiles(m, asset.files);
                if (!v.ok) return { ok: false, error: '拒絕儲存：' + v.message };
                const res = { ok: true, dataMayBeLost: false, written: 0 };
                if (opts && opts.replace) { const keep = new Set(Object.keys(asset.files).map((p) => d + p).concat([d + 'manifest.json'])); for (const k of await listKeys(d)) if (!keep.has(k)) await this.remove(k); }
                for (const p of Object.keys(asset.files)) { const r = await write(d + p, asset.files[p]); res.written++; if (r.dataMayBeLost) { res.dataMayBeLost = true; res.warning = r.warning; res.reason = r.reason; } }
                const r = await write(d + 'manifest.json', enc(JSON.stringify(asset.manifest, null, 1))); // manifest 最後寫：沒有 manifest 的資料夾視為未完成
                if (r.dataMayBeLost) { res.dataMayBeLost = true; res.warning = r.warning; res.reason = r.reason; }
                return res;
            },
            async loadAsset(kind, name) {
                const d = dir(kind, name); const manifest = await this.loadManifest(kind, name); if (!manifest) return null;
                const files = {}; for (const p of Object.keys(manifest.sha256 || {})) { const b = await read(d + p); if (b) files[p] = b; }
                const v = Asset.verifyFiles(manifest, files, { allowExtra: true });
                return { asset: { manifest, files }, verify: v };
            },
            async listAssets() {
                const out = []; const seen = new Set();
                for (const k of await listKeys('')) { const m = /^([^/]+)\/([^/]+)\/manifest\.json$/.exec(k); if (m && !seen.has(m[1] + '/' + m[2])) { seen.add(m[1] + '/' + m[2]); const mf = await this.loadManifest(m[1], m[2]); if (mf) out.push({ kind: m[1], name: m[2], created: mf.created, counts: mf.counts, owner: mf.owner }); } }
                return out;
            },
            async deleteAsset(kind, name) { const d = dir(kind, name); const ks = await listKeys(d); for (const k of ks) await this.remove(k); return { ok: true, removed: ks.length }; }
        };
    }

    return { FAP_PREFIX, CHUNK_BYTES, createMemoryStore, createChunkedStore, createNodeFsStore, createStorage };
});
