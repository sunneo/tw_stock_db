/* variant_race.js — 變體選擇的執行時期（G4，docs/TARGET.cudaweb-cublas.md「選擇與驗證」）。
 * 流程：優先名（priors 第一名）先用 → 對 CPU 參考驗證（不過就標壞、退下一名）→ 背景對前 K 名各跑數次取中位數（時間預算 2 秒、可取消）→ 勝者存快取。
 * 快取存「勝者變體」（WebGPU 管線無法序列化，下次只需編譯勝者）。鍵＝adapter 描述＋驅動／瀏覽器版本＋能力簽名；簽名或版本變了就是另一把鍵，自動失效。
 * 儲存：與 kernel_race 共用的勝者快取（kernel_select.createWinnerCache，localStorage；node 無 localStorage，走記憶體）。純邏輯，node 可直接 require 測試。
 * UMD：node 用 module.exports；瀏覽器用 self.FaVariantRace。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./kernel_select.js')); }
  else { root.FaVariantRace = factory(root.FaKernelSelect); }
}(typeof self !== 'undefined' ? self : this, function (KS) {
  'use strict';

  var DEFAULT_TOL = 1e-5;     // 驗證的相對誤差上限（f32 累加順序不同，與 CPU 參考的合理容差）
  var DEFAULT_BUDGET_MS = 2000;
  var DEFAULT_RUNS = 3;
  var DEFAULT_K = 3;

  function medianOf(xs) {
    var a = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (p, q) { return p - q; });
    if (!a.length) return null;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // 快取鍵：adapter 描述、驅動／瀏覽器版本、能力簽名（由呼叫端給字串，例如 kernel_select.capsHash）、運算、形狀區間
  function makeKey(info) {
    info = info || {};
    return [info.adapter || 'unknown', info.driver || '-', info.browser || '-', info.caps || '-', info.op || '-', info.shape || '-'].join('|');
  }

  // 競賽：candidates = [{ id, verify: async () => relErr, run: async () => ms }]，已依優先序排好（第一名為 priors 首選）。
  // 引擎與 kernel_race 共用（kernel_select.raceVariants）；這裡只做轉接：K 上限、未跑滿的次數也計入勝負、取消用函式。
  // 回傳 { winner: { id, median } | null, timings, bad: [{ id, reason }], skipped: [id], budgetHit, cancelled, ms }
  async function race(candidates, opts) {
    opts = opts || {};
    const byId = {};
    candidates.forEach(function (c) { byId[c.id] = c; });
    const now = opts.now || function () { return Date.now(); };
    return KS.raceVariants({
      ids: candidates.map(function (c) { return c.id; }),
      device: {
        run: function (id) { return byId[id].run(); },
        verify: function (id) { return byId[id].verify(); }
      },
      clock: { now: now },
      cancel: opts.cancel || function () { return false; },
      tol: opts.tol || DEFAULT_TOL,
      budgetMs: opts.budgetMs || DEFAULT_BUDGET_MS,
      runs: opts.runs || DEFAULT_RUNS,
      K: opts.K || DEFAULT_K,
      allowPartial: true,
      yieldFn: opts.yieldFn
    });
  }

  // 儲存（O9 合一）：勝者快取就是 kernel_select.createWinnerCache（單一 localStorage 鍵，與 kernel_race 共用）。
  // 舊的 IndexedDB 勝者不再讀寫（只是快取，缺了會重新競賽）；opts.indexedDB 已忽略。介面維持 async，set 回傳 'local' 或 'memory'。
  function createStore(opts) {
    opts = opts || {};
    const cache = KS.createWinnerCache({ storage: opts.storage, storageKey: opts.storageKey });
    return {
      kind: cache.kind,
      get: async function (key) { return cache.get(key); },
      set: async function (key, value) { cache.put(key, value); return cache.persisted() ? 'local' : 'memory'; },
      entries: async function () { return cache.entries(); },
      clear: async function () { cache.clearEntries(); }
    };
  }

  return { race: race, makeKey: makeKey, createStore: createStore, medianOf: medianOf, DEFAULT_TOL: DEFAULT_TOL, DEFAULT_BUDGET_MS: DEFAULT_BUDGET_MS };
}));
