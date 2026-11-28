'use strict';
// 全參數整步（密集 transformer）：所有線性層、嵌入、輸出頭、RMSNorm 增益都求權重梯度，全部留在 GPU。
// 以 train_step_device.js 的 trainStepDevice 為底（不改它）。差別：
//   · 基底權重可訓練（dW = Xᵀ·dY，用 matmul 的 transA 旗標）；
//   · 嵌入查表用 one-hot 矩陣乘（不經 JS 陣列）；嵌入梯度 = onehotᵀ·dh（＋輸出頭梯度）；
//   · RMSNorm 增益梯度 = 列加總(dy ∘ x̂)，x̂ = rmsnorm(x, 1)；
//   · 分組查詢（kvH < H）：k、v 用 0/1 擴張矩陣 E（kvH·hd × H·hd）擴成 H 個頭；反向用 Eᵀ 加總回 kvH 個頭（全是矩陣乘，沒有新核心）；
//   · qk-norm：q、k 各自每頭 RMSNorm（寬度 hd，增益 qn／kn），在 RoPE 之前（與 llm_scratch 相同）；反向含增益梯度；
//   · RoPE 用 0/1 排列矩陣轉成 rotate-half（精確）；
//   · 梯度裁剪在 GPU 上做（總平方和 → 純量核心 clip_coef → 梯度乘係數）；
//   · AdamW 沿用 train_fused.js 的 WGSL_ADAMW_ACCUM。
// 狀態（參數、m、v）是常駐 GPU 緩衝區（不在批次暫存池裡），AdamW 原地更新；步末只讀回損失列與梯度平方和。
// 限制（明寫）：f32。注意力核心仍假設 H 個頭（GQA 是用擴張矩陣實現，不是核心改寫）。
const TS = require('./train_step_device.js');
const TF = require('./train_fused.js');

const USAGE_STORAGE = 0x80, USAGE_COPY_SRC = 0x4, USAGE_COPY_DST = 0x8;
const f32 = Math.fround;
const EPS = 1e-6;

// 裁剪係數核心：coef = min(1, maxNorm / (√tot + 1e-6))；tot 是總平方和（單一元素緩衝）
const WGSL_CLIP_COEF = `
struct P { maxn: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<storage, read> tot: array<f32>;
@group(0) @binding(1) var<storage, read_write> coef: array<f32>;
@group(0) @binding(2) var<uniform> u: P;
// @kernel clip_coef
@compute @workgroup_size(1)
fn main() {
  let nrm = sqrt(tot[0]);
  coef[0] = min(1.0, u.maxn / (nrm + 1e-6));
}
`;

// 平方和（並行歸約）：每個張量一個工作群組（256 執行緒跨步累加＋樹狀歸約），結果寫進 parts[slot]。
// 取代先前的 matmul(1×n×1)：那個形狀只有一個輸出，整個 K=n 的迴圈落在單一工作群組上，L 規模慢到幾百 ms。
const WGSL_SUMSQ = `
struct P { n: u32, slot: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> g: array<f32>;
@group(0) @binding(1) var<storage, read_write> parts: array<f32>;
@group(0) @binding(2) var<uniform> u: P;
var<workgroup> sh: array<f32, 256>;
// @kernel sumsq_slot
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  var s: f32 = 0.0;
  var i: u32 = lid.x;
  loop { if (i >= u.n) { break; } let v = g[i]; s = s + v * v; i = i + 256u; }
  sh[lid.x] = s;
  workgroupBarrier();
  var st: u32 = 128u;
  loop { if (st == 0u) { break; } if (lid.x < st) { sh[lid.x] = sh[lid.x] + sh[lid.x + st]; } workgroupBarrier(); st = st / 2u; }
  if (lid.x == 0u) { parts[u.slot] = sh[0]; }
}
`;
// 把各張量的平方和加總成單一純量（1 個工作群組）
const WGSL_SUMSLOTS = `
struct P { k: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> parts: array<f32>;
@group(0) @binding(1) var<storage, read_write> tot: array<f32>;
@group(0) @binding(2) var<uniform> u: P;
var<workgroup> sh: array<f32, 256>;
// @kernel sumsq_total
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  var s: f32 = 0.0;
  var i: u32 = lid.x;
  loop { if (i >= u.k) { break; } s = s + parts[i]; i = i + 256u; }
  sh[lid.x] = s;
  workgroupBarrier();
  var st: u32 = 128u;
  loop { if (st == 0u) { break; } if (lid.x < st) { sh[lid.x] = sh[lid.x] + sh[lid.x + st]; } workgroupBarrier(); st = st / 2u; }
  if (lid.x == 0u) { tot[0] = sh[0]; }
}
`;

