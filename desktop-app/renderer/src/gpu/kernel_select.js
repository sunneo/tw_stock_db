// kernel_select.js — cudaweb 核心變體選擇器（清單 O1）。純函式：不碰 GPU、不碰 DOM，node 可測。
// 輸入：能力表（probeCaps 從 adapter／device 讀出，探不到的給保守預設）、運算名稱、形狀、覆蓋表。
// 輸出：{ id, tier, reason, forced }。每個變體宣告它需要的能力與共用記憶體用量，能力不足的變體不會被選到。
// 只有已實作的變體才列在表裡；計畫中的變體（f16、子群組、貼圖記憶體）等實作時才加進來。
'use strict';

const KIB = 1024;
// 保守預設：探不到時當作低階（這是 Kepler 等級，所有核心都必須能跑）
const DEFAULT_CAPS = {
  probed: false,
  software: false,
  maxWorkgroupStorage: 16 * KIB,
  maxInvocations: 256,
  maxWorkgroupSizeX: 256,
  maxStorageBinding: 128 * 1024 * 1024,
  maxUniformBinding: 64 * KIB,
  maxTextureDim: 8192,
  hasF16: false,
  hasSubgroups: false,
  hasTimestamp: false,
  hasPackedDot: false,
};

// 能力表：從 adapter（features、info）與 device（limits）讀出。兩者都可能缺，缺的用保守預設。
function probeCaps(adapter, device) {
  const caps = Object.assign({}, DEFAULT_CAPS);
  const lim = (device && device.limits) || (adapter && adapter.limits) || null;
  if (!lim) return caps;
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  caps.probed = true;
  caps.maxWorkgroupStorage = num(lim.maxComputeWorkgroupStorageSize, caps.maxWorkgroupStorage);
  caps.maxInvocations = num(lim.maxComputeInvocationsPerWorkgroup, caps.maxInvocations);
  caps.maxWorkgroupSizeX = num(lim.maxComputeWorkgroupSizeX, caps.maxWorkgroupSizeX);
  caps.maxStorageBinding = num(lim.maxStorageBufferBindingSize, caps.maxStorageBinding);
  caps.maxUniformBinding = num(lim.maxUniformBufferBindingSize, caps.maxUniformBinding);
  caps.maxTextureDim = num(lim.maxTextureDimension2D, caps.maxTextureDim);
  const feats = (device && device.features) || (adapter && adapter.features) || null;
  const has = (name) => !!(feats && typeof feats.has === 'function' && feats.has(name));
  caps.hasF16 = has('shader-f16');
  caps.hasSubgroups = has('subgroups');
  caps.hasTimestamp = has('timestamp-query');
  caps.hasPackedDot = has('packed_4x8_integer_dot_product');  // 語言功能；這裡只記錄，尚無核心使用
  caps.software = !!(adapter && adapter.isFallbackAdapter);
  return caps;
}

// 等級定義（看能力，不看廠牌）：
//   min  ：軟體 adapter，或共用記憶體／執行緒上限比低階還小 → 只用逐格的簡單核心
//   low  ：共用記憶體 ≥16 KiB、每群組 ≥256 執行緒、沒有 f16、沒有子群組（Kepler 14 W 這台屬於這一級）
//   mid  ：有 shader-f16 或點積語言功能，且共用記憶體 ≥32 KiB
//   high ：有子群組，且共用記憶體 ≥48 KiB
function tierOf(caps) {
  if (!caps || !caps.probed || caps.software) return 'min';
  if (caps.maxWorkgroupStorage < 16 * KIB || caps.maxInvocations < 256 || caps.maxWorkgroupSizeX < 256) return 'min';
  if (caps.hasSubgroups && caps.maxWorkgroupStorage >= 48 * KIB) return 'high';
  if ((caps.hasF16 || caps.hasPackedDot) && caps.maxWorkgroupStorage >= 32 * KIB) return 'mid';
  return 'low';
}

