// node renderer/src/gpu/train_head_test.js
// O8 第二段：交叉熵上裝置、訓練頭一次提交、LoRA 轉置走 O5 旗標、批次矩陣乘帶旗標。
// 假裝置：WGSL 由 CPU 參考版執行（交叉熵是 f64 參考再捨入 f32；矩陣乘是 gpu_core 的 f32 參考），
// 所以這裡驗證的是綁定、旗標、降級、提交次數與回寫；WGSL 的歸約順序與真晶片數值仍待真 Chrome。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const MM = require('./mm_ops.js');
const RT = require('./cudaweb_runtime.js');
const core = require('./gpu_core.js');
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
// 獨立的 f64 交叉熵（與 crossEntropyRef 不共用程式碼，用 softmax 直接算）
function ceIndependent(lg, tg, T, V) {
  let loss = 0; const dl = new Float64Array(T * V);
  for (let t = 0; t < T; t++) {
    const row = Array.from(lg.slice(t * V, (t + 1) * V)); const mx = Math.max(...row);
    const ex = row.map((x) => Math.exp(x - mx)); const sm = ex.reduce((a, b) => a + b, 0);
    loss += -Math.log(ex[tg[t]] / sm);
    for (let j = 0; j < V; j++) dl[t * V + j] = (ex[j] / sm - (j === tg[t] ? 1 : 0)) / T;
  }
  return { loss: loss / T, dl };
}
function countSubmits(dev) {
  const orig = dev.queue.submit.bind(dev.queue); const box = { n: 0 };
  dev.queue.submit = (cmds) => { box.n++; return orig(cmds); };
  return box;
}

