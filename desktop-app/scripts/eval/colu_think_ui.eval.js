// CoLU+Thinking 階段 5（設定介面與推理顯示）真實 Electron 評估。假的離線生成，不下載任何模型。
// 確認：
//  1. 設定面板 #ai-colu-think-chk 存在、預設打開、點擊後 advancedSettings.coluThinking 跟著變（關→開）。
//  2. 關閉後，UML 計畫的請求不帶 enableThinking（沒有任何 thinking 請求），也沒有推理區塊。
//  3. 開啟後，計畫請求帶 enableThinking；進度卡片裡出現「思考過程」收合區塊（預設收合），展開後內容正確（含推理標記），
//     推理裡的 HTML 標籤被跳脫（沒有產生 <img> 元素）。
//  4. 推理標記不出現在工具結果、不出現在 fa.messages 的任何 content 裡。
// 用法：node scripts/eval/run_eval.js scripts/eval/colu_think_ui.eval.js [埠]
const fa = window.fa; const R = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = 'E_S5_MARK';
const HTML_IN_THINK = '<img src=x onerror="window.__s5_xss=1">';
const SCENARIO = '火星人可以做一些事情';
const NOGAP = '{"gap":false,"note":""}';
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
const rpcs = [];
const stubs = {
    _omInstalled: async () => ({ usage: { byModel: { 'qwen3-0.6b': { files: 1, bytes: 600000000 } }, total: 0 }, set: new Set(['qwen3-0.6b']) }),
    _vlmEnsureLoaded: async () => ({ device: 'wasm' }),
    _vlmSlotOf: () => 0,
    _vlmWorkerGet: () => ({ worker: { postMessage() {} } }),
    _vlmScheduleIdle: () => {},
    _vlmRpc: async (type, payload) => {
        if (type !== 'chat') throw new Error('eval: unexpected rpc ' + type);
        const sys = String(payload.messages[0].content); const think = payload.enableThinking === true;
        rpcs.push({ thinking: think, reflect: isReflect(sys), msgsText: JSON.stringify(payload.messages) });
        const text = isReflect(sys) ? NOGAP : ANS[stageOf(sys)];
        return { raw: think ? '<think>' + MARK + ' ' + HTML_IN_THINK + '</think>\n' + text : text };
    },
};
const saved = {}; for (const k of Object.keys(stubs)) { saved[k] = fa[k]; fa[k] = stubs[k]; }
const savedCfg = fa.advancedSettings.coluThinking; const savedViewer = fa.advancedSettings.umlViewerAutoOpen;
fa.advancedSettings.umlViewerAutoOpen = false;

async function runDesign() {
    rpcs.length = 0; let res = null, err = null;
    try { res = await fa._umlDesign({ scenario: SCENARIO, model: 'offline', language: 'python' }); } catch (e) { err = String((e && e.message) || e); }
    return { res, err, rpc: rpcs.slice() };
}
function reasoningCardCount() {
    return fa.messages.filter((m) => m && m._progressWidget && Array.isArray(m._progressWidget.reasoning) && m._progressWidget.reasoning.length > 0).length;
}

return await (async () => {
    try {
        // 1. 設定面板：存在、預設打開、點擊切換
        fa._openAdvancedModal(); await sleep(400);
        const chk = document.getElementById('ai-colu-think-chk');
        R.checkboxExists = !!chk;
        R.labelHasName = !!chk && /CoLU\+Thinking/.test((chk.parentElement.querySelector('label') || {}).textContent || '');
        R.defaultOn = fa.advancedSettings.coluThinking === true && !!chk && chk.checked === true;
        if (chk) chk.click(); await sleep(150);
        R.clickOffSetsFalse = fa.advancedSettings.coluThinking === false && document.getElementById('ai-colu-think-chk').checked === false;
        if (chk) chk.click(); await sleep(150);
        R.clickOnSetsTrue = fa.advancedSettings.coluThinking === true;
        fa._closeAdvancedModal(); await sleep(150);

        // 2. 關閉 → 計畫請求不帶 thinking，沒有推理區塊
        fa.advancedSettings.coluThinking = false;
        const off = await runDesign();
        R.off_error = off.err;
        R.off_no_thinking_request = off.rpc.length > 0 && !off.rpc.some((r) => r.thinking);
        R.off_no_reasoning_card = reasoningCardCount() === 0 && document.querySelectorAll('.colu-think-block').length === 0;

        // 3. 開啟 → 計畫請求帶 thinking；卡片有收合的「思考過程」區塊
        fa.advancedSettings.coluThinking = true;
        const on = await runDesign();
        R.on_error = on.err;
        R.on_result_ok = !!(on.res && on.res.ok);
        R.on_thinking_request = on.rpc.some((r) => r.thinking && !r.reflect);
        R.on_reasoning_card = reasoningCardCount() > 0;
        if (fa._renderMessageHistory) fa._renderMessageHistory();
        await sleep(300);
        const blocks = Array.from(document.querySelectorAll('.colu-think-block'));
        R.block_count = blocks.length;
        R.block_collapsed_by_default = blocks.length > 0 && blocks.every((d) => d.open === false);
        R.block_summary = blocks.length > 0 ? (blocks[0].querySelector('summary') || {}).textContent : null;
        R.block_summary_ok = typeof R.block_summary === 'string' && R.block_summary.indexOf('思考過程') === 0;
        if (blocks.length > 0) blocks[0].open = true;
        await sleep(100);
        const pre = blocks.length > 0 ? blocks[0].querySelector('pre') : null;
        R.block_text_has_mark = !!pre && pre.textContent.indexOf(MARK) >= 0;
        R.block_text_escaped_html = !!pre && pre.textContent.indexOf(HTML_IN_THINK) >= 0 && document.querySelectorAll('.colu-think-block img').length === 0 && window.__s5_xss !== 1;

        // 4. 推理不進工具結果、不進 messages 內容
        R.mark_not_in_result = !JSON.stringify(on.res || {}).includes(MARK);
        R.mark_not_in_messages = !fa.messages.some((m) => String((m && m.content) || '').includes(MARK));
        R.mark_not_in_later_requests = !on.rpc.some((r) => !r.reflect && r.msgsText.includes(MARK));

        const pass = !R.off_error && !R.on_error && R.checkboxExists && R.labelHasName && R.defaultOn && R.clickOffSetsFalse && R.clickOnSetsTrue
            && R.off_no_thinking_request && R.off_no_reasoning_card
            && R.on_result_ok && R.on_thinking_request && R.on_reasoning_card
            && R.block_count > 0 && R.block_collapsed_by_default && R.block_summary_ok && R.block_text_has_mark && R.block_text_escaped_html
            && R.mark_not_in_result && R.mark_not_in_messages && R.mark_not_in_later_requests;
        R.result = pass ? 'PASS' : 'FAIL';
    } finally {
        for (const k of Object.keys(saved)) fa[k] = saved[k];
        fa.advancedSettings.coluThinking = savedCfg; fa.advancedSettings.umlViewerAutoOpen = savedViewer;
    }
    console.log('[eval-file] colu_think_ui ' + JSON.stringify(R));
    return R;
})();
