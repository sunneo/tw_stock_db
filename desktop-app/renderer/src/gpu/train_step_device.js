// O8 整步一次提交：前向（所有層）＋交叉熵＋反向（所有層）＋AdamW 全進同一個 createBatch，只在步末回讀 loss 與更新後的參數。
// 新核心（都有 f64 參考與假裝置分支）：
//   attn_fwd      因果注意力前向（一執行緒一個 (詞元, 頭)，寫 ao 與機率 P）
//   attn_bwd_kv   注意力反向 dK、dV（一執行緒一個 (詞元, 頭)，收集 i≥j）
//   attn_bwd_q    注意力反向 dQ（一執行緒一個 (詞元, 頭)，收集 j≤i）
//   rms_bwd       RMSNorm 反向（一執行緒一列）
//   mlp_bwd       SiLU 閘門反向（逐元素：dg、du）
// AdamW 用 train_fused.js 的 adamw_accum（K=1，梯度已先平均）。
// 注意：這一檔的核心只在假裝置上跑過（CPU 參考）；真 Chrome 尚未驗證，見 scripts/eval/o8_train_check.html。
'use strict';
const f32 = Math.fround;
const TF = require('./train_fused.js');

// ---------- WGSL ----------
const WGSL_ATTN_FWD = `
struct P { T: u32, H: u32, hd: u32, sc: f32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> k: array<f32>;
@group(0) @binding(2) var<storage, read> v: array<f32>;
@group(0) @binding(3) var<storage, read_write> ao: array<f32>;
@group(0) @binding(4) var<storage, read_write> pm: array<f32>;
@group(0) @binding(5) var<uniform> u: P;
// 一個工作群組負責一個 (i,h)，64 執行緒：q 列放進共用記憶體 qs；分數 z_j 由 lane j 平行算（不同 j 不同 lane）存進 sc；
// 最大值與和用樹狀歸約；機率寫回 pm（j＞i 為 0）；輸出 ao 的第 t 分量由第 t 條執行緒累加。
// 舊版一執行緒一個 (i,h)：整條 j 迴圈串列、每個分數與輸出都串列讀全域記憶體（與 attn_bwd_kv 同類）。
// 限制：hd ≤ 64、T ≤ 256。
var<workgroup> qs: array<f32, 64>;
var<workgroup> scs: array<f32, 256>;
var<workgroup> rr: array<f32, 64>;
// @kernel attn_fwd
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let idx = w.x;
  if (idx >= u.T * u.H) { return; }
  let i = idx / u.H;
  let h = idx % u.H;
  let d = u.H * u.hd;
  let t = l.x;
  let isAct = t < u.hd;
  var qv: f32 = 0.0;
  if (isAct) { qv = q[i * d + h * u.hd + t]; }
  qs[t] = qv;
  workgroupBarrier();
  for (var j: u32 = t; j <= i; j = j + 64u) {
    var z: f32 = 0.0;
    for (var u2: u32 = 0u; u2 < u.hd; u2 = u2 + 1u) { z = z + qs[u2] * k[j * d + h * u.hd + u2]; }
    scs[j] = z * u.sc;
  }
  workgroupBarrier();
  var m: f32 = -3.0e38;
  for (var j: u32 = t; j <= i; j = j + 64u) { m = max(m, scs[j]); }
  rr[t] = m;
  workgroupBarrier();
  for (var st: u32 = 32u; st > 0u; st = st >> 1u) {
    if (t < st) { rr[t] = max(rr[t], rr[t + st]); }
    workgroupBarrier();
  }
  let mx = rr[0];
  workgroupBarrier();
  var s: f32 = 0.0;
  for (var j: u32 = t; j <= i; j = j + 64u) { let e = exp(scs[j] - mx); scs[j] = e; s = s + e; }
  rr[t] = s;
  workgroupBarrier();
  for (var st: u32 = 32u; st > 0u; st = st >> 1u) {
    if (t < st) { rr[t] = rr[t] + rr[t + st]; }
    workgroupBarrier();
  }
  let sm = rr[0];
  workgroupBarrier();
  let pb = (h * u.T + i) * u.T;
  for (var j: u32 = t; j < u.T; j = j + 64u) {
    if (j <= i) { let p = scs[j] / sm; scs[j] = p; pm[pb + j] = p; } else { pm[pb + j] = 0.0; }
  }
  workgroupBarrier();
  if (isAct) {
    var acc: f32 = 0.0;
    for (var j: u32 = 0u; j <= i; j = j + 1u) { acc = acc + scs[j] * v[j * d + h * u.hd + t]; }
    ao[i * d + h * u.hd + t] = acc;
  }
}
`;
const WGSL_ATTN_BWD_KV = `
struct P { T: u32, H: u32, hd: u32, sc: f32 }
// 注意：不可宣告本體沒用到的綁定。pipeline 用 layout 'auto'，未使用的綁定不會進 bind group layout，
// 綁了它就是驗證錯誤（整個提交被拒，讀回全是 0）。所以 k 不在這裡（dK 只用 q，dV 用 dao、P、v）。
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> v: array<f32>;
@group(0) @binding(2) var<storage, read> dao: array<f32>;
@group(0) @binding(3) var<storage, read> pm: array<f32>;
@group(0) @binding(4) var<storage, read> ao: array<f32>;
@group(0) @binding(5) var<storage, read_write> dk: array<f32>;
@group(0) @binding(6) var<storage, read_write> dv: array<f32>;
@group(0) @binding(7) var<uniform> u: P;
// 一個工作群組負責一個 (j,h)，64 執行緒（每條通道 t＜hd 一個）：dp、di 用共用記憶體樹狀歸約，dk、dv 的第 t 個分量由第 t 條執行緒累加。
// 舊版一執行緒一個 (j,h)、整條 i 迴圈＋每個 t 串列讀全域記憶體：L 規模只有 T·H＝1024 條執行緒、長串列依賴，量到 attn_bwd_kv 佔 GPU 通道時間的 38%（27.6 ms／次）。
// 限制：hd ≤ 64。
// 第二版（2026-11-28）：去掉逐 i 的樹狀歸約（舊版每個 i 要 12 次屏障，i 迴圈最長 T 次）。
// 階段一：lane 平行算每個 i（i≥j）的 p_ij 與 ds_ij（di、dp 各為 hd 長的串列點積，不用屏障），存進共用記憶體 sp／sds；
// 屏障一次；階段二：第 t 條執行緒對 i 串列累加 dv[j,t]＝Σ p·dao 與 dk[j,t]＝Σ ds·q（共用記憶體讀取＋全域讀取，無屏障）。
// 屏障只有一次。限制：hd ≤ 64、T ≤ 256。
var<workgroup> sp: array<f32, 256>;
var<workgroup> sds: array<f32, 256>;
var<workgroup> pv: array<f32, 64>;
var<workgroup> pk: array<f32, 64>;
// @kernel attn_bwd_kv
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let idx = w.x;
  if (idx >= u.T * u.H) { return; }
  let j = idx / u.H;
  let h = idx % u.H;
  let d = u.H * u.hd;
  let t = l.x;
  for (var i: u32 = t; i < u.T; i = i + 64u) {
    if (i >= j) {
      var di: f32 = 0.0;
      var dp: f32 = 0.0;
      for (var u2: u32 = 0u; u2 < u.hd; u2 = u2 + 1u) {
        let go = dao[i * d + h * u.hd + u2];
        di = di + go * ao[i * d + h * u.hd + u2];
        dp = dp + go * v[j * d + h * u.hd + u2];
      }
      let p = pm[(h * u.T + i) * u.T + j];
      sp[i] = p;
      sds[i] = p * (dp - di) * u.sc;
    } else {
      sp[i] = 0.0;
      sds[i] = 0.0;
    }
  }
  workgroupBarrier();
  // 階段二（分塊）：64 條執行緒 = nch 個 i 分塊 × hd 個分量（需 hd 為 64 的因數，即 8、16、32、64）；
  // 每條執行緒只串列走 T/nch 個 i，再由第 t 分量的 nch 個部分和相加（一次屏障）。
  let nch = 64u / u.hd;
  let c = t / u.hd;
  let tt = t % u.hd;
  var dvv: f32 = 0.0;
  var dkv: f32 = 0.0;
  for (var i: u32 = c; i < u.T; i = i + nch) {
    dvv = dvv + sp[i] * dao[i * d + h * u.hd + tt];
    dkv = dkv + sds[i] * q[i * d + h * u.hd + tt];
  }
  pv[t] = dvv;
  pk[t] = dkv;
  workgroupBarrier();
  if (t < u.hd) {
    var av: f32 = 0.0;
    var ak: f32 = 0.0;
    for (var cc: u32 = 0u; cc < nch; cc = cc + 1u) {
      av = av + pv[cc * u.hd + t];
      ak = ak + pk[cc * u.hd + t];
    }
    dk[j * d + h * u.hd + t] = ak;
    dv[j * d + h * u.hd + t] = av;
  }
}
`;
const WGSL_ATTN_BWD_Q = `
struct P { T: u32, H: u32, hd: u32, sc: f32 }
@group(0) @binding(0) var<storage, read> k: array<f32>;
@group(0) @binding(1) var<storage, read> v: array<f32>;
@group(0) @binding(2) var<storage, read> dao: array<f32>;
@group(0) @binding(3) var<storage, read> pm: array<f32>;
@group(0) @binding(4) var<storage, read> ao: array<f32>;
@group(0) @binding(5) var<storage, read_write> dq: array<f32>;
@group(0) @binding(6) var<uniform> u: P;
// 一個工作群組負責一個 (i,h)，64 執行緒：dao 列放進共用記憶體 gs，di 用樹狀歸約；
// 各 j 的 ds_j 由不同執行緒平行算（lane j 讀 gs 與 v 列），存進共用記憶體 sds；最後第 t 條執行緒累加 dq 的第 t 分量。
// 舊版一執行緒一個 (i,h)：整條 j 迴圈串列、每個 j 再串列讀 hd 個全域值（與 attn_bwd_kv 同類）。
// 限制：hd ≤ 64、T ≤ 256。
var<workgroup> gs: array<f32, 64>;
var<workgroup> rdi: array<f32, 64>;
var<workgroup> sds: array<f32, 256>;
// @kernel attn_bwd_q
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let idx = w.x;
  if (idx >= u.T * u.H) { return; }
  let i = idx / u.H;
  let h = idx % u.H;
  let d = u.H * u.hd;
  let t = l.x;
  let isAct = t < u.hd;
  var g: f32 = 0.0;
  var pa: f32 = 0.0;
  if (isAct) {
    g = dao[i * d + h * u.hd + t];
    pa = g * ao[i * d + h * u.hd + t];
  }
  gs[t] = g;
  rdi[t] = pa;
  workgroupBarrier();
  for (var st: u32 = 32u; st > 0u; st = st >> 1u) {
    if (t < st) { rdi[t] = rdi[t] + rdi[t + st]; }
    workgroupBarrier();
  }
  let di = rdi[0];
  for (var j: u32 = t; j <= i; j = j + 64u) {
    var dp: f32 = 0.0;
    for (var u2: u32 = 0u; u2 < u.hd; u2 = u2 + 1u) { dp = dp + gs[u2] * v[j * d + h * u.hd + u2]; }
    sds[j] = pm[(h * u.T + i) * u.T + j] * (dp - di) * u.sc;
  }
  workgroupBarrier();
  if (isAct) {
    var acc: f32 = 0.0;
    for (var j: u32 = 0u; j <= i; j = j + 1u) { acc = acc + sds[j] * k[j * d + h * u.hd + t]; }
    dq[i * d + h * u.hd + t] = acc;
  }
}
`;
const WGSL_RMS_BWD = `
struct P { T: u32, d: u32, eps: f32 }
@group(0) @binding(0) var<storage, read> dy: array<f32>;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> g: array<f32>;
@group(0) @binding(3) var<storage, read_write> dx: array<f32>;
@group(0) @binding(4) var<uniform> u: P;
// @kernel rms_bwd
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= u.T) { return; }
  var ss: f32 = 0.0;
  for (var i: u32 = 0u; i < u.d; i = i + 1u) { ss = ss + x[t * u.d + i] * x[t * u.d + i]; }
  let inv = 1.0 / sqrt(ss / f32(u.d) + u.eps);
  var md: f32 = 0.0;
  for (var i: u32 = 0u; i < u.d; i = i + 1u) { md = md + dy[t * u.d + i] * g[i] * x[t * u.d + i] * inv; }
  md = md / f32(u.d);
  for (var i: u32 = 0u; i < u.d; i = i + 1u) {
    let xh = x[t * u.d + i] * inv;
    dx[t * u.d + i] = inv * (dy[t * u.d + i] * g[i] - xh * md);
  }
}
`;
const WGSL_MLP_BWD = `
struct P { n: u32 }
@group(0) @binding(0) var<storage, read> da: array<f32>;
@group(0) @binding(1) var<storage, read> gg: array<f32>;
@group(0) @binding(2) var<storage, read> uu: array<f32>;
@group(0) @binding(3) var<storage, read_write> dg: array<f32>;
@group(0) @binding(4) var<storage, read_write> du: array<f32>;
@group(0) @binding(5) var<uniform> u: P;
// @kernel mlp_bwd
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  let gi = gg[i];
  let sg = 1.0 / (1.0 + exp(-gi));
  du[i] = da[i] * gi * sg;
  dg[i] = da[i] * uu[i] * sg * (1.0 + gi * (1.0 - sg));
}
`;

