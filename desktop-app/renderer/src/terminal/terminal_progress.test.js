// node renderer/src/terminal/terminal_progress.test.js
// bash 執行環境：位元組級下載進度、主要→備份切換、Cache API 快取（含開啟失敗）、背景預載、
// ls／cat／cd 快路徑（不等 busybox.wasm）、diag 的階段耗時。方法本體從 floating-assistant.js 抽出，
// 用假的 fetch／caches／模組匯入／檔案系統執行，不碰網路。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };
// 從方法本體的 { 開始做括號配對取出整個方法（不能用 lastIndexOf，方法間的註解裡也可能有成對的大括號）
function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    let i = SRC.indexOf('{', m.index + m[0].length); let depth = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
    return SRC.slice(m.index + 1, i + 1);
}
const METHODS = ['_fetchAssetBytesWithBackup', '_bashReadBody', '_bashWasmEmit', '_bashFileLabel', '_bashProgressText',
    '_terminalBashProgressWriter', '_bashCacheOpen', '_bashCacheKey', '_bashCacheGet', '_bashCachePut', '_bashLoadJsModules',
    '_ensureBashWasmLoaded', '_fetchAssetBackupFile', '_fetchViaProxyThenDirect', '_scheduleBashWasmPreload', '_terminalDiagText',
    '_terminalFsFastPath', '_terminalCd', '_termTimed', '_termStalled', '_runTerminalCommand', '_terminalRecordInput', '_terminalBuildTag', '_terminalPrintDiag',
    '_bashSettings', '_bashStallMs', '_bashJoin', '_bashFetchBytes', '_bashWithStall', '_bashJsSourceList', '_bashLoadOneJsSource', '_normalizeTerminalSettings', '_terminalResolvePath', '_terminalIsDir', '_terminalSandboxFileBytes'];
const CLASS_SRC = '({' + METHODS.map(methodSource).join(',\n') + '})';

const PRIMARY = 'https://cdn.example/wasi/dist/busybox.wasm';
const BACKUP = 'https://backup.example/bash/';
const REL = 'dist/busybox.wasm';
const MB12 = 1200000;

