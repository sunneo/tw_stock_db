'use strict';
// 精度回歸測試（node）：長 K（512）下 SIMD 與 JS 核心的相對誤差都要 ≤ 1e-5。
// 背景：KC=256 時 SIMD 在 K=512 誤差 1.26e-5（超過門檻），改 KC=64 後為 6.5e-6；這個測試把它鎖住。
const assert = require('assert');
const G = require('./cpu_gemm.js');
const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let mx = 0; for (let i = 0; i < r.length; i++) mx = Math.max(mx, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return mx; };
assert.strictEqual(G.DEF_KC, 64, '預設 KC 應為 64（精度）');
const shapes = [[256, 512, 512], [512, 512, 512]];
for (const [m, k, n] of shapes) {
  const A = fill(m * k, 1), B = fill(k * n, 2);
  const ref = G.gemmNaive(A, B, m, k, n, false);
  const e1 = relMax(G.gemmPacked(A, B, m, k, n, {}), ref);
  assert.ok(e1 <= 1e-5, `JS ${m}x${k}x${n} 誤差 ${e1}`);
  if (G.simdSupported()) {
    const e2 = relMax(G.gemmPackedSimd(A, B, m, k, n, {}), ref);
    assert.ok(e2 <= 1e-5, `SIMD ${m}x${k}x${n} 誤差 ${e2}`);
    console.log(`ok ${m}x${k}x${n}：JS ${e1.toExponential(2)}，SIMD ${e2.toExponential(2)}（門檻 1e-5）`);
  } else console.log(`ok ${m}x${k}x${n}：JS ${e1.toExponential(2)}（沒有 SIMD）`);
}
console.log('cpu_gemm_accuracy_test：全部通過');
