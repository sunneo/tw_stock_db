// node renderer/src/gpu/gpu_race_device_test.js — 競賽裝置轉接（清單 O9）的測試。假時鐘、假 GPU、假輸出，不需要真 GPU。
'use strict';
const assert = require('assert');
const KS = require('./kernel_select.js');
const GRD = require('./gpu_race_device.js');

(async () => {
let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

// 假時鐘：只有 launch 與 awaitGpu 會推進
function fakeClock() { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; }
// 假變體：cost 毫秒每次 launch；out 是輸出陣列（可以故意算錯）；launches 計次
function fakeVariant(clock, cost, out) {
  const v = { launches: 0 };
  v.launch = async () => { v.launches++; clock.advance(cost); };
  v.readOut = async () => out.slice();
  return v;
}
const REF = [1, 2, 3, 4];

await t('relErr：相同為 0；有差就是最大差除以最大參考值；長度不同或非有限值為 Infinity', () => {
  assert.strictEqual(GRD.relErr([1, 2], [1, 2]), 0);
  assert.ok(Math.abs(GRD.relErr([1, 2.2], [1, 2]) - 0.1) < 1e-12);
  assert.strictEqual(GRD.relErr([1], [1, 2]), Infinity);
  assert.strictEqual(GRD.relErr([NaN, 1], [1, 1]), Infinity);
  assert.strictEqual(GRD.relErr(null, [1]), Infinity);
});

await t('計時器：時間＝launch 與等 GPU 的總和（不含之後）', async () => {
  const c = fakeClock();
  const tm = GRD.createTimer({ now: c.now, awaitGpu: async () => c.advance(5) });
  const ms = await tm.time(async () => c.advance(7));
  assert.strictEqual(ms, 12);
});

await t('計時器缺 now 或 awaitGpu 就丟錯', () => {
  assert.throws(() => GRD.createTimer({ now: () => 0 }), /now 與 awaitGpu/);
});

await t('browserTimer：需要 GPUDevice；呼叫 queue.onSubmittedWorkDone 等 GPU', async () => {
  assert.throws(() => GRD.browserTimer({}), /onSubmittedWorkDone/);
  let waited = 0;
  const tm = GRD.browserTimer({ queue: { onSubmittedWorkDone: async () => { waited++; } } });
  const ms = await tm.time(async () => {});
  assert.strictEqual(waited, 1);
  assert.strictEqual(typeof ms, 'number');
  assert.ok(ms >= 0 && isFinite(ms));
});

await t('run：第一次先暖機（不計入回傳），之後每次回傳這次的計時', async () => {
  const c = fakeClock();
  const v = fakeVariant(c, 4, REF);
  const dev = GRD.createRaceDevice({ variants: { a: v }, timer: GRD.createTimer({ now: c.now, awaitGpu: async () => {} }), reference: async () => REF });
  const ms = await dev.run('a');
  assert.strictEqual(v.launches, 2, '暖機一次＋計時一次');
  assert.strictEqual(ms, 4);
  assert.strictEqual(await dev.run('a'), 4);
  assert.strictEqual(v.launches, 3);
});

await t('verify：輸出與參考一致為 0；算錯則為正的相對誤差；參考只算一次', async () => {
  const c = fakeClock();
  let refCalls = 0;
  const good = fakeVariant(c, 1, REF);
  const bad = fakeVariant(c, 1, [1, 2, 3, 4.5]);
  const dev = GRD.createRaceDevice({
    variants: { good, bad }, timer: GRD.createTimer({ now: c.now, awaitGpu: async () => {} }),
    reference: async () => { refCalls++; return REF; }
  });
  assert.strictEqual(await dev.verify('good'), 0);
  assert.ok((await dev.verify('bad')) > 1e-5);
  assert.strictEqual(refCalls, 1);
});

await t('沒有變體或缺 launch／readOut 就丟錯；缺 timer 或 reference 也丟錯', async () => {
  const c = fakeClock();
  const timer = GRD.createTimer({ now: c.now, awaitGpu: async () => {} });
  const dev = GRD.createRaceDevice({ variants: {}, timer, reference: async () => REF });
  await assert.rejects(dev.run('nope'), /沒有變體 nope/);
  await assert.rejects(dev.verify('nope'), /沒有變體 nope/);
  assert.throws(() => GRD.createRaceDevice({ variants: {}, reference: async () => REF }), /timer/);
  assert.throws(() => GRD.createRaceDevice({ variants: {}, timer }), /reference/);
});

await t('端到端：經 kernel_select.raceVariants，最快且算對的變體勝出；算錯的標壞、不計勝負', async () => {
  const c = fakeClock();
  const variants = {
    slow_ok: fakeVariant(c, 9, REF),
    fast_wrong: fakeVariant(c, 1, [9, 9, 9, 9]),   // 最快但算錯
    fast_ok: fakeVariant(c, 3, REF),
  };
  const dev = GRD.createRaceDevice({ variants, timer: GRD.createTimer({ now: c.now, awaitGpu: async () => {} }), reference: async () => REF });
  const res = await KS.raceVariants({ ids: ['fast_wrong', 'slow_ok', 'fast_ok'], device: dev, clock: { now: c.now }, budgetMs: 1e9, yieldFn: async () => {} });
  assert.strictEqual(res.winner.id, 'fast_ok');
  assert.strictEqual(res.winner.median, 3);
  assert.deepStrictEqual(res.bad.map((b) => b.id), ['fast_wrong']);
});

console.log(pass + ' 項通過（gpu_race_device）');
})().catch((e) => { console.error(e); process.exit(1); });
