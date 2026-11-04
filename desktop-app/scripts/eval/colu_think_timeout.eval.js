// CoLU+Thinking 階段 7（思考逾時的硬性上限）真實 Electron 評估。假的慢工作者（故意不回），不載入任何真模型、不下載任何東西。
// 確認整條路徑：_llmGenerate（真的，帶 timeoutMs）→ guardedCall → jsonStep 的關閉思考退路。
//  A. 不會中斷的工作者（卡住不回）：timeoutMs 後 5–10 秒內拋出 timeout 錯誤，工作者被終止（die 一次）。
//  B. 同一題經 jsonStep：思考那一輪逾時 → 關掉思考重問 → 拿到答案（ok:true），整段耗時在 timeoutMs＋寬限內。
//  C. 會中斷的工作者：收到中斷後很快回覆 → 直接拿到中斷後的結果，不終止工作者（die 為 0）。
// 用法：node scripts/eval/run_eval.js scripts/eval/colu_think_timeout.eval.js [埠]
const fa = window.fa; const R = {};
const TIMEOUT = 3000;
const m = FaVlm.byId('qwen3-0.6b');
const mode = { interruptible: false };
const rec = {
    pending: new Map(), tid: 0, dies: 0, interrupts: 0,
    worker: {
        postMessage(msg) {
            if (!msg || msg.type !== 'interrupt') return;
            rec.interrupts++;
            if (!mode.interruptible) return;
            const first = rec.pending.keys().next(); if (first.done) return;
            const p = rec.pending.get(first.value); rec.pending.delete(first.value);
            setTimeout(() => p.resolve({ raw: '{"gap":false,"note":"中斷後的結果"}' }), 100);
        },
    },
    die(msg) { rec.dies++; for (const p of rec.pending.values()) p.reject(new Error(msg)); rec.pending.clear(); },
};
const stubs = {
    _vlmEnsureLoaded: async () => ({ device: 'wasm', tried: [] }),
    _vlmWorkerGet: () => rec,
    _vlmScheduleIdle: () => {},
    _vlmRpc: (type, payload) => {
        if (type !== 'chat') throw new Error('eval: unexpected rpc ' + type);
        const tid = ++rec.tid;
        return new Promise((resolve, reject) => {
            rec.pending.set(tid, { resolve, reject });
            // 思考那一輪：永遠不回（像卡在一步計算裡）；關掉思考的退路那一輪：很快回覆
            if (!payload.enableThinking) setTimeout(() => { if (rec.pending.delete(tid)) resolve({ raw: '{"gap":false,"note":""}' }); }, 50);
        });
    },
};
const saved = {}; for (const k of Object.keys(stubs)) { saved[k] = fa[k]; fa[k] = stubs[k]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgs = [{ role: 'user', content: '檢查這個計畫' }];
const gen = (req) => fa._llmGenerate(m, { messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking === true, timeoutMs: req.timeoutMs }, {});

try {
    // A. 卡住不回：直接呼叫 _llmGenerate（開思考）
    let t0 = Date.now(); let errA = null;
    try { await fa._llmGenerate(m, { messages: msgs, maxTokens: 16, enableThinking: true, timeoutMs: TIMEOUT }, {}); } catch (e) { errA = e; }
    R.A_elapsed_ms = Date.now() - t0;
    R.A_error = errA ? String(errA.message || errA) : null;
    R.A_timeout_flag = !!(errA && errA.timeout === true);
    R.A_worker_killed_once = rec.dies === 1;
    R.A_pass = R.A_timeout_flag && R.A_worker_killed_once && R.A_elapsed_ms >= TIMEOUT && R.A_elapsed_ms <= TIMEOUT + 7000;

    // B. jsonStep：思考逾時 → 關掉思考重問 → 合格答案
    const dies0 = rec.dies; const calls = [];
    t0 = Date.now();
    const r = await FaRecipe.jsonStep({
        generate: (req) => { calls.push({ thinking: req.enableThinking === true, timeoutMs: req.timeoutMs }); return gen(req); },
        messages: msgs, maxTries: 2, maxTokens: 160, prefill: '{"gap":',
        thinking: { enabled: true, timeoutMs: TIMEOUT, maxTokens: 400 },
        validate: (o) => typeof o.gap === 'boolean' ? [] : ['gap 必須是布林'],
    });
    R.B_elapsed_ms = Date.now() - t0;
    R.B_ok = r.ok === true; R.B_value = r.value || null; R.B_error = r.error || null;
    R.B_calls = calls;
    R.B_worker_killed = rec.dies - dies0;
    R.B_pass = R.B_ok && calls.length === 2 && calls[0].thinking === true && calls[1].thinking === false
        && R.B_elapsed_ms <= TIMEOUT + 7000 && R.B_elapsed_ms >= TIMEOUT;

    // C. 會中斷的工作者：中斷後很快回覆 → 拿到中斷後的結果，不終止
    mode.interruptible = true; const dies1 = rec.dies; const i1 = rec.interrupts;
    t0 = Date.now(); let errC = null; let valC = null;
    try { valC = await fa._llmGenerate(m, { messages: msgs, maxTokens: 16, enableThinking: true, timeoutMs: TIMEOUT }, {}); } catch (e) { errC = e; }
    R.C_elapsed_ms = Date.now() - t0; R.C_raw = valC; R.C_error = errC ? String(errC.message || errC) : null;
    R.C_killed = rec.dies - dies1; R.C_interrupts = rec.interrupts - i1;
    R.C_pass = !errC && typeof valC === 'string' && valC.indexOf('中斷後的結果') >= 0 && R.C_killed === 0 && R.C_elapsed_ms < TIMEOUT + 2000;
    mode.interruptible = false;

    await sleep(50);
    R.result = R.A_pass && R.B_pass && R.C_pass ? 'PASS' : 'FAIL';
} finally {
    for (const k of Object.keys(saved)) fa[k] = saved[k];
}
console.log('[eval-file] colu_think_timeout ' + JSON.stringify(R));
return R;