// 變體表：每個運算依偏好順序列出已實作的變體。needs 是能力下限；shared 是共用記憶體位元組；threads 是每群組執行緒數。
// applies(shape) 決定形狀是否適用（沒有 applies 表示任何形狀都適用）。最後一個一定是無需求的簡單版（保底）。
const VARIANTS = {
  matmul: [
    // vec4 載入版（O5）：K、N 為 4 的倍數、不轉置時才用；同一份平鋪幾何，只把全域讀取改成 vec4
    { id: 'mm_vec4_f32', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.M >= 16 && s.N >= 16 && s.K % 4 === 0 && s.N % 4 === 0 },
    { id: 'mm_tiled_f32', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.M >= 16 && s.N >= 16 },
    { id: 'mm_simple_f32', shared: 0, threads: 1, needs: {} },
  ],
  // q8mm 的順序與 infer_ops.q8mmVariant 的自動規則一致（K 未給時只有 i32 版；f32 版只在 K ≤ 4096 時適用）。
  // shared 來自各 WGSL 的 var<workgroup> 位元組數（見 infer_ops.js 的 WGSL_Q8MM_*）。
  q8mm: [
    { id: 'q8mm_pf8x4', shared: 6 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 64 && s.K !== undefined && s.K <= 4096 },
    { id: 'q8mm_pf', shared: 5 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 64 },
    { id: 'q8mm_decr8f', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 8 && s.K !== undefined && s.K <= 4096 },
    { id: 'q8mm_decr8', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 8 },
    { id: 'q8mm_decr4f', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 4 && s.K !== undefined && s.K <= 4096 },
    { id: 'q8mm_decr', shared: 8 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M >= 4 },
    { id: 'q8mm_decr2f', shared: 6 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 && s.M === 2 && s.K !== undefined && s.K <= 4096 },
    { id: 'q8mm_dec', shared: 5 * KIB, threads: 256, needs: {}, applies: (s) => s.N % 4 === 0 },
    { id: 'q8mm_simple', shared: 0, threads: 64, needs: {} },
  ],
};

function meets(caps, v) {
  if (caps.maxWorkgroupStorage < v.shared) return '共用記憶體 ' + v.shared + ' 位元組超過上限 ' + caps.maxWorkgroupStorage;
  if (caps.maxInvocations < v.threads) return '每群組 ' + v.threads + ' 執行緒超過上限 ' + caps.maxInvocations;
  if (caps.maxWorkgroupSizeX < Math.min(v.threads, 256)) return 'workgroup X 上限不足';
  if (v.needs.f16 && !caps.hasF16) return '缺 shader-f16';
  if (v.needs.subgroups && !caps.hasSubgroups) return '缺 subgroups';
  if (v.needs.packedDot && !caps.hasPackedDot) return '缺 packed_4x8_integer_dot_product';
  return null;
}

// pickVariant(op, shape, caps, overrides) → { id, tier, reason, forced }
//   overrides：{ [op]: 變體 id }。強制的變體若能力不足，不硬用，退回自動選擇並在 reason 寫明。
function pickVariant(op, shape, caps, overrides) {
  const list = VARIANTS[op];
  if (!list) throw new Error('kernel_select：未知運算 ' + op);
  const c = caps || DEFAULT_CAPS;
  const tier = tierOf(c);
  const s = shape || {};
  const forcedId = overrides && overrides[op];
  const notes = [];
  if (forcedId) {
    const v = list.find((x) => x.id === forcedId);
    if (!v) notes.push('強制變體 ' + forcedId + ' 不存在');
    else if (v.applies && !v.applies(s)) notes.push('強制變體 ' + forcedId + ' 不適用此形狀');
    else if (meets(c, v)) notes.push('強制變體 ' + forcedId + ' 能力不足：' + meets(c, v));
    else return { id: v.id, tier: tier, reason: '強制指定', forced: true };
  }
  for (const v of list) {
    if (v.applies && !v.applies(s)) continue;
    const why = meets(c, v);
    if (why) { notes.push(v.id + '：' + why); continue; }
    return { id: v.id, tier: tier, reason: notes.join('；'), forced: false };
  }
  throw new Error('kernel_select：' + op + ' 沒有可用變體（保底變體也不符合，這不應發生）');
}

