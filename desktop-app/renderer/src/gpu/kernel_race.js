// kernel_race.js — 變體競賽的執行器與本機快取包裝（清單 O9）。純邏輯：時間、裝置、儲存都由呼叫端注入，node 用假時鐘與假裝置測試。
// 競賽：只跑「能力足夠、適用此形狀」的變體；每個變體跑 3 次取中位數；整段預算 2 秒（一次量測若會超過預算就不開始）；
//       每個停止點先讓出執行緒（背景），再檢查取消與預算；取消或預算不足時，不完整的變體不參與勝負。引擎在 kernel_select.raceVariants。
// 快取：唯一的持久化層在 kernel_select.createWinnerCache（單一 localStorage 鍵，與 variant_race 共用）。本檔只負責競賽、強制覆蓋與設定頁資料。
// 預設只用選擇器的規則（kernel_select.pickWithCache）；競賽結果寫進快取後，下一次才會換用，第一次使用不會被擋住。
// UMD：node 用 module.exports（依賴 ./kernel_select.js）；瀏覽器用 self.FaKernelRace（需要先有 self.FaKernelSelect，接線時處理）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./kernel_select.js')); }
  else { root.FaKernelRace = factory(root.FaKernelSelect); }
}(typeof self !== 'undefined' ? self : this, function (KS) {
  'use strict';

  const STORE_KEY = KS.WINNER_KEY;
  const SCHEMA = 1;
  const BUDGET_MS = 2000;
  const RUNS = 3;
  const TOL = 1e-5;

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function defaultClock() {
    return { now: function () { return typeof performance !== 'undefined' ? performance.now() : Date.now(); } };
  }
  function defaultYield() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function createCancel() {
    let c = false;
    return { cancel: function () { c = true; }, cancelled: function () { return c; } };
  }
  function defaultStorage() { return KS.defaultStorage(); }

  // 此運算在這組能力與形狀下可用的變體 id（依表中順序）
  function eligibleVariants(op, shape, caps) {
    const list = KS.VARIANTS[op];
    if (!list) throw new Error('kernel_race：未知運算 ' + op);
    const s = shape || {};
    const c = caps || KS.DEFAULT_CAPS;
    return list.filter(function (v) { return !(v.applies && !v.applies(s)) && !KS.meets(c, v); }).map(function (v) { return v.id; });
  }

  // 競賽執行器。opts：
  //   op, shape, caps：要競賽的運算與形狀、能力表
  //   device：{ run(id) → 毫秒（或 Promise）, verify(id) → 相對誤差（可省；省略就不驗證） }
  //   clock：{ now() → 毫秒 }（預設 performance.now）；yieldFn：每個停止點呼叫的讓出函式（預設 setTimeout 0）
  //   budgetMs（預設 2000）、runs（預設 3）、tol（驗證容差，預設 1e-5）、cancel（createCancel() 產生的物件）
  // 回傳 { op, winner: {id, median}|null, timings: {id: [ms×runs]}（只含跑滿的）, partial: {id: [ms]}, bad: [{id, reason}],
  //        skipped: [id], budgetHit, cancelled, ms }。取消時 winner 一律為 null。
  async function race(opts) {
    if (!opts || !opts.device || typeof opts.device.run !== 'function') throw new Error('kernel_race：race 需要 device.run');
    const ids = eligibleVariants(opts.op, opts.shape, opts.caps);
    return KS.raceVariants(Object.assign({}, opts, { ids: ids }));  // 競賽引擎在 kernel_select.raceVariants（與 variant_race 共用）
  }

  // 競賽入口 ＋ 強制覆蓋 ＋ 設定頁資料。opts：
  //   caps：能力表（鍵與失效都看它的雜湊）；adapter：adapter 描述字串
  //   storage：{ getItem(k), setItem(k, v) }；省略時用 localStorage（取不到就 null）
  //   clock、yieldFn、now（寫入時間戳，預設 Date.now）、budgetMs、runs：傳給 race
  function createKernelRace(opts) {
    opts = opts || {};
    const caps = opts.caps || KS.DEFAULT_CAPS;
    const adapter = String(opts.adapter || 'unknown');
    const clock = opts.clock || defaultClock();
    const now = opts.now || function () { return Date.now(); };
    const cache = KS.createWinnerCache({ storage: opts.storage === undefined ? defaultStorage() : opts.storage, adapter: adapter, caps: caps });
    const chash = cache.capsHash;
    const inflight = {};
    // 這個運算有沒有可用的量測裝置（例如 mm_ops 的真 GPU）。沒給就一律不能重跑（窗格沒有裝置時的預設）。
    const rerunnable = typeof opts.rerunnable === 'function' ? opts.rerunnable : function () { return false; };
    function canRerun(op) { return !caps.software && !!rerunnable(op); }

    // 同步的 store（給 kernel_select.pickWithCache 用）
    const store = { get: cache.get, set: function (key, v) { cache.put(key, v); } };
    function keyFor(op, shape) { return KS.cacheKey(adapter, op, shape, caps); }
    function choose(op, shape) { return KS.pickWithCache(op, shape, caps, cache.overrides(), store, adapter); }

    // 競賽：立即回傳 handle（不阻塞）；同一把鍵在進行中時回傳同一個 handle
    function tune(op, shape, device) {
      const key = keyFor(op, shape);
      if (inflight[key]) return inflight[key];
      const handle = { key: key, op: op, cancel: null, promise: null };
      if (caps.software) {
        handle.cancel = function () {};
        handle.promise = Promise.resolve({ op: op, winner: null, reason: '軟體 adapter 不做競賽', timings: {}, partial: {}, bad: [], skipped: [], budgetHit: false, cancelled: false, ms: 0 });
        return handle;
      }
      const c = createCancel();
      handle.cancel = function () { c.cancel(); };
      inflight[key] = handle;
      handle.promise = race({ op: op, shape: shape, caps: caps, device: device, clock: clock, yieldFn: opts.yieldFn, budgetMs: opts.budgetMs, runs: opts.runs, cancel: c }).then(function (res) {
        if (inflight[key] === handle) delete inflight[key];
        if (res.winner && !res.cancelled) {
          cache.put(key, { id: res.winner.id, median: res.winner.median, at: now(), adapter: adapter, caps: chash, op: op, bucket: KS.shapeBucket(shape) });
        }
        return res;
      }, function (e) {
        if (inflight[key] === handle) delete inflight[key];
        throw e;
      });
      return handle;
    }
    // 重跑：取消進行中的競賽、刪掉這把鍵的結果、重新競賽
    function rerun(op, shape, device) {
      const key = keyFor(op, shape);
      if (inflight[key]) { inflight[key].cancel(); delete inflight[key]; }
      cache.remove(key);
      return tune(op, shape, device);
    }
    // 強制覆蓋：只接受表裡存在的變體；能力不足或形狀不適用時，choose 會退回規則並在 reason 寫明
    function force(op, id) {
      const list = KS.VARIANTS[op];
      if (!list) throw new Error('kernel_race：未知運算 ' + op);
      if (!list.some(function (v) { return v.id === id; })) throw new Error('kernel_race：' + op + ' 沒有變體 ' + id);
      cache.setOverride(op, id);
      return id;
    }
    function unforce(op) { cache.clearOverride(op); }
    function cancelAll() {
      Object.keys(inflight).forEach(function (k) { inflight[k].cancel(); delete inflight[k]; });
    }
    // 恢復預設：取消競賽、清掉所有結果與強制覆蓋
    function reset() { cancelAll(); cache.reset(); }
    // 設定頁用：每個運算目前用哪個變體、來源、是否強制、快取內容、是否正在競賽
    function describe(op, shape) {
      const key = keyFor(op, shape);
      const ov = cache.overrides();
      return {
        op: op, key: key, choice: choose(op, shape),
        cached: cache.get(key),
        forced: has(ov, op) ? ov[op] : null,
        running: !!inflight[key],
        eligible: eligibleVariants(op, shape, caps)
      };
    }
    // 設定頁資料（純資料、可 JSON 序列化）：每個運算一列。shapesByOp：{ [op]: shape }，沒給的運算用空形狀。
    function snapshot(shapesByOp) {
      const shapes = shapesByOp || {};
      return Object.keys(KS.VARIANTS).map(function (op) {
        const d = describe(op, shapes[op] || {});
        return {
          op: op,
          choice: d.choice.id,
          source: d.choice.source,          // 'forced' | 'tuned' | 'rule'
          reason: d.choice.reason,
          forced: d.forced,                 // 強制的變體 id 或 null
          cached: d.cached ? d.cached.id : null,
          cachedMedian: d.cached ? d.cached.median : null,
          running: d.running,
          eligible: d.eligible,
          key: d.key,
          canRerun: canRerun(op),          // 有裝置才能重跑；沒有時 rerunHint 說明原因
          rerunHint: canRerun(op) ? '清掉這個運算的結果後重新競賽' : '重跑需要可量測的真 GPU 裝置（這裡沒有）'
        };
      });
    }

    return {
      adapter: adapter,
      capsHash: chash,
      cacheKind: cache.kind,
      key: keyFor,
      choose: choose,
      tune: tune,
      rerun: rerun,
      force: force,
      unforce: unforce,
      cancelAll: cancelAll,
      reset: reset,
      describe: describe,
      snapshot: snapshot,
      canRerun: canRerun,
      overrides: function () { return cache.overrides(); },
      persisted: function () { return cache.persisted(); }
    };
  }

  return {
    STORE_KEY: STORE_KEY, SCHEMA: SCHEMA, BUDGET_MS: BUDGET_MS, RUNS: RUNS, TOL: TOL,
    eligibleVariants: eligibleVariants, race: race, createKernelRace: createKernelRace,
    createCancel: createCancel, defaultStorage: defaultStorage
  };
}));
