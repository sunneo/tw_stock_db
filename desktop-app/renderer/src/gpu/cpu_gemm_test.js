'use strict';
// 純 CPU GEMM 交叉驗證（node）：與朴素雙精度參考比對，相對誤差 ≤ 1e-5。
// 涵蓋：非 2 的冪次與奇數尺寸、極小（1×1×1）與極長（k 很大、m/n 很小）、四種轉置組合、
// 分塊參數（MC/KC/NC）變動、SIMD 與純 JS 兩版、輸入不被修改。
const assert = require('assert');
const G = require('./cpu_gemm.js');

const fill = (n, s) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let m = 0; for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return m; };
const TOL = 1e-5;

const SHAPES = [
  [1, 1, 1], [7, 5, 3], [33, 47, 21], [129, 257, 65],   // 奇數與非 2 的冪次
  [4, 8, 8], [5, 9, 9],                                 // 剛好與跨過 MR/NR 邊界
  [1, 512, 1], [512, 1, 3], [3, 700, 2],                // 極端：向量、k 很長
];
const COMBOS = [[false, false], [true, false], [false, true], [true, true]]; // [transA, transB]

let checks = 0;
const kernels = [['packed', (A, B, m, k, n, o) => G.gemmPacked(A, B, m, k, n, o)]];
const hasSimd = G.simdSupported();
if (hasSimd) kernels.push(['packedSimd', (A, B, m, k, n, o) => G.gemmPackedSimd(A, B, m, k, n, o)]);

for (const [name, fn] of kernels) {
  for (const [m, k, n] of SHAPES) {
    for (const [tA, tB] of COMBOS) {
      const A = fill(m * k, 1), B = fill(k * n, 2);
      const ref = G.gemmNaive(A, B, m, k, n, { transA: tA, transB: tB });
      const y = fn(A, B, m, k, n, { transA: tA, transB: tB });
      const err = relMax(y, ref);
      assert.ok(err <= TOL, `${name} ${m}x${k}x${n} tA=${tA} tB=${tB} 相對誤差 ${err} 超過 ${TOL}`);
      checks++;
    }
  }
  console.log(`ok ${name}：${SHAPES.length} 個尺寸 × 4 種轉置組合全部在 ${TOL} 內`);
}

// 分塊參數變動：小塊（會跨多個塊）與預設值結果一致
for (const [name, fn] of kernels) {
  const m = 70, k = 90, n = 45;
  const A = fill(m * k, 3), B = fill(k * n, 4);
  const ref = G.gemmNaive(A, B, m, k, n, false);
  for (const o of [{ MC: 8, KC: 16, NC: 16 }, { MC: 12, KC: 40, NC: 24 }, { MC: 96, KC: 256, NC: 512 }]) {
    const err = relMax(fn(A, B, m, k, n, o), ref);
    assert.ok(err <= TOL, `${name} 分塊 ${JSON.stringify(o)} 誤差 ${err}`);
    checks++;
  }
  console.log(`ok ${name}：分塊參數 MC/KC/NC 變動結果一致`);
}

// 輸入不被修改（預設行為）：A、B 打包前後逐元素相同
for (const [name, fn] of kernels) {
  const m = 20, k = 30, n = 25;
  const A = fill(m * k, 5), B = fill(k * n, 6);
  const A0 = A.slice(), B0 = B.slice();
  fn(A, B, m, k, n, { transA: true, transB: true });
  assert.deepStrictEqual(A, A0, `${name} 修改了 A`);
  assert.deepStrictEqual(B, B0, `${name} 修改了 B`);
  checks++;
}
console.log('ok 預設不修改輸入（A、B 逐元素相同）');

// SIMD 偵測：布林值；不支援時 gemmPackedSimd 應拋錯（此環境支援時只檢查型別）
assert.strictEqual(typeof hasSimd, 'boolean');
if (!hasSimd) assert.throws(() => G.gemmPackedSimd(new Float32Array(1), new Float32Array(1), 1, 1, 1, false));
checks++;
console.log(`ok SIMD 偵測：${hasSimd ? '支援（已跑 SIMD 版交叉驗證）' : '不支援（只跑純 JS 版）'}`);

console.log(`cpu_gemm_test：全部通過（${checks} 項）`);
