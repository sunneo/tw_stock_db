// CoLU+Thinking 階段 3（計畫階段接上 thinking）真實 Electron 評估。假的離線生成，不下載任何模型。
// 走的整條路徑：fa._umlDesign（計畫入口）→ _umlModel → _planModel → _llmGenerate → _vlmRpc（工作者的 payload）。
// 確認：qwen3-0.6b 的計畫請求帶 enableThinking、逾時 30 秒、預算依 contextTokens；開關關掉時完全不帶；推理不進工具結果。
// 用法：node scripts/eval/run_eval.js scripts/eval/colu_think_plan.eval.js [埠]
const fa = window.fa; const R = {};
const MARK = 'E_R_MARK';
const SCENARIO = '火星人可以做一些事情';
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

// ---- 假的離線生成（在工作者的 RPC 那一層，之後的路徑全是真的）----
const rpcs = []; const llmCalls = [];
const saved = {};
const stubs = {
    _omInstalled: async () => ({ usage: { byModel: { 'qwen3-0.6b': { files: 1, bytes: 600000000 } }, total: 0 }, set: new Set(['qwen3-0.6b']) }),
    _vlmEnsureLoaded: async () => ({ device: 'wasm' }),
    _vlmSlotOf: () => 0,
    _vlmWorkerGet: () => ({ worker: { postMessage() {} } }),
    _vlmScheduleIdle: () => {},
    _vlmRpc: async (type, payload) => {
        if (type !== 'chat') throw new Error('eval: unexpected rpc ' + type);
        rpcs.push({ enableThinking: payload.enableThinking === true, maxTokens: payload.maxTokens, hasPrefill: !!payload.prefill });
        const text = answerFor(String(payload.messages[0].content));
        return { raw: payload.enableThinking === true ? '<think>' + MARK + '</think>\n' + text : text };
    },
};
for (const k of Object.keys(stubs)) { saved[k] = fa[k]; fa[k] = stubs[k]; }
const origGen = fa._llmGenerate.bind(fa); saved._llmGenerate = fa._llmGenerate;
fa._llmGenerate = async (model, a, cb) => { llmCalls.push({ model: model && model.id, enableThinking: a.enableThinking === true, timeoutMs: a.timeoutMs, maxTokens: a.maxTokens }); return origGen(model, a, cb); };
const savedCfg = fa.advancedSettings.coluThinking; const savedViewer = fa.advancedSettings.umlViewerAutoOpen;
fa.advancedSettings.umlViewerAutoOpen = false;

async function runPlan() {
    llmCalls.length = 0; rpcs.length = 0;
    let res = null, err = null;
    try { res = await fa._umlDesign({ scenario: SCENARIO, model: 'offline', language: 'python' }); } catch (e) { err = String((e && e.message) || e); }
    return { res, err, llm: llmCalls.slice(), rpc: rpcs.slice() };
}

return await (async () => {
    try {
        // A. 預設（開關未設定 → 視為開）
        fa.advancedSettings.coluThinking = undefined;
        const A = await runPlan(); const thinkLlm = A.llm.filter((c) => c.enableThinking);
        R.A_error = A.err;
        R.A_model = A.llm.length ? A.llm[0].model : null;
        R.A_llm_calls = A.llm.length;
        R.A_thinking_calls = thinkLlm.length;
        R.A_thinking_timeout_ok = thinkLlm.length > 0 && thinkLlm.every((c) => c.timeoutMs === 30000);
        R.A_thinking_budget_ok = thinkLlm.length > 0 && thinkLlm.every((c) => c.maxTokens === 1638);
        R.A_rpc_reached_worker = A.rpc.some((r) => r.enableThinking === true);
        R.A_marker_in_tool_result = JSON.stringify(A.res || {}).includes(MARK);
        R.A_progress_line_seen = document.body.innerText.includes('思考完成');

        // B. 開關關掉 → 完全不帶 thinking
        fa.advancedSettings.coluThinking = false;
        const B = await runPlan();
        R.B_error = B.err;
        R.B_llm_calls = B.llm.length;
        R.B_any_thinking = B.llm.some((c) => c.enableThinking) || B.rpc.some((r) => r.enableThinking);
        R.B_no_timeout_override = B.llm.every((c) => c.timeoutMs === undefined);
        R.B_marker_in_tool_result = JSON.stringify(B.res || {}).includes(MARK);

        const pass = !R.A_error && !R.B_error && R.A_thinking_calls > 0 && R.A_thinking_timeout_ok && R.A_thinking_budget_ok && R.A_rpc_reached_worker && !R.A_marker_in_tool_result && !R.B_any_thinking && R.B_no_timeout_override && !R.B_marker_in_tool_result;
        R.result = pass ? 'PASS' : 'FAIL';
    } finally {
        for (const k of Object.keys(saved)) fa[k] = saved[k];
        fa.advancedSettings.coluThinking = savedCfg; fa.advancedSettings.umlViewerAutoOpen = savedViewer;
    }
    console.log('[eval-file] colu_think_plan ' + JSON.stringify(R));
    return R;
})();
