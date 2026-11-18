'use strict';
// 變體競賽邏輯測試（node，假計時與假後端）。
const assert = require('assert');
const RACE = require('./cpu_gemm_race.js');

const V = RACE.candidateVariants();
const ids = V.map((v) => v.id);

// 1. 候選清單：5 個變體，含預設，且預設在清單中
assert.strictEqual(V.length, 5);
assert.ok(ids.includes(RACE.DEFAULT_ID));
console.log('ok 候選變體 5 個，含預設');

// 2. 勝者需快於預設超過 5%
{
  const times = { [RACE.DEFAULT_ID]: 100, 'simd-48-64-256': 80, 'simd-192-64-512': 99, 'simd-96-64-256': 99, 'js-96-256-512': 4000 };
  const r = RACE.raceVariants(V, (v) => times[v.id], 1e9, 2);
  assert.strictEqual(r.winnerId, 'simd-48-64-256');
  assert.strictEqual(r.rows.find((x) => x.id === 'simd-48-64-256').verdict, '勝者');
  assert.strictEqual(r.rows.find((x) => x.id === 'simd-192-64-512').verdict, '沒有好處');
  assert.strictEqual(r.rows.find((x) => x.id === 'js-96-256-512').verdict, '沒有好處');
  console.log('ok 勝者需快於預設 5% 以上（80 vs 100 勝；99 vs 100 不算好處）');
}

// 3. 差距在 5% 以內：維持預設，即使有變體略快（不換）
{
  const times = { [RACE.DEFAULT_ID]: 100, 'simd-48-64-256': 98, 'simd-192-64-512': 99, 'simd-96-64-256': 99, 'js-96-256-512': 4000 };
  const r = RACE.raceVariants(V, (v) => times[v.id], 1e9, 2);
  assert.strictEqual(r.winnerId, RACE.DEFAULT_ID);
  assert.ok(r.reason.includes('維持預設'));
  assert.strictEqual(r.rows.find((x) => x.id === 'simd-48-64-256').verdict, '沒有好處');
  console.log('ok 差距低於 5% 維持預設，並標示沒有好處');
}

// 4. 有好處的非勝者標「有好處」（比預設快 5% 以上，但不是最快）
{
  const times = { [RACE.DEFAULT_ID]: 100, 'simd-48-64-256': 70, 'simd-192-64-512': 90, 'simd-96-64-256': 99, 'js-96-256-512': 4000 };
  const r = RACE.raceVariants(V, (v) => times[v.id], 1e9, 2);
  assert.strictEqual(r.rows.find((x) => x.id === 'simd-192-64-512').verdict, '有好處');
  console.log('ok 非勝者但比預設快 5% 以上標「有好處」');
}

// 5. 取最小值：每個變體重複 reps 次，取最快的一次
{
  let calls = 0;
  const seq = [50, 40, 60];
  RACE.raceVariants([{ id: 'x', kernel: 'simd', MC: 1, KC: 1, NC: 1 }], () => seq[calls++], 1, 3);
  assert.strictEqual(calls, 3);
  console.log('ok 每個變體重複 reps 次（取最小值）');
}

// 6. 瀏覽器版本解析與鍵
assert.strictEqual(RACE.browserVersion('Mozilla/5.0 Chrome/118.0.5993.88 Safari/537.36'), 'Chrome118');
assert.strictEqual(RACE.browserVersion('Mozilla/5.0 Version/17.1 Safari/605.1.15'), 'Safari17');
assert.strictEqual(RACE.browserVersion('Mozilla/5.0 Firefox/120.0'), 'Firefox120');
assert.strictEqual(RACE.browserVersion(''), 'unknown');
assert.strictEqual(RACE.raceKey(4, 'x Chrome/118.0'), 'gemm-race|cores=4|browser=Chrome118');
assert.strictEqual(RACE.raceKey(0, ''), 'gemm-race|cores=1|browser=unknown');
console.log('ok 瀏覽器版本解析與鍵（核心數與版本都在鍵裡）');

(async () => {
  // 7. 保存與讀回（假後端）
  const m = new Map();
  const store = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
  const key = RACE.raceKey(4, 'x Chrome/118.0');
  const times = { [RACE.DEFAULT_ID]: 100, 'simd-48-64-256': 70, 'simd-192-64-512': 99, 'simd-96-64-256': 99, 'js-96-256-512': 4000 };
  const r = RACE.raceVariants(V, (v) => times[v.id], 1e9, 2);
  assert.strictEqual(await RACE.saveWinner(store, key, r), true);
  const picked = await RACE.chooseVariant(store, key, V);
  assert.strictEqual(picked.id, 'simd-48-64-256');
  // 不同鍵（核心數不同）沒有紀錄 → 預設
  const other = await RACE.chooseVariant(store, RACE.raceKey(2, 'x Chrome/118.0'), V);
  assert.strictEqual(other.id, RACE.DEFAULT_ID);
  console.log('ok 保存與讀回；不同核心數的鍵各自獨立，沒有紀錄回預設');

  // 8. 後端失敗：保存回 false、選用回預設，都不拋錯
  const bad = { get: async () => { throw new Error('idb 壞了'); }, set: async () => { throw new Error('寫入失敗'); } };
  assert.strictEqual(await RACE.saveWinner(bad, key, r), false);
  assert.strictEqual((await RACE.chooseVariant(bad, key, V)).id, RACE.DEFAULT_ID);
  console.log('ok 後端失敗：保存回 false，選用回預設，不拋錯');

  // 9. 保存的勝者 id 已不在候選清單中（版本升級）：回預設
  await m.set(key, { winnerId: 'gone-variant' });
  m.set(key, { winnerId: 'gone-variant' });
  assert.strictEqual((await RACE.chooseVariant(store, key, V)).id, RACE.DEFAULT_ID);
  console.log('ok 保存的變體已不存在：回預設');

  console.log('cpu_gemm_race_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
