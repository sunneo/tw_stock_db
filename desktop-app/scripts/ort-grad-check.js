#!/usr/bin/env node
// 把 onnx_grad_core 產生的訓練圖（前向＋反向＋Adam）交給真的 onnxruntime-web（WASM）執行，與 JS 直譯器的 fp64 結果對拍。
// 用法：FA_GRAD_DUMP=<資料夾> node renderer/src/studio/onnx_grad_core.test.js 先產生 tiny_train.onnx／tiny_feeds.json
//       node scripts/ort-grad-check.js <dump資料夾> <onnxruntime-web 的安裝資料夾（含 node_modules）>
const fs = require('fs'), path = require('path');
const [dump, ortDir] = process.argv.slice(2); if (!dump || !ortDir) { console.error('用法見檔頭'); process.exit(2); }
const ort = require(path.join(ortDir, 'node_modules', 'onnxruntime-web'));
(async () => {
    ort.env.wasm.numThreads = 1;
    const j = JSON.parse(fs.readFileSync(path.join(dump, 'tiny_feeds.json'), 'utf8'));
    const t0 = Date.now(); const sess = await ort.InferenceSession.create(fs.readFileSync(path.join(dump, 'tiny_train.onnx')), { executionProviders: ['wasm'] }); const tLoad = Date.now() - t0;
    const feeds = {}; for (const [k, meta] of Object.entries(j.shapes)) { const v = j.feeds[k]; feeds[k] = meta.dtype === 'i64' ? new ort.Tensor('int64', BigInt64Array.from(v.map((x) => BigInt(Math.round(x)))), meta.shape) : new ort.Tensor('float32', Float32Array.from(v), meta.shape); }
    let out; const ts = []; for (let i = 0; i < 5; i++) { const t = Date.now(); out = await sess.run(feeds); ts.push(Date.now() - t); }
    let worst = 0, n = 0; for (const [k, exp] of Object.entries(j.expect)) {
        const name = k === 'loss' ? Object.keys(out).find((x) => out[x].dims.length === 0) : k; const got = out[name]; if (!got) { console.log('FAIL 缺輸出 ' + k); process.exit(1); }
        let a = 0, b = 0; for (let i = 0; i < exp.length; i++) { a += (got.data[i] - exp[i]) ** 2; b += exp[i] ** 2; } worst = Math.max(worst, Math.sqrt(a / (b || 1))); n++;
    }
    console.log('ORT-web ' + require(path.join(ortDir, 'node_modules', 'onnxruntime-web', 'package.json')).version + ' WASM：載入 ' + tLoad + ' ms；單步（前向＋反向＋Adam）' + ts.join('/') + ' ms；' + n + ' 個輸出對 fp64 直譯器最大相對 L2 誤差 ' + worst.toExponential(2));
    process.exit(worst < 1e-4 ? 0 : 1);
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
