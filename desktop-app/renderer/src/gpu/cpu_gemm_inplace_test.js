'use strict';
// 原地轉置與轉置旗標測試（node）：預設不改輸入；inplace:true 才原地轉置（並明確檢查輸入被改成轉置後內容）。
const assert = require('assert');
const G = require('./cpu_gemm.js');

const fill = (n, s) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const relMax = (y, r) => { let m = 0; for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(y[i] - r[i]) / Math.max(1, Math.abs(r[i]))); return m; };
const transposeRef = (X, R, C) => { const T = new Float32Array(R * C); for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) T[j * R + i] = X[i * C + j]; return T; };

// 1. 原地轉置：方陣與非方陣（含單列、單行、大小不規則）
for (const [R, C] of [[1, 5], [5, 1], [3, 7], [7, 3], [4, 4], [6, 9], [2, 1024], [1, 1], [0, 0]]) {
  const X = Float32Array.from({ length: R * C }, (_, i) => i * 1.5 - 7);
  const ref = transposeRef(X, R, C);
  G.transposeInPlace(X, R, C);
  assert.deepStrictEqual(X, ref, `${R}×${C} 原地轉置錯誤`);
}
console.log('ok 原地轉置：方陣與非方陣（含 1×N、N×1、1×1）正確');

// 2. 長度不足要拋錯，不要默默寫壞記憶體
assert.throws(() => G.transposeInPlace(new Float32Array(5), 2, 3));
console.log('ok 長度不足拋錯');

// 3. 預設（沒給 inplace）：不改輸入，結果正確（四種轉置組合）
for (const [tA, tB] of [[false, false], [true, false], [false, true], [true, true]]) {
  const m = 13, k = 17, n = 11;
  const A = fill(m * k, 1), B = fill(k * n, 2);
  const A0 = A.slice(), B0 = B.slice();
  const y = G.gemmWithOptions(A, B, m, k, n, { transA: tA, transB: tB });
  assert.deepStrictEqual(A, A0, '預設模式改動了 A');
  assert.deepStrictEqual(B, B0, '預設模式改動了 B');
  assert.ok(relMax(y, G.gemmNaive(A, B, m, k, n, { transA: tA, transB: tB })) <= 1e-5);
}
console.log('ok 預設不改輸入，四種轉置組合結果正確');

// 4. inplace:true 轉置 A：A 被改成 m×k 的行主序（轉置後內容），結果與參考一致
{
  const m = 7, k = 5, n = 9;
  const Astore = fill(k * m, 3);            // A 以 k×m 儲存（transA）
  const B = fill(k * n, 4);
  const expectedA = transposeRef(Astore, k, m);   // 轉置後應是 m×k
  const ref = G.gemmNaive(Astore, B, m, k, n, { transA: true });
  const y = G.gemmWithOptions(Astore, B, m, k, n, { transA: true, inplace: true });
  assert.deepStrictEqual(Astore, expectedA, 'inplace 應把呼叫端的 A 原地轉成 m×k');
  assert.ok(relMax(y, ref) <= 1e-5, 'inplace 結果錯誤');
  console.log('ok inplace:true 轉置 A：呼叫端 A 被原地轉置，結果正確（這是有記錄的副作用）');
}

// 5. inplace:true 轉置 B
{
  const m = 6, k = 4, n = 10;
  const A = fill(m * k, 5);
  const Bstore = fill(n * k, 6);            // B 以 n×k 儲存（transB）
  const expectedB = transposeRef(Bstore, n, k);  // 轉置後 k×n
  const ref = G.gemmNaive(A, Bstore, m, k, n, { transB: true });
  const y = G.gemmWithOptions(A, Bstore, m, k, n, { transB: true, inplace: true });
  assert.deepStrictEqual(Bstore, expectedB, 'inplace 應把呼叫端的 B 原地轉成 k×n');
  assert.ok(relMax(y, ref) <= 1e-5);
  console.log('ok inplace:true 轉置 B：呼叫端 B 被原地轉置，結果正確');
}

console.log('cpu_gemm_inplace_test：全部通過');
