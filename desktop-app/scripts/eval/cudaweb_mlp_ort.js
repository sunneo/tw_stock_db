'use strict';
// 真 onnxruntime CPU 的第 0 層 MLP 時間（唯讀量測）。做法：同一個模型，兩個改寫的圖：
//   A：輸出 = 注意力殘差之後（MLP 之前）
//   B：輸出 = MLP 的 down 輸出（MLP 之後）
// 兩者都含 embedding 與注意力（1 個詞元），所以 B − A 的中位數 ≈ MLP 本身的時間。
// 每個圖暖機 3 次後量 20 次取中位數。預填 1 個詞元（decode 形狀，無過去快取）。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_mlp_ort.js
const fs = require('fs'), path = require('path');
const { rewriteOutputs } = require('./onnx_rewrite.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
const modelPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const MID = '/model/layers.0/post_attention_layernorm/output_3';
const DOWN = '/model/layers.0/mlp/down_proj/MatMul/output_0';

(async () => {
  const buf = fs.readFileSync(modelPath);
  const hd = 128, Hkv = 8;
  const ids = [151644];
  const feeds = (sess) => {
    const f = {};
    f.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, ids.length]);
    if (sess.inputNames.includes('attention_mask')) f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    if (sess.inputNames.includes('position_ids')) f.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, ids.length]);
    for (const n of sess.inputNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x))) {
      f[n] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
      f[n.replace(/\.key$/, '.value')] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    }
    return f;
  };
  const time = async (outName) => {
    const sess = await ort.InferenceSession.create(rewriteOutputs(buf, [outName]), { executionProviders: ['cpu'] });
    const f = feeds(sess);
    for (let i = 0; i < 3; i++) await sess.run(f);
    const t = [];
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await sess.run(f); t.push(Date.now() - t0); }
    t.sort((a, b) => a - b);
    return { median: t[10], min: t[0], max: t[19] };
  };
  const A = await time(MID), B = await time(DOWN);
  const res = { 圖A_MLP前: A, 圖B_MLP後: B, MLP估計中位數毫秒: B.median - A.median, 注意: '時間以 Date.now 毫秒為單位（解析度約 1 毫秒），MLP 是兩者的差，誤差約 ±2 毫秒' };
  console.log(JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(process.env.TEMP || '.', 'cudaweb_mlp_ort.result.json'), JSON.stringify(res, null, 1));
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
