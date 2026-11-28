#!/usr/bin/env node
// 產生 cudaweb 全參數步的速度量測評估檔（真的 Electron 渲染行程，WebGPU）。
// 用法：node scripts/eval/gen_step_bench_eval.js <renderer/src 資料夾> <輸出評估檔> [steps]
// 規模來自 scripts/bench/sizes.js（S、M、L、XL）；批次 1 條序列；前 5 步暖機，取其後的中位數。
// 每步時間取自 fullParamStepDevice 回傳的 ms（含一次提交與兩次讀回，與 llm_full_run 的每步毫秒同一口徑）。
// 評估結果含轉接器資訊（adapter.info、限制值）與 JS 轉換的粗估（若 stats 有提供）。
const fs = require('fs');
const path = require('path');
const { SIZES } = require('../bench/sizes.js');

const SRC = process.argv[2], out = process.argv[3], STEPS = Number(process.argv[4]) || 30;
const ONLY = process.argv[5] ? process.argv[5].split(',') : null;   // 例：S,M,L（略過會造成裝置遺失的 XL）
if (!SRC || !out) { console.error('用法：node gen_step_bench_eval.js <renderer/src> <輸出評估檔> [steps]'); process.exit(2); }
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
const SIZES = ${JSON.stringify(ONLY ? SIZES.filter((z) => ONLY.indexOf(z.name) >= 0) : SIZES)};
const STEPS = ${STEPS}, WARM = 5;
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device', reason: g.reason || null };
let adapter = null;
try {
  const ad = await navigator.gpu.requestAdapter();
  if (ad) adapter = { info: ad.info ? { vendor: ad.info.vendor, architecture: ad.info.architecture, device: ad.info.device, description: ad.info.description } : null, features: Array.from(ad.features || []).slice(0, 20), maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize, maxBufferSize: ad.limits.maxBufferSize, maxComputeWorkgroupStorageSize: ad.limits.maxComputeWorkgroupStorageSize };
} catch (e) { adapter = { error: String((e && e.message) || e) }; }
const res = [];
console.log("[bench-adapter] " + JSON.stringify(adapter));
for (const sz of SIZES) {
  const cfg = sz.cfg;
  try {
    const init = LD.makeInit(cfg, 1);
    const S = FS.makeResidentState(g.dev, cfg, init);
    const seq = Array.from({ length: cfg.T + 1 }, (_, i) => (i * 37 + 11) % cfg.V);
    const ms = [];
    for (let s = 0; s < STEPS; s++) {
      const r = await FS.fullParamStepDevice({ nn: NN, device: g.dev, state: S, seqs: [seq], lr: 1e-3, wd: 0.01, clip: 1 });
      ms.push(r.ms);
    }
    const steady = ms.slice(WARM).slice().sort((a, b) => a - b);
    const entry = { size: sz.name, cfg, steps: STEPS, warmup: WARM, msFirst: Math.round(ms[0] * 100) / 100, msMedian: Math.round(steady[Math.floor(steady.length / 2)] * 100) / 100, msMin: Math.round(steady[0] * 100) / 100, msMax: Math.round(steady[steady.length - 1] * 100) / 100 };
    res.push(entry); console.log("[bench-size] " + JSON.stringify(entry));
  } catch (e) {
    const entry = { size: sz.name, cfg, error: String((e && e.message) || e) }; res.push(entry); console.log("[bench-size] " + JSON.stringify(entry));
  }
}
return { backend: 'cudaweb', adapter, sizes: res };
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'sizes', SIZES.length, 'steps', STEPS);
