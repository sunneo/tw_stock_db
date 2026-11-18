// O8 訓練路徑（可在 node 驗證的部分）。
// 1. adamw_accum：一次派發同時做「K 個微批次梯度的累加（取平均）」與 AdamW 更新。
//    m ← b1·m + (1−b1)·g；v ← b2·v + (1−b2)·g²；p ← p − lr·wd·p − lr·(m/c1)/(sqrt(v/c2)+eps)
//    其中 g = scale·Σ_k G[k]，scale 通常取 1/K；c1 = 1−b1^t、c2 = 1−b2^t 由主機算好、以 f32 傳入。
// 2. adamStepFused：把一整步的所有 LoRA 矩陣攤平成一條陣列（AdamW 是逐元素的，攤平後結果逐位相同），
//    一步只派發一次、只回讀一次（p、m、v 三個輸出在同一次 submit 裡）。
// 3. pickForwardPrecision：前向精度的能力分支。有 shader-f16 才選 f16；沒有就 f32。永遠不會選 'cpu'。
//
// 數值界線（寫給審的人看，不是真機量測）：
//  - adamwAccumRef：全 f64，當真值。
//  - adamwAccumF32：逐運算做 Math.fround，運算順序與 WGSL 的 adamw_accum 相同（左到右、乘加不融合）。
//    它是 WGSL 的「逐位元參考」；真 GPU 若用 FMA 或不同的 sqrt／除法精度，結果可能差幾個 ulp，這點未在真晶片量。
//  - 誤差來源：每個 f32 捨入 ≤ u = 2^-24；g 的累加誤差 ≤ (K−1)·u·Σ|G_k|；m、v 的加法誤差 ≤ u·(|b1·m|+|(1−b1)·g|)。
//    保守的單元素界線（以更新量 Δ 表示）：|Δ_f32 − Δ_f64| ≤ (K+10)·u·(|p| + |Δ_f64| + lr)。
//    測試用這個式子當上界檢查。注意：這是 f32 相對於 f64 的界，不是 f32 相對於真 GPU 的界。
// 這一檔的 WGSL 只在假裝置上跑過（CPU 參考版）；真 Chrome 的逐元素對拍仍未做，見清單 O8。
'use strict';
const U32 = 2 ** -24;   // f32 單位捨入（unit roundoff）
const f32 = Math.fround;
// uniform 佈局（48 位元組）：0 n(u32)、4 K(u32)、8 lr、12 b1、16 omb1、20 b2、24 omb2、28 eps、32 wd、36 c1、40 c2、44 scale（f32）

const WGSL_ADAMW_ACCUM = `
struct P { n: u32, k: u32, lr: f32, b1: f32, omb1: f32, b2: f32, omb2: f32, eps: f32, wd: f32, c1: f32, c2: f32, scale: f32 }
@group(0) @binding(0) var<storage, read_write> pp: array<f32>;
@group(0) @binding(1) var<storage, read> gg: array<f32>;
@group(0) @binding(2) var<storage, read_write> mm: array<f32>;
@group(0) @binding(3) var<storage, read_write> vv: array<f32>;
@group(0) @binding(4) var<uniform> u: P;
// @kernel adamw_accum
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  var g: f32 = 0.0;
  for (var k: u32 = 0u; k < u.k; k = k + 1u) { g = g + gg[k * u.n + i]; }
  g = g * u.scale;
  let m2 = u.b1 * mm[i] + u.omb1 * g;
  let v2 = u.b2 * vv[i] + u.omb2 * g * g;
  let p0 = pp[i];
  mm[i] = m2;
  vv[i] = v2;
  pp[i] = p0 - u.lr * u.wd * p0 - u.lr * (m2 / u.c1) / (sqrt(v2 / u.c2) + u.eps);
}
`;

// f64 真值。p、m、v 長度 n；G 是攤平的 K×n（第 k 個微批次在 [k·n, (k+1)·n)）。
function adamwAccumRef(p, G, K, m, v, t, lr, b1, b2, eps, wd, scale) {
  const n = p.length;
  if (G.length !== K * n) throw new Error('adamw_accum：G 長度應為 K·n=' + (K * n) + '，實際 ' + G.length);
  if (m.length !== n || v.length !== n) throw new Error('adamw_accum：m、v 長度與 p 不同');
  const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
  const P2 = new Float64Array(n), M2 = new Float64Array(n), V2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; for (let k = 0; k < K; k++) s += G[k * n + i];
    const g = s * scale;
    M2[i] = b1 * m[i] + (1 - b1) * g;
    V2[i] = b2 * v[i] + (1 - b2) * g * g;
    P2[i] = p[i] - lr * wd * p[i] - lr * (M2[i] / c1) / (Math.sqrt(V2[i] / c2) + eps);
  }
  return { p: P2, m: M2, v: V2 };
}

