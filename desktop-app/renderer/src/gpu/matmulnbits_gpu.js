'use strict';
// MatMulNBits（bits=4、block 32、無 zero_points）的 GPU 核心（WGSL），退路：WebGL2 未做 → cpu-js（matmulnbits_ref.js）。
// 一個 invocation 算一個輸出格 (m, n)：沿 K 逐元素累加，權重是 4 位元，從 u32 打包的位元組中取出（低位元是偶數 k）。
// 介面與 q8mm 相同風格：matmulNBits(A, M, K, B, scales, N, opts) → {result: Float32Array(M×N), info}。
// pipeline 由 nn.runWgsl 以 WGSL 字串為鍵快取（第二次呼叫不重建，見 gpu_cache_fallback_test.js）；退路：WebGPU 失敗 → cpu-js（matmulnbits_ref）。

const nn = require('./nn_ops.js');
const REF = require('./matmulnbits_ref.js');

const WGSL_MATMULNBITS = `
struct P { M: u32, K: u32, N: u32, nb: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> bq: array<u32>;
@group(0) @binding(2) var<storage, read> sc: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
// @kernel matmulnbits
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // 一維派發（runWgsl 只接受一個數字）：扁平索引 idx = m × npad + n，npad 是 N 向上取 64 的倍數
  let npad = ((p.N + 63u) / 64u) * 64u;
  let idx = gid.x;
  let m = idx / npad;
  let n = idx % npad;
  if (n >= p.N || m >= p.M) { return; }
  var acc: f32 = 0.0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) {
    let b = k / 32u;
    let bi = (n * p.nb + b) * 16u + (k % 32u) / 2u;
    let byte = (bq[bi >> 2u] >> ((bi & 3u) * 8u)) & 255u;
    let nib = (byte >> ((k & 1u) * 4u)) & 15u;
    let w = (f32(nib) - 8.0) * sc[n * p.nb + b];
    acc = acc + a[m * p.K + k] * w;
  }
  y[m * p.N + n] = acc;
}
`;

// 解碼（M 小）變體（清單 O3，@kernel matmulnbits_dec）：一個工作群組 256 執行緒負責「1 列 m × 16 個輸出欄」。
// 執行緒 t：欄 = t/16（16 欄），lane = t%16 負責該欄的 4 位元字（一個 u32 ＝ 8 個權重，同一個區塊的同一個縮放值）。
// 輸入 A 的一段（256 個 k ＝ 32 個字）先搬進共用記憶體 xs（1 KiB），16 條 lane 各取其中 2 個字。
// 反量化在區塊層級：每個字只讀一次縮放值，權重是 nibble−8。最後 16 條 lane 的部分和經共用記憶體 red（1 KiB）歸約。
// 共用記憶體用量：xs 1 KiB ＋ red 1 KiB ＝ 2 KiB。派發：[ceil(N/16), M, 1]。
const WGSL_MATMULNBITS_DEC = `
struct P { M: u32, K: u32, N: u32, nb: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> bq: array<u32>;
@group(0) @binding(2) var<storage, read> sc: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> xs: array<f32, 256>;
var<workgroup> red: array<f32, 256>;
// @kernel matmulnbits_dec
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let t = lid.x;
  let m = wid.y;
  let col = wid.x * 16u + t / 16u;
  let lane = t % 16u;
  let nw = p.nb * 4u;
  var acc: f32 = 0.0;
  for (var kt: u32 = 0u; kt < p.K; kt = kt + 256u) {
    let kk = kt + t;
    if (kk < p.K) { xs[t] = a[m * p.K + kk]; } else { xs[t] = 0.0; }
    workgroupBarrier();
    for (var j: u32 = 0u; j < 2u; j = j + 1u) {
      let wl = lane + j * 16u;
      let gw = kt / 8u + wl;
      if (col < p.N && gw < nw) {
        let word = bq[col * nw + gw];
        let s = sc[col * p.nb + gw / 4u];
        for (var i: u32 = 0u; i < 8u; i = i + 1u) {
          let byte = (word >> ((i / 2u) * 8u)) & 255u;
          let nib = (byte >> ((i & 1u) * 4u)) & 15u;
          acc = acc + xs[wl * 8u + i] * ((f32(nib) - 8.0) * s);
        }
      }
    }
    workgroupBarrier();
  }
  red[t] = acc;
  workgroupBarrier();
  if (lane == 0u && col < p.N) {
    var sum: f32 = 0.0;
    for (var l: u32 = 0u; l < 16u; l = l + 1u) { sum = sum + red[t + l]; }
    y[m * p.N + col] = sum;
  }
}
`;

// 解碼變體的條件：M ≤ 8 用 matmulnbits_dec；其餘（預填）仍用逐格版，預填的平鋪變體尚未實作（見清單 O3）。
const NB_DEC_MAX_M = 8;
function matmulNBitsVariant(M, opts) {
  const forced = opts && opts.nbVariant;
  if (forced === 'matmulnbits' || forced === 'matmulnbits_dec') return forced;
  return M <= NB_DEC_MAX_M ? 'matmulnbits_dec' : 'matmulnbits';
}

// A：Float32Array（M×K），B：Uint8Array（N×nBlocks×16），scales：Float32Array（N×nBlocks）
async function matmulNBits(A, M, K, B, scales, N, opts) {
  const nb = REF.nBlocksOf(K);
  const variant = matmulNBitsVariant(M, opts);
  return nn.tryLayers('matmulnbits', opts,
    async (dev) => {
      if (B.length % 4 !== 0) throw new Error('matmulNBits：B 的長度必須是 4 的倍數（每格 16 位元組）');
      const bq = new Uint32Array(B.length / 4);
      new Uint8Array(bq.buffer).set(B); // 小端序（WebGPU 所在平台皆為小端序）
      const u = new Uint32Array([M, K, N, nb]);
      const bufs = [{ data: Float32Array.from(A) }, { data: bq }, { data: Float32Array.from(scales) }, { data: new Float32Array(M * N), out: true }];
      const outs = variant === 'matmulnbits_dec'
        ? await nn.runWgsl(dev, WGSL_MATMULNBITS_DEC, bufs, new Uint8Array(u.buffer), [Math.ceil(N / 16), M, 1])
        : await nn.runWgsl(dev, WGSL_MATMULNBITS, bufs, new Uint8Array(u.buffer), M * Math.ceil(N / 64));
      return outs[0];
    },
    null,
    () => REF.matmulNBitsRef(A, M, K, B, scales, N));
}

module.exports = { WGSL_MATMULNBITS, WGSL_MATMULNBITS_DEC, matmulNBits, matmulNBitsVariant };
