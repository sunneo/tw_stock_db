#!/usr/bin/env node
// 產生 trainStepDevice 的每步毫秒量測評估檔（給 FA_DEBUG_EVAL_FILE 用，在真的 Electron 渲染行程裡跑）。
// 用法：node scripts/eval/gen_rope_step_timing_eval.js <renderer/src 資料夾> <輸出評估檔>
// 會從指定的 renderer/src 收集 nn_ops、train_step_device、lora_ref_train 與其相依（靜態 require），內嵌進評估檔。
// 用它量「改前」（以舊提交的 renderer/src 產生）與「改後」（目前工作目錄）的同設定每步毫秒。
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2], out = process.argv[3];
if (!SRC || !out) { console.error('用法：node gen_rope_step_timing_eval.js <renderer/src> <輸出評估檔>'); process.exit(2); }
const ENTRY = ['gpu/nn_ops.js', 'gpu/train_step_device.js', 'studio/lora_ref_train.js'];
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
const NN = __load('gpu/nn_ops.js');
const TS = __load('gpu/train_step_device.js');
const LR = __load('studio/lora_ref_train.js');
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device', reason: g.reason || null };
const cfg = { V: 256, d: 128, L: 4, H: 8, F: 256, r: 8, alpha: 16 };
const seq = Array.from({ length: 65 }, (_, i) => (i * 37 + 11) % cfg.V);
const m = LR.makeModel(cfg, 7);
const st = LR.adamInit(m);
const ms = [], losses = [];
const STEPS = 25;
for (let s = 0; s < STEPS; s++) {
  const t0 = performance.now();
  const R = await TS.trainStepDevice({ nn: NN, device: g.dev, model: m, seqs: [seq], st: st, lr: 1e-2, f16: false });
  ms.push(performance.now() - t0); losses.push(R.loss);
}
const steady = ms.slice(5).slice().sort((a, b) => a - b);
const median = steady[Math.floor(steady.length / 2)];
return { cfg, T: seq.length - 1, steps: STEPS, msFirst: Math.round(ms[0] * 100) / 100, msSteadyMedian: Math.round(median * 100) / 100, msSteadyMin: Math.round(steady[0] * 100) / 100, msSteadyMax: Math.round(steady[steady.length - 1] * 100) / 100, losses: losses.map((x) => Math.round(x * 1e6) / 1e6) };
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size);
