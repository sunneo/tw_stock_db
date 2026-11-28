#!/usr/bin/env node
// 產生 P1 的 cudaweb 真 GPU 對拍評估檔（給 FA_DEBUG_EVAL_FILE 用，在真的渲染行程裡執行）。
// 用法：node scripts/eval/gen_full_param_cudaweb_eval.js <輸出評估檔>
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
if (!out) { console.error('用法：node gen_full_param_cudaweb_eval.js <輸出評估檔>'); process.exit(2); }

const ENTRY = ['gpu/mm_ops.js', 'gpu/cudaweb_runtime.js', 'gpu/nn_ops.js', 'studio/full_param_train.js', 'studio/checkpoint_core.js', 'studio/asset_core.js'];
const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');

// 1) 收集相依（只跟隨相對路徑 require）
const mods = new Map();   // rel → source
const queue = ENTRY.map((e) => path.join(SRC, e));
while (queue.length) {
  const abs = queue.shift(); const r = rel(abs);
  if (mods.has(r)) continue;
  if (!fs.existsSync(abs)) throw new Error('找不到模組：' + r);
  const src = fs.readFileSync(abs, 'utf8');
  mods.set(r, src);
  const re = /require\((['"])(\.[^'"]+)\1\)/g; let m;
  while ((m = re.exec(src))) queue.push(path.resolve(path.dirname(abs), m[2]));
}

// 2) 內嵌
const fixtures = {};
for (const f of ['full_param_parity_f64.json', 'full_param_parity_gqa_qkn_f64.json']) fixtures[f] = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const modBlock = [...mods.entries()].map(([r, src]) => JSON.stringify(r) + ': function (module, exports, require) {\n' + src + '\n}').join(',\n');

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
  const req = (spec) => {
    if (spec[0] !== '.') throw new Error('渲染行程的評估檔不提供 Node 模組：' + spec);
    return __load(__norm(name, spec));
  };
  fn.call(mod.exports, mod, mod.exports, req);
  if (mod.exports && Object.keys(mod.exports).length === 0 && mod.__umd === undefined) { /* 保留 */ }
  return mod.exports;
}
const FX = ${JSON.stringify(fixtures)};
const R = { fixtures: {} };
const t0 = performance.now();
const NN = __load('gpu/nn_ops.js');
const MM = __load('gpu/mm_ops.js');
const RT = __load('gpu/cudaweb_runtime.js');
const T = __load('studio/full_param_train.js');
const g = await NN.getDevice(navigator);
R.env = { webgpu: !!(navigator && navigator.gpu), device: !!g.dev, reason: g.reason || null, ua: navigator.userAgent.slice(0, 120) };
if (!g.dev) { R.note = 'WebGPU 裝置不可用，本次不是 GPU 結果'; return R; }
const rt = RT.createRuntime({ nn: NN, navigator, mm: MM });
const gops = T.gpuOpsFrom(NN, navigator);
for (const name of Object.keys(FX)) {
  const fx = FX[name];
  const be = T.cudawebBackend(rt);
  const m = T.fromInit(fx.cfg, fx.init);
  const st = T.adamInit(m);
  const opt = { lr: fx.lr, wd: fx.wd, clip: fx.clip, backend: be, ops: gops };
  let maxLoss = 0, maxGn = 0; const per = [];
  const t1 = performance.now();
  for (let s = 0; s < fx.steps; s++) {
    const r = await T.trainStep(m, fx.batches[s], st, opt);
    const dl = Math.abs(r.loss - fx.perStep[s].loss), dg = Math.abs(r.gradNorm - fx.perStep[s].gradNorm);
    maxLoss = Math.max(maxLoss, dl); maxGn = Math.max(maxGn, dg);
    per.push(dl);
  }
  R.fixtures[name] = { maxLossAbsDiff: maxLoss, maxGradNormAbsDiff: maxGn, steps: fx.steps, matmulLayer: be.layer, matmulCalls: be.calls, elementwiseOnGpu: 'forward+adamw（rmsnorm/softmax/silu/rope/adamw）；backward 逐元素仍在 CPU', msTotal: Math.round(performance.now() - t1), lossDiffByStep: per.map((x) => +x.toExponential(2)) };
}
// ---- 速度（不是對拍）：較大設定、隨機初始化、暖機 1 步後量 3 步；拆解 矩陣乘（GPU 呼叫的牆鐘）、GPU 逐元素、其餘 ----
const BIG = { V: 2048, d: 256, L: 4, H: 8, kvH: 4, F: 512, T: 128, qkNorm: true };
const hdB = BIG.d / BIG.H, kdB = BIG.kvH * hdB;
let seedB = 7; const rndB = () => { seedB = (seedB * 1103515245 + 12345) % 2147483648; return seedB / 2147483648 - 0.5; };
const mkB = (n, sc) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rndB() * sc; return a; };
const ones = (n) => new Float64Array(n).fill(1);
const bigInit = { emb: mkB(BIG.V * BIG.d, 0.1), nf: ones(BIG.d), layers: [] };
for (let l = 0; l < BIG.L; l++) bigInit.layers.push({ n1: ones(BIG.d), n2: ones(BIG.d), Wq: mkB(BIG.d * BIG.d, 0.06), Wk: mkB(BIG.d * kdB, 0.06), Wv: mkB(BIG.d * kdB, 0.06), Wo: mkB(BIG.d * BIG.d, 0.06), Wg: mkB(BIG.d * BIG.F, 0.06), Wu: mkB(BIG.d * BIG.F, 0.06), Wd: mkB(BIG.F * BIG.d, 0.06), qn: ones(hdB), kn: ones(hdB) });
const bigTok = Array.from({ length: BIG.T + 1 }, () => Math.floor((rndB() + 0.5) * BIG.V));
const timed = (fn, acc) => async (...a) => { const t = performance.now(); try { return await fn(...a); } finally { acc.ms += performance.now() - t; acc.n++; } };
const speedRun = async (label, be, ops) => {
  const accM = { ms: 0, n: 0 }, accO = { ms: 0, n: 0 };
  const be2 = Object.assign({}, be, { matmul: timed(be.matmul, accM) });
  const ops2 = {}; for (const k of Object.keys(ops)) ops2[k] = timed(ops[k], accO);
  const m = T.fromInit(BIG, bigInit); const st = T.adamInit(m);
  const o = { lr: 1e-3, wd: 0.01, clip: 1.0, backend: be2, ops: ops2 };
  await T.trainStep(m, bigTok, st, o);            // 暖機
  accM.ms = 0; accM.n = 0; accO.ms = 0; accO.n = 0;
  const t0 = performance.now(); const losses = [];
  for (let s = 0; s < 3; s++) losses.push((await T.trainStep(m, bigTok, st, o)).loss);
  const total = performance.now() - t0;
  return { label, msPerStep: +(total / 3).toFixed(1), matmulMsPerStep: +(accM.ms / 3).toFixed(1), matmulCallsPerStep: accM.n / 3, gpuElemMsPerStep: +(accO.ms / 3).toFixed(1), gpuElemCallsPerStep: accO.n / 3, otherMsPerStep: +((total - accM.ms - accO.ms) / 3).toFixed(1), losses };
};
R.speed = { config: BIG, tokensPerStep: BIG.T };
R.speed.gpu = await speedRun('cudaweb（矩陣乘＋逐元素 GPU）', T.cudawebBackend(rt), gops);
const cpuAdamw = async (p, g, m, v, t, lr, b1, b2, eps, wd) => { const P2 = new Float64Array(p.length), M2 = new Float64Array(p.length), V2 = new Float64Array(p.length); const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t); for (let i = 0; i < p.length; i++) { M2[i] = b1 * m[i] + (1 - b1) * g[i]; V2[i] = b2 * v[i] + (1 - b2) * g[i] * g[i]; P2[i] = p[i] - lr * wd * p[i] - lr * (M2[i] / c1) / (Math.sqrt(V2[i] / c2) + eps); } return { p: P2, m: M2, v: V2 }; };
const cpuOpsFull = Object.assign({}, T.CPU_OPS, { adamw: cpuAdamw });
R.speed.cpuJs = await speedRun('純 JS（CPU，f64）', T.cpuBackend(), cpuOpsFull);

R.msAll = Math.round(performance.now() - t0);
return R;
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'bytes', body.length);
