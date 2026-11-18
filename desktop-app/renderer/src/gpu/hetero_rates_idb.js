'use strict';
// 速率的 IndexedDB 後端（設計見 docs/DESIGN.cudaweb-hetero.md 第 3 節）。
// 只做「鍵值存取」：get(key) → Promise<值或 undefined>，set(key, value) → Promise。
// 與 hetero_rates.js 的 createRateStore 搭配使用（後者負責資料檢查與吞掉錯誤）。
// idb 由呼叫端注入（瀏覽器預設 indexedDB；測試用假的）。資料庫與物件庫名稱與變體競賽分開。

function createIdbBackend(o) {
  o = o || {};
  const idb = o.idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!idb || typeof idb.open !== 'function') throw new Error('沒有 IndexedDB（速率將不會保存，改用保守預設）');
  const dbName = o.dbName || 'fa-cudaweb-rates';
  const storeName = o.storeName || 'rates';
  let dbP = null;

  function open() {
    if (dbP) return dbP;
    dbP = new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 開啟失敗'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他分頁擋住'));
    });
    // 開啟失敗就清掉快取的 promise，下一次再試
    dbP.catch(() => { dbP = null; });
    return dbP;
  }

  function run(mode, makeReq) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const r = makeReq(store);
      let out;
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 交易失敗'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 交易中止'));
    }));
  }

  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
  };
}

module.exports = { createIdbBackend };