// f32 → f16 儲存（只在 shader-f16 時使用）。輸出是 array<f16>，句柄帶 f16:true，給 f16 矩陣乘當輸入。
const WGSL_CAST16 = `enable f16;
struct P { n: u32 }
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f16>;
@group(0) @binding(2) var<uniform> u: P;
// @kernel cast_f16
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  dst[i] = f16(src[i]);
}
`;

// ---------- f64 參考（與 lora_ref_train.js 的 lossAndGrads 逐式相同） ----------
function attnFwdRef(q, k, v, T, H, hd) {
  const d = H * hd, sc = 1 / Math.sqrt(hd), pm = new Float64Array(H * T * T), ao = new Float64Array(T * d);
  for (let h = 0; h < H; h++) for (let i = 0; i < T; i++) {
    const pb = (h * T + i) * T; let mx = -Infinity;
    for (let j = 0; j <= i; j++) { let z = 0; for (let t = 0; t < hd; t++) z += q[i * d + h * hd + t] * k[j * d + h * hd + t]; z *= sc; pm[pb + j] = z; if (z > mx) mx = z; }
    let sum = 0; for (let j = 0; j <= i; j++) { pm[pb + j] = Math.exp(pm[pb + j] - mx); sum += pm[pb + j]; }
    for (let j = 0; j <= i; j++) pm[pb + j] /= sum;
    for (let t = 0; t < hd; t++) { let z = 0; for (let j = 0; j <= i; j++) z += pm[pb + j] * v[j * d + h * hd + t]; ao[i * d + h * hd + t] = z; }
  }
  return { ao, pm };
}
function attnBwdRef(dao, q, k, v, pm, T, H, hd) {
  const d = H * hd, sc = 1 / Math.sqrt(hd);
  const dq = new Float64Array(T * d), dk = new Float64Array(T * d), dv = new Float64Array(T * d);
  for (let h = 0; h < H; h++) for (let i = 0; i < T; i++) {
    const pb = (h * T + i) * T; const dP = new Float64Array(i + 1); let dot = 0;
    for (let j = 0; j <= i; j++) { let z = 0; for (let t = 0; t < hd; t++) z += dao[i * d + h * hd + t] * v[j * d + h * hd + t]; dP[j] = z; dot += z * pm[pb + j]; }
    for (let j = 0; j <= i; j++) {
      const p = pm[pb + j], ds = p * (dP[j] - dot) * sc;
      for (let t = 0; t < hd; t++) {
        dv[j * d + h * hd + t] += p * dao[i * d + h * hd + t];
        dk[j * d + h * hd + t] += ds * q[i * d + h * hd + t];
        dq[i * d + h * hd + t] += ds * k[j * d + h * hd + t];
      }
    }
  }
  return { dq, dk, dv };
}
function rmsBwdRef(dy, x, g, T, d, eps) {
  const dx = new Float64Array(T * d);
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let i = 0; i < d; i++) ss += x[t * d + i] * x[t * d + i];
    const inv = 1 / Math.sqrt(ss / d + eps);
    let md = 0; for (let i = 0; i < d; i++) md += dy[t * d + i] * g[i] * x[t * d + i] * inv; md /= d;
    for (let i = 0; i < d; i++) dx[t * d + i] = inv * (dy[t * d + i] * g[i] - x[t * d + i] * inv * md);
  }
  return dx;
}
function mlpBwdRef(da, g, u) {
  const n = g.length, dg = new Float64Array(n), du = new Float64Array(n);
  for (let i = 0; i < n; i++) { const sg = 1 / (1 + Math.exp(-g[i])); du[i] = da[i] * g[i] * sg; dg[i] = da[i] * u[i] * sg * (1 + g[i] * (1 - sg)); }
  return { dg, du };
}

