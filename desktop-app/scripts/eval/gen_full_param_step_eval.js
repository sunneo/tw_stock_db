#!/usr/bin/env node
// 產生 P1 的「全參數整步（常駐 GPU）」對拍評估檔（full_param_step_device.js）（給 FA_DEBUG_EVAL_FILE 用，在真的渲染行程裡執行）。
// 用法：node scripts/eval/gen_full_param_step_eval.js <輸出評估檔>
// 做的事：
//   1. 從 renderer/src 收集需要的 CommonJS 模組（依 require('./…') 的靜態相依，不用 grep 遞迴）。
//   2. 把這些模組原文與兩份 PyTorch fixture（fp64）內嵌進評估檔（渲染行程讀不到磁碟）。
//   3. 評估檔內用極小的 require 載入器執行模組，跑 cudaweb 矩陣乘的 20 步全參數訓練，逐步比對 PyTorch 損失與梯度範數。
// 評估檔不進版控（輸出在暫存資料夾）；本腳本與其結果記錄在 PLAN。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const SRC = path.join(root, 'renderer', 'src');
const FIX = path.join(SRC, 'studio', 'fixtures');
const out = process.argv[2];
if (!out) { console.error('用法：node gen_full_param_step_eval.js <輸出評估檔>'); process.exit(2); }

const ENTRY = ['gpu/nn_ops.js', 'gpu/full_param_step_device.js'];
const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');
const mods = new Map();
const queue = ENTRY.map((e) => path.join(SRC, e));
while (queue.length) {
  const abs = queue.shift(); const r = rel(abs);
  if (mods.has(r)) continue;
  if (!fs.existsSync(abs)) throw new Error('找不到模組：' + r);
  const srcText = fs.readFileSync(abs, 'utf8');
  mods.set(r, srcText);
  const re = /require\((['"])(\.[^'"]+)\1\)/g; let m;
  while ((m = re.exec(srcText))) queue.push(path.resolve(path.dirname(abs), m[2]));
}
const fixtures = {};
for (const f of ['full_param_parity_f64.json', 'full_param_parity_gqa_qkn_f64.json']) fixtures[f] = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const modBlock = [...mods.entries()].map(([r, s]) => JSON.stringify(r) + ': function (module, exports, require) {\n' + s + '\n}').join(',\n');
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
const FX = ${JSON.stringify(fixtures)};
const R = { fixtures: {} };
const NN = __load('gpu/nn_ops.js');
const FS = __load('gpu/full_param_step_device.js');
const g = await NN.getDevice(navigator);
R.env = { webgpu: !!(navigator && navigator.gpu), device: !!g.dev, reason: g.reason || null };
if (!g.dev) { R.note = 'WebGPU 裝置不可用'; return R; }
for (const name of Object.keys(FX)) {
  const fx = FX[name];
  const S = FS.makeResidentState(g.dev, fx.cfg, fx.init);
  let maxLoss = 0, maxGn = 0; const per = []; const ms = [];
  let calls0 = null;
  for (let s = 0; s < fx.steps; s++) {
    const r = await FS.fullParamStepDevice({ nn: NN, device: g.dev, state: S, seqs: [fx.batches[s]], lr: fx.lr, wd: fx.wd, clip: fx.clip });
    const dl = Math.abs(r.loss - fx.perStep[s].loss), dg = Math.abs(r.gradNorm - fx.perStep[s].gradNorm);
    maxLoss = Math.max(maxLoss, dl); maxGn = Math.max(maxGn, dg); per.push(+dl.toExponential(2)); ms.push(+r.ms.toFixed(1));
    if (s === 0) calls0 = r.stats;
  }
  R.fixtures[name] = { steps: fx.steps, maxLossAbsDiff: maxLoss, maxGradNormAbsDiff: maxGn, msPerStep: ms, lossDiffByStep: per, statsStep1: calls0 };
}
return R;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'bytes', body.length);
