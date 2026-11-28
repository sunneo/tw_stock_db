#!/usr/bin/env node
// P1c-2 讀回按需量測：產生真 Electron（WebGPU）評估檔，量三件事（每個規模 S／M／L）：
//   A. 每步讀回（readLoss=true）：每步時間的中位數（含等 GPU 的讀回）
//   B. 連續提交不讀回（readLoss=false）：連續 N 步、最後 onSubmittedWorkDone，總時間 ÷ N＝每步吞吐
//   C. 提交領先量：B 中每次提交本身返回的 CPU 時間加總，與總時間之比（越小代表 CPU 比 GPU 領先越多）
// 讀回成本＝A − B（每步的同步成本）。不改訓練數值；B 的參數與 A 逐位元相同已由 full_param_readloss_test.js 驗證。
// 用法：node scripts/eval/gen_readback_eval.js <renderer/src 資料夾> <輸出評估檔> [S,M,L] [steps]
const fs = require('fs');
const path = require('path');
const { SIZES } = require('../bench/sizes.js');

const SRC = process.argv[2], out = process.argv[3];
const ONLY = process.argv[4] ? process.argv[4].split(',') : ['S', 'M', 'L'];
const STEPS = Number(process.argv[5]) || 8;
if (!SRC || !out) { console.error('用法：node gen_readback_eval.js <renderer/src> <輸出評估檔> [S,M,L] [steps]'); process.exit(2); }
const ENTRY = ['gpu/nn_ops.js', 'gpu/full_param_step_device.js', 'studio/llm_full_data.js'];
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
const FS = __load('gpu/full_param_step_device.js');
const LD = __load('studio/llm_full_data.js');
const SIZES = ${JSON.stringify(SIZES.filter((z) => ONLY.indexOf(z.name) >= 0))};
const STEPS = ${STEPS};
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device' };
const dev = g.dev;
const now = () => performance.now();
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const results = [];
for (const sz of SIZES) {
  const cfg = sz.cfg;
  const seqs = [Array.from({ length: cfg.T + 1 }, (_, i) => (i * 7 + 3) % cfg.V)];
  const init = LD.makeInit(cfg, 1);
  const state = FS.makeResidentState(dev, cfg, init);
  const step = (readLoss) => FS.fullParamStepDevice({ nn: NN, device: dev, state, seqs, lr: 0.01, wd: 0, clip: 1.0, readLoss });
  try {
    for (let i = 0; i < 2; i++) await step(true);                     // 暖機
    // A：每步讀回，每步 wall-clock（含等 GPU）
    const aMs = [];
    for (let i = 0; i < STEPS; i++) { const t0 = now(); await step(true); aMs.push(now() - t0); }
    // B：連續提交不讀回，最後一次等 GPU
    const submitCpu = [];
    const t0 = now();
    for (let i = 0; i < STEPS; i++) { const r = await step(false); submitCpu.push(r.ms); }
    await dev.queue.onSubmittedWorkDone();
    const bTotal = now() - t0;
    const perA = med(aMs), perB = bTotal / STEPS;
    const cpuSum = submitCpu.reduce((a, b) => a + b, 0);
    results.push({ size: sz.name, everyStepReadMs: r3(perA), noReadMsPerStep: r3(perB), readbackCostMs: r3(perA - perB), submitCpuMsPerStep: r3(cpuSum / STEPS), cpuLeadRatio: r3(cpuSum / bTotal), steps: STEPS });
  } catch (e) {
    results.push({ size: sz.name, error: String((e && e.message) || e) });
  }
  console.log('[readback-size] ' + JSON.stringify(results[results.length - 1]));
}
const out = { adapter: { info: (g.adapter && g.adapter.info) || null }, sizes: results };
console.log('[readback-result] ' + JSON.stringify(out));
return out;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'sizes', ONLY.join(','), 'steps', STEPS);
