'use strict';
/* LLM 模型匯出（UMD，純函式；不下載、不碰檔案系統、不自己 spawn，執行器由呼叫端注入）。
 * 設計見 DESIGN.lora-training.md §25（路徑 A：合併 → ONNX q8 或 GGUF Q8_0 → 核對 → 寫 manifest）。
 *   EXPORT_PLANS[format]            ONNX q8／GGUF q8_0 的五步（每一步要的工具）
 *   exportPlan(format, toolsState)  把步驟表套上工具狀態：每一步是「缺工具」或「待做」
 *   exportAvailability(toolsState)  格式是否可用，與不可用的具體原因（缺哪些工具）
 *   probeExportTools(detect)        工具偵測（detect 由呼叫端注入：name → { found, version?, reason? }）
 *   buildStepCommands(format, o)    每一步要執行的命令（argv 陣列，不經過 shell）；o 見函式註解
 *   runExportSteps(cmds, runner)    依序執行（runner 注入：argv → Promise<{code, stdout, stderr}>），遇錯停止
 *   parseStepResult(stdout)         取出執行器印的最後一行 JSON（{"step":…,"ok":…}）
 *   LLM_TRAIN_MODES / trainModePlan(mode)   訓練模式（LoRA 與完整微調都有腳本；完整微調只跑過 smoke）
 * 原則：工具沒找到就標「缺工具」，不假裝可用；執行器失敗就照實回報，不吞錯誤。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioLlmExport = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    // 工具名稱（detect 與 toolsState 用的鍵）
    const TOOLS = {
        optimum: 'optimum-cli（匯出用的 Python 環境，.venv-export）',
        onnxruntime: 'onnxruntime（匯出用的 Python 環境，.venv-export）',
        llamaCpp: 'llama.cpp（convert_hf_to_gguf.py、llama-quantize、llama-server）',
        peft: 'peft（合併用的 Python 環境，.venv）'
    };
    // 每一步：tool 是需要的工具（null＝不需外部工具）；runner 為 true 表示執行器腳本存在
    const EXPORT_PLANS = {
        onnx: { format: 'onnx', label: 'ONNX', quant: 'q8', steps: [
            { id: 'merge', label: '把 LoRA 併回基底權重', tool: 'peft', runner: true, script: 'merge_and_export.py' },
            { id: 'convert', label: '匯出 ONNX fp32（optimum-cli export onnx）', tool: 'optimum', runner: true, script: 'export_onnx.py' },
            { id: 'quantize', label: '動態量化 q8（onnxruntime，預設 full）', tool: 'onnxruntime', runner: true, script: 'export_onnx.py' },
            { id: 'verify', label: '核對：與 HF（PyTorch）比對首步 logits 與貪婪 token', tool: 'optimum', runner: true, script: 'export_onnx.py' },
            { id: 'pack', label: '寫 manifest（sha256）', tool: null, runner: true, script: 'export_onnx.py' }
        ] },
        gguf: { format: 'gguf', label: 'GGUF', quant: 'q8_0', steps: [
            { id: 'merge', label: '把 LoRA 併回基底權重', tool: 'peft', runner: true, script: 'merge_and_export.py' },
            { id: 'convert', label: '轉成 GGUF f16（llama.cpp 的 convert_hf_to_gguf.py）', tool: 'llamaCpp', runner: true, script: 'export_gguf.py' },
            { id: 'quantize', label: '量化 Q8_0（llama-quantize）', tool: 'llamaCpp', runner: true, script: 'export_gguf.py' },
            { id: 'verify', label: '核對：llama-server 貪婪 token 與 HF 比對', tool: 'llamaCpp', runner: true, script: 'export_gguf.py' },
            { id: 'pack', label: '寫 manifest（sha256）', tool: null, runner: true, script: 'export_gguf.py' }
        ] }
    };
    const FORMATS = Object.keys(EXPORT_PLANS);

    // toolsState：{ optimum: {found}, onnxruntime: {found}, llamaCpp: {found}, peft: {found} }；缺的鍵視為沒找到
    const has = (ts, name) => !!(ts && ts[name] && ts[name].found);

    function stepState(step, ts) {
        if (step.tool && !has(ts, step.tool)) return { state: '缺工具', blocker: '需要 ' + TOOLS[step.tool] + '；這台還沒找到' };
        if (!step.runner) return { state: '尚未實作', blocker: '執行器尚未寫' };
        return { state: '待做', blocker: '' };
    }

    function exportPlan(format, toolsState) {
        const P = EXPORT_PLANS[format];
        if (!P) return { ok: false, error: 'format 必須是 ' + FORMATS.join('／') + '，收到 ' + JSON.stringify(format) };
        const steps = P.steps.map((s) => Object.assign({ id: s.id, label: s.label, tool: s.tool }, stepState(s, toolsState)));
        const blockers = steps.filter((s) => s.state !== '待做').map((s) => s.label + '：' + s.state + '（' + s.blocker + '）');
        return { ok: true, format: P.format, label: P.label, quant: P.quant, steps, ready: blockers.length === 0, blockers };
    }

    function exportAvailability(toolsState) {
        const out = {};
        FORMATS.forEach((f) => {
            const plan = exportPlan(f, toolsState);
            const missing = plan.steps.filter((s) => s.state === '缺工具').map((s) => s.tool);
            const notBuilt = plan.steps.filter((s) => s.state === '尚未實作');
            const available = plan.ready;
            let reason = '';
            if (!available) {
                if (missing.length) reason = '缺工具：' + Array.from(new Set(missing)).map((t) => TOOLS[t]).join('、');
                else reason = '匯出執行器尚未實作（' + notBuilt.map((s) => s.label).join('；') + '）';
            }
            out[f] = { available, format: f, quant: plan.quant, reason, missingTools: Array.from(new Set(missing)) };
        });
        return out;
    }

    // 偵測：detect 由呼叫端注入（主行程用檔案存在與 python -c import 檢查）；沒有 detect 就全部視為沒找到
    function probeExportTools(detect) {
        const names = Object.keys(TOOLS), state = {};
        names.forEach((n) => {
            let r = null;
            try { r = typeof detect === 'function' ? detect(n) : null; } catch (e) { r = { found: false, reason: String((e && e.message) || e) }; }
            state[n] = r && r.found ? { found: true, version: r.version || null, path: r.path || null } : { found: false, reason: (r && r.reason) || '沒有偵測函式或沒找到' };
        });
        return state;
    }

    // 給 pipeline_routes_core 的 exportCaps：{onnxExport, ggufExport}
    function exportCapsFrom(toolsState) {
        const av = exportAvailability(toolsState || {});
        return { onnxExport: !!av.onnx.available, ggufExport: !!av.gguf.available };
    }

    /* buildStepCommands(format, o)：回 {ok, steps:[{id, label, argv}]} 或 {ok:false, error}
     * o: { pyTrain（merge 用）, pyExport（ONNX／GGUF 的 Python）, scriptsDir（lora-train 資料夾）, baseDir（基底 HF）,
     *      adapterDir（PEFT adapter）, workDir（合併後與各格式產物的根目錄）, outDir（本次格式的輸出資料夾）,
     *      llamaDir（含 llama-quantize／llama-server 的 bin）, llamaSrc（llama.cpp 原始碼根，convert 用）, recipe（full｜mixed，ONNX 用） }
     * 合併後的權重放 workDir/merged（所有格式共用）。argv[0] 是 Python 或工具路徑；路徑一律是字串、不經 shell。 */
    function buildStepCommands(format, o) {
        const P = EXPORT_PLANS[format];
        if (!P) return { ok: false, error: '未知格式 ' + JSON.stringify(format) };
        o = o || {};
        const need = (k) => (o[k] ? null : '缺 ' + k);
        const missing = (format === 'onnx' ? ['pyTrain', 'pyExport', 'scriptsDir', 'baseDir', 'adapterDir', 'workDir', 'outDir'] : ['pyTrain', 'pyExport', 'scriptsDir', 'baseDir', 'adapterDir', 'workDir', 'outDir', 'llamaDir', 'llamaSrc'])
            .map(need).filter(Boolean);
        if (missing.length) return { ok: false, error: missing.join('；') };
        const join = (dir, f) => String(dir).replace(/[\\/]+$/, '') + '/' + f;
        const merged = join(o.workDir, 'merged');
        const recipe = o.recipe || 'full';
        const onnx = format === 'onnx';
        const py = o.pyExport; // 匯出步驟都用匯出環境（.venv-export）
        const script = join(o.scriptsDir, onnx ? 'export_onnx.py' : 'export_gguf.py');
        const steps = P.steps.map((s) => {
            let argv;
            if (s.id === 'merge') argv = [o.pyTrain, join(o.scriptsDir, 'merge_and_export.py'), '--base_dir', o.baseDir, '--adapter_dir', o.adapterDir, '--output_dir', merged];
            else if (onnx) {
                const base = [py, script, '--step', s.id, '--out', o.outDir, '--recipe', recipe];
                if (s.id === 'pack') base.push('--tokenizer', o.baseDir, '--model', merged);
                if (s.id === 'convert' || s.id === 'verify') base.push('--model', merged);
                if (s.id === 'convert' || s.id === 'verify') base.push('--tokenizer', o.baseDir);
                argv = base;
            } else {
                const base = [py, script, '--step', s.id, '--out', o.outDir];
                if (s.id === 'convert') base.push('--model', merged, '--tokenizer', o.baseDir, '--llama_src', o.llamaSrc);
                if (s.id === 'verify' || s.id === 'pack') base.push('--model', merged, '--tokenizer', o.baseDir);
                if (s.id === 'convert' || s.id === 'quantize' || s.id === 'verify') base.push('--llama_dir', o.llamaDir);
                argv = base;
            }
            return { id: s.id, label: s.label, argv };
        });
        return { ok: true, format, steps };
    }

    // 執行器印的最後一行 JSON（{"step":…,"ok":…}）；找不到回 null
    function parseStepResult(stdout) {
        const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
        for (let i = lines.length - 1; i >= 0; i--) {
            try { const j = JSON.parse(lines[i]); if (j && typeof j === 'object' && 'ok' in j && 'step' in j) return j; } catch (e) { /* 不是我們的行 */ }
        }
        return null;
    }

    /* runExportSteps(cmds, runner, opts)：依序執行；runner(argv, id) → Promise<{code, stdout, stderr}>（可能丟例外）。
     * 任一步失敗就停止（後面的步驟標「未執行」）。
     * opts.onEvent(e)：每步開始／結束時呼叫。
     * opts.skip：Set（步驟 id），在裡面的步驟不執行，標「略過（已完成）」（續跑用）。
     * opts.isStopRequested()：每一步開始前檢查；要求停止（暫停或取消）就不再開新步驟，剩下的標「未執行」，回傳 stopped:true。 */
    async function runExportSteps(cmds, runner, opts) {
        const onEvent = (opts && opts.onEvent) || (() => {});
        const skip = (opts && opts.skip) || new Set();
        const stopReq = (opts && opts.isStopRequested) || (() => false);
        const steps = [];
        let failedAt = null, stopped = false;
        for (let i = 0; i < cmds.steps.length; i++) {
            const s = cmds.steps[i];
            if (failedAt !== null || stopped) { steps.push({ id: s.id, label: s.label, state: '未執行' }); continue; }
            if (skip.has(s.id)) { steps.push({ id: s.id, label: s.label, state: '略過（已完成）' }); onEvent({ type: 'step-skip', id: s.id }); continue; }
            if (stopReq()) { stopped = true; steps.push({ id: s.id, label: s.label, state: '未執行' }); continue; }
            onEvent({ type: 'step-start', id: s.id, label: s.label });
            let r;
            try { r = await runner(s.argv, s.id); } catch (e) { r = { code: -1, stdout: '', stderr: String((e && e.message) || e) }; }
            const j = parseStepResult(r && r.stdout);
            const ok = !!(r && r.code === 0 && j && j.ok === true);
            // 被要求停止時中斷的步驟不是失敗：標「中斷」，之後的步驟不再開始
            const interrupted = !ok && stopReq();
            const rec = { id: s.id, label: s.label, state: ok ? '完成' : (interrupted ? '中斷' : '失敗'), code: r ? r.code : -1, result: j,
                error: ok ? '' : ((j && j.error) || String((r && r.stderr) || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || '沒有輸出（退出碼 ' + (r ? r.code : '?') + '）') };
            steps.push(rec);
            onEvent({ type: 'step-end', id: s.id, state: rec.state, error: rec.error });
            if (interrupted) stopped = true;
            else if (!ok) failedAt = s.id;
        }
        const done = steps.filter((x) => x.state === '完成' || x.state === '略過（已完成）').map((x) => x.id);
        return { ok: failedAt === null && !stopped, stopped, format: cmds.format, failedAt, steps, done };
    }

    // 訓練模式：LoRA 已實作（cpu-py／wasm-web）；完整微調有腳本（train_full.py），只跑過 smoke
    const LLM_TRAIN_MODES = [
        { id: 'lora', label: 'LoRA 微調', implemented: true, note: '沿用 LoRA 訓練（cpu-py；網頁版 wasm-web）' },
        { id: 'full', label: '完整微調', implemented: true, note: 'lora-train/train_full.py（CPU、fp32，約 10 GB 記憶體，3–4 步 smoke 已跑）；沒有做品質訓練，輸出可走匯出流程' }
    ];
    function trainModePlan(mode) {
        const m = LLM_TRAIN_MODES.find((x) => x.id === mode);
        if (!m) return { ok: false, error: '訓練模式必須是 ' + LLM_TRAIN_MODES.map((x) => x.id).join('／') + '，收到 ' + JSON.stringify(mode) };
        return { ok: true, mode: m.id, label: m.label, implemented: m.implemented, note: m.note, blocker: m.implemented ? '' : (m.blocker || '') };
    }

    return { TOOLS, EXPORT_PLANS, FORMATS, exportPlan, exportAvailability, probeExportTools, exportCapsFrom, buildStepCommands, parseStepResult, runExportSteps, LLM_TRAIN_MODES, trainModePlan };
}));
