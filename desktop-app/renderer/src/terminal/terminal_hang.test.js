// node renderer/src/terminal/terminal_hang.test.js
// 指令不再被自動中斷（使用者要求拿掉看門狗）：任何階段卡住都一直等，只有 Ctrl-C 才放開。
// 方法本體從 floating-assistant.js 抽出，用假的依賴執行（不碰網路、儲存或真的 shell）。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };
function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    let i = SRC.indexOf(') {\n', m.index) + 2; let depth = 0;   // 參數預設值（如 opts = {}）裡也有大括號，從簽名結尾的 ) { 開始配對
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
    return SRC.slice(m.index + 1, i + 1);
}

const NAMES = ['_handleTerminalInput', '_terminalCapFor', '_termTimed', '_terminalInterrupt', '_terminalRunWasmLine'];
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
        _bashDownloading: () => false,
        _bashCancelLoads: () => {},
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
    // 1. 卡住的指令不會被自動結束：等很久仍然忙碌，沒有任何逾時訊息
    {
        const self = makeSelf({ _terminalRunUnits: () => never() });
        const session = makeSession(self);
        session.line = 'ls';
        const run = self._handleTerminalInput(session, '\r');
        await sleep(150);
        check('1 卡住的指令仍忙碌（沒有看門狗）', session.busy === true && !self.out.some((x) => /超過|沒有新輸出|已中斷/.test(String(x))), self.out);
        self._terminalInterrupt(session);
        await run;
        check('1 Ctrl-C 才放開 busy，並寫出中斷來源', session.busy === false && self.out.some((x) => String(x).includes('已中斷')), self.out);
    }
    // 2. 各階段卡住都一直等：bash 載入、檔案系統、FAP 掛載、shell 執行
    const stages = [
        ['bash 載入', { _ensureBashWasmLoaded: never }],
        ['檔案系統', { _ensureTerminalFsStore: never }],
        ['FAP 掛載', { _hydrateReferencedFapMounts: never }],
        ['shell 執行', { _terminalRun: never }],
    ];
    for (const [label, over] of stages) {
        const self = makeSelf(Object.assign({ _terminalRun: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, over));
        let done = false;
        self._terminalRunWasmLine(makeSession(self), 'ls').then(() => { done = true; }, () => { done = true; });
        await sleep(80);
        check('2 ' + label + ' 卡住：仍在等（沒有逾時）', done === false);
    }
    // 3. 正常的指令：不寫任何逾時或中斷訊息
    {
        const self = makeSelf({ _terminalRunUnits: async () => ({ ok: true }) });
        const session = makeSession(self);
        session.line = 'ls';
        await self._handleTerminalInput(session, '\r');
        check('3 正常指令：沒有多餘訊息', !self.out.some((x) => /超過|沒有新輸出|已中斷|command not found/.test(String(x))), self.out);
    }
    console.log('terminal_hang.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
