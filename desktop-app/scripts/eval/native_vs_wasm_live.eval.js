// 原生 vs WASM 量測（交錯版）：WASM 端（真 Electron、桌面版 fa._llmGenerate 路徑）。
// 由 run_interleaved.js 逐題發號：讀取 live 資料夾的 turn.json，輪到 wasm 且題號相符才執行該題，寫 res-wasm-<i>.json。
// 題目與 native_vs_wasm.eval.js 相同（8 封閉題＋8 計畫題，seed 20261104，貪婪，思考關，最多 16 token）。
// 模型載入在開始發號前完成（載入時間不計入每題）。
return (async () => {
    const LIVE = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-live';
    const rf = async (p) => { try { const r = await window.desktopAPI.rawfs.readFile(p, 'utf8'); return typeof r === 'string' ? r : (r && r.text) || null; } catch (_) { return null; } };
    const wf = async (p, text) => { await window.desktopAPI.rawfs.writeFile(p, { text }); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const N = 8, SEED = 20261104, MAX_TOKENS = 16;
    const model = FaVlm.byId('qwen3-0.6b');
    const dev = await fa._coluDeviceOf({ model });
    const gres = FaVlm.resolveDevice(model, fa._omDevicePrefOf(model), (await fa._omGpuInfo()).available, (await fa._omGpuInfo()).f16);
    // 題目（與 native_vs_wasm.eval.js 同一程式）
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
    await fa._unitCatalogStoreLoad();
    const M = FaCatalogMatrix.buildMatrix(fa._unitCatalogBuild());
    const mk = FaColuBench.makeTasks(M, { n: N, seed: SEED });
    const PT = mk.tasks.filter((t) => t.options).slice(0, N);
    const planMsgs = (task) => { const p = FaColuBench.buildPrompt(task, 'assisted'); return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]; };
    const items = closedQuestions().map((q) => ({ id: q.id, group: 'closed', messages: closedMsgs(q) }))
        .concat(PT.map((t, i) => ({ id: 'p' + i, group: 'plan', messages: planMsgs(t) })));

    // 題目寫給原生端用（同一份輸入）
    await wf(LIVE + '\\prompts.json', JSON.stringify(items.map((x) => ({ id: x.id, group: x.group, messages: x.messages }))));

    // 模型先載入（不計入每題時間）
    const tl = Date.now();
    await fa._vlmEnsureLoaded(model, gres.order.length ? gres.order : ['wasm'], () => {}, () => {});
    const loadMs = Date.now() - tl;
    await wf(LIVE + '\\ready-wasm.txt', JSON.stringify({ load_ms: loadMs, device: dev && dev.device ? dev.device : dev, order: gres.order, at: new Date().toISOString() }));

    // 逐題聽命
    for (let i = 0; i < items.length; i++) {
        let turn = null;
        for (;;) {
            const t = await rf(LIVE + '\\turn.json');
            if (t) { try { turn = JSON.parse(t); } catch (_) { turn = null; } }
            if (turn && turn.who === 'stop') break;
            if (turn && turn.who === 'wasm' && turn.i === i) break;
            await wait(100);
        }
        if (turn && turn.who === 'stop') break;
        const it = items[i];
        const t0 = Date.now();
        let text = null, err = null;
        try { text = await fa._llmGenerate(model, { messages: it.messages, maxTokens: MAX_TOKENS, enableThinking: false, deterministic: true }, {}); }
        catch (e) { err = String((e && e.message) || e); }
        const ms = Date.now() - t0;
        await wf(LIVE + '\\res-wasm-' + i + '.json', JSON.stringify({ i, id: it.id, group: it.group, text: text == null ? null : String(text), ms, err }));
    }
    console.log('[eval-file] native_vs_wasm_live finished');
    return { finished: true, load_ms: loadMs };
})();
