// node renderer/src/recipe/plan_transcribe_seq.test.js
// 通用計畫路徑的 transcribe（進度卡片）每一輪一行：假模型＋假工具，跑真的 FaPlan.advance 與真的 _planEnv（從 floating-assistant.js 抽出來執行）。
// 斷言：步驟序列完整、順序正確、每行有輪次與誰做的；摘要行標示模型或程式（退回時帶原因）；填欄位行帶封閉題與模型回答。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const P = require('./plan_core.js'); const R = require('./recipe_core.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 300))); } };

// 方法本體：從方法名到下一個同層級（4 格縮排）方法名之前，取最後一個 } 為結尾（比逐字計括號穩，字串與正規表示式裡的括號不會搞錯）
function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const stop = n ? n.index : SRC.length; const chunk = SRC.slice(m.index + 1, stop);
    const close = chunk.lastIndexOf('}'); if (close < 0) throw new Error('方法 ' + name + ' 找不到結尾');
    return chunk.slice(0, close + 1);
}
const ctx = { console, Promise, JSON, FaRecipe: R, FaPlan: P, FaVlm: { textBudget: () => ({ prompt: 700 }) }, FA_OT_RISKY_TOOL: /(?!)/, FaLangColu: { languages: [], toolName: () => '' }, FaDesign: {} };
vm.createContext(ctx);
const C = vm.runInContext('({' + ['_planEnv', '_planLocalSummarize', '_planReadText'].map(methodSource).join(',\n') + '})', ctx);

const PAGE = '黃仁勳宣布新一代 AI 晶片 Blackwell 量產，首批供應雲端業者。';
// 計畫的步驟：先取網頁（工具），再用本機摘要（模型）；形狀照 plan_core.buildPlan 的輸出
function steps() {
    return [
        { tool: 'fetch_web_page', label: '讀網頁', stage: 'acquire', cost: 1, local: false, slow: false, bind: { url: { kind: 'url', from: { type: 'fact', kind: 'url' }, many: false } }, extra: [], out: [{ kind: 'text', inline: true }], repeatOut: false, id: 's1', state: 'pending', attempts: 0 },
        { tool: 'local_summarize', label: '摘要', stage: 'analyze', cost: 3, local: true, slow: false, bind: { text: { kind: 'text', from: { type: 'step', ref: 's1', kind: 'text' }, many: true } }, extra: [], out: [{ kind: 'summary', inline: true }], repeatOut: false, id: 's2', state: 'pending', attempts: 0 },
    ];
}
// 假的 this：工具（fetch_web_page 回傳頁面）、檔案快取（沒有）、確認視窗（不用）；_planLocalSummarize 綁回這個 this
function makeSelf() {
    const self = {
        tools: { fetch_web_page: { callback: async () => JSON.stringify({ ok: true, text: PAGE }) } },
        advancedSettings: {}, requestUserForm: async () => null, fileCache: { get: async () => null },
    };
    self._planLocalSummarize = C._planLocalSummarize.bind(self);
    self._planReadText = C._planReadText.bind(self);
    self._gpuDecodeCapOn = () => false; self._gpuChunkCap = (x) => x;   // 非 Qwen 模型：不套 GPU 分段上限（與產品行為相同）
    self._planEnv = C._planEnv.bind(self);
    return self;
}
// 假模型：摘要用 summaryReply；封閉題（JSON 欄位）用 fillReply
function fakeM(summaryReply, fillReply) {
    const calls = [];
    return { calls, model: { id: 'qwen3-0.6b' }, ensure: async () => false, gen: async (req) => {
        const u = (req.messages || []).filter((m) => m.role === 'user').pop(); const isFill = /JSON|欄位|只輸出/.test(String((req.messages || []).map((m) => m.content).join(' ')));
        calls.push({ isFill, user: String((u && u.content) || '').slice(0, 60) });
        return isFill ? fillReply : summaryReply;
    } };
}
async function runPlan(M) {
    const self = makeSelf();
    const facts = P.factsFrom({ url: 'https://example.com/a', text: 'https://example.com/a 摘要黃仁勳' });
    const run = P.createRun({ id: 'web_summary', label: '網頁做摘要' }, facts, { target: 'summary', steps: steps() }, '摘要黃仁勳');
    const lines = []; const prog = { log: (x) => lines.push(x) };
    const env = self._planEnv(run, '摘要黃仁勳', { M, question: '摘要黃仁勳', calls: [], trace: R.newTrace(), prog });
    await P.advance(run, env);
    return { run, lines, self, env };
}

