// node renderer/src/studio/pipeline_core.test.js
const P = require('./pipeline_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// ---- 五種階段表 ----
check('五種訓練都有階段表', JSON.stringify(P.KINDS) === JSON.stringify(['colu', 'matrix', 'blockly', 'lora', 'llm']), P.KINDS);
const ids = (k) => P.PIPELINES[k].stages.map((s) => s.id).join(',');
check('符號式三種階段相同（含按需載入為略過型）', ids('colu') === ids('matrix') && ids('matrix') === ids('blockly') && ids('colu') === 'ingest,generate,split,train,eval,pack,mount', ids('colu'));
check('符號式的按需載入是 lookup、非必要', P.PIPELINES.colu.stages.find((s) => s.id === 'mount').lookup === true && P.PIPELINES.colu.stages.find((s) => s.id === 'mount').required === false);
check('lora 階段表', ids('lora') === 'ingest,generate,split,train,eval,pack,mount', ids('lora'));
check('lora 訓練後端只列 cpu-py 與 wasm-web', JSON.stringify(P.PIPELINES.lora.stages.find((s) => s.id === 'train').backends) === '["cpu-py","wasm-web"]');
check('llm 階段表含合併與匯出', ids('llm') === 'ingest,generate,split,train,eval,merge,export,mount', ids('llm'));
check('llm 匯出與按需載入已接上並附說明', ['export', 'mount'].every((id) => { const s = P.PIPELINES.llm.stages.find((x) => x.id === id); return s.implemented === true && typeof s.note === 'string' && s.note.length > 0; }));
check('未實作以外的階段都標 implemented', P.PIPELINES.lora.stages.every((s) => s.implemented !== false) && P.PIPELINES.colu.stages.every((s) => s.implemented !== false));

// ---- 狀態推導（只看真實產物與標記）----
const prod = { count: 10, files: 3, sha256: 'abc' };
const allDone = { stages: { ingest: { products: [prod], done: true }, generate: { products: [prod], done: true }, split: { products: [prod], done: true }, train: { products: [prod], done: true }, eval: { products: [prod], done: true }, pack: { products: [prod], done: true }, mount: { skipped: '符號式不需要載入' } } };
const colu = P.deriveStageStates('colu', allDone);
check('全部有產物＋done → 完成', colu.ok && colu.stages.slice(0, 6).every((s) => s.state === '完成'), colu);
check('按需載入的略過保留原因', colu.stages[6].state === '略過' && /不需要載入/.test(colu.stages[6].reason));
check('有產物但沒有 done 標記 → 失敗，不宣稱完成', P.stageState({ id: 'x' }, { products: [prod], done: false }, true).state === '失敗');
check('沒有產物也沒有 done → 待做', P.stageState({ id: 'x' }, {}, true).state === '待做');
check('running 優先於完成判斷', P.stageState({ id: 'x' }, { products: [prod], done: true, running: true }, true).state === '進行中');
check('failed 優先於其他旗標', P.stageState({ id: 'x' }, { products: [prod], done: true, failed: '缺 tree-sitter' }, true).state === '失敗' && P.stageState({ id: 'x' }, { failed: '缺 tree-sitter' }, true).reason === '缺 tree-sitter');
check('前一階段沒完成：有殘留檔案也待做（不宣稱完成）', P.stageState({ id: 'x' }, { products: [prod], done: true }, false).state === '待做' && P.stageState({ id: 'x' }, { products: [prod], done: true }, false).reason === '前一個階段還沒完成');
const partial = P.deriveStageStates('lora', { stages: { ingest: { products: [prod], done: true }, generate: { products: [prod], done: true }, split: { running: true }, train: { products: [prod], done: true } } });
check('中間階段進行中，後面不因殘留產物變完成', partial.stages[2].state === '進行中' && partial.stages[3].state === '待做', partial.stages.map((s) => s.state));
check('產物與耗時照原樣帶出', partial.stages[0].products.length === 1 && partial.stages[0].elapsedMs === null);
const withTime = P.deriveStageStates('colu', { stages: { ingest: { products: [prod], done: true, elapsedMs: 1234 } } });
check('耗時帶出', withTime.stages[0].elapsedMs === 1234);
const llmEmpty = P.deriveStageStates('llm', { stages: {} });
check('llm 匯出：已接上（桌面版），沒有產物時狀態待做', llmEmpty.stages.find((s) => s.id === 'export').state === '待做' && llmEmpty.stages.find((s) => s.id === 'export').unimplemented !== true && /DESIGN §13\.1/.test(llmEmpty.stages.find((s) => s.id === 'export').note || ''));
const llmTrained = P.deriveStageStates('llm', { stages: { ingest: { products: [prod], done: true }, generate: { products: [prod], done: true }, split: { products: [prod], done: true }, train: { products: [prod], done: true }, eval: { products: [prod], done: true }, merge: { products: [prod], done: true } } });
check('llm 合併完成但匯出未實作：匯出仍待做、後面不完成', llmTrained.stages[5].state === '完成' && llmTrained.stages[6].state === '待做' && llmTrained.stages[7].state === '待做');
check('未知 kind 回錯誤不丟例外', P.deriveStageStates('nope', {}).ok === false);
check('空 facts 不丟例外', P.deriveStageStates('lora').stages.length === 7);

// ---- 產物摘要 ----
const sp = P.summarizeProduct({ kind: 'lora', name: 'demo', counts: { train: 8, holdout: 2 }, sha256: { 'a.bin': 'x', 'b.json': 'y' } });
check('產物摘要：筆數、檔案數、雜湊片段', sp.count === 10 && sp.files === 2 && sp.kind === 'lora' && typeof sp.sha256 === 'string' && sp.sha256.length === 16, sp);
check('產物摘要：沒有 manifest 回 null', P.summarizeProduct(null) === null);

// ---- 匯出格式預設 ----
const onnxOnly = P.pickExportFormat('web', { onnxExport: true, ggufExport: false });
check('網頁：有 ONNX 工具時預設 ONNX q8', onnxOnly.ok && onnxOnly.default === 'onnx' && onnxOnly.quant === 'q8', onnxOnly);
check('網頁：沒有 llama.cpp 時 GGUF 標不可用並寫原因', onnxOnly.options.find((o) => o.format === 'gguf').available === false && /llama\.cpp/.test(onnxOnly.options.find((o) => o.format === 'gguf').reason));
const desk = P.pickExportFormat('desktop', { onnxExport: true, ggufExport: false });
check('桌面本機：預設 ONNX q8（不因沒有 GGUF 而改）', desk.default === 'onnx' && desk.quant === 'q8', desk);
const both = P.pickExportFormat('desktop', { onnxExport: true, ggufExport: true });
check('有 llama.cpp 後端時 GGUF 可選，但預設仍是 ONNX q8', both.default === 'onnx' && both.options.find((o) => o.format === 'gguf').available === true && both.options.find((o) => o.format === 'gguf').quant === 'q8_0');
const onlyGguf = P.pickExportFormat('web', { onnxExport: false, ggufExport: true });
check('只有 GGUF 可用時預設改成 GGUF，且 q8_0', onlyGguf.default === 'gguf' && onlyGguf.quant === 'q8_0', onlyGguf);
const none = P.pickExportFormat('desktop', {});
check('沒有任何匯出工具：預設為空並說明', none.ok && none.default === null && none.quant === null && /尚未實作/.test(none.reason), none);
check('env 不合法回錯誤', P.pickExportFormat('phone', {}).ok === false);

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
