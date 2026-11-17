// qwen_gpu.js — Qwen3-0.6B（q8）整段 GPU 解碼引擎（WebGPU，WGSL；DESIGN.webgpu-cuda.md §7.13）。
// 一個詞元（或一段預填）的全部運算在同一個 command buffer 裡：RMSNorm、動態量化、q8 投影（整數精確累加）、qk-norm＋RoPE、
// KV 快取、GQA 注意力、SiLU×up、殘差、最後 RMSNorm、lm_head（分塊）、argmax。只讀回一個詞元編號（除錯時可要 logits）。
// 嵌入列在主機端反量化後寫入（嵌入表 155 MB 超過預設的單一緩衝區上限，且每步只有 M 列，很便宜）。
// 數學與 qwen_decode.js 的 CPU 參考引擎相同；沒有 WebGPU 的環境由呼叫端退回既有 ONNX 路徑（本檔不做純 JS 退路：比 ORT 慢，沒有意義）。
// 純 UMD。需要 dev（GPUDevice）；node 無 WebGPU，所以 GPU 驗證在瀏覽器端（scripts/eval/cudaweb_qwen_gpu_browser.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./qwen_decode.js'));
  else root.FaQwenGpu = factory(root.FaQwenDecode);
})(typeof self !== 'undefined' ? self : this, function (Q) {
  'use strict';
  const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
  const STEP = 'struct Step { M: u32, past: u32, a: u32, b: u32 }\n';
  const WGSL = {};
  // 防止編譯器把 a + v*v 融合成 fma（融合會讓平方和差一個 ulp，量化邊界就會翻轉）：經過 bitcast 來回
  const NF = 'fn nf(v: f32) -> f32 { return bitcast<f32>(bitcast<u32>(v)); }\n';

  // 每列 RMSNorm：一個執行緒算一列（平方和依序以 f32 累加，與參考版／ORT 的 f32 順序一致，量化整數才不會在邊界翻轉）。
  // last=1：只算最後一列（輸出寫到第 0 列），給 lm_head 前的 final norm。
  WGSL.rms = NF + STEP + `
struct P { D: u32, last: u32, eps: f32, p1: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@group(0) @binding(4) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var row = gid.x; var dst = gid.x;
  if (p.last == 1u) { if (gid.x != 0u) { return; } row = st.M - 1u; dst = 0u; }
  else if (row >= st.M) { return; }
  let b = row * p.D; let o = dst * p.D;
  var ss: f32 = 0.0;
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { let v = x[b + i]; ss = ss + nf(v * v); }
  let inv = 1.0 / sqrt(ss / f32(p.D) + p.eps);
  for (var i: u32 = 0u; i < p.D; i = i + 1u) { y[o + i] = (x[b + i] * inv) * g[i]; }
}`;

  // 動態量化（整個 M×K 張量一組步長，與 ORT DynamicQuantizeLinear 相同）：輸出已扣 zero point 的整數與步長 qs[0]。單一工作群組。
  WGSL.quant = STEP + `
struct P { K: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> q: array<i32>;
@group(0) @binding(2) var<storage, read_write> qs: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@group(0) @binding(4) var<uniform> st: Step;
var<workgroup> smn: array<f32, 256>;
var<workgroup> smx: array<f32, 256>;
var<workgroup> sh: array<f32, 2>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let total = st.M * p.K;
  var mn: f32 = 0.0; var mx: f32 = 0.0;
  for (var i: u32 = lid.x; i < total; i = i + 256u) { let v = x[i]; mn = min(mn, v); mx = max(mx, v); }
  smn[lid.x] = mn; smx[lid.x] = mx;
  workgroupBarrier();
  for (var s: u32 = 128u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { smn[lid.x] = min(smn[lid.x], smn[lid.x + s]); smx[lid.x] = max(smx[lid.x], smx[lid.x + s]); }
    workgroupBarrier();
  }
  if (lid.x == 0u) {
    let sc = (smx[0] - smn[0]) / 255.0;
    if (sc == 0.0) { sh[0] = 1.0; sh[1] = 0.0; qs[0] = 1.0; }
    else { sh[0] = sc; sh[1] = clamp(round(-smn[0] / sc), 0.0, 255.0); qs[0] = sc; }
  }
  workgroupBarrier();
  let sc = sh[0]; let zp = sh[1];
  for (var i: u32 = lid.x; i < total; i = i + 256u) {
    q[i] = i32(clamp(round(x[i] / sc) + zp, 0.0, 255.0) - zp);
  }
}`;

  // q8 矩陣乘（M 列）：整數精確累加，輸出 = f32(acc) × (輸入步長 × 權重步長)。權重 K×N（列主序，N 連續）。
  WGSL.mm = STEP + `
struct P { K: u32, N: u32, wzp: i32, wscale: f32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read> qs: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@group(0) @binding(5) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x; let m = gid.y;
  if (n >= p.N || m >= st.M) { return; }
  var acc: i32 = 0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) {
    let idx = k * p.N + n;
    let wv = i32((w[idx >> 2u] >> ((idx & 3u) * 8u)) & 255u) - p.wzp;
    acc = acc + x[m * p.K + k] * wv;
  }
  y[m * p.N + n] = f32(acc) * (qs[0] * p.wscale);
}`;

  // qk-norm（每頭 RMSNorm）＋RoPE（rotate-half，查表）；k 寫進 KV 快取（kv 的前半是 K、後半是 V），v 直接複製進快取。
  // 一個執行緒一列：前 M×H 列是 q 頭、後 M×Hkv 列是 k 頭。nw = [q_norm(hd), k_norm(hd)]；trig = [cos(maxT×half), sin(maxT×half)]。
  WGSL.qk = NF + STEP + `
struct P { H: u32, Hkv: u32, hd: u32, maxT: u32, eps: f32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> qin: array<f32>;
@group(0) @binding(1) var<storage, read> kin: array<f32>;
@group(0) @binding(2) var<storage, read> vin: array<f32>;
@group(0) @binding(3) var<storage, read> nw: array<f32>;
@group(0) @binding(4) var<storage, read> trig: array<f32>;
@group(0) @binding(5) var<storage, read_write> qout: array<f32>;
@group(0) @binding(6) var<storage, read_write> kv: array<f32>;
@group(0) @binding(7) var<uniform> p: P;
@group(0) @binding(8) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let Nq = p.H * p.hd; let Nk = p.Hkv * p.hd; let half = p.hd / 2u;
  let qRows = st.M * p.H; let kRows = st.M * p.Hkv;
  if (r >= qRows + kRows) { return; }
  var t: array<f32, 128>;
  var ss: f32 = 0.0;
  if (r < qRows) {
    let m = r / p.H; let h = r % p.H; let src = m * Nq + h * p.hd;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { let v = qin[src + d]; t[d] = v; ss = ss + nf(v * v); }
    let inv = 1.0 / sqrt(ss / f32(p.hd) + p.eps);
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { t[d] = (t[d] * inv) * nw[d]; }
    let pos = st.past + m;
    for (var i: u32 = 0u; i < half; i = i + 1u) {
      let c = trig[pos * half + i]; let s = trig[p.maxT * half + pos * half + i];
      let a = t[i]; let b = t[i + half];
      qout[src + i] = a * c - b * s;
      qout[src + i + half] = b * c + a * s;
    }
  } else {
    let r2 = r - qRows; let m = r2 / p.Hkv; let hk = r2 % p.Hkv; let src = m * Nk + hk * p.hd;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { let v = kin[src + d]; t[d] = v; ss = ss + nf(v * v); }
    let inv = 1.0 / sqrt(ss / f32(p.hd) + p.eps);
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { t[d] = (t[d] * inv) * nw[p.hd + d]; }
    let pos = st.past + m;
    let dst = pos * Nk + hk * p.hd;
    for (var i: u32 = 0u; i < half; i = i + 1u) {
      let c = trig[pos * half + i]; let s = trig[p.maxT * half + pos * half + i];
      let a = t[i]; let b = t[i + half];
      kv[dst + i] = a * c - b * s;
      kv[dst + i + half] = b * c + a * s;
    }
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { kv[p.maxT * Nk + dst + d] = vin[src + d]; }
  }
}`;

  // GQA 因果注意力：一個執行緒算一個（詞元、查詢頭）；分數暫存在 sc（M×H×maxT）。
  WGSL.attn = STEP + `
struct P { H: u32, Hkv: u32, hd: u32, maxT: u32, scale: f32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kv: array<f32>;
@group(0) @binding(2) var<storage, read_write> sc: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@group(0) @binding(5) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= st.M * p.H) { return; }
  let Nq = p.H * p.hd; let Nk = p.Hkv * p.hd;
  let m = idx / p.H; let h = idx % p.H; let kvh = h / (p.H / p.Hkv);
  let nk = st.past + m + 1u;
  let qo = m * Nq + h * p.hd;
  let kb = kvh * p.hd; let vb = p.maxT * Nk + kvh * p.hd;
  let sb = idx * p.maxT;
  var mx: f32 = -3.0e38;
  for (var j: u32 = 0u; j < nk; j = j + 1u) {
    var dot: f32 = 0.0; let ko = j * Nk + kb;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { dot = dot + q[qo + d] * kv[ko + d]; }
    let w = dot * p.scale; sc[sb + j] = w; mx = max(mx, w);
  }
  var sum: f32 = 0.0;
  for (var j: u32 = 0u; j < nk; j = j + 1u) { let e = exp(sc[sb + j] - mx); sc[sb + j] = e; sum = sum + e; }
  var o: array<f32, 128>;
  for (var d: u32 = 0u; d < p.hd; d = d + 1u) { o[d] = 0.0; }
  for (var j: u32 = 0u; j < nk; j = j + 1u) {
    let pj = sc[sb + j] / sum; let vo = j * Nk + vb;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { o[d] = o[d] + pj * kv[vo + d]; }
  }
  for (var d: u32 = 0u; d < p.hd; d = d + 1u) { out[qo + d] = o[d]; }
}`;

  WGSL.silu = STEP + `
struct P { I: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> gate: array<f32>;
@group(0) @binding(1) var<storage, read> up: array<f32>;
@group(0) @binding(2) var<storage, read_write> act: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@group(0) @binding(4) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= st.M * p.I) { return; }
  let g = gate[i];
  act[i] = (g / (1.0 + exp(-g))) * up[i];
}`;

  WGSL.add = STEP + `
struct P { D: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> o: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@group(0) @binding(4) var<uniform> st: Step;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= st.M * p.D) { return; }
  o[i] = a[i] + b[i];
}`;

  // lm_head（與嵌入共用的 q8；一個工作群組一列）。與 infer_ops 的 WGSL_Q8LM 相同。
  WGSL.lm = `
struct P { rows: u32, K: u32, wzp: i32, scale: f32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> sh: array<f32, 64>;
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
}`;

  // argmax：嚴格大於、索引小者優先（與 JS 版相同的平手規則）
  WGSL.argmax = `
struct P { V: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> lg: array<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
var<workgroup> sv: array<f32, 256>;
var<workgroup> si: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  var bv: f32 = -3.0e38; var bi: u32 = 0u;
  for (var i: u32 = lid.x; i < p.V; i = i + 256u) { let v = lg[i]; if (v > bv) { bv = v; bi = i; } }
  sv[lid.x] = bv; si[lid.x] = bi;
  workgroupBarrier();
  for (var s: u32 = 128u; s > 0u; s = s >> 1u) {
    if (lid.x < s) {
      let ov = sv[lid.x + s]; let oi = si[lid.x + s];
      if (ov > sv[lid.x] || (ov == sv[lid.x] && oi < si[lid.x])) { sv[lid.x] = ov; si[lid.x] = oi; }
    }
    workgroupBarrier();
  }
  if (lid.x == 0u) { out[0] = si[0]; }
}`;

  const WGSL_ALL = WGSL;

  // dev：GPUDevice；W：Q.loadWeights 的結果。opts：{ maxT=512, maxM=64, chunkBytes=64MiB }
  // 配置前估算 GPU 緩衝區總量（位元組；與 createGpuEngine 的 createBuffer 逐項對應，每個緩衝區湊成 4 的倍數、最少 16）。
  // 回傳 { total, weights, kv, scratch, lmHead }。opts：maxT（預設 512）、maxM（預設 64）。
  function estimateEngineBytes(W, opts) {
    const o = opts || {}, maxT = o.maxT || 512, maxM = o.maxM || 64;
    const D = W.D, H = W.H, Hkv = W.Hkv, hd = W.hd, Nq = H * hd, Nk = Hkv * hd, I = W.I, V = W.V;
    const sz = (n) => Math.max(16, (n + 3) & ~3);
    let weights = 0, kv = 0, scratch = 0;
    for (let l = 0; l < W.L; l++) {
      const Ly = W.layers[l];
      for (const k of ['q', 'k', 'v', 'o', 'g', 'u', 'd']) weights += sz(Ly[k].W.length);
      weights += sz(Ly.inNorm.byteLength) + sz(Ly.postNorm.byteLength) + sz(2 * hd * 4) + 18 * 32;
      kv += sz(2 * maxT * Nk * 4);
    }
    const lmHead = sz(W.emb.W.length) + 5 * 32;   // lm_head 分塊後總和等於整張嵌入表（每塊再湊 4 的倍數，差距可忽略）
    const m = maxM;
    for (const n of [m * D * 4, m * D * 4, m * D * 4, m * Math.max(Nq, D, I) * 4, 16, m * Nq * 4, m * Nk * 4, m * Nk * 4, m * Nq * 4, m * Nq * 4,
      m * D * 4, m * I * 4, m * I * 4, m * I * 4, m * D * 4, m * H * maxT * 4, D * 4, V * 4, 16, 2 * maxT * (hd / 2) * 4, W.finalNorm.byteLength]) scratch += sz(n);
    scratch += 16 + 16;                                                  // step 緩衝區、讀回 token
    scratch += sz(V * 4) + 2 * sz(W.L * m * D * 4);                      // 讀回 logits、逐層追蹤（除錯用）與其讀回緩衝區
    return { total: weights + kv + scratch + lmHead, weights, kv, scratch, lmHead };
  }

  // 回傳 { step(ids, {logits}) → {token, logits?}, reset(), len, maxT, maxM, info, destroy() }；任何 GPU 錯誤由 step 的 Promise 丟出，呼叫端退回。
  // opts.budgetBytes（>0）：GPU 記憶體上限。配置前先估算，超過就丟 Error（code='GPU_BUDGET'，帶 need／budget），什麼都還沒配置，呼叫端退回原路徑；
  //   沒有「每層串流權重」的實作（見 DESIGN §7.30），所以超過上限＝不用這條路徑。
  async function createGpuEngine(dev, W, opts) {
    const o = opts || {}, maxT = o.maxT || 512, maxM = o.maxM || 64;
    const D = W.D, H = W.H, Hkv = W.Hkv, hd = W.hd, Nq = H * hd, Nk = Hkv * hd, I = W.I, V = W.V;
    if (hd > 128 || hd % 2) throw new Error('qwen_gpu：head 維度 ' + hd + ' 不支援（需為 ≤128 的偶數）');
    if (D % 4) throw new Error('qwen_gpu：隱藏維度必須是 4 的倍數');
    const need = estimateEngineBytes(W, { maxT, maxM });
    if (o.budgetBytes > 0 && need.total > o.budgetBytes) {
      const e = new Error('qwen_gpu：需要約 ' + Math.ceil(need.total / 1048576) + ' MB GPU 記憶體（權重 ' + Math.ceil((need.weights + need.lmHead) / 1048576) + '＋KV ' + Math.ceil(need.kv / 1048576) + '＋暫存 ' + Math.ceil(need.scratch / 1048576) + '），超過上限 ' + Math.ceil(o.budgetBytes / 1048576) + ' MB');
      e.code = 'GPU_BUDGET'; e.need = need; e.budget = o.budgetBytes; throw e;
    }
    const lim = dev.limits || {};
    const chunkBytes = Math.min(o.chunkBytes || (64 << 20), lim.maxStorageBufferBindingSize || (128 << 20));
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    let gpuBytes = 0;
    const mk = (size, usage) => { const n = Math.max(16, (size + 3) & ~3); gpuBytes += n; return dev.createBuffer({ size: n, usage }); };
    const ST = USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC;
    const bufs = [];
    const sbuf = (size) => { const b = mk(size, ST); bufs.push(b); return b; };
    const wbuf = (u8) => { const b = mk(u8.length, ST); dev.queue.writeBuffer(b, 0, u8, 0, u8.length & ~3); if (u8.length & 3) { const t = new Uint8Array(4); t.set(u8.subarray(u8.length & ~3)); dev.queue.writeBuffer(b, u8.length & ~3, t); } bufs.push(b); return b; };
    const fbuf = (f32) => { const b = mk(f32.byteLength, ST); dev.queue.writeBuffer(b, 0, f32); bufs.push(b); return b; };
    const ubuf = (fn) => { const ab = new ArrayBuffer(32); fn(new DataView(ab)); const b = mk(32, USAGE.UNIFORM | USAGE.COPY_DST); dev.queue.writeBuffer(b, 0, new Uint8Array(ab)); bufs.push(b); return b; };

    const mods = {}, pipes = {};
    for (const k of Object.keys(WGSL_ALL)) {
      mods[k] = dev.createShaderModule({ code: WGSL_ALL[k] });
      pipes[k] = dev.createComputePipeline({ layout: 'auto', compute: { module: mods[k], entryPoint: 'main' } });
    }
    // 取得編譯錯誤（createShaderModule 不會丟例外，錯在 getCompilationInfo）
    for (const k of Object.keys(mods)) {
      if (mods[k].getCompilationInfo) {
        const ci = await mods[k].getCompilationInfo();
        const errs = ci.messages.filter((m) => m.type === 'error');
        if (errs.length) throw new Error('qwen_gpu：WGSL「' + k + '」編譯失敗：' + errs.map((m) => m.lineNum + ':' + m.message).join('；'));
      }
    }

    // 活動緩衝區（以 maxM 列配置）
    const stBuf = mk(16, USAGE.UNIFORM | USAGE.COPY_DST); bufs.push(stBuf);
    const hA = sbuf(maxM * D * 4), hB = sbuf(maxM * D * 4), xn = sbuf(maxM * D * 4);
    const qi = sbuf(maxM * Math.max(Nq, D, I) * 4), qs = sbuf(16);
    const qb = sbuf(maxM * Nq * 4), kb = sbuf(maxM * Nk * 4), vb = sbuf(maxM * Nk * 4), qr = sbuf(maxM * Nq * 4), ao = sbuf(maxM * Nq * 4);
    const ob = sbuf(maxM * D * 4), gb = sbuf(maxM * I * 4), ub = sbuf(maxM * I * 4), act = sbuf(maxM * I * 4), db = sbuf(maxM * D * 4);
    const scr = sbuf(maxM * H * maxT * 4);
    const xlast = sbuf(D * 4), logits = sbuf(V * 4), tokBuf = sbuf(16);
    const half = hd / 2, trig = new Float32Array(2 * maxT * half);
    for (let p = 0; p < maxT; p++) for (let i = 0; i < half; i++) { const ang = p * Math.pow(W.theta, -2 * i / hd); trig[p * half + i] = Math.cos(ang); trig[maxT * half + p * half + i] = Math.sin(ang); }
    const trigB = fbuf(trig);
    const finalN = fbuf(W.finalNorm);

    // 每層：權重、norm、KV 快取；並預先建好整條派發計畫（bind group 重複使用，每步只改 step 緩衝區與派發數）
    const plan = [];
    const bg = (k, list) => dev.createBindGroup({ layout: pipes[k].getBindGroupLayout(0), entries: list.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const add = (k, list, groups) => plan.push({ pipe: pipes[k], bg: bg(k, list), groups });
    const g1 = (n) => (M) => [Math.ceil(n(M) / 64), 1];
    const rowsG = (M) => [Math.ceil(M / 64), 1];
    const mmG = (N) => (M) => [Math.ceil(N / 64), M];
    const mmAdd = (src, w, out) => {
      const wb = wbuf(w.W);
      const u = ubuf((d) => { d.setUint32(0, w.K, true); d.setUint32(4, w.N, true); d.setInt32(8, w.zp, true); d.setFloat32(12, Math.fround(w.scale), true); });
      add('mm', [src, wb, qs, out, u, stBuf], mmG(w.N));
    };
    const quantAdd = (src, K) => add('quant', [src, qi, qs, ubuf((d) => d.setUint32(0, K, true)), stBuf], () => [1, 1]);
    const rmsAdd = (src, g, dst, last) => add('rms', [src, g, dst, ubuf((d) => { d.setUint32(0, D, true); d.setUint32(4, last ? 1 : 0, true); d.setFloat32(8, W.eps, true); }), stBuf], last ? () => [1, 1] : rowsG);
    const kvBufs = [], layerEnd = [];
    for (let l = 0; l < W.L; l++) {
      const Ly = W.layers[l];
      const kv = sbuf(2 * maxT * Nk * 4); kvBufs.push(kv);
      const inN = fbuf(Ly.inNorm), postN = fbuf(Ly.postNorm);
      const nw = new Float32Array(2 * hd); nw.set(Ly.qNorm, 0); nw.set(Ly.kNorm, hd); const nwB = fbuf(nw);
      rmsAdd(hA, inN, xn, false); quantAdd(xn, D);
      mmAdd(qi, Ly.q, qb); mmAdd(qi, Ly.k, kb); mmAdd(qi, Ly.v, vb);
      add('qk', [qb, kb, vb, nwB, trigB, qr, kv, ubuf((d) => { d.setUint32(0, H, true); d.setUint32(4, Hkv, true); d.setUint32(8, hd, true); d.setUint32(12, maxT, true); d.setFloat32(16, W.eps, true); }), stBuf], (M) => [Math.ceil(M * (H + Hkv) / 64), 1]);
      add('attn', [qr, kv, scr, ao, ubuf((d) => { d.setUint32(0, H, true); d.setUint32(4, Hkv, true); d.setUint32(8, hd, true); d.setUint32(12, maxT, true); d.setFloat32(16, 1 / Math.sqrt(hd), true); }), stBuf], (M) => [Math.ceil(M * H / 64), 1]);
      quantAdd(ao, Nq); mmAdd(qi, Ly.o, ob);
      add('add', [hA, ob, hB, ubuf((d) => d.setUint32(0, D, true)), stBuf], (M) => [Math.ceil(M * D / 64), 1]);
      rmsAdd(hB, postN, xn, false); quantAdd(xn, D);
      mmAdd(qi, Ly.g, gb); mmAdd(qi, Ly.u, ub);
      add('silu', [gb, ub, act, ubuf((d) => d.setUint32(0, I, true)), stBuf], (M) => [Math.ceil(M * I / 64), 1]);
      quantAdd(act, I); mmAdd(qi, Ly.d, db);
      add('add', [hB, db, hA, ubuf((d) => d.setUint32(0, D, true)), stBuf], (M) => [Math.ceil(M * D / 64), 1]);
      layerEnd.push(plan.length);
    }
    rmsAdd(hA, finalN, xlast, true);
    // lm_head 分塊（列數取 64 的倍數，logits 的綁定位移要符合 256 位元組對齊）
    const align = (lim.minStorageBufferOffsetAlignment || 256) / 4;
    const rowsPer = Math.max(align, Math.floor(chunkBytes / D / align) * align);
    const lmChunks = [];
    for (let r = 0; r < V; r += rowsPer) {
      const n = Math.min(rowsPer, V - r);
      const wb = wbuf(W.emb.W.subarray(r * D, (r + n) * D));
      const u = ubuf((d) => { d.setUint32(0, n, true); d.setUint32(4, D, true); d.setInt32(8, W.emb.zp, true); d.setFloat32(12, Math.fround(W.emb.scale), true); });
      const entries = [{ binding: 0, resource: { buffer: xlast } }, { binding: 1, resource: { buffer: wb } }, { binding: 2, resource: { buffer: logits, offset: r * 4, size: n * 4 } }, { binding: 3, resource: { buffer: u } }];
      plan.push({ pipe: pipes.lm, bg: dev.createBindGroup({ layout: pipes.lm.getBindGroupLayout(0), entries }), groups: () => [Math.min(n, 65535), Math.ceil(n / 65535)] });
      lmChunks.push(n);
    }
    add('argmax', [logits, tokBuf, ubuf((d) => d.setUint32(0, V, true))], () => [1, 1]);
    const rbTok = dev.createBuffer({ size: 16, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const rbLg = dev.createBuffer({ size: V * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const traceB = dev.createBuffer({ size: W.L * maxM * D * 4, usage: USAGE.COPY_DST | USAGE.COPY_SRC }), rbTr = dev.createBuffer({ size: W.L * maxM * D * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    gpuBytes += 16 + V * 4 + 2 * W.L * maxM * D * 4;
    if (dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone();
    let len = 0, dead = '', chain = Promise.resolve();
    const chunkM = Math.max(1, Math.min(maxM, o.chunkM || 16));
    if (dev.lost && dev.lost.then) dev.lost.then((i) => { dead = dead || ('裝置遺失：' + (i && (i.reason || '') + ' ' + (i && i.message || '')).trim()); console.warn('[gpu] qwen 引擎裝置遺失：' + dead.slice(0, 200) + '；最近的 GPU 工作：' + (globalThis.__faGpuLast || '未知')); });
    const info = { maxT, maxM, dispatches: plan.length, lmChunks: lmChunks.length, setupMs: (typeof performance !== 'undefined' ? performance : Date).now() - t0, steps: 0, lastStepMs: 0, gpuBytes, estimateBytes: need.total };

    const eng = {
      get len() { return len; }, maxT, maxM, info,
      reset() { len = 0; },
      async stepOnce(ids, so) {
        if (dead) throw new Error('GPU 裝置已遺失：' + dead);
        const M = ids.length;
        if (M < 1 || M > maxM) throw new Error('qwen_gpu：一次的詞元數 ' + M + ' 超出範圍 1..' + maxM);
        if (len + M > maxT) throw new Error('qwen_gpu：序列超過上限 ' + maxT);
        const ts = (typeof performance !== 'undefined' ? performance : Date).now();
        dev.queue.writeBuffer(hA, 0, Q.embedRows(W, ids));
        dev.queue.writeBuffer(stBuf, 0, new Uint32Array([M, len, 0, 0]));
        const trace = !!(so && so.trace);
        const wantLg = !!(so && so.logits);
        if (!trace) {
          // 一層一次提交（不是整步一個 command buffer）：舊顯卡（例如 Geforce 720）單次提交跑太久會被 Windows 判定 GPU 卡死（DXGI_ERROR_DEVICE_HUNG）；
          // 每 4 層再等一次完成，讓每段 GPU 工作都夠短，也讓頁面有機會喘氣
          let i = 0;
          for (let l = 0; l <= W.L; l++) {
            const stop = l < W.L ? layerEnd[l] : plan.length;
            globalThis.__faGpuLast = 'qwen_gpu 第 ' + l + ' 層（M=' + M + '，已提交到第 ' + i + ' 個派發）';
            const enc = dev.createCommandEncoder(); const pass = enc.beginComputePass();
            for (; i < stop; i++) { const d = plan[i], g = d.groups(M); pass.setPipeline(d.pipe); pass.setBindGroup(0, d.bg); pass.dispatchWorkgroups(g[0], g[1]); }
            pass.end();
            if (l === W.L) { enc.copyBufferToBuffer(tokBuf, 0, rbTok, 0, 4); if (wantLg) enc.copyBufferToBuffer(logits, 0, rbLg, 0, V * 4); }
            dev.queue.submit([enc.finish()]);
            if (l % 4 === 3 && l < W.L && dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone();
            if (dead) throw new Error('GPU 裝置已遺失：' + dead);
          }
        } else {
          const enc = dev.createCommandEncoder();
          // 診斷：每層結束後把殘差流複製出來（每層一個 pass）
          let i = 0;
          for (let l = 0; l <= W.L; l++) {
            const stop = l < W.L ? layerEnd[l] : plan.length;
            const pass = enc.beginComputePass();
            for (; i < stop; i++) { const d = plan[i], g = d.groups(M); pass.setPipeline(d.pipe); pass.setBindGroup(0, d.bg); pass.dispatchWorkgroups(g[0], g[1]); }
            pass.end();
            if (l < W.L) enc.copyBufferToBuffer(hA, 0, traceB, l * maxM * D * 4, M * D * 4);
          }
          enc.copyBufferToBuffer(traceB, 0, rbTr, 0, W.L * maxM * D * 4);
          enc.copyBufferToBuffer(tokBuf, 0, rbTok, 0, 4);
          if (wantLg) enc.copyBufferToBuffer(logits, 0, rbLg, 0, V * 4);
          dev.queue.submit([enc.finish()]);
        }
        await rbTok.mapAsync(1);
        const token = new Uint32Array(rbTok.getMappedRange().slice(0, 4))[0];
        rbTok.unmap();
        let tr = null;
        if (trace) { await rbTr.mapAsync(1); const all = new Float32Array(rbTr.getMappedRange().slice(0)); rbTr.unmap(); tr = []; for (let l = 0; l < W.L; l++) tr.push(all.slice(l * maxM * D, l * maxM * D + M * D)); }
        let lg = null;
        if (wantLg) { await rbLg.mapAsync(1); lg = new Float32Array(rbLg.getMappedRange().slice(0, V * 4)); rbLg.unmap(); }
        len += M; info.steps++; info.lastStepMs = (typeof performance !== 'undefined' ? performance : Date).now() - ts;
        const r = { token }; if (lg) r.logits = lg; if (tr) r.trace = tr; return r;
      },
      // 對外的 step：一次一個（串行，避免上一次的 mapAsync 還沒結束又開下一次）；長提示切成 chunkM 個詞元一段（每段的 GPU 工作都短）；
      // 任何錯誤都把引擎標成失效（之後的呼叫直接丟錯，呼叫端應丟掉這個引擎）並把還在映射的緩衝區解除映射
      step(ids, so) {
        const run = async () => {
          try {
            if (dead) throw new Error('GPU 裝置已遺失：' + dead);
            let r = null;
            for (let o = 0; o < ids.length; o += chunkM) r = await eng.stepOnce(ids.slice(o, o + chunkM), so);
            return r;
          } catch (e) {
            dead = dead || String((e && e.message) || e);
            for (const b of [rbTok, rbLg, rbTr]) { try { if (b.mapState === 'mapped') b.unmap(); } catch (_) { /* 已釋放 */ } }
            throw e;
          }
        };
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
      },
      get dead() { return dead; },
      destroy() { for (const b of bufs) { try { b.destroy(); } catch (e) { /* 已釋放 */ } } try { rbTok.destroy(); rbLg.destroy(); traceB.destroy(); rbTr.destroy(); } catch (e) { /* 已釋放 */ } },
    };
    return eng;
  }

  return { createGpuEngine, estimateEngineBytes, WGSL: WGSL_ALL };
});
