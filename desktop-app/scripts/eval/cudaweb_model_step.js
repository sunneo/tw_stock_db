'use strict';
// Qwen3-0.6B 全部 28 層（預填 3 個詞元、無過去快取）＋最後的 RMSNorm ＋ lm_head，對真 ORT 的 logits 比對。
// CPU 參考版每層：RMSNorm → q8 投影 → attn_ops.attentionBlock → o_proj → 殘差 → RMSNorm → gate／up → SiLU×up → down → 殘差。
// lm_head：與嵌入共用的 q8（tied），用 infer_ops.q8lmRef（與 nn 的 q8lm 參考版相同）。
// ORT 端直接用原模型（不改寫圖），取 logits 輸出。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_model_step.js
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
  const qp = (nm) => { const t = m.inits[nm + 'quantized']; return { W: u8(nm + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(m, nm + 'zero_point'), scale: lite.scalar(m, nm + 'scale') }; };
  const hd = 128, eps = 1e-6, THETA = 1e6;
  const embName = 'model.embed_tokens.weight_';
  const embW = u8(embName + 'quantized'), embZp = lite.scalar(m, embName + 'zero_point'), embSc = lite.scalar(m, embName + 'scale');
  const Vn = m.inits[embName + 'quantized'].dims[0], Kd = m.inits[embName + 'quantized'].dims[1];
  const finalNorm = f32('model.layers.28.final_norm_layernorm.weight'); // 模型圖的最後一個 SkipLayerNorm（見 onnx 節點名）
  // 層數：找得到 layers.N.input_layernorm.weight 的最大 N
  let L = 0; while (m.inits['model.layers.' + L + '.input_layernorm.weight']) L++;
  const H = qp('model.layers.0.attn.q_proj.MatMul.weight_').N / hd, Hkv = qp('model.layers.0.attn.k_proj.MatMul.weight_').N / hd;
  const layers = [];
  for (let l = 0; l < L; l++) {
    const p = 'model.layers.' + l + '.';
    layers.push({
      q: qp(p + 'attn.q_proj.MatMul.weight_'), k: qp(p + 'attn.k_proj.MatMul.weight_'), v: qp(p + 'attn.v_proj.MatMul.weight_'), o: qp(p + 'attn.o_proj.MatMul.weight_'),
      g: qp(p + 'mlp.gate_proj.MatMul.weight_'), u: qp(p + 'mlp.up_proj.MatMul.weight_'), d: qp(p + 'mlp.down_proj.MatMul.weight_'),
      qNorm: f32(p + 'attn.q_norm.layernorm.weight'), kNorm: f32(p + 'attn.k_norm.layernorm.weight'),
      inNorm: f32(p + 'input_layernorm.weight'), postNorm: f32(p + 'post_attention_layernorm.weight'),
    });
  }
  console.log(JSON.stringify({ layers: L, H, Hkv, hd, V: Vn, K: Kd }));

  const ids = [151644, 872, 198], S = ids.length;
  // 每層輸出（第 k 層之後的隱藏狀態 = 第 k+1 層 input_layernorm 的殘差和）；最後一層用 final norm 的殘差和
  const layerOut = (k) => (k < L ? '/model/layers.' + k + '/input_layernorm/output_3' : '/model/layers.' + k + '/final_norm_layernorm/output_3');
  // 第 DBG 層的子運算（診斷用）：注意力輸出、o_proj、殘差、gate、up、SiLU×up、down
  const DBG = 21;
  const dbgNames = { attn: `/model/layers.${DBG}/attn/GroupQueryAttention/output_0`, oproj: `/model/layers.${DBG}/attn/o_proj/MatMul/output_0`, mid: `/model/layers.${DBG}/post_attention_layernorm/output_3`, gate: `/model/layers.${DBG}/mlp/gate_proj/MatMul/output_0`, up: `/model/layers.${DBG}/mlp/up_proj/MatMul/output_0`, act: `/model/layers.${DBG}/mlp/Mul/output_0`, down: `/model/layers.${DBG}/mlp/down_proj/MatMul/output_0`, qIn: `/model/layers.${DBG}/input_layernorm/output_0_quantized`, sIn: `/model/layers.${DBG}/input_layernorm/output_0_scale` };
  const wanted = ['logits'].concat(Array.from({ length: L - 1 }, (_, l) => layerOut(l + 1))).concat(Object.values(dbgNames)); // 最後一層的殘差和不存在於圖中，只比到第 L-1 層之後
  const { rewriteOutputs } = require('./onnx_rewrite.js');
  const wantedRW = wanted.map((x) => (x === dbgNames.qIn ? { name: x, elem: 2 } : x)); // 量化後的整數是 uint8
  const sess = await ort.InferenceSession.create(rewriteOutputs(fs.readFileSync(modelPath), wantedRW), { executionProviders: ['cpu'] });
  const feeds = {};
  feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, S]);
  if (sess.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, S]);
  if (sess.inputNames.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, S]);
  for (const n of sess.inputNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x))) {
    feeds[n] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    feeds[n.replace(/\.key$/, '.value')] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
  }
  const out = await sess.run(feeds);
  const ortLogits = out.logits || out[sess.outputNames.find((n) => /logits/.test(n))];
  const ortData = ortLogits.data;
  console.log('ORT logits dims', JSON.stringify(ortLogits.dims));

  // ---- CPU 參考版 ----
  const perLayer = [], dbg = [];
  let h = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) for (let i = 0; i < Kd; i++) h[t * Kd + i] = (embW[ids[t] * Kd + i] - embZp) * embSc;
  // RMSNorm：預設平方和逐步以 f32 累加（與 ORT 的 f32 精度一致；double 累加會讓量化整數在邊界翻轉，見設計文件 §7.7）。RMS_F32=0 可切回 poc.rmsnormHost。
  const RMS_F32 = process.env.RMS_F32 !== '0';
  const rmsF32 = (x, g) => { let ss = 0; for (let i = 0; i < x.length; i++) ss = Math.fround(ss + Math.fround(x[i] * x[i])); const inv = Math.fround(1 / Math.sqrt(Math.fround(Math.fround(ss / x.length) + eps))); const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = Math.fround(Math.fround(x[i] * inv) * g[i]); return y; };
  const rowNorm = (src, g) => { const o = new Float32Array(src.length); for (let t = 0; t < S; t++) o.set(RMS_F32 ? rmsF32(src.subarray(t * Kd, (t + 1) * Kd), g) : poc.rmsnormHost(src.subarray(t * Kd, (t + 1) * Kd), g, eps), t * Kd); return o; };
  const dynQ = (x) => { const r = ops.quantizeDynamicRef(x); const xi = new Int32Array(x.length); for (let i = 0; i < xi.length; i++) xi[i] = r.q[i] - r.zp; return { xi, scale: r.scale }; };
  const mm = (qz, w, M) => Float32Array.from(ops.q8mmRef(qz.xi, w.W, w.zp, M, w.K, w.N, Math.fround(qz.scale * w.scale)));
  for (let l = 0; l < L; l++) {
    const Ly = layers[l];
    const xn = rowNorm(h, Ly.inNorm);
    const qz = dynQ(xn);
    const attn = A.attentionBlock({ q: mm(qz, Ly.q, S), k: mm(qz, Ly.k, S), v: mm(qz, Ly.v, S), S, H, Hkv, hd, theta: THETA, eps, qNorm: Ly.qNorm, kNorm: Ly.kNorm, cache: A.createKvCache(Hkv, hd, S) });
    const oz = dynQ(attn);
    const op = mm(oz, Ly.o, S);
    const mid = new Float32Array(h.length); for (let i = 0; i < mid.length; i++) mid[i] = h[i] + op[i];
    const n2 = rowNorm(mid, Ly.postNorm);
    const nz = dynQ(n2);
    const gate = mm(nz, Ly.g, S), up = mm(nz, Ly.u, S);
    const act = new Float32Array(gate.length); for (let i = 0; i < act.length; i++) act[i] = (gate[i] / (1 + Math.exp(-gate[i]))) * up[i];
    const down = mm(dynQ(act), Ly.d, S);
    if (l === DBG) {
      const cmpOne = (key, cpu) => { const o = out[dbgNames[key]]; if (!o) { dbg.push({ op: key, error: '沒有 ORT 輸出' }); return; } let ma = 0, mr = 0; for (let i = 0; i < cpu.length; i++) { ma = Math.max(ma, Math.abs(cpu[i] - o.data[i])); mr = Math.max(mr, Math.abs(o.data[i])); } dbg.push({ op: key, rel: +(ma / (mr || 1)).toExponential(3), ortMax: +mr.toFixed(3) }); };
      cmpOne('attn', attn); cmpOne('oproj', op); cmpOne('mid', mid); cmpOne('gate', gate); cmpOne('up', up); cmpOne('act', act); cmpOne('down', down);
      // 假設檢驗：輸入 RMSNorm 之後的動態量化（整數與步長）是否與 ORT 逐元素一致
      const r0 = ops.quantizeDynamicRef(xn);
      const oq0 = out[dbgNames.qIn], os0 = out[dbgNames.sIn];
      if (oq0) { let diff = 0, maxd = 0; for (let i = 0; i < r0.q.length; i++) { const d = Math.abs(r0.q[i] - oq0.data[i]); if (d) diff++; maxd = Math.max(maxd, d); } dbg.push({ op: 'qIn 整數', 不一致數: diff, 總數: r0.q.length, 最大差: maxd }); }
      if (os0) dbg.push({ op: 'qIn 步長', ours: r0.scale, ort: os0.data[0] });
    }
    const next = new Float32Array(h.length); for (let i = 0; i < next.length; i++) next[i] = mid[i] + down[i];
    h = next;
    const ortH = (l + 1 < L) ? out[layerOut(l + 1)] : null;
    if (ortH) { let ma = 0, mr = 0; for (let i = 0; i < h.length; i++) { ma = Math.max(ma, Math.abs(h[i] - ortH.data[i])); mr = Math.max(mr, Math.abs(ortH.data[i])); } perLayer.push({ layer: l, rel: +(ma / (mr || 1)).toExponential(3) }); }
  }
  const hn = rowNorm(h, finalNorm);
  const embQ = { W: embW, zp: embZp, sc: embSc };
  const logits = new Float32Array(S * Vn);
  for (let t = 0; t < S; t++) logits.set(ops.q8lmRef(hn.subarray(t * Kd, (t + 1) * Kd), embQ.W, embQ.zp, Vn, Kd, Math.fround(embQ.sc)), t * Vn);

  // 比對：全部元素的最大相對誤差；另看每個詞元 argmax 是否一致
  let maxAbs = 0, maxRef = 0, argOk = 0;
  for (let i = 0; i < logits.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(logits[i] - ortData[i])); maxRef = Math.max(maxRef, Math.abs(ortData[i])); }
  for (let t = 0; t < S; t++) {
    let a = 0, b = 0;
    for (let i = 1; i < Vn; i++) { if (logits[t * Vn + i] > logits[t * Vn + a]) a = i; if (ortData[t * Vn + i] > ortData[t * Vn + b]) b = i; }
    if (a === b) argOk++;
  }
  const res = { 第21層子運算: dbg, 每層隱藏狀態相對誤差: perLayer, logits: { maxAbs, maxRef, rel: maxAbs / (maxRef || 1) }, 詞元argmax一致: argOk + '/' + S, pass: maxAbs / (maxRef || 1) < 1e-3 && argOk === S };
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
