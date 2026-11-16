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
  function unif(fn) { const ab = new ArrayBuffer(32); fn(new DataView(ab)); return new Uint8Array(ab); }

  function attnCoreGpu(q, S, past, cache, H, scale, opts) {
    const hd = cache.hd, Hkv = cache.Hkv, total = S * H;
    if (H % Hkv !== 0) throw new Error('attnCoreGpu：H=' + H + ' 必須是 Hkv=' + Hkv + ' 的整數倍');
    if (q.length !== S * H * hd) throw new Error('attnCoreGpu：q 的長度 ' + q.length + ' 與 S×H×hd=' + (S * H * hd) + ' 不符');
    if (cache.len < past + S) throw new Error('attnCoreGpu：快取只有 ' + cache.len + ' 個詞元，不足 past+S=' + (past + S));
    const groups = Math.ceil(total / 64);
    return nn.tryLayers('attn', opts, async (dev) => {
      if (groups > 65535) throw new Error('attnCoreGpu：工作群組數 ' + groups + ' 超過 65535（請分批）');
      const n = (past + S) * Hkv * hd;
      const qf = Float32Array.from(q);
      const kc = cache.k.subarray(0, n), vc = cache.v.subarray(0, n);
      const uniform = unif((d) => {
        d.setUint32(0, S, true); d.setUint32(4, past, true); d.setUint32(8, H, true); d.setUint32(12, Hkv, true);
        d.setUint32(16, hd, true); d.setFloat32(20, Math.fround(scale), true);
      });
      const outs = await nn.runWgsl(dev, WGSL_ATTN,
        [{ data: qf }, { data: kc }, { data: vc }, { data: new Float32Array(total * hd), out: true }], uniform, groups);
      return outs[0];
    }, null, () => A.attnCore(q, S, past, cache, H, scale));
  }

  return { attnCoreGpu, WGSL_ATTN };
});
