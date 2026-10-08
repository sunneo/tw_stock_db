// FAP 檔案系統的 worker（頁面端 fapfs_transport.js 把這個檔案內嵌成字串常數 WORKER_SRC 啟動；不能用 function.toString()，建置的壓縮器會改掉變數名稱）
// 頁面在啟動前先設定 self.__FAPFS_OFF（共享記憶體各區的位移與大小）。
let sab = null, ctrl = null, u8 = null, root = null, writable = false; const writers = new Map();
const OFF = self.__FAPFS_OFF; const enc = new TextEncoder(), dec = new TextDecoder();
const parts = (p) => String(p).split('/').filter(Boolean);
const errOf = (e) => ({ code: e && e.name === 'NotFoundError' ? 'ENOENT' : e && e.name === 'TypeMismatchError' ? 'ENOTDIR' : e && e.name === 'NotAllowedError' ? 'EACCES' : e && e.name === 'InvalidModificationError' ? 'ENOTEMPTY' : e && e.name === 'QuotaExceededError' ? 'ENOSPC' : (e && e.code) || 'EIO', message: String((e && e.message) || e) });
async function dirOf(ps) { let h = root; for (const s of ps) h = await h.getDirectoryHandle(s); return h; }
async function resolve(p) {
    const ps = parts(p); if (!ps.length) return { kind: 'directory', handle: root };
    let parent; try { parent = await dirOf(ps.slice(0, -1)); } catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }
    const name = ps[ps.length - 1];
    try { return { kind: 'file', handle: await parent.getFileHandle(name), parent, name }; } catch (e) { if (!e || (e.name !== 'TypeMismatchError' && e.name !== 'NotFoundError')) throw e; if (e.name === 'NotFoundError') return null; }
    try { return { kind: 'directory', handle: await parent.getDirectoryHandle(name), parent, name }; } catch (e) { if (e && e.name === 'NotFoundError') return null; throw e; }
}
const reply = (state, json, bytes) => {
    const j = enc.encode(JSON.stringify(json || {})); if (j.length > OFF.RES_JSON) { const e = enc.encode(JSON.stringify({ error: { code: 'EIO', message: '回應太大' } })); u8.set(e, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, e.length); Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 0, 3); return; }
    u8.set(j, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, j.length); const b = bytes ? bytes.length : 0; if (b) u8.set(bytes, OFF.OFF_RES_BYTES); Atomics.store(ctrl, 4, b); Atomics.store(ctrl, 0, state);
};
const ops = {
    async stat(r) { const x = await resolve(r.path); if (!x) return { json: { st: null } }; if (x.kind === 'directory') return { json: { st: { kind: 'directory', size: 0, mtime: 0 } } }; const f = await x.handle.getFile(); return { json: { st: { kind: 'file', size: f.size, mtime: f.lastModified } } }; },
    async list(r) { const x = await resolve(r.path); if (!x || x.kind !== 'directory') return { json: { entries: null } }; const out = []; let i = 0; for await (const [name, h] of x.handle.entries()) { if (i++ < r.offset) continue; if (out.length >= r.limit) return { json: { entries: out, more: true } }; out.push({ name, kind: h.kind }); } return { json: { entries: out, more: false } }; },
    async read(r) { const x = await resolve(r.path); if (!x || x.kind !== 'file') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); const f = await x.handle.getFile(); const buf = new Uint8Array(await f.slice(r.start, Math.min(r.end, r.start + OFF.RES_BYTES)).arrayBuffer()); return { json: { size: f.size, mtime: f.lastModified }, bytes: buf }; },
    async wBegin(r) {
        if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const x = await resolve(r.path);
        if (x && x.kind === 'directory') throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
        if (!r.force) { if (x) { const f = await x.handle.getFile(); if (!r.expect || f.size !== r.expect.size || f.lastModified !== r.expect.mtime) return { json: { conflict: true, size: f.size, mtime: f.lastModified } }; } else if (r.expect) return { json: { conflict: true, size: 0, mtime: 0 } }; }
        const parent = await dirOf(ps.slice(0, -1)); const fh = await parent.getFileHandle(ps[ps.length - 1], { create: true }); const w = await fh.createWritable({ keepExistingData: false }); writers.set(r.path, { w, fh }); return { json: { ok: true } };
    },
    async wChunk(r, bytes) { const o = writers.get(r.path); if (!o) throw Object.assign(new Error('沒有進行中的寫入'), { code: 'EIO' }); await o.w.write(bytes.slice()); return { json: { ok: true } }; },
    async wEnd(r) { const o = writers.get(r.path); if (!o) throw Object.assign(new Error('沒有進行中的寫入'), { code: 'EIO' }); writers.delete(r.path); await o.w.close(); const f = await o.fh.getFile(); return { json: { ok: true, size: f.size, mtime: f.lastModified } }; },
    async wAbort(r) { const o = writers.get(r.path); if (o) { writers.delete(r.path); try { await o.w.abort(); } catch (_) { /* 已結束 */ } } return { json: { ok: true } }; },
    async mkdir(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.getDirectoryHandle(ps[ps.length - 1], { create: true }); return { json: { ok: true } }; },
    async rmdir(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.removeEntry(ps[ps.length - 1], { recursive: false }); return { json: { ok: true } }; },
    async remove(r) { if (!writable) throw Object.assign(new Error('唯讀'), { code: 'EROFS' }); const ps = parts(r.path); const parent = await dirOf(ps.slice(0, -1)); await parent.removeEntry(ps[ps.length - 1]); return { json: { ok: true } }; },
    async setWritable(r) { writable = !!r.writable; return { json: { ok: true } }; },
};
const waitChange = async (from) => { const r = Atomics.waitAsync(ctrl, 0, from); if (r.async) await r.value; };
async function loop() {
    for (;;) {
        const s = Atomics.load(ctrl, 0);
        if (s === 0) { await waitChange(0); continue; }
        if (s === 2 || s === 3) { await waitChange(s); continue; } // 等頁面端讀完、把狀態還原成 0
        // s === 1：有請求
        let req, bytes = null;
        try {
            req = JSON.parse(dec.decode(u8.slice(OFF.OFF_REQ_JSON, OFF.OFF_REQ_JSON + Atomics.load(ctrl, 1)))); const bl = Atomics.load(ctrl, 2); if (bl) bytes = u8.slice(OFF.OFF_REQ_BYTES, OFF.OFF_REQ_BYTES + bl);
            if (!ops[req.op]) throw Object.assign(new Error('不認得的操作 ' + req.op), { code: 'ENOSYS' });
            const res = await ops[req.op](req, bytes); reply(2, res.json, res.bytes);
        } catch (e) { const er = errOf(e); const j = enc.encode(JSON.stringify({ error: er })); u8.set(j, OFF.OFF_RES_JSON); Atomics.store(ctrl, 3, j.length); Atomics.store(ctrl, 4, 0); Atomics.store(ctrl, 0, 3); }
    }
}
self.onmessage = (ev) => {
    const d = ev.data; if (d && d.type === 'init') { sab = d.sab; ctrl = new Int32Array(sab, 0, 8); u8 = new Uint8Array(sab); root = d.handle; writable = !!d.writable; self.postMessage({ ready: true }); loop(); }
};
