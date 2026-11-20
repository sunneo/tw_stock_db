// node renderer/src/terminal/terminal_fastpath.test.js
// 快路徑：echo／pwd 在 JS 直接算出結果，完全不呼叫 bash wasm、檔案系統或 FAP 掛載（即使那些永遠不會完成也一樣）；
// 有重導向或 shell 運算子時不走快路徑。方法本體從 floating-assistant.js 抽出，用假的依賴執行。
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
const ctx = { console, Promise, JSON, Date, Math, Number, Array, Object, String, Error, Set, Map, setTimeout };
vm.createContext(ctx);
const M = vm.runInContext('({' + methodSource('_terminalExecSimpleCommand') + '})', ctx);
let wasmCalls = 0;
const self = Object.assign({
    _terminalApplyShellAssignment: () => {},
    _terminalExpandWord: (w) => ({ text: String(w) }),
    _terminalHasShellOps: (w) => /[|&;<>$`()]/.test(String(w)),
    _terminalIsVirtualCommandWord: () => false,
    _terminalRunWasmLine: () => { wasmCalls++; return new Promise(() => {}); },
    _terminalRunShellText: () => { wasmCalls++; return new Promise(() => {}); },
}, M);
const node = (words, extra) => Object.assign({ assignments: [], argvWords: words }, extra || {});
(async () => {
    const session = { cwd: '/work' };
    const e = (words, extra) => self._terminalExecSimpleCommand(session, node(words, extra), {}, { streamToWidget: true });
    const r1 = await e(['echo', 'hi']);
    check('1 echo hi 立刻得到 hi（不碰 shell）', r1.stdout === 'hi\n' && r1.exitCode === 0, r1);
    const r2 = await e(['echo', '-n', 'x', 'y']);
    check('2 echo -n：不換行', r2.stdout === 'x y', r2);
    const r3 = await e(['pwd']);
    check('3 pwd 回傳目前目錄', r3.stdout === '/work\n', r3);
    // 有重導向：不走快路徑；後面的執行路徑需要更多依賴（這裡不假裝有），所以會在 _terminalBuildEnvPrefix 丟錯——丟到那裡就證明快路徑被略過了
    let threw = ''; await e(['echo', 'a'], { redirects: [{ op: '>' }] }).catch((err) => { threw = String((err && err.message) || err); });
    check('4 有重導向：不走快路徑（過了快路徑，進到後面的執行步驟）', threw.includes('_terminalBuildEnvPrefix'), threw);
    check('5 全部快路徑沒有呼叫 bash wasm', wasmCalls === 0, wasmCalls);
    console.log('terminal_fastpath.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
