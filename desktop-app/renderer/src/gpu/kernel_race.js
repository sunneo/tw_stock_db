// kernel_race.js — 變體競賽的執行器與本機快取包裝（清單 O9）。純邏輯：時間、裝置、儲存都由呼叫端注入，node 用假時鐘與假裝置測試。
// 競賽：只跑「能力足夠、適用此形狀」的變體；每個變體跑 3 次取中位數；整段預算 2 秒（一次量測若會超過預算就不開始）；
//       每個停止點先讓出執行緒（背景），再檢查取消與預算；取消或預算不足時，不完整的變體不參與勝負。
// 快取：單一 localStorage 鍵 { v, entries, overrides }。每筆記錄 adapter 描述與能力表雜湊；同一 adapter 的能力雜湊變了，舊筆一律刪掉。
//       所有讀寫都 try/catch；讀不到、JSON 壞掉、寫不進去，都退成只在記憶體裡運作。
// 預設只用選擇器的規則（kernel_select.pickWithCache）；競賽結果寫進快取後，下一次才會換用，第一次使用不會被擋住。
// UMD：node 用 module.exports（依賴 ./kernel_select.js）；瀏覽器用 self.FaKernelRace（需要先有 self.FaKernelSelect，接線時處理）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./kernel_select.js')); }
  else { root.FaKernelRace = factory(root.FaKernelSelect); }
}(typeof self !== 'undefined' ? self : this, function (KS) {
  'use strict';

  const STORE_KEY = 'cudaweb.kernel_race.v1';
  const SCHEMA = 1;
  const BUDGET_MS = 2000;
  const RUNS = 3;
  const TOL = 1e-5;

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function msg(e) { return String((e && e.message) || e); }
  function defaultClock() {
    return { now: function () { return typeof performance !== 'undefined' ? performance.now() : Date.now(); } };
  }
  function defaultYield() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function createCancel() {
    let c = false;
    return { cancel: function () { c = true; }, cancelled: function () { return c; } };
  }
  function defaultStorage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
  }

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
    const clock = opts.clock || defaultClock();
    const yieldFn = opts.yieldFn || defaultYield;
    const budget = opts.budgetMs || BUDGET_MS;
    const runs = opts.runs || RUNS;
    const tol = opts.tol || TOL;
    const cancel = opts.cancel || createCancel();
    const device = opts.device;
    if (!device || typeof device.run !== 'function') throw new Error('kernel_race：race 需要 device.run');
    const ids = eligibleVariants(opts.op, opts.shape, opts.caps);
    const t0 = clock.now();
    const res = { op: opts.op, winner: null, timings: {}, partial: {}, bad: [], skipped: [], budgetHit: false, cancelled: false, ms: 0 };
    let lastMs = 0;  // 量到的最長單次耗時：下一次只在「已用＋這個耗時」不超過預算時才開始
    let stop = null;
    function setStop(s) {
      stop = s;
      if (s === 'cancel') res.cancelled = true;
      if (s === 'budget') res.budgetHit = true;
    }
    async function gate() {
      await yieldFn();
      if (cancel.cancelled()) return 'cancel';
      if (clock.now() - t0 + lastMs > budget) return 'budget';
      return null;
    }

    for (const id of ids) {
      if (stop === null) setStop(await gate());
      if (stop === 'cancel') break;
      if (stop === 'budget') { res.skipped.push(id); continue; }

      if (device.verify) {
        let err;
        try { err = await device.verify(id); } catch (e) { res.bad.push({ id: id, reason: '驗證丟錯：' + msg(e) }); continue; }
        if (!(typeof err === 'number' && err <= tol)) { res.bad.push({ id: id, reason: '相對誤差 ' + err + ' 超過 ' + tol }); continue; }
      }

      const xs = [];
      let failed = false;
      for (let r = 0; r < runs; r++) {
        setStop(await gate());
        if (stop) break;
        let ms;
        try { ms = await device.run(id); } catch (e) { res.bad.push({ id: id, reason: '執行丟錯：' + msg(e) }); failed = true; break; }
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { res.bad.push({ id: id, reason: '計時無效：' + ms }); failed = true; break; }
        xs.push(ms);
        if (ms > lastMs) lastMs = ms;
      }
      if (failed) continue;
      if (xs.length === runs) res.timings[id] = xs;
      else if (xs.length) res.partial[id] = xs;
    }

    res.ms = clock.now() - t0;
    if (!res.cancelled) res.winner = KS.chooseWinner(res.timings);
    return res;
  }

  // 本機快取 ＋ 強制覆蓋 ＋ 競賽入口。opts：
  //   caps：能力表（鍵與失效都看它的雜湊）；adapter：adapter 描述字串
  //   storage：{ getItem(k), setItem(k, v) }；省略時用 localStorage（取不到就 null）
  //   clock、yieldFn、now（寫入時間戳，預設 Date.now）、budgetMs、runs：傳給 race
  function createKernelRace(opts) {
    opts = opts || {};
    const caps = opts.caps || KS.DEFAULT_CAPS;
    const adapter = String(opts.adapter || 'unknown');
    const clock = opts.clock || defaultClock();
    const now = opts.now || function () { return Date.now(); };
    const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    const chash = KS.capsHash(caps);
    let lastSaveOk = false;
    const inflight = {};

    function emptyState() { return { v: SCHEMA, entries: {}, overrides: {} }; }
    function load() {
      let raw = null;
      try { raw = storage ? storage.getItem(STORE_KEY) : null; } catch (_) { raw = null; }
      let s = null;
      try { s = raw ? JSON.parse(raw) : null; } catch (_) { s = null; }
      if (!isObj(s) || s.v !== SCHEMA || !isObj(s.entries) || !isObj(s.overrides)) return emptyState();
      return s;
    }
    function save() {
      lastSaveOk = false;
      try { if (storage) { storage.setItem(STORE_KEY, JSON.stringify(st)); lastSaveOk = true; } } catch (_) { lastSaveOk = false; }
      return lastSaveOk;
    }
    // 失效：同一 adapter 的筆數若能力雜湊不同（換卡、換驅動、旗標變了）就刪掉；格式壞掉的也刪
    function prune() {
      let changed = false;
      Object.keys(st.entries).forEach(function (k) {
        const e = st.entries[k];
        if (!isObj(e) || typeof e.id !== 'string' || (e.adapter === adapter && e.caps !== chash)) { delete st.entries[k]; changed = true; }
      });
      return changed;
    }

    let st = load();
    if (prune()) save();

    // 同步的 store（給 kernel_select.pickWithCache 用）
    const store = {
      get: function (key) { return has(st.entries, key) ? st.entries[key] : null; },
      set: function (key, v) { st.entries[key] = v; save(); }
    };
    function keyFor(op, shape) { return KS.cacheKey(adapter, op, shape, caps); }
    function choose(op, shape) { return KS.pickWithCache(op, shape, caps, st.overrides, store, adapter); }

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
          st.entries[key] = { id: res.winner.id, median: res.winner.median, at: now(), adapter: adapter, caps: chash, op: op, bucket: KS.shapeBucket(shape) };
          save();
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
      if (has(st.entries, key)) { delete st.entries[key]; save(); }
      return tune(op, shape, device);
    }
    // 強制覆蓋：只接受表裡存在的變體；能力不足或形狀不適用時，choose 會退回規則並在 reason 寫明
    function force(op, id) {
      const list = KS.VARIANTS[op];
      if (!list) throw new Error('kernel_race：未知運算 ' + op);
      if (!list.some(function (v) { return v.id === id; })) throw new Error('kernel_race：' + op + ' 沒有變體 ' + id);
      st.overrides[op] = id;
      save();
      return id;
    }
    function unforce(op) { if (has(st.overrides, op)) { delete st.overrides[op]; save(); } }
    function cancelAll() {
      Object.keys(inflight).forEach(function (k) { inflight[k].cancel(); delete inflight[k]; });
    }
    // 恢復預設：取消競賽、清掉所有結果與強制覆蓋
    function reset() { cancelAll(); st = emptyState(); save(); }
    // 設定頁用：每個運算目前用哪個變體、來源、是否強制、快取內容、是否正在競賽
    function describe(op, shape) {
      const key = keyFor(op, shape);
      return {
        op: op, key: key, choice: choose(op, shape),
        cached: has(st.entries, key) ? st.entries[key] : null,
        forced: has(st.overrides, op) ? st.overrides[op] : null,
        running: !!inflight[key],
        eligible: eligibleVariants(op, shape, caps)
      };
    }

    return {
      adapter: adapter,
      capsHash: chash,
      key: keyFor,
      choose: choose,
      tune: tune,
      rerun: rerun,
      force: force,
      unforce: unforce,
      cancelAll: cancelAll,
      reset: reset,
      describe: describe,
      overrides: function () { return Object.assign({}, st.overrides); },
      persisted: function () { return lastSaveOk; }
    };
  }

  return {
    STORE_KEY: STORE_KEY, SCHEMA: SCHEMA, BUDGET_MS: BUDGET_MS, RUNS: RUNS, TOL: TOL,
    eligibleVariants: eligibleVariants, race: race, createKernelRace: createKernelRace,
    createCancel: createCancel, defaultStorage: defaultStorage
  };
}));
