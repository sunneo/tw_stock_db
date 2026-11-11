'use strict';
// 頁內訓練 Worker 的資料排版：只對答案 token 算損失、太長保留尾端、不足補齊且補齊位置不算損失。（Worker 全流程在真 Electron 的 studio_webtrain.eval.js 驗證）
const W = require('./webtrain_worker_core.js');
let fail = 0; const ok = (c, n, e) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (e ? '  ' + e : '')); };
const r = W.layoutRow([1, 2, 3], [7, 8], 8);   // all=[1,2,3,7,8]；input=[1,2,3,7]，tgt=[2,3,7,8]
ok(JSON.stringify(r.ids) === '[1,2,3,7,0,0,0,0]' && JSON.stringify(r.tgt) === '[2,3,7,8,0,0,0,0]', '輸入／目標位移一格並補齊到 T', JSON.stringify(r));
ok(JSON.stringify(r.mask) === '[0,0,1,1,0,0,0,0]', '只有目標落在答案區的位置算損失（提示與補齊不算）', JSON.stringify(r.mask));
const t = W.layoutRow([1, 2, 3, 4, 5, 6], [9, 9, 9], 4);   // all 長 9 → input 8 → 保留尾端 4
ok(t.ids.length === 4 && JSON.stringify(t.mask) === '[0,1,1,1]' && t.tgt[3] === 9, '太長保留尾端（答案不被切掉）', JSON.stringify(t));
ok(W.MODEL_URL === 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_quantized.onnx', '模型來源與 AI 助理相同（transformers.js 的 repo 與檔名）');
console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
