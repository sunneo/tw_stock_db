'use strict';
// llm_skeleton（O12b，CPU 參考）：基本運算的已知值、GQA 對應、單一詞元的精確解（與獨立算的結果比對）、不支援的功能要丟錯。
const assert = require('assert');
const S = require('./llm_skeleton.js');
const A = require('./llm_arch.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
const close = (a, b, tol, msg) => { assert.strictEqual(a.length, b.length, msg + ' 長度'); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, msg + ' i=' + i + ' ' + a[i] + ' vs ' + b[i]); };

check('rmsnorm：[3,4] 的 RMS 為 sqrt(12.5)，權重全 1', () => {
  const y = S.rmsnorm(Float32Array.from([3, 4]), Float32Array.from([1, 1]), 0);
  const r = Math.sqrt(12.5);
  close(y, [3 / r, 4 / r], 1e-6, 'rmsnorm');
});

check('softmax：總和為 1；相等的輸入得到均分', () => {
  const p = S.softmax([0, 0]);
  close(p, [0.5, 0.5], 1e-12, 'softmax');
  const q = S.softmax([1, 2, 3]);
  assert.ok(Math.abs(q.reduce((s, v) => s + v, 0) - 1) < 1e-12);
});

check('RoPE：pos=0 是恆等；轉動不改變向量長度', () => {
  const x = Float32Array.from([1, 2, 3, 4, 0.5, -1, 2, 0.25]);
  close(S.rope(x, 2, 4, 0, 10000), Array.from(x), 1e-7, 'pos0');
  const y = S.rope(x, 2, 4, 7, 10000);
  const n = (v) => Math.sqrt(v.reduce((s, q) => s + q * q, 0));
  assert.ok(Math.abs(n(y) - n(x)) < 1e-4, 'norm ' + n(y) + ' vs ' + n(x));
});

check('RoPE half 風格：第 i 組是 (x[i], x[i+d/2])，base=1、pos=1、d=4 時兩組角度都是 1 弧度', () => {
  const x = Float32Array.from([1, 0, 0, 0]);   // 第 0 組 (x0, x2) = (1, 0)
  const y = S.rope(x, 1, 4, 1, 1);
  const c = Math.cos(1), s = Math.sin(1);
  close(y, [c, 0, s, 0], 1e-6, 'half');
});

check('GQA：8 個 query head 對 2 個 kv head，前 4 個用 0、後 4 個用 1', () => {
  const m = [0, 1, 2, 3, 4, 5, 6, 7].map((h) => S.kvHeadOf(h, 8, 2));
  assert.deepStrictEqual(m, [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.strictEqual(S.kvHeadOf(3, 4, 4), 3);   // MHA：一一對應
});

// 一層、一個詞元的精確解：注意力只有一個位置，softmax 為 1，輸出就是 v；wo 為單位矩陣。
// 兩個 query head 都用 kv head 0，所以 attention 輸出是 [v0, v1, v0, v1]。FFN 權重為 0，不貢獻。
function tinyArch() {
  return {
    family: 'llama', status: 'supported', verified: false,
    layers: 1, hidden: 4, heads: 2, kvHeads: 1, headDim: 2, ffn: 2,
    norm: 'rmsnorm', eps: 1e-5, qkNorm: false,
    rope: { base: 10000, scaling: null, style: 'half' },
    act: 'silu_mul', bias: false, tiedEmbeddings: true,
    vocab: 3, quant: ['f32']
  };
}
function tinyWeights() {
  const ones = Float32Array.from([1, 1, 1, 1]);
  const wv = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0]);             // 2×4：v = [h0, h1]
  const wo = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);   // 4×4 單位矩陣
  return {
    embed: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, -0.1, 0.2, 0.0, -0.3, 0.6, 0.1, 0.2]),
    finalNorm: ones,
    layers: [{
      attnNorm: ones, wq: new Float32Array(16), wk: new Float32Array(8), wv: wv, wo: wo,
      ffnNorm: ones, wGate: new Float32Array(8), wUp: new Float32Array(8), wDown: new Float32Array(8)
    }]
  };
}
check('單一詞元的精確解：與獨立算的 logits 一致（GQA、單位 wo、FFN 為 0）', () => {
  const arch = tinyArch(), w = tinyWeights();
  const t = 1;
  const e = w.embed.subarray(t * 4, t * 4 + 4);
  // 獨立計算
  const rms = (x) => { const r = Math.sqrt(x.reduce((s, q) => s + q * q, 0) / x.length + 1e-5); return x.map((q) => q / r); };
  const h = rms(Array.from(e));
  const o = [h[0], h[1], h[0], h[1]];
  const x1 = Array.from(e).map((q, i) => q + o[i]);
  const n = rms(x1);
  const want = [0, 1, 2].map((j) => Array.from(w.embed.subarray(j * 4, j * 4 + 4)).reduce((s, q, k) => s + q * n[k], 0));
  const got = S.run(arch, w, [t]).logits;
  close(got, want, 1e-5, 'logits');
});

