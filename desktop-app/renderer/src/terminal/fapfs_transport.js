/* FapMountFs 的同步後端（只能在瀏覽器／Electron 的頁面跑）：
 * wasi-sh 的 store 契約是同步的，而 FAP（FileSystemDirectoryHandle）只有非同步 API，所以頁面把請求寫進 SharedArrayBuffer、
 * 叫醒持有資料夾 handle 的 worker，頁面自旋等待回應（主執行緒不能 Atomics.wait，但可以自旋；shell 本來就是同步地佔著主執行緒）。
 * 協定一次一個請求：控制區 Int32Array［狀態、請求 JSON 長度、請求位元組長度、回應 JSON 長度、回應位元組長度］，後面接四個資料區。
 * 需要 SharedArrayBuffer（頁面 cross-origin isolated，或像桌面版那樣啟用了這個功能）；不行就回到舊的複製式掛載。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaFapFsTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const REQ_JSON = 256 * 1024, REQ_BYTES = 4 * 1024 * 1024, RES_JSON = 4 * 1024 * 1024, RES_BYTES = 4 * 1024 * 1024, CTRL = 64;
    const OFF_REQ_JSON = CTRL, OFF_REQ_BYTES = OFF_REQ_JSON + REQ_JSON, OFF_RES_JSON = OFF_REQ_BYTES + REQ_BYTES, OFF_RES_BYTES = OFF_RES_JSON + RES_JSON, TOTAL = OFF_RES_BYTES + RES_BYTES;
    const LIST_PAGE = 20000;

    // ---- worker 程式（以字串啟動）----
    /* WORKER-SRC-BEGIN */
    const WORKER_SRC = "// FAP 檔案系統的 worker（頁面端 fapfs_transport.js 把這個檔案內嵌成字串常數 WORKER_SRC 啟動；不能用 function.toString()，建置的壓縮器會改掉變數名稱）\n// 頁面在啟動前先設定 self.__FAPFS_OFF（共享記憶體各區的位移與大小）。\nlet sab = null, ctrl = null, u8 = null, root = null, writable = false; const writers = new Map();\nconst OFF = self.__FAPFS_OFF; const enc = new TextEncoder(), dec = new TextDecoder();\nconst parts = (p) => String(p).split('/').filter(Boolean);\nconst errOf = (e) => ({ code: e && e.name === 'NotFoundError' ? 'ENOENT' : e && e.name === 'TypeMismatchError' ? 'ENOTDIR' : e && e.name === 'NotAllowedError' ? 'EACCES' : e && e.name === 'InvalidModificationError' ? 'ENOTEMPTY' : e && e.name === 'QuotaExceededError' ? 'ENOSPC' : (e && e.code) || 'EIO', message: String((e && e.message) || e) });\nasync function dirOf(ps) { let h = root; for (const s of ps) h = await h.getDirectoryHandle(s); return h; }\nasync function resolve(p) {\n    const ps = parts(p); if (!ps.length) return { kind: 'directory', handle: root };\n    let parent; try { parent = await dirOf(ps.slice(0, -1)); } catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }\n    const name = ps[ps.length - 1];\n    try { return { kind: 'file', handle: await parent.getFileHandle(name), parent, name }; } catch (e) { if (!e || (e.name !== 'TypeMismatchError' && e.name !== 'NotFoundError')) throw e; if (e.name === 'NotFoundError') return null; }\n    try { return { kind: 'directory', handle: await parent.getDirectoryHandle(name), parent, name }; } catch (e) { if (e && e.name === 'NotFoundError') return null; throw e; }\n}\nconst reply = (state, json, bytes) => {\n    const j = enc.encode(JSON.stringify(json || {})); if (j.length > OFF.RES_JSON) { const e = enc.encode(JSON.stringify({ error: { code: 'EIO', message: '回應太大' } })); u8.set(e, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, e.length); Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 0, 3); return; }\n    u8.set(j, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, j.length); const b = bytes ? bytes.length : 0; if (b) u8.set(bytes, OFF.OFF_RES_BYTES); Atomics.store(ctrl, 4, b); Atomics.store(ctrl, 0, state);\n};\nconst ops = {\n    async stat(r) { const x = await resolve(r.path); if (!x) return { json: { st: null } }; if (x.kind === 'directory') return { json: { st: { kind: 'directory', size: 0, mtime: 0 } } }; const f = await x.handle.getFile(); return { json: { st: { kind: 'file', size: f.size, mtime: f.lastModified } } }; },\n    async list(r) { const x = await resolve(r.path); if (!x || x.kind !== 'directory') return { json: { entries: null } }; const out = []; let i = 0; for await (const [name, h] of x.handle.entries()) { if (i++ < r.offset) continue; if (out.length >= r.limit) return { json: { entries: out, more: true } }; out.push({ name, kind: h.kind }); } return { json: { entries: out, more: false } }; },\n    async read(r) { const x = await resolve(r.path); if (!x || x.kind !== 'file') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); const f = await x.handle.getFile(); const buf = new Uint8Array(await f.slice(r.start, Math.min(r.end, r.start + OFF.RES_BYTES)).arrayBuffer()); return { json: { size: f.size, mtime: f.lastModified }, bytes: buf }; },\n    async wBegin(r) {\n        if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const x = await resolve(r.path);\n        if (x && x.kind === 'directory') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });\n        if (!r.force) { if (x) { const f = await x.handle.getFile(); if (!r.expect || f.size !== r.expect.size || f.lastModified !== r.expect.mtime) return { json: { conflict: true, size: f.size, mtime: f.lastModified } }; } else if (r.expect) return { json: { conflict: true, size: 0, mtime: 0 } }; }\n        const parent = await dirOf(ps.slice(0, -1)); const fh = await parent.getFileHandle(ps[ps.length - 1], { create: true }); const w = await fh.createWritable({ keepExistingData: false }); writers.set(r.path, { w, fh }); return { json: { ok: true } };\n    },\n    async wChunk(r, bytes) { const o = writers.get(r.path); if (!o) throw Object.assign(new Error('沒有進行中的寫入'), { code: 'EIO' }); await o.w.write(bytes.slice()); return { json: { ok: true } }; },\n    async wEnd(r) { const o = writers.get(r.path); if (!o) throw Object.assign(new Error('沒有進行中的寫入'), { code: 'EIO' }); writers.delete(r.path); await o.w.close(); const f = await o.fh.getFile(); return { json: { ok: true, size: f.size, mtime: f.lastModified } }; },\n    async wAbort(r) { const o = writers.get(r.path); if (o) { writers.delete(r.path); try { await o.w.abort(); } catch (_) { /* 已結束 */ } } return { json: { ok: true } }; },\n    async mkdir(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.getDirectoryHandle(ps[ps.length - 1], { create: true }); return { json: { ok: true } }; },\n    async rmdir(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.removeEntry(ps[ps.length - 1], { recursive: false }); return { json: { ok: true } }; },\n    async remove(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.removeEntry(ps[ps.length - 1]); return { json: { ok: true } }; },\n    async setWritable(r) { writable = !!r.writable; return { json: { ok: true } }; },\n};\nconst waitChange = async (from) => { const r = Atomics.waitAsync(ctrl, 0, from); if (r.async) await r.value; };\nasync function loop() {\n    for (;;) {\n        const s = Atomics.load(ctrl, 0);\n        if (s === 0) { await waitChange(0); continue; }\n        if (s === 2 || s === 3) { await waitChange(s); continue; } // 等頁面端讀完、把狀態還原成 0\n        // s === 1：有請求\n        let req, bytes = null;\n        try {\n            req = JSON.parse(dec.decode(u8.slice(OFF.OFF_REQ_JSON, OFF.OFF_REQ_JSON + Atomics.load(ctrl, 1)))); const bl = Atomics.load(ctrl, 2); if (bl) bytes = u8.slice(OFF.OFF_REQ_BYTES, OFF.OFF_REQ_BYTES + bl);\n            if (!ops[req.op]) throw Object.assign(new Error('不認得的操作 ' + req.op), { code: 'ENOSYS' });\n            const res = await ops[req.op](req, bytes); reply(2, res.json, res.bytes);\n        } catch (e) { const er = errOf(e); const j = enc.encode(JSON.stringify({ error: er })); u8.set(j, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, j.length); Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 0, 3); }\n    }\n}\nself.onmessage = (ev) => {\n    const d = ev.data; if (d && d.type === 'init') { sab = d.sab; ctrl = new Int32Array(sab, 0, 8); u8 = new Uint8Array(sab); root = d.handle; writable = !!d.writable; self.postMessage({ ready: true }); loop(); }\n};\n";
    /* WORKER-SRC-END */
    function workerSource() { return 'self.__FAPFS_OFF = ' + JSON.stringify({ OFF_REQ_JSON, OFF_REQ_BYTES, OFF_RES_JSON, OFF_RES_BYTES, RES_JSON, RES_BYTES }) + ';\n' + WORKER_SRC; }

    function fsError(code, msg) { const e = new Error(code + (msg ? '：' + msg : '')); e.code = code; return e; }
    const supported = () => typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && typeof Worker !== 'undefined' && typeof Atomics.waitAsync === 'function';

    class WorkerBackend {
        constructor(opts) { this.timeoutMs = (opts && opts.timeoutMs) || 120000; this.worker = null; this.sab = null; this.calls = 0; }
        async init(dirHandle, o) {
            o = o || {}; this.sab = new SharedArrayBuffer(TOTAL); this.ctrl = new Int32Array(this.sab, 0, 8); this.u8 = new Uint8Array(this.sab); this.enc = new TextEncoder(); this.dec = new TextDecoder();
            const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' })); this.worker = new Worker(url); this.url = url;
            await new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error('FAP worker 沒有回應')), 10000); this.worker.onmessage = (ev) => { if (ev.data && ev.data.ready) { clearTimeout(to); resolve(); } }; this.worker.onerror = (e) => { clearTimeout(to); reject(new Error('FAP worker 錯誤：' + (e && e.message))); }; this.worker.postMessage({ type: 'init', sab: this.sab, handle: dirHandle, writable: !!o.writable }); });
        }
        close() { try { if (this.worker) this.worker.terminate(); if (this.url) URL.revokeObjectURL(this.url); } catch (_) { /* 已結束 */ } this.worker = null; }
        _call(req, bytes) {
            if (!this.worker) throw fsError('EIO', '掛載已關閉'); this.calls++; const j = this.enc.encode(JSON.stringify(req)); if (j.length > REQ_JSON) throw fsError('ENAMETOOLONG'); if (bytes && bytes.length > REQ_BYTES) throw fsError('EINVAL', '單次寫入太大');
            this.u8.set(j, OFF_REQ_JSON); Atomics.store(this.ctrl, 1, j.length); if (bytes && bytes.length) this.u8.set(bytes, OFF_REQ_BYTES); Atomics.store(this.ctrl, 2, bytes ? bytes.length : 0);
            Atomics.store(this.ctrl, 0, 1); Atomics.notify(this.ctrl, 0);
            const t0 = Date.now(); let spins = 0; while (Atomics.load(this.ctrl, 0) < 2) { if ((++spins & 0xfff) === 0 && Date.now() - t0 > this.timeoutMs) { throw fsError('EIO', '等待 FAP 逾時（' + Math.round(this.timeoutMs / 1000) + ' 秒）'); } }
            const state = Atomics.load(this.ctrl, 0); const jl = Atomics.load(this.ctrl, 3), bl = Atomics.load(this.ctrl, 4);
            const res = JSON.parse(this.dec.decode(this.u8.slice(OFF_RES_JSON, OFF_RES_JSON + jl))); const out = bl ? this.u8.slice(OFF_RES_BYTES, OFF_RES_BYTES + bl) : null;
            Atomics.store(this.ctrl, 0, 0); Atomics.notify(this.ctrl, 0);
            if (state === 3) { const e = fsError((res.error && res.error.code) || 'EIO', res.error && res.error.message); throw e; }
            return { json: res, bytes: out };
        }
        stat(path) { return this._call({ op: 'stat', path }).json.st; }
        list(path) { const all = []; let offset = 0; for (;;) { const r = this._call({ op: 'list', path, offset, limit: LIST_PAGE }).json; if (r.entries === null) return null; all.push(...r.entries); if (!r.more) return all; offset += r.entries.length; } }
        read(path, start, end) { const parts = []; let size = 0, mtime = 0, pos = start; while (pos < end) { const r = this._call({ op: 'read', path, start: pos, end: Math.min(end, pos + RES_BYTES) }); size = r.json.size; mtime = r.json.mtime; if (!r.bytes || !r.bytes.length) break; parts.push(r.bytes); pos += r.bytes.length; if (pos >= size) break; } const total = parts.reduce((n, p) => n + p.length, 0); const bytes = new Uint8Array(total); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; } return { bytes, size, mtime }; }
        writeFile(path, bytes, expect, force) {
            const b = this._call({ op: 'wBegin', path, expect, force: !!force }).json; if (b.conflict) return { ok: false, conflict: true, size: b.size, mtime: b.mtime };
            try { for (let i = 0; i < bytes.length; i += REQ_BYTES) this._call({ op: 'wChunk', path }, bytes.subarray(i, Math.min(bytes.length, i + REQ_BYTES))); const e = this._call({ op: 'wEnd', path }).json; return { ok: true, size: e.size, mtime: e.mtime }; }
            catch (err) { try { this._call({ op: 'wAbort', path }); } catch (_) { /* */ } throw err; }
        }
        mkdir(path) { this._call({ op: 'mkdir', path }); }
        rmdir(path) { this._call({ op: 'rmdir', path }); }
        remove(path) { this._call({ op: 'remove', path }); }
        setWritable(w) { this._call({ op: 'setWritable', writable: !!w }); }
    }
    // 桌面版：授權的真實資料夾，主行程同步處理（fsx-sync.js），渲染行程用 ipcRenderer.sendSync；不需要 SharedArrayBuffer 與 worker
    class IpcSyncBackend {
        constructor(rootId, call) { this.rootId = rootId; this.callFn = call || ((req) => window.desktopAPI.fsx.call(req)); this.calls = 0; }
        async init() { /* 沒有東西要初始化 */ }
        close() { /* 沒有常駐資源 */ }
        _c(req) { this.calls++; const r = this.callFn(Object.assign({ rootId: this.rootId }, req)); if (r && r.error) throw fsError(r.error.code || 'EIO', r.error.message); return r; }
        stat(path) { return this._c({ op: 'stat', path }).st; }
        list(path) { return this._c({ op: 'list', path }).entries; }
        read(path, start, end) { const parts = []; let size = 0, mtime = 0, pos = start; while (pos < end) { const r = this._c({ op: 'read', path, start: pos, end }); size = r.size; mtime = r.mtime; const b = r.bytes; if (!b || !b.length) break; parts.push(b); pos += b.length; if (pos >= size) break; } const total = parts.reduce((n, p) => n + p.length, 0); const bytes = new Uint8Array(total); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; } return { bytes, size, mtime }; }
        writeFile(path, bytes, expect, force) { const r = this._c({ op: 'writeFile', path, bytes, expect, force: !!force }); return r.ok ? { ok: true, size: r.size, mtime: r.mtime } : { ok: false, conflict: true, size: r.size, mtime: r.mtime }; }
        mkdir(path) { this._c({ op: 'mkdir', path }); }
        rmdir(path) { this._c({ op: 'rmdir', path }); }
        remove(path) { this._c({ op: 'remove', path }); }
        setWritable() { /* 授權的資料夾本來就可寫 */ }
    }
    const ipcSupported = () => typeof window !== 'undefined' && !!(window.desktopAPI && window.desktopAPI.fsx && typeof window.desktopAPI.fsx.call === 'function');
    return { WorkerBackend, IpcSyncBackend, workerSource, supported, ipcSupported, TOTAL };
});
