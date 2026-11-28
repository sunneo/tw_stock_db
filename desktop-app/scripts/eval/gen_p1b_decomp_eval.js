#!/usr/bin/env node
// P1b 拆解：產生真 Electron（WebGPU）的差分量測評估檔。不改訓練程式，只包住 nn.createBatch 來記錄矩陣乘形狀與派發數。
// 用法：node scripts/eval/gen_p1b_decomp_eval.js <renderer/src 資料夾> <輸出評估檔> [sizes，例：S,M,L] [steps]
// 量測項目（都用同一個批次機制，差分消去固定地板）：
//   地板：空批次（無派發）＋兩次讀回（與一步的讀回數相同）的往返時間
//   每次派發成本：同一批次內 R 次小型 axpy 的斜率（R=400 與 R=50）
//   記憶體頻寬：大型 axpy 的斜率（每次讀 2 寫 1，12 位元組／元素）
//   矩陣乘：一步實際出現的每個形狀，單獨重複派發，斜率得到每次時間與 GFLOP/s
//   實測步：同一設定的完整 fullParamStepDevice（中位數）
const fs = require('fs');
const path = require('path');
const { SIZES } = require('../bench/sizes.js');

const SRC = process.argv[2], out = process.argv[3];
const ONLY = process.argv[4] ? process.argv[4].split(',') : ['S', 'M', 'L'];
const STEPS = Number(process.argv[5]) || 8;
if (!SRC || !out) { console.error('用法：node gen_p1b_decomp_eval.js <renderer/src> <輸出評估檔> [S,M,L] [steps]'); process.exit(2); }
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
const STEPS = ${STEPS}, PEAK_GFLOPS = 300;
const g = await NN.getDevice(navigator);
if (!g.dev) return { error: 'no WebGPU device' };
const dev = g.dev;
const now = () => performance.now();
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rnd = (n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = ((i * 2654435761) % 1000) / 1000 - 0.5; return a; };
const r3 = (x) => Math.round(x * 1000) / 1000;

// 1) 地板：空批次＋兩次讀回
async function floorOnce() {
  const B = NN.createBatch(dev);
  const h1 = B.alloc(1), h2 = B.alloc(1);
  const t0 = now();
  await B.read([[h1, 1], [h2, 1]]);
  return now() - t0;
}
const floorSamples = []; for (let i = 0; i < 30; i++) floorSamples.push(await floorOnce());
const floorMs = med(floorSamples);

// 2) 每次派發成本（小型 axpy，n=64）：斜率 (t400 − t50) / 350
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

// 3) 記憶體頻寬（大型 axpy，n=4M，12 位元組／元素）：斜率 (t8 − t2) / 6
const BWN = 4 * 1024 * 1024;
const b2 = [], b8 = [];
for (let i = 0; i < 3; i++) { b2.push(await axpyBatch(2, BWN)); b8.push(await axpyBatch(8, BWN)); }
const perPassMs = (med(b8) - med(b2)) / 6;
const bwGBs = (BWN * 12) / (perPassMs / 1000) / 1e9;

// 4) 矩陣乘單獨量測：形狀 M,K,N,transA,transB；斜率 (t10 − t2) / 8
async function mmBatch(M, K, N, fl, R) {
  const B = NN.createBatch(dev);
  const A = B.upload(rnd(M * K)), W = B.upload(rnd(K * N));
  const t0 = now();
  let last = null; for (let r = 0; r < R; r++) last = B.matmul(A, W, M, K, N, fl);
  await B.read([[last, 1]]);
  return now() - t0;
}
// 批次大小依 FLOPs 調整：每次提交約 0.4 GFLOP 以內（避開 GPU 看門狗），R_lo 與 R_hi 的差距要夠大才量得出斜率
async function mmPerCall(M, K, N, fl) {
  const flops = 2 * M * K * N;
  const rHi = Math.min(60, Math.max(8, Math.floor(4e8 / flops))), rLo = Math.max(2, Math.floor(rHi / 5));
  const a = [], b = [];
  for (let i = 0; i < 5; i++) { a.push(await mmBatch(M, K, N, fl, rLo)); b.push(await mmBatch(M, K, N, fl, rHi)); }
  return Math.max(1e-6, (med(b) - med(a)) / (rHi - rLo));
}

