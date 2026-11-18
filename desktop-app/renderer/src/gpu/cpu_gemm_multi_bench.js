'use strict';
// 多核量測（node，持久工作者池）：1／2／4 個工作者沿 M 分割，量計算時間（不含工作者啟動），算加速比並驗證正確性。
const G = require('D:/Downloads/videos-嗨投資-desktop-app/desktop-app/renderer/src/gpu/cpu_gemm.js');
const { createRowPool } = require('D:/Downloads/videos-嗨投資-desktop-app/desktop-app/renderer/src/gpu/cpu_gemm_rows.js');
const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
(async () => {
  const sz = 1024; const A = fill(sz * sz, 1), B = fill(sz * sz, 2);
  const small = [37, 53, 29];
  for (const p of [1, 2, 4]) {
    const pool = createRowPool(p);
    const As = fill(37 * 53, 7), Bs = fill(53 * 29, 8);
    const ref = G.gemmNaive(As, Bs, 37, 53, 29, false);
    const ys = await pool.run(As, Bs, 37, 53, 29, {});
    let err = 0; for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(ys[i] - ref[i]) / Math.max(1, Math.abs(ref[i])));
    await pool.run(A, B, sz, sz, sz, {});
    let best = Infinity;
    for (let r = 0; r < 3; r++) { const t0 = process.hrtime.bigint(); await pool.run(A, B, sz, sz, sz, {}); const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (ms < best) best = ms; }
    console.log(`${p} 工作者（持久池）：${best.toFixed(1)} ms，${((2 * sz ** 3) / (best * 1e-3) / 1e9).toFixed(2)} GFLOP/s；正確性誤差 ${err.toExponential(2)}`);
    pool.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
