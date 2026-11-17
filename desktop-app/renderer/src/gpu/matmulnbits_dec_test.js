// node renderer/src/gpu/matmulnbits_dec_test.js — MatMulNBits 解碼變體（清單 O3）的 node 測試，不需要 GPU。
// 真 GPU 的逐元素對拍在真 Chrome（待 WebGPU 介面卡恢復）：相對誤差 ≤1e-5。
'use strict';
const assert = require('assert');
const REF = require('./matmulnbits_ref.js');
const G = require('./matmulnbits_gpu.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

let s = 31; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
const randQ = (n) => Uint8Array.from({ length: n }, () => (Math.floor((rnd() + 0.5) * 16)) & 15);
const randScale = (n) => Float32Array.from({ length: n }, () => Math.abs(rnd()) * 0.1 + 0.01);
function relErr(x, y) { let mx = 0, sc = 1e-12; for (let i = 0; i < y.length; i++) { mx = Math.max(mx, Math.abs(x[i] - y[i])); sc = Math.max(sc, Math.abs(y[i])); } return mx / sc; }

// 逐行照 WGSL_MATMULNBITS_DEC 的索引數學（工作群組 256、16 欄 × 16 條 lane、256 個 k 的分塊）在 JS 裡跑一遍，
// 驗證「字（8 個 nibble）→ k、區塊 → 縮放值」的對應，這是真 GPU 上最容易錯的地方。
function emulateDec(A, M, K, B, scales, N) {
  const nb = REF.nBlocksOf(K), nw = nb * 4;
  const Y = new Float32Array(M * N);
  const B32 = new Uint32Array(B.buffer, B.byteOffset, B.length / 4);
  for (let m = 0; m < M; m++) {
    for (let wg = 0; wg < Math.ceil(N / 16); wg++) {
      const red = new Float32Array(256);
      for (let t = 0; t < 256; t++) {
        const col = wg * 16 + Math.floor(t / 16), lane = t % 16;
        let acc = 0;
        for (let kt = 0; kt < K; kt += 256) {
          const xs = new Float32Array(256);
          for (let tt = 0; tt < 256; tt++) xs[tt] = (kt + tt < K) ? A[m * K + kt + tt] : 0;
          for (let j = 0; j < 2; j++) {
            const wl = lane + j * 16, gw = kt / 8 + wl;
            if (col < N && gw < nw) {
              const word = B32[col * nw + gw];
              const sc = scales[col * nb + Math.floor(gw / 4)];
              for (let i = 0; i < 8; i++) {
                const byte = (word >>> ((Math.floor(i / 2)) * 8)) & 255;
                const nib = (byte >>> ((i & 1) * 4)) & 15;
                acc = Math.fround(acc + Math.fround(xs[wl * 8 + i] * Math.fround((nib - 8) * sc)));
              }
            }
          }
        }
        red[t] = acc;
      }
      for (let t = 0; t < 256; t++) {
        const col = wg * 16 + Math.floor(t / 16), lane = t % 16;
        if (lane === 0 && col < N) { let sum = 0; for (let l = 0; l < 16; l++) sum = Math.fround(sum + red[t + l]); Y[m * N + col] = sum; }
      }
    }
  }
  return Y;
}

(async () => {
  const cases = [
    { M: 1, K: 32, N: 16 }, { M: 1, K: 96, N: 20 }, { M: 2, K: 40, N: 33 }, { M: 3, K: 300, N: 17 }, { M: 1, K: 1024, N: 48 },
  ];
  for (const c of cases) {
    await t('索引數學（與 WGSL 同結構的 JS 模擬）與參考版相對誤差 ≤1e-5：M=' + c.M + ' K=' + c.K + ' N=' + c.N, () => {
      const nb = REF.nBlocksOf(c.K);
      const A = Float32Array.from({ length: c.M * c.K }, rnd);
      const B = REF.packQ4(randQ(c.N * c.K), c.N, c.K);
      const sc = randScale(c.N * nb);
      const ref = REF.matmulNBitsRef(A, c.M, c.K, B, sc, c.N);
      const em = emulateDec(A, c.M, c.K, B, sc, c.N);
      assert.ok(relErr(em, ref) <= 1e-5, '相對誤差 ' + relErr(em, ref));
    });
  }

  await t('變體選擇：M ≤ 8 → matmulnbits_dec；較大 M 仍用逐格版（預填平鋪未實作）；可強制', () => {
    assert.strictEqual(G.matmulNBitsVariant(1, {}), 'matmulnbits_dec');
    assert.strictEqual(G.matmulNBitsVariant(8, {}), 'matmulnbits_dec');
    assert.strictEqual(G.matmulNBitsVariant(9, {}), 'matmulnbits');
    assert.strictEqual(G.matmulNBitsVariant(64, { nbVariant: 'matmulnbits_dec' }), 'matmulnbits_dec');
  });

  await t('WGSL：@kernel matmulnbits_dec、256 執行緒、共用記憶體 2 KiB、派發為二維（欄 × 列）', () => {
    const src = G.WGSL_MATMULNBITS_DEC;
    assert.ok(/@kernel matmulnbits_dec/.test(src));
    assert.ok(/@workgroup_size\(256\)/.test(src));
    assert.ok((256 + 256) * 4 <= 16 * 1024);
    for (let b = 0; b <= 4; b++) assert.ok(new RegExp('@binding\\(' + b + '\\)').test(src), 'binding ' + b);
  });

  await t('假裝置：解碼變體走 T1、結果與參考一致（主機端的綁定、二維派發與 uniform）', async () => {
    const M = 2, K = 96, N = 20, nb = REF.nBlocksOf(K);
    const A = Float32Array.from({ length: M * K }, rnd);
    const B = REF.packQ4(randQ(N * K), N, K);
    const sc = randScale(N * nb);
    const ref = REF.matmulNBitsRef(A, M, K, B, sc, N);
    const r = await G.matmulNBits(A, M, K, B, sc, N, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1', JSON.stringify(r.info));
    assert.ok(relErr(r.result, ref) <= 1e-5);
  });

  await t('沒有 WebGPU：退到 cpu-js 並寫明原因', async () => {
    const M = 1, K = 64, N = 8, nb = REF.nBlocksOf(K);
    const A = Float32Array.from({ length: M * K }, rnd);
    const B = REF.packQ4(randQ(N * K), N, K);
    const sc = randScale(N * nb);
    const r = await G.matmulNBits(A, M, K, B, sc, N, { navigator: undefined });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.length > 0);
  });

  console.log(pass + ' 項通過');
})();
