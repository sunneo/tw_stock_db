'use strict';
// cpu_share.runCpuOnly（純 CPU 池，沒有 WebGPU 時用）測試（node，假 Worker）：
// 結果與參考一致；Worker 可用時走 cpu-workers；沒有 Worker、cores=0、Worker 出錯時退回主執行緒且結果仍正確。
const assert = require('assert');
const CS = require('./cpu_share.js');

function fakeWorker(opts) {
  const o = opts || {};
  const w = { onmessage: null, terminate() {}, postMessage(d) {
    const cache = (fakeWorker.cache = fakeWorker.cache || new Map());
    let B = d.B; if (d.bKey != null) { if (B) cache.set(d.bKey, B); else B = cache.get(d.bKey); }
    setTimeout(() => {
      if (o.fail) { w.onmessage({ data: { id: d.id, error: '假的 Worker 失敗' } }); return; }
      w.onmessage({ data: { id: d.id, C: CS.cpuRowsRef(d.A, B, d.m, d.k, d.n, d.transB) } });
    }, 0);
  } };
  return w;
}
const rnd = (n) => Float32Array.from({ length: n }, (_, i) => ((i * 31 + 7) % 97) / 97 - 0.5);
const M = 40, K = 24, N = 16, A = rnd(M * K), B = rnd(K * N);
const ref = CS.cpuRowsRef(A, B, M, K, N, false);
const same = (y) => y.length === ref.length && y.every((v, i) => Math.abs(v - ref[i]) < 1e-5);

(async () => {
  // 1. Worker 可用：結果與參考一致，走 cpu-workers，列分給多個 Worker
  {
    const s = CS.createCpuShare({ minWorkerFlops: 0, makeWorker: () => fakeWorker(), cores: 4 });
    const r = await s.runCpuOnly(A, B, M, K, N, {});
    assert.strictEqual(r.shared, true);
    assert.strictEqual(r.info.mode, 'cpu-workers');
    assert.ok(r.info.workers >= 2 && r.info.workers <= 4, '分給多個 Worker（實際 ' + r.info.workers + '）');
    assert.ok(same(r.y), '結果應與參考一致');
    console.log('ok 1 純 CPU 池走 Worker，結果正確');
  }

  // 2. 還沒開啟（cores=0）：退回主執行緒，結果正確，why=off
  {
    const s = CS.createCpuShare({ minWorkerFlops: 0, makeWorker: () => fakeWorker(), cores: 0 });
    const r = await s.runCpuOnly(A, B, M, K, N, {});
    assert.strictEqual(r.info.mode, 'cpu-main');
    assert.strictEqual(r.info.why, 'off');
    assert.ok(same(r.y));
    console.log('ok 2 cores=0 退回主執行緒');
  }

  // 3. 建立不了 Worker：退回主執行緒，結果正確，說明原因
  {
    const s = CS.createCpuShare({ minWorkerFlops: 0, makeWorker: () => null, cores: 4 });
    const r = await s.runCpuOnly(A, B, M, K, N, {});
    assert.strictEqual(r.info.mode, 'cpu-main');
    assert.ok(r.info.why, '應說明原因');
    assert.ok(same(r.y));
    console.log('ok 3 沒有 Worker 退回主執行緒並說明');
  }

  // 4. Worker 出錯：退回主執行緒，結果仍正確，記錄 fallback
  {
    const s = CS.createCpuShare({ minWorkerFlops: 0, makeWorker: () => fakeWorker({ fail: true }), cores: 2 });
    const r = await s.runCpuOnly(A, B, M, K, N, {});
    assert.strictEqual(r.shared, true);
    assert.strictEqual(r.info.mode, 'cpu-main');
    assert.match(r.info.fallback, /假的 Worker 失敗/);
    assert.ok(same(r.y), 'Worker 出錯後結果仍應正確');
    console.log('ok 4 Worker 出錯退回主執行緒');
  }

  console.log('cpu_share_cpu_only_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
