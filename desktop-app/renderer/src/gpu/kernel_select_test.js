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
  console.log(pass + ' 項通過');
})();
