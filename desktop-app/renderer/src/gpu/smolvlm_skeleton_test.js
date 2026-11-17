'use strict';
// smolvlm_skeleton（O13b，CPU 參考，假權重）：pixel shuffle 的已知值、連接器、影像佔位詞元的插入、step 與 stepVec 一致、
// 整段前向與獨立算的結果比對、錯誤要明確。不驗證真實 SmolVLM 的權重與展開順序（那要 config 與 modeling 程式，見檔案開頭的「尚未核對」）。
const assert = require('assert');
const SV = require('./smolvlm_skeleton.js');
const VIT = require('./vit_skeleton.js');
const LLM = require('./llm_skeleton.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
const close = (a, b, tol, msg) => { assert.strictEqual(a.length, b.length, msg + ' 長度'); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, msg + ' i=' + i + ' ' + a[i] + ' vs ' + b[i]); };
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 0) / 4294967296) - 0.5; }; }
const vec = (n, r) => Float32Array.from({ length: n }, () => r());

// 視覺：4×4×1 影像、patch 2 → 2×2 格，hidden 4；r=2 → 一個 token，寬 4×2×2 = 16
const vitArch = { layers: 1, hidden: 4, heads: 2, ffn: 3, patch: 2, channels: 1, eps: 1e-6 };
// 語言：hidden 8、2 個 query head、1 個 kv head、head 維度 4、vocab 5
const lmArch = { family: 'llama', status: 'supported', verified: false, layers: 1, hidden: 8, heads: 2, kvHeads: 1, headDim: 4, ffn: 2,
  norm: 'rmsnorm', eps: 1e-5, qkNorm: false, rope: { base: 10000, scaling: null, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: true, vocab: 5, quant: ['f32'] };
const IMG = Float32Array.from({ length: 16 }, (_, i) => (i % 5) / 5 - 0.3);

function vitWeights(seed) {
  const r = rng(seed), H = 4, F = 3, P = 4, ones = () => Float32Array.from({ length: H }, () => 1), z = () => new Float32Array(H);
  return {
    patchW: vec(H * P, r), patchB: vec(H, r), pos: vec(4 * H, r), postG: ones(), postB: z(), layers: [{
      ln1g: ones(), ln1b: z(), wq: vec(H * H, r), bq: vec(H, r), wk: vec(H * H, r), bk: vec(H, r), wv: vec(H * H, r), bv: vec(H, r),
      wo: vec(H * H, r), bo: vec(H, r), ln2g: ones(), ln2b: z(), w1: vec(F * H, r), b1: vec(F, r), w2: vec(H * F, r), b2: vec(H, r) }]
  };
}
// 語言權重；zero=true 時每層的注意力與 FFN 輸出都是 0（殘差不變），方便手算最後的 logits
function lmWeights(seed, zero) {
  const r = rng(seed), H = 8, F = 2, hd = 4, nh = 2, nkv = 1, V = 5;
  const g = (n) => (zero ? new Float32Array(n) : vec(n, r));
  return {
    embed: vec(V * H, r), finalNorm: Float32Array.from({ length: H }, () => 1),
    layers: [{ attnNorm: Float32Array.from({ length: H }, () => 1), wq: g(nh * hd * H), wk: g(nkv * hd * H), wv: g(nkv * hd * H), wo: g(H * nh * hd),
      ffnNorm: Float32Array.from({ length: H }, () => 1), wGate: g(F * H), wUp: g(F * H), wDown: g(H * F) }]
  };
}
const cfg = { vit: { arch: vitArch }, r: 2, imageTokenId: 4, lm: lmArch };
function fullWeights(seed, zero) {
  const r = rng(seed + 100);
  return { vit: vitWeights(seed), connW: vec(lmArch.hidden * 16, r), connB: vec(lmArch.hidden, r), lm: lmWeights(seed + 1, zero) };
}
// 獨立算最後的 logits（零層時）：final = rmsnorm(x)，logits_i = embed_i · final
function logitsOf(x, embed) {
  const H = 8; let ms = 0; for (let i = 0; i < H; i++) ms += x[i] * x[i]; ms /= H;
  const inv = 1 / Math.sqrt(ms + 1e-5); const y = Array.from(x, (v) => v * inv);
  const out = []; for (let t = 0; t < 5; t++) { let s = 0; for (let i = 0; i < H; i++) s += embed[t * H + i] * y[i]; out.push(s); }
  return out;
}

check('pixel shuffle：2×2 格、C=1、r=2 → 一個 token，依 [左上, 右上, 左下, 右下]', () => {
  const feat = [0, 1, 2, 3].map((i) => Float32Array.from([i]));
  const t = SV.pixelShuffle(feat, 2, 2, 1, 2);
  assert.strictEqual(t.length, 1);
  assert.deepStrictEqual(Array.from(t[0]), [0, 1, 2, 3]);
});

check('pixel shuffle：4×4 格、r=2 → 4 個 token；第 2 個（oy=0、ox=1）是格 (0,2)、(0,3)、(1,2)、(1,3)', () => {
  const feat = Array.from({ length: 16 }, (_, i) => Float32Array.from([i]));
  const t = SV.pixelShuffle(feat, 4, 4, 1, 2);
  assert.strictEqual(t.length, 4);
  assert.deepStrictEqual(Array.from(t[1]), [2, 3, 6, 7]);
});

check('pixel shuffle：C=2 時每個子格內依通道展開（[c0, c1, c0, c1, …] 的順序）', () => {
  const feat = [0, 1, 2, 3].map((i) => Float32Array.from([i, 10 + i]));
  const t = SV.pixelShuffle(feat, 2, 2, 2, 2);
  assert.deepStrictEqual(Array.from(t[0]), [0, 10, 1, 11, 2, 12, 3, 13]);
});

check('pixel shuffle 錯誤：格子大小不是 r 的整數倍、格數不符、向量長度不對，都丟錯', () => {
  assert.throws(() => SV.pixelShuffle(new Array(9).fill(Float32Array.from([0])), 3, 3, 1, 2), /整數倍/);
  assert.throws(() => SV.pixelShuffle(new Array(3).fill(Float32Array.from([0])), 2, 2, 1, 2), /格子數/);
  assert.throws(() => SV.pixelShuffle(new Array(4).fill(Float32Array.from([0, 0])), 2, 2, 1, 2), /向量長度應為 1/);
});

check('連接器：線性投影，每個 token 獨立；權重長度不對丟錯', () => {
  const W = Float32Array.from([1, 0, 0, 0, 1, 0]);   // 2×3
  const b = Float32Array.from([0.5, -0.5]);
  const out = SV.connector(W, b, 2, 3, [Float32Array.from([1, 2, 3]), Float32Array.from([-1, 4, 0])]);
  close(out[0], [1.5, 1.5], 1e-7, 'tok0');
  close(out[1], [-0.5, 3.5], 1e-7, 'tok1');
  assert.throws(() => SV.connector(new Float32Array(5), b, 2, 3, []), /應為 6/);
});

check('插入影像：佔位詞元依序換成影像嵌入，文字詞元用 embed 對應列；數量不符丟錯', () => {
  const embed = Float32Array.from({ length: 5 * 2 }, (_, i) => i);   // 5 個詞元、hidden 2
  const lm = { hidden: 2, vocab: 5 };
  const img = [Float32Array.from([100, 101]), Float32Array.from([200, 201])];
  const seq = SV.assemble(lm, [0, 4, 1, 4], img, 4, embed);
  assert.deepStrictEqual(Array.from(seq[0]), [0, 1]);
  assert.deepStrictEqual(Array.from(seq[1]), [100, 101]);
  assert.deepStrictEqual(Array.from(seq[2]), [2, 3]);
  assert.deepStrictEqual(Array.from(seq[3]), [200, 201]);
  assert.throws(() => SV.assemble(lm, [0, 4], [], 4, embed), /佔位詞元有 1 個/);
  assert.throws(() => SV.assemble(lm, [0, 9], [], 4, embed), /超出詞表/);
});

check('LLM 的 stepVec 與 step 逐步一致（隨機權重）：同一個詞元的嵌入列，兩條路徑的 logits 完全相同', () => {
  const w = lmWeights(7, false);
  const s1 = LLM.createState(lmArch, w), s2 = LLM.createState(lmArch, w);
  for (const t of [2, 0, 4]) {
    const a = LLM.step(s1, t);
    const b = LLM.stepVec(s2, w.embed.subarray(t * 8, t * 8 + 8));
    close(a, b, 0, 'token ' + t);
  }
  assert.throws(() => LLM.stepVec(s2, new Float32Array(3)), /長度應為 hidden=8/);
});

check('整段前向（零層）：最後一個位置是影像嵌入時，logits 等於 embed · rmsnorm(影像嵌入)，影像嵌入與獨立算的一致', () => {
  const W = fullWeights(3, true);
  const out = SV.forward(cfg, W, IMG, 4, 4, [0, 4]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.imageTokens, 1);
  // 獨立算影像嵌入：2×2 格的 patch 依序（左上、右上、左下、右下）串起來，再做連接器
  const enc = VIT.encode(vitArch, W.vit, IMG, 4, 4);
  const cat = Float32Array.from([...enc[0], ...enc[1], ...enc[2], ...enc[3]]);
  const emb = VIT.linear(W.connW, W.connB, 8, 16, cat);
  close(out.logits, logitsOf(emb, W.lm.embed), 1e-5, '影像位置的 logits');
});

check('整段前向（零層）：最後一個位置是文字時，logits 等於 embed · rmsnorm(該詞元嵌入)', () => {
  const W = fullWeights(4, true);
  const out = SV.forward(cfg, W, IMG, 4, 4, [4, 0]);   // 先放影像，最後是文字詞元 0
  close(out.logits, logitsOf(W.lm.embed.subarray(0, 8), W.lm.embed), 1e-5, '文字位置的 logits');
});

check('整段前向：佔位詞元數與影像 token 數不符時丟錯（不會默默少插）', () => {
  const W = fullWeights(5, true);
  assert.throws(() => SV.forward(cfg, W, IMG, 4, 4, [0, 4, 4]), /佔位詞元有 2 個/);
});

check('整段前向（隨機權重）：有限數、argmax 落在詞表內，且與逐步 stepVec 手動餵入的結果一致', () => {
  const W = fullWeights(6, false);
  const out = SV.forward(cfg, W, IMG, 4, 4, [0, 4, 2]);
  assert.ok(out.logits.every((v) => Number.isFinite(v)), '有非有限數');
  assert.ok(out.argmax >= 0 && out.argmax < 5);
  // 手動：同樣的嵌入序列，逐步 stepVec
  const enc = VIT.encode(vitArch, W.vit, IMG, 4, 4);
  const cat = Float32Array.from([...enc[0], ...enc[1], ...enc[2], ...enc[3]]);
  const emb = VIT.linear(W.connW, W.connB, 8, 16, cat);
  const st = LLM.createState(lmArch, W.lm);
  let last = null;
  [W.lm.embed.subarray(0, 8), emb, W.lm.embed.subarray(16, 24)].forEach((x) => { last = LLM.stepVec(st, x); });
  close(out.logits, last, 1e-6, '與手動逐步一致');
});

console.log('smolvlm_skeleton_test: ' + passes + ' 項通過');
