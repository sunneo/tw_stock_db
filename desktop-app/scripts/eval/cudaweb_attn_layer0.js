'use strict';
// Qwen3-0.6B 第 0 層的注意力 K／V 快取路徑：真 ORT（3 個詞元預填、無過去快取）的 present.0.key／present.0.value，
// 對 CPU 參考版（embed 反量化 → input_layernorm → q8 投影 → attn_ops.attentionBlock）比對。
// 範圍（如實）：比對的是 K、V 快取（含 qk-norm、RoPE、q8 投影、快取寫入）。注意力輸出（softmax 之後）與 o_proj 沒有比對，
// 因為 ORT 模型沒有輸出那裡的張量；注意力數學由 attn_ops_test.js 單獨驗證。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_attn_layer0.js
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const A = require('../../renderer/src/gpu/attn_ops.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
const modelPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

(async () => {
  const m = lite.parseModel(fs.readFileSync(modelPath));
  const u8 = (n) => { const b = lite.tensorBytes(m, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const f32 = (n) => { const b = lite.tensorBytes(m, n); const o = new Float32Array(b.length / 4); for (let i = 0; i < o.length; i++) o[i] = b.readFloatLE(i * 4); return o; };
  const qp = (name) => { const base2 = 'model.layers.0.attn.' + name + '.MatMul.weight_'; const t = m.inits[base2 + 'quantized'];
    return { W: u8(base2 + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(m, base2 + 'zero_point'), scale: lite.scalar(m, base2 + 'scale') }; };
  const wq = qp('q_proj'), wk = qp('k_proj'), wv = qp('v_proj');
  const Kd = wq.K, hd = f32('model.layers.0.attn.q_norm.layernorm.weight').length;
  const H = wq.N / hd, Hkv = wk.N / hd;
  const qNorm = f32('model.layers.0.attn.q_norm.layernorm.weight'), kNorm = f32('model.layers.0.attn.k_norm.layernorm.weight');
  const inNorm = f32('model.layers.0.input_layernorm.weight');
  const eps = 1e-6, THETA = 1e6;
  const embW = u8('model.embed_tokens.weight_quantized'), embZp = lite.scalar(m, 'model.embed_tokens.weight_zero_point'), embSc = lite.scalar(m, 'model.embed_tokens.weight_scale');
  console.log(JSON.stringify({ Kd, H, Hkv, hd }));

  // ---- ORT（真模型）----
  const ids = [151644, 872, 198], S = ids.length;
  const sess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  const inNames = sess.inputNames;
  const feeds = {};
  feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, S]);
  if (inNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, S]);
  if (inNames.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, S]);
  for (const n of inNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x))) {
    feeds[n] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    feeds[n.replace(/\.key$/, '.value')] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
  }
  const out = await sess.run(feeds);
  const ok_ = out['present.0.key'], ov_ = out['present.0.value'];
  console.log('ORT present.0.key dims', JSON.stringify(ok_.dims), '輸入名稱數', inNames.length);

  // ---- CPU 參考版 ----
  const x = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) for (let i = 0; i < Kd; i++) x[t * Kd + i] = (embW[ids[t] * Kd + i] - embZp) * embSc;
  const xn = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) xn.set(poc.rmsnormHost(x.subarray(t * Kd, (t + 1) * Kd), inNorm, eps), t * Kd);
  const aq = ops.quantizeDynamicRef(xn);
  const xi = new Int32Array(xn.length); for (let i = 0; i < xi.length; i++) xi[i] = aq.q[i] - aq.zp;
  const proj = (w) => Float32Array.from(ops.q8mmRef(xi, w.W, w.zp, S, w.K, w.N, Math.fround(aq.scale * w.scale)));
  const q = proj(wq), k = proj(wk), v = proj(wv);
  const cache = A.createKvCache(Hkv, hd, S);
  A.attentionBlock({ q, k, v, S, H, Hkv, hd, theta: THETA, eps, qNorm, kNorm, cache });

  // 比對：ORT 的 present 是 [1, Hkv, S, hd]；快取是 [S, Hkv, hd]
  const cmp = (ortArr, ours) => {
    let maxAbs = 0, maxRef = 0;
    for (let h = 0; h < Hkv; h++) for (let t = 0; t < S; t++) for (let d = 0; d < hd; d++) {
      const a = ortArr[(h * S + t) * hd + d], b = ours[(t * Hkv + h) * hd + d];
      maxAbs = Math.max(maxAbs, Math.abs(a - b)); maxRef = Math.max(maxRef, Math.abs(a));
    }
    return { maxAbs, maxRef, rel: maxAbs / (maxRef || 1) };
  };
  const rK = cmp(ok_.data, cache.k), rV = cmp(ov_.data, cache.v);
  const res = { K: rK, V: rV, S, pass: rK.rel < 1e-3 && rV.rel < 1e-3 };
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
