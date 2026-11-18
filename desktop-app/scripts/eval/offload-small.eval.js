// 整個運算卸載給 CPU 的真機對照（一次）：每個尺寸 N³，比較 (a) 只用 GPU（交界點設為 0，永不卸載）與 (b) 卸載給 CPU 的 SIMD 主執行緒（交界點設為 Infinity）。
// 每種 5 次取中位數；GPU 段在互斥鎖內量。記錄：每次實際走的 kernel、結果與參考（前 64 列）的最大相對誤差、Profile 留下的交界點（若有）。
// 用法同其他真機評估：獨立暫存資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1、不加 --disable-gpu。
const fa = window.fa;
const MM = fa._qwenModule().mm;
const R = { cpuCores: navigator.hardwareConcurrency, sizes: {}, offloadStatus: MM.getOffloadStatus ? MM.getOffloadStatus() : "no getOffloadStatus" };
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const rnd = (n, seed) => Float32Array.from({ length: n }, (_, i) => ((i * 9301 + 49297 + seed * 1237) % 233280) / 233280 - 0.5);
try { const p = JSON.parse(localStorage.getItem('fa_gpu_profile') || 'null'); R.profileCrossover = p ? { crossoverFlops: p.crossoverFlops, crossoverAllCpu: !!p.crossoverAllCpu } : null; } catch (_) { R.profileCrossover = 'err'; }

const runOnce = async (N, A, B, ref) => {
  const ops = { cacheB: true };
  const t0 = performance.now();
  const r = await MM.matmul(A, [N, N], B, [N, N], ops);
  const ms = performance.now() - t0;
  let err = 0;
  for (let k = 0; k < ref.length; k++) err = Math.max(err, Math.abs(r.y[k] - ref[k]) / Math.max(1, Math.abs(ref[k])));
  return { ms, err, kernel: ops.lastKernel || null };
};

let release = null;
try {
  release = await fa._qwenModule().nn.requestExclusiveGpu('offload-small-eval');
  for (const N of [32, 128, 256, 512]) {
    const A = rnd(N * N, 1), B = rnd(N * N, 2);
    const refRows = Math.min(64, N), ref = new Float32Array(refRows * N);
    for (let i = 0; i < refRows; i++) for (let j = 0; j < N; j++) { let s = 0; for (let t = 0; t < N; t++) s += A[i * N + t] * B[t * N + j]; ref[i * N + j] = s; }
    const row = { gpuOnly: [], offload: [] };
    // (a) 只用 GPU
    MM.setOffloadCrossover(0);
    await runOnce(N, A, B, ref);
    for (let r = 0; r < 5; r++) { const x = await runOnce(N, A, B, ref); row.gpuOnly.push(x); await sleep0(); }
    // (b) 卸載給 CPU
    MM.setOffloadCrossover(Infinity);
    await runOnce(N, A, B, ref);
    for (let r = 0; r < 5; r++) { const x = await runOnce(N, A, B, ref); row.offload.push(x); await sleep0(); }
    R.sizes[N] = {
      gpuOnlyMedianMs: Math.round(med(row.gpuOnly.map((x) => x.ms)) * 100) / 100,
      offloadMedianMs: Math.round(med(row.offload.map((x) => x.ms)) * 100) / 100,
      speedup: Math.round((med(row.gpuOnly.map((x) => x.ms)) / med(row.offload.map((x) => x.ms))) * 100) / 100,
      gpuOnlyKernel: row.gpuOnly[0].kernel,
      offloadKernel: row.offload[0].kernel,
      maxRelErrGpuOnly: Math.max(...row.gpuOnly.map((x) => x.err)),
      maxRelErrOffload: Math.max(...row.offload.map((x) => x.err)),
    };
  }
} catch (e) {
  R.error = String((e && e.message) || e);
} finally {
  MM.setOffloadCrossover(null);
  if (release) release();
}
return R;
