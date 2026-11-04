// 原生執行器階段 6：WASM 對照（真 Electron，桌面版既有的 fa._llmGenerate 路徑）。
// 題目沿用 colu 量測的做法：8 封閉題（rng 種子 20261104，與 colu_think_real.eval.js 相同的出題程式）＋8 計畫題（FaColuBench.makeTasks）。
// 每題：貪婪解碼（deterministic）、思考關、最多 16 個新 token；逐題輸出進度並寫入結果檔；總時間上限 10 分鐘。
// 結果檔：%TEMP%\nvw-out\wasm-t1-<時間戳>.jsonl（每行一題，欄位 id、text、ms、device、err）。
// 用法（隔離 profile，不用 run_eval 的全新資料夾，因為模型要用快取）：
//   FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17946 electron.exe <repo> --user-data-dir=%TEMP%\colu-real-ud --no-sandbox --disable-gpu，並設 FA_DEBUG_EVAL_FILE=<本檔>
return (async () => {
    fa.advancedSettings.offlineMaxCpuCores = 1; fa._vlmTerminate();
    const R = { items: [], device: null };
    const OUT_DIR = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-out';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const OUT = OUT_DIR + '\\wasm-' + stamp + '.jsonl';
    const lines = [];
    const persist = async (obj) => {
        lines.push(JSON.stringify(obj));
        try { await window.desktopAPI.rawfs.mkdir(OUT_DIR); await window.desktopAPI.rawfs.writeFile(OUT, { text: lines.join('\n') + '\n' }); } catch (e) { console.log('[eval-file] 寫入失敗 ' + ((e && e.message) || e)); }
    };
    R.out_file = OUT;
    const N = 8, SEED = 20261104, MAX_TOKENS = 16, BUDGET_MS = 10 * 60 * 1000;
    const T0 = Date.now();
    const model = FaVlm.byId('qwen3-0.6b');
    R.device = await fa._coluDeviceOf({ model });

    // 8 封閉題（與 colu_think_real.eval.js 相同的出題程式）
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
            out.push({ id: 'c' + i, text: q + '\nA. ' + opts[0] + '　B. ' + opts[1] + '　C. ' + opts[2] + '　D. ' + opts[3] });
        }
        return out;
    }
    const closedMsgs = (q) => [{ role: 'system', content: '你是答題助手。只回 JSON，不要多說話。' }, { role: 'user', content: q.text + '\n只回這個格式：{"answer":"字母"}' }];

    // 8 計畫題（與 colu 相同的產生器）
    await fa._unitCatalogStoreLoad();
    const M = FaCatalogMatrix.buildMatrix(fa._unitCatalogBuild());
    const mk = FaColuBench.makeTasks(M, { n: N, seed: SEED });
    const PT = mk.tasks.filter((t) => t.options).slice(0, N);
    const planMsgs = (task) => { const p = FaColuBench.buildPrompt(task, 'assisted'); return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]; };

    const items = closedQuestions().map((q) => ({ id: q.id, group: 'closed', messages: closedMsgs(q) }))
        .concat(PT.map((t, i) => ({ id: 'p' + i, group: 'plan', messages: planMsgs(t) })));
    R.prompt_count = items.length;
    // 題目（messages）也寫下來，讓原生端用完全相同的輸入
    try { await window.desktopAPI.rawfs.mkdir(OUT_DIR); await window.desktopAPI.rawfs.writeFile(OUT_DIR + '\\prompts-' + stamp + '.json', { text: JSON.stringify(items.map((x) => ({ id: x.id, group: x.group, messages: x.messages })), null, 1) }); R.prompts_file = OUT_DIR + '\\prompts-' + stamp + '.json'; } catch (e) { console.log('[eval-file] prompts 寫入失敗 ' + ((e && e.message) || e)); }

    for (const it of items) {
        if (Date.now() - T0 > BUDGET_MS) { R.stopped_by_budget = true; break; }
        const t = Date.now();
        let text = null, err = null;
        try { text = await fa._llmGenerate(model, { messages: it.messages, maxTokens: MAX_TOKENS, enableThinking: false, deterministic: true }, {}); }
        catch (e) { err = String((e && e.message) || e); }
        const ms = Date.now() - t;
        const row = { id: it.id, group: it.group, text: text == null ? null : String(text), ms, device: R.device && R.device.device ? R.device.device : R.device, err, js_heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
        R.items.push(row);
        await persist(row);
        console.log('[eval-file] ' + it.id + ' ' + ms + ' 毫秒 ' + (err ? '錯誤 ' + err : ''));
    }
    R.total_ms = Date.now() - T0;
    R.count_done = R.items.length;
    console.log('[eval-file] native_vs_wasm_t1 wasm ' + JSON.stringify({ out: OUT, done: R.count_done, total_ms: R.total_ms, device: R.device }));
    return { out: OUT, done: R.count_done, total_ms: R.total_ms, device: R.device, stopped: !!R.stopped_by_budget };
})();
