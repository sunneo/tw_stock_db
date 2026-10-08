// 網頁版 SQLite 引擎的 worker 啟動程式（wasm_engine.js 把 sql_split.js＋wasm_ops.js＋wasm_vfs.js＋這個檔案串起來內嵌成字串常數啟動；不能用 function.toString()，建置的壓縮器會改掉變數名稱）。
// 頁面在啟動前先設定 self.__SQLITE_WASM_URL（sqlite-wasm 的 index.mjs 網址，同目錄要有 sqlite3.wasm）。
//
// 除了「記憶體資料庫／位元組」之外，這裡多了三種開法（檔案層見 wasm_vfs.js）：
//   openFile  唯讀開 FAP 資料夾裡的檔案（File）：區塊快取，記憶體只由快取決定，檔案多大都行
//   openWb    可讀寫開 FAP 檔案：寫入先進髒頁（超過水位溢出到 OPFS），在交易提交之後才寫回 FAP（sync／close／水位／閒置）
//   openBuild 在 OPFS 建一個新的大型資料庫（同步存取檔，真正的隨機寫入）；建完 copyOut 串流複製進 FAP 資料夾
let __ready = null, __api = null, __sqlite3 = null, __vfs = null, __cur = null, __idle = null, __wbError = null, __busy = false;
async function __init() {
    const mod = await import(self.__SQLITE_WASM_URL);
    __sqlite3 = await mod.default({ print() {}, printErr() {} });
    try { __sqlite3.config.error = () => {}; __sqlite3.config.warn = () => {}; __sqlite3.config.log = () => {}; } catch (_) { /* 版本沒有這些設定就算了 */ }
    __api = FaWasmOps.create(__sqlite3, FaSqlSplit);
}
const __rand = () => Math.random().toString(36).slice(2, 10);
const __opfs = async () => navigator.storage.getDirectory();
async function __sah(name) { const root = await __opfs(); const fh = await root.getFileHandle(name, { create: true }); return await fh.createSyncAccessHandle(); }
async function __rm(name) { try { const root = await __opfs(); await root.removeEntry(name); } catch (_) { /* 不存在 */ } }
function __vfsOnce() { if (!__vfs) __vfs = FaWasmVfs.install(__sqlite3); return __vfs; }
async function __releaseCur() {
    if (__idle) { clearTimeout(__idle); __idle = null; }
    const c = __cur; __cur = null; if (!c) return; try { __api.ops.close(); } catch (_) { /* 已關 */ }
    if (c.vfsName) { try { __vfs.unregister(c.vfsName); } catch (_) { /* */ } } try { c.store && c.store.close(); } catch (_) { /* */ }
    for (const t of c.temps || []) { try { t.close(); } catch (_) { /* */ } } for (const n of c.rm || []) await __rm(n);
}
function __adopt(db, meta) { __api.adopt(db, meta); }
const __pragmas = (db, ro) => { db.exec('PRAGMA foreign_keys=ON; PRAGMA cache_size=-65536;'); if (ro) db.exec('PRAGMA query_only=ON;'); };
// 提交點：沒有進行中的交易時，才把髒頁寫回 FAP
const __autocommit = () => __sqlite3.capi.sqlite3_get_autocommit(__api.getDb().pointer) !== 0;
async function __wbMaybe(force) {
    const c = __cur; if (!c || c.kind !== 'wb' || __busy) return; const st = c.store; if (!st.isDirty()) return; if (!__autocommit()) return;
    if (force || st.dirtyBytes() > 64 * 1024 * 1024) { __busy = true; try { await st.writeBack(c.force); __wbError = null; } catch (e) { __wbError = e; if (force) throw e; } finally { __busy = false; } }
}
function __scheduleIdle() {
    if (__idle) clearTimeout(__idle); const c = __cur; if (!c || c.kind !== 'wb') return;
    __idle = setTimeout(async () => { __idle = null; try { await __wbMaybe(true); } catch (_) { /* 下次操作會回報 __wbError */ } }, 30000);
}
const __async = {
    async openFile(a) {
        await __releaseCur(); __vfsOnce(); const n = 'file-' + __rand(); const store = __vfs.register(n, new FaWasmVfs.FileStore(a.file));
        const db = new __sqlite3.oo1.DB(n, 'r', __vfs.name); __pragmas(db, true); __adopt(db, { path: a.label || n, readonly: true }); __cur = { kind: 'file', vfsName: n, store };
        return { size: a.file.size, version: db.selectValue('select sqlite_version()'), path: a.label || n, readonly: true };
    },
    async openWb(a) {
        await __releaseCur(); __vfsOnce(); const file = await a.fileHandle.getFile(); const spillName = 'wbspill-' + __rand(); const spill = new FaWasmVfs.SahStore(await __sah(spillName)); spill.truncate(0);
        const n = 'wb-' + __rand(); const store = __vfs.register(n, new FaWasmVfs.WbStore(a.fileHandle, file, spill));
        const db = new __sqlite3.oo1.DB(n, a.readonly ? 'r' : (file.size === 0 ? 'c' : 'w'), __vfs.name); db.exec('PRAGMA journal_mode=MEMORY;'); __pragmas(db, !!a.readonly); __adopt(db, { path: a.label || n, readonly: !!a.readonly }); __cur = { kind: 'wb', vfsName: n, store, rm: [spillName], force: false };
        return { size: file.size, version: db.selectValue('select sqlite_version()'), path: a.label || n, readonly: !!a.readonly };
    },
    async openBuild(a) {
        await __releaseCur(); __vfsOnce(); const name = a.name || 'idxbuild-' + __rand(); await __rm(name); const store = new FaWasmVfs.SahStore(await __sah(name)); store.truncate(0);
        const temps = []; const rm = [name]; for (let i = 0; i < 3; i++) { const tn = name + '.tmp' + i; await __rm(tn); const t = new FaWasmVfs.SahStore(await __sah(tn)); temps.push(t); rm.push(tn); __vfs.addTemp(t); }
        const n = 'build-' + __rand(); __vfs.register(n, store); const db = new __sqlite3.oo1.DB(n, 'c', __vfs.name);
        db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA cache_size=-65536; PRAGMA page_size=4096;'); __adopt(db, { path: name, readonly: false }); __cur = { kind: 'build', vfsName: n, store, temps, rm: [], buildName: name, buildRm: rm };
        return { size: 0, version: db.selectValue('select sqlite_version()'), path: name, readonly: false };
    },
    // 建完之後：關閉資料庫，把 OPFS 上的檔案串流複製進 FAP 資料夾的目標檔案（pipeTo 會 close，瀏覽器原子替換；記憶體只有串流的緩衝）
    async copyOut(a) {
        const c = __cur; const name = (c && c.buildName) || a.name; const rmList = (c && c.buildRm) || [a.name];
        if (c) { await __releaseCur(); }
        const root = await __opfs(); const h = await root.getFileHandle(name); const file = await h.getFile(); const size = file.size; const w = await a.fileHandle.createWritable();
        await file.stream().pipeTo(w); for (const n of rmList) await __rm(n); return { size };
    },
    async dropBuild(a) { const c = __cur; const rmList = (c && c.buildRm) || (a.name ? [a.name] : []); if (c) await __releaseCur(); for (const n of rmList) await __rm(n); return { ok: true }; },
    async sync(a) { const c = __cur; if (c && c.kind === 'wb') { if (a && a.force) c.force = true; const st = c.store; let w = 0; if (st.isDirty()) { if (!__autocommit()) throw new Error('有進行中的交易，先 COMMIT 才能寫回'); const r = await st.writeBack(c.force); w = r.written; } c.force = false; __wbError = null; return { written: w }; } return { written: 0 }; },
    async close() { await __releaseCur(); return { ok: true }; },
};
self.onmessage = async (ev) => {
    const d = ev.data || {};
    try {
        if (!__ready) __ready = __init();
        await __ready;
        let result;
        if (__async[d.op]) result = await __async[d.op](d.args || {});
        else {
            if (!__api.ops[d.op]) throw new Error('不認得的操作：' + d.op);
            if (__wbError && d.op === 'exec') { const e = __wbError; __wbError = null; throw new Error('上一次寫回失敗：' + e.message); }
            result = __api.ops[d.op](d.args || {});
            if (__cur && __cur.kind === 'wb' && (d.op === 'exec')) { await __wbMaybe(false); __scheduleIdle(); }
            if (d.op === 'status' && __cur && __cur.kind === 'wb') { result.dirtyBytes = __cur.store.dirtyBytes(); result.needsSync = __cur.store.isDirty(); }
            if (d.op === 'status' && __cur && __cur.store && __cur.store.reads !== undefined) { result.blockReads = __cur.store.reads; result.blockHits = __cur.store.hits; }
        }
        const tr = [];
        if (result && result.bytes instanceof Uint8Array && result.bytes.buffer instanceof ArrayBuffer) tr.push(result.bytes.buffer);
        self.postMessage({ id: d.id, ok: true, result }, tr);
    } catch (e) {
        self.postMessage({ id: d.id, ok: false, error: String((e && e.message) || e), conflict: !!(e && e.conflict) });
    }
};
