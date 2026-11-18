// node renderer/src/recipe/aidoc_ask_chat.test.js
// /aidoc ask 的聊天核心接線：_aidocAskChat 把索引查到的程式碼當參考資料，交給 _offlineLlmAnswer，範圍限定專案程式碼（不給工具、不混入訓練器的規則與問答）。
// 從 floating-assistant.js 抽出真正的方法本體，用假的 this 驗證，不碰模型。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    let i = SRC.indexOf('{', m.index + m[0].length); let depth = 0; const start = m.index + 1;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '/' && SRC[i + 1] === '/') { i = SRC.indexOf('\n', i); continue; }
        if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < SRC.length && SRC[i] !== q) { if (SRC[i] === '\\') i++; i++; } continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error('方法 ' + name + ' 大括號不成對');
}
const ctx = vm.createContext({ console });
const C = vm.runInContext('({' + methodSource('_aidocAskChat') + '})', ctx);

(async () => {
    // A. 有索引說明與程式片段 → 交給聊天核心，參考資料是程式碼，不給工具
    {
        let got = null;
        const self = { _offlineLlmAnswer: async (q, plan, opts) => { got = { q, plan, opts }; return { ok: true, text: '答案', header: 'H' }; } };
        const r = { answer: '函式 foo 定義在 a.c', snippets: [{ path: 'a.c', from_line: 10, text: 'int foo(void) {' }] };
        const out = await C._aidocAskChat.call(self, 'foo 做什麼', r, 'fap:demo');
        check('A 回傳聊天核心的結果', out && out.ok === true && out.text === '答案', out);
        check('A 問題原樣傳入', got && got.q === 'foo 做什麼', got);
        check('A 強制使用（使用者主動問）', got && got.opts.force === true, got && got.opts);
        check('A 不給工具（範圍只限程式碼）', got && got.opts.noTools === true, got && got.opts);
        check('A 不帶空歷史', got && Array.isArray(got.opts.history) && got.opts.history.length === 0, got && got.opts);
        const refs = got && got.opts.codeRefs;
        check('A 參考資料兩筆：索引整理＋程式片段', Array.isArray(refs) && refs.length === 2, refs);
        check('A 程式片段帶 檔案:行 出處', refs && refs[1].title === '程式碼 a.c:10' && refs[1].text === 'int foo(void) {', refs);
        check('A 參考資料全部是 rag 類（不含訓練器規則／問答）', refs && refs.every((x) => x.kind === 'rag'), refs);
    }
    // B. 索引沒有任何說明與片段 → 不呼叫模型，回傳 null（呼叫端只顯示索引查詢結果）
    {
        let called = false;
        const self = { _offlineLlmAnswer: async () => { called = true; return { ok: true }; } };
        const out = await C._aidocAskChat.call(self, 'x', { answer: '   ', snippets: [] }, 'fap:demo');
        check('B 沒有參考資料就回傳 null', out === null, out);
        check('B 沒有參考資料不呼叫模型', called === false, called);
    }
    // C. 聊天核心失敗（沒有模型、被取消）→ 原樣回傳失敗結果，由呼叫端決定顯示
    {
        const self = { _offlineLlmAnswer: async () => ({ ok: false, error: '離線文字模型「X」還沒下載' }) };
        const out = await C._aidocAskChat.call(self, 'q', { answer: 'a', snippets: [] }, 'fap:demo');
        check('C 失敗結果原樣回傳', out && out.ok === false && /還沒下載/.test(out.error), out);
    }
    console.log('aidoc_ask_chat: ' + ok + ' 通過，' + bad + ' 失敗');
    if (bad) process.exitCode = 1;
})();
