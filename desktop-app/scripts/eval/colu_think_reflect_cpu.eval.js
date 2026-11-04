// CoLU+Thinking 階段 7 任務 D：CPU 反思重量測（真的 qwen3-0.6b，不假模型、不改工作目錄任何檔）。
// 只重跑反思：計畫題前 3 題，每題 3 次，共 9 次。逾時用 CPU 的反思值（thinkingPlan stage reflect device cpu，120 秒），不是量測用的假值。
// 走的路徑（真的桌面版程式）：
//   裝置：fa._coluDeviceOf（與產品同一條判斷）；載入：fa._vlmEnsureLoaded（模型已快取，不下載）
//   生成：fa._llmGenerate（真工作者、真串流、真逾時、硬性上限）
//   反思：FaRecipe.coluThinkReflect（含 jsonStep 退路）
// 進度：每次反思跑完印一行 [eval-file]，並把同一行 append 到結果檔（路徑啟動時印出）。
// 用法（背景執行，見階段 7 記錄）：不用 run_eval.js（它有 170 秒上限，這次要跑約 20 分鐘）。
return (async () => {
    const fa = window.fa;
    const MODEL_ID = 'qwen3-0.6b';
    const N = 8, REFLECT_TASKS = 3, REFLECT_RUNS = 3;
    const SEED = 20261104;
    const OUT_DIR = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\colu-real-out';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const OUT = OUT_DIR + '\\reflect-cpu-' + stamp + '.jsonl';
    const R = { model: MODEL_ID, reflect_tasks: REFLECT_TASKS, reflect_runs: REFLECT_RUNS, out_file: OUT };
    const model = FaVlm.byId(MODEL_ID);
    const T0 = Date.now();
    const lines = [];
    const tag = (s) => console.log('[eval-file] ' + s);
    const persist = async (obj) => {
        lines.push(JSON.stringify(obj));
        try { await window.desktopAPI.rawfs.mkdir(OUT_DIR); await window.desktopAPI.rawfs.writeFile(OUT, { text: lines.join('\n') + '\n' }); } catch (e) { tag('結果檔寫入失敗：' + ((e && e.message) || e)); }
    };
    await persist({ event: 'start', out: OUT, reflect_tasks: REFLECT_TASKS, reflect_runs: REFLECT_RUNS });
    tag('結果檔：' + OUT);

    // ---- 1. 裝置與載入 ----
    const dev = await fa._coluDeviceOf({ model });
    const plan = FaRecipe.thinkingPlan({ modelId: MODEL_ID, stage: 'reflect', contextTokens: model.contextTokens, enabled: true, device: dev });
    R.device_used_for_timeout = dev; R.reflect_budget = { maxTokens: plan.maxTokens, timeoutMs: plan.timeoutMs, contextTokens: model.contextTokens };
    const gpu = await fa._omGpuInfo(true);
    const order = FaVlm.resolveDevice(model, fa._omDevicePrefOf(model), gpu.available, gpu.f16).order;
    const t0 = Date.now();
    try {
        const ld = await fa._vlmEnsureLoaded(model, order, () => {}, () => {});
        R.loaded = { ok: true, device: ld.device, ms: Date.now() - t0 };
    } catch (e) { R.loaded = { ok: false, error: String((e && e.message) || e) }; await persist({ event: 'load_failed', error: R.loaded.error }); return R; }
    tag('裝置（產品判斷）：' + dev + '；實際載入：' + R.loaded.device + '；反思逾時 ' + Math.round(plan.timeoutMs / 1000) + ' 秒；載入耗時 ' + R.loaded.ms + 'ms');
    await persist({ event: 'device', device_timeout: dev, loaded: R.loaded, reflect_timeoutMs: plan.timeoutMs, budget: plan.maxTokens });

    // ---- 2. 生成包裝（與階段 6 相同的反思請求）----
    const refGen = (req) => fa._llmGenerate(model, { messages: req.messages, maxTokens: req.maxTokens, prefill: req.prefill, enableThinking: req.enableThinking, timeoutMs: req.timeoutMs }, {});

    // ---- 3. 題目（與階段 6 相同的計畫題）----
    await fa._unitCatalogStoreLoad();
    const M = FaCatalogMatrix.buildMatrix(fa._unitCatalogBuild());
    const mk = FaColuBench.makeTasks(M, { n: N, seed: SEED });
    const PT = mk.tasks.filter((t) => t.options).slice(0, N);
    const refTasks = PT.slice(0, REFLECT_TASKS);
    R.plan_tasks = { with_options: PT.length, used: refTasks.length };
    if (refTasks.length < REFLECT_TASKS) tag('注意：計畫題只有 ' + refTasks.length + ' 題（要 ' + REFLECT_TASKS + ' 題）');

    // ---- 4. 反思（逐次進度）----
    const rows = [];
    for (let ti = 0; ti < refTasks.length; ti++) {
        const task = refTasks[ti];
        const question = task.need + '\n計畫步驟：' + task.intended.map((id) => { const c = task.candidates.find((x) => x.id === id); return c ? c.name : id; }).join(' → ');
        for (let k = 0; k < REFLECT_RUNS; k++) {
            const t = Date.now();
            const r = await FaRecipe.coluThinkReflect({ generate: refGen, modelId: MODEL_ID, contextTokens: model.contextTokens, enabled: true, device: dev, question });
            const ms = Date.now() - t;
            const row = { task: ti + 1, run: k + 1, ms, valid: !!r.ok, gap: r.gap, skipped: !!r.skipped, timeout: !r.ok && /逾時/.test(String(r.error || '')), error: r.ok ? null : (r.error || null), reasoning_chars: String(r.reasoning || '').length };
            rows.push(row);
            tag('R 題' + (ti + 1) + '/' + refTasks.length + ' 第' + (k + 1) + '次 耗時=' + ms + 'ms 有效=' + row.valid + ' 有缺口=' + row.gap + (row.timeout ? ' 逾時' : '') + (row.error && !row.timeout ? ' 錯誤=' + row.error : ''));
            await persist({ event: 'reflect', ...row, elapsed_total_s: Math.round((Date.now() - T0) / 1000) });
        }
    }

    // ---- 5. 彙整 ----
    const valid = rows.filter((x) => x.valid).length;
    const perTask = [];
    for (let ti = 0; ti < refTasks.length; ti++) {
        const rs = rows.filter((x) => x.task === ti + 1);
        const allValid = rs.length === REFLECT_RUNS && rs.every((x) => x.valid);
        const sameGap = allValid && rs.every((x) => x.gap === rs[0].gap);
        perTask.push({ task: ti + 1, valid_runs: rs.filter((x) => x.valid).length, all_valid: allValid, consistent: sameGap, gaps: rs.map((x) => x.gap) });
    }
    const ms = rows.map((x) => x.ms).sort((a, b) => a - b);
    R.summary = {
        runs_total: rows.length, valid_runs: valid, timeouts: rows.filter((x) => x.timeout).length,
        consistent_tasks: perTask.filter((x) => x.consistent).length, tasks: perTask.length,
        per_task: perTask, ms_each: rows.map((x) => x.ms), median_ms: ms.length ? ms[ms.length >> 1] : null, max_ms: ms.length ? ms[ms.length - 1] : null,
        elapsed_total_s: Math.round((Date.now() - T0) / 1000),
    };
    R.rows = rows;
    await persist({ event: 'done', summary: R.summary });
    tag('全部完成：有效 ' + valid + '/' + rows.length + '，一致 ' + R.summary.consistent_tasks + '/' + perTask.length + '，總耗時 ' + R.summary.elapsed_total_s + ' 秒');
    return R;
})();