// AdamW＋裁剪係數融合（P1 融合）：與 train_fused 的 WGSL_ADAMW_ACCUM 同一更新式，但梯度先乘裁剪係數 cf[0]（取代每個張量一次 scale_buf）。
// 運算順序與「scale_buf 再 adamw」逐位相同：g = (0＋gg)·cf，再 ·scale。K 固定為 1（完整參數路徑）。
const WGSL_ADAMW_COEF = `
struct P { n: u32, k: u32, lr: f32, b1: f32, omb1: f32, b2: f32, omb2: f32, eps: f32, wd: f32, c1: f32, c2: f32, scale: f32 }
@group(0) @binding(0) var<storage, read_write> pp: array<f32>;
@group(0) @binding(1) var<storage, read> gg: array<f32>;
@group(0) @binding(2) var<storage, read_write> mm: array<f32>;
@group(0) @binding(3) var<storage, read_write> vv: array<f32>;
@group(0) @binding(4) var<storage, read> cf: array<f32>;
@group(0) @binding(5) var<uniform> u: P;
// @kernel adamw_coef
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  var g: f32 = 0.0;
  g = g + gg[i];
  g = g * cf[0];
  g = g * u.scale;
  let m2 = u.b1 * mm[i] + u.omb1 * g;
  let v2 = u.b2 * vv[i] + u.omb2 * g * g;
  let p0 = pp[i];
  mm[i] = m2;
  vv[i] = v2;
  pp[i] = p0 - u.lr * u.wd * p0 - u.lr * (m2 / u.c1) / (sqrt(v2 / u.c2) + u.eps);
}
`;

