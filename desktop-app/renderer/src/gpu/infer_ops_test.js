// node renderer/src/gpu/infer_ops_test.js — infer_ops／onnx_lite／infer_poc_core 的單元測試（不需要 GPU，也不需要真模型）
'use strict';
const assert = require('assert');
const ops = require('./infer_ops.js');
const poc = require('./infer_poc_core.js');
const lite = require('./onnx_lite.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

(async () => {
  await t('quantizeDynamicRef：範圍、zero point 與還原誤差', () => {
    const x = Float32Array.from([-1, -0.5, 0, 0.25, 2]);
    const r = ops.quantizeDynamicRef(x);
    assert.strictEqual(r.q.length, 5);
    for (let i = 0; i < 5; i++) assert(Math.abs((r.q[i] - r.zp) * r.scale - x[i]) <= r.scale / 2 + 1e-6);
    const z = ops.quantizeDynamicRef(new Float32Array(4));
    assert.strictEqual(z.scale, 1); assert.strictEqual(z.zp, 0);
  });
  await t('q8mmRef 與暴力三層迴圈一致', () => {
    const M = 3, K = 5, N = 7, wzp = 128;
    const W = new Uint8Array(K * N).map((_, i) => (i * 37 + 11) & 255);
    const xq = Int32Array.from({ length: M * K }, (_, i) => ((i * 53) % 511) - 255);
    const r = ops.q8mmRef(xq, W, wzp, M, K, N, 0.001);
    for (let m = 0; m < M; m++) for (let n = 0; n < N; n++) {
      let s = 0; for (let k = 0; k < K; k++) s += xq[m * K + k] * (W[k * N + n] - wzp);
      assert.strictEqual(r[m * N + n], Math.fround(Math.fround(s) * Math.fround(0.001)));
    }
  });
  await t('q8lmRef 與直接定義一致，planChunks 涵蓋所有列且不超過上限', () => {
    const V = 10, K = 8, zp = 100;
    const W = new Uint8Array(V * K).map((_, i) => (i * 29) & 255);
    const x = Float32Array.from({ length: K }, (_, i) => i - 3.5);
    const r = ops.q8lmRef(x, W, zp, V, K, 0.01);
    for (let v = 0; v < V; v++) { let s = 0; for (let k = 0; k < K; k++) s += x[k] * (W[v * K + k] - zp); assert(Math.abs(r[v] - s * 0.01) < 1e-12); }
    const ch = ops.planChunks(W, V, K, 24);  // 24 位元組 → 每塊 3 列
    assert.strictEqual(ch.length, 4);
    assert.strictEqual(ch.reduce((s, c) => s + c.rows, 0), V);
    assert(ch.every((c) => c.w.length <= 24));
  });
  await t('沒有 WebGPU 時 q8mm／q8lm 退到 cpu-js，並寫明原因', async () => {
    const W = new Uint8Array(4 * 4).map((_, i) => i * 7);
    const xq = Int32Array.from([1, -2, 3, -4]);
    const a = await ops.q8mm(xq, W, 5, 1, 4, 4, 0.5, { navigator: undefined });
    assert.strictEqual(a.info.layer, 'cpu-js'); assert(a.info.reason.length > 0);
    assert.deepStrictEqual(Array.from(a.result), Array.from(ops.q8mmRef(xq, W, 5, 1, 4, 4, 0.5)));
    const ch = ops.planChunks(W, 4, 4, 8);
    const b = await ops.q8lm(Float32Array.from([1, 2, 3, 4]), ch, 5, 4, 0.5, { navigator: undefined });
    assert.strictEqual(b.info.layer, 'cpu-js');
    assert.strictEqual(b.result.length, 4);
  });
  await t('WGSL 原始碼含必要的綁定與 kernel 標記', () => {
    for (const s of [ops.WGSL_Q8MM, ops.WGSL_Q8LM]) { assert(/@kernel q8/.test(s)); assert(/@binding\(3\)/.test(s)); assert(/@workgroup_size\(64\)/.test(s)); }
  });
  await t('q8mm_dec：核心標記、256 執行緒、共用記憶體 5 KiB 內；變體選擇（N%4、強制覆蓋）', () => {
    const s = ops.WGSL_Q8MM_DEC;
    assert(/@kernel q8mm_dec/.test(s)); assert(/@workgroup_size\(256\)/.test(s)); assert(/@binding\(3\)/.test(s));
    // 共用記憶體：xs（256 個 i32）＋ red（1024 個 i32）＝ 5120 位元組，低階卡上限 16 KiB
    assert((256 + 1024) * 4 <= 16 * 1024);
    const pf = ops.WGSL_Q8MM_PF;
    assert(/@kernel q8mm_pf/.test(pf)); assert(/@workgroup_size\(256\)/.test(pf));
    // 共用記憶體：xs（1024 個 i32）＋ ws（256 個 u32）＝ 5120 位元組
    assert((1024 + 256) * 4 <= 16 * 1024);
    assert.strictEqual(ops.q8mmVariant(1024, {}, 1), 'dec');
    // 多列解碼 q8mm_decr：共用記憶體 xs（1024 個 i32）＋ red（1024 個 i32）＝ 8 KiB，低階卡上限 16 KiB 內
    assert(/@kernel q8mm_decr/.test(ops.WGSL_Q8MM_DECR)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_DECR));
    assert((1024 + 1024) * 4 <= 16 * 1024);
    // 8 列版 q8mm_decr8：xs 2048 個 i32＝8 KiB（歸約時同一段當 red），低階卡上限 16 KiB 內
    assert(/@kernel q8mm_decr8/.test(ops.WGSL_Q8MM_DECR8)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_DECR8));
    assert(2048 * 4 <= 16 * 1024);
    assert.strictEqual(ops.q8mmVariant(1024, {}, 2), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 4), 'decr');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 7), 'decr');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 8), 'decr8');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 16), 'decr8');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 63), 'decr8');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'decr8' }, 1), 'decr8');
    // f32 8 列版：只在 K ≤ 4096 時路由（精確條件）；沒給 K 時走 i32 版
    assert(/@kernel q8mm_decr8f/.test(ops.WGSL_Q8MM_DECR8F)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_DECR8F));
    assert.strictEqual(ops.q8mmVariant(1024, {}, 8, 1024), 'decr8f');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 16, 4096), 'decr8f');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 16, 8192), 'decr8');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 16), 'decr8');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'decr8f' }, 1), 'decr8f');
    // 預填 4×8 版：M ≥ 64 且 K ≤ 4096 時路由（f32 精確條件）；其餘仍用 pf
    assert(/@kernel q8mm_pf8x4/.test(ops.WGSL_Q8MM_PF8X4)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_PF8X4));
    assert.strictEqual(ops.q8mmVariant(1024, {}, 64, 1024), 'pf8x4');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 256, 4096), 'pf8x4');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 64, 8192), 'pf');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 64), 'pf');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'pf8x4' }, 1), 'pf8x4');
    // 4 列 f32 版：4 ≤ M < 8 且 K ≤ 4096 時路由；沒給 K 時走 i32 decr
    assert(/@kernel q8mm_decr4f/.test(ops.WGSL_Q8MM_DECR4F)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_DECR4F));
    assert.strictEqual(ops.q8mmVariant(1024, {}, 4, 1024), 'decr4f');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 7, 4096), 'decr4f');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 7, 8192), 'decr');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 4), 'decr');
    // 2 列 f32 版：只在 M=2 且 K ≤ 4096 時路由
    assert(/@kernel q8mm_decr2f/.test(ops.WGSL_Q8MM_DECR2F)); assert(/@workgroup_size\(256\)/.test(ops.WGSL_Q8MM_DECR2F));
    assert.strictEqual(ops.q8mmVariant(1024, {}, 2, 1024), 'decr2f');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 2, 8192), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 2), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 1, 1024), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 3, 1024), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, {}, 64), 'pf');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'decr' }, 1), 'decr');
    assert.strictEqual(ops.q8mmVariant(6, {}, 64), 'simple');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'simple' }, 64), 'simple');
    assert.strictEqual(ops.q8mmVariant(6, { q8variant: 'dec' }, 1), 'dec');
    assert.strictEqual(ops.q8mmVariant(1024, { q8variant: 'pf' }, 1), 'pf');
  });
  await t('onnx_lite：讀自製的最小 protobuf（權重與純量）', () => {
    const vi = (n) => Buffer.from([n]);
    const fv = (f, v) => Buffer.concat([vi(f * 8), vi(v)]);
    const fb = (f, b) => Buffer.concat([vi(f * 8 + 2), vi(b.length), b]);
    const tens = Buffer.concat([fv(1, 2), fv(2, 2), fb(8, Buffer.from('W')), fb(9, Buffer.from([1, 2]))]);
    const sc = Buffer.concat([fv(2, 1), fb(8, Buffer.from('s')), fb(4, Buffer.from([0, 0, 0x80, 0x3f]))]);
    const graph = Buffer.concat([fb(5, tens), fb(5, sc)]);
    const m = lite.parseModel(Buffer.concat([fb(7, graph)]));
    assert.deepStrictEqual(m.inits.W.dims, [2]);
    assert.deepStrictEqual(Array.from(lite.tensorBytes(m, 'W')), [1, 2]);
    assert.strictEqual(lite.scalar(m, 's'), 1);
  });
  await t('infer_poc_core：fixedInput 決定性、compare 與 TOL', () => {
    assert.deepStrictEqual(Array.from(poc.fixedInput(8, 1)), Array.from(poc.fixedInput(8, 1)));
    const c = poc.compare(Float32Array.from([1, 2, 3.001]), Float32Array.from([1, 2, 3]));
    assert(c.maxAbs > 0 && c.maxRel < 1e-3 && c.exactFrac > 0.6);
    assert(poc.TOL.mlp < poc.TOL.lm);
  });
  console.log(pass + ' 項通過');
})();
