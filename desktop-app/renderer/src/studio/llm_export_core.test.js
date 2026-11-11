// node renderer/src/studio/llm_export_core.test.js
const E = require('./llm_export_core.js'), PL = require('./pipeline_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// ---- 步驟表 ----
check('格式只有 ONNX 與 GGUF', JSON.stringify(E.FORMATS) === '["onnx","gguf"]');
check('ONNX 用 q8、GGUF 用 q8_0', E.EXPORT_PLANS.onnx.quant === 'q8' && E.EXPORT_PLANS.gguf.quant === 'q8_0');
check('兩個格式都是 合併→轉換→量化→核對→寫入 五步', ['onnx', 'gguf'].every((f) => E.EXPORT_PLANS[f].steps.map((s) => s.id).join(',') === 'merge,convert,quantize,verify,pack'));
check('執行器全部還沒寫（runner=false），每一步都有阻礙說明', ['onnx', 'gguf'].every((f) => E.EXPORT_PLANS[f].steps.every((s) => s.runner === false && s.blocker)));

// ---- 計畫：缺工具與尚未實作要分開 ----
const none = E.exportPlan('onnx', {});
check('沒有工具：轉換步驟是「缺工具」，寫出工具名稱', none.steps.find((s) => s.id === 'convert').state === '缺工具' && /optimum/.test(none.steps.find((s) => s.id === 'convert').blocker));
check('沒有工具：合併步驟（不需要外部工具）是「尚未實作」而不是缺工具', none.steps.find((s) => s.id === 'merge').state === '尚未實作');
check('計畫不可用（ready=false），阻礙清單非空', none.ready === false && none.blockers.length === 5, none);
const withTools = E.exportPlan('onnx', { optimum: { found: true }, onnxruntime: { found: true } });
check('工具都找到：轉換變成「尚未實作」（執行器沒寫），不會假裝待做', withTools.steps.find((s) => s.id === 'convert').state === '尚未實作' && withTools.ready === false);
check('未知格式回錯誤', E.exportPlan('safetensors', {}).ok === false);

// ---- 可用性與原因 ----
const av0 = E.exportAvailability({});
check('沒有工具：兩個格式都不可用，原因是缺工具並列出名稱', av0.onnx.available === false && /缺工具：/.test(av0.onnx.reason) && /optimum/.test(av0.onnx.reason) && av0.gguf.available === false && /llama\.cpp/.test(av0.gguf.reason), av0);
const av1 = E.exportAvailability({ optimum: { found: true }, onnxruntime: { found: true }, llamaCpp: { found: true } });
check('工具都找到但執行器沒寫：不可用，原因寫「執行器尚未實作」', av1.onnx.available === false && /匯出執行器尚未實作/.test(av1.onnx.reason) && av1.gguf.available === false && /尚未實作/.test(av1.gguf.reason), av1);
check('只有 llama.cpp 時 GGUF 的缺工具清單為空', E.exportAvailability({ llamaCpp: { found: true } }).gguf.missingTools.length === 0 && E.exportAvailability({ llamaCpp: { found: true } }).onnx.missingTools.join() === 'optimum,onnxruntime');

// ---- 偵測 ----
const pr = E.probeExportTools((n) => (n === 'optimum' ? { found: true, version: '1.2.3' } : { found: false, reason: '找不到 ' + n }));
check('偵測：找到的工具帶版本', pr.optimum.found === true && pr.optimum.version === '1.2.3');
check('偵測：沒找到的工具帶原因', pr.llamaCpp.found === false && /找不到 llamaCpp/.test(pr.llamaCpp.reason));
check('偵測：沒有偵測函式＝全部沒找到', E.probeExportTools(null).optimum.found === false);
check('偵測：偵測函式丟例外不影響其他工具', (() => { const s = E.probeExportTools((n) => { if (n === 'optimum') throw new Error('boom'); return { found: true }; }); return s.optimum.found === false && /boom/.test(s.optimum.reason) && s.onnxruntime.found === true; })());

// ---- 與流程核心接上：有工具但執行器沒寫 → 格式預設仍是空 ----
const caps = { onnxExport: av1.onnx.available, ggufExport: av1.gguf.available };
check('流程核心的格式預設：執行器沒寫時不會選 ONNX', PL.pickExportFormat('desktop', caps).default === null);

// ---- 訓練模式 ----
check('LoRA 模式已實作', E.trainModePlan('lora').implemented === true && E.trainModePlan('lora').blocker === '');
const full = E.trainModePlan('full');
check('完整微調：未實作，寫明阻礙（記憶體與時間未評估）', full.implemented === false && /未評估|沒有寫|沒評估|還沒評估/.test(full.blocker), full);
check('未知訓練模式回錯誤', E.trainModePlan('dpo').ok === false);

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
