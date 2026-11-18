// node renderer/src/gpu/kernel_race_test.js — 變體競賽執行器與本機快取（清單 O9）的測試。假時鐘、假裝置、假儲存，不需要 GPU。
'use strict';
const assert = require('assert');
const KS = require('./kernel_select.js');
const KR = require('./kernel_race.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

const LOW = KS.probeCaps({ features: new Set() }, { limits: { maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 }, features: new Set() });
const MID = KS.probeCaps({ features: new Set(['shader-f16']) }, { limits: { maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }, features: new Set(['shader-f16']) });
const SOFT = KS.probeCaps({ isFallbackAdapter: true, features: new Set() }, { limits: { maxComputeWorkgroupStorageSize: 65536, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024 }, features: new Set() });
const MM = { M: 64, N: 64, K: 64 };          // 三個 matmul 變體都適用
const MM_IDS = ['mm_vec4_f32', 'mm_tiled_f32', 'mm_simple_f32'];

// 假時鐘：只有 advance 會前進（假裝置每次執行時推進）
function fakeClock() { let t = 0; return { now: function () { return t; }, advance: function (ms) { t += ms; } }; }
// 假裝置：plan = { [id]: [耗時…] }（超出長度就用最後一個）；耗時是 Error 就丟出；plan.verify = { [id]: 相對誤差 }
function fakeDevice(clock, plan) {
  const calls = {};
  return {
    calls: calls,
    run: async function (id) {
      calls[id] = (calls[id] || 0) + 1;
      const seq = plan[id] || [1];
      const c = seq[Math.min(calls[id] - 1, seq.length - 1)];
      if (c instanceof Error) throw c;
      clock.advance(c);
      return c;
    },
    verify: plan.verify ? async function (id) { return has(plan.verify, id) ? plan.verify[id] : 0; } : undefined
  };
}
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
// 假儲存：getItem／setItem 走 Map；可選擇讓它丟錯
function memStorage(initial) {
  const m = new Map();
  if (initial !== undefined) m.set(KR.STORE_KEY, initial);
  return { getItem: function (k) { return m.has(k) ? m.get(k) : null; }, setItem: function (k, v) { m.set(k, String(v)); }, raw: function () { return m.get(KR.STORE_KEY) || null; } };
}
const instantYield = async function () {};

(async () => {
  await t('eligibleVariants：依能力與形狀過濾（低階沒有 f16；q8mm_pf 要 M≥64）', () => {
    assert.deepStrictEqual(KR.eligibleVariants('matmul', MM, LOW), MM_IDS);
    assert.deepStrictEqual(KR.eligibleVariants('matmul', { M: 1, N: 1, K: 3 }, LOW), ['mm_simple_f32']);
    assert.deepStrictEqual(KR.eligibleVariants('q8mm', { M: 1, N: 1024 }, LOW), ['q8mm_dec', 'q8mm_simple']);
    // q8mm 表已與 infer_ops 同步（K 未給：f32 版不適用，decr8／decr 是 pf 之後的可用後備）
    assert.deepStrictEqual(KR.eligibleVariants('q8mm', { M: 128, N: 1024 }, LOW), ['q8mm_pf', 'q8mm_decr8', 'q8mm_decr', 'q8mm_dec', 'q8mm_simple']);
    assert.throws(() => KR.eligibleVariants('nope', MM, LOW), /未知運算/);
  });

  await t('race：每個變體跑 3 次取中位數，勝者是中位數最小者（不受單次離群值影響）', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [3, 1, 2], mm_tiled_f32: [5, 5, 5], mm_simple_f32: [9, 0.5, 9] });
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: instantYield });
    assert.deepStrictEqual(res.timings.mm_vec4_f32, [3, 1, 2]);
    assert.strictEqual(res.winner.id, 'mm_vec4_f32');
    assert.strictEqual(res.winner.median, 2);
    assert.strictEqual(res.budgetHit, false);
    assert.strictEqual(res.cancelled, false);
    assert.deepStrictEqual(dev.calls, { mm_vec4_f32: 3, mm_tiled_f32: 3, mm_simple_f32: 3 });
  });

  await t('race：預算 2 秒，一次量測若會超過預算就不開始；不完整的變體不參與勝負，總時間不超過 2 秒', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [900], mm_tiled_f32: [900], mm_simple_f32: [1] });
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: instantYield });
    // vec4：900、1800 兩次（第三次 1800+900 會超過 2000，不開始）→ 不完整，只進 partial
    assert.deepStrictEqual(res.partial.mm_vec4_f32, [900, 900]);
    assert.strictEqual(has(res.timings, 'mm_vec4_f32'), false);
    assert.deepStrictEqual(res.skipped, ['mm_tiled_f32', 'mm_simple_f32']);
    assert.strictEqual(res.budgetHit, true);
    assert.strictEqual(res.winner, null);
    assert.ok(res.ms <= 2000, '總時間 ' + res.ms + ' 超過 2000');
  });

  await t('race：便宜的運算在預算內全部跑完（9 次量測）', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [10], mm_tiled_f32: [20], mm_simple_f32: [30] });
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: instantYield });
    assert.strictEqual(res.winner.id, 'mm_vec4_f32');
    assert.strictEqual(res.budgetHit, false);
    assert.strictEqual(res.ms, 180);
  });

  await t('race：背景——每個停止點都讓出執行緒（yield 次數 ≥ 變體數×次數）', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [1], mm_simple_f32: [1] });
    let yields = 0;
    await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: async () => { yields++; } });
    assert.ok(yields >= 9, '只讓出 ' + yields + ' 次');
  });

  await t('race：取消——跑到一半取消，winner 為 null，已量到的不寫成勝者', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [1], mm_simple_f32: [1] });
    const cancel = KR.createCancel();
    let n = 0;
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, cancel: cancel, yieldFn: async () => { n++; if (n === 4) cancel.cancel(); } });
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(res.winner, null);
    // 停止點順序：變體開始、run1、run2、run3；第 4 次讓出時取消 → vec4 只跑了 2 次，之後的變體一次都沒跑
    assert.strictEqual(dev.calls.mm_vec4_f32, 2);
    assert.strictEqual(has(res.timings, 'mm_vec4_f32'), false);
    assert.strictEqual(has(dev.calls, 'mm_tiled_f32'), false);
  });

  await t('race：驗證不過的變體標成壞的、退下一名（驗證先於計時）', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { verify: { mm_vec4_f32: 1e-3, mm_tiled_f32: 1e-7 }, mm_vec4_f32: [1], mm_tiled_f32: [5], mm_simple_f32: [4] });
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: instantYield });
    assert.strictEqual(res.bad.length, 1);
    assert.strictEqual(res.bad[0].id, 'mm_vec4_f32');
    assert.strictEqual(has(dev.calls, 'mm_vec4_f32'), false, '驗證不過就不應計時');
    assert.strictEqual(res.winner.id, 'mm_simple_f32');
  });

  await t('race：執行丟錯或計時無效（NaN、負數）的變體標成壞的，其餘照常', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [new Error('GPU lost')], mm_tiled_f32: [2, NaN], mm_simple_f32: [3] });
    const res = await KR.race({ op: 'matmul', shape: MM, caps: LOW, device: dev, clock: clock, yieldFn: instantYield });
    const reasons = res.bad.map((b) => b.id + ':' + b.reason);
    assert.ok(reasons.some((r) => r.startsWith('mm_vec4_f32:執行丟錯')), reasons.join(' / '));
    assert.ok(reasons.some((r) => r.startsWith('mm_tiled_f32:計時無效')), reasons.join(' / '));
    assert.strictEqual(res.winner.id, 'mm_simple_f32');
  });

  await t('race：沒有裝置 run 會直接丟錯', async () => {
    await assert.rejects(KR.race({ op: 'matmul', shape: MM, caps: LOW, device: {} }), /device\.run/);
  });

  await t('createKernelRace.choose：沒有快取時用規則；tune 進行中不阻塞（仍是規則）；完成後是快取的競賽結果', async () => {
    const clock = fakeClock();
    const storage = memStorage();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
    const dev = fakeDevice(clock, { mm_vec4_f32: [5], mm_tiled_f32: [1], mm_simple_f32: [9] });
    const h = kr.tune('matmul', MM, dev);
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule', 'tune 進行中不應改用結果');
    assert.strictEqual(kr.describe('matmul', MM).running, true);
    const res = await h.promise;
    assert.strictEqual(res.winner.id, 'mm_tiled_f32');
    const c = kr.choose('matmul', MM);
    assert.strictEqual(c.source, 'tuned');
    assert.strictEqual(c.id, 'mm_tiled_f32');
    assert.strictEqual(kr.persisted(), true);
    const saved = JSON.parse(storage.raw());
    assert.strictEqual(saved.entries[kr.key('matmul', MM)].id, 'mm_tiled_f32');
  });

  await t('tune：同一把鍵進行中回傳同一個 handle（不重複競賽）；handle.cancel 在開跑前取消，不寫快取', async () => {
    const clock = fakeClock();
    const storage = memStorage();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    const dev = fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [1], mm_simple_f32: [1] });
    const h1 = kr.tune('matmul', MM, dev);
    const h2 = kr.tune('matmul', MM, dev);
    assert.strictEqual(h1, h2);
    h1.cancel();
    const res = await h1.promise;
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
    assert.strictEqual(storage.raw(), null);
  });

  await t('軟體 adapter 不做競賽：立即完成、不呼叫裝置、不寫快取', async () => {
    const clock = fakeClock();
    const dev = fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [1], mm_simple_f32: [1] });
    const kr = KR.createKernelRace({ caps: SOFT, adapter: 'swiftshader', storage: memStorage(), clock: clock, yieldFn: instantYield });
    const res = await kr.tune('matmul', MM, dev).promise;
    assert.strictEqual(res.winner, null);
    assert.strictEqual(Object.keys(dev.calls).length, 0);
  });

  await t('快取鍵：含 adapter 描述與形狀區間（同一區間共用，區間外不共用）', () => {
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: fakeClock() });
    assert.strictEqual(kr.key('matmul', { M: 60, N: 64 }), kr.key('matmul', { M: 33, N: 40 }));
    assert.notStrictEqual(kr.key('matmul', { M: 60, N: 64 }), kr.key('matmul', { M: 300, N: 64 }));
    assert.notStrictEqual(kr.key('matmul', MM), KR.createKernelRace({ caps: LOW, adapter: 'other', storage: memStorage() }).key('matmul', MM));
  });

  await t('失效：能力表變了（換卡）→ 同一 adapter 的舊結果從儲存中刪掉；別的 adapter 不受影響', async () => {
    const clock = fakeClock();
    const storage = memStorage();
    const kr1 = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    const dev = fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] });
    await kr1.tune('matmul', MM, dev).promise;
    // 另一個 adapter 的舊結果（能力雜湊不同也不該被刪）
    const raw = JSON.parse(storage.raw());
    raw.entries['other|matmul|x|y'] = { id: 'mm_simple_f32', adapter: 'other', caps: 'zzz', op: 'matmul', bucket: 'x' };
    storage.setItem(KR.STORE_KEY, JSON.stringify(raw));
    const kr2 = KR.createKernelRace({ caps: MID, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    const after = JSON.parse(storage.raw());
    assert.strictEqual(has(after.entries, kr1.key('matmul', MM)), false, '舊能力的結果沒被刪');
    assert.strictEqual(has(after.entries, 'other|matmul|x|y'), true, '別的 adapter 被誤刪');
    assert.strictEqual(kr2.choose('matmul', MM).source, 'rule');
  });

  await t('不失效：能力表沒變，重新開啟後快取仍在', async () => {
    const clock = fakeClock();
    const storage = memStorage();
    const kr1 = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    await kr1.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] })).promise;
    const kr2 = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    const c = kr2.choose('matmul', MM);
    assert.strictEqual(c.source, 'tuned');
    assert.strictEqual(c.id, 'mm_vec4_f32');
  });

  await t('強制覆蓋：force 後 choose 來源為 forced；未知變體丟錯；能力或形狀不符時退回規則並寫明原因；unforce 還原', () => {
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: fakeClock() });
    kr.force('matmul', 'mm_simple_f32');
    const c = kr.choose('matmul', MM);
    assert.strictEqual(c.id, 'mm_simple_f32');
    assert.strictEqual(c.source, 'forced');
    assert.deepStrictEqual(kr.overrides(), { matmul: 'mm_simple_f32' });
    assert.throws(() => kr.force('matmul', 'no_such'), /沒有變體/);
    assert.throws(() => kr.force('nope', 'x'), /未知運算/);
    // vec4 不適用於 M=1：不硬用，退回規則
    kr.force('matmul', 'mm_vec4_f32');
    const bad = kr.choose('matmul', { M: 1, N: 1, K: 3 });
    assert.notStrictEqual(bad.id, 'mm_vec4_f32');
    assert.strictEqual(bad.source, 'rule');
    assert.ok(bad.reason.indexOf('不適用') >= 0, bad.reason);
    kr.unforce('matmul');
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
  });

  await t('強制覆蓋 會蓋過快取的競賽結果', async () => {
    const clock = fakeClock();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: clock, yieldFn: instantYield });
    await kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] })).promise;
    kr.force('matmul', 'mm_tiled_f32');
    assert.strictEqual(kr.choose('matmul', MM).id, 'mm_tiled_f32');
    assert.strictEqual(kr.choose('matmul', MM).source, 'forced');
  });

  await t('重跑：刪掉舊結果後重新競賽，新勝者取代舊的', async () => {
    const clock = fakeClock();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: clock, yieldFn: instantYield });
    await kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [5], mm_simple_f32: [5] })).promise;
    assert.strictEqual(kr.choose('matmul', MM).id, 'mm_vec4_f32');
    const h = kr.rerun('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [9], mm_tiled_f32: [1], mm_simple_f32: [5] }));
    await h.promise;
    assert.strictEqual(kr.choose('matmul', MM).id, 'mm_tiled_f32');
  });

  await t('重跑：進行中的競賽被取消，不會晚到寫入舊結果', async () => {
    const clock = fakeClock();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: clock, yieldFn: instantYield });
    const old = kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] }));
    const again = kr.rerun('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [4], mm_tiled_f32: [2], mm_simple_f32: [3] }));
    assert.notStrictEqual(old, again);
    assert.strictEqual((await old.promise).cancelled, true);
    await again.promise;
    assert.strictEqual(kr.choose('matmul', MM).id, 'mm_tiled_f32');
  });

  await t('恢復預設：清掉競賽結果與強制覆蓋，儲存也清空；進行中的競賽取消', async () => {
    const clock = fakeClock();
    const storage = memStorage();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: clock, yieldFn: instantYield });
    await kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] })).promise;
    kr.force('q8mm', 'q8mm_simple');
    const pending = kr.tune('matmul', { M: 1, N: 1, K: 8 }, fakeDevice(clock, { mm_simple_f32: [1] }));
    kr.reset();
    assert.strictEqual((await pending.promise).cancelled, true);
    assert.deepStrictEqual(kr.overrides(), {});
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
    const saved = JSON.parse(storage.raw());
    assert.deepStrictEqual(saved.entries, {});
    assert.deepStrictEqual(saved.overrides, {});
  });

  await t('describe：回報目前變體、來源、強制項、快取內容與可用變體（設定頁用）', async () => {
    const clock = fakeClock();
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(), clock: clock, yieldFn: instantYield });
    const d0 = kr.describe('matmul', MM);
    assert.strictEqual(d0.choice.source, 'rule');
    assert.strictEqual(d0.cached, null);
    assert.strictEqual(d0.forced, null);
    assert.deepStrictEqual(d0.eligible, MM_IDS);
    await kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] })).promise;
    kr.force('matmul', 'mm_simple_f32');
    const d1 = kr.describe('matmul', MM);
    assert.strictEqual(d1.forced, 'mm_simple_f32');
    assert.strictEqual(d1.cached.id, 'mm_vec4_f32');
    assert.strictEqual(d1.choice.id, 'mm_simple_f32');
  });

  await t('儲存丟錯（讀寫都丟）：仍可競賽與選擇，只留在記憶體；persisted 為 false', async () => {
    const clock = fakeClock();
    const bad = { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('quota'); } };
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: bad, clock: clock, yieldFn: instantYield });
    assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
    const res = await kr.tune('matmul', MM, fakeDevice(clock, { mm_vec4_f32: [1], mm_tiled_f32: [2], mm_simple_f32: [3] })).promise;
    assert.strictEqual(res.winner.id, 'mm_vec4_f32');
    assert.strictEqual(kr.choose('matmul', MM).source, 'tuned');
    assert.strictEqual(kr.persisted(), false);
    kr.force('matmul', 'mm_tiled_f32');
    assert.strictEqual(kr.choose('matmul', MM).id, 'mm_tiled_f32');
  });

  await t('儲存內容壞掉（非 JSON、格式版本不對）：當作空的，不丟錯', () => {
    for (const junk of ['{not json', JSON.stringify({ v: 0, entries: {}, overrides: {} }), JSON.stringify([1, 2])]) {
      const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: memStorage(junk), clock: fakeClock() });
      assert.strictEqual(kr.choose('matmul', MM).source, 'rule');
      assert.deepStrictEqual(kr.overrides(), {});
    }
  });

  await t('儲存裡的格式壞掉的筆數會被清掉，好的保留', () => {
    const good = { id: 'mm_simple_f32', adapter: 'kep', caps: KS.capsHash(LOW), op: 'matmul', bucket: 'x' };
    const storage = memStorage(JSON.stringify({ v: 1, entries: { a: 'junk', b: { adapter: 'kep', caps: KS.capsHash(LOW) }, c: good }, overrides: {} }));
    KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: fakeClock() });
    const saved = JSON.parse(storage.raw());
    assert.deepStrictEqual(Object.keys(saved.entries), ['c']);
  });

  await t('設定頁資料 snapshot：每個運算一列、可 JSON 序列化；強制與快取會反映在列上', () => {
    const storage = { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } };
    const kr = KR.createKernelRace({ caps: LOW, adapter: 'kep', storage: storage, clock: { now: () => 0 }, yieldFn: instantYield });
    let rows = kr.snapshot({ matmul: MM });
    const mm = rows.find((r) => r.op === 'matmul');
    assert.strictEqual(mm.choice, 'mm_vec4_f32');
    assert.strictEqual(mm.source, 'rule');
    assert.strictEqual(mm.forced, null);
    assert.strictEqual(mm.cached, null);
    kr.force('matmul', 'mm_simple_f32');
    rows = kr.snapshot({ matmul: MM });
    assert.strictEqual(rows.find((r) => r.op === 'matmul').choice, 'mm_simple_f32');
    assert.strictEqual(rows.find((r) => r.op === 'matmul').source, 'forced');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rows)), rows);
    kr.reset();
    assert.strictEqual(kr.snapshot({ matmul: MM }).find((r) => r.op === 'matmul').forced, null);
  });

  console.log(pass + ' 項通過');
})();
