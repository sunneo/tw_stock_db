// node renderer/src/recipe/plan_files.test.js
// 檔案整理（file_organize）：第 0 層程式依副檔名排計畫（不動檔案）；路由；真的 advance＋_planEnv 跑一次（假模型），斷言 transcribe 的行序與誰做的。
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
const ctx = { console, Promise, JSON, FaRecipe: R, FaPlan: P, FaVlm: { textBudget: () => ({ prompt: 700 }) }, FA_OT_RISKY_TOOL: /(?!)/, FaLangColu: { languages: [], toolName: () => '' }, FaDesign: {} };
vm.createContext(ctx);
const C = vm.runInContext('({' + ['_planEnv', '_planLocalSummarize', '_planReadText'].map(methodSource).join(',\n') + '})', ctx);

// 1. 純程式排計畫：依副檔名分資料夾（大小寫不分）、看不出類別的列出來、沒有檔案時明說
{
    const r = P.organizePlan(['a.pdf', 'b.JPG', 'c.mp4', 'd.xyz', 'e.zip', 'noext']);
    check('1 檔案數', r.moves.length === 6, r.moves.length);
    check('1 PDF 進文件', r.moves.some((m) => m.from === 'a.pdf' && m.to === '文件/a.pdf'), r.moves);
    check('1 大寫副檔名也認得', r.moves.some((m) => m.from === 'b.JPG' && m.to === '圖片/b.JPG'), r.moves);
    check('1 看不出類別的列出來', JSON.stringify(r.unknown) === JSON.stringify(['d.xyz', 'noext']), r.unknown);
    check('1 計畫文字含「請你確認」', r.text.includes('看不出類別、請你確認：d.xyz、noext'), r.text);
    const e = P.organizePlan([]);
    check('1 沒有檔案時明說', e.moves.length === 0 && e.text.startsWith('整理計畫：0 個檔案'), e.text);
}
// 2. 路由：附件＋「整理這些檔案」→ file_organize；只說「摘要這份文件」不走整理
{
    const f = P.factsFrom({ attachments: [{ id: 'f1234567', filename: 'a.pdf' }, { id: 'f2345678', filename: 'b.jpg' }], text: '把這些檔案整理到資料夾' });
    check('2 整理檔案走 file_organize', P.matchGoals('把這些檔案整理到資料夾', f)[0].id === 'file_organize', P.matchGoals('把這些檔案整理到資料夾', f).map((g) => g.id));
    const d = P.factsFrom({ attachments: [{ id: 'doc1234567', filename: 'm.txt' }], text: '幫我摘要這份文件的重點' });
    check('2 摘要文件不被判成整理', !P.matchGoals('幫我摘要這份文件的重點', d).some((g) => g.id === 'file_organize'), P.matchGoals('幫我摘要這份文件的重點', d).map((g) => g.id));
    const pl = P.buildPlan(P.GOALS.find((g) => g.id === 'file_organize'), f, {});
    check('2 計畫是 files_plan → files_explain', pl.ok && JSON.stringify(pl.steps.map((x) => x.tool)) === JSON.stringify(['files_plan', 'files_explain']), pl.ok ? pl.steps.map((x) => x.tool) : pl.reason);
}
// 3. 真的 advance＋_planEnv（假模型）：行序完整、第 0 層程式、第 1、2 層模型、不動檔案（沒有任何工具呼叫）
(async () => {
    const calls = []; const M = { model: { id: 'fake' }, ensure: async () => false, gen: async (req) => {
        const txt = (req.messages || []).map((m) => m.content).join(' ');
        calls.push(/合併成 2～4 個重點/.test(txt) ? 'merge' : 'chunk');
        return '整理計畫：3 個檔案，分到 3 個資料夾。';   // 只用計畫裡有的字（否則 checkExtractive 會退回，這是預期的檢查）
    } };
    const self = { tools: {}, advancedSettings: {}, requestUserForm: async () => null, fileCache: { get: async () => null } };
    self._planLocalSummarize = C._planLocalSummarize.bind(self); self._planReadText = C._planReadText.bind(self); self._planEnv = C._planEnv.bind(self);
    const facts = P.factsFrom({ attachments: [{ id: 'f1234567', filename: 'a.pdf' }, { id: 'f2345678', filename: 'b.jpg' }, { id: 'f3456789', filename: 'x.bin' }], text: '把這些檔案整理到資料夾' });
    const goal = P.GOALS.find((g) => g.id === 'file_organize'); const plan = P.buildPlan(goal, facts, {});
    const run = P.createRun(goal, facts, plan, '把這些檔案整理到資料夾');
    const lines = []; const env = self._planEnv(run, '把這些檔案整理到資料夾', { M, question: '把這些檔案整理到資料夾', calls: [], trace: R.newTrace(), prog: { log: (x) => lines.push(x) } });
    await P.advance(run, env);
    const rounds = lines.filter((l) => /^第 \d+ 輪/.test(l));
    check('3 計畫跑完', run.state === 'done', run.state);
    check('3 第 0 層程式行（不動檔案）', rounds.some((l) => l.startsWith('第 1 輪｜整理計畫（第 0 層）｜程式（不動檔案）｜整理計畫：3 個檔案')), rounds);
    check('3 第 1 層模型行', rounds.some((l) => l.includes('｜摘要（第 1 層）｜模型｜')), rounds);
    check('3 說明結果行標示模型', rounds.some((l) => l.includes('｜說明｜模型｜')), rounds);
    check('3 模型確實被呼叫', calls.length >= 1 && calls.includes('chunk'), calls);
    check('3 沒有任何工具呼叫（不動檔案）', !rounds.some((l) => l.includes('｜工具｜')), rounds);
    check('3 行序：第 0 層在說明之前', rounds.findIndex((l) => l.includes('整理計畫（第 0 層）')) < rounds.findIndex((l) => l.includes('｜說明｜')), rounds);

    console.log('plan_files.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