// 逐元素乘以單一純量緩衝（裁剪係數）：o[i] = g[i]·c[0]。取代先前的 matmul(ONES(n), coef, n, 1, 1)＋逐元素乘：
// 那個 1 次內積的矩陣乘用 64×64 平鋪核心，每個張量白跑一整塊，ablation 量到約 114 ms／步（L）。
const WGSL_SCALE_BUF = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> g: array<f32>;
@group(0) @binding(1) var<storage, read> c: array<f32>;
@group(0) @binding(2) var<storage, read_write> o: array<f32>;
@group(0) @binding(3) var<uniform> u: P;
// @kernel scale_buf
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  o[i] = g[i] * c[0];
}
`;

// 嵌入查表（P1 調校，取代 one-hot(T×V)·emb 的整個矩陣乘）：h[t,j] = emb[ids[t], j]。
// 結果與 one-hot 矩陣乘逐位相同（一個 1 乘一個數、其餘都是 0）。
const WGSL_EMB_GATHER = `
struct P { T: u32, d: u32, V: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> emb: array<f32>;
@group(0) @binding(1) var<storage, read> ids: array<u32>;
@group(0) @binding(2) var<storage, read_write> o: array<f32>;
@group(0) @binding(3) var<uniform> u: P;
// @kernel emb_gather
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.T * u.d) { return; }
  let t = i / u.d; let j = i % u.d;
  o[i] = emb[ids[t] * u.d + j];
}
`;
// 嵌入梯度的 scatter-add（取代 one-hotᵀ·dh 的矩陣乘）：g[v,j] = Σ_{t: ids[t]=v} dh[t,j]。
// 每個工作群組負責一個詞彙 v，沿著 CSR（off、pos：依 v 分組、組內 t 由小到大）累加，順序固定、結果可重現。
// 沒有出現過的 v 得到 0（與 one-hot 矩陣乘相同）。
const WGSL_EMB_SCATTER = `
struct P { T: u32, d: u32, V: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> dh: array<f32>;
@group(0) @binding(1) var<storage, read> off: array<u32>;
@group(0) @binding(2) var<storage, read> pos: array<u32>;
@group(0) @binding(3) var<storage, read_write> g: array<f32>;
@group(0) @binding(4) var<uniform> u: P;
// @kernel emb_scatter
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let v = w.x;
  if (v >= u.V) { return; }
  let s = off[v]; let e = off[v + 1u];
  var j = l.x;
  loop {
    if (j >= u.d) { break; }
    var acc: f32 = 0.0;
    for (var q: u32 = s; q < e; q = q + 1u) { acc = acc + dh[pos[q] * u.d + j]; }
    g[v * u.d + j] = acc;
    j = j + 256u;
  }
}
`;

// 依詞彙分組的位置表（counting sort，組內保持 t 由小到大）：off[v]..off[v+1] 是詞彙 v 出現的位置 t 清單 pos。
function embCsr(ids, V) {
  const off = new Uint32Array(V + 1);
  for (let t = 0; t < ids.length; t++) off[ids[t] + 1]++;
  for (let v = 0; v < V; v++) off[v + 1] += off[v];
  const cur = off.slice(0, V), pos = new Uint32Array(ids.length);
  for (let t = 0; t < ids.length; t++) pos[cur[ids[t]]++] = t;
  return { off: off, pos: pos };
}

// 批次運算（與 train_step_device.js 的 extend 相同的核心，這裡重新掛上以免改動它）
function extend(b) {
  const r = {};
  r.attnFwd = (q, k, v, T, H, hd) => {
    const ao = b.alloc(T * H * hd), pm = b.alloc(H * T * T);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    b.dispatchRaw(TS.WGSL_ATTN_FWD, [q.buf, k.buf, v.buf, ao.buf, pm.buf], uni, T * H);   // 一個 (i,h) 一個工作群組
    return { ao: ao, pm: pm };
  };
  // K 轉置（[T][H·hd] → [H][hd][T]）：在 K 投影輸出端做一次（佈局改善：分數點積合併讀取）
  r.transposeTH = (src, T, H, hd) => {
    const dst = b.alloc(T * H * hd);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 4).set([T, H, hd, 0]);
    b.dispatchRaw(TS.WGSL_TRANSPOSE_TH, [src.buf, dst.buf], uni, Math.ceil(T * H * hd / 64));
    return dst;
  };
  // 前向（K 已是轉置佈局 kt）：同 attnFwd，只換分數讀取的佈局
  r.attnFwdKt = (q, kt, v, T, H, hd) => {
    const ao = b.alloc(T * H * hd), pm = b.alloc(H * T * T);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    b.dispatchRaw(TS.WGSL_ATTN_FWD_KT, [q.buf, kt.buf, v.buf, ao.buf, pm.buf], uni, T * H);
    return { ao: ao, pm: pm };
  };
  r.attnBwd = (dao, q, k, v, ao, pm, T, H, hd) => {
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    const dk = b.alloc(T * H * hd), dv = b.alloc(T * H * hd), dq = b.alloc(T * H * hd);
    b.dispatchRaw(TS.WGSL_ATTN_BWD_KV, [q.buf, v.buf, dao.buf, pm.buf, ao.buf, dk.buf, dv.buf], uni, T * H);   // 一個 (j,h) 一個工作群組
    b.dispatchRaw(TS.WGSL_ATTN_BWD_Q, [k.buf, v.buf, dao.buf, pm.buf, ao.buf, dq.buf], uni, T * H);   // 一個 (i,h) 一個工作群組
    return { dq: dq, dk: dk, dv: dv };
  };
  // 反向（V 已有轉置佈局 vt）：dQ 改讀 vt（lane 沿 j 合併）；dK、dV 仍用原 v
  r.attnBwdVt = (dao, q, k, v, vt, ao, pm, T, H, hd) => {
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    const dk = b.alloc(T * H * hd), dv = b.alloc(T * H * hd), dq = b.alloc(T * H * hd);
    b.dispatchRaw(TS.WGSL_ATTN_BWD_KV, [q.buf, v.buf, dao.buf, pm.buf, ao.buf, dk.buf, dv.buf], uni, T * H);
    b.dispatchRaw(TS.WGSL_ATTN_BWD_Q_VT, [k.buf, vt.buf, dao.buf, pm.buf, ao.buf, dq.buf], uni, T * H);
    return { dq: dq, dk: dk, dv: dv };
  };
  // RMSNorm 反向：rows 列、寬度 width（qk-norm 時 rows＝T·頭數、width＝hd）
  r.rmsnormBwd = (dy, x, g, rows, width, eps) => {
    const dx = b.alloc(rows * width);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([rows, width]); new Float32Array(uni, 8, 1)[0] = eps;
    b.dispatchRaw(TS.WGSL_RMS_BWD, [dy.buf, x.buf, g.buf, dx.buf], uni, Math.ceil(rows / 64));
    return dx;
  };
  r.mlpBwd = (da, g, u, n) => {
    const dg = b.alloc(n), du = b.alloc(n);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = n;
    b.dispatchRaw(TS.WGSL_MLP_BWD, [da.buf, g.buf, u.buf, dg.buf, du.buf], uni, Math.ceil(n / 64));
    return { dg: dg, du: du };
  };
  // g·c（c 是單一元素的裁剪係數句柄）：一次派發、輸出新的 n 個元素
  r.scaleBuf = (g, c, n) => {
    const o = b.alloc(n);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = n;
    b.dispatchRaw(WGSL_SCALE_BUF, [g.buf, c.buf, o.buf], uni, Math.ceil(n / 64));
    return o;
  };
  // 平方和寫入 parts[slot]（n 個元素）；sumslots 把 k 個槽加總成 1 個純量句柄
  r.sumsqSlot = (g, n, parts, slot) => {
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([n, slot]);
    b.dispatchRaw(WGSL_SUMSQ, [g.buf, parts.buf], uni, 1);
  };
  r.sumslots = (parts, k) => {
    const tot = b.alloc(1);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = k;
    b.dispatchRaw(WGSL_SUMSLOTS, [parts.buf, tot.buf], uni, 1);
    return tot;
  };
  r.clipCoef = (tot, maxNorm) => {
    const coef = b.alloc(1);
    const uni = new ArrayBuffer(16); new Float32Array(uni, 0, 1)[0] = maxNorm;
    b.dispatchRaw(WGSL_CLIP_COEF, [tot.buf, coef.buf], uni, 1);
    return coef;
  };
  // AdamW：p、m、v 是常駐緩衝區（原地更新）；g 已平均與裁剪；fl 同 train_fused 的佈局
  r.adamw = (p, g, m, v, n, fl) => {
    const uni = new ArrayBuffer(48); new Uint32Array(uni, 0, 2).set([n, 1]); new Float32Array(uni, 8, 10).set(fl);
    b.dispatchRaw(TF.WGSL_ADAMW_ACCUM, [p.buf, g.buf, m.buf, v.buf], uni, Math.ceil(n / 64));
  };
  // AdamW＋裁剪係數（融合，見 WGSL_ADAMW_COEF）：g 為未裁剪的平均梯度，cf 為裁剪係數句柄
  r.adamwCoef = (p, g, cf, m, v, n, fl) => {
    const uni = new ArrayBuffer(48); new Uint32Array(uni, 0, 2).set([n, 1]); new Float32Array(uni, 8, 10).set(fl);
    b.dispatchRaw(WGSL_ADAMW_COEF, [p.buf, g.buf, m.buf, v.buf, cf.buf], uni, Math.ceil(n / 64));
  };
  return Object.assign(r, { b: b });
}

function dimsOf(cfg) {
  const H = cfg.H, d = cfg.d, hd = d / H, KVH = cfg.kvH || H, kd = KVH * hd;
  if (H % KVH !== 0) throw new Error('kvH 必須整除 H');
  return { H: H, d: d, hd: hd, KVH: KVH, kd: kd, rep: H / KVH, gqa: KVH !== H, qkn: !!cfg.qkNorm, F: cfg.F, V: cfg.V, L: cfg.L };
}

// 常駐狀態的張量清單（名稱與 full_param_train.js 的 eachParam 相同）
function paramList(cfg) {
  const D = dimsOf(cfg);
  const list = [['emb', D.V * D.d], ['nf', D.d]];
  for (let l = 0; l < D.L; l++) {
    const p = 'L' + l + '.';
    list.push([p + 'n1', D.d], [p + 'n2', D.d], [p + 'Wq', D.d * D.d], [p + 'Wk', D.d * D.kd], [p + 'Wv', D.d * D.kd], [p + 'Wo', D.d * D.d], [p + 'Wg', D.d * D.F], [p + 'Wu', D.d * D.F], [p + 'Wd', D.F * D.d]);
    if (D.qkn) list.push([p + 'qn', D.hd], [p + 'kn', D.hd]);
  }
  return list;
}
function makeResidentState(device, cfg, init) {
  const mk = (n, data) => {
    const buf = device.createBuffer({ size: Math.max(4, n * 4), usage: USAGE_STORAGE | USAGE_COPY_SRC | USAGE_COPY_DST });
    if (data) device.queue.writeBuffer(buf, 0, data instanceof Float32Array ? data : Float32Array.from(data));
    return { buf: buf, n: n };
  };
  const D = dimsOf(cfg);
  const P = {}, M = {}, Vv = {};
  for (const [name, n] of paramList(cfg)) {
    P[name] = mk(n, init ? initFor(init, name) : null);
    M[name] = mk(n, null); Vv[name] = mk(n, null);
  }
  const list = paramList(cfg);
  const maxN = Math.max(...list.map((x) => x[1]), cfg.T * D.d, cfg.T * D.F, cfg.T * D.V, cfg.T * D.H * D.hd);
  const ones = mk(maxN, new Float32Array(maxN).fill(1));
  // RoPE 排列（寬度 d 用 H 頭；寬度 kd 用 KVH 頭）：把 rotate-half 配對換成核心的交錯配對（精確的 0/1 排列）
  // GQA 擴張矩陣 E（kd×d）：E[g·hd+u][h·hd+u] = 1，g = floor(h / rep)
  let expand = null;
  if (D.gqa) {
    const E = new Float32Array(D.kd * D.d);
    for (let h = 0; h < D.H; h++) { const g = Math.floor(h / D.rep); for (let u = 0; u < D.hd; u++) E[(g * D.hd + u) * D.d + (h * D.hd + u)] = 1; }
    expand = mk(D.kd * D.d, E);
  }
  return { P: P, M: M, V: Vv, ones: ones, expand: expand, t: 0, cfg: cfg, D: D };
}
function initFor(init, name) {
  if (name === 'emb') return init.emb;
  if (name === 'nf') return init.nf;
  const mm = /^L(\d+)\.(\w+)$/.exec(name); return init.layers[+mm[1]][mm[2]];
}

// 一步（K 條序列）。o: { nn, device, state, seqs, lr, wd, clip }
// 回傳 { loss, gradNorm, ms, stats }。參數與狀態在 GPU 內原地更新，步末只讀回損失列與梯度平方和。
async function fullParamStepDevice(o) {
  const { nn, device, state: S, seqs, lr, wd = 0, clip = 1.0 } = o;
  const D = S.D; const { V, d, L, H, F, hd, KVH, kd, gqa, qkn } = D; const K = seqs.length;
  const B = nn.createBatch(device), X = extend(B);
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const onesRow = (rows) => ({ buf: S.ones.buf, n: rows });
  // 增益梯度：列加總(dy ∘ x̂)，x̂ = rmsnorm(x, 1)；rows 列、寬度 width
  const gainGrad = (dy, x, rows, width) => {
    const y1 = B.rmsnorm(x, { buf: S.ones.buf, n: width }, rows, width, EPS);
    return B.matmul(onesRow(rows), B.mul(dy, y1), 1, rows, width);
  };
  const gacc = {}; const accum = (name, h) => { gacc[name] = gacc[name] ? B.axpy(gacc[name], h, 1) : h; };
  // RoPE：核心本身就是 rotate-half（nn_ops.ROPE_CONVENTION），不再需要排列矩陣包裝（省下每層每步 4 次矩陣乘）
  const rp = (x, dir, T, Hn, width) => B.rope(x, T, Hn, width / Hn, dir);
  const lossRows = [];
  for (const tokens of seqs) {
    const T = tokens.length - 1, inp = tokens.slice(0, T), tgt = tokens.slice(1);
    // 嵌入查表：h[t] = emb[inp[t]]（gather）；反向用同一份 CSR 做 scatter-add
    const idsH = B.uploadU32(Uint32Array.from(inp));
    const csr = embCsr(inp, V);
    const offH = B.uploadU32(csr.off), posH = B.uploadU32(csr.pos);
    let h = B.alloc(T * d);
    { const uni = new ArrayBuffer(16); new Uint32Array(uni).set([T, d, V, 0]); B.dispatchRaw(WGSL_EMB_GATHER, [S.P['emb'].buf, idsH.buf, h.buf], uni, Math.ceil(T * d / 64)); }
    const cache = [];
    for (let l = 0; l < L; l++) {
      const pre = 'L' + l + '.'; const P = (k) => S.P[pre + k], c = { hIn: h };
      c.n1 = B.rmsnorm(h, P('n1'), T, d, EPS);
      const q0 = B.matmul(c.n1, P('Wq'), T, d, d), k0 = B.matmul(c.n1, P('Wk'), T, d, kd), v0 = B.matmul(c.n1, P('Wv'), T, d, kd);
      // qk-norm（每頭 RMSNorm，寬度 hd），在 RoPE 之前
      let qx = q0, kx = k0;
      if (qkn) {
        c.qIn = q0; qx = B.rmsnorm(q0, P('qn'), T * H, hd, EPS); c.qN = qx;
        c.kIn = k0; kx = B.rmsnorm(k0, P('kn'), T * KVH, hd, EPS); c.kN = kx;
      }
      c.q = rp(qx, 1, T, H, d);
      c.kR = rp(kx, 1, T, KVH, kd);
      // 分組查詢：k、v 擴成 H 個頭（矩陣乘 with E）
      c.k = gqa ? B.matmul(c.kR, S.expand, T, kd, d) : c.kR;
      c.v = gqa ? B.matmul(v0, S.expand, T, kd, d) : v0;
      const kt = X.transposeTH(c.k, T, H, hd);
      const at = X.attnFwdKt(c.q, kt, c.v, T, H, hd); c.ao = at.ao; c.pm = at.pm;
      c.vt = X.transposeTH(c.v, T, H, hd);   // V 轉置佈局：反向 dP 合併讀取用
      const o2 = B.matmul(c.ao, P('Wo'), T, d, d);
      c.h1 = B.axpy(h, o2, 1);
      c.n2 = B.rmsnorm(c.h1, P('n2'), T, d, EPS);
      c.g = B.matmul(c.n2, P('Wg'), T, d, F); c.u = B.matmul(c.n2, P('Wu'), T, d, F);
      c.a = B.mul(B.silu(c.g), c.u);
      const dn = B.matmul(c.a, P('Wd'), T, F, d);
      h = B.axpy(c.h1, dn, 1);
      cache.push(c);
      B.flush();   // 分段提交：每層前向送出一段（XL 單次提交過長會被 GPU 逾時重置）
    }
    // 頭：norm → logits（與嵌入共用）→ 交叉熵（dl 已含 1/T）
    const nfH = S.P['nf'], embH = S.P['emb'];
    const nf = B.rmsnorm(h, nfH, T, d, EPS);
    const logits = B.matmul(nf, embH, T, d, V, { transB: true });
    const ce = B.crossEntropy(logits, B.uploadU32(Uint32Array.from(tgt)), T, V, 1 / T);
    lossRows.push({ rows: ce.rows, T: T });
    accum('nf', gainGrad(B.matmul(ce.dl, embH, T, V, d), h, T, d));
    accum('emb', B.matmul(ce.dl, nf, V, T, d, { transA: true }));
    let dh = X.rmsnormBwd(B.matmul(ce.dl, embH, T, V, d), h, nfH, T, d, EPS);
    for (let l = L - 1; l >= 0; l--) {
      const pre = 'L' + l + '.'; const P = (k) => S.P[pre + k], c = cache[l];
      const da = B.matmul(dh, P('Wd'), T, d, F, { transB: true });
      accum(pre + 'Wd', B.matmul(c.a, dh, F, T, d, { transA: true }));
      const mg = X.mlpBwd(da, c.g, c.u, T * F);
      accum(pre + 'Wg', B.matmul(c.n2, mg.dg, d, T, F, { transA: true }));
      accum(pre + 'Wu', B.matmul(c.n2, mg.du, d, T, F, { transA: true }));
      const dn2 = B.axpy(B.matmul(mg.dg, P('Wg'), T, F, d, { transB: true }), B.matmul(mg.du, P('Wu'), T, F, d, { transB: true }), 1);
      accum(pre + 'n2', gainGrad(dn2, c.h1, T, d));
      const dh1 = B.axpy(X.rmsnormBwd(dn2, c.h1, P('n2'), T, d, EPS), dh, 1);
      accum(pre + 'Wo', B.matmul(c.ao, dh1, d, T, d, { transA: true }));
      const dao = B.matmul(dh1, P('Wo'), T, d, d, { transB: true });
      const ab = X.attnBwdVt(dao, c.q, c.k, c.v, c.vt, c.ao, c.pm, T, H, hd);
      // q：RoPE 反向（H 頭）→ qk-norm 反向（T·H 列）
      let dq = rp(ab.dq, -1, T, H, d);
      // k：先從 H 個頭加總回 KVH 個頭（Eᵀ），再 RoPE 反向（KVH 頭）→ qk-norm 反向（T·KVH 列）
      let dkR = gqa ? B.matmul(ab.dk, S.expand, T, d, kd, { transB: true }) : ab.dk;
      let dk = rp(dkR, -1, T, KVH, kd);
      let dvK = gqa ? B.matmul(ab.dv, S.expand, T, d, kd, { transB: true }) : ab.dv;
      if (qkn) {
        accum(pre + 'qn', gainGrad(dq, c.qIn, T * H, hd));
        dq = X.rmsnormBwd(dq, c.qIn, P('qn'), T * H, hd, EPS);
        accum(pre + 'kn', gainGrad(dk, c.kIn, T * KVH, hd));
        dk = X.rmsnormBwd(dk, c.kIn, P('kn'), T * KVH, hd, EPS);
      }
      accum(pre + 'Wq', B.matmul(c.n1, dq, d, T, d, { transA: true }));
      accum(pre + 'Wk', B.matmul(c.n1, dk, d, T, kd, { transA: true }));
      accum(pre + 'Wv', B.matmul(c.n1, dvK, d, T, kd, { transA: true }));
      const dn1 = B.axpy(B.axpy(B.matmul(dq, P('Wq'), T, d, d, { transB: true }), B.matmul(dk, P('Wk'), T, kd, d, { transB: true }), 1), B.matmul(dvK, P('Wv'), T, kd, d, { transB: true }), 1);
      accum(pre + 'n1', gainGrad(dn1, c.hIn, T, d));
      dh = B.axpy(X.rmsnormBwd(dn1, c.hIn, P('n1'), T, d, EPS), dh1, 1);
      B.flush();   // 分段提交：每層反向送出一段
    }
    // 嵌入輸入梯度：onehotᵀ · dh
    const gE = B.alloc(V * d);
    { const uni = new ArrayBuffer(16); new Uint32Array(uni).set([T, d, V, 0]); B.dispatchRaw(WGSL_EMB_SCATTER, [dh.buf, offH.buf, posH.buf, gE.buf], uni, V); }
    accum('emb', gE);
  }
  // 平均（K 條序列）
  const names = Object.keys(gacc);
  // K=1 時 1/K＝1，逐元素乘以 1 是恆等（逐位相同），直接沿用原緩衝區，省下每個張量一次派發（L 每步 46 次）
  const gavg = {}; for (const nm of names) gavg[nm] = K === 1 ? gacc[nm] : B.scal(gacc[nm], 1 / K);
  // 總平方和：每個張量 ‖g‖² = onesᵀ·(g∘g)（1×n · n×1）
  const parts = B.alloc(names.length);
  names.forEach((nm, k) => X.sumsqSlot(gavg[nm], S.P[nm].n, parts, k));
  const total = X.sumslots(parts, names.length);
  // 梯度匯出（P1c-2）：不做 AdamW、不改參數與動量、S.t 不前進；回傳平均後、裁剪前的梯度（逐名稱的 Float32Array）。
  // 用於多資源分擔：各資源匯出梯度，由協調端加權平均後再統一更新。
  if (o.applyUpdate === false) {
    const specsG = lossRows.map((r) => [r.rows, r.T]);
    specsG.push([total, 1]);
    for (const nm of names) specsG.push([gavg[nm], S.P[nm].n]);
    const outG = await B.read(specsG);
    let lossG = 0; lossRows.forEach((r, k) => { let sr = 0; for (let i = 0; i < r.T; i++) sr += outG[k][i]; lossG += (sr / r.T) / K; });
    const grads = {}; names.forEach((nm, k) => { grads[nm] = outG[lossRows.length + 1 + k]; });
    return { loss: lossG, gradNorm: Math.sqrt(outG[lossRows.length][0]), grads: grads, applied: false, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0, stats: B.stats || null };
  }
  const coef = X.clipCoef(total, clip);
  // 梯度乘裁剪係數：廣播 coef（n×1 · 1×1 → n×1）後逐元素相乘
  const t = S.t + 1, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
  const fl = [lr, b1, 1 - b1, b2, 1 - b2, eps, wd, c1, c2, 1].map(f32);
  for (const nm of names) {
    const n = S.P[nm].n;
    X.adamwCoef(S.P[nm], gavg[nm], coef, S.M[nm], S.V[nm], n, fl);
  }
  // 不需要數值的步（readLoss=false）：只提交，不讀回；參數與動量全在 GPU，下一步直接接著算
  if (o.readLoss === false) {
    B.submit();
    S.t = t;
    return { loss: null, gradNorm: null, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0, stats: B.stats || null };
  }
  // 步末讀回：損失列與總平方和（每次讀回都要等 GPU 把這一步算完）
  const specs = lossRows.map((r) => [r.rows, r.T]); specs.push([total, 1]);
  const outs = await B.read(specs);
  let loss = 0; lossRows.forEach((r, k) => { let sr = 0; for (let i = 0; i < r.T; i++) sr += outs[k][i]; loss += (sr / r.T) / K; });
  S.t = t;
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  return { loss: loss, gradNorm: Math.sqrt(outs[lossRows.length][0]), ms: ms, stats: B.stats || null };
}

// 檢查點（GPU 路徑）：把常駐的參數、m、v 與步數讀回 CPU（只在存檔時做，不在訓練迴圈裡）。
// 讀回用暫存緩衝區（MAP_READ），每個張量一次複製＋一次映射；存成 Float32Array 副本，格式同 fa-f32 的內容。
async function readResident(device, S) {
  const readOne = async (h) => {
    const bytes = h.n * 4;
    const stage = device.createBuffer({ size: bytes, usage: 0x1 | 0x8 });  // MAP_READ | COPY_DST
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(h.buf, 0, stage, 0, bytes);
    device.queue.submit([enc.finish()]);
    await stage.mapAsync(0x1);                                              // GPUMapMode.READ
    const out = new Float32Array(stage.getMappedRange().slice(0));
    stage.unmap(); stage.destroy();
    return out;
  };
  const snap = { t: S.t, P: {}, M: {}, V: {} };
  for (const k of Object.keys(S.P)) { snap.P[k] = await readOne(S.P[k]); snap.M[k] = await readOne(S.M[k]); snap.V[k] = await readOne(S.V[k]); }
  return snap;
}
// 載入檢查點：寫回同一組常駐緩衝區（形狀必須相同）
function loadResident(device, S, snap) {
  for (const k of Object.keys(S.P)) {
    if (!snap.P[k] || snap.P[k].length !== S.P[k].n) throw new Error('檢查點參數 ' + k + ' 形狀不符');
    device.queue.writeBuffer(S.P[k].buf, 0, snap.P[k]);
    device.queue.writeBuffer(S.M[k].buf, 0, snap.M[k]);
    device.queue.writeBuffer(S.V[k].buf, 0, snap.V[k]);
  }
  S.t = snap.t;
  return S;
}

module.exports = { fullParamStepDevice, makeResidentState, readResident, loadResident, paramList, dimsOf, WGSL_CLIP_COEF, extend };
