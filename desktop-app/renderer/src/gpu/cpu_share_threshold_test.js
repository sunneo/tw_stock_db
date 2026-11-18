'use strict';
// 工作者門檻測試（node）：純函式的邊界；預設門檻下 512³ 不建立工作者、只用主執行緒；1024³ 會走工作者。
const assert = require('assert');
const CS = require('./cpu_share.js');
const { MIN_WORKER_FLOPS, cpuPathFor } = CS;

assert.strictEqual(MIN_WORKER_FLOPS, 2 * 768 * 768 * 768);
assert.strictEqual(cpuPathFor({ m: 512, k: 512, n: 512, workers: 4 }).path, 'main', '512³ 應走主執行緒');
assert.strictEqual(cpuPathFor({ m: 1024, k: 1024, n: 1024, workers: 4 }).path, 'workers', '1024³ 應走工作者');
assert.strictEqual(cpuPathFor({ m: 1024, k: 1024, n: 1024, workers: 0 }).path, 'main', '沒有工作者一律主執行緒');
// 邊界：恰等於門檻走工作者，小一點點走主執行緒
const edgeM = Math.cbrt(MIN_WORKER_FLOPS / 2);            // 768
assert.strictEqual(cpuPathFor({ m: 768, k: 768, n: 768, workers: 2 }).path, 'workers', '恰等於門檻走工作者');
assert.strictEqual(cpuPathFor({ m: 767, k: 768, n: 768, workers: 2 }).path, 'main', '小於門檻走主執行緒');
assert.ok(edgeM > 767 && edgeM < 769);
// 可注入門檻（測試用）
assert.strictEqual(cpuPathFor({ m: 1, k: 1, n: 1, workers: 2, minFlops: 0 }).path, 'workers');
assert.ok(cpuPathFor({ m: 512, k: 512, n: 512, workers: 4 }).reason.includes('門檻'));
console.log('ok 純函式：512³→主執行緒、1024³→工作者、邊界正確、沒有工作者→主執行緒、門檻可注入');

(async () => {
  // 預設門檻：512³ 的 runCpuOnly 不建立任何工作者
  let made = 0;
  const sh = CS.createCpuShare({ cores: 4, makeWorker: () => { made++; return null; } });
  const m = 512, k = 512, n = 512;
  const A = new Float32Array(m * k).map((_, i) => ((i % 7) - 3) / 10), B = new Float32Array(k * n).map((_, i) => ((i % 5) - 2) / 10);
  const r = await sh.runCpuOnly(A, B, m, k, n, {});
  assert.strictEqual(r.info.mode, 'cpu-main', '512³ 應 cpu-main，實得 ' + r.info.mode);
  assert.strictEqual(made, 0, '512³ 不應建立工作者');
  assert.ok(String(r.info.why).includes('門檻'), 'info.why 應說明原因');
  sh.dispose();
  console.log('ok 預設門檻：512³ 的 runCpuOnly 只用主執行緒，建立工作者 0 次，info 說明原因');
  console.log('cpu_share_threshold_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
