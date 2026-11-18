'use strict';
// llava_skeleton（O13a，CPU 參考，隨機小權重）：模型表與 config.json 一致、影像裁切、精確 GELU、視覺編碼器、投影、佔位詞元插入、
// 整段前向（與獨立手寫的參考逐元素比對）、偏置確實有作用、形狀與錯誤訊息。不驗證真權重（沒有下載 LLaVA 的權重）。
const assert = require('assert');
const L = require('./llava_skeleton.js');
const ARCH = require('./llm_arch.js');
let passes = 0;
function check(name, fn) { fn(); passes++; console.log('ok   ' + name); }
function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 0) / 4294967296) - 0.5; }; }
const vec = (n, r) => Float32Array.from({ length: n }, () => r() * 1.0);
// 逐元素比對：絕對誤差 ≤ tol·max(1,|期望值|)（權重與計算用 Float32 儲存，參考用 Float64）
function close(got, want, tol, msg) {
  assert.strictEqual(got.length, want.length, msg + ' 長度');
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs(got[i] - want[i]), lim = tol * Math.max(1, Math.abs(want[i]));
    assert.ok(d <= lim, msg + ' i=' + i + ' got ' + got[i] + ' want ' + want[i]);
  }
}

// ---------- 小模型（同一組形狀的 Qwen2 結構與 SigLIP 結構，維度可手算） ----------
const vis = { layers: 2, hidden: 8, heads: 2, ffn: 6, patch: 2, channels: 3, eps: 1e-6 };
const text = { family: 'qwen2', status: 'supported', verified: false, layers: 2, hidden: 8, heads: 4, kvHeads: 2, headDim: 2, ffn: 6,
  norm: 'rmsnorm', eps: 1e-6, qkNorm: false, rope: { base: 10000, scaling: null, style: 'half' }, act: 'silu_mul', bias: true,
  tiedEmbeddings: true, vocab: 9, quant: ['f32'] };
const IMG_TOK = 7;
const model = { vision: vis, featureLayer: -1, featureSelect: 'full', imageTokenId: IMG_TOK, textArch: text };
const IH = 5, IW = 6;                                   // 5×6 會裁成 4×6，2×3＝6 個 patch
function imgData(seed) { const r = rng(seed); return Float32Array.from({ length: IH * IW * vis.channels }, () => r() * 1.0); }

function vitWeights(seed, nPatch) {
  const r = rng(seed), D = vis.hidden, K = vis.patch * vis.patch * vis.channels, F = vis.ffn;
  const ones = () => Float32Array.from({ length: D }, () => 1), z = () => new Float32Array(D);
  const layers = [];
  for (let l = 0; l < vis.layers; l++) layers.push({
    ln1g: vec(D, r), ln1b: vec(D, r), wq: vec(D * D, r), bq: vec(D, r), wk: vec(D * D, r), bk: vec(D, r), wv: vec(D * D, r), bv: vec(D, r),
    wo: vec(D * D, r), bo: vec(D, r), ln2g: vec(D, r), ln2b: vec(D, r), w1: vec(F * D, r), b1: vec(F, r), w2: vec(D * F, r), b2: vec(D, r) });
  return { patchW: vec(D * K, r), patchB: vec(D, r), pos: vec(nPatch * D, r), postG: ones(), postB: z(), layers: layers };
}
function projWeights(seed) {
  const r = rng(seed), T = text.hidden, V = vis.hidden;
  return { p1W: vec(T * V, r), p1B: vec(T, r), p2W: vec(T * T, r), p2B: vec(T, r) };
}
function lmWeights(seed) {
  const r = rng(seed), H = text.hidden, nh = text.heads, nkv = text.kvHeads, hd = text.headDim, F = text.ffn, V = text.vocab;
  const ones = () => Float32Array.from({ length: H }, () => 1);
  const layers = [];
  for (let l = 0; l < text.layers; l++) layers.push({
    attnNorm: vec(H, r), wq: vec(nh * hd * H, r), bq: vec(nh * hd, r), wk: vec(nkv * hd * H, r), bk: vec(nkv * hd, r),
    wv: vec(nkv * hd * H, r), bv: vec(nkv * hd, r), wo: vec(H * nh * hd, r), ffnNorm: vec(H, r),
    wGate: vec(F * H, r), wUp: vec(F * H, r), wDown: vec(H * F, r) });
  return { embed: vec(V * H, r), finalNorm: ones(), layers: layers };
}
function allWeights(seed, nPatch) { return { vit: vitWeights(seed, nPatch), proj: projWeights(seed + 1), lm: lmWeights(seed + 2) }; }
const IDS = [1, IMG_TOK, IMG_TOK, IMG_TOK, IMG_TOK, IMG_TOK, IMG_TOK, 2, 3];   // 6 個影像詞元（與 6 個 patch 對應）

