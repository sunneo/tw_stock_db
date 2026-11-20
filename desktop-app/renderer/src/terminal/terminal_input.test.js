// node renderer/src/terminal/terminal_input.test.js
// 手機終端機輸入（從 floating-assistant.js 抽出 _handleTerminalInput／_terminalMobileInputSetup／_terminalKeyBarKeys，用假的 session 與假的 shell 執行）：
// 1) 螢幕鍵盤的組字結果（xterm 在 compositionend 時把整段文字當成一次 onData 送來）＋Enter 能執行 ls；
// 2) 指令永不結束：看門狗逾時後放開 busy、寫出說明、之後的輸入照常進來（不再整個卡住）；
// 3) 指令執行中的輸入：只提示一次，不默默吃掉；
// 4) 正常結束：沒有逾時訊息；5) 手機的 textarea 屬性與快捷鍵列（Enter、Tab、方向鍵、Ctrl+C）。
// 全部是假的（假 xterm、假 shell、假 DOM）；真手機（Galaxy A54）的 IME 行為沒有驗證。
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
const NAMES = ['_handleTerminalInput', '_terminalMobileInputSetup', '_terminalKeyBarKeys'];
const ctx = { console, Promise, JSON, Date, Math, Number, Array, Object, String, Error, setTimeout, clearTimeout, window: {}, navigator: { maxTouchPoints: 5 } };
vm.createContext(ctx);
const M = vm.runInContext('({' + NAMES.map(methodSource).join(',\n') + '})', ctx);

