// /hetero-matmul：cudaweb = CPU + GPU 的真機一次（使用者要求的一次）。一個形狀（512×512×512 f32 矩陣乘）。
// 比較：(a) 只用 GPU（CPU 分工關閉，setCores(0)）；(b) GPU＋CPU 分工（mm_ops 走 cpu_share，決策決定比例）。
// 每種跑 5 次取中位數；分工版先暖機 14 次（速率是指數平均，分工版的探測每 10 次一次）。
// 記錄：CPU 核心數、GPU 介面卡資訊、各次採用的比例與 info、結果與參考的最大相對誤差。
// 用互斥鎖 requestExclusiveGpu 包住量測。用法同其他 eval（獨立暫存資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1，不加 --disable-gpu）。
const fa = window.fa;
const R = { runs: {} };
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const N = 512;
const rnd = (n, seed) => Float32Array.from({ length: n }, (_, i) => ((i * 9301 + 49297 + seed * 1237) % 233280) / 233280 - 0.5);
const A = rnd(N * N, 1), B = rnd(N * N, 2);
const MM = fa._qwenModule().mm;
const SH = fa._qwenModule().cpuShare.getShared();
const push = (k, v) => { (R.runs[k] = R.runs[k] || []).push(v); };
const runOnce = async () => {
  const t0 = performance.now();
  const ops = { cacheB: true };   // mm_ops 把 lastInfo／lastKernel 寫在傳入的 ops 物件上，所以要留住這個參考
  const r = await MM.matmul(A, [N, N], B, [N, N], ops);
  return { ms: performance.now() - t0, y: r.y, info: ops.lastInfo || null, kernel: ops.lastKernel || null };
};
R.cpuCores = navigator.hardwareConcurrency;
try {
  const ad = await navigator.gpu.requestAdapter();
  const i = ad && ad.info;
  R.gpu = i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : 'adapter.info 不可用';
} catch (e) { R.gpu = 'err: ' + ((e && e.message) || e); }
R.infoBefore = await fa._pyBridgeGpu('info', {});
let release = null;
try {
  release = await fa._qwenModule().nn.requestExclusiveGpu('hetero-matmul-real');
  // 參考結果（只算一次，不計時）：取前 64 列對拍
  const refRows = 64, ref = new Float32Array(refRows * N);
  for (let i = 0; i < refRows; i++) for (let j = 0; j < N; j++) { let s = 0; for (let t = 0; t < N; t++) s += A[i * N + t] * B[t * N + j]; ref[i * N + j] = s; }
  const relErr = (y) => { let m = 0; for (let k = 0; k < ref.length; k++) m = Math.max(m, Math.abs(y[k] - ref[k]) / Math.max(1, Math.abs(ref[k]))); return m; };
  // (a) 只用 GPU
  SH.setCores(0);
  await runOnce();
  for (let r = 0; r < 5; r++) { const x = await runOnce(); push('gpuOnlyMs', x.ms); R.errGpuOnly = relErr(x.y); R.kernelGpuOnly = x.kernel; await sleep0(); }
  // (b) GPU＋CPU 分工
  SH.setCores(navigator.hardwareConcurrency >= 4 ? 4 : Math.max(1, navigator.hardwareConcurrency - 1));
  R.cpuWorkers = SH.cores();
  for (let w = 0; w < 14; w++) { await runOnce(); await sleep0(); }
  R.sharedAfterWarmup = SH.stats().rate;
  for (let r = 0; r < 5; r++) {
    const x = await runOnce();
    push('heteroMs', x.ms);
    R.errHetero = relErr(x.y);
    R.lastHeteroInfo = x.info;
    R.lastHeteroKernel = x.kernel;
    await sleep0();
  }
  R.median = {};
  for (const k of Object.keys(R.runs)) R.median[k] = Math.round(med(R.runs[k]) * 10) / 10;
  R.speedup = Math.round((R.median.gpuOnlyMs / R.median.heteroMs) * 100) / 100;
  R.shareStats = SH.stats();
} catch (e) {
  R.error = String((e && e.message) || e);
} finally {
  SH.setCores(0);
  if (release) release();
}
R.infoAfter = await fa._pyBridgeGpu('info', {});
return R;
