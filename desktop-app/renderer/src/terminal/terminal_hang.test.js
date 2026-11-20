// node renderer/src/terminal/terminal_hang.test.js
// 指令卡住（手機實測：ls 顯示「指令執行中」一直不結束）：從 floating-assistant.js 抽出真的方法，用假的 shell 與假的檔案系統層：
// 1) 每個階段（bash 載入、檔案系統、FAP 掛載、內建工具、shell 執行）都有硬上限，逾時的錯誤寫出「卡在哪一個階段」；
// 2) 指令的硬上限：快速指令 5 秒、長時間指令 120 秒、其餘 30 秒；
// 3) Ctrl+C 立刻放開 busy（就算卡在還沒註冊中止函式的階段）；中斷前不保留按鍵；
// 4) 看門狗的訊息寫出卡在的階段；5) 逾時後丟掉執行環境，下一次重新載入。
// 全部是假的（假的永不 resolve 的 Promise、假 runtime）；真手機上卡在哪一層沒有驗證。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const NAMES = ['_handleTerminalInput', '_terminalCapFor', '_termTimed', '_termStalled', '_terminalInterrupt', '_terminalRunWasmLine'];
const ctx = { console, Promise, JSON, Date, Math, Number, Array, Object, String, Error, Set, Map, Uint8Array, TextDecoder, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, performance: { now: () => Date.now() } };
vm.createContext(ctx);
const M = vm.runInContext('({' + NAMES.map(methodSource).join(',\n') + '})', ctx);
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假的 self：所有會被呼叫的方法都是假的（或預設成安全的空實作）
function makeSelf(over) {
    const self = Object.assign({
        _terminalScanInput: (text) => ({ incomplete: false, units: [text] }),
        _terminalRunUnits: never,
        _writeTerminalPrompt: () => self.out.push('<PROMPT>'),
        _persistTerminalSnapshot: async () => {},
        _redrawTerminalLine: () => {}, _terminalSetExit: () => {}, _terminalInterrupt: null,
        _terminalStdinFeed: () => {}, _handleTerminalTabComplete: async () => {}, _terminalPromptText: () => '$ ',
        _setTerminalLine: () => {}, _guiAudioStop: () => {},
        _ensureBashWasmLoaded: async () => ({ wasmBytes: new Uint8Array(4), run: never }),
        _terminalBashProgressWriter: () => () => {},
        _ensureTerminalFsStore: async () => ({}),
        _hydrateReferencedFapMounts: async () => {},
        _buildTerminalSandboxBuiltins: async () => ({}),
        _terminalComputeBashSpecialVars: () => ({}),
        _terminalRewriteBuiltinPaths: (s) => s,
        _shQuote: (s) => "'" + String(s) + "'",
        _terminalRun: never,
        _terminalWriteOutput: (sess, t) => t, _terminalFilterGuiLines: (sess, t) => t,
        _terminalResolvePath: (cwd, t) => t, _writeBytesToTerminalFs: () => {},
        _terminalWatchdogMs: 30,
        out: [],
    }, M, over || {});
    self._terminalInterrupt = M._terminalInterrupt.bind(self);
    return self;
}
function makeSession(self) {
    const writes = [];
    const session = { line: '', cursorPos: 0, busy: false, history: [], historyIndex: 0, pending: null, ended: false, activeProgram: null, _stdinWaiter: null, cwd: '/work',
        term: { write: (s) => { writes.push(String(s)); self.out.push(String(s)); } }, writes };
    return session;
}