// ---------- 變體競賽的快取（清單 O9）：只處理鍵、失效與挑選；實際計時在瀏覽器端做 ----------
// 快取鍵 = adapter 描述 | 運算 | 形狀區間 | 能力表雜湊。能力表一變（換卡、換驅動、旗標變了），雜湊就變，舊結果自動失效。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}
function capsHash(caps) {
  const c = caps || DEFAULT_CAPS;
  return fnv1a(JSON.stringify([c.maxWorkgroupStorage, c.maxInvocations, c.maxWorkgroupSizeX, c.maxStorageBinding, c.maxUniformBinding, c.maxTextureDim, c.hasF16, c.hasSubgroups, c.hasTimestamp, c.hasPackedDot, c.software]));
}
// 形狀區間：每一維取不小於它的 2 的冪次（同一區間共用一個競賽結果）
function ceilPow2(v) { let b = 1; while (b < v) b *= 2; return b; }
function shapeBucket(shape) {
  const s = shape || {};
  return Object.keys(s).sort().map((k) => k + ceilPow2(Math.max(1, s[k] | 0))).join(',');
}
function cacheKey(adapterDesc, op, shape, caps) {
  return [String(adapterDesc || 'unknown'), op, shapeBucket(shape), capsHash(caps)].join('|');
}
// store：任何有 get(key)／set(key, value) 的物件（瀏覽器端用 localStorage 包一層）。
// 回傳 { id, source: 'forced'|'tuned'|'rule', reason }。已強制的永遠優先；快取裡的變體若能力不足就忽略。
function pickWithCache(op, shape, caps, overrides, store, adapterDesc) {
  const forcedId = overrides && overrides[op];
  if (forcedId) {
    const r = pickVariant(op, shape, caps, overrides);
    return { id: r.id, source: r.forced ? 'forced' : 'rule', reason: r.reason };
  }
  const key = cacheKey(adapterDesc, op, shape, caps);
  let entry = null;
  try { entry = store && store.get ? store.get(key) : null; } catch (_) { entry = null; }
  if (entry && entry.id) {
    const v = (VARIANTS[op] || []).find((x) => x.id === entry.id);
    if (v && !(v.applies && !v.applies(shape || {})) && !meets(caps || DEFAULT_CAPS, v)) {
      return { id: v.id, source: 'tuned', reason: '快取的競賽結果（' + key + '）' };
    }
  }
  const r = pickVariant(op, shape, caps, overrides);
  return { id: r.id, source: 'rule', reason: r.reason };
}
// 競賽結果：timings = { 變體 id: [毫秒, 毫秒, ...] }，取中位數最小者；沒有有效量測回傳 null
function medianOf(xs) {
  const a = xs.filter((x) => typeof x === 'number' && isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function chooseWinner(timings) {
  let best = null;
  for (const id of Object.keys(timings || {})) {
    const med = medianOf(timings[id]);
    if (med === null) continue;
    if (!best || med < best.median) best = { id: id, median: med };
  }
  return best;
}

// ---------- 競賽執行器（O9 整合：kernel_race.race 與 variant_race.race 共用這一份）----------
// opts：
//   ids：依優先序的變體 id 清單（呼叫端先做能力／形狀過濾）
//   device：{ run(id) → 毫秒（或 Promise）, verify(id) → 相對誤差（可省） }
//   clock：{ now() → 毫秒 }；yieldFn：每個停止點先呼叫（讓出執行緒）；cancel：{ cancelled() } 或回傳布林的函式
//   budgetMs（2000）、runs（3）、tol（1e-5）、K（驗證＋計時的變體數上限，預設不限）、allowPartial（未跑滿的次數是否計入勝負，預設否）
// 規則：驗證先於計時；每次量測若「已用＋最長一次耗時」會超過預算就不開始；取消時 winner 為 null。
// 回傳 { winner: {id, median}|null, timings: {id: [ms×runs]}, partial: {id: [ms]}, bad: [{id, reason}], skipped: [id], budgetHit, cancelled, ms }。
async function raceVariants(opts) {
  opts = opts || {};
  const device = opts.device;
  if (!device || typeof device.run !== 'function') throw new Error('kernel_select：競賽需要 device.run');
  const ids = opts.ids || [];
  const clock = opts.clock || { now: function () { return typeof performance !== 'undefined' ? performance.now() : Date.now(); } };
  const yieldFn = opts.yieldFn || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  const budget = opts.budgetMs || 2000;
  const runs = opts.runs || 3;
  const tol = opts.tol || 1e-5;
  const K = opts.K || Infinity;
  const cancelSrc = opts.cancel;
  const cancelObj = typeof cancelSrc === 'function' ? { cancelled: cancelSrc } : (cancelSrc || { cancelled: function () { return false; } });
  const t0 = clock.now();
  const res = { winner: null, timings: {}, partial: {}, bad: [], skipped: [], budgetHit: false, cancelled: false, ms: 0 };
  if (opts.op !== undefined) res.op = opts.op;
  let lastMs = 0;  // 量到的最長單次耗時：下一次只在「已用＋這個耗時」不超過預算時才開始
  let stop = null;
  let tried = 0;
  function setStop(s) {
    stop = s;
    if (s === 'cancel') res.cancelled = true;
    if (s === 'budget') res.budgetHit = true;
  }
  async function gate() {
    await yieldFn();
    if (cancelObj.cancelled()) return 'cancel';
    if (clock.now() - t0 + lastMs > budget) return 'budget';
    return null;
  }
  for (const id of ids) {
    if (stop === null && tried < K) setStop(await gate());
    if (stop === 'cancel') break;
    if (stop === 'budget' || tried >= K) { res.skipped.push(id); continue; }
    tried++;

    if (device.verify) {
      let err;
      try { err = await device.verify(id); } catch (e) { res.bad.push({ id: id, reason: '驗證丟錯：' + msgOf(e) }); continue; }
      if (!(typeof err === 'number' && err <= tol)) { res.bad.push({ id: id, reason: '相對誤差 ' + err + ' 超過 ' + tol }); continue; }
    }

    const xs = [];
    let failed = false;
    for (let r = 0; r < runs; r++) {
      setStop(await gate());
      if (stop) break;
      let ms;
      try { ms = await device.run(id); } catch (e) { res.bad.push({ id: id, reason: '執行丟錯：' + msgOf(e) }); failed = true; break; }
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { res.bad.push({ id: id, reason: '計時無效：' + ms }); failed = true; break; }
      xs.push(ms);
      if (ms > lastMs) lastMs = ms;
    }
    if (failed) continue;
    if (xs.length === runs) res.timings[id] = xs;
    else if (xs.length) res.partial[id] = xs;
  }

  res.ms = clock.now() - t0;
  const counted = opts.allowPartial ? Object.assign({}, res.timings, res.partial) : res.timings;
  if (opts.allowPartial) res.timings = counted;
  if (!res.cancelled) res.winner = chooseWinner(counted);
  return res;
}
function msgOf(e) { return String((e && e.message) || e); }

// ---------- 勝者快取（O9 合一）：唯一的持久化層，kernel_race 與 variant_race 都用這裡 ----------
// 單一 localStorage 鍵 { v, entries, overrides }；entries 以 cacheKey 為鍵，值是勝者記錄（至少有 id）。
// 失效：同一 adapter 的筆數若 caps 雜湊不同就刪掉；格式壞掉的也刪。所有讀寫都 try/catch，失敗就只在記憶體。
const WINNER_KEY = 'cudaweb.kernel_race.v1';   // 沿用 O9 既有鍵，已存的結果不會遺失
const WINNER_SCHEMA = 1;
function defaultStorage() {
  // Node 25 會有一個壞掉的 localStorage 全域（沒有 getItem）：只接受真的有讀寫方法的物件
  if (typeof window === 'undefined') return null;   // node 不碰 localStorage 全域（會有警告）；node 測試一律走記憶體
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    return ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function' ? ls : null;
  } catch (_) { return null; }
}
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
// opts：storage（省略＝localStorage；null＝純記憶體）、storageKey、adapter（字串，給失效用；省略就不依 adapter 刪）、caps（給雜湊）
function createWinnerCache(opts) {
  opts = opts || {};
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const key = opts.storageKey || WINNER_KEY;
  const adapter = opts.adapter == null ? null : String(opts.adapter);
  const chash = opts.caps ? capsHash(opts.caps) : null;
  let lastSaveOk = false;
  function emptyState() { return { v: WINNER_SCHEMA, entries: {}, overrides: {} }; }
  function load() {
    let raw = null;
    try { raw = storage ? storage.getItem(key) : null; } catch (_) { raw = null; }
    let s = null;
    try { s = raw ? JSON.parse(raw) : null; } catch (_) { s = null; }
    if (!isObj(s) || s.v !== WINNER_SCHEMA || !isObj(s.entries) || !isObj(s.overrides)) return emptyState();
    return s;
  }
  function save() {
    lastSaveOk = false;
    try { if (storage) { storage.setItem(key, JSON.stringify(st)); lastSaveOk = true; } } catch (_) { lastSaveOk = false; }
    return lastSaveOk;
  }
  function prune() {
    let changed = false;
    Object.keys(st.entries).forEach(function (k) {
      const e = st.entries[k];
      if (!isObj(e) || typeof e.id !== 'string' || (adapter !== null && e.adapter === adapter && e.caps !== chash)) { delete st.entries[k]; changed = true; }
    });
    return changed;
  }
  let st = load();
  if (prune()) save();
  return {
    kind: storage ? 'localStorage' : 'memory',
    adapter: adapter,
    capsHash: chash,
    get: function (k) { return hasOwn(st.entries, k) ? st.entries[k] : null; },
    put: function (k, v) { st.entries[k] = v; return save(); },
    remove: function (k) { if (hasOwn(st.entries, k)) { delete st.entries[k]; return save(); } return true; },
    entries: function () { return Object.keys(st.entries).map(function (k) { return { key: k, value: st.entries[k] }; }); },
    setOverride: function (op, id) { st.overrides[op] = id; return save(); },
    clearOverride: function (op) { if (hasOwn(st.overrides, op)) { delete st.overrides[op]; return save(); } return true; },
    overrides: function () { return Object.assign({}, st.overrides); },
    reset: function () { st = emptyState(); return save(); },
    clearEntries: function () { st.entries = {}; return save(); },   // 只清勝者，保留強制覆蓋
    persisted: function () { return lastSaveOk; }
  };
}

module.exports = { DEFAULT_CAPS, probeCaps, tierOf, pickVariant, VARIANTS, meets, capsHash, shapeBucket, cacheKey, pickWithCache, medianOf, chooseWinner, raceVariants, createWinnerCache, defaultStorage, WINNER_KEY };
