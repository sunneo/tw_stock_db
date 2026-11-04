// CoLU+Thinking 階段 4（反思）真實 Electron 評估。假的離線生成，不下載任何模型。
// 走的整條路徑：fa._umlDesign（計畫入口，帶 reflect）→ designProject → scenarioToModelBig → jsonStep → _llmGenerate → _vlmRpc（工作者的 payload）。
// 確認：計畫後反思有缺口 → 重做一次（重做提示只進請求）；計畫層上限 2 次反思；反思輸出壞掉 → 照原計畫；
// 答案核對失敗 → 反思一次；開關關閉 → 完全不反思；推理標記不出現在工具結果、也不出現在任何後續請求的 messages。
// 用法：node scripts/eval/run_eval.js scripts/eval/colu_think_reflect.eval.js [埠]
const fa = window.fa; const R = {};
const MARK = 'E_R4_MARK';
const SCENARIO = '火星人可以做一些事情';
const GAP = '{"gap":true,"note":"缺少付款步驟"}';
const NOGAP = '{"gap":false,"note":""}';
const REDO_PHRASE = '反思提示，請修正這個缺口';
const ANS = {
    actors: '{"actors":["Customer"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"結帳"}]}',
    classes: '{"classes":[{"name":"Book","kind":"class","label":""},{"name":"Cart","kind":"class","label":""}]}',
    members: '{"attrs":[],"ops":[]}',
    relations: '{"relations":[]}',
    sequence: '{"steps":[{"to":"Cart","op":"add"}]}',
};
function stageOf(sys) {
    if (/參與者（人或外部系統）/.test(sys)) return 'actors';
    if (/呼叫順序/.test(sys)) return 'sequence';
    if (/跟其他類別的關係/.test(sys)) return 'relations';
    if (/列出屬性與操作/.test(sys)) return 'members';
    return 'classes';
}
const isReflect = (sys) => /檢查一個計畫有沒有缺口/.test(sys);

let mode = 'gap-once'; // gap-once | gap-always | garbage | classes-fail
let classesFails = 0;
const rpcs = []; const reflectCalls = [];
const saved = {};
const stubs = {
    _omInstalled: async () => ({ usage: { byModel: { 'qwen3-0.6b': { files: 1, bytes: 600000000 } }, total: 0 }, set: new Set(['qwen3-0.6b']) }),
    _vlmEnsureLoaded: async () => ({ device: 'wasm' }),
    _vlmSlotOf: () => 0,
    _vlmWorkerGet: () => ({ worker: { postMessage() {} } }),
    _vlmScheduleIdle: () => {},
    _vlmRpc: async (type, payload) => {
        if (type !== 'chat') throw new Error('eval: unexpected rpc ' + type);
        const sys = String(payload.messages[0].content); const msgsText = JSON.stringify(payload.messages);
        const think = payload.enableThinking === true;
        if (isReflect(sys)) {
            reflectCalls.push({ thinking: think });
            rpcs.push({ reflect: true, thinking: think, msgsText });
            const n = reflectCalls.length; let text;
            if (mode === 'garbage') text = 'nope';
            else if (mode === 'gap-always') text = GAP;
            else text = n === 1 ? GAP : NOGAP; // gap-once：第一次有缺口，之後沒有
            return { raw: think ? '<think>' + MARK + '</think>\n' + text : text };
        }
        const st = stageOf(sys); let text = ANS[st];
        if (mode === 'classes-fail' && st === 'classes' && classesFails < 3) { classesFails++; text = 'nope'; }
        rpcs.push({ reflect: false, thinking: think, msgsText });
        return { raw: think ? '<think>' + MARK + '</think>\n' + text : text };
    },
};
for (const k of Object.keys(stubs)) { saved[k] = fa[k]; fa[k] = stubs[k]; }
const savedCfg = fa.advancedSettings.coluThinking; const savedViewer = fa.advancedSettings.umlViewerAutoOpen;
fa.advancedSettings.umlViewerAutoOpen = false;

async function runPlan(m, cfg) {
    mode = m; classesFails = 0; rpcs.length = 0; reflectCalls.length = 0;
    fa.advancedSettings.coluThinking = cfg;
    let res = null, err = null;
    try { res = await fa._umlDesign({ scenario: SCENARIO, model: 'offline', language: 'python' }); } catch (e) { err = String((e && e.message) || e); }
    return { res, err, rpc: rpcs.slice(), reflects: reflectCalls.length, reflectThinking: reflectCalls.filter((c) => c.thinking).length };
}

return await (async () => {
    try {
        // A. gap-once：計畫後反思有缺口 → 重做一次 → 重做的反思沒有缺口
        const A = await runPlan('gap-once', undefined);
        R.A_error = A.err;
        R.A_result_ok = !!(A.res && A.res.ok);
        R.A_reflect_calls = A.reflects;
        R.A_reflect_thinking = A.reflectThinking > 0;
        R.A_redo_request_seen = A.rpc.some((r) => !r.reflect && r.msgsText.includes(REDO_PHRASE));
        R.A_mark_not_in_result = !JSON.stringify(A.res || {}).includes(MARK);
        R.A_mark_not_in_messages = !A.rpc.some((r) => !r.reflect && r.msgsText.includes(MARK));
        R.A_progress_seen = document.body.innerText.includes('反思');

        // B. gap-always：計畫層上限 2 次反思（第二次仍有缺口 → 用原計畫）
        const B = await runPlan('gap-always', undefined);
        R.B_error = B.err;
        R.B_result_ok = !!(B.res && B.res.ok);
        R.B_reflect_calls = B.reflects;

        // C. garbage：反思輸出壞掉 → 視為沒有缺口，不重做、流程照常
        const C = await runPlan('garbage', undefined);
        R.C_error = C.err;
        R.C_result_ok = !!(C.res && C.res.ok);
        R.C_reflect_calls = C.reflects;
        R.C_no_redo = !C.rpc.some((r) => !r.reflect && r.msgsText.includes(REDO_PHRASE));

        // D. 開關關閉 → 完全不反思、沒有任何 thinking 請求
        const D = await runPlan('gap-once', false);
        R.D_error = D.err;
        R.D_reflect_calls = D.reflects;
        R.D_any_thinking = D.rpc.some((r) => r.thinking);

        // E. classes-fail：類別答案核對失敗 → 答案層反思一次（每題最多 1 次）
        const E = await runPlan('classes-fail', undefined);
        R.E_error = E.err;
        R.E_answer_reflect_seen = E.rpc.some((r) => r.reflect && /沒有通過核對/.test(r.msgsText || ''));
        R.E_reflect_calls = E.reflects;

        const pass = !R.A_error && R.A_result_ok && R.A_reflect_calls === 2 && R.A_reflect_thinking && R.A_redo_request_seen && R.A_mark_not_in_result && R.A_mark_not_in_messages
            && !R.B_error && R.B_reflect_calls === 2
            && !R.C_error && R.C_result_ok && R.C_reflect_calls === 3 && R.C_no_redo
            && !R.D_error && R.D_reflect_calls === 0 && !R.D_any_thinking
            && !R.E_error && R.E_answer_reflect_seen && R.E_reflect_calls >= 1;
        R.result = pass ? 'PASS' : 'FAIL';
    } finally {
        for (const k of Object.keys(saved)) fa[k] = saved[k];
        fa.advancedSettings.coluThinking = savedCfg; fa.advancedSettings.umlViewerAutoOpen = savedViewer;
    }
    console.log('[eval-file] colu_think_reflect ' + JSON.stringify(R));
    return R;
})();