(async () => {
    // A. 模型摘要被接受：步驟序列 工具→完成→摘要（模型）→完成，輪次 1、1、2、2
    {
        const M = fakeM(PAGE, '{}');
        const { run, lines } = await runPlan(M);
        check('A 計畫跑完', run.state === 'done', run.state);
        check('A 共 5 行（工具、完成、第 1 層摘要、摘要結果、完成）', lines.length === 5, lines);
        check('A 第 1 行是第 1 輪工具（程式，帶參數與回傳大小）', /^第 1 輪｜工具｜程式｜fetch_web_page \{"url":"https:\/\/example\.com\/a"\}｜回 \d+ 字/.test(lines[0] || ''), lines[0]);
        check('A 第 2 行是第 1 輪完成', (lines[1] || '').startsWith('第 1 輪｜完成｜程式｜fetch_web_page｜成品：'), lines[1]);
        check('A 第 3 行是第 2 輪第 1 層摘要（模型，第 1/1 段）', (lines[2] || '').startsWith('第 2 輪｜摘要（第 1 層）｜模型｜第 1/1 段，輸入 ') && (lines[2] || '').includes('｜答「黃仁勳宣布'), lines[2]);
        check('A 第 4 行是第 2 輪摘要結果（模型，有輸入字數與答案）', (lines[3] || '').startsWith('第 2 輪｜摘要｜模型｜輸入 ') && (lines[3] || '').includes('｜答「黃仁勳宣布'), lines[3]);
        check('A 第 5 行是第 2 輪完成', (lines[4] || '').startsWith('第 2 輪｜完成｜程式｜local_summarize｜成品：summary'), lines[4]);
        check('A 步驟順序：工具在摘要之前', lines.findIndex((l) => l.includes('｜工具｜')) < lines.findIndex((l) => l.includes('｜摘要｜')), lines);
        check('A 模型確實被呼叫來摘要（不是程式直接吐原文）', M.calls.some((c) => !c.isFill), M.calls);
    }
    // B. 模型摘要被退回（出現來源沒有的數字）：摘要行標程式、帶退回原因與模型原文
    {
        const M = fakeM('2026 年的新聞：黃仁勳宣布 Blackwell。', '{}');
        const { lines } = await runPlan(M);
        const sum = lines.find((l) => l.includes('｜摘要｜')) || '';
        check('B 摘要行標示程式（沒經過 AI）', sum.includes('程式（沒經過 AI）'), sum);
        check('B 摘要行帶退回原因', sum.includes('退回：出現來源沒有的數字：2026'), sum);
        check('B 摘要行帶模型原文開頭', sum.includes('模型原文「2026 年的新聞'), sum);
    }
    // C. 封閉題（填欄位）：行帶封閉題、模型回答、填入的欄位名；輪次跟著目前的步驟
    {
        const M = fakeM(PAGE, '{"keyword":"黃仁勳"}');
        const self = makeSelf();
        const facts = P.factsFrom({ url: 'https://example.com/a', text: '摘要黃仁勳' });
        const run = P.createRun({ id: 'web_summary', label: '網頁做摘要' }, facts, { target: 'summary', steps: steps() }, '摘要黃仁勳');
        const lines = []; const env = self._planEnv(run, '摘要黃仁勳', { M, question: '摘要黃仁勳', calls: [], trace: R.newTrace(), prog: { log: (x) => lines.push(x) } });
        const values = await env.fill({ id: 's1', tool: 'fetch_web_page' }, [{ name: 'keyword', type: 'string', description: '關鍵字' }], null);
        check('C 填入欄位', values && values.values && values.values.keyword === '黃仁勳', values);
        const fill = lines.find((l) => l.includes('｜填欄位｜')) || '';
        check('C 填欄位行標模型', fill.startsWith('第 1 輪｜填欄位｜模型｜'), fill);
        check('C 填欄位行含封閉題與模型回答', fill.includes('封閉題「') && fill.includes('模型答「{"keyword":"黃仁勳"}」'), fill);
        check('C 填欄位行含填入欄位', fill.includes('｜填入：keyword'), fill);
    }

    console.log('plan_transcribe_seq.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
