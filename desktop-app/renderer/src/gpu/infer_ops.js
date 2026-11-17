// infer_ops.js — 離線模型推論用的 cudaweb 核心（DESIGN.webgpu-cuda.md §7.3、§12）。
// 目前內容：q8 反量化矩陣乘兩種（對應 Qwen3-0.6B 現有 onnx q8 權重格式）：
//   q8mm  ：MatMulInteger 路徑。權重 K×N（uint8、單一 zero point），輸入先動態量化成 uint8（扣掉 zero point 後是 int32），
//           累加用 int32（精確），最後乘上 輸入scale×權重scale，與 ORT 的 DynamicQuantizeLinear→MatMulInteger→Cast→Mul 一致。
//   q8lm  ：lm_head 路徑。權重 V×K（詞表×隱藏，uint8、單一 zero point），輸入是 f32，logits[v] = scale · Σ x[k]·(w[v,k] − zp)。
// 每個核心三層：T1 = WGSL、T3 = WebGL2（此檔尚未實作，會寫明）、cpu-js = 參考版。
// 注意：node 內的測試用假裝置只驗證主機端流程；WGSL 的數值要在真 WebGPU（scripts/eval/cudaweb_infer_browser.js）驗證。
'use strict';
const nn = require('./nn_ops.js');

const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const MAX_GROUPS = 65535;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;  // 預設裝置的儲存緩衝上限 128 MiB；權重照列切成 ≤ 64 MiB 的塊

// ---------- 參考版（CPU，純 JS） ----------
function roundHalfEven(v) {
  const r = Math.round(v);
  return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
// ORT DynamicQuantizeLinear（uint8）：回傳 { q: Uint8Array, scale, zp }
function quantizeDynamicRef(x) {
  let mn = 0, mx = 0;
  for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  const scale = Math.fround((mx - mn) / 255);
  if (scale === 0) return { q: new Uint8Array(x.length), scale: 1, zp: 0 };
  const zp = Math.min(255, Math.max(0, roundHalfEven(Math.fround(-mn / scale))));
  const q = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) q[i] = Math.min(255, Math.max(0, roundHalfEven(Math.fround(x[i] / scale)) + zp));
  return { q: q, scale: scale, zp: zp };
}
// xq：M×K 的 int（已扣輸入 zero point），W：K×N uint8，回傳 Float32Array(M×N)
function q8mmRef(xq, W, wzp, M, K, N, scale) {
  const out = new Float32Array(M * N);
  const acc = new Int32Array(N);
  const sc = Math.fround(scale);
  for (let m = 0; m < M; m++) {
    acc.fill(0);
    for (let k = 0; k < K; k++) {
      const xv = xq[m * K + k];
      if (xv === 0) continue;
      const row = k * N;
      for (let n = 0; n < N; n++) acc[n] += xv * (W[row + n] - wzp);
    }
    for (let n = 0; n < N; n++) out[m * N + n] = Math.fround(Math.fround(acc[n]) * sc);
  }
  return out;
}
// x：K 個 f32，W：V×K uint8 → Float64Array(V)（用雙精度累加，當作「真值」）
function q8lmRef(x, W, wzp, V, K, scale) {
  const out = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    let s = 0; const row = v * K;
    for (let k = 0; k < K; k++) s += x[k] * (W[row + k] - wzp);
    out[v] = s * scale;
  }
  return out;
}

