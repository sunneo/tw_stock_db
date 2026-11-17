// node renderer/src/recipe/plan_layers.test.js
// 逐層歸約（map-reduce）：_planLocalSummarize 第 1 層每段一次模型、第 2 層把各段重點再合併一次；合併退回就串接並說明原因。
// 假模型：回的字都取自來源（「黃仁勳」），所以會通過 checkExtractive；合併回數字 2026（來源沒有）就會退回。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const P = require('./plan_core.js'); const R = require('./recipe_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const ctx = { console, Promise, JSON, FaRecipe: R, FaPlan: P, FaVlm: { textBudget: () => ({ prompt: 700 }) } };
vm.createContext(ctx);
const C = vm.runInContext('({' + ['_planLocalSummarize', '_planReadText'].map(methodSource).join(',\n') + '})', ctx);

// 很長的來源（超過一段的預算）：重複的句子，每句都含「黃仁勳」
const LONG = Array.from({ length: 60 }, (_, i) => '第' + (i + 1) + '則：黃仁勳在會議中說明新一代晶片的量產時程與供應計畫，並回答記者提問。').join('\n');

function makeSelf() {
    const self = { fileCache: { get: async () => null }, _gpuDecodeCapOn: () => false, _gpuChunkCap: () => 1024 }; // 假模型不走 GPU 解碼，切段不受 GPU 上限影響
    self._planReadText = C._planReadText.bind(self);
    self._planLocalSummarize = C._planLocalSummarize.bind(self);
    return self;
}
// 假模型：第 1 層回「黃仁勳」（取自來源）；合併（內容含「各段」或多行）回 mergeReply
function fakeM(mergeReply) {
    const calls = [];
    return { calls, model: { id: 'fake' }, ensure: async () => false, gen: async (req) => {
        const txt = (req.messages || []).map((m) => m.content).join(' ');
        const merge = /合併成 2～4 個重點/.test(txt);
        calls.push(merge ? 'merge' : 'chunk');
        return merge ? mergeReply : '黃仁勳說明晶片量產時程。';
    } };
}

(async () => {
    // A. 多段：第 1 層每段一行，第 2 層合併一行，最後結果是合併的模型摘要
    {
        const M = fakeM('黃仁勳說明晶片量產時程。');
        const lines = [];
        const r = await makeSelf()._planLocalSummarize(LONG, '黃仁勳最近說了什麼', M, { step: (st, who, text) => lines.push(st + '｜' + who + '｜' + text) });
        const layer1 = lines.filter((l) => l.startsWith('摘要（第 1 層）'));
        const layer2 = lines.filter((l) => l.startsWith('合併（第 2 層）'));
        check('A 多段（>1 段）', r.json.chunks > 1, r.json.chunks);
        check('A 第 1 層每段一行（段數＝行數）', layer1.length === r.json.chunks, { n: layer1.length, chunks: r.json.chunks });
        check('A 第 1 層行標示段號', layer1.every((l, i) => l.includes('第 ' + (i + 1) + '/' + r.json.chunks + ' 段')), layer1.slice(0, 2));
        check('A 第 2 層合併一行，標模型', layer2.length === 1 && layer2[0].includes('模型') && layer2[0].includes('段'), layer2);
        check('A 合併結果是模型合併的摘要', r.json.merge === 'model' && r.text === '黃仁勳說明晶片量產時程。', { merge: r.json.merge, text: r.text });
        check('A 模型被呼叫：每段一次＋合併一次', M.calls.filter((c) => c === 'chunk').length === r.json.chunks && M.calls.filter((c) => c === 'merge').length === 1, M.calls);
    }
    // B. 合併退回（數字 2026 來源沒有）：串接各段、第 2 層行說明退回原因，最終結果不是合併版
    {
        const M = fakeM('2026 年黃仁勳說明晶片量產。');
        const lines = [];
        const r = await makeSelf()._planLocalSummarize(LONG, '黃仁勳最近說了什麼', M, { step: (st, who, text) => lines.push(st + '｜' + who + '｜' + text) });
        const layer2 = lines.filter((l) => l.startsWith('合併（第 2 層）'));
        check('B 合併退回標示程式串接', r.json.merge === 'concat' && layer2.length === 1 && layer2[0].includes('程式（串接）'), { merge: r.json.merge, layer2 });
        check('B 合併退回帶原因', layer2.length === 1 && layer2[0].includes('退回：出現來源沒有的數字：2026'), layer2);
        check('B 結果是串接（每段各一句，不含合併版）', !r.text.startsWith('2026') && r.text.split('\n').length === r.json.chunks, r.text.slice(0, 80));
    }
    // C. 單段：不做第 2 層
    {
        const M = fakeM('黃仁勳說明晶片量產時程。');
        const lines = [];
        const r = await makeSelf()._planLocalSummarize('黃仁勳說明晶片量產時程。', '摘要', M, { step: (st, who, text) => lines.push(st + '｜' + who + '｜' + text) });
        check('C 單段不做合併', r.json.merge === 'none' && !lines.some((l) => l.startsWith('合併')) && M.calls.filter((c) => c === 'merge').length === 0, { merge: r.json.merge, lines });
    }
    // D. noMerge：關掉第 2 層
    {
        const M = fakeM('黃仁勳說明晶片量產時程。');
        const r = await makeSelf()._planLocalSummarize(LONG, '摘要', M, { noMerge: true });
        check('D noMerge 不呼叫合併', r.json.merge === 'none' && M.calls.filter((c) => c === 'merge').length === 0, M.calls);
    }

    console.log('plan_layers.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