class FakeResponse { constructor(buf) { this._b = buf; } arrayBuffer() { return Promise.resolve(this._b); } }
class FakeBlob { constructor(parts) { this.parts = parts; } }
function fakeRes(status, chunks, len) {
    const hdr = { get: (k) => (k.toLowerCase() === 'content-length' && len != null ? String(len) : null) };
    return {
        ok: status >= 200 && status < 300, status, headers: hdr,
        body: { getReader() { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }; } },
        arrayBuffer: async () => { const n = chunks.reduce((s, c) => s + c.byteLength, 0); const o = new Uint8Array(n); let f = 0; for (const c of chunks) { o.set(c, f); f += c.byteLength; } return o.buffer; },
    };
}
function fakeNet(routes) {
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url);
        const r = routes[url];
        if (!r) return fakeRes(404, [], null);
        return fakeRes(r.status || 200, r.chunks || [], r.len === undefined ? null : r.len);
    };
    return { fetch: fetchFn, calls };
}
function fakeCaches() {
    const store = new Map();
    return { store, open: async () => ({ match: async (k) => store.get(k), put: async (k, res) => { store.set(k, res); } }) };
}
function fakeFs(entries) {
    const files = new Map(); const dirs = new Set(['/']);
    for (const [p, v] of Object.entries(entries)) {
        if (v === null) dirs.add(p.replace(/\/$/, ''));
        else files.set(p, new TextEncoder().encode(v));
    }
    return {
        statSync(p) { if (dirs.has(p)) return { mode: 0o40755, size: 0 }; if (files.has(p)) return { mode: 0o100644, size: files.get(p).length }; throw new Error('ENOENT ' + p); },
        readSync(p, buf, off, len) { buf.set(files.get(p).subarray(0, len), off); return len; },
        readdirSync(p) {
            const pre = p === '/' ? '/' : p + '/'; const names = new Set();
            for (const x of [...dirs, ...files.keys()]) { if (x !== p && x.startsWith(pre)) { const rest = x.slice(pre.length); if (rest && !rest.includes('/')) names.add(rest); } }
            return [...names];
        },
    };
}
function makeCtx(extra) {
    const ctx = Object.assign({
        console, Promise, JSON, Math, Number, Array, Object, String, Error, Set, Map, Uint8Array, TextDecoder, TextEncoder,
        Response: FakeResponse, Blob: FakeBlob, URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
        FA_ASSET_URLS: { bashWasmJsBase: 'https://cdn.example/wasi/', bashWasmBackupBase: BACKUP },
        setTimeout: (fn) => { ctx.timers.push(fn); return ctx.timers.length; }, clearTimeout() {},
        timers: [], intervals: [], setInterval: (fn) => { ctx.intervals.push(fn); return ctx.intervals.length; }, clearInterval() {},
        caches: undefined, navigator: undefined, requestIdleCallback: undefined, fetch: undefined,
        Date: { now: () => (ctx.tick += 150) }, tick: 0,
    }, extra || {});
    vm.createContext(ctx);
    return ctx;
}
function makeSelf(ctx, over) {
    const M = vm.runInContext(CLASS_SRC, ctx);
    const stubs = {
        _viaAssetProxy: (u) => u,
        _bashImportModule: async (u) => {
            if (u.endsWith('index.mjs')) return { run: () => 'run' };
            if (u.endsWith('fs.mjs')) return { memoryFs: () => 'mfs' };
            if (u.startsWith('blob:')) return { run: () => 'run', memoryFs: () => 'mfs' };
            throw new Error('找不到模組 ' + u);
        },
        _terminalHasShellOps: (t) => /[|&;<>$`()]/.test(String(t || '')),
        _terminalTokenizeArgs: (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/) : []),
        _hydrateReferencedFapMounts: async () => {},
        _ensureTerminalFsStore: async () => fakeFs({}),
    };
    return Object.assign({}, M, stubs, over || {});
}
const sink = () => { const out = []; return { out, sess: { cwd: '/work', term: { write: (s) => out.push(s) } } }; };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
    // T1：有 Content-Length 的分塊串流：進度單調遞增、總量正確、完成事件標主要來源；進度行用 \r 就地更新、不換行
    {
        const chunk = new Uint8Array(300000).fill(1);
        const net = fakeNet({ [PRIMARY]: { chunks: [chunk, chunk, chunk, chunk], len: MB12 } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx);
        const evs = []; const { out, sess } = sink(); const writer = self._terminalBashProgressWriter(sess);
        self._bashWasmSubs = new Set([(ev) => { evs.push(ev); writer(ev); }]);
        const buf = await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        const prog = evs.filter((e) => e.kind === 'progress' && !e.final);
        check('T1 位元組完整', buf.byteLength === MB12, buf.byteLength);
        check('T1 每塊都回報進度，已下載量遞增到總量', prog.length === 4 && prog.every((e, i) => i === 0 || e.loaded > prog[i - 1].loaded) && prog[3].loaded === MB12, prog.map((e) => e.loaded));
        check('T1 total 取自 Content-Length', prog.every((e) => e.total === MB12));
        check('T1 完成事件標主要來源', evs.some((e) => e.kind === 'done' && e.source === '主要' && e.bytes === MB12));
        check('T1 進度行以 \\r 就地更新（進行中不換行）', out.slice(0, 4).every((s) => s.startsWith('\r\x1b[2K') && !s.includes('\n')), out.slice(0, 4));
        check('T1 進度文字含 百分比與來源', /下載 shell 0\.3\/1\.1 MB 25% 已用 \ds 來源：主要/.test(out.find((x) => x.includes('MB 25%'))), out[0]);
        check('T1 完成時換行定稿（只有一行 \\r\\n）', out[out.length - 1].endsWith('\r\n') && out.join('').split('\r\n').length === 2, out.length);
    }
    // T2：沒有 Content-Length：只顯示已下載量，不顯示百分比
    {
        const net = fakeNet({ [PRIMARY]: { chunks: [new Uint8Array(200000), new Uint8Array(200000)], len: null } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx); const { out, sess } = sink(); const writer = self._terminalBashProgressWriter(sess);
        self._bashWasmSubs = new Set([writer]);
        await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        check('T2 無 Content-Length：顯示已下載量且無百分比', out.some((s) => s.includes('已下載')) && out.every((s) => !s.includes('%')), out);
    }
    // T3：主要來源 HTTP 500 → 切到備份（manifest 404 就當單檔），writer 顯示切換，診斷記下原因
    {
        const net = fakeNet({ [PRIMARY]: { status: 500 }, [BACKUP + 'dist/busybox.wasm']: { chunks: [new Uint8Array(10)], len: 10 } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx); const { out, sess } = sink(); const writer = self._terminalBashProgressWriter(sess);
        const evs = [];
        self._bashWasmSubs = new Set([(ev) => { evs.push(ev); writer(ev); }]);   // 走正式的 emit 路徑（_bashWasmEmit 會記 diag）
        const buf = await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        const fb = evs.find((e) => e.kind === 'fallback');
        check('T3 備份成功', buf.byteLength === 10);
        check('T3 切換事件寫明網址、階段、原因', !!fb && fb.reason.includes(PRIMARY) && fb.reason.includes('階段：下載') && fb.reason.includes('HTTP 500'), fb);
        check('T3 完成事件標備份來源', evs.some((e) => e.kind === 'done' && e.source === '備份'));
        check('T3 終端機顯示切換備份來源', out.some((s) => s.includes('切換備份來源')));
        check('T3 diag 可看到最近的主要來源失敗', self._terminalDiagText({}).includes('最近一次主要來源失敗：jsDelivr（' + PRIMARY));
    }
    // T4：主要與備份都失敗 → 錯誤訊息同時列出兩邊的網址與原因
    {
        const net = fakeNet({ [PRIMARY]: { status: 500 } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx); let msg = '';
        await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null).catch((e) => { msg = e.message; });
        check('T4 失敗訊息含主要網址、階段、HTTP 狀態', msg.includes(PRIMARY) && msg.includes('階段：下載') && msg.includes('HTTP 500'), msg);
        check('T4 失敗訊息含備份分支的原因', msg.includes('備份分支') && msg.includes('HTTP 404'), msg);
    }
    // T5：快取命中：第二次不打網路，事件為 cache；寫入與讀出都走 Cache API
    {
        const net = fakeNet({ [PRIMARY]: { chunks: [new Uint8Array(1000)], len: 1000 } });
        const caches = fakeCaches();
        const ctx = makeCtx({ fetch: net.fetch, caches });
        const self = makeSelf(ctx);
        await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        const evs = []; const { out, sess } = sink(); const writer = self._terminalBashProgressWriter(sess);
        self._bashWasmSubs = new Set([(ev) => { evs.push(ev); writer(ev); }]);
        const buf = await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        check('T5 第二次快取命中：位元組正確', buf.byteLength === 1000);
        check('T5 第二次不再下載', net.calls.filter((u) => u === PRIMARY).length === 1, net.calls);
        check('T5 事件為快取命中，終端機顯示已使用快取', evs.some((e) => e.kind === 'cache') && out.some((s) => s.includes('已使用快取')), evs);
    }
    // T6：IndexedDB／Cache API 開啟被拒（或逾時）：照常下載，不因快取失敗
    {
        const net = fakeNet({ [PRIMARY]: { chunks: [new Uint8Array(500)], len: 500 } });
        const ctx = makeCtx({ fetch: net.fetch, caches: { open: () => Promise.reject(new Error('denied')) } });
        const self = makeSelf(ctx);
        const buf = await self._fetchAssetBytesWithBackup(PRIMARY, BACKUP, REL, null);
        check('T6 快取開啟被拒仍可載入', buf.byteLength === 500);
    }
    // T7：JS 模組：原生 import 失敗（index.mjs）→ 改用 GitHub 備份的單檔 bundle；事件標來源「備份」
    {
        const net = fakeNet({ [BACKUP + 'wasi-sh.bundle.mjs']: { chunks: [new TextEncoder().encode('export const run = 1;')], len: 21 } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx, { _bashImportModule: async (u) => { if (u.startsWith('blob:')) return { run: () => 'bundle-run', memoryFs: () => 'mfs' }; throw new Error('import 失敗'); } });
        const evs = []; self._bashWasmSubs = new Set([(ev) => evs.push(ev)]);
        const rt = await self._bashLoadJsModules();
        check('T7 備份 bundle 可用（原生 import 不需要）', rt.run() === 'bundle-run', rt);
        check('T7 完成事件標來源備份', evs.some((e) => e.kind === 'done' && e.source === '備份' && e.file === 'wasi-sh.bundle.mjs'), evs.map((e) => e.kind));
    }
    // T7b：所有 JS 來源都失敗 → 錯誤逐一列出網址與原因，不是無聲卡住
    {
        const ctx = makeCtx({ fetch: fakeNet({ [BACKUP + 'wasi-sh.bundle.mjs']: { status: 500 } }).fetch });
        const self = makeSelf(ctx, { _bashImportModule: async () => { throw new Error('import 被擋'); } });
        let msg = ''; await self._bashLoadJsModules().catch((e) => { msg = e.message; });
        check('T7b 全部失敗：列出備份與 jsDelivr 的網址與原因', msg.includes(BACKUP + 'wasi-sh.bundle.mjs') && msg.includes('HTTP 500') && msg.includes('src/index.mjs') && msg.includes('import 被擋'), msg);
    }
    // T7c：設定指定來源（bashSource=jsdelivr）→ 不嘗試備份；自訂網址先於備份
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx, { advancedSettings: { terminal: { bashSource: 'jsdelivr' } } });
        const names = self._bashJsSourceList().map((x) => x.key);
        check('T7c 指定 jsDelivr 時只剩 jsDelivr（匯入的檔案仍保留在最前）', names.join(',') === 'imported,jsdelivr', names);
        const self2 = makeSelf(ctx, { advancedSettings: { terminal: { bashCustomUrl: 'https://mirror.example/wasi' } } });
        const n2 = self2._bashJsSourceList();
        check('T7c 自訂網址排在備份之前，並補上斜線與檔名', n2[1].key === 'custom' && n2[1].url === 'https://mirror.example/wasi/wasi-sh.bundle.mjs', n2.map((x) => x.key));
    }
    // T8：wasm 尚未載入（永遠不 resolve）時，ls／cat 仍立即輸出（只用 JS 檔案系統）
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        let wasmCalls = 0;
        const fsA = fakeFs({ '/work': null, '/work/a.txt': 'hello\n', '/work/.hidden': 'x', '/work/sub': null, '/work/sub/b.txt': 'bbb' });
        const self = makeSelf(ctx, {
            _ensureTerminalFsStore: async () => fsA,
            _ensureBashWasmLoaded: () => { wasmCalls++; return new Promise(() => {}); },
            _fetchAssetBytesWithBackup: () => new Promise(() => {}),
        });
        const a = sink();
        check('T8 ls 列出可見檔案（隱藏檔不列）', (await self._terminalFsFastPath(a.sess, 'ls', '')) === true && a.out.join('') === 'a.txt\r\nsub\r\n', a.out);
        const b = sink();
        check('T8 cat 直接輸出檔案內容', (await self._terminalFsFastPath(b.sess, 'cat', 'a.txt')) === true && b.out.join('') === 'hello\r\n', b.out);
        const c = sink();
        check('T8 ls 子目錄', (await self._terminalFsFastPath(c.sess, 'ls', 'sub')) === true && c.out.join('') === 'b.txt\r\n', c.out);
        const d = sink();
        check('T8 有旗標、shell 運算子、不存在的路徑都交給 shell', (await self._terminalFsFastPath(d.sess, 'ls', '-a')) === false
            && (await self._terminalFsFastPath(d.sess, 'cat', 'a.txt | wc')) === false
            && (await self._terminalFsFastPath(d.sess, 'cat', 'nope.txt')) === false
            && (await self._terminalFsFastPath(d.sess, 'cat', '')) === false, d.out);
        check('T8 全部快路徑沒有等 wasm', wasmCalls === 0, wasmCalls);
    }
    // T9：cd 到現成目錄不等 wasm；不存在的目錄才走 shell 路徑（這裡 wasm 永遠不回，所以會卡住，證明確實走了 shell）
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        let wasmCalls = 0;
        const fsA = fakeFs({ '/work': null, '/work/sub': null });
        const self = makeSelf(ctx, {
            _ensureTerminalFsStore: async () => fsA,
            _ensureBashWasmLoaded: () => { wasmCalls++; return new Promise(() => {}); },
        });
        const s = sink();
        const r = await self._terminalCd(s.sess, 'sub');
        check('T9 cd 到現成目錄：立即換 cwd、不等 wasm', r.ok === true && s.sess.cwd === '/work/sub' && wasmCalls === 0, { r, cwd: s.sess.cwd, wasmCalls });
        self._terminalCd(s.sess, 'nope');
        await tick();
        check('T9 cd 不存在的目錄：交給 shell 路徑', wasmCalls === 1, wasmCalls);
    }
    // T10：背景預載：閒置排程只一次；前景在預載進行中加入，共用同一個載入，每次只下載一次
    {
        const net = fakeNet({ [PRIMARY]: { chunks: [new Uint8Array(4000)], len: 4000 } });
        const ctx = makeCtx({ fetch: net.fetch });
        const self = makeSelf(ctx);
        self._scheduleBashWasmPreload();
        self._scheduleBashWasmPreload();
        check('T10 預載只排程一次', ctx.timers.length === 1, ctx.timers.length);
        ctx.timers[0]();
        const fg = [];
        const rt = await self._ensureBashWasmLoaded((ev) => fg.push(ev));
        check('T10 前景加入進行中的預載：拿到 wasm 位元組', rt.wasmBytes.byteLength === 4000);
        check('T10 前景加入時也收到下載完成事件', fg.some((e) => e.kind === 'done'), fg);
        const rt2 = await self._ensureBashWasmLoaded(null);
        check('T10 預載完成後，後續指令直接拿到 runtime', rt2 === rt);
        check('T10 busybox 只下載一次', net.calls.filter((u) => u === PRIMARY).length === 1, net.calls);
    }
    // T11：省流量模式（saveData）不預載
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch, navigator: { connection: { saveData: true } } });
        const self = makeSelf(ctx);
        self._scheduleBashWasmPreload();
        check('T11 saveData 時不預載', ctx.timers.length === 0);
    }
    // T12：diag 列出階段耗時與成敗；session 已結束時終端機不再寫入
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx);
        const s = sink();
        await self._termTimed(s.sess, '檔案系統初始化', Promise.resolve(1), 1000);
        await self._termTimed(s.sess, 'FAP 掛載讀取', Promise.reject(new Error('x')), 1000).catch(() => {});
        const txt = self._terminalDiagText(s.sess);
        check('T12 diag 列出各階段與成敗', txt.includes('檔案系統初始化：') && txt.includes('（完成）') && txt.includes('FAP 掛載讀取') && txt.includes('（失敗或逾時）'), txt);
        const ended = sink(); ended.sess.ended = true;
        self._terminalBashProgressWriter(ended.sess)({ kind: 'progress', file: REL, source: '主要', loaded: 1, total: 2, elapsedMs: 0 });
        check('T12 session 已結束：不寫入', ended.out.length === 0);
    }

    // T13：停滯判定：沒有新的下載活動超過門檻才逾時，訊息寫明階段、已等秒數與最後的下載量
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx);
        const p = self._termStalled(null, '測試階段', new Promise(() => {}), 30000);
        ctx.tick += 40000;
        ctx.intervals[0]();
        let err = null; await p.catch((e) => { err = e; });
        check('T13 無進展超過門檻：逾時並寫明階段與原因', !!err && err.timedOut && err.message.includes('「測試階段」已 ') && err.message.includes('沒有新的下載進度') && err.message.includes('尚未收到任何下載資料'), err && err.message);
    }
    // T14：有下載活動就不算卡住：即使總時間超過門檻，只要最近有進度就繼續等，完成後正常回傳
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx);
        let resolveP; const work = new Promise((r) => { resolveP = r; });
        const p = self._termStalled(null, '測試階段', work, 30000);
        ctx.tick += 40000;
        self._bashWasmEmit({ kind: 'progress', file: REL, source: '主要', loaded: 5, total: 10, elapsedMs: 1 });
        ctx.intervals[0]();
        resolveP(42);
        check('T14 有新位元組：不逾時，正常回傳', (await p) === 42);
    }
    // T15：互動路徑的 echo：在任何載入（_ensureTerminalProgramLoaded 永不回）之前就輸出
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx, {
            _terminalGroupCompoundLine: () => [{ type: 'shell', text: '' }],
            _terminalSplitAiPipe: () => null,
            _terminalSplitPyPipe: () => null,
            _terminalSetExit: (sess, code) => { sess.exit = code; },
            _ensureTerminalProgramLoaded: () => new Promise(() => {}),
        });
        const a = sink();
        await self._runTerminalCommand(a.sess, 'echo hi there');
        check('T15 echo 互動路徑：立即輸出、不等載入', a.out.join('') === 'hi there\r\n' && a.sess.exit === 0, a.out);
        const b = sink();
        await self._runTerminalCommand(b.sess, 'echo -n x');
        check('T15 echo -n：不換行', b.out.join('') === 'x', b.out);
    }
    // T16：diag 顯示版本、輸入事件紀錄（最後 10 筆）；沒有輸入時明說沒有事件到達
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx);
        const s = sink(); s.sess._inputLog = [];
        const empty = self._terminalDiagText(s.sess);
        check('T16 diag 有版本與「沒有輸入事件」的明說', empty.includes('版本：v504') && empty.includes('沒有任何輸入事件到達終端機'), empty);
        for (let i = 0; i < 12; i++) self._terminalRecordInput(s.sess, 'keydown', { key: 'e', keyCode: 229 });
        self._terminalRecordInput(s.sess, 'data', { data: 'e' });
        const txt = self._terminalDiagText(s.sess);
        check('T16 輸入紀錄只留最後 10 筆', s.sess._inputLog.length === 10 && txt.includes('data "e"') && txt.includes('keydown e/keyCode=229'), s.sess._inputLog.length);
    }
    // T17：快捷列「診斷」：直接把 diag 印到終端機，不送進指令
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch });
        const self = makeSelf(ctx);
        const s = sink(); s.sess._inputLog = [];
        self._terminalPrintDiag(s.sess);
        check('T17 診斷按鈕印出版本與輸入紀錄', s.out.join('').includes('版本：v504') && s.out.join('').includes('最後 10 個輸入事件'), s.out.length);
    }
    // T18：設定白名單：來源只收已知值、自訂網址只收 http(s)、逾時秒數夾在 5–120、預載預設開
    {
        const ctx = makeCtx({ fetch: fakeNet({}).fetch, TERMINAL_THEME_PRESETS: { dark: {} } });
        const self = makeSelf(ctx, { _createDefaultAdvancedSettings: () => ({ terminal: { fontFamily: 'monospace', fontSize: 13, cols: 0, scrollback: 1000, theme: 'system', resourcePolicy: 'focus', resourceCountLimit: 3 } }) });
        const ok = self._normalizeTerminalSettings({ bashSource: 'backup', bashCustomUrl: 'https://mirror.example/x', bashStallSec: 999, bashPreload: false });
        check('T18 來源、自訂網址、預載保留合法值', ok.bashSource === 'backup' && ok.bashCustomUrl === 'https://mirror.example/x' && ok.bashPreload === false, ok);
        check('T18 逾時秒數夾在 5–120（超過回到預設 20）', ok.bashStallSec === 20 && self._normalizeTerminalSettings({ bashStallSec: 3 }).bashStallSec === 20 && self._normalizeTerminalSettings({ bashStallSec: 45 }).bashStallSec === 45);
        const bad = self._normalizeTerminalSettings({ bashSource: 'evil', bashCustomUrl: 'javascript:alert(1)' });
        check('T18 未知來源退回自動；非 http(s) 網址清空；預載預設開', bad.bashSource === 'auto' && bad.bashCustomUrl === '' && bad.bashPreload === true, bad);
    }
    console.log('terminal_progress.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