// ---------- 獨立手寫的 CPU 參考（不呼叫骨架的任何函式） ----------
function refErf(x) {   // 冪級數：erf(x) = 2/√π · Σ (−1)^n x^(2n+1) / (n!(2n+1))，|x| ≤ 3 內夠準
  let sum = 0, term = x;
  for (let n = 0; n < 80; n++) { sum += term / (2 * n + 1); term = -term * x * x / (n + 1); }
  return 2 / Math.sqrt(Math.PI) * sum;
}
const refGeluExact = (v) => 0.5 * v * (1 + refErf(v / Math.SQRT2));
const refGeluTanh = (t) => 0.5 * t * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (t + 0.044715 * t * t * t)));
function refLin(Wm, b, rows, cols, x) {
  const y = [];
  for (let r = 0; r < rows; r++) { let s = b ? b[r] : 0; for (let c = 0; c < cols; c++) s += Wm[r * cols + c] * x[c]; y.push(s); }
  return y;
}
function refLN(x, g, b, eps) {
  const n = x.length, m = x.reduce((a, v) => a + v, 0) / n, vr = x.reduce((a, v) => a + (v - m) * (v - m), 0) / n;
  return x.map((v, i) => (v - m) / Math.sqrt(vr + eps) * g[i] + b[i]);
}
// 視覺：裁切、patch（(py,px,c) 展開）、嵌入＋位置、跑 nLayers 層、不做後 LN
function refVision(w, nLayers, img, H, W) {
  const p = vis.patch, C = vis.channels, D = vis.hidden, hd = D / vis.heads;
  const gh = Math.floor(H / p), gw = Math.floor(W / p);
  const xs0 = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const v = [];
    for (let py = 0; py < p; py++) for (let px = 0; px < p; px++) for (let c = 0; c < C; c++) v.push(img[((gy * p + py) * W + (gx * p + px)) * C + c]);
    xs0.push(v);
  }
  const n = xs0.length;
  let xs = xs0.map((v, i) => {
    const out = [];
    for (let d = 0; d < D; d++) { let s = w.patchB[d] + w.pos[i * D + d]; for (let k = 0; k < v.length; k++) s += w.patchW[d * v.length + k] * v[k]; out.push(s); }
    return out;
  });
  for (let l = 0; l < nLayers; l++) {
    const Lw = w.layers[l];
    const n1 = xs.map((x) => refLN(x, Lw.ln1g, Lw.ln1b, vis.eps));
    const Q = n1.map((x) => refLin(Lw.wq, Lw.bq, D, D, x)), K = n1.map((x) => refLin(Lw.wk, Lw.bk, D, D, x)), V = n1.map((x) => refLin(Lw.wv, Lw.bv, D, D, x));
    const att = xs.map(() => new Array(D).fill(0));
    for (let h = 0; h < vis.heads; h++) for (let i = 0; i < n; i++) {
      const sc = [];
      for (let j = 0; j < n; j++) { let s = 0; for (let d = 0; d < hd; d++) s += Q[i][h * hd + d] * K[j][h * hd + d]; sc.push(s / Math.sqrt(hd)); }
      const mx = Math.max(...sc), ex = sc.map((s) => Math.exp(s - mx)), Z = ex.reduce((a, b) => a + b, 0);
      for (let j = 0; j < n; j++) for (let d = 0; d < hd; d++) att[i][h * hd + d] += ex[j] / Z * V[j][h * hd + d];
    }
    const proj = att.map((a) => refLin(Lw.wo, Lw.bo, D, D, a));
    xs = xs.map((x, i) => x.map((v, d) => v + proj[i][d]));
    xs = xs.map((x) => {
      const hmid = refLin(Lw.w1, Lw.b1, vis.ffn, D, refLN(x, Lw.ln2g, Lw.ln2b, vis.eps)).map(refGeluTanh);
      const dn = refLin(Lw.w2, Lw.b2, D, vis.ffn, hmid);
      return x.map((v, i) => v + dn[i]);
    });
  }
  return xs;
}
function refProj(w, feats) {
  const T = text.hidden, V = vis.hidden;
  return feats.map((x) => refLin(w.p2W, w.p2B, T, T, refLin(w.p1W, w.p1B, T, V, x).map(refGeluExact)));
}
// Qwen2 式解碼器（q/k/v 有偏置、o 沒有、RMSNorm、RoPE half、MHA、SwiGLU、tied 嵌入）
function refLM(w, seq) {
  const H = text.hidden, nh = text.heads, nkv = text.kvHeads, hd = text.headDim, F = text.ffn, base = text.rope.base;
  const rms = (x, g) => { const ms = x.reduce((s, v) => s + v * v, 0) / x.length, r = 1 / Math.sqrt(ms + text.eps); return x.map((v, i) => v * r * g[i]); };
  const rot = (vv, nHeads, pos) => {
    const out = vv.slice(), half = hd / 2;
    for (let h = 0; h < nHeads; h++) for (let i = 0; i < half; i++) {
      const o = h * hd, th = pos * Math.pow(base, -2 * i / hd), c = Math.cos(th), s = Math.sin(th);
      out[o + i] = vv[o + i] * c - vv[o + i + half] * s; out[o + i + half] = vv[o + i] * s + vv[o + i + half] * c;
    }
    return out;
  };
  const Kc = w.layers.map(() => []), Vc = w.layers.map(() => []);
  let last = null;
  seq.forEach((x0, pos) => {
    let x = x0.slice();
    w.layers.forEach((Lw, l) => {
      const h = rms(x, Lw.attnNorm);
      const q = rot(refLin(Lw.wq, Lw.bq, nh * hd, H, h), nh, pos);
      const k = rot(refLin(Lw.wk, Lw.bk, nkv * hd, H, h), nkv, pos);
      const v = refLin(Lw.wv, Lw.bv, nkv * hd, H, h);
      Kc[l].push(k); Vc[l].push(v);
      const ao = new Array(nh * hd).fill(0), group = nh / nkv;
      for (let qh = 0; qh < nh; qh++) {
        const kh = Math.floor(qh / group);
        const sc = Kc[l].map((kt) => { let s = 0; for (let i = 0; i < hd; i++) s += q[qh * hd + i] * kt[kh * hd + i]; return s / Math.sqrt(hd); });
        const mx = Math.max(...sc), ex = sc.map((s) => Math.exp(s - mx)), Z = ex.reduce((a, b) => a + b, 0);
        for (let t = 0; t < sc.length; t++) for (let i = 0; i < hd; i++) ao[qh * hd + i] += ex[t] / Z * Vc[l][t][kh * hd + i];
      }
      const o = refLin(Lw.wo, null, H, nh * hd, ao);
      x = x.map((vv, i) => vv + o[i]);
      const h2 = rms(x, Lw.ffnNorm);
      const g = refLin(Lw.wGate, null, F, H, h2), u = refLin(Lw.wUp, null, F, H, h2);
      const act = g.map((gv, i) => gv / (1 + Math.exp(-gv)) * u[i]);
      const d = refLin(Lw.wDown, null, H, F, act);
      x = x.map((vv, i) => vv + d[i]);
    });
    last = x;
  });
  const xn = rms(last, w.finalNorm);
  const logits = [];
  for (let t = 0; t < text.vocab; t++) { let s = 0; for (let i = 0; i < H; i++) s += w.embed[t * H + i] * xn[i]; logits.push(s); }
  return logits;
}
function refForward(w, img, H, W, ids, nLayers) {
  const feats = refVision(w.vit, nLayers, img, H, W);
  const imgEmb = refProj(w.proj, feats);
  let next = 0;
  const seq = ids.map((t) => (t === IMG_TOK ? imgEmb[next++] : Array.from(w.lm.embed.subarray(t * text.hidden, t * text.hidden + text.hidden))));
  return { logits: refLM(w.lm, seq), feats: feats, imgEmb: imgEmb };
}

