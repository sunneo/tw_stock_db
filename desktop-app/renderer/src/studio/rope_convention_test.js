// node renderer/src/studio/rope_convention_test.js
// RoPE 慣例防護：三處的版本字串一致（nn_ops、lora_ref_train、backend_cudaweb）；存出的 LoRA 檢查點帶 rope 標記；
// 舊版（沒有標記＝交錯成對）與不同慣例的檢查點一律拒絕載入，並給出要重訓的原因；rotate-half 的 JS 參考與 llm_scratch 式公式逐元素一致。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NN = require('../gpu/nn_ops.js');
const LR = require('./lora_ref_train.js');
const { createCudawebBackend } = require('./backend_cudaweb.js');
const { fakeNavigator } = require('../gpu/gpu_fakes.js');
const core = require('../gpu/gpu_core.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}

const TAG = 'rotate-half-v1';
const cfg = { V: 16, d: 8, L: 1, H: 2, F: 12, r: 2, alpha: 4 };

(async () => {
  await check('三處的慣例版本字串一致（nn_ops、lora_ref_train、backend_cudaweb）', () => {
    const bcSrc = fs.readFileSync(path.join(__dirname, 'backend_cudaweb.js'), 'utf8');
    assert.strictEqual(NN.ROPE_CONVENTION, TAG);
    assert.strictEqual(LR.ROPE_CONVENTION, TAG);
    assert.ok(bcSrc.includes("const ROPE_CONVENTION = '" + TAG + "'"), 'backend_cudaweb.js 的版本常數不一致');
  });

  await check('rotate-half 參考版與 llm_scratch 式公式（cos/sin 表＝cat(fr,fr)，rot_half＝cat(−x[h:], x[:h])）逐元素一致（正向與反向）', () => {
    for (const [T, H, hd] of [[4, 2, 8], [6, 4, 16], [3, 1, 8]]) for (const dir of [1, -1]) {
      const half = hd / 2, x = Float64Array.from({ length: T * H * hd }, (_, i) => Math.sin(i * 1.7) + 0.3);
      const y = NN.ropeRef(x, T, H, hd, dir);
      for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) {
        const o = (t * H + h) * hd;
        const fr = []; for (let i = 0; i < half; i++) fr.push(t * Math.pow(10000, -2 * i / hd));
        const emb = fr.concat(fr);
        const rot = []; for (let j = 0; j < hd; j++) rot.push(j < half ? -x[o + j + half] : x[o + j - half]);
        for (let j = 0; j < hd; j++) {
          const want = x[o + j] * Math.cos(emb[j]) + rot[j] * (dir * Math.sin(emb[j]));
          assert.ok(Math.abs(y[o + j] - want) < 1e-12, 'T=' + T + ' H=' + H + ' hd=' + hd + ' dir=' + dir + ' 位置 ' + (o + j) + ' 差 ' + Math.abs(y[o + j] - want));
        }
      }
    }
  });

  await check('存出的 LoRA 檢查點帶 rope 標記', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const b = createCudawebBackend({ getRuntime: () => rt });
    await b.init({ cfg, seed: 3, lr: 0.01 });
    const ck = await b.saveCheckpoint();
    assert.strictEqual(ck.rope, TAG);
  });

  await check('舊版（沒有 rope 標記＝交錯成對）的檢查點被拒絕，原因說明要重訓', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const b = createCudawebBackend({ getRuntime: () => rt });
    await b.init({ cfg, seed: 3, lr: 0.01 });
    const ck = await b.saveCheckpoint();
    const legacy = Object.assign({}, ck); delete legacy.rope;
    await assert.rejects(() => b.loadCheckpoint(legacy), (e) => /未標記（舊版交錯成對）/.test(e.message) && /重新訓練/.test(e.message));
  });

  await check('其他慣例版本的檢查點被拒絕（不得悄悄套用）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const b = createCudawebBackend({ getRuntime: () => rt });
    await b.init({ cfg, seed: 3, lr: 0.01 });
    const ck = await b.saveCheckpoint();
    await assert.rejects(() => b.loadCheckpoint(Object.assign({}, ck, { rope: 'interleaved-v0' })), (e) => /interleaved-v0/.test(e.message) && /需要「rotate-half-v1」/.test(e.message));
  });

  await check('目前版本的檢查點可以載入（往返）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const b = createCudawebBackend({ getRuntime: () => rt });
    await b.init({ cfg, seed: 3, lr: 0.01 });
    const ck = await b.saveCheckpoint();
    await b.loadCheckpoint(ck);
  });

  console.log(fail ? fail + ' 項失敗，' + pass + ' 項通過' : pass + ' 通過，0 失敗');
  process.exit(fail ? 1 : 0);
})();
