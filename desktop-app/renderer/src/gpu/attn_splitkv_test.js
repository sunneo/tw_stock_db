'use strict';
// R5 注意力：decode（S=1）的 split-KV（flash-decoding 式）假裝置測試（先寫）：
//  1. 切分：每 64 個 key 一塊（nChunks = ⌈(past+1)/64⌉）；最後一塊不足的部分不計分。
//  2. simulate（與兩段核心相同的 max／sum／加權和與合併）對 attn_ops.attnCore（S=1）相對誤差 ≤1e-5；
//     形狀：H=4/Hkv=2/hd=64、H=8/Hkv=2/hd=128、past 為 0、63、64、300。
//  3. 規則：只在 S=1 時適用；S>1 不適用（回傳 null，由呼叫端退回既有核心）。
// 用法：node renderer/src/gpu/attn_splitkv_test.js
const assert = require('assert');
const SKV = require('./attn_splitkv.js');
const A = require('./attn_ops.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; }; }

check('切分：每塊 64 個 key，塊數 ⌈(past+1)/64⌉', () => {
  assert.strictEqual(SKV.nChunks(0), 1);
  assert.strictEqual(SKV.nChunks(63), 1);
  assert.strictEqual(SKV.nChunks(64), 2);
  assert.strictEqual(SKV.nChunks(300), 5);
});
check('規則：S=1 才適用；S>1 回傳 null', () => {
  assert.ok(SKV.applies(1, 128, 300));
  assert.strictEqual(SKV.applies(2, 128, 300), false);
});
const cases = [
  { H: 4, Hkv: 2, hd: 64, past: 0 }, { H: 4, Hkv: 2, hd: 64, past: 63 }, { H: 4, Hkv: 2, hd: 64, past: 64 },
  { H: 8, Hkv: 2, hd: 128, past: 300 }, { H: 16, Hkv: 8, hd: 128, past: 512 },
];
for (const c of cases) {
  check('simulate 對 attnCore（S=1）相對誤差 ≤1e-5：H' + c.H + ' Hkv' + c.Hkv + ' hd' + c.hd + ' past' + c.past, () => {
    const r = rng(c.past + c.hd);
    const maxT = c.past + 1;
    const cache = A.createKvCache(c.Hkv, c.hd, maxT);
    for (let t = 0; t < c.past; t++) {
      const k = Float32Array.from({ length: c.Hkv * c.hd }, r), v = Float32Array.from({ length: c.Hkv * c.hd }, r);
      A.kvAppend(cache, k, v, 1);
    }
    const kNew = Float32Array.from({ length: c.Hkv * c.hd }, r), vNew = Float32Array.from({ length: c.Hkv * c.hd }, r);
    A.kvAppend(cache, kNew, vNew, 1);
    const q = Float32Array.from({ length: c.H * c.hd }, r);
    const scale = 1 / Math.sqrt(c.hd);
    const ref = A.attnCore(q, 1, c.past, cache, c.H, scale);
    const got = SKV.simulate(q, cache, c.past, c.H, scale);
    let mx = 0, sc = 1e-9; for (let i = 0; i < ref.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
    assert.ok(mx / sc <= 1e-5, '相對誤差 ' + (mx / sc));
  });
}
check('核心文字：部分核心（workgroup 64、wid.y 選塊）與合併核心', () => {
  assert.ok(/@workgroup_size\(64\)/.test(SKV.WGSL_SPLITKV_PARTIAL) && /wid\.y/.test(SKV.WGSL_SPLITKV_PARTIAL));
  assert.ok(/@workgroup_size\(64\)/.test(SKV.WGSL_SPLITKV_COMBINE));
});

console.log(passed + ' 項通過');
