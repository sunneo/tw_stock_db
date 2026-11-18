'use strict';
// 分攤的 CPU 段模式測試（node，假 Worker 跑真的 Worker 原始碼）：cpuSegment:'worker' 強制 CPU 段走工作者；預設仍依門檻走主執行緒；兩者結果都正確。
const assert = require('assert');
const vm = require('vm');
const CS = require('./cpu_share.js');
const G = require('./cpu_gemm.js');

const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let mx = 0; for (let i = 0; i < r.length; i++) mx = Math.max(mx, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return mx; };
function fakeWorker() {
  const w = { onmessage: null, postMessage(msg) {
    const self = { postMessage: (out) => { queueMicrotask(() => w.onmessage && w.onmessage({ data: out })); } };
    const ctx = { self, Float32Array, Map, Set, Math, Number, String, Object, Array, Error, WebAssembly, TextEncoder, Uint8Array };
    vm.createContext(ctx); vm.runInContext(CS.workerSource(), ctx); ctx.self.onmessage({ data: msg });
  } };
  return w;
}
const m = 512, k = 512, n = 512;
const A = fill(m * k, 1), B = fill(k * n, 2);
const gpuFn = (Asub, mG) => G.gemmPackedSimd(Asub, B, mG, k, n, {});   // 假 GPU：用同一個 SIMD 核心算（只要結果正確即可）
const ref = G.gemmNaive(A, B, m, k, n, false);

(async () => {
  for (const mode of ['auto', 'worker']) {
    const sh = CS.createCpuShare({ cores: 4, makeWorker: () => fakeWorker(), profile: true });
    sh._setRates(1e7, 1.26e7);
    const out = await sh.run(gpuFn, A, B, m, k, n, { cpuSegment: mode === 'worker' ? 'worker' : undefined });
    assert.strictEqual(out.shared, true, mode + '：應分攤');
    assert.ok(relMax(out.y, ref) <= 1e-5, mode + '：結果錯誤');
    const st = sh.stats();
    if (mode === 'worker') assert.strictEqual(st.cpuBreak.calls, 0, 'worker 模式：CPU 段不應走主執行緒核心');
    else assert.ok(st.cpuBreak.calls >= 1, 'auto 模式：小段應走主執行緒核心');
    console.log(`ok ${mode}：結果正確；主執行緒 CPU 核心呼叫 ${st.cpuBreak.calls} 次；CPU 列數 ${out.info.mCpu}`);
    sh.dispose();
  }
  console.log('cpu_share_segment_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
