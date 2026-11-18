// 純 CPU GEMM 真機一次（使用者要求的一次）：完全不碰 GPU（不呼叫 WebGPU、不取互斥鎖）。
// 512×512×512 f32 矩陣乘，比較：(a) 舊核心 cpuRowsRef 單執行緒；(b) 新核心 runCpuOnly 主執行緒（cores=0）；
// (c) 新核心 runCpuOnly 工作者 1／2／4（cores=N）。每個設定暖機一次，之後取 3 次中位數。
// 記錄：核心數、各設定的 GFLOP/s、相對舊核心的加速比、與朴素參考（前 64 列）的最大相對誤差、info（模式、工作者數）。
// 用法同其他真機評估：獨立暫存資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1、不加 --disable-gpu（這裡雖然不用 GPU，仍依既有做法）。
const fa = window.fa;
const CS = fa._qwenModule().cpuShare;
const R = { flopsPerRun: 2 * 512 * 512 * 512, runs: {} };
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const N = 512;
const rnd = (n, seed) => Float32Array.from({ length: n }, (_, i) => ((i * 9301 + 49297 + seed * 1237) % 233280) / 233280 - 0.5);
const A = rnd(N * N, 1), B = rnd(N * N, 2);
R.cpuCores = navigator.hardwareConcurrency;

// 參考（前 64 列，不計時）
const refRows = 64, ref = new Float32Array(refRows * N);
for (let i = 0; i < refRows; i++) for (let j = 0; j < N; j++) { let s = 0; for (let t = 0; t < N; t++) s += A[i * N + t] * B[t * N + j]; ref[i * N + j] = s; }
const relErr = (y) => { let m = 0; for (let k = 0; k < ref.length; k++) m = Math.max(m, Math.abs(y[k] - ref[k]) / Math.max(1, Math.abs(ref[k]))); return m; };

const gflops = (ms) => Math.round((R.flopsPerRun / (ms * 1e-3) / 1e9) * 100) / 100;
const push = (k, v) => { (R.runs[k] = R.runs[k] || []).push(v); };

// (a) 舊核心單執行緒
{
  let y = null;
  CS.cpuRowsRef(A, B, N, N, N, false);
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now(); y = CS.cpuRowsRef(A, B, N, N, N, false); push('oldSingleMs', performance.now() - t0); await sleep0();
  }
  R.errOld = relErr(y);
}

// (b)(c) 新核心：runCpuOnly；cores=0 為主執行緒，cores=1/2/4 為工作者
const sh = CS.getShared();
for (const c of [0, 1, 2, 4]) {
  sh.setCores(c);
  let last = null;
  await sh.runCpuOnly(A, B, N, N, N, {});        // 暖機（建立工作者、JIT、編譯 wasm）
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    const out = await sh.runCpuOnly(A, B, N, N, N, {});
    push('newCores' + c + 'Ms', performance.now() - t0);
    last = out;
    await sleep0();
  }
  R['info_cores' + c] = last && last.info ? { mode: last.info.mode, workers: last.info.workers, why: last.info.why || null } : null;
  R['err_cores' + c] = relErr(last.y);
}
sh.setCores(0);

R.median = {};
for (const k of Object.keys(R.runs)) R.median[k] = Math.round(med(R.runs[k]) * 10) / 10;
R.gflops = {
  oldSingle: gflops(R.median.oldSingleMs),
  newMain: gflops(R.median.newCores0Ms),
  newWorkers1: gflops(R.median.newCores1Ms),
  newWorkers2: gflops(R.median.newCores2Ms),
  newWorkers4: gflops(R.median.newCores4Ms),
};
R.speedupVsOld = {
  newMain: Math.round((R.median.oldSingleMs / R.median.newCores0Ms) * 100) / 100,
  newWorkers4: Math.round((R.median.oldSingleMs / R.median.newCores4Ms) * 100) / 100,
};
R.errOldVsRef = R.errOld;
return R;