// ---------- WGSL ----------
const WGSL_Q8MM = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
// @kernel q8mm
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  let m = gid.y;
  if (n >= p.N || m >= p.M) { return; }
  var acc: i32 = 0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) {
    let idx = k * p.N + n;
    let wv = i32((w[idx >> 2u] >> ((idx & 3u) * 8u)) & 255u) - p.wzp;
    acc = acc + x[m * p.K + k] * wv;
  }
  y[m * p.N + n] = f32(acc) * p.scale;
}
`;
// q8mm 解碼／通用變體（@kernel q8mm_dec）：一個工作群組（256 執行緒）負責「一列輸入 m」的「64 個輸出欄」。
// 執行緒 t：cq = t&15 管 4 個相鄰欄（一個 u32 權重字＝同一列 k 的 4 個位元組），ks = t>>4 管 K 的第 ks 條切片（每 16 個 k 取一個）。
// 輸入 x 的一段（256 個 k）先搬進共用記憶體 xs（所有執行緒重複讀，走共用記憶體），每個執行緒的 4 個整數累加器各自累加，
// 最後 16 條切片的部分和經共用記憶體 red（16×64，4 KiB）樹外歸約（64 個執行緒各加 16 個值）。
// 整數累加（i32）精確，所以與 q8mmRef 逐位相同。N 必須是 4 的倍數（由主機端檢查）。
// 共用記憶體用量：xs 1 KiB + red 4 KiB＝5 KiB（低階卡的上限 16 KiB 內）。
const WGSL_Q8MM_DEC = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<i32, 256>;
var<workgroup> red: array<i32, 1024>;
// @kernel q8mm_dec
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m = wid.y;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a0: i32 = 0;
  var a1: i32 = 0;
  var a2: i32 = 0;
  var a3: i32 = 0;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    if (kk < p.K) { xs[t] = x[m * p.K + kk]; } else { xs[t] = 0; }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let xv = xs[tl];
        a0 = a0 + xv * (i32(word & 255u) - p.wzp);
        a1 = a1 + xv * (i32((word >> 8u) & 255u) - p.wzp);
        a2 = a2 + xv * (i32((word >> 16u) & 255u) - p.wzp);
        a3 = a3 + xv * (i32((word >> 24u) & 255u) - p.wzp);
      }
    }
    workgroupBarrier();
  }
  let b = ks * 64u + cq * 4u;
  red[b] = a0;
  red[b + 1u] = a1;
  red[b + 2u] = a2;
  red[b + 3u] = a3;
  workgroupBarrier();
  if (t < 64u) {
    var s: i32 = 0;
    for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + red[q * 64u + t]; }
    let n = wid.x * 64u + t;
    if (n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
  }
}
`;
// q8mm 多列解碼（@kernel q8mm_decr）：一個工作群組負責 4 列輸入 × 64 個輸出欄。權重字每個只讀一次，同時乘 4 列
// （WGSL_Q8MM_DEC 每列一個工作群組，M 列就把整個權重讀 M 次）。整數累加與 WGSL_Q8MM_DEC 相同，所以逐位相同。
// 共用記憶體：xs 4 列×256 k 的 i32（4 KiB）＋ red 16×64 的 i32（4 KiB）＝8 KiB。4 列的結果依序經 red 歸約（每列一次屏障組）。
// 工作群組數：ceil(N/64) × ceil(M/4)。
const WGSL_Q8MM_DECR = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<i32, 1024>;
var<workgroup> red: array<i32, 1024>;
// @kernel q8mm_decr
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m0 = wid.y * 4u;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a: array<i32, 16>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    for (var r: u32 = 0u; r < 4u; r = r + 1u) {
      let m = m0 + r;
      if (m < p.M && kk < p.K) { xs[r * 256u + t] = x[m * p.K + kk]; } else { xs[r * 256u + t] = 0; }
    }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let b0 = i32(word & 255u) - p.wzp;
        let b1 = i32((word >> 8u) & 255u) - p.wzp;
        let b2 = i32((word >> 16u) & 255u) - p.wzp;
        let b3 = i32((word >> 24u) & 255u) - p.wzp;
        for (var r: u32 = 0u; r < 4u; r = r + 1u) {
          let xv = xs[r * 256u + tl];
          a[r * 4u] = a[r * 4u] + xv * b0;
          a[r * 4u + 1u] = a[r * 4u + 1u] + xv * b1;
          a[r * 4u + 2u] = a[r * 4u + 2u] + xv * b2;
          a[r * 4u + 3u] = a[r * 4u + 3u] + xv * b3;
        }
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 4u; r = r + 1u) {
    let b = ks * 64u + cq * 4u;
    red[b] = a[r * 4u];
    red[b + 1u] = a[r * 4u + 1u];
    red[b + 2u] = a[r * 4u + 2u];
    red[b + 3u] = a[r * 4u + 3u];
    workgroupBarrier();
    if (t < 64u) {
      var s: i32 = 0;
      for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + red[q * 64u + t]; }
      let m = m0 + r;
      let n = wid.x * 64u + t;
      if (m < p.M && n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
    }
    workgroupBarrier();
  }
}
`;
// q8mm 多列解碼 8 列版（@kernel q8mm_decr8）：與 q8mm_decr 相同的整數累加，一個工作群組負責 8 列 × 64 欄，
// 權重字的位元組拆解只做一次、供 8 列共用（decr 的拆解成本由 4 列分攤）。共用記憶體 8 KiB：歸約時 xs 同一段當 red。
const WGSL_Q8MM_DECR8 = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<i32, 2048>;
// @kernel q8mm_decr8
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m0 = wid.y * 8u;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a: array<i32, 32>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    for (var r: u32 = 0u; r < 8u; r = r + 1u) {
      let m = m0 + r;
      if (m < p.M && kk < p.K) { xs[r * 256u + t] = x[m * p.K + kk]; } else { xs[r * 256u + t] = 0; }
    }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let b0 = i32(word & 255u) - p.wzp;
        let b1 = i32((word >> 8u) & 255u) - p.wzp;
        let b2 = i32((word >> 16u) & 255u) - p.wzp;
        let b3 = i32((word >> 24u) & 255u) - p.wzp;
        for (var r: u32 = 0u; r < 8u; r = r + 1u) {
          let xv = xs[r * 256u + tl];
          a[r * 4u] = a[r * 4u] + xv * b0;
          a[r * 4u + 1u] = a[r * 4u + 1u] + xv * b1;
          a[r * 4u + 2u] = a[r * 4u + 2u] + xv * b2;
          a[r * 4u + 3u] = a[r * 4u + 3u] + xv * b3;
        }
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 8u; r = r + 1u) {
    let b = ks * 64u + cq * 4u;
    xs[b] = a[r * 4u];
    xs[b + 1u] = a[r * 4u + 1u];
    xs[b + 2u] = a[r * 4u + 2u];
    xs[b + 3u] = a[r * 4u + 3u];
    workgroupBarrier();
    if (t < 64u) {
      var s: i32 = 0;
      for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + xs[q * 64u + t]; }
      let m = m0 + r;
      let n = wid.x * 64u + t;
      if (m < p.M && n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
    }
    workgroupBarrier();
  }
}
`;
// q8mm 多列解碼 8 列 f32 版（@kernel q8mm_decr8f）：與 q8mm_decr8 逐位相同，但乘加在 f32 做（這台 f32 乘加屋頂約是 i32 的 2.5 倍）。
// 精確條件：|輸入| ≤ 255、|權重−zp| ≤ 255；每個執行緒的部分和最多 K/16 個乘積，K ≤ 4096 時 ≤ 16.6M < 2^24，每一步都是精確整數。
// 歸約前把部分和轉成 i32 再用 i32 加總。主機端只在 K ≤ 4096 時路由到這個核心。共用記憶體：xs f32 8 KiB ＋ red i32 4 KiB ＝ 12 KiB。
// 實測（真 Chrome，K1024 N1024，交錯三輪）：M8 0.60→0.44 ms、M16 1.07→0.79 ms。
const WGSL_Q8MM_DECR8F = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<f32, 2048>;
var<workgroup> red: array<i32, 1024>;
// @kernel q8mm_decr8f
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m0 = wid.y * 8u;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a: array<f32, 32>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    for (var r: u32 = 0u; r < 8u; r = r + 1u) {
      let m = m0 + r;
      if (m < p.M && kk < p.K) { xs[r * 256u + t] = f32(x[m * p.K + kk]); } else { xs[r * 256u + t] = 0.0; }
    }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let b0 = f32(i32(word & 255u) - p.wzp);
        let b1 = f32(i32((word >> 8u) & 255u) - p.wzp);
        let b2 = f32(i32((word >> 16u) & 255u) - p.wzp);
        let b3 = f32(i32((word >> 24u) & 255u) - p.wzp);
        for (var r: u32 = 0u; r < 8u; r = r + 1u) {
          let xv = xs[r * 256u + tl];
          a[r * 4u] = a[r * 4u] + xv * b0;
          a[r * 4u + 1u] = a[r * 4u + 1u] + xv * b1;
          a[r * 4u + 2u] = a[r * 4u + 2u] + xv * b2;
          a[r * 4u + 3u] = a[r * 4u + 3u] + xv * b3;
        }
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 8u; r = r + 1u) {
    let b = ks * 64u + cq * 4u;
    red[b] = i32(a[r * 4u]);
    red[b + 1u] = i32(a[r * 4u + 1u]);
    red[b + 2u] = i32(a[r * 4u + 2u]);
    red[b + 3u] = i32(a[r * 4u + 3u]);
    workgroupBarrier();
    if (t < 64u) {
      var s: i32 = 0;
      for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + red[q * 64u + t]; }
      let m = m0 + r;
      let n = wid.x * 64u + t;
      if (m < p.M && n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
    }
    workgroupBarrier();
  }
}
`;
// q8mm 多列解碼 4 列 f32 版（@kernel q8mm_decr4f）：與 q8mm_decr 逐位相同，乘加在 f32；精確條件與 q8mm_decr8f 相同（K ≤ 4096）。
// 主機端只在 4 ≤ M < 8 且 K ≤ 4096 時路由到這裡。共用記憶體：xs f32 4 KiB ＋ red i32 4 KiB ＝ 8 KiB。
const WGSL_Q8MM_DECR4F = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<f32, 1024>;
var<workgroup> red: array<i32, 1024>;
// @kernel q8mm_decr4f
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m0 = wid.y * 4u;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a: array<f32, 16>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    for (var r: u32 = 0u; r < 4u; r = r + 1u) {
      let m = m0 + r;
      if (m < p.M && kk < p.K) { xs[r * 256u + t] = f32(x[m * p.K + kk]); } else { xs[r * 256u + t] = 0.0; }
    }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let b0 = f32(i32(word & 255u) - p.wzp);
        let b1 = f32(i32((word >> 8u) & 255u) - p.wzp);
        let b2 = f32(i32((word >> 16u) & 255u) - p.wzp);
        let b3 = f32(i32((word >> 24u) & 255u) - p.wzp);
        for (var r: u32 = 0u; r < 4u; r = r + 1u) {
          let xv = xs[r * 256u + tl];
          a[r * 4u] = a[r * 4u] + xv * b0;
          a[r * 4u + 1u] = a[r * 4u + 1u] + xv * b1;
          a[r * 4u + 2u] = a[r * 4u + 2u] + xv * b2;
          a[r * 4u + 3u] = a[r * 4u + 3u] + xv * b3;
        }
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 4u; r = r + 1u) {
    let b = ks * 64u + cq * 4u;
    red[b] = i32(a[r * 4u]);
    red[b + 1u] = i32(a[r * 4u + 1u]);
    red[b + 2u] = i32(a[r * 4u + 2u]);
    red[b + 3u] = i32(a[r * 4u + 3u]);
    workgroupBarrier();
    if (t < 64u) {
      var s: i32 = 0;
      for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + red[q * 64u + t]; }
      let m = m0 + r;
      let n = wid.x * 64u + t;
      if (m < p.M && n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
    }
    workgroupBarrier();
  }
}
`;
// q8mm 2 列解碼 f32 版（@kernel q8mm_decr2f）：2 列 × 64 欄，權重只讀一次（WGSL_Q8MM_DEC 每列一個工作群組，M=2 時權重讀兩次）。
// 精確條件同 decr4f（K ≤ 4096）。主機端只在 M=2 且 K ≤ 4096 時路由到這裡。共用記憶體：xs f32 2 KiB ＋ red i32 4 KiB。
const WGSL_Q8MM_DECR2F = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<f32, 512>;
var<workgroup> red: array<i32, 1024>;
// @kernel q8mm_decr2f
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let ks = t >> 4u;
  let m0 = wid.y * 2u;
  let quad = wid.x * 16u + cq;
  let qok = quad < p.nq;
  var a: array<f32, 8>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    for (var r: u32 = 0u; r < 2u; r = r + 1u) {
      let m = m0 + r;
      if (m < p.M && kk < p.K) { xs[r * 256u + t] = f32(x[m * p.K + kk]); } else { xs[r * 256u + t] = 0.0; }
    }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let tl = j * 16u + ks;
      let k = kt + tl;
      if (qok && k < p.K) {
        let word = w[k * p.nq + quad];
        let b0 = f32(i32(word & 255u) - p.wzp);
        let b1 = f32(i32((word >> 8u) & 255u) - p.wzp);
        let b2 = f32(i32((word >> 16u) & 255u) - p.wzp);
        let b3 = f32(i32((word >> 24u) & 255u) - p.wzp);
        for (var r: u32 = 0u; r < 2u; r = r + 1u) {
          let xv = xs[r * 256u + tl];
          a[r * 4u] = a[r * 4u] + xv * b0;
          a[r * 4u + 1u] = a[r * 4u + 1u] + xv * b1;
          a[r * 4u + 2u] = a[r * 4u + 2u] + xv * b2;
          a[r * 4u + 3u] = a[r * 4u + 3u] + xv * b3;
        }
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 2u; r = r + 1u) {
    let b = ks * 64u + cq * 4u;
    red[b] = i32(a[r * 4u]);
    red[b + 1u] = i32(a[r * 4u + 1u]);
    red[b + 2u] = i32(a[r * 4u + 2u]);
    red[b + 3u] = i32(a[r * 4u + 3u]);
    workgroupBarrier();
    if (t < 64u) {
      var s: i32 = 0;
      for (var q: u32 = 0u; q < 16u; q = q + 1u) { s = s + red[q * 64u + t]; }
      let m = m0 + r;
      let n = wid.x * 64u + t;
      if (m < p.M && n < p.N) { y[m * p.N + n] = f32(s) * p.scale; }
    }
    workgroupBarrier();
  }
}
`;
// q8mm 預填 4×8 暫存器分塊（@kernel q8mm_pf8x4）：一個工作群組 64 列 × 128 欄（256 執行緒，每執行緒 4 列 × 8 欄 ＝ 32 個 f32 累加器）。
// 每個權重字的位元組只拆一次，共用記憶體讀取由 4×4 版的每 16 次乘加 5 次降到 6 次／32 次乘加。
// 精確條件：|輸入| ≤ 255、|權重−zp| ≤ 255；每個累加器跨整個 K 累加，K ≤ 4096 時 ≤ 16.6M < 2^24，每一步精確。主機端只在 K ≤ 4096 路由到這裡，其餘仍用 WGSL_Q8MM_PF。
// 實測（真 Chrome，K1024 N1024，交錯）：M64 2.70→1.94 ms、M128 5.24→3.83、M256 10.41→7.12（約 −30%）；M70 N132 1.245→1.16；與 q8mmRef 逐位相同。
const WGSL_Q8MM_PF8X4 = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<f32, 1024>;
var<workgroup> ws: array<u32, 512>;
// @kernel q8mm_pf8x4
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let rg = t >> 4u;
  let m0 = wid.y * 64u;
  let q0 = wid.x * 32u;
  var acc: array<f32, 32>;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 16u) {
    for (var i: u32 = 0u; i < 4u; i = i + 1u) {
      let idx = t + i * 256u;
      let gm = m0 + (idx >> 4u);
      let kk = idx & 15u;
      if (gm < p.M && kt + kk < p.K) { xs[idx] = f32(x[gm * p.K + kt + kk]); } else { xs[idx] = 0.0; }
    }
    for (var i: u32 = 0u; i < 2u; i = i + 1u) {
      let idx = t + i * 256u;
      let wk = idx >> 5u;
      let wq = q0 + (idx & 31u);
      if (kt + wk < p.K && wq < p.nq) { ws[idx] = w[(kt + wk) * p.nq + wq]; } else { ws[idx] = 0u; }
    }
    workgroupBarrier();
    for (var kk: u32 = 0u; kk < 16u; kk = kk + 1u) {
      let w0 = ws[kk * 32u + cq * 2u];
      let w1 = ws[kk * 32u + cq * 2u + 1u];
      let b0 = f32(i32(w0 & 255u) - p.wzp);
      let b1 = f32(i32((w0 >> 8u) & 255u) - p.wzp);
      let b2 = f32(i32((w0 >> 16u) & 255u) - p.wzp);
      let b3 = f32(i32((w0 >> 24u) & 255u) - p.wzp);
      let b4 = f32(i32(w1 & 255u) - p.wzp);
      let b5 = f32(i32((w1 >> 8u) & 255u) - p.wzp);
      let b6 = f32(i32((w1 >> 16u) & 255u) - p.wzp);
      let b7 = f32(i32((w1 >> 24u) & 255u) - p.wzp);
      for (var r: u32 = 0u; r < 4u; r = r + 1u) {
        let xv = xs[(rg * 4u + r) * 16u + kk];
        acc[r * 8u] = acc[r * 8u] + xv * b0;
        acc[r * 8u + 1u] = acc[r * 8u + 1u] + xv * b1;
        acc[r * 8u + 2u] = acc[r * 8u + 2u] + xv * b2;
        acc[r * 8u + 3u] = acc[r * 8u + 3u] + xv * b3;
        acc[r * 8u + 4u] = acc[r * 8u + 4u] + xv * b4;
        acc[r * 8u + 5u] = acc[r * 8u + 5u] + xv * b5;
        acc[r * 8u + 6u] = acc[r * 8u + 6u] + xv * b6;
        acc[r * 8u + 7u] = acc[r * 8u + 7u] + xv * b7;
      }
    }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 4u; r = r + 1u) {
    let gm = m0 + rg * 4u + r;
    for (var c: u32 = 0u; c < 8u; c = c + 1u) {
      let gn = q0 * 4u + cq * 8u + c;
      if (gm < p.M && gn < p.N) { y[gm * p.N + gn] = acc[r * 8u + c] * p.scale; }
    }
  }
}
`;
// q8mm 預填／大 M 變體（@kernel q8mm_pf）：一個工作群組（16×16＝256 執行緒）負責 64 列輸入 × 64 個輸出欄的一塊。
// 執行緒 (rg, cq)：cq = t&15 管 4 欄（一個權重字），rg = t>>4 管 4 列（暫存器分塊 4×4＝16 個整數累加器）。
// 每次沿 K 取 16 個 k：輸入塊 64×16 i32（4 KiB）與權重塊 16×16 個 u32（1 KiB）先搬進共用記憶體，再由 16 個 k 做累加。
// 共用記憶體用量 5 KiB。整數累加精確，與 q8mmRef 逐位相同。N 必須是 4 的倍數（主機端檢查）。
const WGSL_Q8MM_PF = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, nq: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> xs: array<f32, 1024>;
var<workgroup> ws: array<u32, 256>;
// @kernel q8mm_pf
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let cq = t & 15u;
  let rg = t >> 4u;
  let m0 = wid.y * 64u;
  let q0 = wid.x * 16u;
  var acc: array<i32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { acc[i] = 0; }
  // 每個 K 區塊（16 個 k）的部分和用 f32 乘加：|x|,|b| ≤ 255，一個區塊的和 ≤ 16·255·255 ≈ 1.04e6 < 2^24，每一步都是精確整數，
  // 所以與 i32 累加逐位相同；區塊結束再轉成 i32 加到 acc。Kepler 上 f32 乘加比 i32 乘法快得多。
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 16u) {
    var pa: array<f32, 16>;
    for (var i: u32 = 0u; i < 4u; i = i + 1u) {
      let idx = t + i * 256u;
      let gm = m0 + (idx >> 4u);
      let kk = idx & 15u;
      if (gm < p.M && kt + kk < p.K) { xs[idx] = f32(x[gm * p.K + kt + kk]); } else { xs[idx] = 0.0; }
    }
    let wk = t >> 4u;
    let wq = q0 + (t & 15u);
    if (kt + wk < p.K && wq < p.nq) { ws[t] = w[(kt + wk) * p.nq + wq]; } else { ws[t] = 0u; }
    workgroupBarrier();
    for (var kk: u32 = 0u; kk < 16u; kk = kk + 1u) {
      let word = ws[kk * 16u + cq];
      let b0 = f32(i32(word & 255u) - p.wzp);
      let b1 = f32(i32((word >> 8u) & 255u) - p.wzp);
      let b2 = f32(i32((word >> 16u) & 255u) - p.wzp);
      let b3 = f32(i32((word >> 24u) & 255u) - p.wzp);
      for (var r: u32 = 0u; r < 4u; r = r + 1u) {
        let xv = xs[(rg * 4u + r) * 16u + kk];
        pa[r * 4u] = pa[r * 4u] + xv * b0;
        pa[r * 4u + 1u] = pa[r * 4u + 1u] + xv * b1;
        pa[r * 4u + 2u] = pa[r * 4u + 2u] + xv * b2;
        pa[r * 4u + 3u] = pa[r * 4u + 3u] + xv * b3;
      }
    }
    for (var i: u32 = 0u; i < 16u; i = i + 1u) { acc[i] = acc[i] + i32(pa[i]); }
    workgroupBarrier();
  }
  for (var r: u32 = 0u; r < 4u; r = r + 1u) {
    let gm = m0 + rg * 4u + r;
    for (var c: u32 = 0u; c < 4u; c = c + 1u) {
      let gn = q0 * 4u + cq * 4u + c;
      if (gm < p.M && gn < p.N) { y[gm * p.N + gn] = f32(acc[r * 4u + c]) * p.scale; }
    }
  }
}
`;
// 一個工作群組（64 執行緒）算一個詞表列；每個執行緒讀整個 u32（4 個位元組）。K 必須是 4 的倍數。
const WGSL_Q8LM = `
struct P { rows: u32, K: u32, wzp: i32, scale: f32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> sh: array<f32, 64>;
// @kernel q8lm
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let row = wid.y * 65535u + wid.x;
  let kw = p.K >> 2u;
  var acc: f32 = 0.0;
  if (row < p.rows) {
    let base = row * kw;
    for (var j: u32 = lid.x; j < kw; j = j + 64u) {
      let word = w[base + j];
      let k4 = j * 4u;
      acc = acc + x[k4] * f32(i32(word & 255u) - p.wzp)
                + x[k4 + 1u] * f32(i32((word >> 8u) & 255u) - p.wzp)
                + x[k4 + 2u] * f32(i32((word >> 16u) & 255u) - p.wzp)
                + x[k4 + 3u] * f32(i32((word >> 24u) & 255u) - p.wzp);
    }
  }
  sh[lid.x] = acc;
  workgroupBarrier();
  for (var s: u32 = 32u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { sh[lid.x] = sh[lid.x] + sh[lid.x + s]; }
    workgroupBarrier();
  }
  if (lid.x == 0u && row < p.rows) { y[row] = sh[0] * p.scale; }
}
`;

// ---------- 主機端：緩衝區與分派 ----------
const wcache = new WeakMap();  // 裝置 → WeakMap(Uint8Array → { buf, bytes })
function packedBytes(u8) {
  const padded = (u8.length + 3) & ~3;
  if (padded === u8.length && (u8.byteOffset & 3) === 0) return new Uint8Array(u8.buffer, u8.byteOffset, u8.length);
  const c = new Uint8Array(padded); c.set(u8); return c;
}
// 權重緩衝區：同一個 Uint8Array 在同一裝置上只上傳一次（常駐）
function weightBuf(dev, u8) {
  let m = wcache.get(dev);
  if (!m) { m = new WeakMap(); wcache.set(dev, m); }
  let e = m.get(u8);
  if (!e) {
    const bytes = packedBytes(u8);
    const buf = dev.createBuffer({ size: bytes.byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC });
    dev.queue.writeBuffer(buf, 0, bytes);
    e = { buf: buf, bytes: bytes.byteLength };
    m.set(u8, e);
  }
  return e.buf;
}
const pipes = new WeakMap();  // 裝置 → Map(程式碼 → 管線)
function pipeFor(dev, code) {
  let m = pipes.get(dev);
  if (!m) { m = new Map(); pipes.set(dev, m); }
  let p = m.get(code);
  if (!p) { p = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: code }), entryPoint: 'main' } }); m.set(code, p); }
  return p;
}
function inBuf(dev, arr) {
  const buf = dev.createBuffer({ size: Math.max(4, arr.byteLength), usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC });
  dev.queue.writeBuffer(buf, 0, arr);
  return buf;
}
// 分派一次並讀回輸出（Float32Array，長度 outLen）
async function dispatchRead(dev, code, bufs, outLen, uniform, gx, gy) {
  const out = dev.createBuffer({ size: Math.max(4, outLen * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
  const ub = dev.createBuffer({ size: Math.max(16, Math.ceil(uniform.byteLength / 16) * 16), usage: USAGE.UNIFORM | USAGE.COPY_DST });
  dev.queue.writeBuffer(ub, 0, uniform);
  const pipe = pipeFor(dev, code);
  const all = bufs.concat([out]);
  const entries = all.map((b, i) => ({ binding: i, resource: { buffer: b } }));
  entries.push({ binding: all.length, resource: { buffer: ub } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(gx, gy || 1); pass.end();
  const rb = dev.createBuffer({ size: Math.max(4, outLen * 4), usage: USAGE.MAP_READ | USAGE.COPY_DST });
  enc.copyBufferToBuffer(out, 0, rb, 0, Math.max(4, outLen * 4));
  dev.queue.submit([enc.finish()]);
  await rb.mapAsync(1);
  const res = new Float32Array(rb.getMappedRange().slice(0, outLen * 4));
  rb.unmap();
  out.destroy && out.destroy(); rb.destroy && rb.destroy(); ub.destroy && ub.destroy();
  return res;
}

function unif(fn) { const ab = new ArrayBuffer(32); fn(new DataView(ab)); return new Uint8Array(ab); }

// ---------- 對外 API ----------
// q8mm：xq（Int32Array，M×K，已扣輸入 zero point）、W（Uint8Array，K×N）、wzp、scale = 輸入scale × 權重scale
// opts.q8variant：'simple'（逐格，低階保底）、'dec'（解碼，共用記憶體 GEMV 式）或 'pf'（預填，64×64 平鋪＋4×4 暫存器分塊）；
// 沒給時：N 不是 4 的倍數 → simple；M ≥ 16 → pf；否則 dec。測試與對拍用 opts.q8variant 強制。
// 門檻以實測為準：這台 Kepler 上 M=8 時 pf 比 dec 慢（4.2 ms 對 0.8 ms），M=64 才勝出（4.1 ms 對 5.8 ms）；M=16、32 尚未量，先取已量到的 64。
const Q8_PF_MIN_M = 64;
// 4 ≤ M < 64 → 'decr'（多列解碼，每工作群組 4 列，權重只讀一次）：real Chrome 實測 M=4 0.455→0.40、M=8 0.81→0.65、M=16 1.58→1.135、M=32 2.93→2.115 ms；M=1、2 仍用 'dec'（decr 較慢）。
// K 參數只用來判斷 f32 版是否精確（K ≤ 4096）；沒給 K 時走 i32 的 decr8，一定精確。
function q8mmVariant(N, opts, M, K) {
  const forced = opts && opts.q8variant;
  if (forced === 'simple' || forced === 'dec' || forced === 'pf' || forced === 'decr' || forced === 'decr8' || forced === 'decr8f' || forced === 'pf8x4' || forced === 'decr4f' || forced === 'decr2f') return forced;
  if (N % 4 !== 0) return 'simple';
  if (M !== undefined && M >= Q8_PF_MIN_M) return (K !== undefined && K <= 4096) ? 'pf8x4' : 'pf';   // f32 4×8 分塊（K ≤ 4096 精確）；其餘用 pf
  if (M !== undefined && M >= 8) return (K !== undefined && K <= 4096) ? 'decr8f' : 'decr8';   // f32 8 列版：M=8 0.60→0.44 ms、M=16 1.07→0.79 ms（K ≤ 4096 精確）
  if (M !== undefined && M >= 4) return (K !== undefined && K <= 4096) ? 'decr4f' : 'decr';
  if (M === 2 && K !== undefined && K <= 4096) return 'decr2f';
  return 'dec';
}
async function q8mm(xq, W, wzp, M, K, N, scale, opts) {
  const sc = Math.fround(scale);
  const variant = q8mmVariant(N, opts, M, K);
  return nn.tryLayers('q8mm', opts,
    async (dev) => {
      if (variant !== 'simple' && N % 4 !== 0) throw new Error('q8mm ' + variant + '：N 必須是 4 的倍數（N=' + N + '）');
      const xb = inBuf(dev, Int32Array.from(xq));
      const wb = weightBuf(dev, W);
      let r;
      if (variant === 'dec' || variant === 'pf') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        if (variant === 'dec') r = await dispatchRead(dev, WGSL_Q8MM_DEC, [xb, wb], M * N, u, Math.ceil(N / 64), M);
        else r = await dispatchRead(dev, WGSL_Q8MM_PF, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 64));
      } else if (variant === 'pf8x4') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_PF8X4, [xb, wb], M * N, u, Math.ceil(N / 128), Math.ceil(M / 64));
      } else if (variant === 'decr2f') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_DECR2F, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 2));
      } else if (variant === 'decr4f') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_DECR4F, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 4));
      } else if (variant === 'decr8f') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_DECR8F, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 8));
      } else if (variant === 'decr8') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_DECR8, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 8));
      } else if (variant === 'decr') {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); d.setUint32(20, N >>> 2, true); });
        r = await dispatchRead(dev, WGSL_Q8MM_DECR, [xb, wb], M * N, u, Math.ceil(N / 64), Math.ceil(M / 4));
      } else {
        const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); });
        r = await dispatchRead(dev, WGSL_Q8MM, [xb, wb], M * N, u, Math.ceil(N / 64), M);
      }
      xb.destroy && xb.destroy();
      return r;
    },
    null,
    () => q8mmRef(xq, W, wzp, M, K, N, sc));
}

// ---------- 批次版 q8mm（O6）：輸入 xq 與 sx 都在 GPU 上（來自 nn_ops 批次的 quantizeDyn），整段不回讀 ----------
// 做法：把三個核心的 binding(3) uniform 換成 binding(4)，新增 binding(3) 的 sx（[輸入 scale]），輸出乘上 sx[0]·wscale。
// 權重 wbuf 是 GPU 緩衝區（K×N/4 個 u32，布局與 q8mm 的權重相同：每列 N 個 uint8，小端 4 個一字）；wscale、wzp 是主機端常數。
// 注意：GPU 的 f32 乘法與參考版（f64 算 scale 再 fround）會差 1 ulp 左右，判準用相對誤差，不要求逐位相同（q 本身仍逐位相同）。
function dynKernel(src) {
  return src.replace('@group(0) @binding(3) var<uniform> p: P;', '@group(0) @binding(3) var<storage, read> sx: array<f32>;\n@group(0) @binding(4) var<uniform> p: P;')
    .replace('* p.scale;', '* (sx[2] * p.scale);');   // sx＝quantizeDyn 的 st：[mn, mx, scale, zp]，輸入 scale 在 sx[2]
}
const WGSL_Q8MM_DYN = dynKernel(WGSL_Q8MM);
const WGSL_Q8MM_DEC_DYN = dynKernel(WGSL_Q8MM_DEC);
const WGSL_Q8MM_PF_DYN = dynKernel(WGSL_Q8MM_PF);
const WGSL_Q8MM_DECR_DYN = dynKernel(WGSL_Q8MM_DECR);
const WGSL_Q8MM_DECR8_DYN = dynKernel(WGSL_Q8MM_DECR8);
const WGSL_Q8MM_DECR8F_DYN = dynKernel(WGSL_Q8MM_DECR8F);
const WGSL_Q8MM_PF8X4_DYN = dynKernel(WGSL_Q8MM_PF8X4);
const WGSL_Q8MM_DECR4F_DYN = dynKernel(WGSL_Q8MM_DECR4F);
const WGSL_Q8MM_DECR2F_DYN = dynKernel(WGSL_Q8MM_DECR2F);
// b：nn_ops.createBatch；xq：quantizeDyn 的回傳（{buf, n, st}）；wbuf：GPUBuffer；回傳 { buf, n }（M×N 的 f32 句柄）
function q8mmBatched(b, xq, wbuf, wzp, M, K, N, wscale, opts) {
  const variant = q8mmVariant(N, opts, M, K);
  if (variant !== 'simple' && N % 4 !== 0) throw new Error('q8mm ' + variant + '：N 必須是 4 的倍數（N=' + N + '）');
  const y = b.alloc(M * N);
  const u = new ArrayBuffer(32), d = new DataView(u);
  d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, Math.fround(wscale), true); d.setUint32(20, N >>> 2, true);
  const sx = xq.st.buf;
  if (variant === 'dec') b.dispatchRaw(WGSL_Q8MM_DEC_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), M, 1]);
  else if (variant === 'pf') b.dispatchRaw(WGSL_Q8MM_PF_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 64), 1]);
  else if (variant === 'pf8x4') b.dispatchRaw(WGSL_Q8MM_PF8X4_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 128), Math.ceil(M / 64), 1]);
  else if (variant === 'decr2f') b.dispatchRaw(WGSL_Q8MM_DECR2F_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 2), 1]);
  else if (variant === 'decr4f') b.dispatchRaw(WGSL_Q8MM_DECR4F_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 4), 1]);
  else if (variant === 'decr8f') b.dispatchRaw(WGSL_Q8MM_DECR8F_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 8), 1]);
  else if (variant === 'decr8') b.dispatchRaw(WGSL_Q8MM_DECR8_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 8), 1]);
  else if (variant === 'decr') b.dispatchRaw(WGSL_Q8MM_DECR_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), Math.ceil(M / 4), 1]);
  else b.dispatchRaw(WGSL_Q8MM_DYN, [xq.buf, wbuf, y.buf, sx], new Uint8Array(u), [Math.ceil(N / 64), M, 1]);
  return y;
}

// q8lm：x（Float32Array K）、W（Uint8Array V×K，不論多大；超過儲存緩衝上限時照列分塊）、回傳 logits
// chunks 可選：事先切好的 Uint8Array 陣列（同一個陣列物件重複使用才能常駐），沒給就用 W.subarray 切（每次新物件，不常駐）
function planChunks(W, V, K, maxBytes) {
  const rowsPer = Math.max(1, Math.floor(maxBytes / K));
  const out = [];
  for (let r = 0; r < V; r += rowsPer) { const n = Math.min(rowsPer, V - r); out.push({ row0: r, rows: n, w: W.subarray(r * K, (r + n) * K) }); }
  return out;
}
async function q8lm(x, chunks, wzp, K, scale, opts) {
  const xf = Float32Array.from(x);
  const V = chunks.reduce((s, c) => s + c.rows, 0);
  const sc = Math.fround(scale);
  return nn.tryLayers('q8lm', opts,
    async (dev) => {
      if (K % 4 !== 0) throw new Error('q8lm：K 必須是 4 的倍數（K=' + K + '）');
      const xb = inBuf(dev, xf);
      const out = new Float32Array(V);
      for (const c of chunks) {
        const wb = weightBuf(dev, c.w);
        const u = unif((d) => { d.setUint32(0, c.rows, true); d.setUint32(4, K, true); d.setInt32(8, wzp, true); d.setFloat32(12, sc, true); });
        const r = await dispatchRead(dev, WGSL_Q8LM, [xb, wb], c.rows, u, Math.min(c.rows, MAX_GROUPS), Math.ceil(c.rows / MAX_GROUPS));
        out.set(r, c.row0);
      }
      xb.destroy && xb.destroy();
      return out;
    },
    null,
    () => {
      const o = new Float32Array(V);
      for (const c of chunks) { const r = q8lmRef(xf, c.w, wzp, c.rows, K, sc); for (let i = 0; i < c.rows; i++) o[c.row0 + i] = r[i]; }
      return o;
    });
}

// ---------- WebGL2（T3）：lm_head 的 q8 矩陣乘退路 ----------
// 權重打包成 RGBA8 紋理：每個紋理像素是同一列的 4 個相鄰位元組（k=4j..4j+3），紋理寬度 = maxTex，
// 紋理像素序號 t = 列×(K/4)+j。一個分塊（tile）＝一張 maxTex×maxTex 的紋理（至多 maxTex² 個像素）。
// 片段著色器每個輸出（一個詞表列）讀 K/4 個像素做點積；x 放在寬 K、高 1 的 RGBA32F 紋理（R 通道）。
// 輸出寫進 RGBA32F 的 FBO，readPixels 讀回。需要 EXT_color_buffer_float（nn.glSupport 會檢查）。
const VS_GL = '#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';
const FS_Q8LM_GL = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uW;
uniform highp sampler2D uX;
uniform int uK4;
uniform int uTW;
uniform int uRows;
uniform int uOW;
uniform float uZp;
uniform float uScale;
out vec4 fragColor;
void main() {
  int idx = int(gl_FragCoord.y) * uOW + int(gl_FragCoord.x);
  if (idx >= uRows) { fragColor = vec4(0.0); return; }
  float acc = 0.0;
  for (int j = 0; j < uK4; j++) {
    int t = idx * uK4 + j;
    vec4 b = floor(texelFetch(uW, ivec2(t % uTW, t / uTW), 0) * 255.0 + 0.5);
    int k = j * 4;
    acc += texelFetch(uX, ivec2(k, 0), 0).r * (b.r - uZp)
         + texelFetch(uX, ivec2(k + 1, 0), 0).r * (b.g - uZp)
         + texelFetch(uX, ivec2(k + 2, 0), 0).r * (b.b - uZp)
         + texelFetch(uX, ivec2(k + 3, 0), 0).r * (b.a - uZp);
  }
  fragColor = vec4(acc * uScale, 0.0, 0.0, 1.0);
}`;
const glStateOf = new WeakMap();  // WebGL2 上下文 → { prog, maxTex, weights: WeakMap(權重陣列 → 分塊紋理) }
function glStateFor(gl) {
  let s = glStateOf.get(gl);
  if (!s) {
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    s = { prog: null, maxTex: maxTex, weights: new WeakMap() };
    glStateOf.set(gl, s);
  }
  return s;
}
function glCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('著色器編譯失敗：' + gl.getShaderInfoLog(sh));
  return sh;
}
function glProgramFor(gl, st) {
  if (st.prog) return st.prog;
  const p = gl.createProgram();
  gl.attachShader(p, glCompile(gl, gl.VERTEX_SHADER, VS_GL));
  gl.attachShader(p, glCompile(gl, gl.FRAGMENT_SHADER, FS_Q8LM_GL));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('程式連結失敗：' + gl.getProgramInfoLog(p));
  st.prog = p;
  return p;
}
function glTex2D(gl, internal, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  return t;
}
// 把一個分塊的權重（rows×K 位元組）打包成 maxTex 寬的 RGBA8 紋理（尾端補 0）
function glUploadWeightTile(gl, bytes, texels, maxTex) {
  const th = Math.max(1, Math.ceil(texels / maxTex));
  const px = new Uint8Array(maxTex * th * 4);
  px.set(bytes);
  const t = glTex2D(gl, gl.RGBA8, maxTex, th);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, maxTex, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { tex: t };
}
// WebGL2 版 lm_head：整張權重（V×K）依 maxTex² 切塊，權重紋理快取在上下文上（同一個權重陣列只上傳一次）
function q8lmGl(gl, x, W, V, K, zp, scale) {
  const sup = nn.glSupport(gl);
  if (!sup.ok) throw new Error(sup.reason);
  if (K % 4 !== 0) throw new Error('q8lm（WebGL2）：K 必須是 4 的倍數（K=' + K + '）');
  const st = glStateFor(gl);
  const maxTex = st.maxTex, K4 = K / 4;
  if (K > maxTex) throw new Error('q8lm（WebGL2）：K=' + K + ' 超過紋理寬度上限 ' + maxTex);
  const prog = glProgramFor(gl, st);
  const tileRows = Math.floor(maxTex * maxTex / K4);
  let tiles = st.weights.get(W);
  if (!tiles) {
    tiles = [];
    for (let r0 = 0; r0 < V; r0 += tileRows) {
      const n = Math.min(tileRows, V - r0);
      tiles.push({ row0: r0, rows: n, tex: glUploadWeightTile(gl, W.subarray(r0 * K, (r0 + n) * K), n * K4, maxTex).tex });
    }
    st.weights.set(W, tiles);
  }
  // x：寬 K、高 1 的 RGBA32F（R 通道）
  const xpx = new Float32Array(K * 4);
  for (let k = 0; k < K; k++) xpx[k * 4] = x[k];
  const xTex = glTex2D(gl, gl.RGBA32F, K, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, K, 1, gl.RGBA, gl.FLOAT, xpx);
  const out = new Float32Array(V);
  const fb = gl.createFramebuffer();
  const tmp = [xTex];
  try {
    gl.useProgram(prog);
    const uW = gl.getUniformLocation(prog, 'uW'), uX = gl.getUniformLocation(prog, 'uX');
    gl.uniform1i(uW, 0); gl.uniform1i(uX, 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'uK4'), K4);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTW'), maxTex);
    gl.uniform1f(gl.getUniformLocation(prog, 'uZp'), zp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uScale'), scale);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (const tile of tiles) {
      const ow = Math.min(tile.rows, maxTex), oh = Math.ceil(tile.rows / ow);
      const oTex = glTex2D(gl, gl.RGBA32F, ow, oh);
      tmp.push(oTex);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, oTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL2 幀緩衝區不完整');
      gl.uniform1i(gl.getUniformLocation(prog, 'uRows'), tile.rows);
      gl.uniform1i(gl.getUniformLocation(prog, 'uOW'), ow);
      gl.viewport(0, 0, ow, oh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tile.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, xTex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const buf = new Float32Array(ow * oh * 4);
      gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.FLOAT, buf);
      for (let i = 0; i < tile.rows; i++) out[tile.row0 + i] = buf[i * 4];
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    for (const t of tmp) gl.deleteTexture(t);
  }
  return out;
}

