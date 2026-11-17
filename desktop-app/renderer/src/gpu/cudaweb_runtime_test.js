'use strict';
// cudaweb_runtime：rt.matmul 的轉置旗標要原樣交給 mm_ops；沒給旗標時維持原本的不轉置行為。
// 用假的 mm 記錄收到的參數（不需要 GPU）。
const assert = require('assert');
const RT = require('./cudaweb_runtime.js');
(async () => {
  const calls = [];
  const fakeMm = { matmul: async (a, aD, b, bD, ops) => { calls.push({ aD: aD, bD: bD, ops: ops }); return { y: new Float32Array(aD[0] * bD[1]) }; } };
  const rt = RT.createRuntime({ mm: fakeMm, nn: null, navigator: undefined, device: {} });
  // 1) 沒給旗標：與原本行為相同（兩個旗標都是 false）
  await rt.matmul([1, 2, 3, 4], [1, 2, 3, 4], 2, 2, 2);
  assert.strictEqual(calls[0].ops.transA, false); assert.strictEqual(calls[0].ops.transB, false);
  assert.deepStrictEqual(calls[0].aD, [2, 2]); assert.deepStrictEqual(calls[0].bD, [2, 2]);
  // 2) 給旗標：原樣傳給 mm_ops；維度仍是邏輯維度 [m,k]、[k,n]
  await rt.matmul([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], 2, 3, 2, { transA: true, transB: true });
  assert.strictEqual(calls[1].ops.transA, true); assert.strictEqual(calls[1].ops.transB, true);
  assert.deepStrictEqual(calls[1].aD, [2, 3]); assert.deepStrictEqual(calls[1].bD, [3, 2]);
  // 3) 只給一個旗標
  await rt.matmul([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], 2, 3, 2, { transB: true });
  assert.strictEqual(calls[2].ops.transA, false); assert.strictEqual(calls[2].ops.transB, true);
  console.log('cudaweb_runtime_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
