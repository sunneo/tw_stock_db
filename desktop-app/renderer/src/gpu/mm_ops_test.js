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
  // GPU 失敗不能當成通過：沒有 GPU 時不得得到勝者；現在在取得裝置時就回報 noGpu，候選一個都不跑（不再由 CPU 退路產生失敗列）
  const cpuRace = await M.raceMatmul(32, 16, 32, { navigator: undefined, gSimple: 500 });
  assert.strictEqual(cpuRace.winner, null); assert.strictEqual(cpuRace.noGpu, true);
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
  // 能力探測：UI 已設定的（adapter 來源）不被裝置探測蓋掉，競賽鍵與表格查詢才會一致
  const capsUi = Object.assign({}, KS.probeCaps(null, null), { maxWorkgroupStorage: 12345 });
  M.setMatmulCaps(capsUi, 'adapter-ui');
  await M.initMatmulTuning({ device: fakeDev, adapterDesc: 'device-side', store: st2, shapes: [] });
  assert.strictEqual(M.getMatmulCaps(), capsUi);
  // 競賽一定有共用儲存（表格讀的是同一個），沒有就建一個
  M.TUNE.store = null;
  await M.startMatmulRace([{ M: 64, K: 1024, N: 1024 }], { calibrate: calibOk, raceOne: async () => ({ winner: null, bad: [], gated: [] }) });
  assert.ok(M.TUNE.store && typeof M.TUNE.store.entries === 'function');
  // 矩陣乘轉置旗標（同一份平鋪核心）：沒有 GPU 時走參考，轉置儲存的輸入要與普通形式的結果一致
  {
    const Mm = 5, Kk = 7, Nn = 6;
    let q = 21; const rr = () => { q = (Math.imul(q, 1664525) + 1013904223) | 0; return (q >>> 0) / 4294967296 - 0.5; };
    const An = Float32Array.from({ length: Mm * Kk }, rr), Bn = Float32Array.from({ length: Kk * Nn }, rr);
    const As = new Float32Array(Mm * Kk), Bs = new Float32Array(Kk * Nn);
    for (let i = 0; i < Mm; i++) for (let k = 0; k < Kk; k++) As[k * Mm + i] = An[i * Kk + k];
    for (let k = 0; k < Kk; k++) for (let j = 0; j < Nn; j++) Bs[j * Kk + k] = Bn[k * Nn + j];
    const want = M.matmulRef(An, [Mm, Kk], Bn, [Kk, Nn]).y;
    const close = (got) => { for (let i = 0; i < want.length; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-5, 'i=' + i); };
    close((await M.matmul(As, [Mm, Kk], Bn, [Kk, Nn], { gpu: false, transA: true })).y);
    close((await M.matmul(An, [Mm, Kk], Bs, [Kk, Nn], { gpu: false, transB: true })).y);
    close((await M.matmul(As, [Mm, Kk], Bs, [Kk, Nn], { gpu: false, transA: true, transB: true })).y);
    // 轉置版只支援單一批次：批次 2 要明確拒絕（不得默默算錯）
    await assert.rejects(M.matmul(new Float32Array(2 * Mm * Kk), [2, Mm, Kk], Bs, [Kk, Nn], { gpu: false, transA: true }), /只支援單一批次/);
  }
  // 核心計時與屋頂（R0）：純函式（數字都選二進位可精確表示的值，避免浮點誤差）
  assert.strictEqual(M.pickBatch(0.5, 100), 64);                 // 很快的派發 → 批次上限 64
  assert.strictEqual(M.pickBatch(65, 100), 1);                   // 慢的派發不批次（至少 1 次）
  assert.strictEqual(M.pickBatch(10, 100), 10);
  assert.strictEqual(M.compileFromSamples(120, [60, 62, 61]), 59);   // 首次總時間 − 穩定中位數 61
  assert.strictEqual(M.compileFromSamples(50, [80, 90, 85]), 0);     // 不為負
  assert.strictEqual(M.compileFromSamples(50, []), null);            // 沒有樣本就不報
  assert.strictEqual(M.gflopsFrom(2e9, 1000), 2);                    // 2 GFLOP 花 1 s → 2 GFLOP/s
  assert.strictEqual(M.gflopsFrom(1e6, 0), null);
  // 迭代數：單次 ＝ a + b·iters，a=8、b=0.5 ms；目標 108 ms → (108−8)/0.5 = 200
  assert.strictEqual(M.pickRooflineIters(40, 64, 520, 1024, 108), 200);
  assert.strictEqual(M.pickRooflineIters(40, 64, 40, 1024, 40), 1024);  // 兩次時間一樣（斜率 0）→ 退回第二個迭代數
  assert.strictEqual(M.pickRooflineIters(40, 64, 520, 1024, 1), 64);  // 目標小於固定開銷 → 下限 64
  // 峰值：只認同一能力簽名的 ROOF 鍵，且 gflops 要 > 0
  const ents = [{ key: 'ROOF|devA|wg16384-inv256-f160-sg0', value: { gflops: 90.5, iters: 4096, batch: 8 } }, { key: 'devA|matmul|b|wg16384-inv256-f160-sg0', value: {} }];
  const pk = M.peakFromEntries(ents, 'wg16384-inv256-f160-sg0');
  assert.strictEqual(pk.gflops, 90.5); assert.strictEqual(pk.measured, true); assert.ok(/4096 次迭代、8 次一批/.test(pk.basis), pk.basis);
  assert.strictEqual(M.peakFromEntries(ents, 'other-sig'), null);
  assert.strictEqual(M.peakFromEntries([{ key: 'ROOF|devA|sig', value: { gflops: 0 } }], 'sig'), null);
  // 沒有 GPU：屋頂量不到，回傳原因（不拋例外、不影響競賽）；競賽不記編譯 ms
  const rr = await M.measureRoofline({ navigator: undefined });
  assert.strictEqual(rr.ok, false); assert.ok(typeof rr.reason === 'string' && rr.reason.length > 0, JSON.stringify(rr));
  const rc = await M.raceMatmul(64, 1024, 1024, { navigator: undefined });
  assert.strictEqual(rc.noGpu, true);
  // 屋頂安全校準（假裝置，不碰 GPU）：外推到約 30 ms、迭代數上限、不可信時中止且不再放大、總時間上限
  {
    const fake = (perIter, overhead, slowAbove) => {
      const calls = [], times = [];
      const dispatch = async (iters, n) => {
        calls.push({ iters: iters, n: n });
        let t = n * (overhead + perIter * iters);
        if (slowAbove && iters > slowAbove) t = 1e4;   // 模擬降頻：超過某個迭代數就變很慢
        times.push(t);
        return t;
      };
      return { dispatch: dispatch, calls: calls, times: times };
    };
    // 1) 外推：每次迭代 0.05 ms、固定開銷 0.5 ms → 單次約 30 ms 約 590 次迭代；所有派發都在 ROOF_ABORT_MS 以下
    let f = fake(0.05, 0.5);
    let r = await M.rooflineCalibrate({ dispatch: f.dispatch });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.iters >= 580 && r.iters <= 600, 'iters=' + r.iters);
    assert.ok(Math.abs(r.perDispatchMs - 30) < 1.5, 'per=' + r.perDispatchMs);
    assert.ok(Math.max(...f.times) <= M.ROOF_ABORT_MS, 'max=' + Math.max(...f.times));
    // 2) 上限：每次迭代極快 → 迭代數壓在 ROOF_MAX_ITERS，不會無限放大
    f = fake(0.00001, 0.5);
    r = await M.rooflineCalibrate({ dispatch: f.dispatch });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.iters, M.ROOF_MAX_ITERS);
    // 3) 校準階段就慢：每次迭代 10 ms → 32 次迭代的派發 320 ms > 150 → 中止；只派發了暖機與兩次校準（沒有放大）
    f = fake(10, 0.5);
    r = await M.rooflineCalibrate({ dispatch: f.dispatch });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.untrusted, true); assert.ok(/不可信/.test(r.reason), r.reason);
    assert.strictEqual(f.calls.length, 3, JSON.stringify(f.calls));
    // 4) 確認階段才慢（超過 300 次迭代就變 1e4 ms）：外推的那次派發超時 → 中止；中止後沒有更大的派發
    f = fake(0.05, 0.5, 300);
    r = await M.rooflineCalibrate({ dispatch: f.dispatch });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.untrusted, true); assert.ok(/外推的/.test(r.reason), r.reason);
    const last = f.calls[f.calls.length - 1];
    assert.ok(f.calls.every((c) => c.iters <= last.iters), JSON.stringify(f.calls));
    // 5) 總時間上限：每次派發假裝花 2 秒 → 採樣前就超過上限，回傳明確原因（不是不可信）
    let clock = 0;
    f = fake(0.05, 0.5);
    r = await M.rooflineCalibrate({ dispatch: async (iters, n) => { clock += 2000; return f.dispatch(iters, n); }, now: () => clock });
    assert.strictEqual(r.ok, false); assert.ok(/時間上限/.test(r.reason), r.reason);
  }
  // 提交拆分（估計超過上限就拆）：純函式
  assert.deepStrictEqual(M.splitRuns(10, 30, 100), [3, 3, 3, 1]);   // 每個提交估計 ≤ 100 ms
  assert.deepStrictEqual(M.splitRuns(5, 1, 100), [5]);             // 很快，不拆
  assert.deepStrictEqual(M.splitRuns(4, 200, 100), [1, 1, 1, 1]);   // 單次就超過上限：每次一個提交
  assert.deepStrictEqual(M.splitRuns(0, 5, 100), []);
  // 量測互斥鎖與競賽入口：背景競賽在有量測時跳過；前景競賽排隊等鎖
  {
    const NNm = require('./nn_ops.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fakeRaceOne = async () => ({ winner: null, timings: {}, bad: [], skipped: [], cancelled: false, key: 'k' });
    const fakeCal = async () => ({ noGpu: false, ms: 1, gSimple: 1000 });
    const hold = NNm.withMeasureLock(async () => { await sleep(40); });
    await sleep(5);
    const bgRes = await M.startMatmulRace([{ M: 4, K: 4, N: 4 }], { background: true, raceOne: fakeRaceOne, calibrate: fakeCal });
    assert.strictEqual(bgRes.skipped, true, JSON.stringify(bgRes));
    const t0 = Date.now();
    const fgRes = await M.startMatmulRace([{ M: 4, K: 4, N: 4 }], { raceOne: fakeRaceOne, calibrate: fakeCal });
    assert.ok(Array.isArray(fgRes) && fgRes.length === 1, JSON.stringify(fgRes));
    assert.ok(Date.now() - t0 >= 20, '前景競賽應該排在量測後面等待');
    await hold;
  }
  console.log('mm_ops_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
