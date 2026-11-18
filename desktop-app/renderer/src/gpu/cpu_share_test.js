'use strict';
// cpu_share 測試：用假 Worker（同行程直接跑 cpuRowsRef），驗證分工結果與單一路徑一致、核心數 0＝不分工、比例會依實測調整。
const assert = require('assert');
const CS = require('./cpu_share.js');
function fakeWorker() {
  const w = { onmessage: null, terminate() {}, postMessage(d) {
    const cache = (fakeWorker.cache = fakeWorker.cache || new Map());
    let B = d.B; if (d.bKey != null) { if (B) cache.set(d.bKey, B); else B = cache.get(d.bKey); }
    setTimeout(() => w.onmessage({ data: { id: d.id, C: CS.cpuRowsRef(d.A, B, d.m, d.k, d.n, d.transB) } }), 0);
  } };
  return w;
}
const rnd = (n) => Float32Array.from({ length: n }, () => Math.random() - 0.5);
let t = 0; const now = () => (t += 1);
(async () => {
  const m = 64, k = 48, n = 40, A = rnd(m * k), B = rnd(k * n);
  const ref = CS.cpuRowsRef(A, B, m, k, n, false);
  const gpu = async (rows, mG) => CS.cpuRowsRef(rows, B, mG, k, n, false);
  let calls = 0; const gpuC = async (r, mG) => { calls++; return gpu(r, mG); };
  // 1. cores=0 → 不分工、gpuFn 不被呼叫（呼叫端走原路徑）
  const off = CS.createCpuShare({ makeWorker: fakeWorker, now });
  let r = await off.run(gpuC, A, B, m, k, n, {}); assert.strictEqual(r.shared, false); assert.strictEqual(calls, 0);
  // 2. 小運算不分工
  const on = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now });
  r = await on.run(gpuC, A, B, m, k, n, {}); assert.strictEqual(r.shared, false); assert.strictEqual(r.why, 'small');
  // 3. 夠大：分工，結果等於單一路徑
  const M = 256, K = 256, N = 512, A2 = rnd(M * K), B2 = rnd(K * N), ref2 = CS.cpuRowsRef(A2, B2, M, K, N, false);
  const g2 = async (rows, mG) => CS.cpuRowsRef(rows, B2, mG, K, N, false);
  r = await on.run(g2, A2, B2, M, K, N, {});
  assert.ok(r.shared); assert.strictEqual(r.info.mGpu + r.info.mCpu, M); assert.ok(r.info.mCpu >= 1 && r.info.workers <= 4);
  assert.strictEqual(r.y.length, M * N); for (let i = 0; i < ref2.length; i++) assert.strictEqual(r.y[i], ref2[i]);
  // 4. transB 與 bKey 快取（第二次不再送 B）
  const Bt = new Float32Array(K * N); for (let i = 0; i < K; i++) for (let j = 0; j < N; j++) Bt[j * K + i] = B2[i * N + j];
  const g3 = async (rows, mG) => CS.cpuRowsRef(rows, Bt, mG, K, N, true);
  for (let rep = 0; rep < 2; rep++) { r = await on.run(g3, A2, Bt, M, K, N, { transB: true, bKey: Bt }); assert.ok(r.shared); for (let i = 0; i < ref2.length; i += 97) assert.ok(Math.abs(r.y[i] - ref2[i]) < 1e-3); }
  // 5. 比例會依實測調整：CPU 假裝很慢（耗時大）→ 比例下降
  const r0 = on._ratioNow(); assert.ok(r0 > 0 && r0 <= CS.MAX_CPU_RATIO);
  // 6. GPU 出錯 → shared:false（呼叫端重算原路徑）
  r = await on.run(async () => { throw new Error('boom'); }, A2, B2, M, K, N, {}); assert.strictEqual(r.shared, false); assert.strictEqual(r.why, 'error');
  // 7. 沒有 Worker → shared:false，不丟錯
  const nw = CS.createCpuShare({ makeWorker: () => null, cores: 2, now }); r = await nw.run(g2, A2, B2, M, K, N, {}); assert.strictEqual(r.shared, false);
  // 8. 關閉後 Worker 收掉
  on.setCores(0); assert.strictEqual(on.stats().workers, 0);
  console.log('cpu_share_test：8 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
