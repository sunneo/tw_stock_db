'use strict';
// 純 CPU GEMM 基準量測（node，單執行緒，沒有 GPU）。量測時間取最小值（重複 REPS 次），報告 GFLOP/s。
// 用法：node cpu_gemm_bench.js [kernelName ...]   kernelName: baseline | packed | wasm ...（沒給就跑全部已註冊的）
const { cpuRowsRef } = require('./cpu_share.js');
let gemmPacked = null, gemmPackedSimd = null;
try { gemmPacked = require('./cpu_gemm.js').gemmPacked; } catch (_) { /* 尚未建立時略過 */ }
try { gemmPackedSimd = require('./cpu_gemm.js').gemmPackedSimd; } catch (_) { /* 尚未建立時略過 */ }

const REPS = 3;
const SIZES = [[256, 256, 256], [512, 512, 512], [1024, 1024, 1024]];

function fill(n, seed) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + seed * 12345) >>> 0) % 2001) / 1000 - 1;
  return x;
}

function timeKernel(fn, m, k, n) {
  const A = fill(m * k, 1), B = fill(k * n, 2);
  fn(A, B, m, k, n, false);            // 預熱（JIT）
  let best = Infinity;
  for (let r = 0; r < REPS; r++) {
    const t0 = process.hrtime.bigint();
    fn(A, B, m, k, n, false);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  const gflops = (2 * m * k * n) / (best * 1e-3) / 1e9;
  return { ms: best, gflops };
}

const KERNELS = {
  baseline: (A, B, m, k, n, tb) => cpuRowsRef(A, B, m, k, n, tb),
};
if (gemmPacked) KERNELS.packed = (A, B, m, k, n, tb) => gemmPacked(A, B, m, k, n, tb);
if (gemmPackedSimd) KERNELS.packedSimd = (A, B, m, k, n, tb) => gemmPackedSimd(A, B, m, k, n, tb);

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(KERNELS);
const out = [];
for (const name of names) {
  const fn = KERNELS[name];
  if (!fn) { out.push(`${name}：未註冊，略過`); continue; }
  for (const [m, k, n] of SIZES) {
    const r = timeKernel(fn, m, k, n);
    out.push(`${name} ${m}x${k}x${n}：${r.ms.toFixed(2)} ms，${r.gflops.toFixed(3)} GFLOP/s（單執行緒）`);
  }
}
console.log(out.join('\n'));
