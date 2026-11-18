'use strict';
// hetero_rates 測試（node，記憶體後端，IndexedDB 由呼叫端注入）：鍵的組成、資料檢查、EMA、
// 存取往返、壞資料當作沒有、後端丟錯不影響呼叫端。
const assert = require('assert');
const R = require('./hetero_rates.js');

(async () => {
  // 1. 鍵：環境任一項變了就不同；值裡的 | 會被替換，不會和分隔符混淆
  {
    const base = { op: 'matmul', browser: 'Chrome/130', adapter: 'nvidia', cores: 8 };
    const k0 = R.rateKey(base);
    assert.notStrictEqual(k0, R.rateKey(Object.assign({}, base, { browser: 'Chrome/131' })), '瀏覽器版本變了要換鍵');
    assert.notStrictEqual(k0, R.rateKey(Object.assign({}, base, { adapter: 'amd' })), '介面卡變了要換鍵');
    assert.notStrictEqual(k0, R.rateKey(Object.assign({}, base, { cores: 4 })), '核心數變了要換鍵');
    assert.notStrictEqual(k0, R.rateKey(Object.assign({}, base, { op: 'elementwise' })), '運算種類不同要換鍵');
    assert.strictEqual(R.rateKey({ op: 'a|b' }).indexOf('a|b'), -1, '分隔符要被替換');
    console.log('ok 1 鍵的組成');
  }

  // 2. 資料檢查：只接受有限正數的 gpu、cpu
  {
    assert.strictEqual(R.sanitizeRates(null), null);
    assert.strictEqual(R.sanitizeRates('x'), null);
    assert.strictEqual(R.sanitizeRates({ gpu: NaN, cpu: 1 }), null, 'NaN 視為壞資料');
    assert.strictEqual(R.sanitizeRates({ gpu: -1, cpu: 1 }), null, '負數視為壞資料');
    assert.strictEqual(R.sanitizeRates({ gpu: 1 }), null, '缺欄位視為壞資料');
    assert.strictEqual(R.sanitizeRates({ gpu: Infinity, cpu: 1 }), null, '無限大視為壞資料');
    const ok = R.sanitizeRates({ gpu: '2.5', cpu: 1, updatedAt: 5 });
    assert.deepStrictEqual(ok, { gpu: 2.5, cpu: 1, updatedAt: 5 }, '字串數字可接受');
    console.log('ok 2 資料檢查');
  }

  // 3. EMA：沒有舊值時直接用新值；有舊值時 0.6／0.4
  {
    assert.strictEqual(R.ema(0, 10), 10);
    assert.ok(Math.abs(R.ema(10, 20) - 14) < 1e-9);
    console.log('ok 3 EMA');
  }

  // 4. 存取往返
  {
    const store = R.createRateStore(R.memoryBackend());
    const key = R.rateKey({ op: 'matmul', browser: 'b', adapter: 'a', cores: 8 });
    assert.strictEqual(await store.load(key), null, '沒有資料 → null');
    assert.strictEqual(await store.save(key, { gpu: 3, cpu: 1 }), true);
    const back = await store.load(key);
    assert.strictEqual(back.gpu, 3); assert.strictEqual(back.cpu, 1);
    assert.strictEqual(await store.load(R.rateKey({ op: 'matmul', browser: 'b2', adapter: 'a', cores: 8 })), null, '換環境讀不到舊速率');
    console.log('ok 4 存取往返與換環境');
  }

  // 5. 壞資料不寫入、讀到壞資料當作沒有
  {
    const be = R.memoryBackend();
    const store = R.createRateStore(be);
    assert.strictEqual(await store.save('k', { gpu: NaN, cpu: 1 }), false, '壞資料不寫入');
    be._map.set('k', { gpu: 'oops', cpu: 1 });
    assert.strictEqual(await store.load('k'), null, '讀到壞資料當作沒有');
    console.log('ok 5 壞資料');
  }

  // 6. 後端丟錯：讀回 null、寫入回 false，都不丟到呼叫端
  {
    const broken = { get: async () => { throw new Error('IndexedDB 不能用'); }, set: async () => { throw new Error('寫入失敗'); } };
    const store = R.createRateStore(broken);
    assert.strictEqual(await store.load('k'), null);
    assert.strictEqual(await store.save('k', { gpu: 1, cpu: 1 }), false);
    console.log('ok 6 後端丟錯不影響呼叫端');
  }

  // 7. 建構參數檢查
  assert.throws(() => R.createRateStore({}), TypeError);
  console.log('ok 7 參數檢查');

  console.log('hetero_rates：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
