// node renderer/src/studio/lora_ref_train_async_test.js
// 非同步訓練變體的測試：與同步參考版（lora_ref_train.js 原路徑）比對。
// 1) CPU 後端：應與同步版幾乎完全相同（同樣的運算順序）。
// 2) cudaweb 後端（假 WebGPU 裝置）：與同步版在 f32 容差內一致。
// 3) 幾步訓練：非同步路徑的損失軌跡與同步版一致，且損失下降。
'use strict';
const assert = require('assert');
const R = require('./lora_ref_train.js');
const core = require('../gpu/gpu_core.js');
const { fakeNavigator, fakeGl } = require('../gpu/gpu_fakes.js');
const NN = require('../gpu/nn_ops.js');

const cfg = { V: 11, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
const toks = [1, 4, 7, 2, 9, 3, 0, 5, 8];   // T = 8
const maxK = Math.max(cfg.d, cfg.F, cfg.V, toks.length - 1);
const TOL = core.tolerance(maxK);

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); pass++; console.log('ok   ' + name); }
    catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
// 量測：全部梯度的「範數相對誤差」||a−b||₂ / ||b||₂。
// 不用逐元素相對誤差：梯度裡有接近 0 的元素，逐元素比值會被它們主導，與 f32 的絕對捨入誤差不成比例。
function maxRelGrads(ga, gb) {
    let num = 0, den = 0;
    for (let l = 0; l < ga.length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
        const a = ga[l][k][w], b = gb[l][k][w];
        for (let i = 0; i < a.length; i++) { num += (a[i] - b[i]) ** 2; den += b[i] * b[i]; }
    }
    return Math.sqrt(num / den);
}
// 讓 LoRA 的 B 不為零，梯度才會有意義（B 初始為小隨機數，已足夠；這裡另外放大一點確保非平凡）
function model(seed) { const m = R.makeModel(cfg, seed); for (const lo of m.lora) for (const k of ['q', 'k', 'v', 'o']) for (let i = 0; i < lo[k].B.length; i++) lo[k].B[i] *= 4; return m; }

