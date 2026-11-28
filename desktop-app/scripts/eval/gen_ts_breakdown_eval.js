#!/usr/bin/env node
// 逐核心歸因（timestamp-query）：產生真 Electron 的評估檔。每次派發的計算通道寫入起訖時間戳（nn_ops.js 的 o.timestamps，預設關），
// 一步結束時解析，依核心名彙總：次數、總時間（中位數，跨 K 步）、佔 GPU 通道總時間的比例、佔整步牆鐘時間的比例。
// 用法：node scripts/eval/gen_ts_breakdown_eval.js <renderer/src 資料夾> <輸出評估檔> [S,M,L] [steps]
const fs = require('fs');
const path = require('path');
const { SIZES } = require('../bench/sizes.js');

const SRC = process.argv[2], out = process.argv[3];
const ONLY = process.argv[4] ? process.argv[4].split(',') : ['L'];
const STEPS = Number(process.argv[5]) || 3;
if (!SRC || !out) { console.error('用法：node gen_ts_breakdown_eval.js <renderer/src> <輸出評估檔> [S,M,L] [steps]'); process.exit(2); }
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
const adapter = await navigator.gpu.requestAdapter();
const dev = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
const MAX = 1000;   // 查詢數上限 2×1000＝2000，低於多數裝置的 maxQuerySetSize（4096）
const origCB = NN.createBatch;
let TS = null;
NN.createBatch = (d) => origCB(d, TS ? { timestamps: TS } : undefined);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const qs = dev.createQuerySet({ type: 'timestamp', count: 2 * MAX });
const resolveBuf = dev.createBuffer({ size: 8 * 2 * MAX, usage: 0x200 | 0x4 });   // QUERY_RESOLVE | COPY_SRC
const readBuf = dev.createBuffer({ size: 8 * 2 * MAX, usage: 0x1 | 0x8 });        // MAP_READ | COPY_DST
const results = [];
for (const sz of SIZES) {
  const cfg = sz.cfg;
  const seqs = [Array.from({ length: cfg.T + 1 }, (_, i) => (i * 7 + 3) % cfg.V)];
  const state = FS.makeResidentState(dev, cfg, LD.makeInit(cfg, 1));
  const perStepLabels = [], wall = [], passSum = [];
  for (let s = 0; s < STEPS + 1; s++) {
    TS = { qs: qs, resolveBuf: resolveBuf, readBuf: readBuf, max: MAX, labels: [], ns: null };
    const t0 = performance.now();
    await FS.fullParamStepDevice({ nn: NN, device: dev, state, seqs, lr: 0.01, wd: 0, clip: 1.0, readLoss: true });
    const w = performance.now() - t0;
    if (s === 0) continue;                       // 第 0 步是暖機
    const agg = {};
    TS.labels.forEach((lb, k) => { const v = TS.ns[k]; agg[lb] = agg[lb] || { count: 0, ns: 0 }; agg[lb].count++; agg[lb].ns += v; });
    perStepLabels.push(agg);
    wall.push(w);
    passSum.push(TS.ns.reduce((a, b) => a + b, 0) / 1e6);
  }
  const names = Array.from(new Set(perStepLabels.flatMap((a) => Object.keys(a))));
  const wallMs = med(wall), passMs = med(passSum);
  const rows = names.map((nm) => {
    const cnt = med(perStepLabels.map((a) => (a[nm] ? a[nm].count : 0)));
    const ms = med(perStepLabels.map((a) => (a[nm] ? a[nm].ns / 1e6 : 0)));
    return { kernel: nm, count: cnt, msTotal: r3(ms), msPerCall: r3(cnt ? ms / cnt : 0), shareOfPassPct: r3(100 * ms / passMs), shareOfWallPct: r3(100 * ms / wallMs) };
  }).sort((a, b) => b.msTotal - a.msTotal);
  results.push({ size: sz.name, wallMsMedian: r3(wallMs), passSumMsMedian: r3(passMs), gapMsMedian: r3(wallMs - passMs), coveredByNamedPct: r3(100 * passMs / wallMs), kernels: rows, steps: STEPS });
  console.log('[ts-size] ' + JSON.stringify({ size: sz.name, wallMsMedian: r3(wallMs), passSumMsMedian: r3(passMs) }));
}
const out = { adapter: { info: (adapter.info && (adapter.info.description || adapter.info.device)) || null }, sizes: results };
console.log('[ts-result] ' + JSON.stringify(out));
return out;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'sizes', ONLY.join(','), 'steps', STEPS);
