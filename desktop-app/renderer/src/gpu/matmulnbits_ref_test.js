'use strict';
// MatMulNBits CPU 參考版的 node 測試（合成權重，不需要網路與模型）。
// 獨立的比對方式：先用已知的 q（4 位元整數）與 scales 打包成 B，再直接用 q 算期望值（不經過 unpack／dequant），兩者必須一致。
const assert = require('assert');
const R = require('./matmulnbits_ref.js');

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// 依 q（N×K，0..15）與 scales（N×nBlocks）打包成 B（N×nBlocks×16），ONNX 佈局：低 4 位元是偶數 k，高 4 位元是奇數 k
function pack(q, N, K) {
  const nb = R.nBlocksOf(K);
  const B = new Uint8Array(N * nb * R.BYTES);
  for (let n = 0; n < N; n++) for (let b = 0; b < nb; b++) for (let j = 0; j < R.BYTES; j++) {
    const k0 = b * R.BLOCK + 2 * j, k1 = k0 + 1;
    const lo = k0 < K ? q[n * K + k0] : 0, hi = k1 < K ? q[n * K + k1] : 0;
    B[(n * nb + b) * R.BYTES + j] = (hi << 4) | lo;
  }
  return B;
}

const cases = [
  { name: '小形狀，K 是 32 的整數倍', M: 3, K: 64, N: 5 },
  { name: 'K 不是 32 的整數倍（K=40，末尾 block 有 padding）', M: 2, K: 40, N: 4 },
  { name: '接近 MLP 形狀（M=2、K=1024、N=64）', M: 2, K: 1024, N: 64 },
];

const results = [];
for (const c of cases) {
  const { M, K, N } = c;
  const nb = R.nBlocksOf(K);
  const q = new Uint8Array(N * K); for (let i = 0; i < q.length; i++) q[i] = Math.floor(rnd() * 16);
  const scales = new Float32Array(N * nb); for (let i = 0; i < scales.length; i++) scales[i] = 0.01 + rnd() * 0.1;
  const A = new Float32Array(M * K); for (let i = 0; i < A.length; i++) A[i] = rnd() * 2 - 1;
  const B = pack(q, N, K);

  // 解包必須還原 q（只比有效的 k < K）
  const qBack = R.unpackQ4(B, N, K);
  for (let i = 0; i < q.length; i++) assert.strictEqual(qBack[i], q[i], c.name + '：解包第 ' + i + ' 個不符');

  // 期望值：直接用 q、scales、零點 8 的定義算，不經過 dequantQ4
  const exp = new Float32Array(M * N);
  for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
    let acc = 0;
    for (let k = 0; k < K; k++) acc += A[m * K + k] * (q[n * K + k] - 8) * scales[n * nb + Math.floor(k / R.BLOCK)];
    exp[m * N + n] = acc;
  }
  const got = R.matmulNBitsRef(A, M, K, B, scales, N);
  let maxAbs = 0, maxRef = 0;
  for (let i = 0; i < exp.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(got[i] - exp[i])); maxRef = Math.max(maxRef, Math.abs(exp[i])); }
  const rel = maxAbs / (maxRef || 1);
  assert.ok(rel < 1e-5, c.name + '：相對誤差 ' + rel + ' 超過 1e-5');
  results.push({ 案例: c.name, 相對誤差: rel, 通過: true });
}

// 長度檢查要丟錯（不靜默）
assert.throws(() => R.unpackQ4(new Uint8Array(3), 1, 32), /長度/);
assert.throws(() => R.dequantQ4(new Uint8Array(16), new Float32Array(2), 1, 32), /scales/);
assert.throws(() => R.matmulNBitsRef(new Float32Array(3), 2, 32, new Uint8Array(16), new Float32Array(1), 1), /A 的長度/);

console.log(JSON.stringify({ results, pass: true }, null, 1));
console.log('matmulnbits_ref_test：全部通過');