// 深拷貝（保留 typed array；JSON 會把 Float32Array 變成一般物件）
function deep(o) {
  if (ArrayBuffer.isView(o)) return new o.constructor(o);
  if (Array.isArray(o)) return o.map(deep);
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = deep(o[k]); return r; }
  return o;
}

// ---------- 測試 ----------
check('模型表與 config.json 一致：文字 Qwen2（24 層、1024、16 頭＝16 kv、2816、vocab 152000、qkv 偏置、tied）；視覺 SigLIP（26 層、1152、16 頭、4304、patch 14）', () => {
  const M = L.LLAVA_INTERLEAVE_05B, t = ARCH.archFor(M.text);
  assert.strictEqual(M.text, 'qwen2-0.5b');
  assert.deepStrictEqual([t.layers, t.hidden, t.heads, t.kvHeads, t.ffn, t.vocab], [24, 1024, 16, 16, 2816, 152000]);
  assert.strictEqual(t.bias, true); assert.strictEqual(t.tiedEmbeddings, true); assert.strictEqual(t.rope.base, 1000000);
  assert.strictEqual(ARCH.isSupported('qwen2-0.5b'), true);
  assert.deepStrictEqual([M.vision.layers, M.vision.hidden, M.vision.heads, M.vision.ffn, M.vision.patch, M.vision.channels], [26, 1152, 16, 4304, 14, 3]);
  assert.strictEqual(M.imageTokenId, 151646);
  assert.strictEqual(M.featureLayer, -1); assert.strictEqual(M.featureSelect, 'full'); assert.strictEqual(M.projectorAct, 'gelu');
  assert.strictEqual(L.numImageTokens(M), 729);        // 384 → floor(384/14)=27，27²
  assert.strictEqual(M.gpuNeedsF16, false);
  assert.strictEqual(M.verified, false);               // 沒有真權重，不能標 verified
});

