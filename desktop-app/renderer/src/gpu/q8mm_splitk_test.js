'use strict';
// R5：q8mm 的 split-K（解碼 M=1 等）假裝置測試（先寫）：
//  1. 整數累加的切片和等於整段和（逐位相同，因為 i32 加法與順序無關，且 |和| < 2^31）。
//  2. simulate（與核心同一個切片與歸約順序）對 q8mmRef 逐位相同（maxAbsDiff 0），S 取 1、2、4、8、16，形狀含 M=1、M=3、K 非 256 倍數、N 非 64 倍數。
//  3. N 不是 4 的倍數時丟錯（權重要以 u32 讀）。
//  4. 核心文字：部分和核心與歸約核心各有 entry、以 wid.y 選切片、歸約乘 scale。
// 用法：node renderer/src/gpu/q8mm_splitk_test.js
const assert = require('assert');
const Q = require('./q8mm_splitk.js');
const IO = require('./infer_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return s; }; }

check('切分：各片連續、涵蓋 [0,K)；S 大於 K 時多出來的片為空', () => {
  for (const [K, S] of [[1024, 8], [1000, 16], [5, 7]]) {
    const rs = Q.sliceRanges(K, S); let pos = 0;
    for (const [a, b] of rs) { assert.strictEqual(a, pos); pos = b; }
    assert.strictEqual(pos, K);
  }
});
check('pickSplits：K ≥ 4096 切 16、1024 ≤ K < 4096 切 8、其餘不切', () => {
  assert.strictEqual(Q.pickSplits(4096), 16); assert.strictEqual(Q.pickSplits(1024), 8); assert.strictEqual(Q.pickSplits(300), 1);
});
for (const S of [1, 2, 4, 8, 16]) {
  check('simulate（S=' + S + '）與 q8mmRef 逐位相同（M=1、3；K 非 256 倍數；N 非 64 倍數）', () => {
    const r = rng(100 + S);
    for (const [M, K, N] of [[1, 1024, 1024], [3, 300, 132], [1, 1000, 68], [2, 4096, 256]]) {
      const xq = Int32Array.from({ length: M * K }, () => ((r() >>> 8) % 511) - 255);
      const W = Uint8Array.from({ length: K * N }, () => (r() >>> 13) & 255);
      const ref = IO.q8mmRef(xq, W, 131, M, K, N, 0.0123);
      const got = Q.simulate(xq, W, 131, M, K, N, 0.0123, S);
      for (let i = 0; i < ref.length; i++) assert.ok(Object.is(got[i], ref[i]), M + 'x' + K + 'x' + N + ' i=' + i + ' got ' + got[i] + ' ref ' + ref[i]);
    }
  });
}
check('N 不是 4 的倍數：丟錯', () => {
  assert.throws(() => Q.simulate(new Int32Array(4), new Uint8Array(6), 0, 1, 2, 3, 1, 4), /4 的倍數/);
});
check('核心文字：部分和與歸約兩個 entry，部分和用 wid.y 選切片，歸約乘 scale', () => {
  assert.ok(/@compute @workgroup_size\(256\)/.test(Q.WGSL_Q8_SPLITK_PARTIAL) && /wid\.y/.test(Q.WGSL_Q8_SPLITK_PARTIAL));
  assert.ok(/scale/.test(Q.WGSL_Q8_SPLITK_REDUCE) && /@compute/.test(Q.WGSL_Q8_SPLITK_REDUCE));
});

check('規則（infer_ops.q8mmVariant）：split-K 只在強制指定時選（端到端沒有好處，見 q8mm_integ_check）；自動規則不變', () => {
  assert.strictEqual(IO.q8mmVariant(1024, {}, 1, 4096), 'dec');
  assert.strictEqual(IO.q8mmVariant(3072, {}, 1, 1024), 'dec');
  assert.strictEqual(IO.q8mmVariant(1024, { q8variant: 'splitk' }, 1, 4096), 'splitk', '強制指定可用');
  assert.strictEqual(IO.q8mmVariant(1024, { q8variant: 'dec' }, 1, 4096), 'dec', '強制指定優先');
  assert.strictEqual(IO.q8mmVariant(1022, {}, 1, 4096), 'simple', 'N 非 4 的倍數不切（沿用既有規則）');
});

console.log(passed + ' 項通過');
