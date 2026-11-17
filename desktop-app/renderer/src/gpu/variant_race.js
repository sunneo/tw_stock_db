/* variant_race.js — 變體選擇的執行時期（G4，docs/TARGET.cudaweb-cublas.md「選擇與驗證」）。
 * 流程：優先名（priors 第一名）先用 → 對 CPU 參考驗證（不過就標壞、退下一名）→ 背景對前 K 名各跑數次取中位數（時間預算 2 秒、可取消）→ 勝者存快取。
 * 快取存「勝者變體」（WebGPU 管線無法序列化，下次只需編譯勝者）。鍵＝adapter 描述＋驅動／瀏覽器版本＋能力簽名；簽名或版本變了就是另一把鍵，自動失效。
 * 儲存：IndexedDB（失敗或不存在時退記憶體 Map）。純邏輯，node 可直接 require 測試（node 沒有 indexedDB，走記憶體）。
 * UMD：node 用 module.exports；瀏覽器用 self.FaVariantRace。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaVariantRace = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
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
  // 回傳 { winner: { id, median } | null, timings, bad: [{ id, reason }], skipped: [id], budgetHit, cancelled, ms }
  async function race(candidates, opts) {
    opts = opts || {};
    var tol = opts.tol || DEFAULT_TOL, budget = opts.budgetMs || DEFAULT_BUDGET_MS, runs = opts.runs || DEFAULT_RUNS;
    var K = opts.K || DEFAULT_K, now = opts.now || function () { return Date.now(); };
    var cancelled = opts.cancel || function () { return false; };
    var t0 = now();
    var res = { winner: null, timings: {}, bad: [], skipped: [], budgetHit: false, cancelled: false, ms: 0 };
    var tried = 0;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (cancelled()) { res.cancelled = true; break; }
      if (tried >= K) { res.skipped.push(c.id); continue; }
      if (now() - t0 > budget) { res.budgetHit = true; res.skipped.push(c.id); continue; }
      tried++;
      // 驗證：不過就標壞、退下一名（驅動行為不同，不能只信 priors）
      var err;
      try { err = await c.verify(); } catch (e) { res.bad.push({ id: c.id, reason: '驗證丟錯：' + String(e && e.message || e) }); continue; }
      if (!(typeof err === 'number' && err <= tol)) { res.bad.push({ id: c.id, reason: '相對誤差 ' + err + ' 超過 ' + tol }); continue; }
      // 計時：取中位數；超過預算就停止加量（已量到的仍有效）
      var xs = [];
      for (var r = 0; r < runs; r++) {
        if (cancelled()) { res.cancelled = true; break; }
        if (now() - t0 > budget) { res.budgetHit = true; break; }
        try { xs.push(await c.run()); } catch (e2) { res.bad.push({ id: c.id, reason: '執行丟錯：' + String(e2 && e2.message || e2) }); xs = []; break; }
      }
      res.timings[c.id] = xs;
      if (res.cancelled) break;
    }
    var best = null;
    Object.keys(res.timings).forEach(function (id) {
      var m = medianOf(res.timings[id]);
      if (m !== null && (!best || m < best.median)) best = { id: id, median: m };
    });
    res.winner = best;
    res.ms = now() - t0;
    return res;
  }

  // 儲存：get(key) → 值或 null；set(key, value)。IndexedDB 失敗或不存在就退記憶體。
  function createStore(opts) {
    opts = opts || {};
    var mem = new Map();
    var idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    var dbName = opts.dbName || 'cudaweb_variants', storeName = 'winners';
    var dbP = null;
    function open() {
      if (dbP) return dbP;
      dbP = new Promise(function (resolve, reject) {
        if (!idb) { reject(new Error('沒有 indexedDB')); return; }
        var req = idb.open(dbName, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(storeName); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('indexedDB 開啟失敗')); };
      });
      dbP.catch(function () { /* 退記憶體，見 get／set */ });
      return dbP;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(storeName, mode), s = t.objectStore(storeName);
          var r = fn(s);
          t.oncomplete = function () { resolve(r && r.result !== undefined ? r.result : undefined); };
          t.onerror = function () { reject(t.error); };
        });
      });
    }
    return {
      kind: idb ? 'idb-or-memory' : 'memory',
      get: async function (key) {
        try { var v = await tx('readonly', function (s) { return s.get(key); }); return v === undefined ? null : v; }
        catch (_) { return mem.has(key) ? mem.get(key) : null; }
      },
      set: async function (key, value) {
        mem.set(key, value);
        try { await tx('readwrite', function (s) { return s.put(value, key); }); return 'idb'; }
        catch (_) { return 'memory'; }
      },
      // 啟動時整批載入（派發路徑是同步查表，見 mm_ops.setMatmulWinners）；失敗就給記憶體內容
      entries: async function () {
        try {
          const db = await open();
          return await new Promise(function (resolve, reject) {
            const t = db.transaction(storeName, 'readonly'), s = t.objectStore(storeName), out = [];
            const req = s.openCursor();
            req.onsuccess = function () { const c = req.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } };
            t.oncomplete = function () { resolve(out); };
            t.onerror = function () { reject(t.error); };
          });
        } catch (_) { return Array.from(mem.entries()).map(function (kv) { return { key: kv[0], value: kv[1] }; }); }
      },
      // 測試與設定頁「恢復預設」用
      clear: async function () { mem.clear(); try { await tx('readwrite', function (s) { return s.clear(); }); } catch (_) { /* 記憶體已清 */ } }
    };
  }

  return { race: race, makeKey: makeKey, createStore: createStore, medianOf: medianOf, DEFAULT_TOL: DEFAULT_TOL, DEFAULT_BUDGET_MS: DEFAULT_BUDGET_MS };
}));
