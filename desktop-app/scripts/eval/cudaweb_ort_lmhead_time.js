'use strict';
// 量「現有路徑」的 lm_head 時間：onnxruntime-node（CPU）跑完整 151936×1024 的 DequantizeLinear→Transpose→MatMul（與模型內同一組節點）。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_ort_lmhead_time.js
// 結果寫到 cudaweb_ort_lmhead_time.result.json。拿來和 GPU 版（cudaweb_infer_browser.result.json 的 lm.gpuWarmMs）比，才知道接線值不值得。
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const vi = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const tag = (f, w) => vi(f * 8 + w);
const fVar = (f, v) => Buffer.concat([tag(f, 0), vi(v)]);
const fBytes = (f, b) => Buffer.concat([tag(f, 2), vi(b.length), b]);
const fStr = (f, s) => fBytes(f, Buffer.from(s, 'utf8'));
const cat = (...a) => Buffer.concat(a);
const tensor = (name, dims, dtype, raw) => cat(...dims.map((d) => fVar(1, d)), fVar(2, dtype), fStr(8, name), fBytes(9, raw));
const node = (op, ins, outs, attrs) => cat(...ins.map((s) => fStr(1, s)), ...outs.map((s) => fStr(2, s)), fStr(4, op), ...(attrs || []));
const attrInts = (name, ints) => fBytes(5, cat(fStr(1, name), ...ints.map((i) => fVar(8, i)), fVar(20, 7)));
const vinfo = (name, elem, dims) => cat(fStr(1, name), fBytes(2, fBytes(1, cat(fVar(1, elem), fBytes(2, cat(...dims.map((d) => fBytes(1, fVar(1, d)))))))));
const f32raw = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

(async () => {
  const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
  const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
  const w = poc.extractWeights(lite.parseModel(fs.readFileSync(modelPath)), 0);
  const V = w.lm.V, K = w.lm.K;
  const g = cat(
    ...[node('DequantizeLinear', ['Wq', 'ws', 'wz'], ['Wd']), node('Transpose', ['Wd'], ['Wt'], [attrInts('perm', [1, 0])]), node('MatMul', ['X', 'Wt'], ['Y'])].map((n) => fBytes(1, n)),
    fStr(2, 'g'),
    ...[tensor('Wq', [V, K], 2, Buffer.from(w.lm.W.buffer, w.lm.W.byteOffset, w.lm.W.length)), tensor('ws', [], 1, f32raw(w.lm.scale)), tensor('wz', [], 2, Buffer.from([w.lm.zp]))].map((t) => fBytes(5, t)),
    fBytes(11, vinfo('X', 1, [1, K])), fBytes(12, vinfo('Y', 1, [1, V])));
  const mb = cat(fVar(1, 8), fBytes(8, fVar(2, 13)), fBytes(7, g));
  const sess = await ort.InferenceSession.create(new Uint8Array(mb), { executionProviders: ['cpu'] });
  const x = poc.rmsnormHost(poc.fixedInput(K, 4242), new Float32Array(K).fill(1), 1e-6);
  const times = [];
  for (let i = 0; i < 12; i++) { const t0 = process.hrtime.bigint(); await sess.run({ X: new ort.Tensor('float32', x, [1, K]) }); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  const sorted = times.slice(1).sort((a, b) => a - b);
  const out = { ort: 'onnxruntime-node 1.22.0 CPU', firstMs: times[0], warmMedianMs: sorted[Math.floor(sorted.length / 2)], warmMinMs: sorted[0], allMs: times };
  fs.writeFileSync(path.join(__dirname, 'cudaweb_ort_lmhead_time.result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
