// node renderer/src/gpu/mm_rerun_test.js — O9：mm_ops 重跑、窗格對接的鍵條件、第一次使用仍用規則、canRerun 資料。
// 不需要 GPU：raceOne／calibrate 注入假函式，儲存用記憶體。
'use strict';
const assert = require('assert');
const mm = require('./mm_ops.js');
const KS = require('./kernel_select.js');
const KR = require('./kernel_race.js');
const VR = require('./variant_race.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

const SH = { M: 32, K: 32, N: 32 };
const KEY = KS.cacheKey('unknown', 'matmul', SH, null);   // mm_ops 預設 adapter 與 caps（node 沒有 GPU）
const calibrate = async () => ({ gSimple: null });
function fakeRaceOne(log) {
  return async (M, K, N) => { log.push([M, K, N]); return { key: KEY, winner: null, bad: [], gated: [], cancelled: false, noGpu: false }; };
}
function fakeStore() {
  return { removed: [], remove: async function (k) { this.removed.push(k); } };
}

(async () => {
  await t('第一次使用（沒有勝者）派發用規則，不擋住', () => {
    mm.setMatmulWinners([]);
    const r = mm.pickMatmulKernel(SH.M, SH.K, SH.N, {});
    assert.strictEqual(r.source, 'rule');
  });

  await t('有勝者時派發用勝者（tuned）', () => {
    mm.setMatmulWinners([{ key: KEY, value: { id: 'mm_simple_f32', median: 1, timings: {} } }]);
    const r = mm.pickMatmulKernel(SH.M, SH.K, SH.N, {});
    assert.strictEqual(r.source, 'tuned');
    assert.strictEqual(r.id, 'mm_simple_f32');
  });

  await t('重跑：先清掉舊勝者（記憶體與儲存），再對這個形狀競賽一次', async () => {
    mm.setMatmulWinners([{ key: KEY, value: { id: 'mm_simple_f32', median: 1, timings: {} } }]);
    const log = [], store = fakeStore();
    await mm.rerunMatmul([SH], { store: store, raceOne: fakeRaceOne(log), calibrate: calibrate, roofline: false });
    assert.deepStrictEqual(log, [[32, 32, 32]]);
    assert.deepStrictEqual(store.removed, [KEY]);
    assert.strictEqual(mm.pickMatmulKernel(SH.M, SH.K, SH.N, {}).source, 'rule', '舊勝者已清掉，派發回到規則');
  });

  await t('重跑：沒有有效形狀就不競賽、不丟錯', async () => {
    const log = [];
    const out = await mm.rerunMatmul([{ M: 0, K: 1, N: 1 }, null], { raceOne: fakeRaceOne(log), calibrate: calibrate, roofline: false });
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(log, []);
  });

  await t('窗格對接：getMatmulTuneContext 給的 adapter 與 caps，能讓 kernel_race 算出與 mm_ops 相同的鍵', () => {
    const ctx = mm.getMatmulTuneContext();
    const kr = KR.createKernelRace({ adapter: ctx.adapter, caps: ctx.caps || undefined, storage: null });
    assert.strictEqual(kr.key('matmul', SH), KEY);
  });

  await t('canRerun：沒給 rerunnable 時全部為否（附原因）；給了才為真；軟體 adapter 永遠否', () => {
    const none = KR.createKernelRace({ adapter: 'x', storage: null }).snapshot({});
    assert.ok(none.every((r) => r.canRerun === false && /真 GPU/.test(r.rerunHint)));
    const yes = KR.createKernelRace({ adapter: 'x', storage: null, rerunnable: (op) => op === 'matmul' }).snapshot({});
    assert.strictEqual(yes.find((r) => r.op === 'matmul').canRerun, true);
    assert.strictEqual(yes.find((r) => r.op === 'q8mm').canRerun, false);
    const soft = KS.probeCaps({ isFallbackAdapter: true, features: new Set() }, { limits: {}, features: new Set() });
    const sw = KR.createKernelRace({ adapter: 'x', caps: soft, storage: null, rerunnable: () => true }).snapshot({});
    assert.ok(sw.every((r) => r.canRerun === false));
  });

  await t('變體儲存 remove：只刪這一把鍵', async () => {
    const s = VR.createStore({ storage: null });
    await s.set('a', { id: 'x' });
    await s.set('b', { id: 'y' });
    await s.remove('a');
    assert.strictEqual(await s.get('a'), null);
    assert.deepStrictEqual(await s.get('b'), { id: 'y' });
  });

  console.log(pass + ' 項通過（mm_rerun）');
})().catch((e) => { console.error(e); process.exit(1); });