check('裁切：5×6 裁成 4×6，保留左上角；已是整數倍時原樣回傳', () => {
  const img = Float32Array.from({ length: 5 * 6 }, (_, i) => i);
  const c = L.cropToPatch(img, 5, 6, 1, 2);
  assert.strictEqual(c.H, 4); assert.strictEqual(c.W, 6);
  assert.deepStrictEqual(Array.from(c.img.subarray(0, 6)), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(Array.from(c.img.subarray(18, 24)), [18, 19, 20, 21, 22, 23]);
  const img4 = img.subarray(0, 24);
  const same = L.cropToPatch(img4, 4, 6, 1, 2);
  assert.strictEqual(same.H, 4); assert.strictEqual(same.img, img4);
  assert.throws(() => L.cropToPatch(img.subarray(0, 1), 1, 1, 1, 2), /比一個 patch/);
});

check('精確 GELU 與 erf：erf(1) ≈ 0.8427007929，GELU(1) ≈ 0.8413447461，GELU(0)=0；與冪級數參考一致', () => {
  assert.ok(Math.abs(L.erf(1) - 0.8427007929) < 2e-7, 'erf(1)');
  assert.ok(Math.abs(L.geluExact(1) - 0.8413447461) < 2e-7, 'gelu(1)');
  assert.strictEqual(L.geluExact(0), 0);
  for (const x of [-2.5, -0.7, 0.3, 1.9]) assert.ok(Math.abs(L.geluExact(x) - refGeluExact(x)) < 3e-7, 'gelu ' + x);
});

check('視覺特徵形狀：6 個 patch、每個 8 維；featureLayer -2 只跑前 1 層（與參考逐元素一致）', () => {
  const w = allWeights(11, 6);
  const f1 = L.visionFeatures(vis, -1, 'full', w.vit, imgData(3), IH, IW);
  assert.strictEqual(f1.length, 6); f1.forEach((f) => assert.strictEqual(f.length, 8));
  const f2 = L.visionFeatures(vis, -2, 'full', w.vit, imgData(3), IH, IW);
  close(f1[5], refVision(w.vit, 2, imgData(3), IH, IW)[5], 1e-4, 'vision -1 patch5');
  close(f2[0], refVision(w.vit, 1, imgData(3), IH, IW)[0], 1e-4, 'vision -2 patch0');
});

check('視覺特徵與獨立參考逐元素一致（全部 patch、最後一層、不做後 LayerNorm）', () => {
  const w = allWeights(21, 6), img = imgData(5);
  const got = L.visionFeatures(vis, -1, 'full', w.vit, img, IH, IW);
  const want = refVision(w.vit, vis.layers, img, IH, IW);
  assert.strictEqual(got.length, want.length);
  got.forEach((g, i) => close(g, want[i], 1e-4, 'vision patch ' + i));
});

check('投影層與獨立參考逐元素一致（線性 → 精確 GELU → 線性）', () => {
  const w = allWeights(31, 6);
  const feats = L.visionFeatures(vis, -1, 'full', w.vit, imgData(7), IH, IW);
  const got = L.projector(text.hidden, vis.hidden, w.proj, feats);
  const want = refProj(w.proj, refVision(w.vit, vis.layers, imgData(7), IH, IW));
  assert.strictEqual(got.length, 6); got.forEach((g) => assert.strictEqual(g.length, text.hidden));
  got.forEach((g, i) => close(g, want[i], 1e-4, 'proj ' + i));
});

check('插入佔位詞元：影像位置等於影像嵌入列，文字位置等於 embed 列；數量不符或詞表外都丟錯', () => {
  const w = allWeights(41, 6), H = text.hidden;
  const imgEmb = Array.from({ length: 6 }, (_, i) => Float32Array.from({ length: H }, (_, d) => i * 10 + d));
  const seq = L.assemble(text, IDS, imgEmb, IMG_TOK, w.lm.embed);
  assert.strictEqual(seq.length, IDS.length);
  seq.forEach((x, p) => {
    if (IDS[p] === IMG_TOK) close(x, imgEmb[p - 1], 0, 'img row at ' + p);
    else close(x, w.lm.embed.subarray(IDS[p] * H, IDS[p] * H + H), 0, 'text row at ' + p);
  });
  assert.throws(() => L.assemble(text, IDS, imgEmb.slice(0, 5), IMG_TOK, w.lm.embed), /影像佔位詞元有 6 個，但影像嵌入有 5 個/);
  assert.throws(() => L.assemble(text, [1, 9], [], IMG_TOK, w.lm.embed), /超出詞表/);
});

check('整段前向：logits 長度＝vocab、與獨立參考逐元素一致（視覺 → 投影 → 插入 → Qwen2 解碼）', () => {
  const w = allWeights(51, 6), img = imgData(9);
  const got = L.forward(model, w, img, IH, IW, IDS);
  const want = refForward(w, img, IH, IW, IDS, vis.layers);
  assert.strictEqual(got.logits.length, text.vocab);
  assert.strictEqual(got.length, IDS.length);
  assert.strictEqual(got.imageTokens, 6);
  close(got.logits, want.logits, 1e-4, 'logits');
  let best = 0; for (let i = 1; i < want.logits.length; i++) if (want.logits[i] > want.logits[best]) best = i;
  assert.strictEqual(got.argmax, best);
});

check('偏置確實有作用：把 q、k、v 偏置歸零後 logits 會改變（偏置不是擺設）', () => {
  const w = allWeights(61, 6), img = imgData(13);
  const a = L.forward(model, w, img, IH, IW, IDS).logits;
  const w2 = deep(w);
  const zero = (arr) => new Float32Array(arr.length);
  w2.lm.layers.forEach((Lw) => { Lw.bq = zero(Lw.bq); Lw.bk = zero(Lw.bk); Lw.bv = zero(Lw.bv); });
  const b = L.forward(model, w2, img, IH, IW, IDS).logits;
  const diff = Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i])));
  assert.ok(diff > 1e-4, '偏置歸零後最大差 ' + diff);
});

