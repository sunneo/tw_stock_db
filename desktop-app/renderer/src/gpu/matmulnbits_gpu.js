'use strict';
// MatMulNBits（bits=4、block 32、無 zero_points）的 GPU 核心（WGSL），退路：WebGL2 未做 → cpu-js（matmulnbits_ref.js）。
// 一個 invocation 算一個輸出格 (m, n)：沿 K 逐元素累加，權重是 4 位元，從 u32 打包的位元組中取出（低位元是偶數 k）。
// 介面與 q8mm 相同風格：matmulNBits(A, M, K, B, scales, N, opts) → {result: Float32Array(M×N), info}。
// 注意：這一版沒有快取 pipeline（runWgsl 每次重建），速度不是本版的目標。

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

// A：Float32Array（M×K），B：Uint8Array（N×nBlocks×16），scales：Float32Array（N×nBlocks）
async function matmulNBits(A, M, K, B, scales, N, opts) {
  const nb = REF.nBlocksOf(K);
  return nn.tryLayers('matmulnbits', opts,
    async (dev) => {
      if (B.length % 4 !== 0) throw new Error('matmulNBits：B 的長度必須是 4 的倍數（每格 16 位元組）');
      const bq = new Uint32Array(B.length / 4);
      new Uint8Array(bq.buffer).set(B); // 小端序（WebGPU 所在平台皆為小端序）
      const u = new Uint32Array([M, K, N, nb]);
      const outs = await nn.runWgsl(dev, WGSL_MATMULNBITS,
        [{ data: Float32Array.from(A) }, { data: bq }, { data: Float32Array.from(scales) }, { data: new Float32Array(M * N), out: true }],
        new Uint8Array(u.buffer), M * Math.ceil(N / 64));
      return outs[0];
    },
    null,
    () => REF.matmulNBitsRef(A, M, K, B, scales, N));
}

module.exports = { WGSL_MATMULNBITS, matmulNBits };
