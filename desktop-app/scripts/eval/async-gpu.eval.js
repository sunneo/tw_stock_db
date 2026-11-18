// /async-gpu：真機一次（WebGPU，不加 --disable-gpu）。一個形狀（64×64 矩陣乘）、先估時間、用互斥鎖量測。
// 量測內容：同步 call、串列（同步 call 後做 CPU）、重疊（gpu.a.submit 後做 CPU，最後 wait）；結果與 CPU 參考比對。
// 用法（Windows，獨立資料夾與埠）：
//   FA_DEBUG_EVAL_FILE=<本檔絕對路徑> FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=17990 FA_BROWSER_CONTROL_NO_LAUNCH=1
//   node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<新暫存資料夾>
// 暫存資料夾要先寫入 main-ext-rev.txt（內容是 main-ext.js 的 REV 字串），避免自動跳更新對話框。
const fa = window.fa;
const R = {};
const N = 64;
const rnd = (n) => Array.from({ length: n }, (_, i) => ((i * 9301 + 49297) % 233280) / 233280);
const A = rnd(N * N);
const B = rnd(N * N);
const args = { a: A, b: B, m: N, k: N, n: N };
const cpuRef = new Array(N * N).fill(0);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  let s = 0;
  for (let t = 0; t < N; t++) s += A[i * N + t] * B[t * N + j];
  cpuRef[i * N + j] = s;
}
const maxErr = (x) => {
  if (!Array.isArray(x) || x.length !== cpuRef.length) return 'bad-shape';
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - cpuRef[i]));
  return m;
};
const burn = (ms) => {
  const t0 = performance.now();
  let s = 0;
  while (performance.now() - t0 < ms) s += Math.sqrt(s + 1);
  return s;
};
R.loaded = { hasGpuAsync: typeof fa._gpuAsync === 'function', hasQueueGet: typeof fa._gpuAsyncGet === 'function' };
try {
  R.infoBefore = await fa._pyBridgeGpu('info', {});
  const NN = fa._qwenModule().nn;
  const release = await NN.requestExclusiveGpu('async-gpu-real-eval');
  try {
    // 1. 估時間：第一次暖機不計，第二次量同步 call 的時間
    await fa._pyBridgeGpu('call', { op: 'matmul', args });
    let t0 = performance.now();
    const s1 = await fa._pyBridgeGpu('call', { op: 'matmul', args });
    R.tSync = performance.now() - t0;
    R.syncErr = maxErr(s1.result);
    R.layer = s1.layer || '';
    // 2. 串列：同步 call，再做等同 tSync 的 CPU 工作
    t0 = performance.now();
    await fa._pyBridgeGpu('call', { op: 'matmul', args });
    burn(R.tSync);
    R.tSerial = performance.now() - t0;
    // 3. 重疊：提交後立刻做 CPU，最後才等
    t0 = performance.now();
    const h = await fa._gpuAsync('submit', { name: 'call', body: { op: 'matmul', args, out_bin: null }, stream: 1 });
    R.tSubmit = performance.now() - t0;
    burn(R.tSync);
    const w = await fa._gpuAsync('wait', { handle: h.handle });
    R.tOverlap = performance.now() - t0;
    R.asyncErr = maxErr(w.result);
    await fa._gpuAsync('forget', { handle: h.handle });
  } finally {
    release();
  }
  R.infoAfter = await fa._pyBridgeGpu('info', {});
} catch (e) {
  R.error = String((e && e.message) || e);
}
return R;
