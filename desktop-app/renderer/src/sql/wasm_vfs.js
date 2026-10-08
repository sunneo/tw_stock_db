/* 網頁版 SQLite 的檔案層（只能在 worker 裡跑；DESIGN.sqlite-fap.md §4）：一個自訂 VFS「fa」，資料庫檔案可以放在不同的「儲存」上：
 *   FileStore     唯讀，直接讀 FAP 資料夾裡的檔案：FileReaderSync 讀 File.slice，256 KB 區塊 LRU 快取（記憶體只由快取大小決定，與檔案大小無關）
 *   SahStore      OPFS 的同步存取檔（createSyncAccessHandle）：真正的隨機讀寫，建大型資料庫用（不需要 cross-origin isolation，也不需要 SharedArrayBuffer）
 *   WbStore       寫回式：寫入進髒頁（記憶體，超過水位溢出到 OPFS 暫存檔），在「交易提交之後」才用 createWritable({keepExistingData:true}) 依位置寫回 FAP 檔案，
 *                 close() 時瀏覽器原子替換；寫回前比對檔案身分（大小＋mtime），被外部改過就不覆蓋
 *   MemStore      記憶體：日誌、暫存檔、一般記憶體資料庫
 * VFS 的方法必須同步，所以所有非同步的準備（取得 File、SyncAccessHandle、WritableStream）都在 SQLite 呼叫「之前」做完，這個檔案的方法只碰已經備好的同步物件。
 * 寫回（非同步）只發生在兩次 SQL 呼叫之間的「提交點」：沒有進行中的交易、而且（要求同步／關閉／髒頁超過水位／閒置夠久）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaWasmVfs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const BLK = 256 * 1024, MAX_BLOCKS = 256;       // 唯讀快取：64 MB
    const CH = 4096, SPILL_AFTER = 32 * 1024 * 1024; // 寫回式：髒頁在記憶體最多 32 MB，超過溢出到 OPFS 暫存檔
    const err = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };

    class MemStore {
        constructor() { this.buf = new Uint8Array(0); this.len = 0; }
        size() { return this.len; }
        read(dst, at) { const n = Math.max(0, Math.min(dst.length, this.len - at)); if (n) dst.set(this.buf.subarray(at, at + n), 0); return n; }
        write(src, at) { const end = at + src.length; if (end > this.buf.length) { const g = new Uint8Array(Math.max(end, Math.floor(this.buf.length * 1.5), 4096)); g.set(this.buf.subarray(0, this.len), 0); this.buf = g; } this.buf.set(src, at); if (end > this.len) this.len = end; }
        truncate(n) { if (n < this.len) { this.len = n; } else if (n > this.len) { this.write(new Uint8Array(n - this.len), this.len); } }
        flush() {} close() { this.buf = new Uint8Array(0); this.len = 0; }
    }
    class FileStore {
        constructor(file, rs) { this.file = file; this.rs = rs || new FileReaderSync(); this.cache = new Map(); this.reads = 0; this.hits = 0; }
        size() { return this.file.size; }
        _blk(i) {
            let b = this.cache.get(i); if (b) { this.cache.delete(i); this.cache.set(i, b); this.hits++; return b; }
            this.reads++; b = new Uint8Array(this.rs.readAsArrayBuffer(this.file.slice(i * BLK, Math.min((i + 1) * BLK, this.file.size)))); this.cache.set(i, b); if (this.cache.size > MAX_BLOCKS) this.cache.delete(this.cache.keys().next().value); return b;
        }
        read(dst, at) { const size = this.file.size; const end = Math.min(size, at + dst.length); if (end <= at) return 0; let pos = at; while (pos < end) { const i = Math.floor(pos / BLK); const b = this._blk(i); const o = pos - i * BLK; const n = Math.min(b.length - o, end - pos); dst.set(b.subarray(o, o + n), pos - at); pos += n; } return end - at; }
        write() { throw err('EROFS', '唯讀'); } truncate() { throw err('EROFS', '唯讀'); } flush() {} close() { this.cache.clear(); }
    }
    class SahStore {
        constructor(sah) { this.sah = sah; }
        size() { return this.sah.getSize(); }
        read(dst, at) { return this.sah.read(dst, { at }); }
        write(src, at) { const n = this.sah.write(src, { at }); if (n !== src.length) throw err('EIO', '寫入不完整'); }
        truncate(n) { this.sah.truncate(n); } flush() { this.sah.flush(); } close() { try { this.sah.flush(); } catch (_) { /* 已關 */ } try { this.sah.close(); } catch (_) { /* 已關 */ } }
    }
    // 寫回式：base＝原本的 FAP 檔案（唯讀 FileStore）；髒頁以 CH 為單位
    class WbStore {
        constructor(fileHandle, file, spill, rs) {
            this.fh = fileHandle; this.base = new FileStore(file, rs); this.spill = spill || null; this.len = file.size; this.baseSize = file.size; this.baseMtime = file.lastModified;
            this.dirty = new Map(); this.spilled = new Set(); this.touched = 0; this.lastWriteAt = 0; this.wrote = 0;
        }
        size() { return this.len; }
        _get(i, forWrite) {
            let c = this.dirty.get(i); if (c) return c;
            const buf = new Uint8Array(CH);
            if (this.spilled.has(i)) this.spill.read(buf, i * CH); else { const at = i * CH; if (at < this.baseSize) this.base.read(buf.subarray(0, Math.min(CH, this.baseSize - at)), at); }
            if (!forWrite) return buf; this.dirty.set(i, buf); this.spilled.delete(i); return buf;
        }
        read(dst, at) { const end = Math.min(this.len, at + dst.length); if (end <= at) return 0; let pos = at; while (pos < end) { const i = Math.floor(pos / CH); const c = this._get(i, false); const o = pos - i * CH; const n = Math.min(CH - o, end - pos); dst.set(c.subarray(o, o + n), pos - at); pos += n; } return end - at; }
        write(src, at) {
            const end = at + src.length; if (end > this.len) this.len = end; let pos = at; let k = 0;
            while (k < src.length) { const i = Math.floor(pos / CH); const c = this._get(i, true); const o = pos - i * CH; const n = Math.min(CH - o, src.length - k); c.set(src.subarray(k, k + n), o); pos += n; k += n; this.touched++; }
            this.lastWriteAt = Date.now(); if (this.spill && this.dirty.size * CH > SPILL_AFTER) this._spillOut();
        }
        _spillOut() { for (const [i, c] of this.dirty) { this.spill.write(c, i * CH); this.spilled.add(i); } this.dirty.clear(); }
        truncate(n) { if (n < this.len) { this.len = n; const lastIdx = Math.floor((n - 1) / CH); for (const i of Array.from(this.dirty.keys())) if (i > lastIdx) this.dirty.delete(i); for (const i of Array.from(this.spilled)) if (i > lastIdx) this.spilled.delete(i); } else if (n > this.len) { this.write(new Uint8Array(Math.min(n - this.len, CH * 16)), this.len); this.len = n; } this.lastWriteAt = Date.now(); }
        flush() {} // 本機持久（日誌）不等於寫回 FAP；寫回在提交點由 writeBack() 做
        dirtyBytes() { return (this.dirty.size + this.spilled.size) * CH; }
        isDirty() { return this.dirty.size > 0 || this.spilled.size > 0 || this.len !== this.baseSize; }
        // 提交點的寫回：依位置寫入（相鄰的合併）、必要時截斷，close() 時原子替換；寫回前檢查檔案是否被外部改過
        async writeBack(force) {
            if (!this.isDirty()) return { written: 0 };
            const cur = await this.fh.getFile(); if (!force && (cur.size !== this.baseSize || cur.lastModified !== this.baseMtime)) { const e = err('CONFLICT', '檔案在開啟之後被外部改過，沒有覆蓋（要覆蓋請 force）'); e.conflict = true; throw e; }
            const idx = Array.from(new Set([...this.dirty.keys(), ...this.spilled])).sort((a, b) => a - b); const w = await this.fh.createWritable({ keepExistingData: true });
            try {
                let runStart = -1, runBuf = null, runLen = 0; const flushRun = async () => { if (runStart >= 0 && runLen) await w.write({ type: 'write', position: runStart * CH, data: runBuf.subarray(0, runLen) }); runStart = -1; runBuf = null; runLen = 0; };
                const MAXRUN = 8 * 1024 * 1024; let prev = -2;
                for (const i of idx) {
                    const c = this.dirty.get(i) || this._get(i, false);
                    if (i !== prev + 1 || runLen + CH > MAXRUN) { await flushRun(); runStart = i; runBuf = new Uint8Array(MAXRUN); runLen = 0; }
                    runBuf.set(c, runLen); runLen += CH; prev = i;
                }
                await flushRun(); await w.truncate(this.len); await w.close();
            } catch (e) { try { await w.abort(); } catch (_) { /* 已結束 */ } throw e; }
            const now = await this.fh.getFile(); const n = idx.length;
            this.base.close(); this.base = new FileStore(now, this.base.rs); this.baseSize = now.size; this.baseMtime = now.lastModified; this.len = now.size; this.dirty.clear(); this.spilled.clear(); if (this.spill) this.spill.truncate(0); this.wrote += n; this.touched = 0;
            return { written: n };
        }
        close() { this.base.close(); this.dirty.clear(); this.spilled.clear(); if (this.spill) this.spill.close(); }
    }

    function install(sqlite3, opts) {
        opts = opts || {}; const wasm = sqlite3.wasm, capi = sqlite3.capi; const name = opts.name || 'fa';
        const registry = new Map();   // 檔名 → 儲存
        const open = new Map();       // pFile → { store, name, flags, temp }
        const tempPool = [];          // 預先備好的 OPFS 暫存（xOpen 是同步的，沒辦法當場建立 SyncAccessHandle）
        const heap = () => wasm.heap8u(); const num = (p) => Number(p);
        const io = {
            xCheckReservedLock: (pFile, pOut) => { wasm.poke32(pOut, 0); return 0; },
            xClose: (pFile) => { const f = open.get(num(pFile)); if (f) { open.delete(num(pFile)); try { if (f.temp) { f.store.truncate(0); if (f.pooled) tempPool.push(f.store); else f.store.close(); } else if (f.flags & capi.SQLITE_OPEN_DELETEONCLOSE) { registry.delete(f.name); } } catch (_) { return capi.SQLITE_IOERR; } } return 0; },
            xDeviceCharacteristics: (pFile) => { const f = open.get(num(pFile)); return f && f.store instanceof FileStore ? capi.SQLITE_IOCAP_IMMUTABLE : capi.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN; },
            xFileControl: (pFile, op, pArg) => capi.SQLITE_NOTFOUND,
            xFileSize: (pFile, pSz) => { const f = open.get(num(pFile)); wasm.poke64(pSz, BigInt(f.store.size())); return 0; },
            xLock: (pFile, t) => 0, xUnlock: (pFile, t) => 0,
            xRead: (pFile, pDest, n, off64) => {
                const f = open.get(num(pFile)); const dst = heap().subarray(num(pDest), num(pDest) + n);
                try { const got = f.store.read(dst, num(off64)); if (got < n) { dst.fill(0, got); return capi.SQLITE_IOERR_SHORT_READ; } return 0; } catch (e) { f.lastError = e; return capi.SQLITE_IOERR_READ; }
            },
            xSectorSize: (pFile) => 4096,
            xSync: (pFile, flags) => { const f = open.get(num(pFile)); try { f.store.flush(); return 0; } catch (e) { f.lastError = e; return capi.SQLITE_IOERR_FSYNC; } },
            xTruncate: (pFile, sz64) => { const f = open.get(num(pFile)); try { f.store.truncate(num(sz64)); return 0; } catch (e) { f.lastError = e; return capi.SQLITE_IOERR_TRUNCATE; } },
            xWrite: (pFile, pSrc, n, off64) => { const f = open.get(num(pFile)); try { if (f.store instanceof FileStore) return capi.SQLITE_READONLY; f.store.write(heap().subarray(num(pSrc), num(pSrc) + n), num(off64)); return 0; } catch (e) { f.lastError = e; return capi.SQLITE_IOERR_WRITE; } },
        };
        const ioMethods = new capi.sqlite3_io_methods(); ioMethods.$iVersion = 1; sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: io } });
        const vfsM = {
            xAccess: (pVfs, zName, flags, pOut) => { const n = zName ? wasm.cstrToJs(zName) : ''; wasm.poke32(pOut, registry.has(n) ? 1 : 0); return 0; },
            xCurrentTime: (pVfs, pOut) => { wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, 'double'); return 0; },
            xCurrentTimeInt64: (pVfs, pOut) => { wasm.poke(pOut, 0xbfc83e532200 + Date.now(), 'i64'); return 0; },
            xDelete: (pVfs, zName, sync) => { registry.delete(wasm.cstrToJs(zName)); return 0; },
            xFullPathname: (pVfs, zName, nOut, pOut) => (wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN),
            xGetLastError: (pVfs, nOut, pOut) => 0,
            xOpen: (pVfs, zName, pFile, flags, pOutFlags) => {
                try {
                    const n = zName && wasm.peek8(zName) ? wasm.cstrToJs(zName) : ''; let store = n ? registry.get(n) : null; let temp = false, pooled = false;
                    if (!store) {
                        const isMain = n && !/-(journal|wal|shm)$/.test(n);
                        if (isMain && !(flags & capi.SQLITE_OPEN_CREATE)) return capi.SQLITE_CANTOPEN;
                        temp = true; if (tempPool.length) { store = tempPool.pop(); pooled = true; store.truncate(0); } else store = new MemStore();
                        if (n) registry.set(n, store);
                    }
                    open.set(num(pFile), { store, name: n, flags, temp, pooled }); const f = new capi.sqlite3_file(pFile); f.$pMethods = ioMethods.pointer; f.dispose(); wasm.poke32(pOutFlags, flags); return 0;
                } catch (e) { return capi.SQLITE_CANTOPEN; }
            },
        };
        const vfs = new capi.sqlite3_vfs(); const dV = capi.sqlite3_vfs_find(null); const d = dV ? new capi.sqlite3_vfs(dV) : null;
        vfs.$iVersion = 2; vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof; vfs.$mxPathname = 1024; vfs.addOnDispose(vfs.$zName = wasm.allocCString(name));
        if (d) { vfs.$xRandomness = d.$xRandomness; vfs.$xSleep = d.$xSleep; d.dispose(); }
        if (!vfs.$xRandomness) vfsM.xRandomness = (pVfs, nOut, pOut) => { const h = heap(); let i = 0; for (; i < nOut; ++i) h[num(pOut) + i] = Math.random() * 255e3 & 255; return i; };
        if (!vfs.$xSleep) vfsM.xSleep = () => 0;
        sqlite3.vfs.installVfs({ vfs: { struct: vfs, methods: vfsM } });
        return {
            name, registry, tempPool,
            register(n, store) { registry.set(n, store); return store; }, unregister(n) { const s = registry.get(n); registry.delete(n); return s; },
            addTemp(store) { tempPool.push(store); },
        };
    }
    return { install, MemStore, FileStore, SahStore, WbStore, BLK, CH, MAX_BLOCKS, SPILL_AFTER };
});
