'use strict';
// MatMulNBits 投影的 CPU 參考版（ONNX com.microsoft MatMulNBits，bits=4、block_size=32、無 zero_points）。
// 佈局（與 ONNX 規格一致）：
//   B：uint8 [N, nBlocks, 16]，nBlocks = ceil(K / 32)；每個 block 的 16 個位元組，第 j 個位元組的低 4 位是 k = b*32 + 2j，高 4 位是 k = b*32 + 2j + 1。
//   scales：[N, nBlocks]（浮點）；沒有 zero_points 時，零點固定為 8（4 位元的中點）。
//   反量化：w[n,k] = (q[n,k] - zp) * scale[n, b]，b = floor(k / 32)。
//   輸出 Y[m,n] = Σ_k A[m,k] · w[n,k]，即 Y = A · Wᵀ。
// 本檔只是參考實作與介面，不含 GPU 核心；網頁版真正的 q4 權重尚未在本機取得，所以目前沒有與 q8 路徑的真權重對拍。

const BLOCK = 32, BYTES = 16, ZP = 8;

function nBlocksOf(K) { return Math.ceil(K / BLOCK); }

// 把 B 解成每個 (n, k) 的 4 位元整數（Uint8Array，長度 N×K，已去掉 K 之後的 padding）
function unpackQ4(B, N, K) {
  const nb = nBlocksOf(K);
  if (B.length !== N * nb * BYTES) throw new Error('unpackQ4：B 的長度 ' + B.length + ' 與 N×nBlocks×16=' + (N * nb * BYTES) + ' 不符');
  const q = new Uint8Array(N * K);
  for (let n = 0; n < N; n++) {
    for (let b = 0; b < nb; b++) {
      const base = (n * nb + b) * BYTES;
      for (let j = 0; j < BYTES; j++) {
        const k0 = b * BLOCK + 2 * j, k1 = k0 + 1, byte = B[base + j];
        if (k0 < K) q[n * K + k0] = byte & 0x0f;
        if (k1 < K) q[n * K + k1] = byte >> 4;
      }
    }
  }
  return q;
}

// 反量化成 Float32Array（N×K），用於參考與測試
function dequantQ4(B, scales, N, K, zp = ZP) {
  const nb = nBlocksOf(K);
  if (scales.length !== N * nb) throw new Error('dequantQ4：scales 的長度 ' + scales.length + ' 與 N×nBlocks=' + (N * nb) + ' 不符');
  const q = unpackQ4(B, N, K);
  const w = new Float32Array(N * K);
  for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) {
    w[n * K + k] = (q[n * K + k] - zp) * scales[n * nb + Math.floor(k / BLOCK)];
  }
  return w;
}

// Y = A · Wᵀ，A 是 M×K（Float32Array，列優先），回傳 Float32Array（M×N）。
// 累加用 f64，最後存成 f32（參考版的數值基準）。
function matmulNBitsRef(A, M, K, B, scales, N, zp = ZP) {
  if (A.length !== M * K) throw new Error('matmulNBitsRef：A 的長度 ' + A.length + ' 與 M×K=' + (M * K) + ' 不符');
  const w = dequantQ4(B, scales, N, K, zp);
  const Y = new Float32Array(M * N);
  for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
    let acc = 0;
    const ao = m * K, wo = n * K;
    for (let k = 0; k < K; k++) acc += A[ao + k] * w[wo + k];
    Y[m * N + n] = acc;
  }
  return Y;
}

module.exports = { BLOCK, BYTES, ZP, nBlocksOf, unpackQ4, dequantQ4, matmulNBitsRef };
