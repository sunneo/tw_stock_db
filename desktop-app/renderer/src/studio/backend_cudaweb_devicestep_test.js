// node renderer/src/studio/backend_cudaweb_devicestep_test.js
// 產品訓練器的整步一次提交路徑（O8）：預設關、開啟時與舊路徑同結果、失敗永久退回舊路徑、沒有裝置就退回、f16 能力分支。
// 假裝置：WGSL 由 CPU 參考執行。真 Chrome 未跑（見 scripts/eval/o8_train_check.html）。
'use strict';
const assert = require('assert');
const { createCudawebBackend } = require('./backend_cudaweb.js');
const NN = require('../gpu/nn_ops.js');
const MM = require('../gpu/mm_ops.js');
const RT = require('../gpu/cudaweb_runtime.js');
const { fakeNavigator } = require('../gpu/gpu_fakes.js');

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); pass++; console.log('ok   ' + name); }
    catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}
const cfg = { V: 11, d: 8, L: 1, H: 2, F: 12, r: 2, alpha: 4 };
const toks = [1, 4, 7, 2, 9, 3];

function make(o) {
    const nav = fakeNavigator(o.fake || {}).nav;
    const rt = RT.createRuntime({ nn: NN, mm: MM, navigator: nav });
    const be = createCudawebBackend({ getRuntime: () => rt, navigator: nav, deviceStep: o.deviceStep, f16Forward: o.f16Forward });
    return { be, nav };
}
const params = (be) => {
    // 取得模型參數（用 saveCheckpoint 的純資料，避免碰內部）
    return be.saveCheckpoint().then((ck) => ck.lora[0]);
};
function maxAbsDiffLora(a, b) {
    let d = 0;
    for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) for (let i = 0; i < a[k][w].length; i++) d = Math.max(d, Math.abs(a[k][w][i] - b[k][w][i]));
    return d;
}

(async () => {
    await check('預設關：不會進整步路徑，行為與舊版相同（兩次獨立執行結果一致）', async () => {
        const A = make({}), Bk = make({});
        await A.be.init({ cfg, seed: 3, lr: 0.01 }); await Bk.be.init({ cfg, seed: 3, lr: 0.01 });
        const sa = A.be.deviceStepStatus();
        assert.strictEqual(sa.want, false); assert.strictEqual(sa.active, false);
        const ra = await A.be.step(toks), rb = await Bk.be.step(toks);
        assert.strictEqual(ra.path, undefined, '預設不應標示整步路徑');
        assert.strictEqual(A.be.deviceStepStatus().used, 0);
        assert.strictEqual(ra.loss, rb.loss);
        assert.strictEqual(maxAbsDiffLora(await params(A.be), await params(Bk.be)), 0);
    });

    await check('開啟：整步路徑被使用，結果與舊路徑在 f32 界內（loss 與參數）', async () => {
        const L = make({}), D = make({ deviceStep: true });
        await L.be.init({ cfg, seed: 4, lr: 0.01 }); await D.be.init({ cfg, seed: 4, lr: 0.01 });
        const rl = await L.be.step(toks), rd = await D.be.step(toks);
        assert.strictEqual(rd.path, 'device-step');
        assert.strictEqual(D.be.deviceStepStatus().used, 1);
        assert.strictEqual(D.be.deviceStepStatus().active, true);
        assert.ok(Math.abs(rd.loss - rl.loss) / Math.abs(rl.loss) < 1e-5, 'loss 相對差 ' + Math.abs(rd.loss - rl.loss) / Math.abs(rl.loss));
        const dp = maxAbsDiffLora(await params(L.be), await params(D.be));
        assert.ok(dp < 1e-5, '參數最大絕對差 ' + dp);
        console.log('     開啟 vs 舊路徑：loss 相對差 ' + (Math.abs(rd.loss - rl.loss) / Math.abs(rl.loss)).toExponential(2) + '，參數最大絕對差 ' + dp.toExponential(2));
    });

    await check('失敗永久退回：第一步的整步路徑丟錯 → 本步改跑舊路徑，之後不再嘗試整步路徑', async () => {
        const D = make({ deviceStep: true });
        await D.be.init({ cfg, seed: 5, lr: 0.01 });
        const orig = NN.createBatch; let calls = 0;
        NN.createBatch = (dev) => { calls++; if (calls === 1) throw new Error('假的整步失敗'); return orig(dev); };
        let r1, r2, r3;
        try { r1 = await D.be.step(toks); r2 = await D.be.step(toks); r3 = await D.be.step(toks); }
        finally { NN.createBatch = orig; }
        const s = D.be.deviceStepStatus();
        assert.strictEqual(s.disabled, true);
        assert.ok(/永久退回舊路徑/.test(s.reason), '原因：' + s.reason);
        assert.strictEqual(s.used, 0, '失敗的那一步不算使用');
        assert.strictEqual(r1.path, undefined); assert.strictEqual(r2.path, undefined); assert.strictEqual(r3.path, undefined);
        assert.ok(Number.isFinite(r1.loss) && Number.isFinite(r3.loss));
    });

    await check('沒有 WebGPU 裝置：開啟也只會停用並走舊路徑，原因寫明', async () => {
        const D = make({ deviceStep: true, fake: { adapter: 'null' } });
        await D.be.init({ cfg, seed: 6, lr: 0.01 });
        const s = D.be.deviceStepStatus();
        assert.strictEqual(s.want, true); assert.strictEqual(s.disabled, true); assert.strictEqual(s.active, false);
        assert.ok(s.reason && s.reason.length > 0);
        // 注意：沒有裝置時不呼叫 step（舊路徑的 rt.matmulMany 本來就假設有裝置；產品裡有執行期才會有 init 成功的後端）
    });

    await check('f16 能力分支：有 shader-f16 且要求 f16 → precision f16、loss 在 f16 界內；沒有 → f32', async () => {
        const F = make({ deviceStep: true, f16Forward: true, fake: { features: ['shader-f16'] } });
        const L = make({});
        await F.be.init({ cfg, seed: 7, lr: 0.01 }); await L.be.init({ cfg, seed: 7, lr: 0.01 });
        const rf = await F.be.step(toks), rl = await L.be.step(toks);
        assert.strictEqual(rf.path, 'device-step');
        assert.strictEqual(rf.precision, 'f16');
        assert.strictEqual(F.be.deviceStepStatus().precision, 'f16');
        assert.ok(Math.abs(rf.loss - rl.loss) / Math.abs(rl.loss) < 1e-2, 'f16 loss 相對差 ' + Math.abs(rf.loss - rl.loss) / Math.abs(rl.loss));
        const N = make({ deviceStep: true, f16Forward: true });
        await N.be.init({ cfg, seed: 7, lr: 0.01 });
        const rn = await N.be.step(toks);
        assert.strictEqual(rn.precision, 'f32', '沒有 shader-f16 應維持 f32');
    });

    console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
    process.exitCode = fail ? 1 : 0;
})();
