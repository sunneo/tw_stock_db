// CoLU+Thinking 階段 6：真的 qwen3-0.6b 量測（不假模型、不改工作目錄任何檔）。
// 走的路徑（全部是桌面版真實程式）：
//   載入：fa._vlmEnsureLoaded（同一套離線模型載入機制；模型已快取就只載入、不下載）
//   生成：fa._llmGenerate（真工作者、真串流、真逾時、真垃圾輸出偵測）
//   解析：FaRecipe.stripThink、FaColuBench.grade（計畫題）、FaRecipe.coluThinkReflect（反思，含 jsonStep 退路）
// 題目固定可重現：封閉題用固定種子產生（答案由程式算出）；計畫題用 FaColuBench.makeTasks（種子 20261104）。
// 量測組（每組 N 題，同一批題）：
//   G1 封閉題・思考關　G2 封閉題・思考開（計畫預算）
//   G3 計畫題・思考關　G4 計畫題・思考開（計畫預算）
//   R  反思穩定度：前 3 個計畫題，各跑 3 次 coluThinkReflect（思考開，反思預算，逾時 15 秒，含 jsonStep 退路）
// 逾時：WebGPU 用產品的 30 秒；CPU 用 60 秒「量測用上限」（不是產品設定，記錄裡要註明）。
// 進度：每題跑完印一行 [eval-file]，並把同一行 append 到結果檔（路徑啟動時印出；中途被停掉已寫的會保留）。
// FAKE = true 時不載入模型，用假的生成函式跑整條流程（只用來驗證進度與結果檔，不算量測）。
return (async () => {
    const fa = window.fa;
    const FAKE = false;
    const MODEL_ID = 'qwen3-0.6b';
    const N = 8;
    const REFLECT_TASKS = 3, REFLECT_RUNS = 3;
    const SEED = 20261104;
    const OUT_DIR = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\colu-real-out';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const OUT = OUT_DIR + '\\run-' + stamp + (FAKE ? '-fake' : '') + '.jsonl';
    const R = { model: MODEL_ID, n_per_group: N, fake: FAKE, out_file: OUT };
    const model = FaVlm.byId(MODEL_ID);
    const T0 = Date.now();
    const lines = [];
    const tag = (s) => console.log('[eval-file] ' + s);
    const persist = async (obj) => {
        lines.push(JSON.stringify(obj));
        try { await window.desktopAPI.rawfs.mkdir(OUT_DIR); await window.desktopAPI.rawfs.writeFile(OUT, { text: lines.join('\n') + '\n' }); } catch (e) { tag('結果檔寫入失敗：' + ((e && e.message) || e)); }
    };
    await persist({ event: 'start', out: OUT, fake: FAKE, n_per_group: N, reflect_tasks: REFLECT_TASKS, reflect_runs: REFLECT_RUNS });

    // ---- 1. 裝置與載入 ----
    let cpuCap = 60000;
    if (!FAKE) {
        const gpu = await fa._omGpuInfo(true);
        const dev = FaVlm.resolveDevice(model, fa._omDevicePrefOf(model), gpu.available, gpu.f16);
        R.gpu = { available: !!gpu.available, f16: !!gpu.f16 }; R.device_order = dev.order; R.device_reason = dev.reason || null;
        const t0 = Date.now(); let ld = null; const loadLog = [];
        try {
            ld = await fa._vlmEnsureLoaded(model, dev.order, () => {}, (s) => loadLog.push(String(s).slice(0, 120)));
            R.load = { ok: true, device: ld.device, ms: Date.now() - t0, tried: ld.tried || null, log: loadLog.slice(-4) };
        } catch (e) { R.load = { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }; await persist({ event: 'load_failed', error: R.load.error }); return R; }
        R.device = ld.device;
    } else { R.device = 'fake'; R.load = { ok: true, fake: true }; }
    const thinkPlan = FaRecipe.thinkingPlan({ modelId: MODEL_ID, stage: 'plan', contextTokens: model.contextTokens, enabled: true });
    const onCap = R.device === 'webgpu' ? thinkPlan.timeoutMs : cpuCap; // 思考開的逾時：WebGPU 用產品值，CPU 用量測上限
    R.plan_budget = { maxTokens: thinkPlan.maxTokens, timeoutMs_product: thinkPlan.timeoutMs, timeoutMs_used: onCap, contextTokens: model.contextTokens };
    const OFF_MAX = 160; // 同 jsonStep 的預設 maxTokens
    // 估計上限：每題最多等 逾時上限；反思每次最多 15 秒
    const calls = N * 4 + REFLECT_TASKS * REFLECT_RUNS;
    const est = (N * 2) * onCap + (N * 2) * cpuCap + REFLECT_TASKS * REFLECT_RUNS * 15000;
    R.estimate = { total_questions: calls, upper_bound_ms: est, upper_bound_min: Math.round(est / 60000) };
    tag('總題數 ' + calls + '（封閉 ' + N + '×2 組、計畫 ' + N + '×2 組、反思 ' + REFLECT_TASKS + '×' + REFLECT_RUNS + '）；預估上限時間 ' + R.estimate.upper_bound_min + ' 分鐘（思考開逾時 ' + Math.round(onCap / 1000) + ' 秒）');
    tag('結果檔：' + OUT);
    await persist({ event: 'plan', total_questions: calls, upper_bound_min: R.estimate.upper_bound_min, device: R.device, timeoutMs_thinking: onCap });

    // ---- 2. 生成包裝 ----
    const fakeReply = (messages) => {
        const sys = String(messages[0].content);
        if (/檢查一個計畫有沒有缺口/.test(sys)) return '{"gap":false,"note":""}';
        if (/選出最符合需求/.test(String(messages[messages.length - 1].content)) || /choice/.test(String(messages[messages.length - 1].content))) return '{"choice":1}';
        return '{"answer":"A"}';
    };
    async function gen(messages, maxTokens, enableThinking, timeoutMs) {
        const t = Date.now(); let raw = ''; let err = null;
        try {
            if (FAKE) raw = (enableThinking ? '<think>假的思考</think>' : '') + fakeReply(messages);
            else raw = await fa._llmGenerate(model, { messages, maxTokens, enableThinking, timeoutMs }, {});
        } catch (e) { err = String((e && e.message) || e); }
        const ms = Date.now() - t; const text = String(raw == null ? '' : raw); const st = FaRecipe.stripThink(text);
        const tagState = /<think(?:ing)?>/i.test(text) ? 'tagged' : (/<\/think(?:ing)?>/i.test(text) ? 'closing_only' : 'none');
        return { answer: st.answer, think_chars: st.reasoning.length, unclosed: st.unclosed, tag_state: tagState, ms, err, device: FAKE ? 'fake' : ((fa._omLastDevice || {})[MODEL_ID] || null) };
    }
    const refGen = (req) => FAKE ? Promise.resolve((req.enableThinking ? '<think>假的思考</think>' : '') + fakeReply(req.messages)) : fa._llmGenerate(model, { messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking, timeoutMs: req.timeoutMs }, {});

    // ---- 3. 題目 ----
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    function closedQuestions() {
        const r = rng(SEED); const out = [];
        for (let i = 0; i < N; i++) {
            let q, ans; const k = i % 4;
            if (k === 0) { const a = 11 + Math.floor(r() * 38), b = 11 + Math.floor(r() * 38); ans = a * b; q = a + ' × ' + b + ' 等於多少？'; }
            else if (k === 1) { const a = 100 + Math.floor(r() * 900), b = 7 + Math.floor(r() * 13); ans = a % b; q = a + ' 除以 ' + b + ' 的餘數是多少？'; }
            else if (k === 2) { let x = 1 + Math.floor(r() * 5); const seq = [x]; for (let j = 0; j < 3; j++) { x = 2 * x + 1; seq.push(x); } ans = 2 * x + 1; q = '數列 ' + seq.join(', ') + ', ... 的下一個數是多少？（規律：每一項是前一項的 2 倍加 1）'; }
            else { const a = 2 + Math.floor(r() * 8), b = 2 + Math.floor(r() * 8), c = 2 + Math.floor(r() * 8), d = 1 + Math.floor(r() * 9); ans = (a + b) * c - d; q = '(' + a + ' + ' + b + ') × ' + c + ' − ' + d + ' 等於多少？'; }
            const opts = [ans]; while (opts.length < 4) { const cand = ans + (Math.floor(r() * 19) - 9); if (cand > 0 && opts.indexOf(cand) < 0) opts.push(cand); }
            for (let j = opts.length - 1; j > 0; j--) { const m = Math.floor(r() * (j + 1)); [opts[j], opts[m]] = [opts[m], opts[j]]; }
            out.push({ id: 'c' + i, text: q + '\nA. ' + opts[0] + '　B. ' + opts[1] + '　C. ' + opts[2] + '　D. ' + opts[3], letter: 'ABCD'[opts.indexOf(ans)] });
        }
        return out;
    }
    const CQ = closedQuestions();
    const closedMsgs = (q) => [{ role: 'system', content: '你是答題助手。只回 JSON，不要多說話。' }, { role: 'user', content: q.text + '\n只回這個格式：{"answer":"字母"}' }];
    function parseLetter(answer) {
        const m = String(answer || '').match(/\{[^{}]*\}/); if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o.answer === 'string') return o.answer.trim().toUpperCase().slice(0, 1); } catch (_) { /* 往下 */ } }
        const l = String(answer || '').match(/\b([A-D])\b/); return l ? l[1] : null;
    }
    await fa._unitCatalogStoreLoad();
    const M = FaCatalogMatrix.buildMatrix(fa._unitCatalogBuild());
    const mk = FaColuBench.makeTasks(M, { n: N, seed: SEED });
    const PT = mk.tasks.filter((t) => t.options).slice(0, N);
    R.plan_tasks = { made: mk.tasks.length, with_options: PT.length, skipped: mk.skipped || null, reason: mk.reason || null, units: M.units.length };
    if (PT.length < N) tag('注意：計畫題只有 ' + PT.length + ' 題（要 ' + N + ' 題）');
    const planMsgs = (task) => { const p = FaColuBench.buildPrompt(task, 'assisted'); return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]; };
    const closedGrader = (q, g) => { const l = parseLetter(g.answer); return { parsed: !!l, ok: l === q.letter, reason: l ? '' : '格式不對' }; };
    const planGrader = (task, g) => { if (FAKE) return { parsed: true, ok: true, reason: 'fake' }; const x = FaColuBench.grade(M, task, g.answer, 'assisted'); return { parsed: x.parsed, ok: !!x.ok, reason: x.reason }; };

    // ---- 4. 跑一組（逐題印進度＋寫結果檔）----
    async function runGroup(name, items, mkMsgs, grader, opts) {
        const rows = []; const tStart = Date.now(); const limit = opts.timeoutMs;
        tag(name + ' 開始：' + items.length + ' 題，逾時上限 ' + Math.round(limit / 1000) + ' 秒');
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const g = await gen(mkMsgs(it), opts.maxTokens, opts.think, limit);
            const r = grader(it, g);
            const row = { id: it.id, ok: r.ok, parsed: r.parsed, ms: g.ms, device: g.device, think_chars: g.think_chars, unclosed: g.unclosed, tag_state: g.tag_state, err: g.err, timeout: g.ms >= limit - 500 && !r.parsed, reason: r.reason || '' };
            rows.push(row);
            const result = row.ok ? '正確' : (row.timeout ? '逾時' : (row.parsed ? '錯誤' : '格式不對'));
            tag(name.split(' ')[0] + ' ' + (i + 1) + '/' + items.length + ' 耗時=' + g.ms + 'ms 結果=' + result);
            await persist({ event: 'q', group: name.split(' ')[0], i: i + 1, n: items.length, ...row, result });
        }
        const okN = rows.filter((x) => x.ok).length; const cum = Math.round((Date.now() - tStart) / 1000);
        tag(name + ' 結束：' + okN + '/' + rows.length + '，本組耗時 ' + cum + ' 秒，累計已跑 ' + Math.round((Date.now() - T0) / 1000) + ' 秒');
        await persist({ event: 'group_end', group: name.split(' ')[0], ok: okN, n: rows.length, group_sec: cum, total_sec: Math.round((Date.now() - T0) / 1000) });
        return rows;
    }
    const thinkOpts = { maxTokens: thinkPlan.maxTokens, think: true, timeoutMs: onCap };
    const offOpts = { maxTokens: OFF_MAX, think: false, timeoutMs: cpuCap };

    const G = {};
    G.closed_off = await runGroup('G1 封閉題・思考關', CQ, closedMsgs, closedGrader, offOpts);
    G.closed_on = await runGroup('G2 封閉題・思考開', CQ, closedMsgs, closedGrader, thinkOpts);
    G.plan_off = await runGroup('G3 計畫題・思考關', PT, planMsgs, planGrader, offOpts);
    G.plan_on = await runGroup('G4 計畫題・思考開', PT, planMsgs, planGrader, thinkOpts);

    // ---- 5. 反思穩定度 ----
    const refRows = [];
    const refTasks = PT.slice(0, REFLECT_TASKS);
    for (let ti = 0; ti < refTasks.length; ti++) {
        const task = refTasks[ti];
        const question = task.need + '\n計畫步驟：' + task.intended.map((id) => { const c = task.candidates.find((x) => x.id === id); return c ? c.name : id; }).join(' → ');
        const runs = [];
        for (let k = 0; k < REFLECT_RUNS; k++) {
            const t = Date.now(); const r = await FaRecipe.coluThinkReflect({ generate: refGen, modelId: MODEL_ID, contextTokens: model.contextTokens, enabled: true, question });
            runs.push({ gap: r.gap, ok: !!r.ok, ms: Date.now() - t, skipped: !!r.skipped });
            tag('R 題' + (ti + 1) + '/' + refTasks.length + ' 第' + (k + 1) + '次 耗時=' + (Date.now() - t) + 'ms 有缺口=' + r.gap + ' 合格=' + !!r.ok);
            await persist({ event: 'reflect', task: ti + 1, run: k + 1, ms: Date.now() - t, gap: r.gap, ok: !!r.ok });
        }
        refRows.push({ id: task.id, runs, consistent: runs.every((x) => x.ok) && runs.every((x) => x.gap === runs[0].gap), all_ok: runs.every((x) => x.ok) });
    }

    // ---- 6. 彙整 ----
    const stat = (rows) => {
        const n = rows.length; const ok = rows.filter((r) => r.ok).length; const ms = rows.map((r) => r.ms).sort((a, b) => a - b); const thk = rows.map((r) => r.think_chars).sort((a, b) => a - b);
        return {
            n, ok, acc: n ? Math.round((ok / n) * 100) / 100 : null,
            median_ms: ms.length ? ms[ms.length >> 1] : null, max_ms: ms.length ? ms[ms.length - 1] : null,
            over_30s: rows.filter((r) => r.ms > 30000).length, timeouts: rows.filter((r) => r.timeout).length,
            parse_fail: rows.filter((r) => !r.parsed).length, unclosed_think: rows.filter((r) => r.unclosed).length,
            think_chars_median: thk.length ? thk[thk.length >> 1] : null,
            tag_states: rows.reduce((o, r) => { o[r.tag_state] = (o[r.tag_state] || 0) + 1; return o; }, {}),
            errors: rows.filter((r) => r.err).length, devices: Array.from(new Set(rows.map((r) => r.device))),
        };
    };
    R.stats = {}; for (const k of Object.keys(G)) R.stats[k] = stat(G[k]);
    const fallbackAcc = (on, off) => { let ok = 0, triggers = 0; on.forEach((r, i) => { if (r.parsed) { if (r.ok) ok++; } else { triggers++; if (off[i] && off[i].ok) ok++; } }); return { triggers, ok, n: on.length, acc: on.length ? Math.round((ok / on.length) * 100) / 100 : null }; };
    R.fallback = { closed: fallbackAcc(G.closed_on, G.closed_off), plan: fallbackAcc(G.plan_on, G.plan_off) };
    const pair = (a, b) => { let won = 0, lost = 0, both = 0, neither = 0; a.forEach((r, i) => { const x = r.ok, y = b[i] && b[i].ok; if (x && !y) won++; else if (!x && y) lost++; else if (x && y) both++; else neither++; }); return { on_only_right: won, off_only_right: lost, both_right: both, both_wrong: neither }; };
    R.paired = { closed: pair(G.closed_on, G.closed_off), plan: pair(G.plan_on, G.plan_off) };
    R.reflect = {
        tasks: refRows.length, all_ok: refRows.filter((r) => r.all_ok).length, consistent: refRows.filter((r) => r.consistent).length,
        gap_true_runs: refRows.reduce((s, r) => s + r.runs.filter((x) => x.gap).length, 0), runs_total: refRows.length * REFLECT_RUNS,
        median_ms: (() => { const a = refRows.flatMap((r) => r.runs.map((x) => x.ms)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; })(),
    };
    R.elapsed_total_ms = Date.now() - T0;
    R.rows = G; R.reflect_rows = refRows;
    await persist({ event: 'done', stats: R.stats, fallback: R.fallback, paired: R.paired, reflect: R.reflect, elapsed_ms: R.elapsed_total_ms });
    tag('全部完成，總耗時 ' + Math.round(R.elapsed_total_ms / 1000) + ' 秒');
    return R;
})();
