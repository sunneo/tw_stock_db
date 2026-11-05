// 探索迴圈（工具目錄→知識庫→小模型字母題→問使用者）與反思（沒達成換路線、上限、成功後寫進記憶）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const G = require('../renderer/src/offline/intent_gate.js');
const R = require('../renderer/src/recipe/recipe_core.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };

const m0 = src.indexOf('    // ---- 階段4：理解不了時先思考'), m1 = src.indexOf('    async _otBumpHit(plan) {');
const Cls = new Function('FaIntentGate', 'FaRecipe', 'FA_OT_GATE_MAX_REFLECT', 'return (class {\n' + src.slice(m0, m1) + '\n});')(G, R, 2);
const methods = {}; Object.getOwnPropertyNames(Cls.prototype).filter((n) => n !== 'constructor').forEach((n) => { methods[n] = Cls.prototype[n]; });
const store = {};
const toolDefs = (names) => Object.fromEntries(names.map((n) => [n, { description: '', callback: async () => '{"ok":true}' }]));
const mkFa = (over) => Object.assign({ _ot: { gateMemory: {} }, _otLoad: async () => { }, _otDb: () => ({ get: async (t, k) => store[k], put: async (t, o) => { store[o.k] = o; } }), advancedSettings: {}, slashCommands: new Map(), tools: toolDefs(['edit_xlsx_open', 'edit_docx_open', 'open_existing_presentation']) }, methods, over || {});
const mkPlan = (text) => { const p = { text, slots: {}, decision: { status: 'no_match', chosen: null } }; return p; };
const prep = (fa, text) => { const p = mkPlan(text); const ga = fa._otGateApply(p, text); return ga.plan; };
const gen = (n) => async () => '{"choice": ' + n + '}';
const T = '把那份財報叫出來 [附件：q1（file_id=f1）]';

(async () => {
    // 先確認這句真的是「表沒有寫到的說法」：種類判斷不出來、程式也不夠確定
    const g0 = G.gate(T);
    ok(g0.kind === null && g0.explicit === true, '前提：「' + T + '」表裡沒有對應的名詞，但明確要打開');
    ok(G.pickDerived(G.deriveTool(T, [], {})) === null, '前提：工具目錄推導不夠確定（兩個候選分數接近）');

    // ③ 小模型字母題
    let fa = mkFa({ _otGateGen: gen(1), _otGateThinking: { enabled: true, maxTokens: 1500, timeoutMs: 30000 }, requestUserForm: async (o) => ({ confirmed: true, answer: o.choices[0] }) });
    let plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && plan.gate.explored.by.indexOf('離線小模型') >= 0, '③ 程式不確定：小模型字母題挑種類（' + plan.gate.kind + '）');
    ok(plan.decision.chosen && plan.decision.chosen.pattern === 'gate_open_' + plan.gate.kind && /探索③/.test(plan.gate.trace.join('|')), '探索結果接成可執行的動作，過程列在卡片');
    ok(plan.gate.explored.alts.length >= 1, '留下備選種類給反思換路線用');

    // 小模型猜的種類要先問使用者確認：說不對就改讓使用者選（猜錯不會直接開）
    let confirms = 0;
    fa = mkFa({ _otGateGen: gen(1), requestUserForm: async (o) => { if (/對嗎/.test(o.title)) { confirms++; return { confirmed: true, answer: o.choices[1] }; } return { confirmed: true, answer: o.choices[2] }; } });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && confirms === 1 && /你說不對/.test(plan.gate.trace.join('|')) && plan.gate.explored.by === '使用者回答', '小模型猜錯：使用者說不對→改讓使用者選，不直接開');
    // 小模型選的不在程式推導前三名：不採用（直接問使用者）
    fa = mkFa({ _otGateGen: async () => '{"choice": 99}', requestUserForm: async (o) => ({ confirmed: true, answer: o.choices[0] }) });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && /沒有得到合格的回答|不在程式推導/.test(plan.gate.trace.join('|')), '小模型選不出合格的：不採用，問使用者');
    // ② 知識庫（使用者自己的文件）
    fa = mkFa({ tools: Object.assign(toolDefs(['edit_xlsx_open', 'edit_docx_open']), { knowledge_ask: { callback: async () => JSON.stringify({ hits: [{ quote: '財報一律放在 Excel 試算表 xlsx 裡，每季更新' }] }) } }), requestUserForm: async () => { throw new Error('不該問使用者'); } });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && plan.gate.kind === 'xlsx' && /探索②知識庫/.test(plan.gate.trace.join('|')), '② 知識庫的片段幫忙推導出 xlsx');

    // ④ 小模型沒載入 → 問使用者
    let asked = 0;
    fa = mkFa({ requestUserForm: async (o) => { asked++; return { confirmed: true, answer: o.choices[1] }; } });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && asked === 1 && /沒安裝，這一步略過，直接問使用者/.test(plan.gate.trace.join('|')) && plan.gate.explored.by === '使用者回答', '④ 小模型沒載入：直接問使用者，採用回答');
    // 使用者不選 → 沒有動作
    fa = mkFa({ requestUserForm: async () => null });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === false && !plan.decision.chosen && /沒有確定要開哪一種/.test(plan.gate.trace.join('|')), '使用者沒回答：不亂開');
    // 小模型亂答 → 退回問使用者
    asked = 0;
    fa = mkFa({ _otGateGen: async () => '{"choice": 77}', requestUserForm: async (o) => { asked++; return { confirmed: true, answer: o.choices[0] }; } });
    plan = prep(fa, T);
    ok(await fa._otGateExplore(plan, T) === true && asked === 1, '小模型亂答（不在選單）：退回問使用者');
    // 已有明確規則／種類就不探索
    fa = mkFa({});
    plan = prep(fa, '打開 a.docx [附件：a.docx（file_id=d1）]');
    ok(await fa._otGateExplore(plan, '打開 a.docx') === false, '種類已經判得出來：不探索');
    plan = prep(fa, '看一下今天天氣');
    ok(await fa._otGateExplore(plan, '看一下今天天氣') === false, '不是明確的「打開」說法：不探索（不搶其他流程）');

    // 規則語意勉強配到別的工具（merge_pdfs 0.54）：不算數，照樣探索
    fa = mkFa({ _otGateGen: gen(1), requestUserForm: async (o) => (/對嗎/.test(o.title) ? { confirmed: true, answer: o.choices[0] } : null) });
    plan = prep(fa, T); plan.decision = { status: 'planned', chosen: { pattern: 'feat_merge-pdfs', tool: 'merge_pdfs', via: '語意', score: 0.54, kind: 'tool' } };
    ok(await fa._otGateExplore(plan, T) === true && plan.decision.chosen.pattern.indexOf('gate_open_') === 0, '弱規則（語意 0.54 的 merge_pdfs）：不算數，探索後接手');
    plan = prep(fa, T); plan.decision = { status: 'planned', chosen: { pattern: 'x', tool: 'merge_pdfs', via: '規則', score: 0.95, kind: 'tool' } };
    ok(await fa._otGateExplore(plan, T) === false, '字面規則高信心：尊重規則，不探索');
    // 反思：第一條路線失敗 → 換路線；上限 2 次；成功寫進記憶
    const says = [];
    fa = mkFa({ _otGateGen: gen(1), requestUserForm: async (o) => (/對嗎/.test(o.title) ? { confirmed: true, answer: o.choices[0] } : null) });
    plan = prep(fa, T); await fa._otGateExplore(plan, T);
    const firstKind = plan.gate.kind; const tried = [];
    fa._otExecute = async (p) => { const k = p.decision.chosen.pattern; tried.push(k); return tried.length >= 1 ? { ok: true, text: '開好了' } : { ok: false, error: '工具回報失敗' }; };
    let r = await fa._otGateReflect(plan, T, { ok: false, error: '第一次失敗' }, (t) => says.push(t));
    ok(r.ok === true && tried.length === 1 && says.length === 1 && /反思/.test(says[0]), '反思：第一次失敗後換路線重試（換了 ' + tried.length + ' 次）');
    ok(plan.gate.kind !== firstKind && /沒有自動記住/.test(r.text) && Object.keys(fa._ot.gateMemory).length === 0, '反思：小模型猜的種類、換路線的結果不自動記（實測 0.6b 會猜錯），卡片明說');
    // 使用者回答的才記
    fa = mkFa({ requestUserForm: async (o) => ({ confirmed: true, answer: o.choices[1] }) });
    plan = prep(fa, T); await fa._otGateExplore(plan, T);
    fa._otExecute = async () => ({ ok: true, text: '開好了' });
    r = await fa._otGateReflect(plan, T, { ok: true, text: '開好了' }, () => { });
    ok(/已記住這個說法/.test(r.text) && fa._ot.gateMemory['s:' + G.memKey(T)] === 'kind:' + plan.gate.kind && store.gate_memory, '使用者回答的種類：成功後「句子→種類」寫進記憶（含持久化）');
    // 下次直接懂：不探索
    ok(G.gate(T, { memory: fa._ot.gateMemory }).kind !== null && /記憶/.test(G.gate(T, { memory: fa._ot.gateMemory }).kindBy), '下次同樣說法：直接用記憶，不用再探索');
    // 上限：一直失敗最多換 2 次就停
    fa = mkFa({ _otGateGen: gen(1), requestUserForm: async (o) => (/對嗎/.test(o.title) ? { confirmed: true, answer: o.choices[0] } : null) });
    plan = prep(fa, T); await fa._otGateExplore(plan, T);
    let n = 0; fa._otExecute = async () => { n++; return { ok: false, error: '一直失敗' }; };
    r = await fa._otGateReflect(plan, T, { ok: false, error: '第一次失敗' }, () => { });
    ok(r.ok === false && n <= 2, '反思上限：一直失敗最多換 2 次就停（換了 ' + n + ' 次）');
    ok(Object.keys(fa._ot.gateMemory).length === 0, '失敗不寫進記憶');
    // 接線
    ok(/_otGateExplore\(plan, text\)/.test(src) && /_otGateReflect\(plan, text, r, say\)/.test(src) && /FA_OT_GATE_MAX_REFLECT = 2/.test(src), '接線：離線對話呼叫探索與反思，上限寫死為 2');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