// ---------- 批次運算（掛在 nn.createBatch 的批次上：alloc＋dispatchRaw，不回讀） ----------
function extend(b) {
  const r = {};
  r.attnFwd = (q, k, v, T, H, hd) => {
    const ao = b.alloc(T * H * hd), pm = b.alloc(H * T * T);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    b.dispatchRaw(WGSL_ATTN_FWD, [q.buf, k.buf, v.buf, ao.buf, pm.buf], uni, T * H);   // 一個 (i,h) 一個工作群組
    return { ao: ao, pm: pm };
  };
  r.attnBwd = (dao, q, k, v, ao, pm, T, H, hd) => {
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    const dk = b.alloc(T * H * hd), dv = b.alloc(T * H * hd), dq = b.alloc(T * H * hd);
    b.dispatchRaw(WGSL_ATTN_BWD_KV, [q.buf, v.buf, dao.buf, pm.buf, ao.buf, dk.buf, dv.buf], uni, T * H);   // 一個 (j,h) 一個工作群組（見 WGSL_ATTN_BWD_KV）
    b.dispatchRaw(WGSL_ATTN_BWD_Q, [k.buf, v.buf, dao.buf, pm.buf, ao.buf, dq.buf], uni, T * H);   // 一個 (i,h) 一個工作群組
    return { dq: dq, dk: dk, dv: dv };
  };
  r.rmsnormBwd = (dy, x, g, T, d, eps) => {
    const dx = b.alloc(T * d);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([T, d]); new Float32Array(uni, 8, 1)[0] = eps;
    b.dispatchRaw(WGSL_RMS_BWD, [dy.buf, x.buf, g.buf, dx.buf], uni, Math.ceil(T / 64));
    return dx;
  };
  r.mlpBwd = (da, g, u, n) => {
    const dg = b.alloc(n), du = b.alloc(n);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = n;
    b.dispatchRaw(WGSL_MLP_BWD, [da.buf, g.buf, u.buf, dg.buf, du.buf], uni, Math.ceil(n / 64));
    return { dg: dg, du: du };
  };
  // AdamW（梯度 g 已平均）：p、m、v 原地更新；fl = [lr, b1, omb1, b2, omb2, eps, wd, c1, c2, scale]，與 train_fused 的 adamw_accum 相同佈局
  r.adamw = (p, g, m, v, n, fl) => {
    const uni = new ArrayBuffer(48); new Uint32Array(uni, 0, 2).set([n, 1]); new Float32Array(uni, 8, 10).set(fl);
    b.dispatchRaw(TF.WGSL_ADAMW_ACCUM, [p.buf, g.buf, m.buf, v.buf], uni, Math.ceil(n / 64));
  };
  // LoRA 投影（前向）：y＝X·W＋s·(X·A)·B；X、A、B、W 都是句柄。回傳 y 與 xA。
  // x16、W16（選用）：f16 版的輸入與權重，有的話基底 X·W 走 f16 矩陣乘（只影響前向；XA 仍用 f32）
  r.cast16 = (x) => {
    const o = b.alloc(x.n);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = x.n;
    b.dispatchRaw(WGSL_CAST16, [x.buf, o.buf], uni, Math.ceil(x.n / 64));
    return { buf: o.buf, n: x.n, f16: true };
  };
  r.loraFwd = (x, Wh, Ah, Bh, s, T, din, dout, rr, x16, W16) => {
    const xA = b.matmul(x, Ah, T, din, rr);
    const base = x16 && W16 ? b.matmul(x16, W16, T, din, dout, { f16: true }) : b.matmul(x, Wh, T, din, dout);
    const br = b.matmul(xA, Bh, T, rr, dout);
    return { y: b.axpy(base, br, s), xA: xA };
  };
  // LoRA 投影（反向）：與 cudaweb_runtime 的 loraBwdMany 相同公式，回傳 dA、dB、dx（句柄）
  r.loraBwd = (dy, x, Wh, Ah, Bh, xA, s, T, din, dout, rr) => {
    const dB = b.scal(b.matmul(xA, dy, rr, T, dout, { transA: true }), s);
    const dxA = b.scal(b.matmul(dy, Bh, T, dout, rr, { transB: true }), s);
    const dA = b.matmul(x, dxA, din, T, rr, { transA: true });
    const dx = b.matmul(dy, Wh, T, dout, din, { transB: true });
    const dx2 = b.matmul(dxA, Ah, T, rr, din, { transB: true });
    return { dA: dA, dB: dB, dx: b.axpy(dx, dx2, 1) };
  };
  return Object.assign(r, { b: b });
}

