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
  // 啟動接線：載入勝者；簽名相同的命中、簽名不同的（舊）不命中且算成 stale；缺的形狀回報 missing（簽名變了才會缺）
  const fakeDev = { limits: { maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256 }, features: new Set() };
  const capsNow = KS.probeCaps(null, fakeDev);
  const curKey = KS.cacheKey('fake-adapter', 'matmul', { M: 64, K: 1024, N: 1024 }, capsNow);
  const oldKey = KS.cacheKey('fake-adapter', 'matmul', { M: 64, K: 1024, N: 1024 }, Object.assign({}, capsNow, { maxWorkgroupStorage: 32768 }));
  const st2 = VR.createStore({});
  await st2.set(curKey, { id: 'mm_tiled_f32', median: 2 });
  await st2.set(oldKey, { id: 'mm_vec4_f32', median: 1 });
  const info = await M.initMatmulTuning({ device: fakeDev, adapterDesc: 'fake-adapter', store: st2, shapes: [{ M: 64, K: 1024, N: 1024 }] });
  assert.strictEqual(info.tier, 'low'); assert.strictEqual(info.loaded, 2); assert.strictEqual(info.stale, 1); assert.deepStrictEqual(info.missing, []);
  assert.strictEqual(M.pickMatmulKernel(64, 1024, 1024, {}).id, 'mm_tiled_f32');  // 命中的勝者（不是舊簽名的 vec4）
  const info2 = await M.initMatmulTuning({ device: fakeDev, adapterDesc: 'other-adapter', store: st2, shapes: [{ M: 64, K: 1024, N: 1024 }] });
  assert.strictEqual(info2.missing.length, 1);  // 換了 adapter → 缺勝者 → 會背景重跑
  assert.ok(Array.isArray(M.AUTO_SHAPES) && M.AUTO_SHAPES.length === 1);
  // 逐形狀安全閘門（依這台機器的校正）：GT 720 實測 simple 2.06 GFLOP/s、tiled 約 2.42 倍
  const ids3 = ['mm_vec4_f32', 'mm_tiled_f32', 'mm_simple_f32'];
  const g720 = 2.06;
  let gg = M.gateCandidates({ M: 64, K: 1024, N: 1024 }, ids3, g720, M.SAFE_DISPATCH_MS);
  assert.deepStrictEqual(gg.run, ids3); assert.strictEqual(gg.skipped.length, 0);  // 64×1024×1024 全部照跑（與現行保護一致）
  gg = M.gateCandidates({ M: 512, K: 1024, N: 1024 }, ids3, g720, M.SAFE_DISPATCH_MS);
  assert.deepStrictEqual(gg.run, []); assert.strictEqual(gg.skipped.length, 3);  // 512×1024×1024 全部略過（tiled 約 215 ms）
  assert.ok(gg.skipped.every((s) => /預估逾時/.test(s.reason)));
  gg = M.gateCandidates({ M: 512, K: 1024, N: 3072 }, ids3, g720, M.SAFE_DISPATCH_MS);
  assert.deepStrictEqual(gg.run, []);
  gg = M.gateCandidates({ M: 512, K: 1024, N: 3072 }, ids3, 500, M.SAFE_DISPATCH_MS);  // 強機器：每個候選都在上限內
  assert.deepStrictEqual(gg.run, ids3); assert.strictEqual(gg.skipped.length, 0);
  // 有校正時 raceMatmul 對全部超過上限的形狀：不派發任何一次（沒有 GPU 也不會退 CPU 去跑）
  const allGated = await M.raceMatmul(512, 1024, 1024, { navigator: undefined, gSimple: g720, safeMs: M.SAFE_DISPATCH_MS });
  assert.strictEqual(allGated.winner, null); assert.strictEqual(allGated.noGpu, false); assert.strictEqual(allGated.gated.length, 3);
  assert.deepStrictEqual(Object.keys(allGated.timings), []);
  // GPU 失敗不能當成通過：沒有 GPU 的強機器校正下，候選全部退 CPU → 驗證丟錯（不得得到勝者）
  const cpuRace = await M.raceMatmul(32, 16, 32, { navigator: undefined, gSimple: 500 });
  assert.strictEqual(cpuRace.winner, null);
  assert.ok(cpuRace.bad.length > 0 && cpuRace.bad.every((b) => /GPU 派發失敗/.test(b.reason)), JSON.stringify(cpuRace.bad));
  // 校正：沒有 GPU 就回報 noGpu（不拿 CPU 時間當校正）
  const calNo = await M.calibrateSimple({ M: 32, K: 16, N: 32 }, { navigator: undefined });
  assert.strictEqual(calNo.noGpu, true);
  // 多形狀：逐一跑、進度 i／n、結果順序與輸入相同
  const shapesAll = [{ M: 64, K: 1024, N: 1024 }, { M: 512, K: 1024, N: 1024 }, { M: 512, K: 1024, N: 3072 }];
  const calibOk = async () => ({ noGpu: false, gSimple: g720, ms: 65 });
  const ran = []; const prog = [];
  const okRace = async (Mm, Kk, Nn) => { ran.push(Mm + 'x' + Kk + 'x' + Nn); return { winner: { id: 'mm_tiled_f32' }, bad: [], gated: [], key: 'k' }; };
  let outs = await M.startMatmulRace(shapesAll, { calibrate: calibOk, raceOne: okRace, onProgress: (p) => prog.push(p.i + '/' + p.n) });
  assert.deepStrictEqual(ran, ['64x1024x1024', '512x1024x1024', '512x1024x3072']);
  assert.deepStrictEqual(prog, ['1/3', '2/3', '3/3']);
  assert.strictEqual(outs.length, 3); assert.ok(outs.every((x) => x.winner && x.error === null));
  // 中間一個形狀丟例外：只記在它自己那筆，後面照跑
  ran.length = 0;
  const boomMid = async (Mm, Kk, Nn) => { ran.push(Mm); if (Mm === 512 && Nn === 1024) throw new Error('boom'); return { winner: { id: 'x' }, bad: [], gated: [] }; };
  outs = await M.startMatmulRace(shapesAll, { calibrate: calibOk, raceOne: boomMid });
  assert.deepStrictEqual(ran, [64, 512, 512]);
  assert.strictEqual(outs[1].error, 'boom'); assert.ok(outs[2].winner && outs[2].error === null);
  // 裝置遺失（丟例外）：標原因並停止，之後的形狀標未執行
  ran.length = 0;
  const lostThrow = async (Mm) => { ran.push(Mm); throw new Error('device lost: destroyed'); };
  outs = await M.startMatmulRace(shapesAll, { calibrate: calibOk, raceOne: lostThrow });
  assert.deepStrictEqual(ran, [64]); assert.ok(/未執行/.test(outs[1].error) && /未執行/.test(outs[2].error));
  // 裝置遺失（以 bad 的原因回報）：同樣停止
  ran.length = 0;
  const lostBad = async (Mm) => { ran.push(Mm); return { winner: null, bad: [{ id: 'mm_simple_f32', reason: '執行丟錯：GPU 派發失敗，退回 CPU：WGSL 執行失敗：device lost' }], gated: [] }; };
  outs = await M.startMatmulRace(shapesAll, { calibrate: calibOk, raceOne: lostBad });
  assert.deepStrictEqual(ran, [64]); assert.ok(/未執行/.test(outs[2].error));
  // 取消：第一個形狀後取消，後面不再跑
  ran.length = 0; let cancelled = false;
  outs = await M.startMatmulRace(shapesAll, { calibrate: calibOk, cancel: () => cancelled, raceOne: async (Mm) => { ran.push(Mm); cancelled = true; return { winner: null, bad: [], gated: [] }; } });
  assert.deepStrictEqual(ran, [64]); assert.strictEqual(outs[1].cancelled, true);
  // 校正發現沒有 GPU：每個形狀都標 noGpu，不呼叫競賽
  ran.length = 0;
  outs = await M.startMatmulRace(shapesAll, { calibrate: async () => ({ noGpu: true, reason: 'no adapter' }), raceOne: async (Mm) => { ran.push(Mm); return {}; } });
  assert.deepStrictEqual(ran, []); assert.ok(outs.every((x) => x.noGpu === true));
  // 競賽一定有共用儲存（表格讀的是同一個），沒有就建一個
  M.TUNE.store = null;
  await M.startMatmulRace([{ M: 64, K: 1024, N: 1024 }], { calibrate: calibOk, raceOne: async () => ({ winner: null, bad: [], gated: [] }) });
  assert.ok(M.TUNE.store && typeof M.TUNE.store.entries === 'function');
  console.log('mm_ops_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
