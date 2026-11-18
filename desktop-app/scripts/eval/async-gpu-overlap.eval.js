// /async-gpu-overlap：第二次（也是最後一次）真機。修正版設計：
// (1) CPU 工作分塊（每塊約 2 毫秒），塊與塊之間 await 一個 macrotask，讓 GPU 的提交與讀回回呼能在 CPU 工作期間被處理。
// (2) GPU 工作拆成 K 次 matmul，每次單次 sync 量測都 ≤ 50 毫秒（超過就中止、不硬跑）；整體目標約 120 毫秒。
// (3) 每種量測跑 3 次、取中位數；順序交錯（GPU 單獨、CPU 單獨、串列、重疊）。
// 用互斥鎖 requestExclusiveGpu。結果含 GPU 型號、CPU 忙迴圈耗時、GPU 耗時、串列與重疊總耗時。
// 用法同 async-gpu.eval.js（獨立 --user-data-dir、換埠、FA_DISABLE_MAIN_OVERLAY=1，不加 --disable-gpu）。
const fa = window.fa;
const R = { runs: {} };
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const rnd = (n, seed) => Array.from({ length: n }, (_, i) => ((i * 9301 + 49297 + seed * 1237) % 233280) / 233280);
const mkArgs = (N) => ({ a: rnd(N * N, 1), b: rnd(N * N, 2), m: N, k: N, n: N });
const cpuBlock = (iters) => { let s = 0; for (let i = 0; i < iters; i++) s += Math.sqrt(i + s * 1e-9 + 1); return s; };
let ITERS_PER_MS = 0;
const calibrateCpu = () => { const t0 = performance.now(); cpuBlock(400000); const ms = performance.now() - t0; ITERS_PER_MS = 400000 / Math.max(ms, 1e-3); return ITERS_PER_MS; };
// 分塊 CPU 工作：每塊約 2 毫秒，塊間讓出；回傳實際耗時（毫秒）
const cpuWorkMs = async (targetMs) => {
  const t0 = performance.now();
  while (performance.now() - t0 < targetMs) { cpuBlock(Math.max(1000, Math.round(ITERS_PER_MS * 2))); await sleep0(); }
  return performance.now() - t0;
};
const syncMatmul = async (args) => { const t0 = performance.now(); const r = await fa._pyBridgeGpu('call', { op: 'matmul', args }); return { ms: performance.now() - t0, result: r.result }; };
const submitMatmul = (args) => fa._gpuAsync('submit', { name: 'call', body: { op: 'matmul', args, out_bin: null }, stream: 1 });
const relErr = (x, ref) => { let m = 0; for (let i = 0; i < ref.length; i++) m = Math.max(m, Math.abs(x[i] - ref[i]) / Math.max(1, Math.abs(ref[i]))); return m; };
const refMatmul = (args) => { const { a, b, m, k, n } = args; const C = new Array(m * n).fill(0); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let t = 0; t < k; t++) s += a[i * k + t] * b[t * n + j]; C[i * n + j] = s; } return C; };

R.lost = null;
try {
  const rt = fa._cudawebRuntime && fa._cudawebRuntime();
  const dev = rt && (rt.device || rt._device);
  R.lostHook = !!(dev && dev.lost);
  if (dev && dev.lost) dev.lost.then((i) => { R.lost = { reason: i.reason, message: i.message }; });
} catch (e) { R.lostHook = 'err: ' + ((e && e.message) || e); }
try {
  const ad = await navigator.gpu.requestAdapter();
  const i = ad && ad.info;
  R.gpu = i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : 'adapter.info 不可用';
} catch (e) { R.gpu = 'err: ' + ((e && e.message) || e); }
R.infoBefore = await fa._pyBridgeGpu('info', {});
R.loaded = { hasGpuAsync: typeof fa._gpuAsync === 'function' };
let release = null;
try {
  release = await fa._qwenModule().nn.requestExclusiveGpu('async-gpu-overlap-real');
  calibrateCpu();
  R.cpuItersPerMs = Math.round(ITERS_PER_MS);
  // 形狀選擇：先暖機，再量 256 與 128；單次超過 50 毫秒就用較小的形狀
  const a256 = mkArgs(256), a128 = mkArgs(128);
  await syncMatmul(a128);
  const t128 = (await syncMatmul(a128)).ms;
  const t256 = (await syncMatmul(a256)).ms;
  R.estimate = { t128, t256 };
  const N = t256 <= 50 ? 256 : 128;
  const args = N === 256 ? a256 : a128;
  const tN = N === 256 ? t256 : t128;
  if (tN > 100) throw new Error('單次 matmul 超過 100 毫秒（' + tN.toFixed(1) + '），中止，不硬跑');
  const K = Math.min(60, Math.max(1, Math.round(120 / tN)));
  const target = K * tN;
  R.shape = { N, K, perDispatchMsEst: tN, gpuTargetMs: target };
  // 正確性（不計時）：第一塊的結果與 CPU 參考比對
  const hWarm = await submitMatmul(args);
  const wWarm = await fa._gpuAsync('wait', { handle: hWarm.handle });
  await fa._gpuAsync('forget', { handle: hWarm.handle });
  R.correctRelErr = relErr(wWarm.result, refMatmul(args));
  const pushRun = (k, v) => { (R.runs[k] = R.runs[k] || []).push(v); };
  for (let r = 0; r < 3; r++) {
    // GPU 單獨：K 次 submit，等全部完成（不做 CPU）
    let t0 = performance.now();
    const hs = []; for (let i = 0; i < K; i++) hs.push(await submitMatmul(args));
    for (const h of hs) await fa._gpuAsync('wait', { handle: h.handle });
    pushRun('gpuOnlyMs', performance.now() - t0);
    for (const h of hs) await fa._gpuAsync('forget', { handle: h.handle });
    // CPU 單獨
    pushRun('cpuOnlyMs', await cpuWorkMs(target));
    // 串列：K 次同步 matmul，接著 CPU 工作
    t0 = performance.now();
    for (let i = 0; i < K; i++) await syncMatmul(args);
    await cpuWorkMs(target);
    pushRun('serialMs', performance.now() - t0);
    // 重疊：K 次 submit，立刻做 CPU 工作（分塊讓出），最後才等
    t0 = performance.now();
    const hs2 = []; for (let i = 0; i < K; i++) hs2.push(await submitMatmul(args));
    await cpuWorkMs(target);
    for (const h of hs2) await fa._gpuAsync('wait', { handle: h.handle });
    pushRun('overlapMs', performance.now() - t0);
    for (const h of hs2) await fa._gpuAsync('forget', { handle: h.handle });
  }
  R.median = {};
  for (const k of Object.keys(R.runs)) R.median[k] = Math.round(med(R.runs[k]) * 10) / 10;
  R.medianSerialMinusOverlap = Math.round((R.median.serialMs - R.median.overlapMs) * 10) / 10;
  R.infoAfter = await fa._pyBridgeGpu('info', {});
} catch (e) {
  R.error = String((e && e.message) || e);
} finally {
  if (release) release();
}
await sleep0();
R.deviceLost = R.lost;
return R;
