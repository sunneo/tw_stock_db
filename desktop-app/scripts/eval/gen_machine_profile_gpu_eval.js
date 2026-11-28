#!/usr/bin/env node
// 機器剖析：WebGPU 部分（P1c-1）。產生真 Electron 的評估檔，量 cudaweb 這台機器的實測能力：
//   裝置上限（緩衝區、工作群大小與數量、共用記憶體）、是否支援 shader-f16
//   固定地板（空批次＋兩次讀回）、每次派發成本（斜率）、複製頻寬（斜率）、矩陣乘 GFLOPS（三個形狀，斜率）
// 量測方法與 gen_p1b_decomp_eval.js 相同（差分消去固定成本），只用 nn_ops.js，不跑訓練步。
// 用法：node scripts/eval/gen_machine_profile_gpu_eval.js <renderer/src 資料夾> <輸出評估檔>
// 結果：評估檔印出 [machine-gpu] <JSON>，之後由 scripts/bench/machine_profile.js 讀取組成能力檔。
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2], out = process.argv[3];
if (!SRC || !out) { console.error('用法：node gen_machine_profile_gpu_eval.js <renderer/src> <輸出評估檔>'); process.exit(2); }
const ENTRY = ['gpu/nn_ops.js'];
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
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device' };
const dev = g.dev;
const now = () => performance.now();
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rnd = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = ((i * 2654435761) % 1000) / 1000 - 0.5; return a; };
const r3 = (x) => Math.round(x * 1000) / 1000;

const lim = dev.limits || {};
const limits = {
  maxBufferSize: Number(lim.maxBufferSize) || null,
  maxWorkgroupSize: Number(lim.maxComputeWorkgroupSizeX) || null,
  maxInvocations: Number(lim.maxComputeInvocationsPerWorkgroup) || null,
  maxWorkgroupStorage: Number(lim.maxComputeWorkgroupStorageSize) || null,
  f16: !!(dev.features && dev.features.has && dev.features.has('shader-f16')),
};

// 1) 固定地板：空批次＋兩次讀回
async function floorOnce() {
  const B = NN.createBatch(dev);
  const h1 = B.alloc(1), h2 = B.alloc(1);
  const t0 = now();
  await B.read([[h1, 1], [h2, 1]]);
  return now() - t0;
}
const floorSamples = []; for (let i = 0; i < 30; i++) floorSamples.push(await floorOnce());
const floorMs = med(floorSamples);

// 2) 每次派發成本：小型 axpy（n=64），斜率 (t400 − t50) / 350
async function axpyBatch(R, n) {
  const B = NN.createBatch(dev);
  const x = B.upload(rnd(n)), y = B.upload(rnd(n));
  const t0 = now();
  let last = null; for (let r = 0; r < R; r++) last = B.axpy(x, y, 1);
  await B.read([[last, n]]);
  return now() - t0;
}
const d50 = [], d400 = [];
for (let i = 0; i < 5; i++) { d50.push(await axpyBatch(50, 64)); d400.push(await axpyBatch(400, 64)); }
const dispOverheadMs = (med(d400) - med(d50)) / 350;

// 3) 複製頻寬：大型 axpy（n=4M，每元素讀 2 寫 1，12 位元組），斜率 (t8 − t2) / 6
const BWN = 4 * 1024 * 1024;
const b2 = [], b8 = [];
for (let i = 0; i < 3; i++) { b2.push(await axpyBatch(2, BWN)); b8.push(await axpyBatch(8, BWN)); }
const perPassMs = (med(b8) - med(b2)) / 6;
const copyGBs = (BWN * 12) / (perPassMs / 1000) / 1e9;

// 4) 矩陣乘：斜率 (t_hi − t_lo) / (R_hi − R_lo)，每次提交約 0.4 GFLOP 以內（避開看門狗）
async function mmBatch(M, K, N, R) {
  const B = NN.createBatch(dev);
  const A = B.upload(rnd(M * K)), W = B.upload(rnd(K * N));
  const t0 = now();
  let last = null; for (let r = 0; r < R; r++) last = B.matmul(A, W, M, K, N, {});
  await B.read([[last, 1]]);
  return now() - t0;
}
async function mmPerCall(M, K, N) {
  const flops = 2 * M * K * N;
  const rHi = Math.min(60, Math.max(8, Math.floor(4e8 / flops))), rLo = Math.max(2, Math.floor(rHi / 5));
  const a = [], b = [];
  for (let i = 0; i < 5; i++) { a.push(await mmBatch(M, K, N, rLo)); b.push(await mmBatch(M, K, N, rHi)); }
  return Math.max(1e-6, (med(b) - med(a)) / (rHi - rLo));
}
const shapes = [[512, 1024, 1024], [128, 256, 512], [128, 256, 256]];
const matmul = [];
for (const [M, K, N] of shapes) {
  const ms = await mmPerCall(M, K, N);
  matmul.push({ M: M, K: K, N: N, ms: r3(ms), gflops: r3(2 * M * K * N / (ms * 1e-3) / 1e9) });
}
const best = matmul.reduce((a, b) => (b.gflops > a.gflops ? b : a));

const result = {
  adapter: { info: (g.adapter && g.adapter.info) || null },
  limits,
  floorMs: r3(floorMs),
  dispOverheadMs: r3(dispOverheadMs),
  copyGBs: r3(copyGBs),
  matmulGflops: best.gflops,
  matmul,
};
console.log('[machine-gpu] ' + JSON.stringify(result));
return result;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size);
