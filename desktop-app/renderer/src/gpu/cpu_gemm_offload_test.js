'use strict';
// 卸載交界點純函式測試（node）
const assert = require('assert');
const O = require('./cpu_gemm_offload.js');

assert.strictEqual(O.flopsOf(2, 3, 4), 48);
// 沒有 GPU → CPU
assert.strictEqual(O.offloadDecision({ m: 512, k: 512, n: 512, gpuReady: false, crossoverFlops: 1e9 }).route, 'cpu');
// 尚未量測 → GPU（不自己編門檻）
assert.strictEqual(O.offloadDecision({ m: 8, k: 8, n: 8, crossoverFlops: null }).route, 'gpu');
assert.strictEqual(O.offloadDecision({ m: 8, k: 8, n: 8 }).route, 'gpu');
// 量測的交界點：小於 → CPU，不小於 → GPU（邊界 = GPU）
const x = O.flopsOf(64, 64, 64);            // 524288
assert.strictEqual(O.offloadDecision({ m: 32, k: 64, n: 64, crossoverFlops: x }).route, 'cpu');
assert.strictEqual(O.offloadDecision({ m: 64, k: 64, n: 64, crossoverFlops: x }).route, 'gpu');
assert.strictEqual(O.offloadDecision({ m: 128, k: 64, n: 64, crossoverFlops: x }).route, 'gpu');
// CPU 在各種大小都不輸 → 全 CPU
assert.strictEqual(O.offloadDecision({ m: 4096, k: 4096, n: 4096, crossoverFlops: Infinity }).route, 'cpu');
// 交界點非正 → 永遠 GPU
assert.strictEqual(O.offloadDecision({ m: 2, k: 2, n: 2, crossoverFlops: 0 }).route, 'gpu');
assert.strictEqual(O.offloadDecision({ m: 2, k: 2, n: 2, crossoverFlops: -5 }).route, 'gpu');
// 理由字串存在
assert.ok(O.offloadDecision({ m: 1, k: 1, n: 1, crossoverFlops: 10 }).reason.length > 0);
console.log('cpu_gemm_offload_test：全部通過（9 組）');
