'use strict';
// node renderer/src/gpu/full_param_readloss_test.js
// P1c-2 讀回按需：readLoss=false 的步只提交、不讀回，但參數與動量必須與每步讀回的路徑逐位元相同。
// 假裝置（gpu_fakes）：WGSL 由 CPU 參考執行。
const assert = require('assert');
const NN = require('./nn_ops.js');
const FS = require('./full_param_step_device.js');
const LD = require('../studio/llm_full_data.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}

const cfg = { V: 16, d: 8, L: 1, H: 2, kvH: 2, F: 12, T: 6, qkNorm: true };
const seqs = [[1, 4, 7, 2, 9, 3, 5]];

async function runSteps(readLoss, steps) {
  const dev = (await NN.getDevice(fakeNavigator({}).nav)).dev;
  const init = LD.makeInit(cfg, 1);
  const state = FS.makeResidentState(dev, cfg, init);
  let last = null;
  for (let s = 0; s < steps; s++) last = await FS.fullParamStepDevice({ nn: NN, device: dev, state, seqs, lr: 0.01, wd: 0, clip: 1.0, readLoss });
  const snap = await FS.readResident(dev, state);
  return { snap, last };
}

(async () => {
  await check('readLoss=false：不回傳損失與梯度範數（回傳 null），不讀回', async () => {
    const r = await runSteps(false, 1);
    assert.strictEqual(r.last.loss, null);
    assert.strictEqual(r.last.gradNorm, null);
  });

  await check('每步讀回 vs 只在最後讀回：3 步後參數與動量逐位元相同', async () => {
    const A = await runSteps(true, 3);
    const B = await runSteps(false, 3);
    assert.strictEqual(A.snap.t, B.snap.t);
    for (const k of Object.keys(A.snap.P)) {
      for (const part of ['P', 'M', 'V']) {
        assert.deepStrictEqual(Array.from(B.snap[part][k]), Array.from(A.snap[part][k]), part + '.' + k + ' 不同');
      }
    }
  });

  await check('讀回的步仍然回傳有限的損失與梯度範數（正常路徑沒被破壞）', async () => {
    const r = await runSteps(true, 2);
    assert.ok(Number.isFinite(r.last.loss) && r.last.loss > 0);
    assert.ok(Number.isFinite(r.last.gradNorm) && r.last.gradNorm > 0);
  });

  console.log(fail ? fail + ' 項失敗，' + pass + ' 項通過' : '全部通過（' + pass + ' 項）');
  process.exit(fail ? 1 : 0);
})();