// 分塊快取：同一個權重陣列只切一次（分塊物件穩定，WGSL 端的權重緩衝區才能常駐）
const chunkCache = new WeakMap();
function cachedChunks(W, V, K, maxBytes) {
  let c = chunkCache.get(W);
  if (!c) { c = planChunks(W, V, K, maxBytes); chunkCache.set(W, c); }
  return c;
}
// WebGPU 版 lm_head（分塊、常駐權重）；丟例外由呼叫端決定退路
async function q8lmWgsl(dev, x, chunks, K, zp, scale) {
  if (K % 4 !== 0) throw new Error('q8lm：K 必須是 4 的倍數（K=' + K + '）');
  const xf = Float32Array.from(x);
  const V = chunks.reduce((s, c) => s + c.rows, 0);
  const sc = Math.fround(scale);
  const xb = inBuf(dev, xf);
  const out = new Float32Array(V);
  try {
    for (const c of chunks) {
      const wb = weightBuf(dev, c.w);
      const u = unif((d) => { d.setUint32(0, c.rows, true); d.setUint32(4, K, true); d.setInt32(8, zp, true); d.setFloat32(12, sc, true); });
      const r = await dispatchRead(dev, WGSL_Q8LM, [xb, wb], c.rows, u, Math.min(c.rows, MAX_GROUPS), Math.ceil(c.rows / MAX_GROUPS));
      out.set(r, c.row0);
    }
  } finally { xb.destroy && xb.destroy(); }
  return out;
}

