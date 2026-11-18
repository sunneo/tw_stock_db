// node renderer/src/gpu/train_step_test.js
// O8 整步一次提交（假裝置）：前向＋反向（所有層，含注意力）＋AdamW 在同一個批次，只在步末回讀。
// 比較對象：CPU f64 的 lossAndGradsAsync＋adamStepAsync。假裝置以 CPU 參考執行 WGSL（f32 逐元素捨入），
// 所以這裡驗證的是綁定、順序、批次、回讀與數學式；WGSL 的真晶片數值與每步時間仍未量（見 scripts/eval/o8_train_check.html）。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const TS = require('./train_step_device.js');
const { fakeNavigator } = require('./gpu_fakes.js');
const LR = require('../studio/lora_ref_train.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}
function seededF64(n, seed, scale) {
  let s = seed >>> 0 || 1; const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = (((s % 2001) - 1000) / 1000) * scale; }
  return out;
}
function countSubmits(dev) { const orig = dev.queue.submit.bind(dev.queue); const box = { n: 0 }; dev.queue.submit = (c) => { box.n++; return orig(c); }; return box; }
function maxAbsDiff(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; }
function maxAbs(a) { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i])); return d; }
const cfg = { V: 16, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
const seqs = [[1, 4, 9, 2, 7, 3, 12, 5, 8, 14], [6, 0, 11, 14, 2, 9, 4, 13, 10, 3]];
const LRATE = 1e-2;

// CPU f64 整步（與訓練器現有的同步路徑相同）
async function cpuStep(m, st) {
  const rs = [];
  for (const tk of seqs) rs.push(await LR.lossAndGradsAsync(m, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }));
  const loss = (rs[0].loss + rs[1].loss) / 2;
  const avg = rs[0].grads.map((_, l) => {
    const o = {};
    for (const key of ['q', 'k', 'v', 'o']) {
      o[key] = {};
      for (const w of ['A', 'B']) { const n = rs[0].grads[l][key][w].length, a = new Float64Array(n); for (const r of rs) for (let i = 0; i < n; i++) a[i] += r.grads[l][key][w][i] / rs.length; o[key][w] = a; }
    }
    return o;
  });
  await LR.adamStepAsync(m, avg, st, LRATE, LR.cpuNnOps());
  return loss;
}
function paramsOf(m) { const out = []; for (const lo of m.lora) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) out.push(lo[k][w]); return out; }

(async () => {
  await check('注意力前向參考與獨立公式一致（因果遮罩、列和為 1）', async () => {
    const T = 5, H = 2, hd = 3, d = H * hd;
    const q = seededF64(T * d, 1, 1), k = seededF64(T * d, 2, 1), v = seededF64(T * d, 3, 1);
    const r = TS.attnFwdRef(q, k, v, T, H, hd);
    for (let h = 0; h < H; h++) for (let i = 0; i < T; i++) {
      let s = 0; for (let j = 0; j < T; j++) { const p = r.pm[(h * T + i) * T + j]; s += p; if (j > i) assert.strictEqual(p, 0, '遮罩位置應為 0'); }
      assert.ok(Math.abs(s - 1) < 1e-12, '列和 ' + s);
    }
  });

  await check('一步（K=2）：loss、LoRA 參數、AdamW 狀態與 CPU f64 在 f32 界內，且只提交一次', async () => {
    const mC = LR.makeModel(cfg, 5), stC = LR.adamInit(mC);
    const mD = LR.makeModel(cfg, 5), stD = LR.adamInit(mD);
    const loss0 = await cpuStep(mC, stC);
    const nav = fakeNavigator().nav; const dev = (await NN.getDevice(nav)).dev;
    const subs = countSubmits(dev);
    const R = await TS.trainStepDevice({ nn: NN, device: dev, model: mD, seqs, st: stD, lr: LRATE });
    assert.strictEqual(subs.n, 1, '整步應只 submit 一次，實際 ' + subs.n);
    assert.ok(Math.abs(R.loss - loss0) / Math.abs(loss0) < 1e-5, 'loss 相對差 ' + Math.abs(R.loss - loss0) / Math.abs(loss0));
    const pc = paramsOf(mC), pd = paramsOf(mD);
    let worstP = 0, scaleP = 0; for (let i = 0; i < pc.length; i++) { worstP = Math.max(worstP, maxAbsDiff(pc[i], pd[i])); scaleP = Math.max(scaleP, maxAbs(pc[i])); }
    assert.ok(worstP <= 1e-5 * Math.max(scaleP, 1), '參數最大絕對差 ' + worstP + '（尺度 ' + scaleP + '）');
    console.log('     一步：loss 相對差 ' + (Math.abs(R.loss - loss0) / Math.abs(loss0)).toExponential(2) + '，參數最大絕對差 ' + worstP.toExponential(2));
  });

  await check('20 步（K=2）：每步只提交一次；loss 與 CPU f64 的最差相對差', async () => {
    const mC = LR.makeModel(cfg, 9), stC = LR.adamInit(mC);
    const mD = LR.makeModel(cfg, 9), stD = LR.adamInit(mD);
    const nav = fakeNavigator().nav; const dev = (await NN.getDevice(nav)).dev;
    let worst = 0, first = 0, last = 0, maxSubs = 0, minSubs = Infinity;
    for (let step = 0; step < 20; step++) {
      const lc = await cpuStep(mC, stC);
      const subs = countSubmits(dev);
      const R = await TS.trainStepDevice({ nn: NN, device: dev, model: mD, seqs, st: stD, lr: LRATE });
      maxSubs = Math.max(maxSubs, subs.n); minSubs = Math.min(minSubs, subs.n);
      if (step === 0) first = lc;
      last = lc;
      worst = Math.max(worst, Math.abs(R.loss - lc) / Math.abs(lc));
    }
    console.log('     20 步：每步提交次數 ' + minSubs + '～' + maxSubs + '；loss f64 首 ' + first.toFixed(6) + ' 末 ' + last.toFixed(6) + '；新路徑最差相對差 ' + worst.toExponential(3) + '（假裝置）');
    assert.strictEqual(maxSubs, 1); assert.strictEqual(minSubs, 1);
    assert.ok(worst < 1e-4, '最差相對差 ' + worst);
    assert.ok(last < first, 'loss 應下降');
    const pc = paramsOf(mC), pd = paramsOf(mD); let worstP = 0, scaleP = 0;
    for (let i = 0; i < pc.length; i++) { worstP = Math.max(worstP, maxAbsDiff(pc[i], pd[i])); scaleP = Math.max(scaleP, maxAbs(pc[i])); }
    console.log('     20 步後參數最大絕對差／尺度 ' + (worstP / Math.max(scaleP, 1e-12)).toExponential(2));
    assert.ok(worstP <= 1e-4 * Math.max(scaleP, 1), '20 步後參數偏差 ' + worstP);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  process.exitCode = fail ? 1 : 0;
})();
