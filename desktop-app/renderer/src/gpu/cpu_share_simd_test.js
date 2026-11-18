'use strict';
// 接線測試（node）：真的執行 cpu_share.workerSource() 產生的 Worker 原始碼（vm 沙箱），確認 SIMD 路徑與參考一致；
// 也確認預設主執行緒的 runCpuOnly（cores=0）走新核心且結果正確。
const assert = require('assert');
const vm = require('vm');
const CS = require('./cpu_share.js');
const G = require('./cpu_gemm.js');
const CW = require('./cpu_gemm_wasm.js');

const fill = (n, s) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let m = 0; for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return m; };

// 1. 跑真正的 Worker 原始碼（沙箱）
function runWorker(msg) {
  const out = [];
  const self = { postMessage: (m) => out.push(m) };
  const ctx = { self, Float32Array, Map, Set, Math, Number, String, Object, Array, Error, WebAssembly, TextEncoder, Uint8Array };
  vm.createContext(ctx);
  vm.runInContext(CS.workerSource(), ctx);
  ctx.self.onmessage({ data: msg });
  assert.strictEqual(out.length, 1, 'Worker 應回覆一次');
  return out[0];
}

{
  const m = 37, k = 53, n = 29;
  const A = fill(m * k, 1), B = fill(k * n, 2);
  // 不轉置
  const res = runWorker({ id: 1, A, B, m, k, n, transB: false, wasm: CW.buildModule() });
  assert.ok(!res.error, 'Worker 出錯：' + res.error);
  const ref = G.gemmNaive(A, B, m, k, n, false);
  assert.ok(relMax(res.C, ref) <= 1e-5, 'Worker SIMD 不轉置結果錯誤');
  console.log('ok Worker 原始碼（SIMD）不轉置：與參考一致');

  // 轉置 B（B 以 n×k 儲存）
  const bT = fill(n * k, 3);
  const res2 = runWorker({ id: 2, A, B: bT, m, k, n, transB: true, wasm: CW.buildModule() });
  assert.ok(!res2.error, 'Worker 出錯：' + res2.error);
  assert.ok(relMax(res2.C, G.gemmNaive(A, bT, m, k, n, { transB: true })) <= 1e-5, 'Worker SIMD 轉置結果錯誤');
  console.log('ok Worker 原始碼（SIMD）轉置 B：與參考一致');

  // 沒有 wasm 位元組：退回 cpuRowsRef，結果仍正確
  const res3 = runWorker({ id: 3, A, B, m, k, n, transB: false });
  assert.ok(relMax(res3.C, ref) <= 1e-5, 'Worker 純 JS 退路結果錯誤');
  console.log('ok Worker 無 wasm 時退回純 JS 參考，結果正確');
}

// 2. 預設主執行緒的 runCpuOnly（cores=0）：走新核心，結果正確
(async () => {
  const sh = CS.createCpuShare({ cores: 0 });
  const m = 40, k = 33, n = 21;
  const A = fill(m * k, 4), B = fill(k * n, 5);
  const r = await sh.runCpuOnly(A, B, m, k, n, {});
  assert.strictEqual(r.info.mode, 'cpu-main');
  assert.ok(relMax(r.y, G.gemmNaive(A, B, m, k, n, false)) <= 1e-5, '主執行緒 runCpuOnly 結果錯誤');
  console.log('ok 主執行緒 runCpuOnly（cores=0）：結果正確');
  sh.dispose();
  console.log('cpu_share_simd_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