// 自動選層的 lm_head（網頁版與桌面版渲染行程共用）：T1 WebGPU（分塊）→ T3 WebGL2（紋理分塊）。
// 都不可用或執行失敗就丟出「每一層各自的原因」，呼叫端退回 ONNX 路徑；不走慢的純 JS（比 ORT 還慢，沒有意義）。
// opts：{ navigator, gl, skipT1 }（測試用：skipT1 強制走 WebGL2）。回傳 { result, info:{ layer, ms, reasons } }。
async function q8lmAuto(x, W, V, K, zp, scale, opts) {
  const o = opts || {};
  const nav = o.navigator !== undefined ? o.navigator : (typeof navigator !== 'undefined' ? navigator : undefined);
  const reasons = [];
  const t0 = Date.now();
  if (!o.skipT1) {
    const g = await nn.getDevice(nav);
    if (g.dev) {
      try {
        const r = await q8lmWgsl(g.dev, x, cachedChunks(W, V, K, MAX_CHUNK_BYTES), K, zp, scale);
        return { result: r, info: { layer: 'T1', ms: Date.now() - t0, reasons: reasons } };
      } catch (e) { reasons.push('WebGPU 執行失敗：' + String((e && e.message) || e)); }
    } else reasons.push(g.reason || 'WebGPU 不可用');
  } else reasons.push('已指定跳過 WebGPU');
  const gl = o.gl !== undefined ? o.gl : nn.getGl({ navigator: nav });
  if (gl) {
    try {
      const t1 = Date.now();
      const r = q8lmGl(gl, x, W, V, K, zp, scale);
      return { result: r, info: { layer: 'T3', ms: Date.now() - t1, reasons: reasons } };
    } catch (e) { reasons.push('WebGL2 執行失敗：' + String((e && e.message) || e)); }
  } else reasons.push('WebGL2 上下文不可用');
  const err = new Error('lm_head 沒有可用的 GPU 層（' + reasons.join('；') + '）');
  err.reasons = reasons;
  throw err;
}

module.exports = { quantizeDynamicRef, q8mmRef, q8lmRef, q8mm, q8mmVariant, q8lm, q8lmAuto, q8lmGl, q8lmWgsl, cachedChunks, planChunks, WGSL_Q8MM, WGSL_Q8MM_DEC, WGSL_Q8MM_DECR, WGSL_Q8MM_DECR8, WGSL_Q8MM_PF, WGSL_Q8LM, FS_Q8LM_GL, MAX_GROUPS, MAX_CHUNK_BYTES, q8mmBatched, WGSL_Q8MM_DYN, WGSL_Q8MM_DEC_DYN, WGSL_Q8MM_PF_DYN, WGSL_Q8MM_DECR_DYN, WGSL_Q8MM_DECR8_DYN, WGSL_Q8MM_DECR8F_DYN, WGSL_Q8MM_DECR8F, WGSL_Q8MM_DECR4F, WGSL_Q8MM_DECR2F, WGSL_Q8MM_PF8X4 };
