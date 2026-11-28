#!/usr/bin/env node
// 產生梯度匯出對拍評估檔：用 fixture 的初始參數與第 1 步的批次，呼叫 fullParamStepDevice(applyUpdate:false)，
// 與 PyTorch fp64 參考的 step1Grads 逐名稱比對（相對誤差＝max|g−ref| ÷ max|ref|）；同時確認參數未被更新。
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2], out = process.argv[3], FIX = process.argv[4];
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
const fx = JSON.parse(fs.readFileSync(FIX, 'utf8'));
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
const FX = ${JSON.stringify(fx)};
const g = await NN.getDevice(navigator);
const dev = g.dev;
const state = FS.makeResidentState(dev, FX.cfg, FX.init);
const before = await FS.readResident(dev, state);
const r = await FS.fullParamStepDevice({ nn: NN, device: dev, state, seqs: [FX.batches[0]], lr: FX.lr, wd: FX.wd, clip: FX.clip, applyUpdate: false });
const after = await FS.readResident(dev, state);
let paramMaxDiff = 0;
for (const k of Object.keys(before.P)) for (const part of ['P', 'M', 'V']) { const a = before[part][k], b = after[part][k]; for (let i = 0; i < a.length; i++) paramMaxDiff = Math.max(paramMaxDiff, Math.abs(a[i] - b[i])); }
let refMax = 0, errMax = 0, worst = null, nNames = 0;
for (const nm of Object.keys(FX.step1Grads)) {
  const ref = FX.step1Grads[nm], g2 = r.grads[nm];
  if (!g2) throw new Error('缺少梯度：' + nm);
  nNames++;
  let rm = 0, em = 0;
  for (let i = 0; i < ref.length; i++) { rm = Math.max(rm, Math.abs(ref[i])); em = Math.max(em, Math.abs(g2[i] - ref[i])); }
  refMax = Math.max(refMax, rm);
  if (em / Math.max(rm, 1e-30) > (worst ? worst.rel : 0)) worst = { name: nm, rel: em / Math.max(rm, 1e-30) };
  errMax = Math.max(errMax, em);
}
const out = { applied: r.applied, loss: r.loss, gradNorm: r.gradNorm, refGradNorm: FX.perStep[0].gradNorm, refLoss: FX.perStep[0].loss, names: nNames, paramMaxDiffAfterExport: paramMaxDiff, stepCounter: state.t, gradAbsMaxErr: errMax, gradRefMax: refMax, gradRelMaxErr: worst && worst.rel, worstName: worst && worst.name };
console.log('[grad-export] ' + JSON.stringify(out));
return out;
`;
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size);