(async () => {
    // 1. 指令的硬上限
    {
        const self = makeSelf();
        check('1 ls 5 秒', self._terminalCapFor('ls -la').ms === 5000, self._terminalCapFor('ls -la'));
        check('1 /bin/ls 也是 5 秒', self._terminalCapFor('/bin/ls').ms === 5000);
        check('1 python3 是長時間（120 秒）', self._terminalCapFor('python3 x.py').ms === 120000);
        check('1 其他指令 30 秒', self._terminalCapFor('foo bar').ms === 30000);
    }
    // 2. 階段逾時：_termTimed 的錯誤訊息寫出階段名稱、標記 timedOut；沒逾時就照常回傳
    {
        const self = makeSelf();
        let err = null; try { await self._termTimed(null, 'FAP 掛載讀取', never(), 20); } catch (e) { err = e; }
        check('2 逾時錯誤寫出階段名稱', err && err.message.includes('FAP 掛載讀取') && err.message.includes('沒有完成') && err.timedOut === true, err && err.message);
        const v = await self._termTimed(null, 'x', Promise.resolve(42), 1000);
        check('2 沒逾時照常回傳結果', v === 42);
    }
    // 3. 整條 _terminalRunWasmLine：每個階段都有上限（測試時把每個階段的上限縮成 20 毫秒）；卡在 shell 執行時丟掉執行環境
    {
        const self = makeSelf({ _ensureBashWasmLoaded: async () => ({ wasmBytes: new Uint8Array(4), run: never }) });
        self._termTimed = (sess, stage, p, ms) => M._termTimed.call(self, sess, stage, p, 20);
        self._bashWasmRuntime = { wasmBytes: new Uint8Array(4) };
        const session = makeSession(self);
        const r = await self._terminalRunWasmLine(session, 'ls');
        check('3 shell 執行卡住：回傳錯誤（不是永遠等）', r && r.ok === false && r.error.includes('指令執行（shell）'), r);
        check('3 逾時後丟掉執行環境，下次重新載入', self._bashWasmRuntime === null, self._bashWasmRuntime);
    }
    {   // 3b. bash 載入卡住：錯誤寫出「bash 執行環境載入」，載入的 promise 被清掉（下次重試）
        const self = makeSelf({ _ensureBashWasmLoaded: never });
        self._termTimed = (sess, stage, p, ms) => M._termTimed.call(self, sess, stage, p, 20);
        self._termStalled = (sess, stage, p, ms) => M._termStalled.call(self, sess, stage, p, 20);   // bash 載入改用「沒有新下載進度」判定，這裡縮成 20ms
        self._bashWasmLoadPromise = Promise.resolve(); self._bashWasmRuntime = null;
        const r = await self._terminalRunWasmLine(makeSession(self), 'ls');
        check('3b bash 載入卡住：錯誤指出階段', r.ok === false && r.error.includes('bash 執行環境載入'), r);
    }
    {   // 3c. 檔案系統（例如 IndexedDB 開啟被擋）卡住：錯誤指出「檔案系統初始化」
        const self = makeSelf({ _ensureTerminalFsStore: never });
        self._termTimed = (sess, stage, p, ms) => M._termTimed.call(self, sess, stage, p, 20);
        const r = await self._terminalRunWasmLine(makeSession(self), 'ls');
        check('3c 檔案系統卡住（IndexedDB 被擋／很慢）：錯誤指出階段', r.ok === false && r.error.includes('檔案系統初始化'), r);
    }
    {   // 3d. FAP 掛載讀取很慢：錯誤指出「FAP 掛載讀取」，流程不會無限等
        const self = makeSelf({ _hydrateReferencedFapMounts: never });
        self._termTimed = (sess, stage, p, ms) => M._termTimed.call(self, sess, stage, p, 20);
        const r = await self._terminalRunWasmLine(makeSession(self), 'ls /mnt/x');
        check('3d FAP 掛載讀取很慢：錯誤指出階段', r.ok === false && r.error.includes('FAP 掛載讀取'), r);
    }
    // 4. Ctrl+C 立刻放開 busy（卡在還沒註冊中止函式的階段），顯示「已中斷」；中斷前卡住的階段寫出來
    {
        const self = makeSelf({ _terminalRunUnits: (sess) => { sess._stage = '檔案系統初始化'; return never(); } });
        const session = makeSession(self);
        session.line = 'ls';
        const enter = self._handleTerminalInput(session, '\r');   // 不 await：模擬卡住
        await sleep(5);
        check('4 卡住時 busy=true、正在等', session.busy === true);
        await self._handleTerminalInput(session, '\x03');
        await enter;
        check('4 Ctrl+C 立刻放開 busy', session.busy === false, session.busy);
        check('4 顯示已中斷與卡住的階段', self.out.some((x) => String(x).includes('已中斷') && String(x).includes('檔案系統初始化')), self.out);
        check('4 中斷後提示字元回來', self.out.includes('<PROMPT>'));
    }
    // 5. 卡住時的按鍵：只提示一次、不保留；中斷後新的按鍵照常進來（不會把卡住時打的字補進來）
    {
        const self = makeSelf();
        const session = makeSession(self);
        session.line = 'ls';
        const enter = self._handleTerminalInput(session, '\r');
        await sleep(5);
        await self._handleTerminalInput(session, 'a');
        await self._handleTerminalInput(session, 'b');
        const hints = self.out.filter((x) => String(x).includes('還在執行')).length;
        check('5 卡住時的按鍵：只提示一次', hints === 1, hints);
        await self._handleTerminalInput(session, '\x03'); await enter;
        await self._handleTerminalInput(session, 'c');
        check('5 中斷後的新按鍵照常，卡住時打的字不補進來', session.line === 'c', session.line);
    }
    // 6. 看門狗：逾時的訊息寫出指令、上限、卡住的階段；之後能再輸入
    {
        const self = makeSelf({ _terminalRunUnits: (sess) => { sess._stage = 'FAP 掛載讀取'; return never(); }, _terminalWatchdogMs: 30 });
        const session = makeSession(self);
        session.line = 'ls';
        await self._handleTerminalInput(session, '\r');
        check('6 看門狗訊息含指令、類別與卡住的階段', self.out.some((x) => String(x).includes('快速指令') && String(x).includes('「ls」') && String(x).includes('卡在：FAP 掛載讀取')), self.out);
        check('6 看門狗之後放開 busy', session.busy === false);
        await self._handleTerminalInput(session, 'x');
        check('6 之後的輸入照常進來', session.line === 'x', session.line);
    }
    // 7. 正常的指令：不寫任何逾時或中斷訊息
    {
        const self = makeSelf({ _terminalRunUnits: async () => ({ ok: true }) });
        const session = makeSession(self);
        session.line = 'echo hi';
        await self._handleTerminalInput(session, '\r');
        check('7 正常結束沒有逾時／中斷訊息', !self.out.some((x) => String(x).includes('沒有結束') || String(x).includes('已中斷')), self.out);
    }

    console.log('terminal_hang.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