// f32 逐運算模擬（與 WGSL 同一順序）。fl = [lr, b1, omb1, b2, omb2, eps, wd, c1, c2, scale]，已是 f32 值。
// omb1 = 1−b1、omb2 = 1−b2 由主機在 f64 算好再取 f32：若在 f32 裡做 1−f32(b2) 會有 ~3e-5 的相對誤差（已踩過的坑）。
function adamwAccumF32(p, G, K, m, v, fl) {
  const n = p.length, [lr, b1, omb1, b2, omb2, eps, wd, c1, c2, scale] = fl;
  const P2 = new Float32Array(n), M2 = new Float32Array(n), V2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let g = 0;
    for (let k = 0; k < K; k++) g = f32(g + G[k * n + i]);
    g = f32(g * scale);
    const m2 = f32(f32(b1 * m[i]) + f32(omb1 * g));
    const v2 = f32(f32(f32(b2 * v[i]) + f32(f32(omb2 * g) * g)));
    const p0 = p[i];
    M2[i] = m2; V2[i] = v2;
    const decay = f32(f32(lr * wd) * p0);
    const step = f32(f32(f32(lr * f32(m2 / c1)) / f32(f32(Math.sqrt(f32(v2 / c2))) + eps)));
    P2[i] = f32(f32(p0 - decay) - step);
  }
  return { p: P2, m: M2, v: V2 };
}

// 攤平一步的梯度：gradsList 是 K 個與 lora 同結構的梯度物件（grads[l][k][w]）。
function flattenParams(m) {
  const parts = [];
  for (let l = 0; l < m.lora.length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) parts.push(m.lora[l][k][w]);
  return parts;
}
function flattenWith(parts, pick) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Float64Array(n); let o = 0;
  for (const p of parts) { out.set(pick(p), o); o += p.length; }
  return out;
}

// 一步 AdamW（＋梯度平均）：一次派發、一次回讀。st 與 adamInit 相同結構（st.t、st.z[l][k][w].m/.v）。
// opts：與 nn_ops 的 tryLayers 相同（navigator 等）。層：T1（WGSL）→ cpu-js（f64 參考）；回傳 info 記錄實際層。
async function adamStepFused(m, gradsList, st, lr, opts) {
  const K = gradsList.length; if (!K) throw new Error('adamStepFused：至少需要一份梯度');
  const NN = require('./nn_ops.js');
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0, scale = 1 / K;
  const t = st.t + 1;
  const params = flattenParams(m);
  const mParts = [], vParts = [];
  for (let l = 0; l < m.lora.length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) { mParts.push(st.z[l][k][w].m); vParts.push(st.z[l][k][w].v); }
  const n = params.reduce((a, p) => a + p.length, 0);
  const P = flattenWith(params, (x) => x), M = flattenWith(mParts, (x) => x), V = flattenWith(vParts, (x) => x);
  const G = new Float64Array(K * n);
  for (let kk = 0; kk < K; kk++) {
    const flat = [];
    for (let l = 0; l < gradsList[kk].length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) flat.push(gradsList[kk][l][k][w]);
    let o = kk * n; for (const g of flat) { G.set(g, o); o += g.length; }
  }
  const c1 = f32(1 - Math.pow(b1, t)), c2 = f32(1 - Math.pow(b2, t));
  const fl = [f32(lr), f32(b1), f32(1 - b1), f32(b2), f32(1 - b2), f32(eps), f32(wd), c1, c2, f32(scale)];
  const Pf = Float32Array.from(P), Gf = Float32Array.from(G), Mf = Float32Array.from(M), Vf = Float32Array.from(V);
  const { result, info } = await NN.tryLayers('adamw_accum', opts,
    async (dev) => {
      const uni = new ArrayBuffer(48);
      const u32 = new Uint32Array(uni, 0, 2); u32[0] = n; u32[1] = K;
      new Float32Array(uni, 8, 10).set(fl);
      const outs = await NN.runWgsl(dev, WGSL_ADAMW_ACCUM,
        [{ data: Pf, out: true }, { data: Gf, out: false }, { data: Mf, out: true }, { data: Vf, out: true }],
        uni, Math.ceil(n / 64));
      return { p: outs[0], m: outs[1], v: outs[2] };
    },
    null,
    () => adamwAccumRef(P, G, K, M, V, t, lr, b1, b2, eps, wd, scale));
  // 寫回：攤平的結果依同一順序切回每個矩陣
  const writeBack = (parts, src) => { let o = 0; for (const p of parts) { for (let i = 0; i < p.length; i++) p[i] = src[o + i]; o += p.length; } };
  writeBack(params, result.p); writeBack(mParts, result.m); writeBack(vParts, result.v);
  st.t = t;
  return { info, n, K };
}

// 前向精度的能力分支。features：Set、陣列或物件（{ 'shader-f16': true }）。
// 有 shader-f16 → f16 儲存、f32 累加；沒有 → f32。永遠不回傳 'cpu'。
function pickForwardPrecision(features) {
  const has = (name) => !!features && (typeof features.has === 'function' ? features.has(name)
    : Array.isArray(features) ? features.includes(name) : !!features[name]);
  if (has('shader-f16')) return { precision: 'f16', accum: 'f32', reason: 'shader-f16 可用' };
  return { precision: 'f32', accum: 'f32', reason: '無 shader-f16，前向走 f32（不退 CPU）' };
}

module.exports = { WGSL_ADAMW_ACCUM, adamwAccumRef, adamwAccumF32, adamStepFused, pickForwardPrecision, U32 };
