'use strict';
// GPU 量測互斥鎖（nn_ops.withMeasureLock）：前景排隊不重疊、背景在有量測時跳過、fn 丟錯也會釋放鎖。純 node，不碰 GPU。
const assert = require('assert');
const NN = require('./nn_ops.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('ok   ' + name); }

(async () => {
  await check('前景量測排隊：第二個等第一個結束才開始（不重疊）', async () => {
    const log = [];
    const a = NN.withMeasureLock(async () => { log.push('a-start'); await sleep(40); log.push('a-end'); return 'A'; });
    const b = NN.withMeasureLock(async () => { log.push('b-start'); await sleep(5); log.push('b-end'); return 'B'; });
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepStrictEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
    assert.strictEqual(ra, 'A'); assert.strictEqual(rb, 'B');
  });

  await check('背景量測：有量測在跑時跳過（回傳 skipped），不排隊、不執行', async () => {
    let ranBg = false;
    const fg = NN.withMeasureLock(async () => { await sleep(30); return 'fg'; });
    const bg = await NN.withMeasureLock(async () => { ranBg = true; return 'bg'; }, { background: true });
    assert.strictEqual(bg.skipped, true);
    assert.strictEqual(ranBg, false);
    assert.strictEqual(await fg, 'fg');
  });

  await check('背景量測：有前景在排隊（尚未開始）也跳過', async () => {
    const fg1 = NN.withMeasureLock(async () => { await sleep(20); });
    const fg2 = NN.withMeasureLock(async () => { await sleep(5); });   // 排隊中
    const bg = await NN.withMeasureLock(async () => 'bg', { background: true });
    assert.strictEqual(bg.skipped, true);
    await Promise.all([fg1, fg2]);
  });

  await check('背景量測：沒有量測時照常執行', async () => {
    const r = await NN.withMeasureLock(async () => 'bg-ok', { background: true });
    assert.strictEqual(r, 'bg-ok');
  });

  await check('fn 丟錯：呼叫端收到錯誤，鎖被釋放，之後的量測照常進行', async () => {
    const bad = NN.withMeasureLock(async () => { await sleep(5); throw new Error('裝置遺失'); });
    await assert.rejects(bad, /裝置遺失/);
    const st = NN.measureLockState();
    assert.strictEqual(st.running, false); assert.strictEqual(st.pending, 0);
    assert.strictEqual(await NN.withMeasureLock(async () => 'after'), 'after');
  });

  await check('狀態：執行中 running、排隊中 pending，結束後歸零', async () => {
    const p = NN.withMeasureLock(async () => { await sleep(20); });
    const q = NN.withMeasureLock(async () => { await sleep(1); });
    await sleep(5);   // 讓鏈上的第一個工作開始（running 在它開始時才設為真）
    const mid = NN.measureLockState();
    assert.strictEqual(mid.running, true); assert.strictEqual(mid.pending, 1);
    await Promise.all([p, q]);
    const end = NN.measureLockState();
    assert.strictEqual(end.running, false); assert.strictEqual(end.pending, 0);
  });

  console.log('measure_lock_test: ' + passes + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
