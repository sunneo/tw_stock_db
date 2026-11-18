'use strict';
// hetero_rates_idb 測試（node，假的 IndexedDB）：開啟與升級、讀寫往返、開啟失敗、與 createRateStore 搭配時的吞錯行為。
const assert = require('assert');
const { createIdbBackend } = require('./hetero_rates_idb.js');
const { createRateStore, rateKey } = require('./hetero_rates.js');

// 假的 IndexedDB：涵蓋本模組用到的介面（open、onupgradeneeded、transaction、objectStore、get、put、oncomplete）
function fakeIdb(opts) {
  const o = opts || {};
  const dbs = new Map();   // dbName → Map(storeName → Map)
  let opens = 0;
  const later = (fn) => setTimeout(fn, 0);
  return {
    get openCount() { return opens; },
    open(name) {
      const req = {};
      opens++;
      later(() => {
        if (o.failOpen) { req.error = new Error('假的開啟失敗'); req.onerror && req.onerror(); return; }
        if (!dbs.has(name)) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => { stores.set(s, new Map()); },
          transaction: (store, mode) => {
            const m = stores.get(store);
            const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
            const pending = [];
            tx.objectStore = () => ({
              get: (k) => { const r = { result: undefined, onsuccess: null }; pending.push(() => { r.result = m.get(k); r.onsuccess && r.onsuccess(); }); return r; },
              put: (v, k) => { const r = {}; pending.push(() => { m.set(k, v); r.onsuccess && r.onsuccess(); }); return r; },
            });
            later(() => { pending.forEach((f) => f()); later(() => tx.oncomplete && tx.oncomplete()); });
            return tx;
          },
        };
        req.result = db;
        if (!req._upgraded) { req._upgraded = true; req.onupgradeneeded && req.onupgradeneeded(); }
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

(async () => {
  // 1. 讀寫往返；沒有資料時讀到 undefined
  {
    const be = createIdbBackend({ idb: fakeIdb(), dbName: 'd1', storeName: 's1' });
    assert.strictEqual(await be.get('k'), undefined);
    await be.set('k', { gpu: 2, cpu: 1 });
    assert.deepStrictEqual(await be.get('k'), { gpu: 2, cpu: 1 });
    console.log('ok 1 讀寫往返');
  }

  // 2. 只開一次資料庫（之後的讀寫共用同一個開啟結果）
  {
    const idb = fakeIdb();
    const be = createIdbBackend({ idb });
    await be.set('a', 1); await be.set('b', 2); await be.get('a');
    assert.strictEqual(idb.openCount, 1, '應只開一次，實際 ' + idb.openCount);
    console.log('ok 2 只開一次');
  }

  // 3. 開啟失敗：get／set 丟錯，且之後會再試（不卡在失敗的 promise 上）
  {
    const idb = fakeIdb({ failOpen: true });
    const be = createIdbBackend({ idb });
    await assert.rejects(be.get('k'), /假的開啟失敗/);
    await assert.rejects(be.set('k', 1), /假的開啟失敗/);
    assert.strictEqual(idb.openCount, 2, '失敗後下一次要重新開啟');
    console.log('ok 3 開啟失敗會丟錯並可重試');
  }

  // 4. 沒有 IndexedDB 時建構即丟錯（呼叫端改用保守預設）
  assert.throws(() => createIdbBackend({ idb: null }), /沒有 IndexedDB/);
  console.log('ok 4 沒有 IndexedDB 時建構丟錯');

  // 5. 與 createRateStore 搭配：開啟失敗時 load 回 null、save 回 false，不丟到呼叫端
  {
    const store = createRateStore(createIdbBackend({ idb: fakeIdb({ failOpen: true }) }));
    assert.strictEqual(await store.load(rateKey({ op: 'matmul', browser: 'b', adapter: 'a', cores: 4 })), null);
    assert.strictEqual(await store.save('k', { gpu: 1, cpu: 1 }), false);
    console.log('ok 5 與 createRateStore 搭配時吞錯');
  }

  // 6. 與 createRateStore 搭配的往返：存進去、讀出來、壞資料仍被擋下
  {
    const idb = fakeIdb();
    const store = createRateStore(createIdbBackend({ idb }));
    const key = rateKey({ op: 'matmul', browser: 'Chrome/130', adapter: 'nvidia', cores: 8 });
    assert.strictEqual(await store.save(key, { gpu: 5, cpu: 2 }), true);
    const back = await store.load(key);
    assert.strictEqual(back.gpu, 5); assert.strictEqual(back.cpu, 2);
    assert.strictEqual(await store.load(rateKey({ op: 'matmul', browser: 'Chrome/131', adapter: 'nvidia', cores: 8 })), null, '換瀏覽器版本讀不到');
    console.log('ok 6 與 createRateStore 往返');
  }

  console.log('hetero_rates_idb：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
