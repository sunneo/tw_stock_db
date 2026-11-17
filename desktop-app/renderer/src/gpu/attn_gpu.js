// attn_gpu.js — 注意力核心的 GPU 版（DESIGN.webgpu-cuda.md §7.7）。UMD，node 可 require（node 只會走退路）。
// 對外：attnCoreGpu(q, S, past, cache, H, scale, opts) → { result: Float64Array|Float32Array（S×H×hd）, info }
//   info.layer：T1（WGSL）或 cpu-js（參考版，attn_ops.attnCore）；info.reason 寫實際原因。
// 演算法（正確性優先，還沒有優化）：一個 invocation 算一個（查詢位置 i、查詢頭 h），兩段式 softmax（先求最大值與和，再加權）。
// 沒有共享記憶體、沒有分塊；長序列會很慢，速度要另外量（見設計文件）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nn_ops.js'), require('./attn_ops.js'));
  else root.FaAttnGpu = factory(root.FaNnOps, root.FaAttnOps);
})(typeof self !== 'undefined' ? self : this, function (nn, A) {
  'use strict';
  const WGSL_ATTN = `
struct P { S: u32, past: u32, H: u32, Hkv: u32, hd: u32, scale: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
fn score(qo: u32, ko: u32) -> f32 {
  var dot: f32 = 0.0;
  for (var d: u32 = 0u; d < p.hd; d = d + 1u) { dot = dot + q[qo + d] * kc[ko + d]; }
  return dot * p.scale;
}
// @kernel attn
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= p.S * p.H) { return; }
  let i = idx / p.H;
  let h = idx % p.H;
  let kvh = h / (p.H / p.Hkv);
  let hd = p.hd;
  let nKeys = p.past + i + 1u;
  let qo = (i * p.H + h) * hd;
  var mx: f32 = -3.0e38;
  for (var j: u32 = 0u; j < nKeys; j = j + 1u) {
    let s = score(qo, (j * p.Hkv + kvh) * hd);
    if (s > mx) { mx = s; }
  }
  var sum: f32 = 0.0;
  for (var j: u32 = 0u; j < nKeys; j = j + 1u) {
    sum = sum + exp(score(qo, (j * p.Hkv + kvh) * hd) - mx);
  }
  for (var d: u32 = 0u; d < hd; d = d + 1u) { y[qo + d] = 0.0; }
  for (var j: u32 = 0u; j < nKeys; j = j + 1u) {
    let vo = (j * p.Hkv + kvh) * hd;
    let w = exp(score(qo, (j * p.Hkv + kvh) * hd) - mx) / sum;
    for (var d: u32 = 0u; d < hd; d = d + 1u) { y[qo + d] = y[qo + d] + w * vc[vo + d]; }
  }
}
`;
  // 分塊線上 softmax（清單 O4，@kernel attn_flash）：一個工作群組（64 執行緒）負責一個（詞元 i, 查詢頭 h）。
  // 鍵以 256 個一塊處理：64 個執行緒並行算這一塊的分數（存進共用記憶體 sc，1 KiB），再用線上 softmax（最大值與分母隨塊更新，
  // 已累加的輸出乘上修正係數 alpha）把 V 加權進來。每個執行緒負責 hd 的 hd/64 個維度（hd 必須是 64 的倍數且 ≤ 512）。
  // 分數只算一遍；解碼（S=1）與預填（S>1）用同一個核心，預填時每個（詞元, 頭）各一個群組。
  const WGSL_ATTN_FLASH = `
struct P { S: u32, past: u32, H: u32, Hkv: u32, hd: u32, scale: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> sc: array<f32, 256>;
// @kernel attn_flash
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let idx = wid.y * 65535u + wid.x;
  if (idx >= p.S * p.H) { return; }
  let i = idx / p.H;
  let h = idx % p.H;
  let kvh = h / (p.H / p.Hkv);
  let hd = p.hd;
  let t = lid.x;
  let nKeys = p.past + i + 1u;
  let qo = (i * p.H + h) * hd;
  let nd = hd / 64u;
  var acc: array<f32, 8>;
  for (var k: u32 = 0u; k < 8u; k = k + 1u) { acc[k] = 0.0; }
  var m: f32 = -3.0e38;
  var l: f32 = 0.0;
  for (var c0: u32 = 0u; c0 < nKeys; c0 = c0 + 256u) {
    let cn = min(256u, nKeys - c0);
    for (var jj: u32 = t; jj < cn; jj = jj + 64u) {
      let ko = ((c0 + jj) * p.Hkv + kvh) * hd;
      var dot: f32 = 0.0;
      for (var d: u32 = 0u; d < hd; d = d + 1u) { dot = dot + q[qo + d] * kc[ko + d]; }
      sc[jj] = dot * p.scale;
    }
    workgroupBarrier();
    var cm: f32 = -3.0e38;
    for (var j: u32 = 0u; j < cn; j = j + 1u) { cm = max(cm, sc[j]); }
    let mn = max(m, cm);
    let alpha = exp(m - mn);
    l = l * alpha;
    for (var k: u32 = 0u; k < nd; k = k + 1u) { acc[k] = acc[k] * alpha; }
    for (var j: u32 = 0u; j < cn; j = j + 1u) {
      let pj = exp(sc[j] - mn);
      l = l + pj;
      let vo = ((c0 + j) * p.Hkv + kvh) * hd;
      for (var k: u32 = 0u; k < nd; k = k + 1u) { acc[k] = acc[k] + pj * vc[vo + t + k * 64u]; }
    }
    m = mn;
    workgroupBarrier();
  }
  for (var k: u32 = 0u; k < nd; k = k + 1u) { y[qo + t + k * 64u] = acc[k] / l; }
}
`;
  // 與 WGSL_ATTN_FLASH 同一個演算法的 JS 版（每一步都 Math.fround 成 f32），給假裝置與 node 測試用；不進產品路徑。
  function flashRef(q, S, past, cache, H, scale) {
    const hd = cache.hd, Hkv = cache.Hkv, rep = H / Hkv, fr = Math.fround;
    const out = new Float32Array(S * H * hd), sc = new Float32Array(256), acc = new Float32Array(hd);
    for (let i = 0; i < S; i++) {
      const nKeys = past + i + 1;
      for (let h = 0; h < H; h++) {
        const kvh = Math.floor(h / rep), qo = (i * H + h) * hd;
        let m = -3.0e38, l = 0;
        acc.fill(0);
        for (let c0 = 0; c0 < nKeys; c0 += 256) {
          const cn = Math.min(256, nKeys - c0);
          for (let jj = 0; jj < cn; jj++) {
            const ko = ((c0 + jj) * Hkv + kvh) * hd;
            let dot = 0;
            for (let d = 0; d < hd; d++) dot = fr(dot + fr(q[qo + d] * cache.k[ko + d]));
            sc[jj] = fr(dot * fr(scale));
          }
          let cm = -3.0e38;
          for (let j = 0; j < cn; j++) cm = Math.max(cm, sc[j]);
          const mn = Math.max(m, cm), alpha = fr(Math.exp(m - mn));
          l = fr(l * alpha);
          for (let d = 0; d < hd; d++) acc[d] = fr(acc[d] * alpha);
          for (let j = 0; j < cn; j++) {
            const pj = fr(Math.exp(sc[j] - mn));
            l = fr(l + pj);
            const vo = ((c0 + j) * Hkv + kvh) * hd;
            for (let d = 0; d < hd; d++) acc[d] = fr(acc[d] + fr(pj * cache.v[vo + d]));
          }
          m = mn;
        }
        for (let d = 0; d < hd; d++) out[qo + d] = fr(acc[d] / l);
      }
    }
    return out;
  }
  function unif(fn) { const ab = new ArrayBuffer(32); fn(new DataView(ab)); return new Uint8Array(ab); }

  // 選哪個核心：hd 是 64 的倍數且 ≤ 512 → attn_flash（共用記憶體 1 KiB）；否則保底的逐格版。opts.attnVariant 可強制（'attn' 或 'attn_flash'）。
  function attnVariantFor(hd, opts) {
    const forced = opts && opts.attnVariant;
    if (forced === 'attn' || forced === 'attn_flash') return forced;
    return (hd % 64 === 0 && hd <= 512) ? 'attn_flash' : 'attn';
  }

  function attnCoreGpu(q, S, past, cache, H, scale, opts) {
    const hd = cache.hd, Hkv = cache.Hkv, total = S * H;
    if (H % Hkv !== 0) throw new Error('attnCoreGpu：H=' + H + ' 必須是 Hkv=' + Hkv + ' 的整數倍');
    if (q.length !== S * H * hd) throw new Error('attnCoreGpu：q 的長度 ' + q.length + ' 與 S×H×hd=' + (S * H * hd) + ' 不符');
    if (cache.len < past + S) throw new Error('attnCoreGpu：快取只有 ' + cache.len + ' 個詞元，不足 past+S=' + (past + S));
    const variant = attnVariantFor(hd, opts);
    const groups = variant === 'attn_flash' ? total : Math.ceil(total / 64);
    return nn.tryLayers('attn', opts, async (dev) => {
      if (variant === 'attn_flash' && !(hd % 64 === 0 && hd <= 512)) throw new Error('attn_flash：hd=' + hd + ' 必須是 64 的倍數且 ≤ 512');
      if (groups > 65535 && variant === 'attn') throw new Error('attnCoreGpu：工作群組數 ' + groups + ' 超過 65535（請分批）');
      const n = (past + S) * Hkv * hd;
      const qf = Float32Array.from(q);
      const kc = cache.k.subarray(0, n), vc = cache.v.subarray(0, n);
      const uniform = unif((d) => {
        d.setUint32(0, S, true); d.setUint32(4, past, true); d.setUint32(8, H, true); d.setUint32(12, Hkv, true);
        d.setUint32(16, hd, true); d.setFloat32(20, Math.fround(scale), true);
      });
      const code = variant === 'attn_flash' ? WGSL_ATTN_FLASH : WGSL_ATTN;
      const outs = await nn.runWgsl(dev, code,
        [{ data: qf }, { data: kc }, { data: vc }, { data: new Float32Array(total * hd), out: true }], uniform, groups);
      return outs[0];
    }, null, () => A.attnCore(q, S, past, cache, H, scale));
  }

  // 批次版（O6）：q、kc、vc 都是批次的 GPU 句柄（kc、vc 至少 (past+S)·Hkv·hd 個 f32）；回傳 GPU 句柄 y（S·H·hd），整段不回讀。
  // 與 attnCoreGpu 同一組核心與 uniform；綁定順序 q、kc、vc、y、uniform（dispatchRaw 會把 uniform 接在最後）。
  function attnCoreBatched(b, q, kc, vc, S, past, H, Hkv, hd, scale, opts) {
    if (H % Hkv !== 0) throw new Error('attnCoreBatched：H=' + H + ' 必須是 Hkv=' + Hkv + ' 的整數倍');
    const variant = attnVariantFor(hd, opts);
    if (variant === 'attn_flash' && !(hd % 64 === 0 && hd <= 512)) throw new Error('attn_flash：hd=' + hd + ' 必須是 64 的倍數且 ≤ 512');
    const total = S * H;
    const groups = variant === 'attn_flash' ? total : Math.ceil(total / 64);
    if (groups > 65535) throw new Error('attnCoreBatched：工作群組數 ' + groups + ' 超過 65535（請分批）');
    const y = b.alloc(total * hd);
    const uniform = unif((d) => {
      d.setUint32(0, S, true); d.setUint32(4, past, true); d.setUint32(8, H, true); d.setUint32(12, Hkv, true);
      d.setUint32(16, hd, true); d.setFloat32(20, Math.fround(scale), true);
    });
    b.dispatchRaw(variant === 'attn_flash' ? WGSL_ATTN_FLASH : WGSL_ATTN, [q.buf, kc.buf, vc.buf, y.buf], uniform, groups);
    return y;
  }

  return { attnCoreGpu, attnCoreBatched, WGSL_ATTN, WGSL_ATTN_FLASH, flashRef, attnVariantFor };
});
