#!/usr/bin/env node
// 整步對拍（真 WebGPU，走 fullParamStepDevice＝產品路徑，含注意力三個 GPU 核心）：
// 每個 fixture（dense／gqa_qkn × fp64／f32）：20 步，逐步損失與梯度範數對 PyTorch 參考；
// 第 1 步另用 applyUpdate:false 量逐參數梯度相對誤差；續訓：第 10 步存檔（readResident）→ 新狀態 loadResident → 續跑 10 步，與連續 20 步的最終參數逐位比對。
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2], out = process.argv[3], FIXDIR = process.argv[4];
const ENTRY = ['gpu/nn_ops.js', 'gpu/full_param_step_device.js', 'studio/llm_full_data.js'];
const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');
const mods = new Map();
const queue = ENTRY.map((e) => path.join(SRC, e));
while (queue.length) {
  const abs = queue.shift(); const r = rel(abs);
  if (mods.has(r)) continue;
  const s = fs.readFileSync(abs, 'utf8'); mods.set(r, s);
  const re = /require\((['"])(\.[^'"]+)\1\)/g; let m;
  while ((m = re.exec(s))) queue.push(path.resolve(path.dirname(abs), m[2]));
}
const modBlock = [...mods.entries()].map(([r, s]) => JSON.stringify(r) + ': function (module, exports, require) {\n' + s + '\n}').join(',\n');
const names = ['full_param_parity_f64.json', 'full_param_parity_gqa_qkn_f64.json', 'full_param_parity_f32.json', 'full_param_parity_gqa_qkn_f32.json'];
const FX = {};
for (const n of names) FX[n] = JSON.parse(fs.readFileSync(path.join(FIXDIR, n), 'utf8'));
const body = `
const __mods = {
${modBlock}
};
const __cache = Object.create(null);
function __norm(base, spec) {
  const parts = base.split('/'); parts.pop();
  for (const seg of spec.split('/')) { if (seg === '.' || seg === '') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}
function __load(name) {
  if (__cache[name]) return __cache[name].exports;
  const fn = __mods[name]; if (!fn) throw new Error('未內嵌的模組：' + name);
  const mod = { exports: {} }; __cache[name] = mod;
  fn.call(mod.exports, mod, mod.exports, (spec) => { if (spec[0] !== '.') throw new Error('不提供 Node 模組：' + spec); return __load(__norm(name, spec)); });
  return mod.exports;
}
const NN = __load('gpu/nn_ops.js');
const FS = __load('gpu/full_param_step_device.js');
const FXS = ${JSON.stringify(FX)};
const g = await NN.getDevice(navigator);
const dev = g.dev;
const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);
const R = { fixtures: {} };
for (const name of Object.keys(FXS)) {
  const fx = FXS[name];
  const rowRes = { steps: fx.steps, maxLossAbs: 0, maxGradNormRel: 0, maxGradNormAbs: 0, step1ParamGradRelMax: null, resume: null, nonFinite: false };
  // 20 步連續（applyUpdate 預設＝真的更新）
  let S = FS.makeResidentState(dev, fx.cfg, fx.init);
  for (let s = 0; s < fx.steps; s++) {
    const r = await FS.fullParamStepDevice({ nn: NN, device: dev, state: S, seqs: [fx.batches[s]], lr: fx.lr, wd: fx.wd, clip: fx.clip });
    if (!Number.isFinite(r.loss) || !Number.isFinite(r.gradNorm)) rowRes.nonFinite = true;
    rowRes.maxLossAbs = Math.max(rowRes.maxLossAbs, Math.abs(r.loss - fx.perStep[s].loss));
    rowRes.maxGradNormAbs = Math.max(rowRes.maxGradNormAbs, Math.abs(r.gradNorm - fx.perStep[s].gradNorm));
    rowRes.maxGradNormRel = Math.max(rowRes.maxGradNormRel, relErr(r.gradNorm, fx.perStep[s].gradNorm));
  }
  const finalCont = await FS.readResident(dev, S);
  // 第 1 步逐參數梯度（新狀態，applyUpdate:false，不改參數）
  const S1 = FS.makeResidentState(dev, fx.cfg, fx.init);
  const g1 = await FS.fullParamStepDevice({ nn: NN, device: dev, state: S1, seqs: [fx.batches[0]], lr: fx.lr, wd: fx.wd, clip: fx.clip, applyUpdate: false });
  let pg = 0;
  for (const nm of Object.keys(fx.step1Grads)) {
    const ref = fx.step1Grads[nm], got = g1.grads[nm];
    let rm = 0, em = 0; for (let i = 0; i < ref.length; i++) { rm = Math.max(rm, Math.abs(ref[i])); em = Math.max(em, Math.abs(got[i] - ref[i])); }
    pg = Math.max(pg, em / Math.max(rm, 1e-30));
  }
  rowRes.step1ParamGradRelMax = pg;
  // 續訓：前 10 步 → 存檔 → 新狀態載入 → 續跑 10 步；與連續 20 步逐位比對
  const A = FS.makeResidentState(dev, fx.cfg, fx.init);
  for (let s = 0; s < 10; s++) await FS.fullParamStepDevice({ nn: NN, device: dev, state: A, seqs: [fx.batches[s]], lr: fx.lr, wd: fx.wd, clip: fx.clip });
  const ck = await FS.readResident(dev, A);
  const Bst = FS.loadResident(dev, FS.makeResidentState(dev, fx.cfg, fx.init), ck);
  for (let s = 10; s < fx.steps; s++) await FS.fullParamStepDevice({ nn: NN, device: dev, state: Bst, seqs: [fx.batches[s]], lr: fx.lr, wd: fx.wd, clip: fx.clip });
  const finalResume = await FS.readResident(dev, Bst);
  let rd = 0;
  for (const k of Object.keys(finalCont.P)) for (const part of ['P', 'M', 'V']) { const a = finalCont[part][k], b = finalResume[part][k]; for (let i = 0; i < a.length; i++) rd = Math.max(rd, Math.abs(a[i] - b[i])); }
  rowRes.resume = { maxAbsDiffVsContinuous: rd, stepCounter: finalResume.t };
  R.fixtures[name] = rowRes;
}
console.log('[fullstep-parity] ' + JSON.stringify(R));
return R;
`;
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size);
