'use strict';
// vit_skeleton（O13a，CPU 參考）：LayerNorm、GELU、patch 切分的已知值；編碼器在可手算的情況下逐位比對；錯誤要明確。
const assert = require('assert');
const V = require('./vit_skeleton.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
const close = (a, b, tol, msg) => { assert.strictEqual(a.length, b.length, msg + ' 長度'); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, msg + ' i=' + i + ' ' + a[i] + ' vs ' + b[i]); };

check('LayerNorm：[1,2,3,4]，平均 2.5、變異數 1.25，γ=1、β=0、eps=0', () => {
  const y = V.layernorm(Float32Array.from([1, 2, 3, 4]), Float32Array.from([1, 1, 1, 1]), Float32Array.from([0, 0, 0, 0]), 0);
  const s = Math.sqrt(1.25);
  close(y, [-1.5 / s, -0.5 / s, 0.5 / s, 1.5 / s], 1e-6, 'layernorm');
});

check('GELU（tanh 近似）：0 → 0；大正值 ≈ 自身；大負值 ≈ 0', () => {
  assert.strictEqual(V.geluTanh(0), 0);
  assert.ok(Math.abs(V.geluTanh(10) - 10) < 1e-6);
  assert.ok(Math.abs(V.geluTanh(-10)) < 1e-6);
});

check('patch 切分：4×4×1、patch 2 → 4 個 patch；第 0 個是 [0,1,4,5]，最後一個是 [10,11,14,15]', () => {
  const img = Float32Array.from({ length: 16 }, (_, i) => i);
  const ps = V.patchify(img, 4, 4, 1, 2);
  assert.strictEqual(ps.length, 4);
  assert.deepStrictEqual(Array.from(ps[0]), [0, 1, 4, 5]);
  assert.deepStrictEqual(Array.from(ps[3]), [10, 11, 14, 15]);
});

check('patch 切分：多通道時每個 patch 依 (py, px, c) 展開', () => {
  // 2×2×2（HWC）：像素 (0,0)=[1,2]、(0,1)=[3,4]、(1,0)=[5,6]、(1,1)=[7,8]
  const img = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const ps = V.patchify(img, 2, 2, 2, 2);
  assert.deepStrictEqual(Array.from(ps[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

check('patch 切分錯誤：高寬不是 patch 的整數倍、元素數不符，都丟錯', () => {
  assert.throws(() => V.patchify(new Float32Array(9), 3, 3, 1, 2), /整數倍/);
  assert.throws(() => V.patchify(new Float32Array(10), 4, 4, 1, 2), /元素數/);
});

// 小模型：4×4×1 影像、patch 2 → 4 個 patch；hidden 4、heads 2、ffn 3、1 層
function arch(layers) { return { layers: layers || 1, hidden: 4, heads: 2, ffn: 3, patch: 2, channels: 1, eps: 1e-6 }; }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 0) / 4294967296) - 0.5; }; }
function weights(a, zeroBlocks) {
  const r = rng(5), H = a.hidden, F = a.ffn, P = a.patch * a.patch * a.channels, nP = 4;
  const z = (n) => new Float32Array(n);
  const rv = (n) => Float32Array.from({ length: n }, () => (zeroBlocks ? 0 : r()));
  const w = {
    patchW: rv(H * P), patchB: rv(H), pos: rv(nP * H), postG: Float32Array.from({ length: H }, () => 1), postB: z(H), layers: []
  };
  for (let i = 0; i < a.layers; i++) {
    w.layers.push({
      ln1g: Float32Array.from({ length: H }, () => 1), ln1b: z(H),
      wq: rv(H * H), bq: rv(H), wk: rv(H * H), bk: rv(H), wv: rv(H * H), bv: rv(H), wo: rv(H * H), bo: zeroBlocks ? z(H) : rv(H),
      ln2g: Float32Array.from({ length: H }, () => 1), ln2b: z(H),
      w1: rv(F * H), b1: rv(F), w2: zeroBlocks ? z(H * F) : rv(H * F), b2: zeroBlocks ? z(H) : rv(H)
    });
  }
  return w;
}
const IMG = Float32Array.from({ length: 16 }, (_, i) => (i % 5) / 5 - 0.3);

check('編碼器（MLP 與注意力的輸出為 0）：結果 = 後 LayerNorm(patch 嵌入 + 位置)，與獨立算的一致', () => {
  const a = arch(1), w = weights(a, true);
  const out = V.encode(a, w, IMG, 4, 4);
  assert.strictEqual(out.length, 4);
  const ps = V.patchify(IMG, 4, 4, 1, 2);
  for (let i = 0; i < 4; i++) {
    const e = V.linear(w.patchW, w.patchB, 4, 4, ps[i]).map((v, d) => v + w.pos[i * 4 + d]);
    const want = V.layernorm(Float32Array.from(e), w.postG, w.postB, a.eps);
    close(out[i], want, 1e-5, 'patch ' + i);
  }
});

check('單一 patch（注意力只看自己）：注意力輸出 = wo·(wv·h + bv) + bo，手算比對', () => {
  const a = arch(1); a.patch = 2;
  const img = Float32Array.from([0.1, -0.2, 0.3, 0.4]);   // 2×2×1，只有一個 patch
  const w = weights(a, false);
  w.pos = Float32Array.from({ length: 1 * 4 }, (_, i) => (i % 3) * 0.01);   // 1 個 patch × hidden 4
  const out = V.encode(a, w, img, 2, 2);
  // 獨立計算
  const L = w.layers[0];
  const x0 = V.linear(w.patchW, w.patchB, 4, 4, img).map((v, d) => v + w.pos[d]);
  const h = V.layernorm(Float32Array.from(x0), L.ln1g, L.ln1b, a.eps);
  const vv = V.linear(L.wv, L.bv, 4, 4, h);
  const att = V.linear(L.wo, L.bo, 4, 4, vv);
  const x1 = x0.map((v, d) => v + att[d]);
  const h2 = V.layernorm(Float32Array.from(x1), L.ln2g, L.ln2b, a.eps);
  const mid = V.linear(L.w1, L.b1, 3, 4, h2).map((v) => 0.5 * v * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (v + 0.044715 * v * v * v))));
  const dn = V.linear(L.w2, L.b2, 4, 3, mid);
  const x2 = x1.map((v, d) => v + dn[d]);
  const want = V.layernorm(Float32Array.from(x2), w.postG, w.postB, a.eps);
  close(out[0], want, 1e-5, 'single patch');
});

check('編碼器：權重長度不對、heads 不整除，都丟明確錯誤', () => {
  const a = arch(1), w = weights(a, false);
  w.layers[0].wq = new Float32Array(3);
  assert.throws(() => V.encode(a, w, IMG, 4, 4), /權重 layers\[0\]\.wq 長度應為 16/);
  const b = arch(1); b.heads = 3;
  assert.throws(() => V.encode(b, weights(arch(1), false), IMG, 4, 4), /hidden 必須能被 heads 整除/);
});

console.log('vit_skeleton_test: ' + passes + ' 項通過');
