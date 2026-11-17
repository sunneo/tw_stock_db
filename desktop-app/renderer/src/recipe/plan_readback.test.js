// node renderer/src/recipe/plan_readback.test.js
// 讀＋總結（逐層歸約的最後一層）：摘要類計畫跑完後，取回的內容一定經過模型（_planLocalSummarize），最終回答是模型的摘要；
// 沒有模型時標示「這次沒有經過 AI」；非摘要目標維持原本的輸出。方法本體從 floating-assistant.js 抽出來，用假的 this 執行；
// 純函式（FaRecipe、FaPlan）用真的模組，只替換模型、UI、快取與儲存。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const FaRecipe = require('./recipe_core.js');
const FaPlan = require('./plan_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

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
function loadMethods(names, globals) {
    const ctx = Object.assign({ console, Promise }, globals || {}); vm.createContext(ctx);
    return vm.runInContext('({' + names.map(methodSource).join(',\n') + '})', ctx);
}

const HEADLINES = [
    '黃仁勳宣布新一代 AI 晶片 Blackwell 量產',
    '輝達股價盤中創高 黃仁勳：AI 需求仍強',
    '今天天氣晴朗，午後偶有陣雨',
];
const PAGE = HEADLINES.join('\n');

// 假的計畫執行結果：最後一步的輸出是取回的頁面文字
function makeRun(target) {
    return {
        goal: { id: 'web_summary', label: '網頁做摘要', target },
        steps: [{ tool: 'fetch_web_page', state: 'done' }],
        phases: [],
        state: 'done',
        artifacts: [{ kind: target, value: PAGE }],
    };
}
// 假的 this：只提供 _planFinish 與 _planLocalSummarize 會用到的東西
function makeSelf(gen, modelErr) {
    return {
        _planLocalSummarize: null, // 下面綁定真的方法
        fileCache: { get: async () => null },
        _recipeLearnBack: async () => {},
        _recipeSaveTrace: () => {},
    };
}

(async () => {
    // 模型摘要：從取回內容挑出第一則相關標題原文（checkExtractive 會通過），回傳格式固定
    const modelCalls = [];
    const M = {
        model: { id: 'qwen3-0.6b' },
        ensure: async () => null,
        gen: async (a) => { modelCalls.push(a); return '- ' + HEADLINES[0]; },
    };
    const globals = { FaRecipe, FaPlan, FaVlm: { textBudget: () => ({ prompt: 4000 }) } };
    const M2 = loadMethods(['_planFinish', '_planLocalSummarize', '_planReadText'], globals);
    const self = makeSelf();
    self._planLocalSummarize = M2._planLocalSummarize;
    self._planReadText = M2._planReadText;
    self._planFinish = M2._planFinish;
    const trace = FaRecipe.newTrace('看今天有哪些黃仁勳新聞', { recipe: 'plan' });
    const userText = '看今天有哪些黃仁勳新聞';

    // ① 有模型：取回內容送進模型，最終回答含模型摘要，而且標示經過 AI
    const r1 = await self._planFinish(makeRun('summary'), userText, trace, [], null, M);
    check('① 取回內容有被送進模型', modelCalls.length >= 1 && String(modelCalls[0].messages.map((m) => m.content).join('\n')).includes(HEADLINES[0]), modelCalls.length);
    check('① 最終回答含模型摘要（項目符號「- 」不算內容，已去掉）', r1.text.includes(HEADLINES[0]) && !r1.text.includes('- ' + HEADLINES[0]), r1.text);
    check('① 標示經過 AI（不是程式摘錄）', r1.text.includes('經 AI') && !r1.text.includes('沒有經過 AI'), r1.text);
    check('① 計畫仍 handled、ok', r1.handled === true && r1.ok === true, r1);

    // ② 沒有模型：誠實標示「這次沒有經過 AI」，且不呼叫模型
    const noModelCalls = [];
    const M3 = { model: M.model, ensure: async () => '模型還沒下載', gen: async (a) => { noModelCalls.push(a); return 'x'; } };
    const r2 = await self._planFinish(makeRun('summary'), userText, FaRecipe.newTrace(userText, { recipe: 'plan' }), [], null, M3);
    check('② 沒模型時標示「這次沒有經過 AI」', r2.text.includes('這次沒有經過 AI'), r2.text);
    check('② 沒模型時不呼叫模型', noModelCalls.length === 0, noModelCalls.length);

    // ③ 非摘要目標（target 不是 summary）：維持原本輸出，不呼叫模型
    const thirdCalls = [];
    const M4 = { model: M.model, ensure: async () => null, gen: async (a) => { thirdCalls.push(a); return 'x'; } };
    const r3 = await self._planFinish(makeRun('pdf'), userText, FaRecipe.newTrace(userText, { recipe: 'plan' }), [], null, M4);
    check('③ 非摘要目標不經模型', thirdCalls.length === 0, thirdCalls.length);
    check('③ 非摘要目標輸出原文（不加 AI 標示）', r3.text.includes(PAGE) && !r3.text.includes('經 AI') && !r3.text.includes('沒有經過 AI'), r3.text);

    console.log(ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
