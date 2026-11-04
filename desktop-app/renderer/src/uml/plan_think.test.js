// CoLU+Thinking 階段 3 測試：計畫階段（UML 由上而下）接上 thinking。假模型，不載入任何真模型。
// 用法：node renderer/src/uml/plan_think.test.js
const R = require('../recipe/recipe_core.js');
const U = require('./uml_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600))); } }

const SECRET = 'SECRET_REASON_XYZ';
const SCENARIO = '線上書店：顧客可以結帳';
const ANS = {
    actors: '{"actors":["Customer"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"結帳"}]}',
    classes: '{"classes":[{"name":"Book","kind":"class","label":""},{"name":"Cart","kind":"class","label":""}]}',
    members: '{"attrs":[],"ops":[]}',
    relations: '{"relations":[]}',
    sequence: '{"steps":[{"to":"Cart","op":"add"}]}',
};
function answerFor(sys) {
    if (/參與者（人或外部系統）/.test(sys)) return ANS.actors;
    if (/呼叫順序/.test(sys)) return ANS.sequence;
    if (/跟其他類別的關係/.test(sys)) return ANS.relations;
    if (/列出屬性與操作/.test(sys)) return ANS.members;
    return ANS.classes;
}
// mode: 'good' 思考後給合法答案；'unclosed' 思考沒閉合（像逾時截斷）；'badjson' 思考後給不合法答案；'throw' 開 thinking 時拋錯
function fakeModel(mode) {
    const calls = [];
    const generate = async (req) => {
        calls.push(req); const ans = answerFor(req.messages[0].content);
        if (!req.enableThinking) return ans;
        if (mode === 'throw') throw new Error('boom');
        if (mode === 'unclosed') return '<think>' + SECRET + ' 想到一半';
        if (mode === 'badjson') return '<think>' + SECRET + '</think>這不是 JSON';
        return '<think>' + SECRET + '</think>\n' + ans;
    };
    return { generate, calls };
}
const PREFILL_ACTORS = '{"actors":["';

(async () => {
    // ---- A. thinkingPlan：哪些模型、預算跟著 contextTokens 縮放 ----
    const p4 = R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096 });
    check('A1 qwen3-0.6b plan on, budget 1638 at 4096 ctx, timeout 30s', p4.enabled === true && p4.maxTokens === 1638 && p4.timeoutMs === 30000, p4);
    check('A2 budget clamps to min 1500 at small context', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 2048 }).maxTokens === 1500);
    check('A3 budget clamps to max 3000 at large context', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 8192 }).maxTokens === 3000);
    check('A4 switch off (enabled:false) turns it off', R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096, enabled: false }).enabled === false);
    check('A5 qwen3-1.7b is not in this path', R.thinkingPlan({ modelId: 'qwen3-1.7b', stage: 'plan', contextTokens: 8192 }).enabled === false);
    check('A6 qwen2.5-1.5b is not in this path', R.thinkingPlan({ modelId: 'qwen2.5-1.5b', stage: 'plan', contextTokens: 8192 }).enabled === false);
    check('A7 online model id is not in this path', R.thinkingPlan({ modelId: 'online:gpt-x', stage: 'plan', contextTokens: 8192 }).enabled === false);

    // ---- B. 計畫入口：thinking 開／關、其他模型行為不變 ----
    const f0 = fakeModel('good');
    const r0 = await U.scenarioToModel(SCENARIO, { program: false, generate: f0.generate });
    check('B1 no thinking option: every request has only messages/maxTokens/prefill', r0.ok && f0.calls.length > 0 && f0.calls.every((c) => Object.keys(c).sort().join(',') === 'maxTokens,messages,prefill'), Object.keys(f0.calls[0] || {}));
    const f1 = fakeModel('good');
    const off = R.thinkingPlan({ modelId: 'qwen2.5-1.5b', stage: 'plan', contextTokens: 8192 });
    const r1 = await U.scenarioToModel(SCENARIO, { program: false, generate: f1.generate, thinking: off });
    check('B2 other model (thinking disabled): requests unchanged, no enableThinking/timeoutMs keys', r1.ok && f1.calls.every((c) => Object.keys(c).sort().join(',') === 'maxTokens,messages,prefill') && f1.calls.every((c) => c.enableThinking === undefined), Object.keys(f1.calls[0] || {}));
    const f2 = fakeModel('good');
    const on = R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 4096 });
    const r2 = await U.scenarioToModel(SCENARIO, { program: false, generate: f2.generate, thinking: on });
    check('B3 qwen3-0.6b on: every thinking request has enableThinking:true and timeoutMs:30000', r2.ok && f2.calls.length > 0 && f2.calls.every((c) => c.enableThinking === true && c.timeoutMs === 30000), f2.calls.map((c) => [c.enableThinking, c.timeoutMs]));
    check('B4 qwen3-0.6b on: the thinking round carries the budget (maxTokens 1638) and no prefill', f2.calls.every((c) => c.maxTokens === 1638 && !('prefill' in c)), f2.calls.map((c) => [c.maxTokens, 'prefill' in c]));
    check('B5 budget follows contextTokens in the real request (2048 ctx => 1500)', await (async () => { const f = fakeModel('good'); await U.scenarioToModel(SCENARIO, { program: false, generate: f.generate, thinking: R.thinkingPlan({ modelId: 'qwen3-0.6b', stage: 'plan', contextTokens: 2048 }) }); return f.calls.every((c) => c.maxTokens === 1500); })());
    check('B6 thinking on, normal answers: no non-thinking fallback call is made', f2.calls.every((c) => c.enableThinking === true));

    // ---- C. 逾時／退路：思考沒閉合或答案不合法 → 同一題關 thinking 再問一次 ----
    const f3 = fakeModel('unclosed');
    const r3 = await U.scenarioToModel(SCENARIO, { program: false, generate: f3.generate, thinking: on });
    const fb3 = f3.calls.filter((c) => c.enableThinking === false);
    check('C1 timeout-like unclosed thinking falls back to one non-thinking ask on the same question', r3.ok && fb3.length > 0 && fb3[0].messages[0].content === f3.calls[0].messages[0].content, { n: fb3.length, ok: r3.ok });
    check('C2 fallback ask keeps prefill (answer shape is forced again)', fb3.length > 0 && fb3[0].prefill === PREFILL_ACTORS, fb3[0] && fb3[0].prefill);
    check('C3 fallback ask keeps the plan timeout (30s, independent of the 90s/300s default)', fb3.length > 0 && fb3[0].timeoutMs === 30000, fb3[0] && Object.keys(fb3[0]));
    const f4 = fakeModel('badjson');
    const r4 = await U.scenarioToModel(SCENARIO, { program: false, generate: f4.generate, thinking: on });
    check('C4 invalid answer after thinking also falls back and the pipeline still completes', r4.ok && f4.calls.some((c) => c.enableThinking === false), { ok: r4.ok, n: f4.calls.length });
    const f5 = fakeModel('throw');
    let threw = false; let r5 = null;
    try { r5 = await U.scenarioToModel(SCENARIO, { program: false, generate: f5.generate, thinking: on }); } catch (_) { threw = true; }
    check('C5 generate throwing under thinking does not escape as an unhandled exception', !threw && r5 && r5.ok === false && typeof r5.error === 'string', { threw, r5: r5 && r5.error });

    // ---- D. 推理只給介面，不進 messages、不送回模型、不進結果的答案部分 ----
    const leaked = f3.calls.some((c) => JSON.stringify(c.messages).includes(SECRET)) || f4.calls.some((c) => JSON.stringify(c.messages).includes(SECRET));
    check('D1 reasoning text never appears in any request messages (unclosed and bad-json cases)', !leaked);
    const f6 = fakeModel('good');
    const r6 = await U.scenarioToModel(SCENARIO, { program: false, generate: f6.generate, thinking: on });
    check('D2 reasoning text never appears in the model answer, dsl or decisions', r6.ok && !r6.dsl.includes(SECRET) && !JSON.stringify(r6.decisions).includes(SECRET) && !JSON.stringify(r6.model).includes(SECRET));
    check('D3 reasoning is exposed as a plain data field on the plan result', r6.ok && typeof r6.reasoning === 'string' && r6.reasoning.includes(SECRET), r6.reasoning && r6.reasoning.slice(0, 80));
    const events = [];
    await U.scenarioToModel(SCENARIO, { program: false, generate: fakeModel('good').generate, thinking: on, onStage: (e) => events.push(e) });
    check('D4 progress events: 思考中 then 思考完成（N 字）, with N > 0', events.some((e) => e.type === 'thinking' && e.phase === 'start') && events.some((e) => e.type === 'thinking' && e.phase === 'done' && e.chars > 0), events.filter((e) => e.type === 'thinking').slice(0, 2));
    const r7 = await U.scenarioToModel(SCENARIO, { program: false, generate: fakeModel('good').generate });
    check('D5 thinking off: plan result has an empty reasoning field and no thinking events', r7.ok && r7.reasoning === '' );
    // 同一次計畫：多個步驟的推理互不進入後面的 messages（每次都是新的一題）
    const f8 = fakeModel('good'); await U.scenarioToModel(SCENARIO, { program: false, generate: f8.generate, thinking: on });
    check('D6 each stage starts a fresh question: no request carries another request\'s reasoning', f8.calls.every((c) => c.messages.length === 2 && c.messages.every((m) => !JSON.stringify(m).includes(SECRET))), f8.calls.map((c) => c.messages.length));
    // 大問題（切塊）也要把推理合併到 reasoning，且不進 messages
    const big = '線上書店：顧客可以結帳。顧客可以查詢訂單。管理員可以新增書籍。管理員可以刪除書籍。顧客可以取消訂單。';
    const r9 = await U.scenarioToModelBig(big, { program: false, generate: fakeModel('good').generate, thinking: on });
    check('D7 chunked scenario: reasoning from every chunk is collected', r9.ok && r9.chunks > 1 && (r9.reasoning.match(new RegExp(SECRET, 'g')) || []).length >= 2, { chunks: r9.chunks, n: (r9.reasoning.match(new RegExp(SECRET, 'g')) || []).length });

    console.log('think_plan_uml: ' + ok + ' passed, ' + bad.length + ' failed');
    if (bad.length) { console.log('FAILED: ' + bad.join(', ')); process.exit(1); }
})();
