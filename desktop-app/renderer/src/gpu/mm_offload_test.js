'use strict';
// 整個運算卸載給 CPU（mm_ops 的決策接線）測試（node，沒有 WebGPU）。交界點來自 setOffloadCrossover（Profile 實測值）。
const assert = require('assert');
const MM = require('./mm_ops.js');

const fill = (n, s) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const naive = (a, b, m, k, n) => { const C = new Float64Array(m * n); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let p = 0; p < k; p++) s += a[i * k + p] * b[p * n + j]; C[i * n + j] = s; } return C; };
const relMax = (y, r) => { let mx = 0; for (let i = 0; i < r.length; i++) mx = Math.max(mx, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return mx; };
const F = (m, k, n) => 2 * m * k * n;

(async () => {
  // 1. 交界點無限大：小形狀卸載，結果正確，記錄 offload-cpu
  MM.setOffloadCrossover(Infinity);
  {
    const a = fill(16 * 16, 1), b = fill(16 * 16, 2); const o = { navigator: undefined };
    const r = await MM.matmul(a, [16, 16], b, [16, 16], o);
    assert.strictEqual(o.lastKernel, 'offload-cpu', '應卸載');
    assert.ok(relMax(r.y, naive(a, b, 16, 16, 16)) <= 1e-5);
    console.log('ok 交界點無限大：16³ 整個卸載給 CPU，結果正確');
  }
  // 2. 沒有實測（null）：不卸載
  MM.setOffloadCrossover(null);
  {
    const a = fill(16 * 16, 1), b = fill(16 * 16, 2); const o = { navigator: undefined };
    await MM.matmul(a, [16, 16], b, [16, 16], o);
    assert.notStrictEqual(o.lastKernel, 'offload-cpu', '沒有實測值不應卸載');
    console.log('ok 沒有實測值：不卸載（維持原路徑）');
  }
  // 3. 交界點 = 64³ 的運算量：32³ 卸載、64³ 不卸載（邊界）
  MM.setOffloadCrossover(F(64, 64, 64));
  {
    const a = fill(32 * 32, 3), b = fill(32 * 32, 4); const o = { navigator: undefined };
    await MM.matmul(a, [32, 32], b, [32, 32], o);
    assert.strictEqual(o.lastKernel, 'offload-cpu', '32³ 應卸載');
    const a2 = fill(64 * 64, 5), b2 = fill(64 * 64, 6); const o2 = { navigator: undefined };
    await MM.matmul(a2, [64, 64], b2, [64, 64], o2);
    assert.notStrictEqual(o2.lastKernel, 'offload-cpu', '64³ 恰等於交界點，不卸載（小於才卸載）');
    console.log('ok 交界點邊界：32³ 卸載、64³ 不卸載');
  }
  // 4. 轉置 A 不卸載（原路徑）
  MM.setOffloadCrossover(Infinity);
  {
    const a = fill(16 * 16, 7), b = fill(16 * 16, 8); const o = { navigator: undefined, transA: true };
    await MM.matmul(a, [16, 16], b, [16, 16], o);
    assert.notStrictEqual(o.lastKernel, 'offload-cpu', '轉置 A 不走卸載');
    console.log('ok 轉置 A 不卸載');
  }
  // 5. 轉置 B 卸載：結果正確（b 以 n×k 儲存）
  {
    const m = 12, k = 20, n = 9;
    const a = fill(m * k, 9), bT = fill(n * k, 10); const o = { navigator: undefined, transB: true };
    const r = await MM.matmul(a, [m, k], bT, [k, n], o);
    assert.strictEqual(o.lastKernel, 'offload-cpu');
    const ref = new Float64Array(m * n); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let p = 0; p < k; p++) s += a[i * k + p] * bT[j * k + p]; ref[i * n + j] = s; }
    assert.ok(relMax(r.y, ref) <= 1e-5, '卸載的轉置 B 結果錯誤');
    console.log('ok 轉置 B 卸載：結果正確');
  }
  MM.setOffloadCrossover(null);
  console.log('mm_offload_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
