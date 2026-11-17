'use strict';
// mm_ops：批次矩陣乘（共用權重／逐批權重）、MatMulInteger（零點）；沒有 WebGPU 時退 cpu-js 且與參考一致。
// 真圖逐節點對真 ORT 與 Chrome 軟體 WebGPU：scripts/eval/cudaweb_node_dump.js、cudaweb_node_gpu_check.js。
const assert = require('assert');
const M = require('./mm_ops.js');
(async () => {
  let s = 9; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  const a = Float32Array.from({ length: 2 * 3 * 4 }, rnd), b1 = Float32Array.from({ length: 4 * 5 }, rnd), b2 = Float32Array.from({ length: 2 * 4 * 5 }, rnd);
  const r1 = M.matmulRef(a, [2, 3, 4], b1, [4, 5]), r2 = M.matmulRef(a, [2, 3, 4], b2, [2, 4, 5]);
  assert.deepStrictEqual(r1.dims, [2, 3, 5]);
  // 手算一格：批次 1 的 (0,0)
  let e = 0; for (let k = 0; k < 4; k++) e += a[12 + k] * b2[20 + k * 5]; assert.ok(Math.abs(r2.y[15] - e) < 1e-6);
  const o = { navigator: undefined };
  assert.deepStrictEqual(Array.from((await M.matmul(a, [2, 3, 4], b2, [2, 4, 5], o)).y), Array.from(r2.y));
  assert.ok(/cpu-js/.test(o.lastInfo.layer), JSON.stringify(o.lastInfo));
  const ai = Uint8Array.from([1, 2, 3, 4, 5, 6]), bi = Int8Array.from([1, -1, 2, 0, 3, 1]);
  const ri = M.matmulIntRef(ai, [2, 3], bi, [3, 2], 1, 0); // A−1 = [0,1,2;3,4,5]
  assert.deepStrictEqual(Array.from(ri.y), [0 * 1 + 1 * 2 + 2 * 3, 0 * -1 + 1 * 0 + 2 * 1, 3 * 1 + 4 * 2 + 5 * 3, 3 * -1 + 4 * 0 + 5 * 1]);
  assert.deepStrictEqual(Array.from((await M.matmulInt(ai, [2, 3], bi, [3, 2], 1, 0, { navigator: undefined })).y), Array.from(ri.y));
  assert.throws(() => M.plan([2, 3, 4], [3, 4, 5]), /批次廣播/);
  // 平鋪核心：16×16 個執行緒、共用記憶體 8 KiB（規格預設上限 16 KiB 以內）；正確性與速度要真 Chrome 驗證（scripts/eval/mm_tiled_check.html）
  assert.ok(/workgroup_size\(16, 16, 1\)/.test(M.WGSL_MM_F32_TILED) && /array<f32, 1024>/.test(M.WGSL_MM_F32_TILED));
  // G4 接線：變體選擇（規則）
  assert.strictEqual(M.pickMatmulKernel(64, 256, 256, {}).id, 'mm_vec4_f32');      // K、N 為 4 的倍數 → vec4
  assert.strictEqual(M.pickMatmulKernel(64, 10, 256, {}).id, 'mm_tiled_f32');      // K 不是 4 的倍數 → 平鋪
  assert.strictEqual(M.pickMatmulKernel(1, 256, 256, {}).id, 'mm_simple_f32');     // M 太小（解碼向量）→ 簡單版
  assert.strictEqual(M.pickMatmulKernel(64, 256, 256, { kernel: 'mm_tiled_f32' }).id, 'mm_tiled_f32');  // 強制指定
  assert.strictEqual(M.pickMatmulKernel(64, 10, 256, { kernel: 'mm_vec4_f32' }).id, 'mm_tiled_f32');   // 強制但不適用 → 退回規則
  assert.ok(/vec4/.test(M.WGSL_MM_F32_VEC4) && /array<vec4<f32>>/.test(M.WGSL_MM_F32_VEC4));
  // 已存的勝者（變體競賽結果）優先於規則；能力不符就忽略
  const KS = require('./kernel_select.js');
  M.setMatmulWinners([{ key: KS.cacheKey('unknown', 'matmul', { M: 64, K: 256, N: 256 }, null), value: { id: 'mm_tiled_f32', median: 1 } }]);
  const tuned = M.pickMatmulKernel(64, 256, 256, {});
  assert.strictEqual(tuned.id, 'mm_tiled_f32'); assert.strictEqual(tuned.source, 'tuned');
  M.setMatmulWinners([]);
  assert.strictEqual(M.pickMatmulKernel(64, 256, 256, {}).source, 'rule');
  // 沒有 GPU 時不競賽（不拿 CPU 時間當結果）
  const race = await M.raceMatmul(32, 16, 32, { navigator: undefined });
  assert.strictEqual(race.noGpu, true);
  // 記憶體退路的儲存：entries 能列出寫入的內容
  const VR = require('./variant_race.js');
  const st = VR.createStore({});
  await st.set('k1', { id: 'x' });
  assert.deepStrictEqual((await st.entries()).map((e) => e.key), ['k1']);
  console.log('mm_ops_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
