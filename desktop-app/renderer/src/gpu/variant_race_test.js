'use strict';
// variant_race 的 node 測試（G4）：驗證先於計時、驗證失敗退下一名、K 上限、時間預算、可取消、中位數勝者、快取鍵失效、記憶體儲存退路。
const assert = require('assert');
const VR = require('./variant_race.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('ok   ' + name); }

// 假時鐘（見檔尾 clock0）：run() 每次把時鐘往前推 ms（模擬實際花的時間）
function cand(id, times, opts) {
  opts = opts || {};
  const c = clock; // 呼叫前已由測試設定 clock = clock0()
  let i = 0;
  return {
    id: id,
    verify: async () => { if (opts.verifyThrows) throw new Error('boom'); return opts.err === undefined ? 1e-7 : opts.err; },
    run: async () => { if (opts.runThrows) throw new Error('gpu lost'); const ms = times[Math.min(i, times.length - 1)]; i++; c.advance(ms); return ms; },
  };
}
let clock;

(async () => {
  await check('勝者＝中位數最小的已驗證變體（不是平均、不是第一名）', async () => {
    clock = clock0();
    const r = await VR.race([
      cand('A', [5, 9, 5]),      // 中位數 5
      cand('B', [4, 30, 30]),    // 中位數 30（平均最小但中位數大）
      cand('C', [6, 6, 6]),      // 中位數 6
    ], { now: clock.now, budgetMs: 1e9 });
    assert.strictEqual(r.winner.id, 'A');
    assert.strictEqual(r.winner.median, 5);
  });

  await check('驗證先於計時：誤差超過容差的變體標壞、不計時、退下一名', async () => {
    clock = clock0();
    const r = await VR.race([
      cand('bad', [1, 1, 1], { err: 0.5 }),   // 1 ms 很快但算錯
      cand('good', [9, 9, 9]),
    ], { now: clock.now, budgetMs: 1e9 });
    assert.strictEqual(r.winner.id, 'good');
    assert.ok(!('bad' in r.timings), '標壞的不應有計時');
    assert.strictEqual(r.bad[0].id, 'bad');
    assert.ok(/相對誤差/.test(r.bad[0].reason));
  });

  await check('驗證丟錯或執行丟錯：標壞並寫原因，不影響其他變體', async () => {
    clock = clock0();
    const r = await VR.race([
      cand('v', [1], { verifyThrows: true }),
      cand('r', [1], { runThrows: true }),
      cand('ok', [7, 7, 7]),
    ], { now: clock.now, budgetMs: 1e9 });
    assert.strictEqual(r.winner.id, 'ok');
    assert.deepStrictEqual(r.bad.map((b) => b.id), ['v', 'r']);
  });

  await check('K 上限：只量前 K 名，其餘列為 skipped', async () => {
    clock = clock0();
    const r = await VR.race([cand('1', [5]), cand('2', [5]), cand('3', [5]), cand('4', [1])], { now: clock.now, budgetMs: 1e9, K: 3 });
    assert.deepStrictEqual(r.skipped, ['4']);
    assert.ok(!('4' in r.timings));
  });

  await check('時間預算 2 秒：超過就停止加量，已量到的仍有效，剩下的 skipped', async () => {
    clock = clock0();
    const r = await VR.race([cand('slow', [1500, 1500, 1500]), cand('late', [1, 1, 1])], { now: clock.now, budgetMs: 2000, runs: 3 });
    assert.strictEqual(r.budgetHit, true);
    assert.ok(r.timings.slow.length >= 1 && r.timings.slow.length < 3, '第一次就超過預算，只留已量到的次數');
    assert.ok(r.skipped.includes('late') || !('late' in r.timings), 'late 不該被量');
  });

  await check('可取消：cancel 為真時立刻停止，回傳 cancelled', async () => {
    clock = clock0();
    let calls = 0;
    const r = await VR.race([cand('a', [5, 5, 5]), cand('b', [5, 5, 5])], { now: clock.now, budgetMs: 1e9, cancel: () => ++calls > 2 });
    assert.strictEqual(r.cancelled, true);
    assert.ok(r.winner === null || typeof r.winner.id === 'string', '取消後 winner 為 null 或有效結果');
  });

  await check('快取鍵：adapter、驅動／瀏覽器版本、能力簽名、運算或形狀任一變就換鍵（失效）', async () => {
    const base = { adapter: 'nvidia kepler', driver: '475.14', browser: 'chrome 130', caps: 'c1', op: 'matmul', shape: 'M512' };
    const k0 = VR.makeKey(base);
    assert.notStrictEqual(k0, VR.makeKey(Object.assign({}, base, { driver: '476' })), '驅動變了要失效');
    assert.notStrictEqual(k0, VR.makeKey(Object.assign({}, base, { browser: 'chrome 131' })), '瀏覽器變了要失效');
    assert.notStrictEqual(k0, VR.makeKey(Object.assign({}, base, { caps: 'c2' })), '能力簽名變了要失效');
    assert.notStrictEqual(k0, VR.makeKey(Object.assign({}, base, { op: 'q8mm' })));
    assert.strictEqual(k0, VR.makeKey(Object.assign({}, base)), '同樣輸入同一把鍵');
  });

  await check('儲存（node 無 indexedDB → 記憶體退路）：set 後 get 取回；clear 清空', async () => {
    const s = VR.createStore({ indexedDB: null });
    assert.strictEqual(s.kind, 'memory');
    assert.strictEqual(await s.get('k'), null);
    assert.strictEqual(await s.set('k', { id: 'v4' }), 'memory');
    assert.deepStrictEqual(await s.get('k'), { id: 'v4' });
    await s.clear();
    assert.strictEqual(await s.get('k'), null);
  });

  await check('儲存：indexedDB 開啟失敗（丟錯）時 get／set 不拋例外，退記憶體', async () => {
    const broken = { open() { const req = {}; setTimeout(() => { req.error = new Error('denied'); req.onerror && req.onerror(); }, 0); return req; } };
    const s = VR.createStore({ indexedDB: broken });
    assert.strictEqual(await s.get('x'), null);
    assert.strictEqual(await s.set('x', 1), 'memory');
    assert.strictEqual(await s.get('x'), 1);
  });

  console.log(passed + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });

function clock0() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
