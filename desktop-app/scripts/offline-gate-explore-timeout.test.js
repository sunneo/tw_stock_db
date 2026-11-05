// 探索的短逾時與略過：用假計時器證明「知識庫 5 秒、檢查小模型 5 秒、小模型選擇題 20 秒」各自逾時就略過，沒安裝小模型直接略過，全部推不出 10 秒內回到問使用者
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
const never = () => new Promise(() => { });
const toolDefs = (names) => Object.fromEntries(names.map((n) => [n, { description: '', callback: async () => '{"ok":true}' }]));
// 假計時器：不真的等，由 run() 依序觸發最早的計時器，並累計「虛擬經過毫秒」
function mkClock() {
    const c = { now: 0, list: [], id: 0 };
    c.timer = { set: (f, ms) => { const h = ++c.id; c.list.push({ h, at: c.now + ms, f }); return h; }, clear: (h) => { c.list = c.list.filter((x) => x.h !== h); } };
    return c;
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function run(clock, p) {
    let done = false, val; p.then((v) => { done = true; val = v; }, (e) => { done = true; val = { err: e }; });
    for (let guard = 0; guard < 50 && !done; guard++) {
        await flush(); if (done) break;
        if (!clock.list.length) { await new Promise((r) => setImmediate(r)); continue; }
        clock.list.sort((a, b) => a.at - b.at); const t = clock.list.shift(); clock.now = Math.max(clock.now, t.at); t.f();
    }
    await flush();
    return { done, val, ms: clock.now };
}
const mkFa = (clock, over) => Object.assign({ _ot: { gateMemory: {} }, _otLoad: async () => { }, _otDb: () => ({ get: async (t, k) => store[k], put: async (t, o) => { store[o.k] = o; } }), advancedSettings: {}, slashCommands: new Map(), tools: toolDefs(['edit_xlsx_open', 'edit_docx_open', 'open_existing_presentation']), _otGateTimer: clock.timer }, methods, over || {});
const prep = (fa, text) => { const p = { text, slots: {}, decision: { status: 'no_match', chosen: null } }; return fa._otGateApply(p, text).plan; };
const T = '把那份財報叫出來 [附件：q1（file_id=f1）]';
const kb = (cb) => ({ knowledge_ask: { description: '', callback: cb } });

(async () => {
    // ① 知識庫卡住：5 秒就略過
    let clock = mkClock(), asked = [], kbArgs = null;
    let fa = mkFa(clock, { tools: Object.assign(toolDefs(['edit_xlsx_open', 'edit_docx_open']), kb(function (a) { kbArgs = JSON.parse(a); return never(); })), requestUserForm: async (o) => { asked.push(o); return { confirmed: true, answer: o.choices[0] }; } });
    let plan = prep(fa, T);
    let r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === true, '知識庫卡住：探索仍然完成');
    ok(r.ms === 5000, '知識庫卡住：剛好 5 秒就放棄（虛擬 ' + r.ms + ' 毫秒）');
    ok(/探索②知識庫：超過 5 秒，這一步逾時略過/.test(plan.gate.trace.join('|')), '卡片寫「這一步逾時略過」');
    ok(kbArgs && kbArgs.no_expand === true, '查知識庫時關掉「請模型想同義詞」（實測會卡 50 秒以上的元兇）');
    ok(asked.length === 1 && /我已經試過/.test(asked[0].description) && /工具目錄/.test(asked[0].description) && /知識庫/.test(asked[0].description), '問使用者時列出已試過哪幾步');

    // ② 檢查小模型卡住：5 秒就略過
    clock = mkClock(); asked = [];
    fa = mkFa(clock, { _otGateModel: never, requestUserForm: async (o) => { asked.push(o); return { confirmed: true, answer: o.choices[0] }; } });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === true && r.ms === 5000 && /探索③離線小模型：檢查超過 5 秒，這一步逾時略過/.test(plan.gate.trace.join('|')), '檢查小模型卡住：5 秒略過，改問使用者（虛擬 ' + r.ms + ' 毫秒）');

    // ③ 知識庫＋檢查模型都逾時：合計 10 秒內回到問使用者
    clock = mkClock(); asked = [];
    fa = mkFa(clock, { tools: Object.assign(toolDefs(['edit_xlsx_open', 'edit_docx_open']), kb(never)), _otGateModel: never, requestUserForm: async (o) => { asked.push(o); return null; } });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === false && r.ms <= 10000 && asked.length === 1, '兩步都卡住：合計 ' + r.ms + ' 毫秒（≤ 10000）就回到問使用者，沒回答就不動作');

    // ④ 小模型選擇題卡住：20 秒略過
    clock = mkClock(); asked = [];
    fa = mkFa(clock, { _otGateGen: never, _otGateThinking: { enabled: true, maxTokens: 1500, timeoutMs: 30000 }, requestUserForm: async (o) => { asked.push(o); return { confirmed: true, answer: o.choices[0] }; } });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === true && r.ms === 20000 && /探索③離線小模型：超過 20 秒，這一步逾時略過/.test(plan.gate.trace.join('|')) && asked.length === 1, '小模型選擇題卡住：20 秒略過，改問使用者（虛擬 ' + r.ms + ' 毫秒）');
    ok(!/改問使用者.*改問使用者/.test(plan.gate.trace.join('|')), '逾時略過不會重複寫兩次「改問使用者」');

    // ⑤ 沒安裝小模型：直接略過，完全不等計時器
    clock = mkClock(); asked = [];
    fa = mkFa(clock, { _otGateModel: async () => null, requestUserForm: async (o) => { asked.push(o); return { confirmed: true, answer: o.choices[0] }; } });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === true && r.ms === 0 && /沒安裝，這一步略過/.test(plan.gate.trace.join('|')) && asked.length === 1, '沒安裝小模型：直接略過，虛擬 0 毫秒就問使用者');

    // ⑥ 正常很快的情況不受影響，而且選擇題不開 Thinking
    clock = mkClock(); let sawThinking = null;
    fa = mkFa(clock, { _otGateGen: async (a) => { sawThinking = a && a.enableThinking; return '{"choice": 1}'; }, _otGateThinking: { enabled: true, maxTokens: 1500, timeoutMs: 30000 }, requestUserForm: async (o) => ({ confirmed: true, answer: o.choices[0] }) });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(r.done && r.val === true && plan.gate.explored.by.indexOf('離線小模型') >= 0 && !sawThinking && !/Thinking）/.test(plan.gate.explored.by.replace('關閉 Thinking', '')), '很快回來：照常採用，並且不開 Thinking');

    // ⑦ 進度顯示：每一步都會送到進度卡，結束（問使用者之前）會收掉
    clock = mkClock(); const steps = []; let removed = 0, askedWhileOpen = null; let open = false;
    fa = mkFa(clock, { _createProgressWidget: () => { open = true; return { update: () => { }, log: (l) => steps.push(l), remove: () => { removed++; open = false; } }; }, _otGateModel: async () => null, requestUserForm: async (o) => { askedWhileOpen = open; return { confirmed: true, answer: o.choices[0] }; } });
    plan = prep(fa, T);
    r = await run(clock, fa._otGateExplore(plan, T));
    ok(steps.length >= 3 && steps.some((s) => /探索①/.test(s)) && steps.some((s) => /探索③/.test(s)), '逐步進度顯示在進度卡（' + steps.length + ' 行）');
    ok(removed === 1 && askedWhileOpen === false, '問使用者前先收掉進度卡（不會一直轉圈等使用者）');

    // ⑧ 接線檢查
    ok(/_otGateLimits\(\) \{ return Object\.assign\(\{ kbMs: 5000, modelCheckMs: 5000, askMs: 20000 \}/.test(src), '預設逾時寫死為 5／5／20 秒');
    console.log('\n' + pass + ' 通過，' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
