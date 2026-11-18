// node renderer/src/gpu/layer_batch_test.js
// O8 每層一次提交：f16 編解碼、逐元素批次運算、f16 矩陣乘、LoRA 投影群組（前向／反向）與前饋區塊各一次提交，
// 以及假裝置上的 20 步 loss 對 CPU f64（含新路徑、含 f16 前向）。
// 假裝置：WGSL 由 CPU 參考執行（f16 輸入先解碼再做 f32 累加）。真 GPU 的 f16 與數值、每步時間仍未量。
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
function seeded(n, seed, scale) {
  let s = seed >>> 0 || 1; const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = (((s % 2001) - 1000) / 1000) * scale; }
  return out;
}
function mmRef(A, B, m, k, n) { const C = new Float64Array(m * n); for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) for (let j = 0; j < n; j++) C[i * n + j] += A[i * k + p] * B[p * n + j]; return C; }
function countSubmits(dev) { const orig = dev.queue.submit.bind(dev.queue); const box = { n: 0 }; dev.queue.submit = (c) => { box.n++; return orig(c); }; return box; }
function maxAbsDiff(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; }
function loraFwdRef(x, W, lo, s, T, din, dout) {
  const r = lo.A.length / din;
  const xA = mmRef(x, lo.A, T, din, r), base = mmRef(x, W, T, din, dout), br = mmRef(xA, lo.B, T, r, dout);
  const y = new Float64Array(T * dout); for (let i = 0; i < y.length; i++) y[i] = base[i] + s * br[i];
  return { y, xA };
}
function loraBwdRef(dy, x, W, lo, s, xA, T, din, dout) {
  const r = lo.A.length / din;
  const dB = new Float64Array(r * dout), dxA = new Float64Array(T * r);
  // dB = s·xAᵀ·dy；dxA = s·dy·Bᵀ
  for (let i = 0; i < r; i++) for (let j = 0; j < dout; j++) { let z = 0; for (let t = 0; t < T; t++) z += xA[t * r + i] * dy[t * dout + j]; dB[i * dout + j] = s * z; }
  for (let t = 0; t < T; t++) for (let i = 0; i < r; i++) { let z = 0; for (let j = 0; j < dout; j++) z += dy[t * dout + j] * lo.B[i * dout + j]; dxA[t * r + i] = s * z; }
  const dA = new Float64Array(din * r); for (let i = 0; i < din; i++) for (let j = 0; j < r; j++) { let z = 0; for (let t = 0; t < T; t++) z += x[t * din + i] * dxA[t * r + j]; dA[i * r + j] = z; }
  const dx = new Float64Array(T * din);
  for (let t = 0; t < T; t++) for (let i = 0; i < din; i++) { let z = 0; for (let j = 0; j < dout; j++) z += dy[t * dout + j] * W[i * dout + j]; for (let j = 0; j < r; j++) z += dxA[t * r + j] * lo.A[i * r + j]; dx[t * din + i] = z; }
  return { dA, dB, dx };
}
function setup(features) {
  const nav = fakeNavigator(features ? { features } : {}).nav;
  return NN.getDevice(nav).then((r) => {
    const dev = r.dev;
    const rt = RT.createRuntime({ nn: NN, mm: MM, navigator: nav, device: dev, f16Forward: !!(features && features.indexOf('shader-f16') >= 0) });
    return { nav, dev, rt };
  });
}

