// infer_poc_core.js — Qwen3-0.6B 推論熱點概念驗證的核心（DESIGN.webgpu-cuda.md §7.3）。純 UMD，node 可 require。
// 範圍：第 0 層 MLP（gate／up／down，q8 MatMulInteger 路徑）與 lm_head（q8 權重反量化）。
// 權重讀自現有 onnx q8 模型（不下載、不改檔）。注意力、KV 快取、整層串接都不在這裡。
// 主機端「膠水」（RMSNorm、動態量化、SiLU 相乘）兩條路徑共用同一份 CPU 程式，因此比對的差異只來自矩陣乘本身。
'use strict';
const ops = require('./infer_ops.js');
const lite = require('./onnx_lite.js');

const f = Math.fround;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;  // 預設裝置的儲存緩衝上限是 128 MiB，lm_head 照列切成 ≤ 64 MiB 的塊

// 從已解析的模型取出第 layer 層 MLP 與 lm_head 的權重
function extractWeights(model, layer) {
  const L = layer || 0;
  const q = (n) => { const b = lite.tensorBytes(model, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const g = (proj) => {
    const base = 'model.layers.' + L + '.mlp.' + proj + '.MatMul.weight_';
    const t = model.inits[base + 'quantized'];
    return { W: q(base + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(model, base + 'zero_point'), scale: lite.scalar(model, base + 'scale') };
  };
  const nt = lite.tensorBytes(model, 'model.layers.' + L + '.post_attention_layernorm.weight');
  const normW = new Float32Array(nt.length / 4);
  for (let i = 0; i < normW.length; i++) normW[i] = nt.readFloatLE(i * 4);
  const eNode = model.nodes.find((n) => n.name === '/model/layers.' + L + '/post_attention_layernorm/SkipLayerNorm' || n.name === '/model/layers.' + L + '/post_attention_layernorm/LayerNorm');
  const eps = eNode && eNode.attrs.epsilon && eNode.attrs.epsilon.f != null ? eNode.attrs.epsilon.f : 1e-6;
  const et = model.inits['model.embed_tokens.weight_quantized'];
  return {
    gate: g('gate_proj'), up: g('up_proj'), down: g('down_proj'), normW: normW, eps: eps,
    lm: { W: q('model.embed_tokens.weight_quantized'), V: et.dims[0], K: et.dims[1], zp: lite.scalar(model, 'model.embed_tokens.weight_zero_point'), scale: lite.scalar(model, 'model.embed_tokens.weight_scale') }
  };
}

// 決定性的固定輸入（隱藏狀態）：看起來像殘差流的數值（多數小、少數大）
function fixedInput(n, seed) {
  const x = new Float32Array(n);
  let s = (seed || 12345) >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const u = (s % 20001) / 10000 - 1;
    x[i] = f(u * (i % 97 === 0 ? 8 : 1.5));
  }
  return x;
}

function rmsnormHost(x, g, eps) {
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  const inv = f(1 / Math.sqrt(ss / x.length + eps));
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = f(f(x[i] * inv) * g[i]);
  return y;
}
function quantToInt(x) {  // 動態量化後扣掉 zero point，成為 int32（q8mm 的輸入）
  const r = ops.quantizeDynamicRef(x);
  const xi = new Int32Array(x.length);
  for (let i = 0; i < x.length; i++) xi[i] = r.q[i] - r.zp;
  return { xi: xi, scale: r.scale };
}

// 一層 MLP：mm 是 (xi, W, zp, M, K, N, scale) → Float32Array 的矩陣乘函式（參考版或 GPU 版）
async function mlpForward(h, w, mm) {
  const xn = rmsnormHost(h, w.normW, w.eps);
  const a = quantToInt(xn);
  const gate = await mm(a.xi, w.gate.W, w.gate.zp, 1, w.gate.K, w.gate.N, f(a.scale * w.gate.scale));
  const up = await mm(a.xi, w.up.W, w.up.zp, 1, w.up.K, w.up.N, f(a.scale * w.up.scale));
  const act = new Float32Array(gate.length);
  for (let i = 0; i < act.length; i++) {
    const sg = f(1 / (1 + Math.exp(-gate[i])));
    act[i] = f(f(gate[i] * sg) * up[i]);
  }
  const b = quantToInt(act);
  return await mm(b.xi, w.down.W, w.down.zp, 1, w.down.K, w.down.N, f(b.scale * w.down.scale));
}
const mmRef = async (xi, W, zp, M, K, N, scale) => ops.q8mmRef(xi, W, zp, M, K, N, scale);
const mmGpu = (opts, sink) => async (xi, W, zp, M, K, N, scale) => {
  const r = await ops.q8mm(xi, W, zp, M, K, N, scale, opts);
  if (sink) sink.push(r.info);
  return r.result;
};

// 比對：回傳 { maxAbs, maxRel（相對最大絕對值）, exact（逐位元相同的比例）, n }
function compare(a, b) {
  let maxAbs = 0, refMax = 0, same = 0;
  for (let i = 0; i < b.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) maxAbs = d;
    if (Math.abs(b[i]) > refMax) refMax = Math.abs(b[i]);
    if (a[i] === b[i]) same++;
  }
  return { n: b.length, maxAbs: maxAbs, refMax: refMax, maxRel: refMax > 0 ? maxAbs / refMax : 0, exactFrac: b.length ? same / b.length : 1 };
}
// 通過條件：MLP 兩邊同為 f32 運算且整數累加精確，容許 1e-5（相對最大值）；lm_head 是 f32 累加，不同順序，容許 1e-4
const TOL = { mlp: 1e-5, lm: 1e-4 };

async function runPoc(w, opts, now) {
  const clock = now || (() => Date.now());
  const h = fixedInput(w.gate.K, 777);
  const res = { mlp: null, lm: null };
  const infos = [];
  let t = clock();
  const ref = await mlpForward(h, w, mmRef);
  const tRef = clock() - t;
  t = clock();
  const got = await mlpForward(h, w, mmGpu(opts, infos));
  const tGpu = clock() - t;
  res.mlp = Object.assign(compare(got, ref), { refMs: tRef, gpuMs: tGpu, layers: infos.map((i) => i && i.layer), reasons: infos.map((i) => i && i.reason).filter(Boolean) });
  res.mlp.pass = res.mlp.maxRel <= TOL.mlp;
  // lm_head：輸入用 RMSNorm 後的固定向量
  const x = rmsnormHost(fixedInput(w.lm.K, 4242), new Float32Array(w.lm.K).fill(1), 1e-6);
  const chunks = ops.planChunks(w.lm.W, w.lm.V, w.lm.K, MAX_CHUNK_BYTES);
  t = clock();
  const lref = ops.q8lmRef(x, w.lm.W, w.lm.zp, w.lm.V, w.lm.K, w.lm.scale);
  const tLRef = clock() - t;
  t = clock();
  const lg = await ops.q8lm(x, chunks, w.lm.zp, w.lm.K, w.lm.scale, opts);
  const tLGpu = clock() - t;
  t = clock();
  const lg2 = await ops.q8lm(x, chunks, w.lm.zp, w.lm.K, w.lm.scale, opts);  // 第二次：權重已常駐
  const tLGpu2 = clock() - t;
  let amRef = 0, amGot = 0;
  for (let i = 1; i < lref.length; i++) { if (lref[i] > lref[amRef]) amRef = i; if (lg.result[i] > lg.result[amGot]) amGot = i; }
  res.lm = Object.assign(compare(lg.result, lref), { refMs: tLRef, gpuMs: tLGpu, gpuWarmMs: tLGpu2, layer: lg.info.layer, reason: lg.info.reason, argmaxRef: amRef, argmaxGot: amGot, chunks: chunks.length });
  res.lm.pass = res.lm.maxRel <= TOL.lm && amRef === amGot;
  res.pass = res.mlp.pass && res.lm.pass;
  return res;
}

module.exports = { extractWeights, fixedInput, rmsnormHost, quantToInt, mlpForward, mmRef, mmGpu, compare, runPoc, TOL, MAX_CHUNK_BYTES };
