'use strict';
/* LLM 模型匯出（純函式，不執行任何轉換、不下載、不碰檔案）。設計見 DESIGN.TODO.offline-training-studio.md §20。
 *   EXPORT_PLANS[format]            ONNX q8／GGUF q8_0 的步驟表（每一步要的工具、是否已有執行器、阻礙）
 *   exportPlan(format, toolsState)  把步驟表套上工具狀態：每一步是「尚未實作」「缺工具」或「待做」
 *   exportAvailability(toolsState)  格式是否可用，與不可用的具體原因（缺工具／執行器尚未實作）
 *   probeExportTools(detect)        工具偵測（detect 由呼叫端注入：name → { found, version?, reason? }）
 *   LLM_TRAIN_MODES / trainModePlan(mode)   訓練模式（LoRA 已實作；完整微調尚未實作，寫明阻礙）
 * 原則：執行器沒寫的步驟一律標「尚未實作」，即使工具找到也不宣稱可用。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioLlmExport = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    // 工具名稱（detect 與 toolsState 用的鍵）
    const TOOLS = { optimum: 'optimum（HuggingFace 的 ONNX 匯出）', onnxruntime: 'onnxruntime（量化）', llamaCpp: 'llama.cpp（GGUF 轉換與量化）' };
    // 每個格式的步驟：tool 為 null 表示不需外部工具。runner 為 false 表示執行器還沒寫（不論工具在不在）
    const EXPORT_PLANS = {
        onnx: { format: 'onnx', label: 'ONNX', quant: 'q8', steps: [
            { id: 'merge', label: '把 LoRA 併入基底權重', tool: null, runner: false, blocker: '合併器（lora_merge_core.js）存在，但還沒串成匯出流程' },
            { id: 'convert', label: '匯出 ONNX（optimum-cli export onnx）', tool: 'optimum', runner: false, blocker: '匯出執行器尚未寫' },
            { id: 'quantize', label: '動態量化 q8（onnxruntime）', tool: 'onnxruntime', runner: false, blocker: '量化執行器尚未寫' },
            { id: 'verify', label: '核對：與基底模型的輸出比對', tool: null, runner: false, blocker: '核對程式尚未寫' },
            { id: 'pack', label: '寫入資產（sha256 與 manifest）', tool: null, runner: false, blocker: '匯出結果寫成資產的流程尚未串接' }
        ] },
        gguf: { format: 'gguf', label: 'GGUF', quant: 'q8_0', steps: [
            { id: 'merge', label: '把 LoRA 併入基底權重', tool: null, runner: false, blocker: '合併器存在，但還沒串成匯出流程' },
            { id: 'convert', label: '轉成 GGUF（llama.cpp 的 convert_hf_to_gguf.py）', tool: 'llamaCpp', runner: false, blocker: '轉換執行器尚未寫' },
            { id: 'quantize', label: '量化 q8_0（llama-quantize）', tool: 'llamaCpp', runner: false, blocker: '量化執行器尚未寫' },
            { id: 'verify', label: '核對：與基底模型的輸出比對', tool: null, runner: false, blocker: '核對程式尚未寫' },
            { id: 'pack', label: '寫入資產（sha256 與 manifest）', tool: null, runner: false, blocker: '匯出結果寫成資產的流程尚未串接' }
        ] }
    };
    const FORMATS = Object.keys(EXPORT_PLANS);

    // toolsState：{ optimum: {found}, onnxruntime: {found}, llamaCpp: {found} }；缺的鍵視為沒找到
    const has = (ts, name) => !!(ts && ts[name] && ts[name].found);

    function stepState(step, ts) {
        if (step.tool && !has(ts, step.tool)) return { state: '缺工具', blocker: '需要 ' + TOOLS[step.tool] + '；這台還沒找到' };
        if (!step.runner) return { state: '尚未實作', blocker: step.blocker };
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

    // 偵測：detect 由呼叫端注入（例如主行程用 python -c 或看路徑）；沒有 detect 就全部視為沒找到
    function probeExportTools(detect) {
        const names = Object.keys(TOOLS), state = {};
        names.forEach((n) => {
            let r = null;
            try { r = typeof detect === 'function' ? detect(n) : null; } catch (e) { r = { found: false, reason: String((e && e.message) || e) }; }
            state[n] = r && r.found ? { found: true, version: r.version || null } : { found: false, reason: (r && r.reason) || '沒有偵測函式或沒找到' };
        });
        return state;
    }

    // 訓練模式：LoRA 已實作（cpu-py／wasm-web 路線）；完整微調尚未實作
    const LLM_TRAIN_MODES = [
        { id: 'lora', label: 'LoRA 微調', implemented: true, note: '沿用 LoRA 訓練（cpu-py；網頁版 wasm-web）' },
        { id: 'full', label: '完整微調', implemented: false, blocker: '完整微調需要整包權重的梯度與優化器狀態；0.6B 在這台 CPU 上的記憶體與時間還沒評估，訓練程式也沒寫' }
    ];
    function trainModePlan(mode) {
        const m = LLM_TRAIN_MODES.find((x) => x.id === mode);
        if (!m) return { ok: false, error: '訓練模式必須是 ' + LLM_TRAIN_MODES.map((x) => x.id).join('／') + '，收到 ' + JSON.stringify(mode) };
        return { ok: true, mode: m.id, label: m.label, implemented: m.implemented, blocker: m.implemented ? '' : m.blocker };
    }

    return { TOOLS, EXPORT_PLANS, FORMATS, exportPlan, exportAvailability, probeExportTools, LLM_TRAIN_MODES, trainModePlan };
}));