// ---------- 整步：一個批次 ----------
// o: { nn, device, model, seqs: [tokens...], st (adamInit 結構), lr }
// 回傳 { loss（K 條序列的平均）, t }；並把更新後的 LoRA 參數與 AdamW 狀態寫回 model、st。
// 只做一次 submit：loss（每條序列的逐列 −log p）與所有參數／狀態在步末一起回讀。
async function trainStepDevice(o) {
  const { nn, device, model: m, seqs, st, lr } = o;
  const B = nn.createBatch(device), X = extend(B);
  // f16 能力分支：呼叫端要求（o.f16）且裝置真的有 shader-f16；否則整步全部 f32
  const f16 = !!o.f16 && !!device.features && typeof device.features.has === 'function' && device.features.has('shader-f16');
  const { V, d, L, H, F, r } = m.cfg; const hd = d / H; const s = (m.cfg.alpha || r) / r; const K = seqs.length;
  const t = st.t + 1, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
  const fl = [lr, b1, 1 - b1, b2, 1 - b2, eps, 0, c1, c2, 1].map(f32);
  const up = (a) => B.upload(a instanceof Float32Array ? a : Float32Array.from(a));
  // 參數句柄（所有序列共用；AdamW 會原地更新，所以要在步末回讀）
  const LW = m.layers.map((P) => ({ Wq: up(P.Wq), Wk: up(P.Wk), Wv: up(P.Wv), Wo: up(P.Wo), Wg: up(P.Wg), Wu: up(P.Wu), Wd: up(P.Wd), n1: up(P.n1), n2: up(P.n2) }));
  if (f16) m.layers.forEach((P, l) => { Object.assign(LW[l], { Wq16: B.uploadF16(P.Wq), Wk16: B.uploadF16(P.Wk), Wv16: B.uploadF16(P.Wv), Wg16: B.uploadF16(P.Wg), Wu16: B.uploadF16(P.Wu) }); });
  const LH = m.lora.map((lo) => { const o2 = {}; for (const key of ['q', 'k', 'v', 'o']) o2[key] = { A: up(lo[key].A), B: up(lo[key].B) }; return o2; });
  const nfH = up(m.nf), embH = up(m.emb);
  const mats = []; // 用於 AdamW 與回讀：{ l, key, w, p, rawLen }
  for (let l = 0; l < L; l++) for (const key of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) mats.push({ l, key, w, p: LH[l][key][w], n: m.lora[l][key][w].length });
  const gacc = {}; // gacc[l][key][w] = 句柄（K 條序列的梯度和）
  const lossRows = [];
  for (const tokens of seqs) {
    const T = tokens.length - 1, inp = tokens.slice(0, T), tgt = tokens.slice(1);
    const h0 = new Float64Array(T * d); for (let i = 0; i < T; i++) for (let j = 0; j < d; j++) h0[i * d + j] = m.emb[inp[i] * d + j];
    // ---- 前向 ----
    const cache = [];
    let h = up(h0);
    for (let l = 0; l < L; l++) {
      const P = LW[l], lo = LH[l], c = { hIn: h };
      c.n1 = B.rmsnorm(h, P.n1, T, d, 1e-6);
      const x16 = f16 ? X.cast16(c.n1) : null;
      const q0 = X.loraFwd(c.n1, P.Wq, lo.q.A, lo.q.B, s, T, d, d, lo.q.A.n / d, x16, P.Wq16);
      const k0 = X.loraFwd(c.n1, P.Wk, lo.k.A, lo.k.B, s, T, d, d, lo.k.A.n / d, x16, P.Wk16);
      const v0 = X.loraFwd(c.n1, P.Wv, lo.v.A, lo.v.B, s, T, d, d, lo.v.A.n / d, x16, P.Wv16);
      c.qXA = q0.xA; c.kXA = k0.xA; c.vXA = v0.xA;
      c.q = B.rope(q0.y, T, H, hd, 1); c.k = B.rope(k0.y, T, H, hd, 1); c.v = v0.y;
      const at = X.attnFwd(c.q, c.k, c.v, T, H, hd); c.ao = at.ao; c.pm = at.pm;
      const o2 = X.loraFwd(c.ao, P.Wo, lo.o.A, lo.o.B, s, T, d, d, lo.o.A.n / d);
      c.oXA = o2.xA;
      c.h1 = B.axpy(h, o2.y, 1);
      c.n2 = B.rmsnorm(c.h1, P.n2, T, d, 1e-6);
      if (f16) { const n216 = X.cast16(c.n2); c.g = B.matmul(n216, P.Wg16, T, d, F, { f16: true }); c.u = B.matmul(n216, P.Wu16, T, d, F, { f16: true }); }
      else { c.g = B.matmul(c.n2, P.Wg, T, d, F); c.u = B.matmul(c.n2, P.Wu, T, d, F); }
      c.a = B.mul(B.silu(c.g), c.u);
      const dn = B.matmul(c.a, P.Wd, T, F, d);
      h = B.axpy(c.h1, dn, 1);
      cache.push(c);
    }
    // ---- 頭：norm → logits → 交叉熵 → dh ----
    const nf = B.rmsnorm(h, nfH, T, d, 1e-6);
    const logits = B.matmul(nf, embH, T, d, V, { transB: true });
    const ce = B.crossEntropy(logits, B.uploadU32(Uint32Array.from(tgt)), T, V, 1 / T);
    lossRows.push({ rows: ce.rows, T: T });
    const dhHead = B.matmul(ce.dl, embH, T, V, d);
    // ---- 反向 ----
    let dh = X.rmsnormBwd(dhHead, h, nfH, T, d, 1e-6);
    const grads = new Array(L);
    const acc = (l, key, w, hnd) => { gacc[l] = gacc[l] || {}; gacc[l][key] = gacc[l][key] || {}; const prev = gacc[l][key][w]; gacc[l][key][w] = prev ? B.axpy(prev, hnd, 1) : hnd; };
    for (let l = L - 1; l >= 0; l--) {
      const P = LW[l], lo = LH[l], c = cache[l];
      const da = B.matmul(dh, P.Wd, T, d, F, { transB: true });
      const mg = X.mlpBwd(da, c.g, c.u, T * F);
      const dn2 = B.axpy(B.matmul(mg.dg, P.Wg, T, F, d, { transB: true }), B.matmul(mg.du, P.Wu, T, F, d, { transB: true }), 1);
      const dh1 = B.axpy(X.rmsnormBwd(dn2, c.h1, P.n2, T, d, 1e-6), dh, 1);
      const ob = X.loraBwd(dh1, c.ao, P.Wo, lo.o.A, lo.o.B, c.oXA, s, T, d, d, lo.o.A.n / d);
      acc(l, 'o', 'A', ob.dA); acc(l, 'o', 'B', ob.dB);
      const ab = X.attnBwd(ob.dx, c.q, c.k, c.v, c.ao, c.pm, T, H, hd);
      const dq0 = B.rope(ab.dq, T, H, hd, -1), dk0 = B.rope(ab.dk, T, H, hd, -1), dv0 = ab.dv;
      const gq = X.loraBwd(dq0, c.n1, P.Wq, lo.q.A, lo.q.B, c.qXA, s, T, d, d, lo.q.A.n / d);
      const gk = X.loraBwd(dk0, c.n1, P.Wk, lo.k.A, lo.k.B, c.kXA, s, T, d, d, lo.k.A.n / d);
      const gv = X.loraBwd(dv0, c.n1, P.Wv, lo.v.A, lo.v.B, c.vXA, s, T, d, d, lo.v.A.n / d);
      acc(l, 'q', 'A', gq.dA); acc(l, 'q', 'B', gq.dB); acc(l, 'k', 'A', gk.dA); acc(l, 'k', 'B', gk.dB); acc(l, 'v', 'A', gv.dA); acc(l, 'v', 'B', gv.dB);
      const dn1 = B.axpy(B.axpy(gq.dx, gk.dx, 1), gv.dx, 1);
      dh = B.axpy(X.rmsnormBwd(dn1, c.hIn, P.n1, T, d, 1e-6), dh1, 1);
    }
  }
  // ---- AdamW（梯度取平均）----
  const stHandles = mats.map((x) => ({ m: up(st.z[x.l][x.key][x.w].m), v: up(st.z[x.l][x.key][x.w].v) }));
  mats.forEach((x, i) => {
    const gavg = B.scal(gacc[x.l][x.key][x.w], 1 / K);
    X.adamw(x.p, gavg, stHandles[i].m, stHandles[i].v, x.n, fl);
  });
  // ---- 步末唯一的一次回讀 ----
  const specs = [];
  for (const lr2 of lossRows) specs.push([lr2.rows, lr2.T]);
  for (let i = 0; i < mats.length; i++) specs.push([mats[i].p, mats[i].n], [stHandles[i].m, mats[i].n], [stHandles[i].v, mats[i].n]);
  const outs = await B.read(specs);
  let loss = 0;
  lossRows.forEach((lr2, k) => { let sr = 0; for (let i = 0; i < lr2.T; i++) sr += outs[k][i]; loss += (sr / lr2.T) / K; });
  mats.forEach((x, i) => {
    const pv = outs[lossRows.length + 3 * i], mv = outs[lossRows.length + 3 * i + 1], vv = outs[lossRows.length + 3 * i + 2];
    m.lora[x.l][x.key][x.w].set(pv);
    const sl = st.z[x.l][x.key][x.w]; sl.m.set(mv); sl.v.set(vv);
  });
  st.t = t;
  return { loss: loss, t: t, precision: f16 ? 'f16' : 'f32' };
}

