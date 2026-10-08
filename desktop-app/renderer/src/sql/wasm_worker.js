// 網頁版 SQLite 引擎的 worker 啟動程式（wasm_engine.js 把 sql_split.js＋wasm_ops.js＋這個檔案串起來內嵌成字串常數啟動；不能用 function.toString()，建置的壓縮器會改掉變數名稱）。
// 頁面在啟動前先設定 self.__SQLITE_WASM_URL（sqlite-wasm 的 index.mjs 網址，同目錄要有 sqlite3.wasm）。
let __ready = null, __api = null;
async function __init() {
    const mod = await import(self.__SQLITE_WASM_URL);
    const sqlite3 = await mod.default({ print() {}, printErr() {} });
    try { sqlite3.config.error = () => {}; sqlite3.config.warn = () => {}; sqlite3.config.log = () => {}; } catch (_) { /* 版本沒有這些設定就算了 */ }
    __api = FaWasmOps.create(sqlite3, FaSqlSplit);
}
self.onmessage = async (ev) => {
    const d = ev.data || {};
    try {
        if (!__ready) __ready = __init();
        await __ready;
        if (!__api.ops[d.op]) throw new Error('不認得的操作：' + d.op);
        const result = __api.ops[d.op](d.args || {});
        const tr = [];
        if (result && result.bytes instanceof Uint8Array && result.bytes.buffer instanceof ArrayBuffer) tr.push(result.bytes.buffer);
        self.postMessage({ id: d.id, ok: true, result }, tr);
    } catch (e) {
        self.postMessage({ id: d.id, ok: false, error: String((e && e.message) || e) });
    }
};
