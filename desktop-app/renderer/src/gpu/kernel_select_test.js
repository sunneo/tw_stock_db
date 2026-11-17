// node renderer/src/gpu/kernel_select_test.js — 變體選擇器（O1）的單元測試（純函式，不需要 GPU）
'use strict';
const assert = require('assert');
const KS = require('./kernel_select.js');
const ops = require('./infer_ops.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

// 三種假能力表（對應低／中／高）＋軟體 adapter
const LOW = KS.probeCaps({ features: new Set() }, { limits: { maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 }, features: new Set() });
const MID = KS.probeCaps({ features: new Set(['shader-f16']) }, { limits: { maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }, features: new Set(['shader-f16']) });
const HIGH = KS.probeCaps({ features: new Set(['subgroups']) }, { limits: { maxComputeWorkgroupStorageSize: 49152, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }, features: new Set(['subgroups']) });
const SOFT = KS.probeCaps({ isFallbackAdapter: true, features: new Set() }, { limits: { maxComputeWorkgroupStorageSize: 65536, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }, features: new Set() });

(async () => {
  await t('probeCaps：讀 limits 與 features；探不到給保守預設（低階）', () => {
    assert.strictEqual(LOW.probed, true);
    assert.strictEqual(LOW.maxWorkgroupStorage, 16384);
    assert.strictEqual(LOW.hasF16, false);
    const none = KS.probeCaps(null, null);
    assert.strictEqual(none.probed, false);
    assert.strictEqual(none.maxWorkgroupStorage, 16384);
    assert.strictEqual(KS.tierOf(none), 'min');
  });
  await t('tierOf：低／中／高／軟體 adapter 各自歸類', () => {
    assert.strictEqual(KS.tierOf(LOW), 'low');
    assert.strictEqual(KS.tierOf(MID), 'mid');
    assert.strictEqual(KS.tierOf(HIGH), 'high');
    assert.strictEqual(KS.tierOf(SOFT), 'min');
    const tiny = Object.assign({}, LOW, { maxWorkgroupStorage: 8192 });
    assert.strictEqual(KS.tierOf(tiny), 'min');
  });
  await t('低階：matmul 選平鋪 f32（形狀夠大）或簡單版；不會選到需要 f16 或子群組的變體', () => {
    assert.strictEqual(KS.pickVariant('matmul', { M: 64, N: 1024 }, LOW, {}).id, 'mm_tiled_f32');
    assert.strictEqual(KS.pickVariant('matmul', { M: 1, N: 1024 }, LOW, {}).id, 'mm_simple_f32');
    assert.strictEqual(KS.pickVariant('q8mm', { M: 1, N: 1024 }, LOW, {}).id, 'q8mm_dec');
    assert.strictEqual(KS.pickVariant('q8mm', { M: 64, N: 1024 }, LOW, {}).id, 'q8mm_pf');
    assert.strictEqual(KS.pickVariant('q8mm', { M: 1, N: 6 }, LOW, {}).id, 'q8mm_simple');
  });
  await t('低階：每種形狀都回傳可用變體（保底不會丟錯）', () => {
    for (const op of ['matmul', 'q8mm']) for (const M of [1, 8, 16, 64, 300]) for (const N of [1, 4, 6, 64, 1024]) {
      const v = KS.pickVariant(op, { M, N }, LOW, {});
      assert.ok(v.id && v.tier === 'low', op + ' ' + M + 'x' + N);
    }
  });
  await t('中、高階與軟體 adapter：同一組形狀仍只回傳已實作的變體，共用記憶體不超過該卡上限', () => {
    for (const caps of [MID, HIGH, SOFT]) {
      const v = KS.pickVariant('q8mm', { M: 64, N: 1024 }, caps, {});
      assert.ok(KS.VARIANTS.q8mm.some((x) => x.id === v.id));
      assert.ok(KS.VARIANTS.q8mm.find((x) => x.id === v.id).shared <= caps.maxWorkgroupStorage);
    }
    assert.strictEqual(KS.pickVariant('q8mm', { M: 64, N: 1024 }, SOFT, {}).tier, 'min');
  });
  await t('軟體 adapter 只看上限不看名稱：上限夠就用平鋪；執行緒上限不足才退到簡單版', () => {
    const v = KS.pickVariant('matmul', { M: 64, N: 1024 }, SOFT, {});
    assert.strictEqual(v.id, 'mm_tiled_f32');  // 軟體 adapter 的上限夠大，平鋪仍可用
    const tiny = Object.assign({}, LOW, { maxInvocations: 64, maxWorkgroupSizeX: 64 });
    assert.strictEqual(KS.pickVariant('matmul', { M: 64, N: 1024 }, tiny, {}).id, 'mm_simple_f32');
    assert.strictEqual(KS.pickVariant('q8mm', { M: 64, N: 1024 }, tiny, {}).id, 'q8mm_simple');
  });
  await t('強制覆蓋：能力足夠就照指定；能力不足或形狀不適用就退回自動並寫明原因', () => {
    const f = KS.pickVariant('q8mm', { M: 1, N: 1024 }, LOW, { q8mm: 'q8mm_simple' });
    assert.strictEqual(f.id, 'q8mm_simple'); assert.strictEqual(f.forced, true);
    const bad = KS.pickVariant('q8mm', { M: 1, N: 6 }, LOW, { q8mm: 'q8mm_dec' });
    assert.strictEqual(bad.id, 'q8mm_simple'); assert.strictEqual(bad.forced, false);
    assert.ok(/不適用/.test(bad.reason));
    const tiny = Object.assign({}, LOW, { maxWorkgroupStorage: 4096 });
    const big = KS.pickVariant('q8mm', { M: 1, N: 1024 }, tiny, { q8mm: 'q8mm_dec' });
    assert.strictEqual(big.id, 'q8mm_simple'); assert.ok(/共用記憶體/.test(big.reason));
    const unknown = KS.pickVariant('q8mm', { M: 1, N: 1024 }, LOW, { q8mm: 'nope' });
    assert.ok(/不存在/.test(unknown.reason));
  });
  await t('未知運算丟錯', () => {
    assert.throws(() => KS.pickVariant('nosuch', {}, LOW, {}), /未知運算/);
  });
  await t('與 infer_ops.q8mmVariant（自動選擇）在常見形狀上一致', () => {
    for (const [M, N] of [[1, 1024], [8, 1024], [64, 1024], [300, 1024], [1, 6], [64, 6]]) {
      assert.strictEqual(KS.pickVariant('q8mm', { M, N }, LOW, {}).id.replace('q8mm_', ''), ops.q8mmVariant(N, {}, M));
    }
  });
  // ---- O9：快取鍵、失效、強制覆蓋、競賽挑選 ----
  const mem = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m }; };
  await t('快取鍵：同 adapter、運算、形狀區間、能力表 → 同一鍵；形狀跨區間或能力變了 → 不同鍵', () => {
    const k1 = KS.cacheKey('nvidia kepler', 'q8mm', { M: 1, N: 1000 }, LOW);
    assert.strictEqual(k1, KS.cacheKey('nvidia kepler', 'q8mm', { M: 1, N: 1024 }, LOW));  // 1000 與 1024 同一個 2 的冪次區間
    assert.notStrictEqual(k1, KS.cacheKey('nvidia kepler', 'q8mm', { M: 2, N: 1024 }, LOW));
    assert.notStrictEqual(k1, KS.cacheKey('nvidia kepler', 'q8mm', { M: 1, N: 1024 }, MID));
    assert.notStrictEqual(k1, KS.cacheKey('amd x', 'q8mm', { M: 1, N: 1024 }, LOW));
  });
  await t('快取：有效的競賽結果優先於規則；能力表變了就失效（回到規則）', () => {
    const store = mem();
    const shape = { M: 1, N: 1024 };
    store.set(KS.cacheKey('kep', 'q8mm', shape, LOW), { id: 'q8mm_simple', ms: 1.2 });
    const hit = KS.pickWithCache('q8mm', shape, LOW, {}, store, 'kep');
    assert.strictEqual(hit.id, 'q8mm_simple'); assert.strictEqual(hit.source, 'tuned');
    const miss = KS.pickWithCache('q8mm', shape, MID, {}, store, 'kep');
    assert.strictEqual(miss.source, 'rule');
  });
  await t('快取：指向能力不足或不適用的變體時忽略，走規則', () => {
    const store = mem();
    store.set(KS.cacheKey('kep', 'q8mm', { M: 1, N: 6 }, LOW), { id: 'q8mm_dec' });  // N 不是 4 的倍數，dec 不適用
    assert.strictEqual(KS.pickWithCache('q8mm', { M: 1, N: 6 }, LOW, {}, store, 'kep').source, 'rule');
    const tiny = Object.assign({}, LOW, { maxWorkgroupStorage: 4096 });
    store.set(KS.cacheKey('kep', 'q8mm', { M: 1, N: 1024 }, tiny), { id: 'q8mm_dec' });
    assert.strictEqual(KS.pickWithCache('q8mm', { M: 1, N: 1024 }, tiny, {}, store, 'kep').id, 'q8mm_simple');
  });
  await t('快取：壞掉的儲存（get 丟錯）不影響選擇，退回規則', () => {
    const bad = { get() { throw new Error('storage blocked'); }, set() {} };
    const r = KS.pickWithCache('q8mm', { M: 1, N: 1024 }, LOW, {}, bad, 'kep');
    assert.strictEqual(r.source, 'rule');
    assert.strictEqual(KS.pickWithCache('q8mm', { M: 1, N: 1024 }, LOW, {}, null, 'kep').source, 'rule');
  });
  await t('強制覆蓋優先於快取', () => {
    const store = mem();
    store.set(KS.cacheKey('kep', 'q8mm', { M: 1, N: 1024 }, LOW), { id: 'q8mm_dec' });
    const r = KS.pickWithCache('q8mm', { M: 1, N: 1024 }, LOW, { q8mm: 'q8mm_simple' }, store, 'kep');
    assert.strictEqual(r.id, 'q8mm_simple'); assert.strictEqual(r.source, 'forced');
  });
  await t('競賽挑選：取中位數最小者（不受單次離群值影響）；沒有有效量測回傳 null', () => {
    const w = KS.chooseWinner({ q8mm_dec: [1, 9, 1.1], q8mm_simple: [2, 2.1, 2.2], q8mm_pf: [] });
    assert.strictEqual(w.id, 'q8mm_dec');
    assert.strictEqual(w.median, 1.1);
    assert.strictEqual(KS.chooseWinner({ a: [NaN] }), null);
    assert.strictEqual(KS.medianOf([4, 1, 3, 2]), 2.5);
  });

  console.log(pass + ' 項通過');
})();