check('形狀與權重錯誤：影像元素數不符、投影權重長度不符、缺 bq、featureLayer 非法、select 非 full，都丟明確錯誤', () => {
  const w = allWeights(71, 6), img = imgData(15);
  assert.throws(() => L.forward(model, w, img.subarray(1), IH, IW, IDS), /元素數/);
  const badProj = Object.assign({}, w, { proj: Object.assign({}, w.proj, { p1W: new Float32Array(3) }) });
  assert.throws(() => L.forward(model, badProj, img, IH, IW, IDS), /投影權重 p1W 長度應為 64/);
  const noBq = deep(w); delete noBq.lm.layers[0].bq;
  assert.throws(() => L.forward(model, noBq, img, IH, IW, IDS), /layers\[0\]\.bq/);
  assert.throws(() => L.visionFeatures(vis, 1, 'full', w.vit, img, IH, IW), /featureLayer/);
  assert.throws(() => L.visionFeatures(vis, -3, 'full', w.vit, img, IH, IW), /featureLayer/);
  assert.throws(() => L.visionFeatures(vis, -1, 'cls', w.vit, img, IH, IW), /full/);
  assert.throws(() => L.forward(model, w, img, IH, IW, [1, 2, 3]), /影像佔位詞元有 0 個/);
});

console.log('llava_skeleton_test: ' + passes + ' 項通過');
