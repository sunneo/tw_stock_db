'use strict';
// cudaweb 異質排程器的速率持久化（設計見 docs/DESIGN.cudaweb-hetero.md 第 3 節）。
// 純邏輯：鍵的組成、資料檢查、EMA 更新、與儲存後端的包裝。IndexedDB 由呼叫端注入（backend.get／backend.set）。
// 任何讀寫失敗都不丟錯：讀不到或資料壞掉就當作沒有速率（呼叫端會走保守預設）。

// 鍵：裝置環境變了就是新的量測。
// o: { op, browser, adapter, cores, kernel }。kernel 是 CPU 核心的版本識別（cpu_share.CPU_KERNEL_ID）：核心換了，舊速率自動作廢。
function rateKey(o) {
  o = o || {};
  const part = (v) => String(v == null ? '' : v).replace(/\|/g, '/');
  return ['v2', part(o.op), part(o.browser), part(o.adapter), part(o.cores), part(o.kernel || 'none')].join(' | ');
}

// 檢查儲存的速率。只接受 gpu、cpu 都是有限正數的物件；其餘一律視為沒有資料。
function sanitizeRates(v) {
  if (!v || typeof v !== 'object') return null;
  const g = Number(v.gpu), c = Number(v.cpu);
  if (!(isFinite(g) && g > 0 && isFinite(c) && c > 0)) return null;
  return { gpu: g, cpu: c, updatedAt: Number(v.updatedAt) || 0 };
}

// 指數平均（與 cpu_share 相同的 0.6／0.4 權重）
const ema = (old, v) => (old > 0 ? old * 0.6 + v * 0.4 : v);

// 包裝儲存後端。backend: { get(key) → Promise<any>, set(key, value) → Promise }
// 讀取：失敗或資料不合法 → null。寫入：失敗就忽略（回傳 false）。
function createRateStore(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.set !== 'function') {
    throw new TypeError('createRateStore：需要 backend.get 與 backend.set');
  }
  return {
    async load(key) {
      try {
        return sanitizeRates(await backend.get(key));
      } catch (_) {
        return null;
      }
    },
    async save(key, rates) {
      const clean = sanitizeRates(rates);
      if (!clean) return false;
      try {
        await backend.set(key, clean);
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}

// 記憶體後端（測試用，也可在 IndexedDB 不能用時當退路；注意：這種退路不會跨頁面保存）
function memoryBackend() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    _map: m,
  };
}

module.exports = { rateKey, sanitizeRates, ema, createRateStore, memoryBackend };
