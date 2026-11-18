// node renderer/src/gpu/train_fused_test.js
// O8 訓練路徑（node 部分）：adamw_accum 融合核心、一步一次派發、前向精度分支、20 步 loss 對 CPU f64。
// 注意：假裝置以 CPU 的 f32 逐運算模擬執行 WGSL，所以這裡驗證的是主機端的綁定、攤平、回寫、降級與界線；
// 真 GPU 的逐元素數值與每步時間都還沒量，真 Chrome 20 步仍待做（見 docs/CHECKLIST.cudaweb-optimize.md 的 O8）。
'use strict';
const assert = require('assert');
const TF = require('./train_fused.js');
const NN = require('./nn_ops.js');
const { fakeNavigator } = require('./gpu_fakes.js');
const LR = require('../studio/lora_ref_train.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}
const U = 2 ** -24;
function seededF64(n, seed, scale) {
  let s = seed >>> 0 || 1; const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = (((s % 2001) - 1000) / 1000) * scale; }
  return out;
}
// 與 WGSL 同一組超參數（b1、b2、eps、wd=0），c1、c2 依 t 算好後以 f32 傳入
function flOf(t, lr, scale) {
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0;
  return { fl: [Math.fround(lr), Math.fround(b1), Math.fround(1 - b1), Math.fround(b2), Math.fround(1 - b2),
    Math.fround(eps), Math.fround(wd), Math.fround(1 - Math.pow(b1, t)), Math.fround(1 - Math.pow(b2, t)), Math.fround(scale)], b1, b2, eps, wd };
}

