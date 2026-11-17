'use strict';
// kernel_gen 的 node 測試（G1）：參數推導、能力過濾、WGSL 結構（fma 數、屏障數、陣列大小、長度），
// 以及用 JS 逐步模擬「同一套索引公式」與 CPU 參考比對（驗證索引數學，不驗證 WGSL 語法）。
const assert = require('assert');
const KG = require('./kernel_gen.js');
const core = require('./gpu_core.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

// 用與 WGSL 相同的索引公式在 JS 裡跑一遍（scalar 與 vec4 兩路）
function simulate(spec, A, B, M, K, N) {
  const d = KG.describe(spec).v;
  const { WG, TM, TN, BM, BN, BK, vec } = d;
  const threads = WG * WG;
  const y = new Float32Array(M * N);
  const As = new Float32Array(BM * BK), Bs = new Float32Array(BK * BN);
  const gx = Math.ceil(N / BN), gy = Math.ceil(M / BM);
  for (let wy = 0; wy < gy; wy++) for (let wx = 0; wx < gx; wx++) {
    const row0 = wy * BM, col0 = wx * BN;
    const acc = []; for (let tid0 = 0; tid0 < threads; tid0++) acc.push(new Float32Array(TM * TN));
    for (let t = 0; t < K / BK; t++) {
      const k0 = t * BK;
      // 協作搬入（與 WGSL 的 for q = tid; q < N; q += threads 對應）
      for (let tid = 0; tid < threads; tid++) {
        if (vec === 4) {
          const BKV = BK / 4, BNV = BN / 4;
          for (let q = tid; q < BM * BKV; q += threads) {
            const ar = Math.floor(q / BKV), ak = (q % BKV) * 4, gr = row0 + ar;
            for (let j = 0; j < 4; j++) As[ar * BK + ak + j] = (gr < M) ? A[gr * K + k0 + ak + j] : 0;
          }
          for (let q = tid; q < BK * BNV; q += threads) {
            const br = Math.floor(q / BNV), bc = (q % BNV) * 4, gc = col0 + bc;
            for (let j = 0; j < 4; j++) Bs[br * BN + bc + j] = (gc + j < N) ? B[(k0 + br) * N + gc + j] : 0;
          }
        } else {
          for (let q = tid; q < BM * BK; q += threads) {
            const ar = Math.floor(q / BK), ak = q % BK, gr = row0 + ar;
            As[q] = (gr < M) ? A[gr * K + k0 + ak] : 0;
          }
          for (let q = tid; q < BK * BN; q += threads) {
            const br = Math.floor(q / BN), bc = q % BN, gc = col0 + bc;
            Bs[q] = (gc < N) ? B[(k0 + br) * N + gc] : 0;
          }
        }
      }
      // 計算（每個執行緒）
      for (let ty = 0; ty < WG; ty++) for (let tx = 0; tx < WG; tx++) {
        const a = acc[ty * WG + tx];
        for (let kk = 0; kk < BK; kk++) {
          const bv = []; for (let j = 0; j < TN; j++) bv.push(Bs[kk * BN + tx * TN + j]);
          for (let i = 0; i < TM; i++) {
            const av = As[(ty * TM + i) * BK + kk];
            for (let j = 0; j < TN; j++) a[i * TN + j] = Math.fround(av * bv[j] + a[i * TN + j]);
          }
        }
      }
    }
    // 寫回
    for (let ty = 0; ty < WG; ty++) for (let tx = 0; tx < WG; tx++) {
      const a = acc[ty * WG + tx];
      for (let i = 0; i < TM; i++) for (let j = 0; j < TN; j++) {
        const gr = row0 + ty * TM + i, gc = col0 + tx * TN + j;
        if (gr < M && gc < N) y[gr * N + gc] = a[i * TN + j];
      }
    }
  }
  return y;
}

check('describe：推導 BM、BN、共用記憶體與執行緒數', () => {
  const d = KG.describe({ WG: 16, TM: 8, TN: 8, BK: 8, vec: 1 }).v;
  assert.strictEqual(d.BM, 128); assert.strictEqual(d.BN, 128);
  assert.strictEqual(d.sharedBytes, (128 * 8 + 8 * 128) * 4);   // 8 KiB
  assert.strictEqual(d.threads, 256);
});

check('describe：不合法的組合要說明原因（TM 不是 2 的冪、vec4 需要 4 的倍數）', () => {
  assert.strictEqual(KG.describe({ WG: 16, TM: 3, TN: 4, BK: 8, vec: 1 }).ok, false);
  const r = KG.describe({ WG: 16, TM: 4, TN: 2, BK: 8, vec: 4 });
  assert.strictEqual(r.ok, false); assert.ok(/vec4/.test(r.reason));
});

check('enumerate：三種能力表過濾正確（共用記憶體、執行緒、暫存器預算）', () => {
  const low = KG.enumerate({ maxWgStorage: 16384, maxInvocations: 256, regBudget: 64 });
  const tiny = KG.enumerate({ maxWgStorage: 4096, maxInvocations: 256, regBudget: 64 });
  const big = KG.enumerate({ maxWgStorage: 32768, maxInvocations: 1024, regBudget: 128 });
  assert.ok(low.length > 0 && tiny.length > 0 && big.length > 0);
  for (const v of low) { assert.ok(v.sharedBytes <= 16384); assert.ok(v.threads <= 256); assert.ok(v.regsEstimate <= 64); }
  for (const v of tiny) assert.ok(v.sharedBytes <= 4096);
  assert.ok(tiny.length < low.length, '共用記憶體變小，合法變體變少');
  assert.ok(big.length >= low.length, '能力更強，合法變體不會變少');
});

check('generate：8×8 scalar 版的 WGSL 結構（fma 數＝TM·TN·BK 展開中的 TM·TN、屏障 2、陣列大小）', () => {
  const s = KG.generate({ WG: 16, TM: 8, TN: 8, BK: 8, vec: 1 });
  assert.ok(s.startsWith('// @kernel matmul_g_128x128x8_t8x8\n'));
  assert.strictEqual(s.split('fma(').length - 1, 64, 'fma 只在 k 迴圈裡展開一次');
  assert.strictEqual(s.split('workgroupBarrier()').length - 1, 2, '搬入後一次、計算後一次（每個 k 瓦片各一次）');
  assert.ok(s.includes('var<workgroup> As: array<f32, 1024>;'));
  assert.ok(s.includes('var<workgroup> Bs: array<f32, 1024>;'));
  assert.ok(s.length < 12000, '程式要短，實際 ' + s.length);
});

check('generate：vec4 版用 array<vec4<f32>> 綁定，且內層 k 仍是迴圈', () => {
  const s = KG.generate({ WG: 16, TM: 4, TN: 4, BK: 8, vec: 4 });
  assert.ok(/array<vec4<f32>>/.test(s));
  assert.ok(/for \(var kk: u32 = 0u; kk < 8u;/.test(s));
  assert.strictEqual(s.split('fma(').length - 1, 16);
});

check('索引模擬（scalar）：與 CPU 參考逐元素一致（非整除形狀、邊界）', () => {
  let seed = 3; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 - 0.5; };
  for (const [M, K, N] of [[70, 16, 90], [130, 8, 129], [5, 24, 7]]) {
    const A = Float32Array.from({ length: M * K }, rnd), B = Float32Array.from({ length: K * N }, rnd);
    const got = simulate({ WG: 16, TM: 4, TN: 4, BK: 8, vec: 1 }, A, B, M, K, N);
    const ref = core.matmulTRef(A, B, M, K, N, 0);
    let mx = 0, sc = 1e-9; for (let i = 0; i < ref.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
    assert.ok(mx / sc <= 1e-6, M + 'x' + K + 'x' + N + ' 相對誤差 ' + mx / sc);
  }
});

check('索引模擬（vec4）：K、N 為 4 的倍數時與 CPU 參考一致', () => {
  let seed = 5; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 - 0.5; };
  const M = 70, K = 32, N = 92;
  const A = Float32Array.from({ length: M * K }, rnd), B = Float32Array.from({ length: K * N }, rnd);
  const got = simulate({ WG: 16, TM: 4, TN: 4, BK: 8, vec: 4 }, A, B, M, K, N);
  const ref = core.matmulTRef(A, B, M, K, N, 0);
  let mx = 0, sc = 1e-9; for (let i = 0; i < ref.length; i++) { mx = Math.max(mx, Math.abs(got[i] - ref[i])); sc = Math.max(sc, Math.abs(ref[i])); }
  assert.ok(mx / sc <= 1e-6, '相對誤差 ' + mx / sc);
});

check('dispatchFor：分派數由 BM、BN 決定', () => {
  assert.deepStrictEqual(KG.dispatchFor({ WG: 16, TM: 8, TN: 8, BK: 8, vec: 1 }, 512, 1024, 1), [8, 4, 1]);
  assert.deepStrictEqual(KG.dispatchFor({ WG: 16, TM: 4, TN: 4, BK: 8, vec: 4 }, 70, 90, 2), [2, 2, 2]);
});

console.log(passed + ' 項通過');
