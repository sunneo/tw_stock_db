'use strict';
// gpu_async_queue 測試：用假裝置（execute 由測試控制何時完成），驗證保序、同 stream 串行、不同 stream 重疊、
// 延遲錯誤、sticky 錯誤與 reset、句柄查詢、事件、上限。
const assert = require('assert');
const { createGpuQueue, QueueFullError } = require('./gpu_async_queue.js');

// 可控的假裝置：每筆操作的完成時機由測試決定
function fakeDevice() {
  const log = [];
  const waiting = [];
  let active = 0, maxActive = 0;
  const execute = (op, args) => new Promise((resolve, reject) => {
    active++; maxActive = Math.max(maxActive, active);
    log.push('start:' + op);
    waiting.push({ op, args, finish: (ok, v) => {
      active--; log.push((ok ? 'ok:' : 'fail:') + op);
      ok ? resolve(v) : reject(new Error('裝置錯誤:' + op));
    } });
  });
  return { execute, log, waiting, maxActive: () => maxActive, active: () => active };
}
// 讓微任務佇列跑完
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // 1. submit 立刻回傳句柄，不等裝置
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    const h = q.submit('matmul', {}, 0);
    assert.strictEqual(typeof h.id, 'number');
    assert.strictEqual(q.query(h), 'pending');
    assert.deepStrictEqual(d.log, [], '提交後裝置還沒開始（延後到上一筆完成）或已開始，但 submit 本身不等');
    await flush();
    assert.deepStrictEqual(d.log, ['start:matmul']);
    d.waiting[0].finish(true, 42);
    assert.strictEqual(await q.wait(h), 42);
    assert.strictEqual(q.query(h), 'done');
    console.log('ok 1 submit 立刻回傳、wait 取結果');
  }

  // 2. 同一個 stream 保序：第二筆要等第一筆完成才開始
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    const h1 = q.submit('a', {}, 0), h2 = q.submit('b', {}, 0);
    await flush();
    assert.deepStrictEqual(d.log, ['start:a'], '同 stream 第二筆不能提前開始');
    d.waiting[0].finish(true, 1);
    await flush();
    assert.deepStrictEqual(d.log, ['start:a', 'ok:a', 'start:b']);
    d.waiting[1].finish(true, 2);
    assert.strictEqual(await q.wait(h1), 1);
    assert.strictEqual(await q.wait(h2), 2);
    console.log('ok 2 同 stream 保序');
  }

  // 3. 不同 stream 重疊：兩個 stream 同時在裝置上執行
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    q.submit('gpuA', {}, 1);
    q.submit('gpuB', {}, 2);
    await flush();
    assert.strictEqual(d.active(), 2, '兩個 stream 應同時在執行');
    assert.strictEqual(d.maxActive(), 2);
    d.waiting[1].finish(true, 0); d.waiting[0].finish(true, 0);
    await q.synchronize();
    console.log('ok 3 不同 stream 重疊');
  }

  // 4. 錯誤延遲：submit 不丟；wait 才丟；synchronize 也丟
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    const h = q.submit('bad', {}, 0);
    await flush();
    d.waiting[0].finish(false);
    await flush(); // 狀態在微任務裡更新
    assert.strictEqual(q.query(h), 'error');
    await assert.rejects(() => q.wait(h), /裝置錯誤:bad/);
    await assert.rejects(() => q.synchronize(0), /裝置錯誤:bad/, 'sticky：同步點仍要丟出');
    console.log('ok 4 延遲錯誤');
  }

  // 5. sticky：同 stream 出錯後，之後的操作不執行、直接以同一錯誤失敗；其他 stream 不受影響；reset 後恢復
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    const h1 = q.submit('bad', {}, 0);
    const h2 = q.submit('after', {}, 0);
    const hOther = q.submit('other', {}, 9);
    await flush();
    d.waiting.find((w) => w.op === 'bad').finish(false);
    await flush();
    assert.ok(!d.log.includes('start:after'), '出錯後同 stream 的下一筆不應執行');
    await assert.rejects(() => q.wait(h2), /裝置錯誤:bad/);
    d.waiting.find((w) => w.op === 'other').finish(true, 'x');
    assert.strictEqual(await q.wait(hOther), 'x', '其他 stream 不受影響');
    await assert.rejects(() => q.wait(h1));
    q.reset(0);
    const h3 = q.submit('again', {}, 0);
    await flush();
    d.waiting.find((w) => w.op === 'again').finish(true, 7);
    assert.strictEqual(await q.wait(h3), 7);
    console.log('ok 5 sticky 錯誤與 reset');
  }

  // 6. 事件：只等記錄當下已提交的操作，不等之後的
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute, now: (() => { let t = 0; return () => (t += 10); })() });
    q.submit('k1', {}, 0);
    const e1 = q.record(0);
    q.submit('k2', {}, 0);
    const e2 = q.record(0);
    assert.strictEqual(q.eventQuery(e1), false);
    await flush();
    d.waiting[0].finish(true);
    await q.eventSynchronize(e1);
    assert.strictEqual(q.eventQuery(e1), true);
    assert.strictEqual(q.eventQuery(e2), false, 'e2 記錄在 k2 之後，k2 還沒完成');
    await flush();
    d.waiting[1].finish(true);
    await q.eventSynchronize(e2);
    assert.ok(q.eventElapsed(e1, e2) > 0, '兩事件都完成後應有正的牆鐘差');
    assert.ok(Number.isNaN(q.eventElapsed(e1, q.record(3))), '未完成的事件回傳 NaN');
    console.log('ok 6 事件');
  }

  // 7. 上限：未完成數達上限時 submit 丟 QueueFullError；完成後可再提交
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute, maxPending: 2 });
    const h1 = q.submit('a', {}, 0);
    q.submit('b', {}, 1);
    assert.throws(() => q.submit('c', {}, 2), QueueFullError);
    await flush();
    d.waiting[0].finish(true, 1);
    await q.wait(h1);
    await flush();
    d.waiting[1].finish(true, 2);
    await q.synchronize();
    assert.doesNotThrow(() => q.submit('c', {}, 2));
    console.log('ok 7 上限');
  }

  // 8. forget：未完成不能 forget；完成後 forget 後句柄失效
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    const h = q.submit('x', {}, 0);
    assert.throws(() => q.forget(h), /尚未完成/);
    await flush();
    d.waiting[0].finish(true, 5);
    await q.wait(h);
    q.forget(h);
    assert.throws(() => q.query(h), /未知的 GPU 句柄/);
    console.log('ok 8 forget');
  }

  // 9. 同步點只等指定 stream
  {
    const d = fakeDevice();
    const q = createGpuQueue({ execute: d.execute });
    q.submit('s1', {}, 1);
    q.submit('s2', {}, 2);
    await flush();
    d.waiting.find((w) => w.op === 's1').finish(true);
    await q.synchronize(1); // 只等 stream 1，不能因 stream 2 還沒完成而卡住
    d.waiting.find((w) => w.op === 's2').finish(true);
    await q.synchronize(2);
    console.log('ok 9 synchronize 指定 stream');
  }

  console.log('gpu_async_queue：全部通過');
})().catch((e) => { console.error('失敗：', e && e.stack || e); process.exit(1); });