check('run：argmax 是 logits 最大的位置；狀態的 pos 與快取長度隨詞元前進', () => {
  const arch = tinyArch(), w = tinyWeights();
  const r = S.run(arch, w, [0, 1, 2]);
  let best = 0; for (let i = 1; i < r.logits.length; i++) if (r.logits[i] > r.logits[best]) best = i;
  assert.strictEqual(r.argmax, best);
  assert.strictEqual(r.state.pos, 3);
  assert.strictEqual(r.state.cacheK[0].length, 3);
  assert.strictEqual(r.state.cacheV[0].length, 3);
});

check('確定性：同樣的輸入得到同樣的 logits', () => {
  const arch = tinyArch(), w = tinyWeights();
  const a = S.run(arch, w, [0, 2, 1]).logits, b = S.run(arch, w, [0, 2, 1]).logits;
  close(a, b, 0, 'det');
});

check('詞表外的詞元：丟錯，不悄悄取值', () => {
  assert.throws(() => S.run(tinyArch(), tinyWeights(), [3]), /超出詞表/);
  assert.throws(() => S.run(tinyArch(), tinyWeights(), [-1]), /超出詞表/);
});

check('不支援的功能：RoPE 縮放、GELU、pending 族，都丟明確錯誤；bias 缺 q/k/v 偏置時丟錯（不算錯）', () => {
  const a1 = tinyArch(); a1.rope.scaling = { type: 'llama3', factor: 32 };
  assert.throws(() => S.run(a1, tinyWeights(), [0]), /RoPE 縮放/);
  const a2 = tinyArch(); a2.bias = true;
  assert.throws(() => S.run(a2, tinyWeights(), [0]), /權重 layers\[0\]\.bq 長度應為 4/);
  const a3 = tinyArch(); a3.act = 'gelu';
  assert.throws(() => S.run(a3, tinyWeights(), [0]), /gelu/);
  assert.throws(() => S.run(A.archFor('gemma') || Object.assign(tinyArch(), { status: 'pending' }), tinyWeights(), [0]), /pending|不合法/);
});

check('不合法的描述：先由 validateArch 擋下（heads 3 不是 kvHeads 2 的整數倍）', () => {
  const a = tinyArch(); a.heads = 3; a.kvHeads = 2;
  assert.throws(() => S.run(a, tinyWeights(), [0]), /描述表不合法/);
});

check('權重長度不對：開頭就丟錯並指出是哪個權重（不讓 NaN 悄悄出現）', () => {
  const w = tinyWeights(); w.layers[0].wq = new Float32Array(8);   // 應為 16
  assert.throws(() => S.run(tinyArch(), w, [0]), /權重 layers\[0\]\.wq 長度應為 16，實際 8/);
  const w2 = tinyWeights(); w2.embed = new Float32Array(11);
  assert.throws(() => S.run(tinyArch(), w2, [0]), /權重 embed 長度應為 12/);
});

// 覆寫槽（O12c）
check('覆寫槽：正確的覆寫會被呼叫（計數 > 0），logits 與通用實作相同', () => {
  const arch = tinyArch(), w = tinyWeights();
  const base = S.run(arch, w, [1, 2]).logits;
  let calls = 0;
  S.registerOverride(arch.family, 'matvec', (W, r, c, x) => {
    calls++; const y = new Float32Array(r);
    for (let i = 0; i < r; i++) { let s = 0; for (let j = 0; j < c; j++) s += W[i * c + j] * x[j]; y[i] = s; }
    return y;
  });
  try {
    const got = S.run(arch, w, [1, 2]).logits;
    assert.ok(calls > 0, '覆寫沒有被用到');
    close(got, base, 1e-6, 'override');
  } finally { S.clearOverrides(arch.family); }
});

check('覆寫槽：有錯的覆寫確實改變結果（證明覆寫真的有被用）', () => {
  const arch = tinyArch(), w = tinyWeights();
  const base = S.run(arch, w, [1, 2]).logits;
  S.registerOverride(arch.family, 'rmsnorm', (x, wn, eps) => S.rmsnorm(x, wn, eps).map((v) => v * 1.5));
  try {
    const got = S.run(arch, w, [1, 2]).logits;
    assert.ok(Math.max(...Array.from(got).map((v, i) => Math.abs(v - base[i]))) > 1e-3, '錯的覆寫沒有改變結果');
  } finally { S.clearOverrides(arch.family); }
});

check('useOverrides=false：即使註冊了錯的覆寫，也走通用實作（與沒有覆寫時相同）', () => {
  const arch = tinyArch(), w = tinyWeights();
  const base = S.run(arch, w, [1, 2]).logits;
  S.registerOverride(arch.family, 'rmsnorm', (x, wn, eps) => S.rmsnorm(x, wn, eps).map((v) => v * 1.5));
  try {
    const got = S.run(arch, w, [1, 2], { useOverrides: false }).logits;
    close(got, base, 0, 'useOverrides=false');
  } finally { S.clearOverrides(arch.family); }
});

check('覆寫槽：沒有這個槽名就丟錯（不會默默註冊到沒人用的地方）', () => {
  assert.throws(() => S.registerOverride('llama', 'attention', () => {}), /沒有這個覆寫槽/);
  assert.throws(() => S.registerOverride('llama', 'rope', 'not a function'), /必須是函式/);
});

console.log('llm_skeleton_test: ' + passes + ' 項通過');