// 假的 session 與 self：shell（_terminalRunUnits）由每個情境決定
function makeSelf(runUnits) {
    const out = [];
    const self = Object.assign({
        _terminalScanInput: (text) => ({ incomplete: false, units: [text] }),
        _terminalRunUnits: runUnits,
        _writeTerminalPrompt: () => out.push('<PROMPT>'),
        _persistTerminalSnapshot: async () => {},
        _redrawTerminalLine: () => {},
        _terminalSetExit: () => {},
        _terminalInterrupt: () => {},
        _terminalStdinFeed: () => {},
        _handleTerminalTabComplete: async () => {},
        _terminalPromptText: () => '$ ',
        _setTerminalLine: () => {},
        _terminalWatchdogMs: 40,
    }, M);
    const session = { line: '', cursorPos: 0, busy: false, history: [], historyIndex: 0, pending: null, ended: false, activeProgram: null, _stdinWaiter: null,
        term: { write: (s) => out.push(String(s)) } };
    return { self, session, out };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // 1. 螢幕鍵盤組字：xterm 把組好的 "ls" 當成一次 onData 送來，接著 Enter，應該執行 ls
    {
        const ran = []; const { self, session, out } = makeSelf(async (sess, units) => { ran.push(units); return { ok: true }; });
        await self._handleTerminalInput(session, 'ls');   // composition 結束後的整段文字
        check('1 組字結果先進入行緩衝', session.line === 'ls', session.line);
        await self._handleTerminalInput(session, '\r');   // Enter（keyCode 229 的 Enter，xterm 轉成 \r）
        check('1 Enter 執行 ls', ran.length === 1 && ran[0][0] === 'ls', ran);
        check('1 執行完回到提示字元、行緩衝清空、busy 解除', out.includes('<PROMPT>') && session.line === '' && session.busy === false, { line: session.line, busy: session.busy });
    }
    // 2. 指令永不結束：看門狗逾時 → 寫出說明、busy 解除、之後的輸入照常進來
    {
        const { self, session, out } = makeSelf(() => new Promise(() => {}));   // 永遠不 resolve
        session.line = 'ls';
        const t0 = Date.now();
        await self._handleTerminalInput(session, '\r');
        const took = Date.now() - t0;
        check('2 看門狗讓 Enter 的處理在逾時後結束（不是永遠卡住）', took < 1000, took);
        check('2 寫出逾時說明', out.some((x) => String(x).includes('沒有結束')), out);
        check('2 busy 解除、標記逾時', session.busy === false && session._timedOut === true, { busy: session.busy, t: session._timedOut });
        await self._handleTerminalInput(session, 'p');
        check('2 逾時後的輸入照常進來', session.line === 'p', session.line);
    }
    // 3. 指令執行中的輸入：提示一次、不默默吃掉；Ctrl+C 仍然送得進去
    {
        const { self, session, out } = makeSelf(async () => ({ ok: true }));
        session.busy = true;
        await self._handleTerminalInput(session, 'a');
        await self._handleTerminalInput(session, 'b');
        const hints = out.filter((x) => String(x).includes('還在執行')).length;
        check('3 執行中的輸入：只提示一次', hints === 1, { hints, out });
        check('3 執行中的字元不進行緩衝（等它結束）', session.line === '', session.line);
    }
    // 4. 正常結束：沒有逾時訊息
    {
        const { self, session, out } = makeSelf(async () => { await sleep(5); return { ok: true }; });
        session.line = 'echo hi';
        await self._handleTerminalInput(session, '\r');
        check('4 正常結束沒有逾時訊息', !out.some((x) => String(x).includes('沒有結束')) && session._timedOut === false, out);
    }
    // 5. 手機輸入：textarea 關掉自動大寫／更正（Gboard 會把 ls 變成 Ls），Enter 標成傳送；快捷鍵列含 Enter、Tab、方向鍵、Ctrl+C
    {
        const attrs = {}; const ta = { setAttribute: (k, v) => { attrs[k] = v; } };
        const made = []; const fakeEl = () => { const e = { style: {}, dataset: {}, children: [], addEventListener: (t, f) => { e['on' + t] = f; }, appendChild(c) { this.children.push(c); return c; } }; return e; };
        ctx.document = { createElement: (tag) => { const e = fakeEl(); e.tag = tag; made.push(e); return e; } };
        const container = { querySelector: (sel) => (sel === 'textarea' ? ta : null), parentNode: {}, insertAdjacentElement(where, el) { this.inserted = [where, el]; } };
        const { self, session } = makeSelf(async () => ({ ok: true }));
        const bar = self._terminalMobileInputSetup(container, session);
        check('5 textarea：自動大寫、自動更正、拼字檢查關閉，Enter 標示傳送', attrs.autocapitalize === 'off' && attrs.autocorrect === 'off' && attrs.spellcheck === 'false' && attrs.enterkeyhint === 'send', attrs);
        const labels = (bar && bar.children || []).map((b) => b.textContent);
        check('5 快捷鍵列含 Enter、Tab、↑↓←→、Ctrl+C', ['Enter', 'Tab', '↑', '↓', '←', '→', 'Ctrl+C'].every((x) => labels.includes(x)), labels);
        const enterBtn = (bar.children || []).find((b) => b.textContent === 'Enter');
        check('5 快捷鍵的 Enter 送 \\r（Tab 送 \\t）', enterBtn && enterBtn.dataset.seq === '\r' && (bar.children.find((b) => b.textContent === 'Tab').dataset.seq === '\t'));
        check('5 快捷鍵列插在終端機後面', container.inserted && container.inserted[0] === 'afterend' && container.inserted[1] === bar);
        // 按快捷鍵 Enter 等同於輸入 \r：先放 ls 進行緩衝，再按 Enter
        const ran = []; const s2 = makeSelf(async (sess, units) => { ran.push(units); return { ok: true }; }); s2.session.line = 'ls';
        await s2.self._handleTerminalInput(s2.session, enterBtn.dataset.seq);
        check('5 快捷鍵 Enter 真的執行 ls', ran.length === 1 && ran[0][0] === 'ls', ran);
    }
    // 6. 桌面（沒有觸控）：不加快捷鍵列，textarea 仍設定
    {
        const savedWin = ctx.window; ctx.window = {}; ctx.navigator = { maxTouchPoints: 0 };
        const { self, session } = makeSelf(async () => ({ ok: true }));
        const container = { querySelector: () => null, parentNode: {}, insertAdjacentElement() { throw new Error('不應該加快捷鍵列'); } };
        const r = self._terminalMobileInputSetup(container, session);
        check('6 桌面不加快捷鍵列', r === null);
        ctx.window = savedWin;
    }

    console.log('terminal_input.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