// ===== 佈局改善（P1 GPU 原則 1＋2）：K 以 [H][hd][T] 儲存，讓分數點積的 lane（沿 j）讀連續位址 =====
// 轉置只在 K 投影輸出端做一次（WGSL_TRANSPOSE_TH），不在每個注意力核心裡做。
// WGSL_TRANSPOSE_TH：src 是 [T][H·hd]（列主序），dst 是 [H][hd][T]。
const WGSL_TRANSPOSE_TH = `
struct P { T: u32, H: u32, hd: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> u: P;
// @kernel transpose_th
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let o = gid.x;
  let d = u.H * u.hd;
  if (o >= u.T * d) { return; }
  let t = o / d;
  let r = o % d;
  let h = r / u.hd;
  let c = r % u.hd;
  dst[(h * u.hd + c) * u.T + t] = src[o];
}
`;
// 前向（K 轉置版）：與 WGSL_ATTN_FWD 同一演算法；差別兩處：
// (1) 分數點積讀 kt[(h·hd+c)·T + j]（lane 沿 j → 連續位址，合併）；
// (2) PV 的串列 j 迴圈改成四路獨立累加（同一 lane 內的記憶體級平行，蓋住 V 的全域讀取延遲）。
const WGSL_ATTN_FWD_KT = (() => {
  let s = WGSL_ATTN_FWD;
  const rep = (from, to) => { if (s.indexOf(from) < 0) throw new Error('attn_fwd_kt 替換失敗：' + from.slice(0, 60)); s = s.split(from).join(to); };
  rep('// @kernel attn_fwd', '// @kernel attn_fwd_kt');
  rep('for (var u2: u32 = 0u; u2 < u.hd; u2 = u2 + 1u) { z = z + qs[u2] * k[j * d + h * u.hd + u2]; }',
      'for (var u2: u32 = 0u; u2 < u.hd; u2 = u2 + 1u) { z = z + qs[u2] * k[(h * u.hd + u2) * u.T + j]; }');
  rep('for (var j: u32 = 0u; j <= i; j = j + 1u) { acc = acc + scs[j] * v[j * d + h * u.hd + t]; }',
      'var a1: f32 = 0.0; var a2: f32 = 0.0; var a3: f32 = 0.0;\n' +
      '    var jj: u32 = 0u;\n' +
      '    loop { if (jj + 3u > i) { break; } acc = acc + scs[jj] * v[jj * d + h * u.hd + t]; a1 = a1 + scs[jj + 1u] * v[(jj + 1u) * d + h * u.hd + t]; a2 = a2 + scs[jj + 2u] * v[(jj + 2u) * d + h * u.hd + t]; a3 = a3 + scs[jj + 3u] * v[(jj + 3u) * d + h * u.hd + t]; jj = jj + 4u; }\n' +
      '    loop { if (jj > i) { break; } acc = acc + scs[jj] * v[jj * d + h * u.hd + t]; jj = jj + 1u; }\n' +
      '    acc = (acc + a1) + (a2 + a3);');
  return s;
})();