(async () => {
  // ---- 1. 核心的 f32 逐運算模擬 vs f64 真值：逐元素界線 ----
  for (const K of [1, 2, 4]) {
    await check('adamw_accum f32 模擬在界線內（K=' + K + '，p 與 m）', async () => {
      const n = 257, lr = 1e-2, t = 7, scale = 1 / K;
      const p = seededF64(n, 11 + K, 0.5), m = seededF64(n, 21 + K, 0.1), v = Float64Array.from(seededF64(n, 31 + K, 0.1), (x) => x * x);
      const G = seededF64(K * n, 41 + K, 0.3);
      const { fl, b1, b2, eps, wd } = flOf(t, lr, scale);
      const r32 = TF.adamwAccumF32(Float64Array.from(p), G, K, Float64Array.from(m), Float64Array.from(v), fl);
      const r64 = TF.adamwAccumRef(p, G, K, m, v, t, lr, b1, b2, eps, wd, scale);
      let worstP = 0, worstM = 0;
      for (let i = 0; i < n; i++) {
        let sumAbsG = 0; for (let k = 0; k < K; k++) sumAbsG += Math.abs(G[k * n + i]);
        const g = Math.abs(scale * sumAbsG);
        const delta64 = Math.abs(r64.p[i] - p[i]);
        // 界線（見 train_fused.js 檔頭）：|Δp_f32−Δp_f64| 以 (K+10)·u·(|p|+|Δ|+lr) 為上界
        const boundP = (K + 10) * U * (Math.abs(p[i]) + delta64 + lr);
        const errP = Math.abs(r32.p[i] - r64.p[i]);
        worstP = Math.max(worstP, errP / boundP);
        // m 的界線：(K+4)·u·(|b1·m| + (1−b1)·Σ|g|)
        const boundM = (K + 4) * U * (Math.abs(b1 * m[i]) + (1 - b1) * g);
        const errM = Math.abs(r32.m[i] - r64.m[i]);
        worstM = Math.max(worstM, errM / boundM);
      }
      assert.ok(worstP <= 1, 'p 超出界線，最差比值 ' + worstP);
      assert.ok(worstM <= 1, 'm 超出界線，最差比值 ' + worstM);
    });
  }

  await check('adamw_accum 真值的 K=1 與既有 adamwRef（單一梯度、scale=1）逐位一致', async () => {
    const n = 64, t = 3, lr = 0.02;
    const p = seededF64(n, 5, 0.4), g = seededF64(n, 6, 0.2), m = seededF64(n, 7, 0.05), v = Float64Array.from(seededF64(n, 8, 0.05), (x) => x * x);
    const a = TF.adamwAccumRef(p, g, 1, m, v, t, lr, 0.9, 0.999, 1e-8, 0, 1);
    const b = NN.adamwRef(p, g, m, v, t, lr, 0.9, 0.999, 1e-8, 0);
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a.p[i] - b.p[i]), Math.abs(a.m[i] - b.m[i]), Math.abs(a.v[i] - b.v[i]));
    assert.ok(d < 1e-15, '差 ' + d);
  });

  // ---- 2. 攤平一步：假 GPU 走 T1、一次派發、結果與真值在界線內 ----
  const LRC = { V: 16, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
  function gradsFor(model, seqSeed) {
    const tokens = Array.from(seededF64(LRC.V + 1, seqSeed, 1), (x, i) => (Math.abs(Math.round(x * 1000 + i * 7)) % LRC.V));
    return { tokens, promise: LR.lossAndGradsAsync(model, tokens, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }) };
  }
  // 一個微批次的梯度（固定 seed 的 token）
  const toks = [[1, 4, 9, 2, 7, 3, 12, 5, 8], [6, 0, 11, 14, 2, 9, 4, 13, 10]];

  await check('adamStepFused（假 GPU）：layer=T1、一步只派發一次、與真值在界線內', async () => {
    const mA = LR.makeModel(LRC, 3), mB = LR.makeModel(LRC, 3);
    const gA = [];
    for (const tk of toks) gA.push((await LR.lossAndGradsAsync(mA, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() })).grads);
    // 真值：f64 同步路徑的 AdamW（同樣用平均梯度）
    const avg = gA[0].map((lg, l) => ({ q: avgKey(gA, l, 'q'), k: avgKey(gA, l, 'k'), v: avgKey(gA, l, 'v'), o: avgKey(gA, l, 'o') }));
    const stRef = LR.adamInit(mA); await LR.adamStepAsync(mA, avg, stRef, 1e-2, LR.cpuNnOps());
    // 候選：融合核心（假裝置）
    const stB = LR.adamInit(mB);
    let calls = 0; const orig = NN.runWgsl; NN.runWgsl = (...a) => { calls++; return orig(...a); };
    let info;
    try { ({ info } = await TF.adamStepFused(mB, gA, stB, 1e-2, { navigator: fakeNavigator().nav })); }
    finally { NN.runWgsl = orig; }
    assert.strictEqual(info.layer, 'T1');
    assert.strictEqual(calls, 1, '一步應只派發一次，實際 ' + calls);
    let worst = 0;
    for (let l = 0; l < LRC.L; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
      const a = mA.lora[l][k][w], b = mB.lora[l][k][w];
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]) / (Math.abs(a[i]) + 1e-3));
    }
    assert.ok(worst < 1e-4, '參數最差相對差 ' + worst);
    console.log('     參數最差相對差（假 GPU 對 f64）= ' + worst.toExponential(3));
  });

  await check('adamStepFused 無 GPU：layer=cpu-js，結果與 f64 真值逐位一致', async () => {
    const mA = LR.makeModel(LRC, 4), mB = LR.makeModel(LRC, 4);
    const gA = [];
    for (const tk of toks) gA.push((await LR.lossAndGradsAsync(mA, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() })).grads);
    const avg = gA[0].map((lg, l) => ({ q: avgKey(gA, l, 'q'), k: avgKey(gA, l, 'k'), v: avgKey(gA, l, 'v'), o: avgKey(gA, l, 'o') }));
    const stRef = LR.adamInit(mA); await LR.adamStepAsync(mA, avg, stRef, 1e-2, LR.cpuNnOps());
    const stB = LR.adamInit(mB);
    const { info } = await TF.adamStepFused(mB, gA, stB, 1e-2, { navigator: fakeNavigator({ adapter: 'null' }).nav });
    assert.strictEqual(info.layer, 'cpu-js');
    assert.ok(info.reason.length > 0, '降級原因應寫明');
    let d = 0; for (let l = 0; l < LRC.L; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
      const a = mA.lora[l][k][w], b = mB.lora[l][k][w]; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    }
    assert.ok(d < 1e-15, '差 ' + d);
  });

  // ---- 3. 前向精度的能力分支 ----
  await check('pickForwardPrecision：有 shader-f16 → f16；沒有 → f32；從不回傳 cpu', async () => {
    assert.strictEqual(TF.pickForwardPrecision(new Set(['shader-f16'])).precision, 'f16');
    assert.strictEqual(TF.pickForwardPrecision(['shader-f16']).precision, 'f16');
    assert.strictEqual(TF.pickForwardPrecision({ 'shader-f16': true }).precision, 'f16');
    assert.strictEqual(TF.pickForwardPrecision(new Set()).precision, 'f32');
    assert.strictEqual(TF.pickForwardPrecision(undefined).precision, 'f32');
    assert.strictEqual(TF.pickForwardPrecision(new Set(['subgroups'])).precision, 'f32');
    for (const f of [undefined, new Set(), new Set(['shader-f16'])]) assert.notStrictEqual(TF.pickForwardPrecision(f).precision, 'cpu');
    assert.strictEqual(TF.pickForwardPrecision(new Set()).accum, 'f32');
  });

  // ---- 4. 20 步 loss：f64 同步路徑 vs 融合 AdamW（假 GPU）；兩個微批次 ----
  await check('20 步訓練：loss 對 CPU f64 的最差相對差（假裝置，只換 AdamW 路徑）', async () => {
    const mR = LR.makeModel(LRC, 9), mC = LR.makeModel(LRC, 9);
    const stR = LR.adamInit(mR), stC = LR.adamInit(mC);
    const nav = fakeNavigator().nav;
    let worstLoss = 0, lossR = [], lossC = [];
    for (let step = 0; step < 20; step++) {
      const rR = [], rC = [];
      for (const tk of toks) {
        rR.push(await LR.lossAndGradsAsync(mR, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }));
        rC.push(await LR.lossAndGradsAsync(mC, tk, { backend: LR.cpuMatmulBackend(), ops: LR.cpuNnOps() }));
      }
      const lr0 = (rR[0].loss + rR[1].loss) / 2, lc = (rC[0].loss + rC[1].loss) / 2;
      lossR.push(lr0); lossC.push(lc);
      worstLoss = Math.max(worstLoss, Math.abs(lc - lr0) / Math.abs(lr0));
      const avg = rR[0].grads.map((_, l) => ({ q: avgKey(rR.map((x) => x.grads), l, 'q'), k: avgKey(rR.map((x) => x.grads), l, 'k'), v: avgKey(rR.map((x) => x.grads), l, 'v'), o: avgKey(rR.map((x) => x.grads), l, 'o') }));
      await LR.adamStepAsync(mR, avg, stR, 1e-2, LR.cpuNnOps());
      await TF.adamStepFused(mC, [rC[0].grads, rC[1].grads], stC, 1e-2, { navigator: nav });
    }
    console.log('     20 步 loss（f64）首 ' + lossR[0].toFixed(6) + ' 末 ' + lossR[19].toFixed(6) + '；（融合）末 ' + lossC[19].toFixed(6));
    console.log('     20 步 loss 最差相對差 = ' + worstLoss.toExponential(3) + '（假裝置；真 Chrome 未量）');
    assert.ok(worstLoss < 1e-4, '最差相對差 ' + worstLoss);
    assert.ok(lossR[19] < lossR[0], '20 步 loss 應下降（f64 基準）');
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  process.exitCode = fail ? 1 : 0;
})();

// 第 l 層、矩陣 key（q/k/v/o）的兩個微批次梯度的平均，回傳 { A, B }
function avgKey(gradsList, l, key) {
  const out = {};
  for (const w of ['A', 'B']) {
    const n = gradsList[0][l][key][w].length, o = new Float64Array(n);
    for (const g of gradsList) for (let i = 0; i < n; i++) o[i] += g[l][key][w][i] / gradsList.length;
    out[w] = o;
  }
  return out;
}