// 5) 每個規模：記錄一步的矩陣乘形狀（包住 createBatch），量實測步與派發數
const results = [];
const mmCache = new Map();
for (const sz of SIZES) {
  const cfg = sz.cfg;
  let lastBatch = null;
  const shimNn = { createBatch: (dev2) => {
    const b = NN.createBatch(dev2);
    const rec = []; const om = b.matmul;
    b.matmul = (A, Bm, M, K, N, fl) => { rec.push({ M: M, K: K, N: N, fl: { transA: !!(fl && fl.transA), transB: !!(fl && fl.transB) } }); return om(A, Bm, M, K, N, fl); };
    b.__rec = rec; lastBatch = b; return b;
  } };
  try {
    const init = LD.makeInit(cfg, 1);
    const S = FS.makeResidentState(dev, cfg, init);
    const seq = Array.from({ length: cfg.T + 1 }, (_, i) => (i * 37 + 11) % cfg.V);
    const stepOnce = () => FS.fullParamStepDevice({ nn: shimNn, device: dev, state: S, seqs: [seq], lr: 1e-3, wd: 0.01, clip: 1 });
    const warm = await stepOnce();
    const rec = lastBatch.__rec.slice();
    const st = warm.stats || {};
    const stepTimes = [];
    for (let s = 0; s < STEPS; s++) { const r = await stepOnce(); stepTimes.push(r.ms); }
    const stepMs = med(stepTimes.slice(1));
    // 同形狀歸併
    const byKey = new Map();
    for (const c of rec) { const k = [c.M, c.K, c.N, c.fl.transA ? 1 : 0, c.fl.transB ? 1 : 0].join('x'); if (!byKey.has(k)) byKey.set(k, { M: c.M, K: c.K, N: c.N, fl: c.fl, count: 0 }); byKey.get(k).count++; }
    const shapes = [];
    let matmulMsSum = 0;
    for (const v of byKey.values()) {
      const k = [v.M, v.K, v.N, v.fl.transA ? 1 : 0, v.fl.transB ? 1 : 0].join('x');
      if (!mmCache.has(k)) mmCache.set(k, await mmPerCall(v.M, v.K, v.N, v.fl));
      const per = mmCache.get(k);
      const flops = 2 * v.M * v.K * v.N;
      matmulMsSum += per * v.count;
      shapes.push({ shape: v.M + 'x' + v.K + 'x' + v.N + (v.fl.transA ? ' Aᵀ' : '') + (v.fl.transB ? ' Bᵀ' : ''), count: v.count, msPerCall: r3(per), gflops: r3(flops / (per / 1000) / 1e9), pctPeak: r3(100 * flops / (per / 1000) / 1e9 / PEAK_GFLOPS) });
    }
    const nonMatmulDisp = (st.dispatches || 0) - rec.length;
    const predDispMs = nonMatmulDisp * dispOverheadMs;
    const pred = floorMs + matmulMsSum + predDispMs;
    const entry = { size: sz.name, dispatches: st.dispatches, matmulCalls: rec.length, nonMatmulDispatches: nonMatmulDisp, readbacks: st.readbacks, submits: st.submits, stepMsMedian: r3(stepMs), floorMs: r3(floorMs), dispOverheadMs: r3(dispOverheadMs), predFloorMs: r3(floorMs), predMatmulMs: r3(matmulMsSum), predNonMatmulDispatchMs: r3(predDispMs), predTotalMs: r3(pred), residualMs: r3(stepMs - pred), shapes: shapes };
    results.push(entry); console.log('[p1b-size] ' + JSON.stringify(entry));
  } catch (e) {
    const entry = { size: sz.name, error: String((e && e.message) || e) }; results.push(entry); console.log('[p1b-size] ' + JSON.stringify(entry));
  }
}
const out = { adapter: { info: g.dev && (g.adapter && g.adapter.info) || null }, floorMs: r3(floorMs), floorSamples: floorSamples.map(r3), dispOverheadMs: r3(dispOverheadMs), copyBandwidthGBs: r3(bwGBs), copyPerPassMs: r3(perPassMs), sizes: results };
console.log('[p1b-result] ' + JSON.stringify(out));
return out;
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'modules', mods.size, 'sizes', ONLY.join(','), 'steps', STEPS);