// 反向 dq（V 轉置版）：dP[i,j] = dao[i]·v[j] 的 v 改讀 vt[(h·hd+c)·T + j]（lane 沿 j → 合併）；
// dq 的串列 j 迴圈（讀 K，lane 沿 c 已合併）改四路獨立累加。K 維持原佈局（lane 沿 c 本來就合併）。
const WGSL_ATTN_BWD_Q_VT = (() => {
  let s = WGSL_ATTN_BWD_Q;
  const rep = (from, to) => { if (s.indexOf(from) < 0) throw new Error('attn_bwd_q_vt 替換失敗：' + from.slice(0, 60)); s = s.split(from).join(to); };
  rep('// @kernel attn_bwd_q', '// @kernel attn_bwd_q_vt');
  // 順便把每列的 di（Σ dao·ao，只與 i、h 有關）寫進 dio[h·T+i]，供 attn_bwd_kv 直接讀，不必每個 (j,h) 重算
  rep('@group(0) @binding(6) var<uniform> u: P;', '@group(0) @binding(6) var<storage, read_write> dio: array<f32>;\n@group(0) @binding(7) var<uniform> u: P;');
  rep('  let di = rdi[0];', '  let di = rdi[0];\n  if (t == 0u) { dio[h * u.T + i] = di; }');
  rep('dp = dp + gs[u2] * v[j * d + h * u.hd + u2];', 'dp = dp + gs[u2] * v[(h * u.hd + u2) * u.T + j];');
  rep('for (var j: u32 = 0u; j <= i; j = j + 1u) { acc = acc + sds[j] * k[j * d + h * u.hd + t]; }',
      'var a1: f32 = 0.0; var a2: f32 = 0.0; var a3: f32 = 0.0;\n' +
      '    var jj: u32 = 0u;\n' +
      '    loop { if (jj + 3u > i) { break; } acc = acc + sds[jj] * k[jj * d + h * u.hd + t]; a1 = a1 + sds[jj + 1u] * k[(jj + 1u) * d + h * u.hd + t]; a2 = a2 + sds[jj + 2u] * k[(jj + 2u) * d + h * u.hd + t]; a3 = a3 + sds[jj + 3u] * k[(jj + 3u) * d + h * u.hd + t]; jj = jj + 4u; }\n' +
      '    loop { if (jj > i) { break; } acc = acc + sds[jj] * k[jj * d + h * u.hd + t]; jj = jj + 1u; }\n' +
      '    acc = (acc + a1) + (a2 + a3);');
  return s;
})();

