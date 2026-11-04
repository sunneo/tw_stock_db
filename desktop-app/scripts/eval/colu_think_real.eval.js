// CoLU+Thinking 階段 6：真的 qwen3-0.6b 量測（不假模型、不改工作目錄任何檔）。
// 走的路徑（全部是桌面版真實程式）：
//   載入／下載：fa._vlmEnsureLoaded（同一套離線模型下載機制，只下載 qwen3-0.6b）
//   生成：fa._llmGenerate（真工作者、真串流、真逾時、真垃圾輸出偵測）
//   解析：FaRecipe.stripThink、FaColuBench.grade（計畫題）、coluThinkReflect（反思，含 jsonStep 退路）
// 題目固定可重現：封閉題用固定種子產生（答案由程式算出）；計畫題用 FaColuBench.makeTasks（種子 20261104）。
// 量測組（每組 N 題，同一批題）：
//   G1 封閉題・思考關　G2 封閉題・思考開（計畫預算，逾時 30 秒）
//   G3 計畫題・思考關　G4 計畫題・思考開（計畫預算，逾時 30 秒）　G5 計畫題・思考開，逾時 120 秒（對照：30 秒會不會切掉答案）
//   R  反思穩定度：同一計畫題跑 3 次 coluThinkReflect（思考開，反思預算，逾時 15 秒），看三次是否一致
// 裝置：fa._omGpuInfo + FaVlm.resolveDevice（先 WebGPU，不行退 CPU），實際裝置記在 R.load.device 與每筆 device。
// 用法：見 DESIGN.TODO.colu-thinking.md 階段 6 記錄（獨立 --user-data-dir、FA_BROWSER_CONTROL_PORT 換埠）。
return (async () => {
    const fa = window.fa;
    const MODEL_ID = 'qwen3-0.6b';
    const N = 20;
    const SEED = 20261104;
    const R = { model: MODEL_ID, n_requested: N };
    const model = FaVlm.byId(MODEL_ID);
    const tag = (s) => console.log('[eval-file] ' + s);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---- 1. 裝置與載入（真下載：第一次執行會下載，之後從快取載入）----
    const gpu = await fa._omGpuInfo(true);
    const dev = FaVlm.resolveDevice(model, fa._omDevicePrefOf(model), gpu.available, gpu.f16);
    R.gpu = { available: !!gpu.available, f16: !!gpu.f16 };
    R.device_order = dev.order; R.device_reason = dev.reason || null;
    const t0 = Date.now(); let ld = null; let lastPct = null; const loadLog = [];
    try {
        ld = await fa._vlmEnsureLoaded(model, dev.order, (x) => { if (x && x.pct != null) lastPct = Math.round(x.pct); }, (s) => { loadLog.push(String(s).slice(0, 120)); tag('載入：' + s); });
        R.load = { ok: true, device: ld.device, ms: Date.now() - t0, tried: ld.tried || null, last_pct: lastPct };
    } catch (e) {
        R.load = { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
        return R;
    }
    R.load.log = loadLog.slice(-6);
    tag('載入完成：' + ld.device + '，' + R.load.ms + ' 毫秒');

    // ---- 2. 生成包裝（真的 _llmGenerate）----
    const deviceNow = () => (fa._omLastDevice || {})[MODEL_ID] || null;
    async function gen(messages, maxTokens, enableThinking, timeoutMs) {
        const t = Date.now(); let raw = ''; let err = null;
        try { raw = await fa._llmGenerate(model, { messages, maxTokens, enableThinking, timeoutMs }, {}); } catch (e) { err = String((e && e.message) || e); }
        const ms = Date.now() - t; const text = String(raw == null ? '' : raw); const st = FaRecipe.stripThink(text);
        const tagState = /<think(?:ing)?>/i.test(text) ? 'tagged' : (/<\/think(?:ing)?>/i.test(text) ? 'closing_only' : 'none');
        return { raw: text, answer: st.answer, reasoning: st.reasoning, unclosed: st.unclosed, think_chars: st.reasoning.length, tag_state: tagState, ms, err, device: deviceNow() };
    }
    const thinkPlan = FaRecipe.thinkingPlan({ modelId: MODEL_ID, stage: 'plan', contextTokens: model.contextTokens, enabled: true });
    R.plan_budget = { maxTokens: thinkPlan.maxTokens, timeoutMs: thinkPlan.timeoutMs, contextTokens: model.contextTokens };
    const OFF_MAX = 160; // 同 jsonStep 的預設 maxTokens
    const OFF_TIMEOUT = 300000; // 同 _llmGenerate 的 CPU 預設（沒有給 timeoutMs 時）

    // ---- 3. 封閉題：固定種子、答案由程式算（四種題型各 5 題）----
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    function closedQuestions() {
        const r = rng(SEED); const out = [];
        for (let i = 0; i < N; i++) {
            let q, ans;
            const k = i % 4;
            if (k === 0) { const a = 11 + Math.floor(r() * 38), b = 11 + Math.floor(r() * 38); ans = a * b; q = a + ' × ' + b + ' 等於多少？'; }
            else if (k === 1) { const a = 100 + Math.floor(r() * 900), b = 7 + Math.floor(r() * 13); ans = a % b; q = a + ' 除以 ' + b + ' 的餘數是多少？'; }
            else if (k === 2) { let x = 1 + Math.floor(r() * 5); const seq = [x]; for (let j = 0; j < 3; j++) { x = 2 * x + 1; seq.push(x); } ans = 2 * x + 1; q = '數列 ' + seq.join(', ') + ', ... 的下一個數是多少？（規律：每一項是前一項的 2 倍加 1）'; }
            else { const a = 2 + Math.floor(r() * 8), b = 2 + Math.floor(r() * 8), c = 2 + Math.floor(r() * 8), d = 1 + Math.floor(r() * 9); ans = (a + b) * c - d; q = '(' + a + ' + ' + b + ') × ' + c + ' − ' + d + ' 等於多少？'; }
            const opts = [ans]; while (opts.length < 4) { const cand = ans + (Math.floor(r() * 19) - 9); if (cand > 0 && opts.indexOf(cand) < 0) opts.push(cand); }
            for (let j = opts.length - 1; j > 0; j--) { const m = Math.floor(r() * (j + 1)); [opts[j], opts[m]] = [opts[m], opts[j]]; }
            const letter = 'ABCD'[opts.indexOf(ans)];
            out.push({ id: 'c' + i, text: q + '\nA. ' + opts[0] + '　B. ' + opts[1] + '　C. ' + opts[2] + '　D. ' + opts[3], letter });
        }
        return out;
    }
    const CQ = closedQuestions();
    const closedMsgs = (q) => [{ role: 'system', content: '你是答題助手。只回 JSON，不要多說話。' }, { role: 'user', content: q.text + '\n只回這個格式：{"answer":"字母"}' }];
    function parseLetter(answer) {
        const m = String(answer || '').match(/\{[^{}]*\}/); if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o.answer === 'string') return o.answer.trim().toUpperCase().slice(0, 1); } catch (_) { /* 往下 */ } }
        const l = String(answer || '').match(/\b([A-D])\b/); return l ? l[1] : null;
    }

    // ---- 4. 計畫題：FaColuBench.makeTasks（真單元目錄）----
    await fa._unitCatalogStoreLoad();
    const M = FaCatalogMatrix.buildMatrix(fa._unitCatalogBuild());
    const mk = FaColuBench.makeTasks(M, { n: N, seed: SEED });
    const PT = mk.tasks.filter((t) => t.options).slice(0, N);
    R.plan_tasks = { made: mk.tasks.length, with_options: PT.length, skipped: mk.skipped || null, reason: mk.reason || null, units: M.units.length };
    const planMsgs = (task) => { const p = FaColuBench.buildPrompt(task, 'assisted'); return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]; };

    // ---- 5. 跑一組 ----
    async function runGroup(name, items, mkMsgs, grader, opts) {
        const rows = []; const tStart = Date.now();
        for (const it of items) {
            const g = await gen(mkMsgs(it), opts.maxTokens, opts.think, opts.timeoutMs);
            const r = grader(it, g);
            const limit = opts.timeoutMs || OFF_TIMEOUT;
            rows.push({ id: it.id, ok: r.ok, parsed: r.parsed, ms: g.ms, device: g.device, think_chars: g.think_chars, unclosed: g.unclosed, tag_state: g.tag_state, err: g.err, timeout: g.ms >= limit - 500 && !r.parsed, reason: r.reason || '' });
        }
        tag(name + ' 完成：' + rows.filter((x) => x.ok).length + '/' + rows.length + '，耗時 ' + Math.round((Date.now() - tStart) / 1000) + ' 秒');
        return rows;
    }
    const closedGrader = (q, g) => { const l = parseLetter(g.answer); return { parsed: !!l, ok: l === q.letter, reason: l ? '' : '格式不對' }; };
    const planGrader = (task, g) => { const x = FaColuBench.grade(M, task, g.answer, 'assisted'); return { parsed: x.parsed, ok: !!x.ok, reason: x.reason }; };
    const thinkOpts = { maxTokens: thinkPlan.maxTokens, think: true, timeoutMs: thinkPlan.timeoutMs };
    const thinkLong = { maxTokens: thinkPlan.maxTokens, think: true, timeoutMs: 120000 };
    const offOpts = { maxTokens: OFF_MAX, think: false, timeoutMs: 0 };

    const G = {};
    G.closed_off = await runGroup('G1 封閉題・思考關', CQ, closedMsgs, closedGrader, offOpts);
    G.closed_on = await runGroup('G2 封閉題・思考開', CQ, closedMsgs, closedGrader, thinkOpts);
    G.plan_off = await runGroup('G3 計畫題・思考關', PT, planMsgs, planGrader, offOpts);
    G.plan_on = await runGroup('G4 計畫題・思考開（30 秒）', PT, planMsgs, planGrader, thinkOpts);
    G.plan_on120 = await runGroup('G5 計畫題・思考開（120 秒對照）', PT, planMsgs, planGrader, thinkLong);

    // ---- 6. 反思穩定度：同一計畫題跑 3 次 coluThinkReflect（思考開，反思預算，逾時 15 秒，含 jsonStep 退路）----
    const refGen = (req) => fa._llmGenerate(model, { messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking, timeoutMs: req.timeoutMs }, {});
    const refRows = [];
    for (const task of PT) {
        const question = task.need + '\n計畫步驟：' + task.intended.map((id) => { const c = task.candidates.find((x) => x.id === id); return c ? c.name : id; }).join(' → ');
        const runs = [];
        for (let k = 0; k < 3; k++) {
            const t = Date.now(); const r = await FaRecipe.coluThinkReflect({ generate: refGen, modelId: MODEL_ID, contextTokens: model.contextTokens, enabled: true, question });
            runs.push({ gap: r.gap, ok: !!r.ok, ms: Date.now() - t, skipped: !!r.skipped });
        }
        const consistent = runs.every((x) => x.ok) && runs.every((x) => x.gap === runs[0].gap);
        refRows.push({ id: task.id, runs, consistent, all_ok: runs.every((x) => x.ok) });
    }
    tag('R 反思穩定度完成');

    // ---- 7. 彙整 ----
    const stat = (rows, limitMs) => {
        const n = rows.length; const ok = rows.filter((r) => r.ok).length; const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
        const thk = rows.map((r) => r.think_chars).sort((a, b) => a - b);
        return {
            n, ok, acc: n ? Math.round((ok / n) * 100) / 100 : null,
            median_ms: ms.length ? ms[ms.length >> 1] : null, max_ms: ms.length ? ms[ms.length - 1] : null,
            over_30s: rows.filter((r) => r.ms > 30000).length,
            timeouts: rows.filter((r) => r.timeout).length,
            parse_fail: rows.filter((r) => !r.parsed).length,
            unclosed_think: rows.filter((r) => r.unclosed).length,
            think_chars_median: thk.length ? thk[thk.length >> 1] : null,
            tag_states: rows.reduce((o, r) => { o[r.tag_state] = (o[r.tag_state] || 0) + 1; return o; }, {}),
            errors: rows.filter((r) => r.err).length,
            devices: Array.from(new Set(rows.map((r) => r.device))),
        };
    };
    R.stats = {};
    for (const k of Object.keys(G)) R.stats[k] = stat(G[k]);
    // 退路：思考開那一題解析失敗 → 退路改問關閉思考那一題（同題），看最後能不能答對
    const fallbackAcc = (on, off) => { const n = on.length; let ok = 0, triggers = 0; on.forEach((r, i) => { if (r.parsed) { if (r.ok) ok++; } else { triggers++; if (off[i] && off[i].ok) ok++; } }); return { triggers, ok, n, acc: n ? Math.round((ok / n) * 100) / 100 : null }; };
    R.fallback = { closed: fallbackAcc(G.closed_on, G.closed_off), plan: fallbackAcc(G.plan_on, G.plan_off) };
    // 同題兩組的對照（思考開 vs 關）：開贏、關贏、同對、同錯
    const pair = (a, b) => { let won = 0, lost = 0, both = 0, neither = 0; a.forEach((r, i) => { const x = r.ok, y = b[i] && b[i].ok; if (x && !y) won++; else if (!x && y) lost++; else if (x && y) both++; else neither++; }); return { on_only_right: won, off_only_right: lost, both_right: both, both_wrong: neither }; };
    R.paired = { closed: pair(G.closed_on, G.closed_off), plan: pair(G.plan_on, G.plan_off), plan_120_vs_30: pair(G.plan_on120, G.plan_on) };
    R.reflect = {
        tasks: refRows.length,
        all_ok: refRows.filter((r) => r.all_ok).length,
        consistent: refRows.filter((r) => r.consistent).length,
        consistency_rate: refRows.length ? Math.round((refRows.filter((r) => r.consistent).length / refRows.length) * 100) / 100 : null,
        gap_true_runs: refRows.reduce((s, r) => s + r.runs.filter((x) => x.gap).length, 0),
        runs_total: refRows.length * 3,
        median_ms: (() => { const a = refRows.flatMap((r) => r.runs.map((x) => x.ms)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; })(),
    };
    R.elapsed_total_ms = Date.now() - T0;
    R.rows = G; R.reflect_rows = refRows;
    tag('彙整完成，總耗時 ' + Math.round(R.elapsed_total_ms / 1000) + ' 秒');
    return R;
})();
