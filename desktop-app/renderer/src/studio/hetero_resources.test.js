'use strict';
// 資源模型測試（hetero_resources.js）。用法：node renderer/src/studio/hetero_resources.test.js
const R = require('./hetero_resources.js');

let ok = 0, bad = 0;
const check = (name, c, d) => { if (c) { ok++; console.log('ok   ' + name); } else { bad++; console.log('FAIL ' + name + (d === undefined ? '' : ' ' + JSON.stringify(d))); } };
const fakeImpl = () => ({ gradient: async () => ({ loss: 0, n: 0, grads: {}, ms: 1 }) });

// 1. 資源清單：加入、重複 id、類型、在線狀態
{
  const set = R.createResourceSet();
  set.add({ id: 'cpu0', kind: 'cpu-py', rate: 2, impl: fakeImpl() });
  set.add({ id: 'gpu0', kind: 'cudaweb', rate: 6, impl: fakeImpl() });
  check('加入兩個資源後 alive 有 2 個', set.alive().length === 2);
  let dup = false; try { set.add({ id: 'cpu0', kind: 'cpu-py', impl: fakeImpl() }); } catch (e) { dup = true; }
  check('重複 id 會丟錯', dup);
  let badKind = false; try { set.add({ id: 'x', kind: 'tpu', impl: fakeImpl() }); } catch (e) { badKind = true; }
  check('未知類型會丟錯', badKind);
  let noImpl = false; try { set.add({ id: 'y', kind: 'remote' }); } catch (e) { noImpl = true; }
  check('缺 impl.gradient 會丟錯', noImpl);
  let badRate = false; try { set.add({ id: 'z', kind: 'remote', rate: -1, impl: fakeImpl() }); } catch (e) { badRate = true; }
  check('速率為負會丟錯', badRate);
  set.markOffline('gpu0', 'device lost');
  check('離線後 alive 只剩 cpu0', set.alive().map((e) => e.id).join() === 'cpu0');
  const snap = set.snapshot();
  check('snapshot 不含 impl 且保留離線原因', snap.length === 2 && snap[1].online === false && snap[1].reason === 'device lost' && !('impl' in snap[0]), snap);
  set.markOnline('gpu0');
  check('重新上線後 alive 又有 2 個', set.alive().length === 2);
  check('remove 回傳 true 且清單少一筆', set.remove('cpu0') === true && set.snapshot().length === 1);
  check('remove 不存在的 id 回傳 false', set.remove('nope') === false);
}

// 2. splitCounts：總和恆等於 n、比例、至少一筆
{
  const sum = (a) => a.reduce((s, x) => s + x.count, 0);
  const r1 = R.splitCounts(10, [{ id: 'a', share: 0.5 }, { id: 'b', share: 0.5 }]);
  check('10 筆 1:1 → 5/5', r1[0].count === 5 && r1[1].count === 5, r1);
  const r2 = R.splitCounts(7, [{ id: 'a', share: 0.25 }, { id: 'b', share: 0.75 }]);
  check('7 筆 1:3 → 總和 7', sum(r2) === 7, r2);
  const r3 = R.splitCounts(100, [{ id: 'a', share: 1 / 3 }, { id: 'b', share: 1 / 3 }, { id: 'c', share: 1 / 3 }]);
  check('100 筆三等分 → 總和 100、各 33 或 34', sum(r3) === 100 && r3.every((x) => x.count >= 33 && x.count <= 34), r3);
  const r4 = R.splitCounts(3, [{ id: 'a', share: 0.01 }, { id: 'b', share: 0.99 }]);
  check('份額極小的資源至少分到 1 筆（n ≥ 資源數）', r4[0].count === 1 && sum(r4) === 3, r4);
  const r5 = R.splitCounts(5, [{ id: 'a', share: 1 }, { id: 'b', share: 0 }]);
  check('份額為 0 的資源分到 0 筆', r5[0].count === 5 && r5[1].count === 0, r5);
  const r6 = R.splitCounts(0, [{ id: 'a', share: 1 }]);
  check('n=0 → 全部 0', r6[0].count === 0);
  let neg = false; try { R.splitCounts(1.5, [{ id: 'a', share: 1 }]); } catch (e) { neg = true; }
  check('非整數樣本數會丟錯', neg);
  // 任意比例下總和恆等於 n
  let allSum = true;
  for (let n = 1; n <= 40; n++) for (const f of [0.1, 0.33, 0.5, 0.71, 0.9]) {
    if (sum(R.splitCounts(n, [{ id: 'a', share: f }, { id: 'b', share: 1 - f }])) !== n) allSum = false;
  }
  check('40 種樣本數 × 5 種比例：總和恆等於 n', allSum);
}

// 3. 份額來源：速率比例、能力檔比例、缺值
{
  const s = R.sharesFromRates([{ id: 'a', rate: 1 }, { id: 'b', rate: 3 }]);
  check('速率 1:3 → 份額 0.25/0.75', Math.abs(s[0].share - 0.25) < 1e-12 && Math.abs(s[1].share - 0.75) < 1e-12, s);
  check('任一筆沒有速率 → null', R.sharesFromRates([{ id: 'a', rate: 1 }, { id: 'b', rate: null }]) === null);
  const n = R.normalizeShares([{ id: 'a', share: 2 }, { id: 'b', share: 2 }]);
  check('normalizeShares 總和為 1', Math.abs(n[0].share + n[1].share - 1) < 1e-12);
  const z = R.normalizeShares([{ id: 'a', share: 0 }, { id: 'b', share: 0 }]);
  check('全為 0 時等分', Math.abs(z[0].share - 0.5) < 1e-12);
  const prof = { cpu: { best: { n: 4, gflops: 8 } }, gpu: { matmulGflops: 120 } };
  const pr = R.profileRatios(prof);
  check('profileRatios 取 cpu.best.gflops 與 gpu.matmulGflops', pr.cpu === 8 && pr.cudaweb === 120, pr);
  const pn = R.profileRatios({ cpu: { best: null }, gpu: null });
  check('能力檔缺值 → null（不推估）', pn.cpu === null && pn.cudaweb === null, pn);
}

console.log('\n' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