(async () => {
  await check('f16 編解碼：往返在 2⁻¹¹ 相對界內（正規範圍），特殊值正確', async () => {
    for (const v of [0, 1, -1, 0.5, 3.14159, -2.71828, 65504, 1e-4, -1e-3]) {
      const back = NN.f16ToF32(NN.f32ToF16Bits(v));
      assert.ok(Math.abs(back - v) <= Math.abs(v) * 2 ** -11 + 1e-7, v + ' → ' + back);
    }
    assert.strictEqual(NN.f16ToF32(NN.f32ToF16Bits(70000)), Infinity);
    assert.strictEqual(NN.f16ToF32(NN.f32ToF16Bits(-0)), -0);
    assert.ok(Number.isNaN(NN.f16ToF32(NN.f32ToF16Bits(NaN))));
    assert.strictEqual(NN.f16ToF32(NN.f32ToF16Bits(1)), 1);
  });

  await check('批次逐元素（axpy、mul、scal）假裝置與 CPU 一致（逐位，f32 一次乘一次加）', async () => {
    const { dev } = await setup();
    const n = 37, x = Float32Array.from(seeded(n, 1, 2)), y = Float32Array.from(seeded(n, 2, 2));
    const b = NN.createBatch(dev);
    const hx = b.upload(x), hy = b.upload(y);
    const [a, m, s] = await b.read([[b.axpy(hx, hy, 0.25), n], [b.mul(hx, hy), n], [b.scal(hx, -3), n]]);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(a[i] - Math.fround(x[i] + Math.fround(0.25 * y[i]))) === 0, 'axpy ' + i);
      assert.ok(Math.abs(m[i] - Math.fround(x[i] * y[i])) === 0, 'mul ' + i);
      assert.ok(Math.abs(s[i] - Math.fround(-3 * x[i])) === 0, 'scal ' + i);
    }
  });

  await check('f16 矩陣乘（假裝置）：與「先把輸入捨入成 f16 再 f32 累加」的參考逐位一致', async () => {
    const { dev } = await setup(['shader-f16']);
    const m = 5, k = 7, n = 6;
    const A = seeded(m * k, 3, 1), B = seeded(k * n, 4, 1);
    const Aq = Float32Array.from(A, (v) => NN.f16ToF32(NN.f32ToF16Bits(v))), Bq = Float32Array.from(B, (v) => NN.f16ToF32(NN.f32ToF16Bits(v)));
    const b = NN.createBatch(dev);
    const h = b.matmul(b.uploadF16(A), b.uploadF16(B), m, k, n, { f16: true });
    const [y] = await b.read([[h, m * n]]);
    const want = core.matmulTRef(Aq, Bq, m, k, n, 0);
    assert.ok(maxAbsDiff(y, want) < 1e-6, '差 ' + maxAbsDiff(y, want));
  });

  await check('f16 矩陣乘：f32 句柄不能走 f16 路徑（丟明確錯誤）', async () => {
    const { dev } = await setup(['shader-f16']);
    const b = NN.createBatch(dev);
    assert.throws(() => b.matmul(b.upload(new Float32Array(4)), b.upload(new Float32Array(4)), 2, 2, 2, { f16: true }), /uploadF16/);
  });

  const cfg = { V: 16, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
  const T = 7;

  await check('LoRA 投影群組前向（loraFwdMany）：一次提交，與 CPU 參考一致', async () => {
    const { nav, dev, rt } = await setup();
    const din = 8, dout = 8, r = 2, s = 2;
    const x = seeded(T * din, 11, 1);
    const specs = [0, 1, 2].map((i) => ({ x, W: seeded(din * dout, 20 + i, 0.5), A: seeded(din * r, 30 + i, 0.5), B: seeded(r * dout, 40 + i, 0.5), s, T, din, dout }));
    const subs = countSubmits(dev);
    const R = await rt.loraFwdMany(specs);
    assert.strictEqual(subs.n, 1, '一組投影應只提交一次，實際 ' + subs.n);
    specs.forEach((sp, i) => {
      const want = loraFwdRef(x, sp.W, { A: sp.A, B: sp.B }, s, T, din, dout);
      assert.ok(maxAbsDiff(R.results[i].y, want.y) < 1e-5, '投影 ' + i + ' y 差 ' + maxAbsDiff(R.results[i].y, want.y));
      assert.ok(maxAbsDiff(R.results[i].xA, want.xA) < 1e-5, '投影 ' + i + ' xA 差');
    });
  });

  await check('LoRA 投影群組反向（loraBwdMany）：一次提交，與 CPU 參考一致', async () => {
    const { dev, rt } = await setup();
    const din = 8, dout = 8, r = 2, s = 2;
    const x = seeded(T * din, 51, 1), W = seeded(din * dout, 52, 0.5), A = seeded(din * r, 53, 0.5), B = seeded(r * dout, 54, 0.5), dy = seeded(T * dout, 55, 1);
    const fwd = loraFwdRef(x, W, { A, B }, s, T, din, dout);
    const subs = countSubmits(dev);
    const R = await rt.loraBwdMany([{ dy, x, W, A, B, xA: fwd.xA, s, T, din, dout }]);
    assert.strictEqual(subs.n, 1, '反向應只提交一次，實際 ' + subs.n);
    const want = loraBwdRef(dy, x, W, { A, B }, s, fwd.xA, T, din, dout);
    assert.ok(maxAbsDiff(R.results[0].dA, want.dA) < 1e-4, 'dA 差 ' + maxAbsDiff(R.results[0].dA, want.dA));
    assert.ok(maxAbsDiff(R.results[0].dB, want.dB) < 1e-4, 'dB 差');
    assert.ok(maxAbsDiff(R.results[0].dx, want.dx) < 1e-4, 'dx 差');
  });

  await check('前饋區塊（mlpFwd）：一次提交，g、u、a、dn 與 CPU 一致', async () => {
    const { dev, rt } = await setup();
    const d = 8, F = 12, x = seeded(T * d, 61, 1), Wg = seeded(d * F, 62, 0.5), Wu = seeded(d * F, 63, 0.5), Wd = seeded(F * d, 64, 0.5);
    const subs = countSubmits(dev);
    const R = await rt.mlpFwd({ x, Wg, Wu, Wd, T, d, F });
    assert.strictEqual(subs.n, 1, '前饋應只提交一次，實際 ' + subs.n);
    const g = mmRef(x, Wg, T, d, F), u = mmRef(x, Wu, T, d, F);
    const a = new Float64Array(T * F); for (let i = 0; i < a.length; i++) a[i] = g[i] / (1 + Math.exp(-g[i])) * u[i];
    const dn = mmRef(a, Wd, T, F, d);
    assert.ok(maxAbsDiff(R.g, g) < 1e-5 && maxAbsDiff(R.u, u) < 1e-5, 'g/u 差');
    assert.ok(maxAbsDiff(R.a, a) < 1e-5, 'a 差 ' + maxAbsDiff(R.a, a));
    assert.ok(maxAbsDiff(R.dn, dn) < 1e-4, 'dn 差 ' + maxAbsDiff(R.dn, dn));
  });

  await check('precision：有 shader-f16 且要求前向 f16 → 走 f16；沒有 → f32（能力不足不選）', async () => {
    const withF = await setup(['shader-f16']);
    assert.strictEqual((await withF.rt.precision()).precision, 'f16');
    const noF = await setup();
    assert.strictEqual((await noF.rt.precision()).precision, 'f32');
    const { dev } = noF;
    // 沒有 shader-f16 的裝置：即使呼叫端要求 f16，前饋區塊仍用 f32（不丟錯、不退 CPU）
    const rt2 = RT.createRuntime({ nn: NN, mm: MM, navigator: noF.nav, device: dev, f16Forward: true });
    const d = 8, F = 12, x = seeded(T * d, 71, 1), Wg = seeded(d * F, 72, 0.5), Wu = seeded(d * F, 73, 0.5), Wd = seeded(F * d, 74, 0.5);
    const R = await rt2.mlpFwd({ x, Wg, Wu, Wd, T, d, F });
    assert.strictEqual(R.f16, false);
    assert.ok(maxAbsDiff(R.g, mmRef(x, Wg, T, d, F)) < 1e-5);
  });

  // ---- 完整一步：提交次數（每層）與 20 步 loss ----
  function layerCounts(be, nav, dev, tk) {
    return (async () => {
      const m = LR.makeModel(cfg, 5), subs = countSubmits(dev);
      await LR.lossAndGradsAsync(m, tk, { backend: be, ops: NN.trainerOps({ navigator: nav }) });
      return subs.n;
    })();
  }
  const tokens = [1, 4, 9, 2, 7, 3, 12, 5, 8, 14];

  await check('每層提交次數：新路徑 對 逐組基線（同一後端去掉新函式）', async () => {
    const { nav, dev, rt } = await setup();
    const newBe = LR.cudawebMatmulBackend(rt);
    const baseBe = LR.cudawebMatmulBackend(rt);
    delete baseBe.loraFwdMany; delete baseBe.loraBwdMany; delete baseBe.mlpFwd;
    const nNew = await layerCounts(newBe, nav, dev, tokens);
    const nBase = await layerCounts(baseBe, nav, dev, tokens);
    console.log('     整步提交次數：基線 ' + nBase + '（L=' + cfg.L + '），新路徑 ' + nNew + '；每層：基線 ' + ((nBase - 1) / cfg.L).toFixed(1) + '，新路徑 ' + ((nNew - 1) / cfg.L).toFixed(1) + '（扣掉頭與 rmsnorm 等 CPU 包裝後的粗估）');
    assert.ok(nNew < nBase, '新路徑的提交次數應少於基線');
  });

  await check('20 步訓練（新路徑＋融合 AdamW，假裝置）對 CPU f64：loss 最差相對差', async () => {
    const mR = LR.makeModel(cfg, 9), mC = LR.makeModel(cfg, 9);
    const stR = LR.adamInit(mR), stC = LR.adamInit(mC);
    const toks = [[1, 4, 9, 2, 7, 3, 12, 5, 8, 14], [6, 0, 11, 14, 2, 9, 4, 13, 10, 3]];
    const { nav, rt } = await setup();
    const be = LR.cudawebMatmulBackend(rt);
    let worst = 0, first = 0, last = 0;
    for (let step = 0; step < 20; step++) {
      const rR = [], rC = [];
      for (const tk of toks) {
        rR.push(await LR.lossAndGradsAsync(mR, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }));
        rC.push(await LR.lossAndGradsAsync(mC, tk, { backend: be, ops: NN.trainerOps({ navigator: nav }) }));
      }
      const lR = (rR[0].loss + rR[1].loss) / 2, lC = (rC[0].loss + rC[1].loss) / 2;
      if (step === 0) first = lR;
      last = lR;
      worst = Math.max(worst, Math.abs(lC - lR) / Math.abs(lR));
      const avg = (l, k, w) => { const o = new Float64Array(rR[0].grads[l][k][w].length); for (const r of rR) for (let i = 0; i < o.length; i++) o[i] += r.grads[l][k][w][i] / 2; return o; };
      const gavg = rR[0].grads.map((_, l) => ({ q: { A: avg(l, 'q', 'A'), B: avg(l, 'q', 'B') }, k: { A: avg(l, 'k', 'A'), B: avg(l, 'k', 'B') }, v: { A: avg(l, 'v', 'A'), B: avg(l, 'v', 'B') }, o: { A: avg(l, 'o', 'A'), B: avg(l, 'o', 'B') } }));
      await LR.adamStepAsync(mR, gavg, stR, 1e-2, LR.cpuNnOps());
      await require('./train_fused.js').adamStepFused(mC, [rC[0].grads, rC[1].grads], stC, 1e-2, { navigator: nav });
    }
    console.log('     20 步 loss：f64 首 ' + first.toFixed(6) + ' 末 ' + last.toFixed(6) + '；新路徑最差相對差 ' + worst.toExponential(3) + '（假裝置，f32）');
    assert.ok(worst < 1e-4, '最差相對差 ' + worst);
    assert.ok(last < first, 'loss 應下降');
  });

  await check('20 步訓練（f16 前向，有 shader-f16）：loss 最差相對差在 f16 界內（假裝置）', async () => {
    const mR = LR.makeModel(cfg, 9), mC = LR.makeModel(cfg, 9);
    const stR = LR.adamInit(mR), stC = LR.adamInit(mC);
    const toks = [[1, 4, 9, 2, 7, 3, 12, 5, 8, 14], [6, 0, 11, 14, 2, 9, 4, 13, 10, 3]];
    const { nav, rt } = await setup(['shader-f16']);
    const be = LR.cudawebMatmulBackend(rt);
    let worst = 0, first = 0, last = 0;
    for (let step = 0; step < 20; step++) {
      const rR = [], rC = [];
      for (const tk of toks) {
        rR.push(await LR.lossAndGradsAsync(mR, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }));
        rC.push(await LR.lossAndGradsAsync(mC, tk, { backend: be, ops: NN.trainerOps({ navigator: nav }) }));
      }
      const lR = (rR[0].loss + rR[1].loss) / 2, lC = (rC[0].loss + rC[1].loss) / 2;
      if (step === 0) first = lR;
      last = lR;
      worst = Math.max(worst, Math.abs(lC - lR) / Math.abs(lR));
      const avg = (l, k, w) => { const o = new Float64Array(rR[0].grads[l][k][w].length); for (const r of rR) for (let i = 0; i < o.length; i++) o[i] += r.grads[l][k][w][i] / 2; return o; };
      const gavg = rR[0].grads.map((_, l) => ({ q: { A: avg(l, 'q', 'A'), B: avg(l, 'q', 'B') }, k: { A: avg(l, 'k', 'A'), B: avg(l, 'k', 'B') }, v: { A: avg(l, 'v', 'A'), B: avg(l, 'v', 'B') }, o: { A: avg(l, 'o', 'A'), B: avg(l, 'o', 'B') } }));
      await LR.adamStepAsync(mR, gavg, stR, 1e-2, LR.cpuNnOps());
      await require('./train_fused.js').adamStepFused(mC, [rC[0].grads, rC[1].grads], stC, 1e-2, { navigator: nav });
    }
    console.log('     f16 前向 20 步 loss：f64 首 ' + first.toFixed(6) + ' 末 ' + last.toFixed(6) + '；最差相對差 ' + worst.toExponential(3) + '（假裝置；f16 只用於 X·W 與閘門投影）');
    assert.ok(worst < 1e-2, 'f16 最差相對差 ' + worst);
    assert.ok(last < first, 'loss 應下降');
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  process.exitCode = fail ? 1 : 0;
})();