(async () => {
  const T = 6, V = 11, d = 8;
  const lg = seededF64(T * V, 3, 2), tg = Array.from({ length: T }, (_, i) => (i * 5 + 2) % V);

  await check('交叉熵參考版（crossEntropyRef）與獨立 f64 公式一致', async () => {
    const r = NN.crossEntropyRef(lg, tg, T, V, 1 / T);
    const want = ceIndependent(lg, tg, T, V);
    let s = 0; for (let t = 0; t < T; t++) s += r.rows[t];
    assert.ok(Math.abs(s / T - want.loss) < 1e-12, '損失差 ' + Math.abs(s / T - want.loss));
    let dd = 0; for (let i = 0; i < T * V; i++) dd = Math.max(dd, Math.abs(r.dl[i] - want.dl[i]));
    assert.ok(dd < 1e-12, 'dl 差 ' + dd);
    for (let t = 0; t < T; t++) { let z = 0; for (let j = 0; j < V; j++) z += r.dl[t * V + j]; assert.ok(Math.abs(z) < 1e-12, '列和應為 0'); }
  });

  await check('交叉熵經 WGSL（假裝置）：層 T1，與 f64 相差只在 f32 捨入內（≤1e-6）', async () => {
    const r = await NN.crossEntropy(lg, tg, T, V, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    const want = ceIndependent(lg, tg, T, V);
    assert.ok(Math.abs(r.result.loss - want.loss) < 1e-6, '損失差 ' + Math.abs(r.result.loss - want.loss));
    let dd = 0; for (let i = 0; i < T * V; i++) dd = Math.max(dd, Math.abs(r.result.dl[i] - want.dl[i]));
    assert.ok(dd < 1e-6, 'dl 差 ' + dd);
  });

  await check('交叉熵無 GPU：層 cpu-js，結果與 f64 逐位一致', async () => {
    const r = await NN.crossEntropy(lg, tg, T, V, { navigator: fakeNavigator({ adapter: 'null' }).nav });
    assert.strictEqual(r.info.layer, 'cpu-js');
    const want = ceIndependent(lg, tg, T, V);
    assert.ok(Math.abs(r.result.loss - want.loss) < 1e-12);
  });

  await check('批次矩陣乘帶轉置旗標（transB）與 gpu_core 參考一致（假裝置）', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const m = 4, k = 6, n = 5;
    const A = Float32Array.from(seededF64(m * k, 7, 1)), Bt = Float32Array.from(seededF64(n * k, 8, 1)); // Bt 為 n×k 儲存
    const b = NN.createBatch(dev);
    const h = b.matmul(b.upload(A), b.upload(Bt), m, k, n, { transB: true });
    const [y] = await b.read([[h, m * n]]);
    const want = core.matmulTRef(A, Bt, m, k, n, 2);
    let dd = 0; for (let i = 0; i < m * n; i++) dd = Math.max(dd, Math.abs(y[i] - want[i]));
    assert.ok(dd < 1e-5, '差 ' + dd);
  });

  await check('訓練頭（rt.headStep）：一次 submit、與 f64 逐項在界線內', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const subs = countSubmits(dev);
    const rt = RT.createRuntime({ nn: NN, mm: MM, navigator: fakeNavigator().nav, device: dev });
    const nf = seededF64(T * d, 21, 1), emb = seededF64(V * d, 22, 0.5);
    const H = await rt.headStep({ nf, emb, tgt: tg, T, d, V });
    assert.strictEqual(subs.n, 1, '訓練頭應只 submit 一次，實際 ' + subs.n);
    // f64 真值：logits = nf·embᵀ；dl 來自交叉熵；dh = dl·emb
    const logits = new Float64Array(T * V);
    for (let t = 0; t < T; t++) for (let j = 0; j < V; j++) { let z = 0; for (let i = 0; i < d; i++) z += nf[t * d + i] * emb[j * d + i]; logits[t * V + j] = z; }
    const want = ceIndependent(logits, tg, T, V);
    assert.ok(Math.abs(H.loss - want.loss) < 1e-5, '損失差 ' + Math.abs(H.loss - want.loss));
    const dh = new Float64Array(T * d);
    for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) { let z = 0; for (let j = 0; j < V; j++) z += want.dl[t * V + j] * emb[j * d + i]; dh[t * d + i] = z; }
    let dd = 0; for (let i = 0; i < T * d; i++) dd = Math.max(dd, Math.abs(H.dh[i] - dh[i]));
    assert.ok(dd < 1e-5, 'dh 差 ' + dd);
  });

  await check('rt.precision：裝置有 shader-f16 → f16；沒有 → f32（能力分支，與是否要求 f16 無關）', async () => {
    const nav = fakeNavigator({ features: ['shader-f16'] }).nav;
    const dev = (await NN.getDevice(nav)).dev;
    const rt = RT.createRuntime({ nn: NN, mm: MM, navigator: nav, device: dev });
    assert.strictEqual((await rt.precision()).precision, 'f16');
    const nav2 = fakeNavigator().nav;
    const rt2 = RT.createRuntime({ nn: NN, mm: MM, navigator: nav2, device: (await NN.getDevice(nav2)).dev });
    assert.strictEqual((await rt2.precision()).precision, 'f32');
  });

  await check('完整前向反向（cudaweb 假後端＋融合頭）對 CPU f64：loss 與各 LoRA 梯度在界線內', async () => {
    const cfg = { V: 16, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
    const tokens = [1, 4, 9, 2, 7, 3, 12, 5, 8, 14];
    const mA = LR.makeModel(cfg, 5), mB = LR.makeModel(cfg, 5);
    const ref = await LR.lossAndGradsAsync(mA, tokens, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() });
    const nav = fakeNavigator().nav;
    const dev = (await NN.getDevice(nav)).dev;
    const rt = RT.createRuntime({ nn: NN, mm: MM, navigator: nav, device: dev });
    const be = LR.cudawebMatmulBackend(rt);
    assert.ok(be.headStep && be.transFlags, '後端應提供 headStep 與 transFlags');
    const got = await LR.lossAndGradsAsync(mB, tokens, { backend: be, ops: NN.trainerOps({ navigator: nav }) });
    assert.ok(Math.abs(got.loss - ref.loss) / Math.abs(ref.loss) < 1e-5, 'loss 相對差 ' + Math.abs(got.loss - ref.loss) / Math.abs(ref.loss));
    // 界線以「梯度最大值」為尺度（逐元素相對差會被接近 0 的元素放大，不合適）：|Δg| ≤ 1e-5·max|g|
    let worstAbs = 0, scale = 0;
    for (let l = 0; l < cfg.L; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
      const a = ref.grads[l][k][w], b = got.grads[l][k][w];
      for (let i = 0; i < a.length; i++) { worstAbs = Math.max(worstAbs, Math.abs(a[i] - b[i])); scale = Math.max(scale, Math.abs(a[i])); }
    }
    assert.ok(worstAbs <= 1e-5 * scale, '梯度最差絕對差 ' + worstAbs + '，尺度 ' + scale);
    console.log('     loss 相對差 ' + (Math.abs(got.loss - ref.loss) / Math.abs(ref.loss)).toExponential(2) + '，梯度最大絕對差／尺度 ' + (worstAbs / scale).toExponential(2) + '（假裝置）');
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  process.exitCode = fail ? 1 : 0;
})();
