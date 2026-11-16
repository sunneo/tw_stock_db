// attn_ops_test.js — 注意力＋KV 快取 CPU 參考版的測試（node 直接跑）。用法：node renderer/src/gpu/attn_ops_test.js
'use strict';
const A = require('./attn_ops.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ' + m); } else { fail++; console.log('FAIL ' + m); } };

// 決定性的偽亂數（同一組輸入每次一樣）
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }
const fill = (n, r) => Float64Array.from({ length: n }, () => r());
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

const H = 4, Hkv = 2, hd = 8, THETA = 1e6, EPS = 1e-6;
const r = rng(12345);
const qNorm = fill(hd, r).map((x) => 1 + 0.1 * x), kNorm = fill(hd, r).map((x) => 1 + 0.1 * x);

// 1) RoPE：位置 0 是恆等；旋轉不改變每個頭的長度
{
  const x = fill(H * hd, r);
  const y0 = A.ropeHalf(x, 1, H, hd, 0, THETA);
  ok(maxDiff(y0, x) < 1e-12, 'RoPE：位置 0 為恆等');
  const x2 = fill(2 * H * hd, r);
  const y = A.ropeHalf(x2, 2, H, hd, 7, THETA);
  let worst = 0;
  for (let t = 0; t < 2; t++) for (let h = 0; h < H; h++) {
    const o = (t * H + h) * hd; let a = 0, b = 0;
    for (let d = 0; d < hd; d++) { a += x2[o + d] * x2[o + d]; b += y[o + d] * y[o + d]; }
    worst = Math.max(worst, Math.abs(a - b));
  }
  ok(worst < 1e-9, 'RoPE：旋轉保持每個頭的長度（最大偏差 ' + worst.toExponential(2) + '）');
}

// 2) 解碼一步一步 == 一次預填（KV 快取正確性的核心）
{
  const S = 6;
  const q = fill(S * H * hd, r), k = fill(S * Hkv * hd, r), v = fill(S * Hkv * hd, r);
  const cA = A.createKvCache(Hkv, hd, S);
  const full = A.attentionBlock({ q, k, v, S, H, Hkv, hd, theta: THETA, eps: EPS, qNorm, kNorm, cache: cA });
  const cB = A.createKvCache(Hkv, hd, S);
  const step = new Float64Array(S * H * hd);
  for (let t = 0; t < S; t++) {
    const o = A.attentionBlock({
      q: q.slice(t * H * hd, (t + 1) * H * hd), k: k.slice(t * Hkv * hd, (t + 1) * Hkv * hd), v: v.slice(t * Hkv * hd, (t + 1) * Hkv * hd),
      S: 1, H, Hkv, hd, theta: THETA, eps: EPS, qNorm, kNorm, cache: cB,
    });
    step.set(o, t * H * hd);
  }
  const d = maxDiff(full, step);
  ok(d < 1e-6, '解碼逐步 == 一次預填（最大偏差 ' + d.toExponential(2) + '）');
  ok(cA.len === S && cB.len === S, '快取長度都等於 S');
}

// 3) 因果遮罩：改掉最後一個詞元，前面的輸出不變
{
  const S = 5;
  const q = fill(S * H * hd, r), k = fill(S * Hkv * hd, r), v = fill(S * Hkv * hd, r);
  const run = (kk, vv) => A.attentionBlock({ q, k: kk, v: vv, S, H, Hkv, hd, theta: THETA, eps: EPS, qNorm, kNorm, cache: A.createKvCache(Hkv, hd, S) });
  const base = run(k, v);
  const k2 = k.slice(), v2 = v.slice();
  for (let i = (S - 1) * Hkv * hd; i < S * Hkv * hd; i++) { k2[i] += 5; v2[i] -= 3; }
  const alt = run(k2, v2);
  const prefix = (S - 1) * H * hd;
  ok(maxDiff(base.slice(0, prefix), alt.slice(0, prefix)) < 1e-12, '因果遮罩：前 S-1 個詞元的輸出不受最後一個詞元影響');
  ok(maxDiff(base.slice(prefix), alt.slice(prefix)) > 1e-3, '最後一個詞元的輸出確實會變（測試本身有效）');
}

// 4) 所有鍵相同 → 權重平均；直接測 attnCore（不經 RoPE）
{
  const cache = A.createKvCache(Hkv, hd, 4);
  const kRow = fill(Hkv * hd, r), vAll = [];
  for (let j = 0; j < 4; j++) {
    const k = kRow.slice(), v = fill(Hkv * hd, r); vAll.push(v);
    A.kvAppend(cache, k, v, 1);
  }
  const q = fill(1 * H * hd, r);
  const out = A.attnCore(q, 1, 3, cache, H, 1 / Math.sqrt(hd)); // 位置 3，看 0..3 四個鍵
  let worst = 0;
  for (let h = 0; h < H; h++) {
    const kvh = Math.floor(h / (H / Hkv));
    for (let d = 0; d < hd; d++) {
      let mean = 0; for (let j = 0; j < 4; j++) mean += vAll[j][kvh * hd + d]; mean /= 4;
      worst = Math.max(worst, Math.abs(out[h * hd + d] - mean));
    }
  }
  ok(worst < 1e-6, 'softmax 權重平均（鍵全相同）：最大偏差 ' + worst.toExponential(2));
}

// 5) GQA 對應：查詢頭 0 與 1 共用 KV 頭 0；給它們同樣的 q，輸出必須相同
{
  const S = 3;
  const q = fill(S * H * hd, r);
  for (let t = 0; t < S; t++) for (let d = 0; d < hd; d++) q[(t * H + 1) * hd + d] = q[(t * H + 0) * hd + d];
  const k = fill(S * Hkv * hd, r), v = fill(S * Hkv * hd, r);
  const out = A.attentionBlock({ q, k, v, S, H, Hkv, hd, theta: THETA, eps: EPS, qNorm, kNorm, cache: A.createKvCache(Hkv, hd, S) });
  let worst = 0;
  for (let t = 0; t < S; t++) for (let d = 0; d < hd; d++) worst = Math.max(worst, Math.abs(out[(t * H + 0) * hd + d] - out[(t * H + 1) * hd + d]));
  ok(worst < 1e-12, 'GQA：查詢頭 0 與 1（同屬 KV 頭 0）同 q 時輸出相同');
}

// 6) 錯誤處理：快取裝不下、H 不是 Hkv 的整數倍、長度不符都要丟錯（不默默算錯）
{
  let threw = 0;
  try { A.kvAppend(A.createKvCache(1, 2, 1), new Float64Array(2), new Float64Array(2), 2); } catch (_) { threw++; }
  try { A.attnCore(new Float64Array(3 * 1 * 2), 1, 0, A.createKvCache(2, 2, 2), 3, 1); } catch (_) { threw++; }
  try { A.ropeHalf(new Float64Array(5), 1, 1, 4, 0, THETA); } catch (_) { threw++; }
  ok(threw === 3, '錯誤輸入（快取裝不下、H 不整除、長度不符）都會丟錯');
}

console.log('\n' + pass + ' 項通過，' + fail + ' 項失敗');
process.exitCode = fail ? 1 : 0;
