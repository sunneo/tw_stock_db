// node renderer/src/studio/backend_cudaweb_test.js
// cudaweb 後端：probe 依真實能力回報、訓練方法走非同步變體、存讀檔往返。
'use strict';
const assert = require('assert');
const { createCudawebBackend } = require('./backend_cudaweb.js');
const core = require('../gpu/gpu_core.js');
const { fakeNavigator } = require('../gpu/gpu_fakes.js');

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); pass++; console.log('ok   ' + name); }
    catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
const cfg = { V: 11, d: 8, L: 1, H: 2, F: 12, r: 2, alpha: 4 };
const toks = [1, 4, 7, 2, 9, 3];

(async () => {
    await check('沒有執行期（主行程）：probe 不可用，原因寫明', async () => {
        const b = createCudawebBackend({});
        const p = await b.probe({});
        assert.strictEqual(p.available, false);
        assert.ok(p.reason.includes('沒有 GPU 運算核心'));
    });

    await check('有 WebGPU 執行期：probe 依真實能力回報可用，並寫明實際層', async () => {
        const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
        const b = createCudawebBackend({ getRuntime: () => rt });
        const p = await b.probe({});
        assert.strictEqual(p.available, true);
        assert.ok(p.reason.includes('WebGPU（T1）'), p.reason);
        assert.ok(p.reason.includes('矩陣乘'));
    });

    await check('沒有 WebGPU、也沒有 WebGL2：probe 不可用，原因來自執行期', async () => {
        const rt = core.createRuntime({ navigator: {}, webgl2: null });
        const b = createCudawebBackend({ getRuntime: () => rt });
        const p = await b.probe({});
        assert.strictEqual(p.available, false);
        assert.ok(p.reason.includes('沒有可用的 WebGPU 裝置'), p.reason);
    });

    await check('未 init 就 step：明確報錯，不默默算', async () => {
        const b = createCudawebBackend({});
        await assert.rejects(b.step(toks), /尚未 init/);
    });

    await check('沒有執行期時 init 報錯並說明', async () => {
        const b = createCudawebBackend({});
        await assert.rejects(b.init({ cfg, seed: 1, lr: 0.01 }), /沒有 GPU 運算執行期/);
    });

    await check('init → step → 存讀檔往返：損失下降，讀回後 evalLoss 與存檔時相同', async () => {
        const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
        const b = createCudawebBackend({ getRuntime: () => rt });
        await b.init({ cfg, seed: 3, lr: 0.05 });
        const l0 = (await b.evalLoss(toks)).loss;
        for (let i = 0; i < 3; i++) await b.step(toks);
        const l3 = (await b.evalLoss(toks)).loss;
        assert.ok(l3 < l0, '損失應下降 ' + l0 + ' → ' + l3);
        const ck = await b.saveCheckpoint();
        const before = (await b.evalLoss(toks)).loss;
        await b.step(toks);                       // 改動一步
        await b.loadCheckpoint(ck);               // 讀回存檔
        const after = (await b.evalLoss(toks)).loss;
        assert.strictEqual(after, before);
    });

    await check('step 回報實際層：矩陣乘（T1）與五個核心（opsLayer，T1）都走 GPU', async () => {
        const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
        const b = createCudawebBackend({ getRuntime: () => rt, navigator: fakeNavigator().nav });
        await b.init({ cfg, seed: 4, lr: 0.01 });
        const r = await b.step(toks);
        assert.strictEqual(r.layer, 'T1');
        assert.strictEqual(r.opsLayer, 'T1');
        assert.ok(r.opsCalls > 0);
    });

    await check('沒有 GPU 導航器時：矩陣乘仍可走執行期，五個核心退到 cpu-js 並寫明原因', async () => {
        const rt = core.createRuntime({ navigator: {}, webgl2: null });
        const b = createCudawebBackend({ getRuntime: () => rt, navigator: {} });
        await b.init({ cfg, seed: 4, lr: 0.01 });
        const r = await b.step(toks);
        assert.strictEqual(r.opsLayer, 'cpu-js');
        assert.ok(r.opsReason.includes('WebGPU 不可用'), r.opsReason);
    });

    console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
    if (fail) process.exit(1);
})();
