// node renderer/src/terminal/terminal_input.test.js
// 手機終端機輸入（從 floating-assistant.js 抽出 _handleTerminalInput／_terminalMobileInputSetup／_terminalKeyBarKeys，用假的 session 與假的 shell 執行）：
// 1) 螢幕鍵盤的組字結果（xterm 在 compositionend 時把整段文字當成一次 onData 送來）＋Enter 能執行 ls；
// 2) 指令永不結束：看門狗逾時後放開 busy、寫出說明、之後的輸入照常進來（不再整個卡住）；
// 3) 指令執行中的輸入：只提示一次，不默默吃掉；
// 4) 正常結束：沒有逾時訊息；5) 手機的 textarea 屬性與快捷鍵列（Enter、Tab、方向鍵、Ctrl+C）。
// 全部是假的（假 xterm、假 shell、假 DOM）；真手機（Galaxy A54）的 IME 行為沒有驗證。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');

// 假的 DOM：元素有 style／dataset／children，click() 與 _fire(type, ev) 觸發監聽器
function fakeEl() {
    const e = { style: {}, dataset: {}, children: [], _l: {}, textContent: '', className: '', type: '', _attrs: {} };
    e.addEventListener = (t, f) => { e._l[t] = f; };
    e._fire = (t, ev) => { if (e._l[t]) e._l[t](ev || { preventDefault() {} }); };
    e.click = () => e._fire('click', {});
    e.appendChild = (c) => { e.children.push(c); return c; };
    e.setAttribute = (k, v) => { e._attrs[k] = v; };
    e.getAttribute = (k) => e._attrs[k];
    return e;
}
function fakeDocument() { return { createElement: () => fakeEl() }; }

let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const NAMES = ['_handleTerminalInput', '_terminalMobileInputSetup', '_terminalKeyBarKeys', '_terminalCapFor'];
const ctx = { console, Promise, JSON, Date, Math, Number, Array, Object, String, Error, setTimeout, clearTimeout, window: {}, navigator: { maxTouchPoints: 5 } };
vm.createContext(ctx);
const M = vm.runInContext('({' + NAMES.map(methodSource).join(',\n') + '})', ctx);