(async () => {
    await check('CPU 後端：非同步版的損失與同步版幾乎相同（1e-12）', async () => {
        const m = model(3);
        const s = R.lossAndGrads(m, toks), a = await R.lossAndGradsAsync(m, toks, { backend: R.cpuMatmulBackend() });
        assert.ok(Math.abs(s.loss - a.loss) < 1e-12, 'loss 差 ' + (s.loss - a.loss));
        const worst = maxRelGrads(a.grads, s.grads);
        assert.ok(worst < 1e-10, '梯度最大相對差 ' + worst);
    });

    await check('預設後端（未指定）與 CPU 後端結果相同', async () => {
        const m = model(4);
        const a = await R.lossAndGradsAsync(m, toks);
        const b = await R.lossAndGradsAsync(m, toks, { backend: R.cpuMatmulBackend() });
        assert.strictEqual(a.loss, b.loss);
    });

    await check('cudaweb 後端（假 WebGPU）：損失與梯度在 f32 容差內一致', async () => {
        const m = model(5);
        const s = R.lossAndGrads(m, toks);
        const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
        const be = R.cudawebMatmulBackend(rt);
        const a = await R.lossAndGradsAsync(m, toks, { backend: be });
        const relLoss = Math.abs(a.loss - s.loss) / Math.max(1, Math.abs(s.loss));
        assert.ok(relLoss <= TOL, '損失相對差 ' + relLoss + ' 超過容差 ' + TOL);
        const worst = maxRelGrads(a.grads, s.grads);
        assert.ok(worst <= TOL, '梯度最大相對差 ' + worst + ' 超過容差 ' + TOL);
        assert.ok(be.calls > 0, '應該真的呼叫了後端');
        assert.strictEqual(be.layer, 'T1');
    });

    await check('noGrad 只回傳損失，不產生梯度', async () => {
        const m = model(6);
        const a = await R.lossAndGradsAsync(m, toks, { noGrad: true, backend: R.cpuMatmulBackend() });
        assert.ok(a.grads === undefined && typeof a.loss === 'number');
    });

    await check('訓練 3 步：非同步（cudaweb）與同步軌跡一致，且損失下降', async () => {
        const ms = model(7), ma = model(7);
        const ss = R.adamInit(ms), sa = R.adamInit(ma);
        const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
        const be = R.cudawebMatmulBackend(rt);
        const ls = [], la = [];
        for (let i = 0; i < 3; i++) {
            const rs = R.lossAndGrads(ms, toks); ls.push(rs.loss); R.adamStep(ms, rs.grads, ss, 0.02);
            const ra = await R.lossAndGradsAsync(ma, toks, { backend: be }); la.push(ra.loss); R.adamStep(ma, ra.grads, sa, 0.02);
        }
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(ls[i] - la[i]) / Math.max(1, Math.abs(ls[i])) <= TOL * 10, '第 ' + i + ' 步損失軌跡差太大');
        assert.ok(la[2] < la[0], '損失應下降：' + la.join(' → '));
    });

    // ---- 五個核心全部接上（ops 介面）----
    await check('全部 ops 走 T1（假 WebGPU）：損失與梯度與同步版在容差內，且五個核心都確實走了 T1', async () => {
        const m = model(5), s = R.lossAndGrads(m, toks);
        const ops = NN.trainerOps({ navigator: fakeNavigator().nav });
        const a = await R.lossAndGradsAsync(m, toks, { ops });
        assert.ok(Math.abs(a.loss - s.loss) / Math.abs(s.loss) <= TOL, 'loss 相對差');
        assert.ok(maxRelGrads(a.grads, s.grads) <= TOL, '梯度範數相對差 ' + maxRelGrads(a.grads, s.grads));
        for (const op of ['rmsnorm', 'softmax', 'silu', 'rope']) assert.ok(ops.stats.layers[op + ':T1'] > 0, op + ' 沒有走 T1');
    });

    await check('全部 ops 走 T3（假 WebGL2，無 WebGPU）：損失與梯度與同步版在容差內', async () => {
        const m = model(5), s = R.lossAndGrads(m, toks);
        const ops = NN.trainerOps({ navigator: {}, gl: fakeGl() });
        const a = await R.lossAndGradsAsync(m, toks, { ops });
        assert.ok(Math.abs(a.loss - s.loss) / Math.abs(s.loss) <= TOL, 'loss 相對差');
        assert.ok(maxRelGrads(a.grads, s.grads) <= TOL, '梯度範數相對差 ' + maxRelGrads(a.grads, s.grads));
        for (const op of ['rmsnorm', 'softmax', 'silu', 'rope']) assert.ok(ops.stats.layers[op + ':T3'] > 0, op + ' 沒有走 T3');
    });

    await check('AdamW 經 ops（T1）三步：權重軌跡的損失與同步 adamStep 在容差內', async () => {
        const ms = model(7), ma = model(7);
        const ss = R.adamInit(ms), sa = R.adamInit(ma);
        const ops = NN.trainerOps({ navigator: fakeNavigator().nav });
        for (let i = 0; i < 3; i++) {
            const rs = R.lossAndGrads(ms, toks); R.adamStep(ms, rs.grads, ss, 0.02);
            const ra = await R.lossAndGradsAsync(ma, toks, { ops }); await R.adamStepAsync(ma, ra.grads, sa, 0.02, ops);
            const ls = R.lossAndGrads(ms, toks, { noGrad: true }).loss, la = R.lossAndGrads(ma, toks, { noGrad: true }).loss;
            assert.ok(Math.abs(ls - la) / Math.abs(ls) <= TOL * 10, '第 ' + i + ' 步損失軌跡差 ' + Math.abs(ls - la) / Math.abs(ls));
        }
        assert.ok(ops.stats.layers['adamw:T1'] > 0, 'adamw 沒有走 T1');
    });

    console.log('\n' + pass + ' 通過，' + fail + ' 失敗（容差 ' + TOL.toExponential(2) + '）');
    if (fail) process.exit(1);
})();
