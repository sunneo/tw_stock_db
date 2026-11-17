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

  await check('requestExclusiveGpu：排隊中可取消（reject，不佔鎖），之後的請求照常取得', async () => {
    const hold = await NN.requestExclusiveGpu('持有');
    const ac = new AbortController();
    const waiting = NN.requestExclusiveGpu('排隊', { signal: ac.signal });
    assert.strictEqual(NN.measureLockState().pending, 1);
    ac.abort();
    await assert.rejects(waiting, (e) => e.name === 'AbortError');
    assert.strictEqual(NN.measureLockState().pending, 0);
    hold();
    const next = await NN.requestExclusiveGpu('之後');
    next();
    assert.strictEqual(NN.measureLockState().running, false);
  });

  await check('閒置持有者：授予前依註冊順序呼叫 release（A、B），之後才授予；測完不恢復', async () => {
    const order = [];
    const uA = NN.registerIdleGpuHolder('A', () => { order.push('A'); });
    const uB = NN.registerIdleGpuHolder('B', async () => { await sleep(5); order.push('B'); });
    const rel = await NN.requestExclusiveGpu('測');
    order.push('granted');
    rel();
    uA(); uB();
    assert.deepStrictEqual(order, ['A', 'B', 'granted']);
    assert.strictEqual(rel.failures.length, 0);
  });

  await check('閒置持有者釋放失敗：仍然授予，失敗記在 release.failures，後面的持有者照常釋放', async () => {
    const order = [];
    const uC = NN.registerIdleGpuHolder('C', () => { throw new Error('引擎卡住'); });
    const uD = NN.registerIdleGpuHolder('D', () => { order.push('D'); });
    const rel = await NN.requestExclusiveGpu('測');
    rel();
    uC(); uD();
    assert.deepStrictEqual(order, ['D']);
    assert.strictEqual(rel.failures.length, 1);
    assert.strictEqual(rel.failures[0].name, 'C');
    assert.ok(/引擎卡住/.test(rel.failures[0].error), rel.failures[0].error);
  });

  await check('release 重複呼叫只釋放一次：不會提早授予下一個請求', async () => {
    const r2 = await NN.requestExclusiveGpu('a');
    let granted3 = false;
    const p3 = NN.requestExclusiveGpu('b').then((r) => { granted3 = true; return r; });
    await sleep(10);
    assert.strictEqual(granted3, false);
    r2(); r2();
    const r3 = await p3;
    assert.strictEqual(granted3, true);
    r3();
  });

  console.log('measure_lock_test: ' + passes + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
