'use strict';
// 多核列區塊測試（node）：列分割純函式、持久工作者池與參考比對（奇數尺寸、轉置、列數少於工作者數）。
const assert = require('assert');
const G = require('./cpu_gemm.js');
const R = require('./cpu_gemm_rows.js');

const fill = (n, s) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let m = 0; for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return m; };

// 1. 列分割純函式
{
  assert.deepStrictEqual(R.splitRowsAligned(0, 4), []);
  const p = R.splitRowsAligned(10, 2);
  assert.strictEqual(p[0][0], 0); assert.strictEqual(p[p.length - 1][1], 10);
  for (let i = 1; i < p.length; i++) assert.strictEqual(p[i][0], p[i - 1][1], '區塊必須連續不重疊');
  for (const [s, e] of p.slice(0, -1)) assert.strictEqual((e - s) % 4, 0, '非最後一段的列數應為 MR 的倍數');
  const q = R.splitRowsAligned(3, 8);                        // 列數少於工作者數
  assert.deepStrictEqual(q, [[0, 3]]);
  console.log('ok 列分割：連續、不重疊、MR 對齊、列數少於工作者數');
}

// 2. 持久池：奇數尺寸與四種轉置組合，3 個工作者；與參考比對
(async () => {
  const pool = R.createRowPool(3);
  try {
    const shapes = [[37, 53, 29], [1, 17, 1], [4, 8, 8], [41, 9, 13]];
    const combos = [[false, false], [true, false], [false, true], [true, true]];
    for (const [m, k, n] of shapes) for (const [tA, tB] of combos) {
      const A = fill(m * k, 1), B = fill(k * n, 2);
      const ref = G.gemmNaive(A, B, m, k, n, { transA: tA, transB: tB });
      const y = await pool.run(A, B, m, k, n, { transA: tA, transB: tB });
      const err = relMax(y, ref);
      assert.ok(err <= 1e-5, `${m}x${k}x${n} tA=${tA} tB=${tB} 誤差 ${err}`);
    }
    console.log(`ok 持久池（3 工作者，${shapes.length} 個尺寸 × 4 種轉置）全部在 1e-5 內`);

    // 3. 輸入不被修改
    const A = fill(20 * 30, 5), B = fill(30 * 25, 6), A0 = A.slice(), B0 = B.slice();
    await pool.run(A, B, 20, 30, 25, {});
    assert.deepStrictEqual(A, A0); assert.deepStrictEqual(B, B0);
    console.log('ok 多核路徑不修改輸入');

    // 4. 連續呼叫（池重用）結果一致
    const A2 = fill(64 * 64, 9), B2 = fill(64 * 64, 10);
    const y1 = await pool.run(A2, B2, 64, 64, 64, {});
    const y2 = await pool.run(A2, B2, 64, 64, 64, {});
    assert.deepStrictEqual(y1, y2);
    console.log('ok 池重用：同輸入兩次結果逐元素相同');
  } finally { pool.close(); }
  console.log('cpu_gemm_rows_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
