'use strict';
// cpu_share 的比例改由分攤決策決定（見 docs/DESIGN.cudaweb-hetero.md 第 2 節）的測試（node，假 Worker）。
// 驗證：(1) 速率未量到時走探測比例；(2) 速率量到後，大運算採用決策比例（≤ 0.5）；
// (3) 小運算決策說不切，比例為 0；(4) 決策說不切時每 PROBE_EVERY 次探測一次，免得 CPU 速率過期。
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
  const on = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now });
  const M = 256, K = 256, N = 512, A = rnd(M * K), B = rnd(K * N);
  const gpuFn = async (rows, mG) => CS.cpuRowsRef(rows, B, mG, K, N, false);

  // 1. 還沒量到速率：探測比例（> 0，且 ≤ 0.5）
  const probe0 = on._ratioNow(M, K, N);
  assert.ok(probe0 > 0 && probe0 <= CS.MAX_CPU_RATIO, '未量測時應探測，實際 ' + probe0);
  console.log('ok 1 未量測時探測比例');

  // 2. 跑幾次讓速率量到，之後大運算採用決策比例
  for (let i = 0; i < 3; i++) await on.run(gpuFn, A, B, M, K, N, {});
  const st = on.stats();
  assert.ok(st.rate.gpu > 0 && st.rate.cpu > 0, '應該已量到兩邊速率');
  const r = on._ratioNow(M, K, N);
  assert.ok(r >= 0 && r <= CS.MAX_CPU_RATIO, '決策比例應在 [0, 0.5]，實際 ' + r);
  console.log('ok 2 速率量到後大運算的決策比例 ' + r.toFixed(3));

  // 3. 小運算：決策說不切（固定成本划不來）→ 比例為 0
  const fresh = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now });
  await fresh.run(gpuFn, A, B, M, K, N, {}); // 只為了量速率
  const small = fresh._ratioNow(16, 16, 16);
  assert.strictEqual(small, 0, '小運算應不切，比例 0（實際 ' + small + '）');
  console.log('ok 3 小運算不切');

  // 4. 決策說不切時每 PROBE_EVERY 次探測一次。用乾淨的實例：先做一次切分（計數歸零），
  //    之後連續 10 次小運算的比例查詢，前 9 次為 0，第 10 次探測（> 0）
  const c4 = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now });
  const slowGpu = async (rows, mG) => { for (let i = 0; i < 40; i++) now(); return CS.cpuRowsRef(rows, B, mG, K, N, false); };
  await c4.run(slowGpu, A, B, M, K, N, {});
  const cadence = [];
  for (let i = 0; i < 10; i++) cadence.push(c4._ratioNow(16, 16, 16));
  for (let i = 0; i < 9; i++) assert.strictEqual(cadence[i], 0, '第 ' + (i + 1) + ' 次不應探測');
  assert.ok(cadence[9] > 0, '第 10 次應探測（實際 ' + cadence[9] + '）');
  console.log('ok 4 不切時定期探測');

  // 5. 執行路徑：決策不切的小運算回報 shared:false（呼叫端走原路徑）
  const r2 = await fresh.run(gpuFn, A.subarray(0, 16 * 16), B.subarray(0, 16 * 16), 16, 16, 16, {});
  assert.strictEqual(r2.shared, false, '小運算不分工');
  console.log('ok 5 小運算執行路徑 shared:false');

  // 6. 段耗時回饋：分工後 stats().feedback 等於依實測段耗時算出的比例；下一次的決策比例不會超過它
  {
    const H2 = require('./hetero_split.js');
    const s = on.stats();
    assert.ok(s.last && s.last.shared, '前面的分工應該留下 last');
    const expect = H2.feedbackFraction(s.last.mCpu / s.last.m, s.last.gpuMs, s.last.cpuMs, CS.MAX_CPU_RATIO);
    assert.ok(Math.abs(s.feedback - expect) < 1e-9, '回饋比例應等於依實測段耗時算出的值（' + s.feedback + ' vs ' + expect + '）');
    const nxt = on._ratioNow(M, K, N);
    assert.ok(nxt <= s.feedback + 1e-9 || nxt === 0, '下一次比例不應超過回饋比例（' + nxt + ' > ' + s.feedback + '）');
    console.log('ok 6 段耗時回饋（回饋 ' + s.feedback.toFixed(3) + '，下一次 ' + nxt.toFixed(3) + '）');
  }

  // 7. 速率持久化：分工後會存進後端；新實例用同一個鍵建立時會載入（不覆蓋已有的速率）
  {
    const HR = require('./hetero_rates.js');
    const be = HR.memoryBackend();
    const store = HR.createRateStore(be);
    const key = HR.rateKey({ op: 'matmul', browser: 'test', adapter: 'fake', cores: 4 });
    const p1 = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now, rateStore: store, rateKey: key });
    await p1.run(gpuFn, A, B, M, K, N, {});
    await new Promise((r) => setTimeout(r, 5));  // 讓存檔的 promise 結束
    const saved = be._map.get(key);
    assert.ok(saved && saved.gpu > 0 && saved.cpu > 0, '分工後速率應已存進後端');
    const p2 = CS.createCpuShare({ makeWorker: fakeWorker, cores: 4, now, rateStore: store, rateKey: key });
    await new Promise((r) => setTimeout(r, 5));  // 讓載入的 promise 結束
    const st2 = p2.stats().rate;
    assert.ok(Math.abs(st2.gpu - saved.gpu) < 1e-6 && Math.abs(st2.cpu - saved.cpu) < 1e-6, '新實例應載入已保存的速率');
    console.log('ok 7 速率存進後端並在新實例載入');
  }

  console.log('cpu_share_decide_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
