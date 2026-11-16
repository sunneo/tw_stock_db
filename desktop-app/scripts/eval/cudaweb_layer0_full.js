'use strict';
// Qwen3-0.6B 第 0 層完整一層（注意力殘差 → post-attention RMSNorm → gate／up → SiLU×up → down → 殘差）對真 ORT（3 詞元預填）。
// ORT 端用 onnx_rewrite.rewriteOutputs 取中間張量：
//   /model/layers.0/post_attention_layernorm/output_3（注意力殘差之後的隱藏狀態 h_mid）
//   /model/layers.0/mlp/down_proj/MatMul/output_0（MLP 的 down 輸出）
//   /model/layers.1/input_layernorm/SkipLayerNorm/output_3（第 0 層的輸出 h_out = h_mid + down）
// CPU 端：embed → 注意力（attentionBlock＋o_proj）→ h_mid = h0 + o_proj → RMSNorm → q8 gate／up → SiLU(gate)×up → q8 down → h_out。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_layer0_full.js
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const A = require('../../renderer/src/gpu/attn_ops.js');
const { rewriteOutputs } = require('./onnx_rewrite.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
const modelPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const MID = '/model/layers.0/post_attention_layernorm/output_3';
const DOWN = '/model/layers.0/mlp/down_proj/MatMul/output_0';
const HOUT = '/model/layers.1/input_layernorm/output_3';

(async () => {
  const m = lite.parseModel(fs.readFileSync(modelPath));
  const u8 = (n) => { const b = lite.tensorBytes(m, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const f32 = (n) => { const b = lite.tensorBytes(m, n); const o = new Float32Array(b.length / 4); for (let i = 0; i < o.length; i++) o[i] = b.readFloatLE(i * 4); return o; };
  const qp = (scope, name) => { const nm = 'model.layers.0.' + scope + '.' + name + '.MatMul.weight_'; const t = m.inits[nm + 'quantized'];
    return { W: u8(nm + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(m, nm + 'zero_point'), scale: lite.scalar(m, nm + 'scale') }; };
  const wq = qp('attn', 'q_proj'), wk = qp('attn', 'k_proj'), wv = qp('attn', 'v_proj'), wo = qp('attn', 'o_proj');
  const wg = qp('mlp', 'gate_proj'), wu = qp('mlp', 'up_proj'), wd = qp('mlp', 'down_proj');
  const Kd = wq.K, hd = 128, H = wq.N / hd, Hkv = wk.N / hd;
  const qNorm = f32('model.layers.0.attn.q_norm.layernorm.weight'), kNorm = f32('model.layers.0.attn.k_norm.layernorm.weight');
  const inNorm = f32('model.layers.0.input_layernorm.weight'), postNorm = f32('model.layers.0.post_attention_layernorm.weight');
  const eps = 1e-6, THETA = 1e6;
  const embW = u8('model.embed_tokens.weight_quantized'), embZp = lite.scalar(m, 'model.embed_tokens.weight_zero_point'), embSc = lite.scalar(m, 'model.embed_tokens.weight_scale');

  const ids = [151644, 872, 198], S = ids.length;
  const sess = await ort.InferenceSession.create(rewriteOutputs(fs.readFileSync(modelPath), [MID, DOWN, HOUT]), { executionProviders: ['cpu'] });
  const feeds = {};
  feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, S]);
  if (sess.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, S]);
  if (sess.inputNames.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, S]);
  for (const n of sess.inputNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x))) {
    feeds[n] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    feeds[n.replace(/\.key$/, '.value')] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
  }
  const out = await sess.run(feeds);
  const ortMid = out[MID].data, ortDown = out[DOWN].data, ortOut = out[HOUT].data;

  // ---- CPU 參考版 ----
  const x = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) for (let i = 0; i < Kd; i++) x[t * Kd + i] = (embW[ids[t] * Kd + i] - embZp) * embSc;
  const rowNorm = (src, g) => { const o = new Float32Array(src.length); for (let t = 0; t < S; t++) o.set(poc.rmsnormHost(src.subarray(t * Kd, (t + 1) * Kd), g, eps), t * Kd); return o; };
  const xn = rowNorm(x, inNorm);
  const aq = ops.quantizeDynamicRef(xn);
  const xi = new Int32Array(xn.length); for (let i = 0; i < xi.length; i++) xi[i] = aq.q[i] - aq.zp;
  const proj = (w) => Float32Array.from(ops.q8mmRef(xi, w.W, w.zp, S, w.K, w.N, Math.fround(aq.scale * w.scale)));
  const attn = A.attentionBlock({ q: proj(wq), k: proj(wk), v: proj(wv), S, H, Hkv, hd, theta: THETA, eps, qNorm, kNorm, cache: A.createKvCache(Hkv, hd, S) });
  const oq = ops.quantizeDynamicRef(attn);
  const oi = new Int32Array(attn.length); for (let i = 0; i < oi.length; i++) oi[i] = oq.q[i] - oq.zp;
  const oproj = Float32Array.from(ops.q8mmRef(oi, wo.W, wo.zp, S, wo.K, wo.N, Math.fround(oq.scale * wo.scale)));
  const hMid = new Float32Array(S * Kd); for (let i = 0; i < hMid.length; i++) hMid[i] = x[i] + oproj[i];

  const n2 = rowNorm(hMid, postNorm);
  const nq = ops.quantizeDynamicRef(n2);
  const ni = new Int32Array(n2.length); for (let i = 0; i < ni.length; i++) ni[i] = nq.q[i] - nq.zp;
  const gate = Float32Array.from(ops.q8mmRef(ni, wg.W, wg.zp, S, wg.K, wg.N, Math.fround(nq.scale * wg.scale)));
  const up = Float32Array.from(ops.q8mmRef(ni, wu.W, wu.zp, S, wu.K, wu.N, Math.fround(nq.scale * wu.scale)));
  const act = new Float32Array(gate.length); for (let i = 0; i < act.length; i++) act[i] = (gate[i] / (1 + Math.exp(-gate[i]))) * up[i];
  const aq2 = ops.quantizeDynamicRef(act);
  const ai = new Int32Array(act.length); for (let i = 0; i < ai.length; i++) ai[i] = aq2.q[i] - aq2.zp;
  const down = Float32Array.from(ops.q8mmRef(ai, wd.W, wd.zp, S, wd.K, wd.N, Math.fround(aq2.scale * wd.scale)));
  const hOut = new Float32Array(S * Kd); for (let i = 0; i < hOut.length; i++) hOut[i] = hMid[i] + down[i];

  const cmp = (a, b) => { let maxAbs = 0, maxRef = 0; for (let i = 0; i < b.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i])); maxRef = Math.max(maxRef, Math.abs(a[i])); } return { maxAbs, maxRef, rel: maxAbs / (maxRef || 1) }; };
  const rMid = cmp(ortMid, hMid), rDown = cmp(ortDown, down), rOut = cmp(ortOut, hOut);
  const res = { 注意力殘差後: rMid, MLP_down: rDown, 第0層輸出: rOut, S, pass: rMid.rel < 1e-3 && rDown.rel < 1e-3 && rOut.rel < 1e-3 };
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
