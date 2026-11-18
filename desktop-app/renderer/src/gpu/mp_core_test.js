'use strict';
// mp_core 測試（node，不需要 Worker）：工作者上限與低階降級、建立失敗的退回、依序分派與結果順序、
// 同時執行數不超過上限、錯誤後不再開始新任務、取消、取消前已取消、空輸入。
const assert = require('assert');
const { mpWorkerCap, afterCreateFailure, runMap } = require('./mp_core.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 工作者上限
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 8 }), 8, '8 核心 → 8');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 4 }), 4, '4 核心 → 4');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 2 }), 2, '2 核心 → 2（低階）');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 1 }), 2, '1 核心 → 2（原公式下限）');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 8, deviceMemory: 2 }), 1, '記憶體 2 GB → 1（記憶體吃緊）');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 8, deviceMemory: 4 }), 8, '記憶體 4 GB 不降級');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 8, maxWorkers: 3 }), 3, 'maxWorkers 限制');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 8, maxWorkers: 0 }), 8, 'maxWorkers ≤ 0 視為未設定');
  assert.strictEqual(mpWorkerCap({ hardwareConcurrency: 64 }), 8, '核心再多也最多 8');
  assert.strictEqual(mpWorkerCap({}), 4, '沒有資訊時預設 4');
  console.log('ok 1 工作者上限與低階降級');

  // 2. 建立失敗的退回
  assert.deepStrictEqual([afterCreateFailure(3).action, afterCreateFailure(3).cap], ['wait', 3], '已有 3 個 → 改等，上限降為 3');
  assert.deepStrictEqual([afterCreateFailure(0).action, afterCreateFailure(0).cap], ['throw', 1], '一個都沒有 → 丟錯');
  assert.strictEqual(typeof afterCreateFailure(2).reason, 'string', '要附說明');
  console.log('ok 2 建立失敗退回');

  // 3. 依序分派：結果順序與輸入相同（即使完成順序打亂）
  {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = await runMap({ items, concurrency: 3, runTask: async (x) => { await delay((9 - x) % 4); return x * 2; } });
    assert.deepStrictEqual(out, items.map((x) => x * 2));
    console.log('ok 3 結果順序與輸入相同');
  }

  // 4. 同時執行數不超過上限，且真的達到上限
  {
    let active = 0, maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await runMap({ items, concurrency: 3, runTask: async () => { active++; maxActive = Math.max(maxActive, active); await delay(3); active--; } });
    assert.strictEqual(maxActive, 3, '應達到上限 3，且不超過');
    console.log('ok 4 同時執行數不超過上限');
  }

  // 5. 錯誤：第一個錯誤丟出；錯誤之後不再開始新任務；在飛中的任務會結束
  {
    let errorSeen = false, startedAfterError = 0, activeAtReject = -1, active = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await assert.rejects(runMap({ items, concurrency: 2, runTask: async (x) => {
      if (errorSeen) startedAfterError++;
      active++;
      try {
        await delay(2);
        if (x === 3) { errorSeen = true; throw new Error('第 3 筆壞掉'); }
        return x;
      } finally { active--; }
    } }), /第 3 筆壞掉/);
    activeAtReject = active;
    assert.strictEqual(startedAfterError, 0, '錯誤之後不應再開始新任務');
    assert.strictEqual(activeAtReject, 0, '丟出錯誤時在飛中的任務應已結束');
    console.log('ok 5 錯誤傳回、不再開始新任務、在飛中的結束');
  }

  // 6. 取消：中途取消後不再開始新任務，丟 AbortError
  {
    const ac = new AbortController();
    let started = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await assert.rejects(runMap({ items, concurrency: 2, signal: ac.signal, runTask: async (x) => {
      started++;
      if (started === 2) ac.abort();
      await delay(2);
      return x;
    } }), (e) => e.name === 'AbortError');
    assert.ok(started < 20, '取消後應停止分派（實際開始 ' + started + ' 筆）');
    console.log('ok 6 中途取消');
  }

  // 7. 取消前就已取消：不執行任何任務
  {
    const ac = new AbortController(); ac.abort();
    let calls = 0;
    await assert.rejects(runMap({ items: [1, 2, 3], concurrency: 2, signal: ac.signal, runTask: async () => { calls++; } }), (e) => e.name === 'AbortError');
    assert.strictEqual(calls, 0, '已取消時不應呼叫 runTask');
    console.log('ok 7 取消前已取消');
  }

  // 8. 上限退回：concurrency 大於任務數、或 concurrency 為 1 時仍依序正確
  {
    const seq = [];
    const out = await runMap({ items: ['a', 'b', 'c'], concurrency: 1, runTask: async (x) => { seq.push(x); await delay(1); return x + '!'; } });
    assert.deepStrictEqual(seq, ['a', 'b', 'c'], 'concurrency 1 應依序');
    assert.deepStrictEqual(out, ['a!', 'b!', 'c!']);
    const many = await runMap({ items: [1], concurrency: 8, runTask: async (x) => x });
    assert.deepStrictEqual(many, [1], 'concurrency 大於任務數');
    console.log('ok 8 上限為 1 與大於任務數');
  }

  // 9. 空輸入與缺少 runTask
  assert.deepStrictEqual(await runMap({ items: [], concurrency: 4, runTask: async () => 1 }), []);
  await assert.rejects(runMap({ items: [1] }), TypeError);
  console.log('ok 9 空輸入與參數檢查');

  console.log('mp_core：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
