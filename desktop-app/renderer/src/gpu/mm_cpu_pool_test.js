'use strict';
// mm_ops 的純 CPU 池退路測試（node，沒有 WebGPU）：無 WebGPU 時 matmul 自動走純 CPU 池並結果正確；
// 轉置 B（transB）與轉置 A（transA）對拍；沒有 Worker 時退回主執行緒仍正確；有 cpu 池設定時仍正確。
// 注意：node 沒有 WebGPU，所以 GPU 層一定失敗、走 CPU 退路；「中途 device lost」無法在 node 直接模擬（見交接文件），這裡只測無 GPU 與 GPU 不可用。
const assert = require('assert');
const MM = require('./mm_ops.js');
const CS = require('./cpu_share.js');

const rnd = (n, seed) => Float32Array.from({ length: n }, (_, i) => ((i * 9301 + 49297 + seed * 1237) % 233280) / 233280 - 0.5);

// 參考：朴素三重迴圈（雙精度累加），輸入 a 是 M×K（若 transA：a 是 K×M）、b 是 K×N（若 transB：b 是 N×K）
function naive(a, b, M, K, N, transA, transB) {
  const C = new Float64Array(M * N);
  for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) {
    let s = 0;
    for (let t = 0; t < K; t++) {
      const av = transA ? a[t * M + i] : a[i * K + t];
      const bv = transB ? b[j * K + t] : b[t * N + j];
      s += av * bv;
    }
    C[i * N + j] = s;
  }
  return C;
}
const relMax = (y, ref) => { let m = 0; for (let i = 0; i < ref.length; i++) m = Math.max(m, Math.abs(y[i] - ref[i]) / Math.max(1, Math.abs(ref[i]))); return m; };

(async () => {
  // 1. 無 WebGPU：matmul 結果與參考一致，且 info 標示走 CPU（cpu-js）
  {
    const M = 33, K = 47, N = 21;   // 非 2 的冪次、奇數
    const a = rnd(M * K, 1), b = rnd(K * N, 2);
    const o = { navigator: undefined };
    const r = await MM.matmul(a, [M, K], b, [K, N], o);
    assert.ok(relMax(r.y, naive(a, b, M, K, N, false, false)) <= 1e-5, '無 WebGPU 的結果應與參考一致');
    assert.strictEqual(o.lastInfo.layer, 'cpu-js', 'info 應標示 CPU 層');
    console.log('ok 1 無 WebGPU 走純 CPU 池，結果正確（layer=cpu-js）');
  }

  // 2. 無 WebGPU＋轉置 B（b 以 N×K 儲存）：結果與參考一致
  {
    const M = 17, K = 29, N = 11;
    const a = rnd(M * K, 3), bT = rnd(N * K, 4);
    const o = { navigator: undefined, transB: true };
    const r = await MM.matmul(a, [M, K], bT, [K, N], o);   // dims 為邏輯 [K,N]，儲存為 N×K
    assert.ok(relMax(r.y, naive(a, bT, M, K, N, false, true)) <= 1e-5, 'transB 結果應與參考一致');
    console.log('ok 2 無 WebGPU＋transB 正確');
  }

  // 3. 無 WebGPU＋轉置 A（a 以 K×M 儲存）：走參考實作，結果正確
  {
    const M = 13, K = 19, N = 7;
    const aT = rnd(K * M, 5), b = rnd(K * N, 6);
    const o = { navigator: undefined, transA: true };
    const r = await MM.matmul(aT, [M, K], b, [K, N], o);   // dims 為邏輯 [M,K]，儲存為 K×M
    assert.ok(relMax(r.y, naive(aT, b, M, K, N, true, false)) <= 1e-5, 'transA 結果應與參考一致');
    console.log('ok 3 無 WebGPU＋transA 正確');
  }

  // 4. 有 CPU 池設定（cores=4）但環境沒有 Worker：退回主執行緒，結果仍正確
  {
    const sh = CS.getShared();
    sh.setCores(4);
    try {
      const M = 40, K = 24, N = 16;
      const a = rnd(M * K, 7), b = rnd(K * N, 8);
      const r = await MM.matmul(a, [M, K], b, [K, N], { navigator: undefined });
      assert.ok(relMax(r.y, naive(a, b, M, K, N, false, false)) <= 1e-5, '沒有 Worker 時結果應正確');
    } finally { sh.setCores(0); }
    console.log('ok 4 cores=4 但沒有 Worker，退回主執行緒仍正確');
  }

  // 5. runCpuOnly 直接呼叫：沒有 GPU 的呼叫端可以直接用純 CPU 池
  {
    const M = 9, K = 5, N = 6;
    const a = rnd(M * K, 9), b = rnd(K * N, 10);
    const r = await CS.getShared().runCpuOnly(a, b, M, K, N, {});
    assert.ok(relMax(r.y, naive(a, b, M, K, N, false, false)) <= 1e-5);
    console.log('ok 5 runCpuOnly 直接呼叫正確');
  }

  // 6. 整數版不受影響（仍走原本路徑）
  {
    const M = 3, K = 4, N = 2;
    const ai = Int32Array.from({ length: M * K }, (_, i) => (i % 5) - 2), bi = Int32Array.from({ length: K * N }, (_, i) => (i % 3) - 1);
    const r = await MM.matmulInt(ai, [M, K], bi, [K, N], 0, 0, { navigator: undefined });
    assert.strictEqual(r.y.length, M * N);
    console.log('ok 6 整數版不受影響');
  }

  console.log('mm_cpu_pool_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