// 反向 dK、dV（讀 di 緩衝）：與 WGSL_ATTN_BWD_KV 相同，只把 di 的 hd 長點積改成讀 dio[h·T+i]（由 Q_VT 寫入）。
// 綁定：0 q、1 v、2 dao、3 pm、4 dio（讀）、5 dk、6 dv、7 uniform。
const WGSL_ATTN_BWD_KV_DI = (() => {
  let s = WGSL_ATTN_BWD_KV;
  const rep = (from, to) => { if (s.indexOf(from) < 0) throw new Error('attn_bwd_kv_di 替換失敗：' + from.slice(0, 60)); s = s.split(from).join(to); };
  rep('@group(0) @binding(4) var<storage, read> ao: array<f32>;', '@group(0) @binding(4) var<storage, read> dio: array<f32>;');
  rep('      var di: f32 = 0.0;\n', '');
  rep('        di = di + go * ao[i * d + h * u.hd + u2];\n', '');
  rep('sds[i] = p * (dp - di) * u.sc;', 'sds[i] = p * (dp - dio[h * u.T + i]) * u.sc;');
  // dao 轉置（[H][hd][T]）：第一階段 lane 沿 i，dP 的 dao 讀取改成 daoT[(h·hd+u2)·T+i]，合併；第二階段仍讀原 dao（lane 沿 tt 已合併）
  rep('        let go = dao[i * d + h * u.hd + u2];', '        let go = daoT[(h * u.hd + u2) * u.T + i];');
  rep('@group(0) @binding(7) var<uniform> u: P;', '@group(0) @binding(7) var<storage, read> daoT: array<f32>;\n@group(0) @binding(8) var<uniform> u: P;');
  rep('// @kernel attn_bwd_kv\n', '// @kernel attn_bwd_kv_dit\n');
  // 第二階段四路展開：每次迭代同時發出四組獨立的 dao／q 讀取再累加（原本是串列相依鏈，延遲受限）
  rep('  for (var i: u32 = c; i < u.T; i = i + nch) {\n    dvv = dvv + sp[i] * dao[i * d + h * u.hd + tt];\n    dkv = dkv + sds[i] * q[i * d + h * u.hd + tt];\n  }',
      '  var i2: u32 = c;\n' +
      '  loop {\n' +
      '    if (i2 + 3u * nch >= u.T) { break; }\n' +
      '    let a0 = dao[i2 * d + h * u.hd + tt]; let a1 = dao[(i2 + nch) * d + h * u.hd + tt];\n' +
      '    let a2 = dao[(i2 + 2u * nch) * d + h * u.hd + tt]; let a3 = dao[(i2 + 3u * nch) * d + h * u.hd + tt];\n' +
      '    let b0 = q[i2 * d + h * u.hd + tt]; let b1 = q[(i2 + nch) * d + h * u.hd + tt];\n' +
      '    let b2 = q[(i2 + 2u * nch) * d + h * u.hd + tt]; let b3 = q[(i2 + 3u * nch) * d + h * u.hd + tt];\n' +
      '    dvv = dvv + sp[i2] * a0 + sp[i2 + nch] * a1 + sp[i2 + 2u * nch] * a2 + sp[i2 + 3u * nch] * a3;\n' +
      '    dkv = dkv + sds[i2] * b0 + sds[i2 + nch] * b1 + sds[i2 + 2u * nch] * b2 + sds[i2 + 3u * nch] * b3;\n' +
      '    i2 = i2 + 4u * nch;\n' +
      '  }\n' +
      '  loop {\n' +
      '    if (i2 >= u.T) { break; }\n' +
      '    dvv = dvv + sp[i2] * dao[i2 * d + h * u.hd + tt];\n' +
      '    dkv = dkv + sds[i2] * q[i2 * d + h * u.hd + tt];\n' +
      '    i2 = i2 + nch;\n' +
      '  }');
  return s;
})();

module.exports = { trainStepDevice, WGSL_CAST16, WGSL_ATTN_FWD, WGSL_ATTN_BWD_KV, WGSL_ATTN_BWD_Q, WGSL_RMS_BWD, WGSL_MLP_BWD,
  WGSL_TRANSPOSE_TH, WGSL_ATTN_FWD_KT, WGSL_ATTN_BWD_Q_VT, WGSL_ATTN_BWD_KV_DI, attnFwdRef, attnBwdRef, rmsBwdRef, mlpBwdRef };