// 假的 session 與 self：shell（_terminalRunUnits）由每個情境決定
function makeSelf(runUnits) {
    const out = [];
    const self = Object.assign({
        _terminalRecordInput: () => {},
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
    // 5. 手機輸入：textarea 關掉自動大寫／更正（Gboard 會把 ls 變成 Ls），Enter 標成傳送；快捷列（工具列在包裝層裡）含 Enter、Tab、方向鍵、Ctrl+C；插在終端機後面
    {
        const attrs = {}; const ta = { setAttribute: (k, v) => { attrs[k] = v; } };
        ctx.document = fakeDocument();
        const container = { querySelector: (sel) => (sel === 'textarea' ? ta : null), parentNode: {}, insertAdjacentElement(where, el) { this.inserted = [where, el]; } };
        const { self, session } = makeSelf(async () => ({ ok: true }));
        const wrap = self._terminalMobileInputSetup(container, session);
        const bar = wrap.children[1];
        check('5 textarea：自動大寫、自動更正、拼字檢查關閉，Enter 標示傳送', attrs.autocapitalize === 'off' && attrs.autocorrect === 'off' && attrs.spellcheck === 'false' && attrs.enterkeyhint === 'send', attrs);
        const labels = bar.children.map((b) => b.textContent);
        check('5 快捷列含 Enter、Tab、↑↓←→、Ctrl+C、Esc、Ctrl、Alt', ['Enter', 'Tab', '↑', '↓', '←', '→', 'Ctrl+C', 'Esc', 'Ctrl', 'Alt'].every((x) => labels.includes(x)), labels);
        check('5 快捷列插在終端機後面（包裝層）', container.inserted && container.inserted[0] === 'afterend' && container.inserted[1] === wrap);
        const enterBtn = bar.children.find((b) => b.textContent === 'Enter');
        const ran = []; const s2 = makeSelf(async (sess, units) => { ran.push(units); return { ok: true }; }); s2.session.line = 'ls';
        const w2 = s2.self._terminalMobileInputSetup(container, s2.session);
        const enter2 = w2.children[1].children.find((b) => b.textContent === 'Enter');
        enter2.click();
        check('5 快捷列 Enter 真的執行 ls（走實體鍵盤同一條路）', ran.length === 1 && ran[0][0] === 'ls', ran);
    }
    // 7. 修飾鍵（非同步：中間會等 500 ms）：Ctrl 點一下＝下一個字元生效後自動解除；快速點兩下＝鎖定（再點一下解除）；Alt＝ESC 前綴
    {
        const { self, session, out } = makeSelf(async () => ({ ok: true }));
        const seen = []; session.term.write = () => {}; self._handleTerminalInput = async (s, data) => { seen.push(data); };
        ctx.document = fakeDocument();
        const container = { querySelector: () => null, parentNode: {}, insertAdjacentElement() {} };
        const wrap = self._terminalMobileInputSetup(container, session); const bar = wrap.children[1];
        const btn = (label) => bar.children.find((b) => b.textContent === label || (label === 'Ctrl' && b.dataset.mod === 'ctrl') || (label === 'Alt' && b.dataset.mod === 'alt'));   // 修飾鍵鎖定時文字會變成 Ctrl🔒，用 data-mod 找
        btn('Ctrl').click(); btn('|').click(); btn('|').click();
        check('7 Ctrl 點一下：下一個字元變控制字元（| → 0x1c），然後解除', seen[0] === '\x1c' && seen[1] === '|', seen);
        seen.length = 0;
        await sleep(500);   // 離開上一次點擊的 450 ms 雙擊視窗
        btn('Ctrl').click(); btn('Ctrl').click();   // 快速兩下＝鎖定
        btn('|').click(); btn('/').click();
        check('7 Ctrl 鎖定：連續兩個字元都是控制字元', seen[0] === '\x1c' && seen[1] === '\x0f', seen);
        seen.length = 0;
        btn('Ctrl').click();   // 點一下解除鎖定
        btn('/').click();
        check('7 解除鎖定後回到一般字元', seen[0] === '/', seen);
        seen.length = 0;
        btn('Alt').click(); btn('|').click();
        check('7 Alt＝ESC 前綴', seen[0] === '\x1b|', seen);
        seen.length = 0;
        btn('Esc').click(); btn('Home').click(); btn('End').click(); btn('PgUp').click(); btn('PgDn').click(); btn('←').click(); btn('→').click();
        check('7 Esc／Home／End／PgUp／PgDn／←→ 的序列正確', JSON.stringify(seen) === JSON.stringify(['\x1b', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~', '\x1b[D', '\x1b[C']), seen);
    }
    // 8. Tab 真的觸發補全（走 _handleTerminalInput 的 Tab 分支）；按鈕不搶焦點（mousedown／pointerdown 都 preventDefault）
    {
        const { self, session } = makeSelf(async () => ({ ok: true }));
        let tabbed = 0; self._handleTerminalTabComplete = async () => { tabbed++; };
        ctx.document = fakeDocument();
        const container = { querySelector: () => null, parentNode: {}, insertAdjacentElement() {} };
        const wrap = self._terminalMobileInputSetup(container, session); const bar = wrap.children[1];
        bar.children.find((b) => b.textContent === 'Tab').click();
        check('8 Tab 觸發補全', tabbed === 1, tabbed);
        let prevented = 0; const ev = { preventDefault: () => { prevented++; } };
        const esc = bar.children.find((b) => b.textContent === 'Esc');
        esc._fire('mousedown', ev); esc._fire('pointerdown', ev);
        check('8 按鈕不搶焦點（mousedown／pointerdown 都 preventDefault）', prevented === 2, prevented);
    }
    // 9. 收起／展開快捷列會記在 localStorage；下次以記住的狀態顯示；localStorage 拿不到時不出錯
    {
        const store = {}; ctx.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
        const { self, session } = makeSelf(async () => ({ ok: true }));
        ctx.document = fakeDocument();
        const container = { querySelector: () => null, parentNode: {}, insertAdjacentElement() {} };
        const wrap = self._terminalMobileInputSetup(container, session); const bar = wrap.children[1]; const toggle = wrap.children[0];
        check('9 預設（觸控）：快捷列顯示', bar.style.display === 'flex');
        toggle.click();
        check('9 點收起：隱藏，並存 off', bar.style.display === 'none' && store.fa_term_keybar === 'off', { d: bar.style.display, s: store.fa_term_keybar });
        const again = self._terminalMobileInputSetup(container, session);
        check('9 下次以記住的 off 顯示（隱藏）', again.children[1].style.display === 'none');
        ctx.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        let threw = false; try { self._terminalMobileInputSetup(container, session); toggle.click(); } catch (_) { threw = true; }
        check('9 localStorage 拿不到：不丟錯、用預設', !threw);
        ctx.localStorage = undefined;
    }
    // 10. 虛擬鍵盤：快捷列貼在鍵盤上方（visualViewport），鍵盤收起就回到原位
    {
        const { self, session } = makeSelf(async () => ({ ok: true }));
        ctx.document = fakeDocument();
        const vv = { height: 500, offsetTop: 0, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
        ctx.window.innerHeight = 800; ctx.window.visualViewport = vv;
        const container = { querySelector: () => null, parentNode: {}, insertAdjacentElement() {} };
        const wrap = self._terminalMobileInputSetup(container, session);
        vv.listeners.resize();
        check('10 鍵盤跳出（可見高度 500／視窗 800）：快捷列固定在鍵盤上方 300px', wrap.style.position === 'fixed' && wrap.style.bottom === '300px', { p: wrap.style.position, b: wrap.style.bottom });
        vv.height = 800; vv.listeners.resize();
        check('10 鍵盤收起：回到原位', wrap.style.position === '' && wrap.style.bottom === '', { p: wrap.style.position });
        ctx.window.visualViewport = undefined;
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
