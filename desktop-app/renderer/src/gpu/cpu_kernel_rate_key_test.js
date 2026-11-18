'use strict';
// 速率快取的鍵包含 CPU 核心版本：核心換了，舊速率讀不到（自動作廢）。（node，記憶體後端）
const assert = require('assert');
const HR = require('./hetero_rates.js');
const CS = require('./cpu_share.js');

const base = { op: 'matmul', browser: 'Chrome/130', adapter: 'nvidia', cores: 4 };
const kOld = HR.rateKey(Object.assign({}, base, { kernel: 'cpu-simd-pack4x8-v1' }));
const kNew = HR.rateKey(Object.assign({}, base, { kernel: CS.CPU_KERNEL_ID }));
assert.notStrictEqual(kOld, kNew, '核心版本變了，鍵要變');
assert.notStrictEqual(HR.rateKey(base), kNew, '沒有核心版本的鍵與有版本的鍵不同');
assert.strictEqual(HR.rateKey(Object.assign({}, base, { kernel: CS.CPU_KERNEL_ID })), kNew, '同版本鍵要穩定');
assert.ok(kNew.startsWith('v2 |'), '鍵前綴是 v2（舊的 v1 紀錄自動失效）');
console.log('ok 鍵含 CPU 核心版本：核心版本不同 → 鍵不同；同版本鍵穩定');

(async () => {
  // 舊核心寫入的速率，新核心讀不到
  const m = new Map();
  const store = HR.createRateStore({ get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } });
  assert.strictEqual(await store.save(kOld, { gpu: 1e7, cpu: 5e5, updatedAt: 1 }), true);
  assert.strictEqual(await store.load(kNew), null, '換核心後舊速率必須讀不到');
  assert.deepStrictEqual(await store.load(kOld), { gpu: 1e7, cpu: 5e5, updatedAt: 1 }, '同版本仍讀得到');
  console.log('ok 換核心版本後，舊速率讀不到（自動作廢）');
  console.log('cpu_kernel_rate_key_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
