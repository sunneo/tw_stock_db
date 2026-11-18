'use strict';
// 通用矩陣乘（ONNX MatMul／MatMulInteger），給 Demucs、YAMNet、SDXS、Kokoro 等圖逐節點對拍用。
//   matmulRef(a, aDims, b, bDims) → { y: Float32Array, dims }       （雙精度累加）
//   matmul(a, aDims, b, bDims, ops) → Promise<{ y, dims }>          （T1 WGSL → cpu-js；ops.lastInfo 回報層級）
//   matmulIntRef(a, aDims, b, bDims, azp, bzp) → { y: Int32Array, dims }   （精確整數）
//   matmulInt(...ops)                                                 （T1 WGSL i32 → cpu-js；結果必須與參考逐位相同）
// 批次維：a 的批次 = 前導維乘積；b 的批次必須是 1（共用，一般權重）或與 a 相同（注意力）。
const nn = require('./nn_ops.js');
const MM_TILE = require('./gpu_core.js');
const KS = require('./kernel_select.js');
// 子群組核心（mm_subgroup.js）：載入失敗（例如嵌入的模組載入器沒有這個檔）就不提供，規則表不會選到它
let SG = null;
try { SG = require('./mm_subgroup.js'); } catch (_) { SG = null; }
// split-K（mm_splitk.js，R3）：同樣是可選的載入；沒有就規則不會走到它（mm_ops 退回 simple）
let SK = null;
try { SK = require('./mm_splitk.js'); } catch (_) { SK = null; }
const MAX_BUF = 134217728;

// ---------- 變體選擇（G4 接線）：規則＋已存的競賽勝者（kernel_select.pickWithCache）----------
// WINNERS：key（KS.cacheKey）→ { id, median, timings }，由 variant_race 的勝者快取（kernel_select.createWinnerCache，localStorage）在啟動時整批載入（setMatmulWinners）。
// 同步查表：派發路徑是同步查表（啟動時已把快取載入記憶體）；載入前就是規則結果。
const WINNERS = new Map();
let CAPS = null;                 // KS.probeCaps 的結果（瀏覽器端啟動時設定；沒設就用保守預設）
let ADAPTER = 'unknown';         // adapter 描述＋驅動／瀏覽器版本（快取鍵的一部分）
function setMatmulCaps(caps, adapterDesc) { CAPS = caps || null; ADAPTER = adapterDesc || 'unknown'; }
function setMatmulWinners(entries) { WINNERS.clear(); (entries || []).forEach((e) => { if (e && e.key && e.value) WINNERS.set(e.key, e.value); }); }
const WINNER_STORE = { get: (key) => (WINNERS.has(key) ? WINNERS.get(key) : null) };
// pickMatmulKernel(M, K, N, o) → { id, source, reason }；o.kernel 強制指定（同 kernel_select 的 overrides）
function pickMatmulKernel(M, K, N, o) {
  const opts = o || {};
  const overrides = opts.kernel ? { matmul: opts.kernel } : (opts.overrides || null);
  return KS.pickWithCache('matmul', { M: M, K: K, N: N }, CAPS, overrides, WINNER_STORE, ADAPTER);
}

// 接到 runtime 矩陣乘（O14b）：只有真的有競賽勝者（pickWithCache 的 source 為 'tuned'）才回傳變體 id；否則 null，gpu_core 走規則預設。
function runtimeWinnerFor(M, K, N) {
  const r = KS.pickWithCache('matmul', { M: M, K: K, N: N }, CAPS, null, WINNER_STORE, ADAPTER);
  return r && r.source === 'tuned' ? r.id : null;
}
MM_TILE.setMatmulWinnerSource(runtimeWinnerFor);

function plan(aDims, bDims) {
  const ra = aDims.length, rb = bDims.length;
  if (ra < 2 || rb < 2) throw new Error('matmul：只支援 2 維以上');
  const M = aDims[ra - 2], K = aDims[ra - 1], N = bDims[rb - 1];
  if (bDims[rb - 2] !== K) throw new Error('matmul：K 不符');
  const lead = aDims.slice(0, ra - 2), bl = bDims.slice(0, rb - 2);
  const B = lead.reduce((p, v) => p * v, 1), Bb = bl.reduce((p, v) => p * v, 1);
  if (Bb !== 1 && Bb !== B) throw new Error('matmul：不支援的批次廣播');
  return { M, K, N, B, Bb, dims: lead.concat([M, N]) };
}
function matmulRef(a, aDims, b, bDims) {
  const { M, K, N, B, Bb, dims } = plan(aDims, bDims), y = new Float32Array(B * M * N);
  for (let n = 0; n < B; n++) { const ao = n * M * K, bo = (Bb === 1 ? 0 : n) * K * N;
    for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { let acc = 0; for (let k = 0; k < K; k++) acc += a[ao + i * K + k] * b[bo + k * N + j]; y[(n * M + i) * N + j] = acc; } }
  return { y, dims };
}
function matmulIntRef(a, aDims, b, bDims, azp, bzp) {
  const { M, K, N, B, Bb, dims } = plan(aDims, bDims), y = new Int32Array(B * M * N);
  for (let n = 0; n < B; n++) { const ao = n * M * K, bo = (Bb === 1 ? 0 : n) * K * N;
    for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { let acc = 0; for (let k = 0; k < K; k++) acc += (a[ao + i * K + k] - (azp || 0)) * (b[bo + k * N + j] - (bzp || 0)); y[(n * M + i) * N + j] = acc; } }
  return { y, dims };
}
const HEAD = (t) => `
struct P { B: u32, M: u32, K: u32, N: u32, Bb: u32, azp: i32, bzp: i32, p0: u32 }
@group(0) @binding(0) var<storage, read> a: array<${t}>;
@group(0) @binding(1) var<storage, read> b: array<${t}>;
@group(0) @binding(2) var<storage, read_write> y: array<${t}>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * 4194240u;
  if (idx >= p.B * p.M * p.N) { return; }
  let j = idx % p.N;
  let i = (idx / p.N) % p.M;
  let n = idx / (p.N * p.M);
  let ao = (n * p.M + i) * p.K;
  var bo = 0u;
  if (p.Bb != 1u) { bo = n * p.K * p.N; }
`;
const WGSL_MM_F32 = HEAD('f32') + `
  var acc: f32 = 0.0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) { acc = acc + a[ao + k] * b[bo + k * p.N + j]; }
  y[idx] = acc;
}`;
// 平鋪版（f32）：一個工作群組 16×16 個執行緒算 64×64 的輸出，每個執行緒在暫存器裡累加 4×4；A、B 各分 16 層一塊塊搬進共用記憶體再算。
// 原本的版本一個執行緒算一格、每格迴圈 K 次、每次都讀全域記憶體（沒有任何重用），在 14 W 的舊顯示卡上比 ORT 慢一個數量級。
// 共用記憶體 2×64×16×4 B = 8 KiB（規格預設上限 16 KiB 以內）。批次在 z 方向；邊界逐元素檢查，任意形狀都對。
// 平鋪版改用共用的核心（renderer/src/gpu/mm_tile.js，與 gpu_core.js 的 WGSL.matmul 同一份；轉置旗標在 p0，這裡不用）。
const WGSL_MM_F32_TILED = MM_TILE.mmTileWgsl({ marker: 'matmul_tiled', dtype: 'f32' });
// vec4 版：同一幾何、同一組綁定（位元組相同），只讀取改成 vec4；呼叫端要保證 K%4==0、N%4==0（KS 的 applies）。
const WGSL_MM_F32_VEC4 = MM_TILE.mmTileWgslVec4({ marker: 'matmul_vec4_mm' });
const WGSL_MM_I32 = HEAD('i32') + `
  var acc: i32 = 0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) { acc = acc + (a[ao + k] - p.azp) * (b[bo + k * p.N + j] - p.bzp); }
  y[idx] = acc;
}`;

async function run(kind, a, aDims, b, bDims, azp, bzp, ops) {
  const o = ops || {}, pl = plan(aDims, bDims), total = pl.B * pl.M * pl.N, isInt = kind === 'int';
  // 轉置旗標（transA：a 以 K×M 儲存；transB：b 以 N×K 儲存）：送進同一份平鋪核心的 p0；只支援單一批次
  const fl = isInt ? 0 : MM_TILE.mmTileFlags(o);
  if (fl && pl.B !== 1) throw new Error('mm_ops：轉置版目前只支援單一批次（收到 B=' + pl.B + '）');
  const ref = () => (isInt ? matmulIntRef(a, aDims, b, bDims, azp, bzp) : (fl ? { y: MM_TILE.matmulTRef(a, b, pl.M, pl.K, pl.N, fl) } : matmulRef(a, aDims, b, bDims))).y;
  if (o.gpu === false) return { y: ref(), dims: pl.dims };
  // 純 CPU 池（沒有 WebGPU、裝置遺失、GPU 各層都失敗時的退路）：f32、單一批次、不轉置 A 才走 cpu_share.runCpuOnly；
  // 其餘（整數、轉置 A、多批次）與無法取得池時，仍用同步的參考實作。cores=0（預設）時 runCpuOnly 在主執行緒算，結果相同。
  const cpuPoolRef = async () => {
    if (isInt || o.transA || pl.B !== 1 || !CPU_SHARE) return ref();
    const sh = CPU_SHARE.getShared();
    const af = a instanceof Float32Array ? a : Float32Array.from(a), bf = b instanceof Float32Array ? b : Float32Array.from(b);
    const rr = await sh.runCpuOnly(af, bf, pl.M, pl.K, pl.N, { transB: !!o.transB, bKey: o.cacheB ? b : null });
    return rr.y;
  };
  // 轉置時只有平鋪版讀 p0（簡單版與 vec4 版不讀），所以強制用平鋪版
  // 轉置版（訓練）：M=1、K≥1024、單一批次時改走 split-K（支援 transA／transB 旗標；同機 intel xe-lpg 快 22–60%），其餘仍用平鋪
  const flSplitK = !!fl && !!SK && pl.B === 1 && pl.M === 1 && pl.K >= 1024 && !isInt;
  const kernelId = isInt ? 'mm_simple_f32' : (fl ? (flSplitK ? 'mm_splitk_f32' : 'mm_tiled_f32') : pickMatmulKernel(pl.M, pl.K, pl.N, o).id);
  const r = await nn.tryLayers(isInt ? 'matmulInt' : 'matmul', { navigator: o.navigator }, async (dev) => {
    // 啟動接線：第一次拿到 GPU 裝置時，背景載入勝者；缺勝者的形狀再背景競賽（本次派發仍用規則，下次才換）
    if (!TUNE.started) {
      TUNE.started = true;
      initMatmulTuning({ device: dev, shapes: AUTO_SHAPES }).then((info) => {
        if (info.missing.length && o.navigator) startMatmulRace(info.missing, { navigator: o.navigator, budgetMs: 2000, background: true }).catch(() => {});
      }).catch(() => {});
    }
    for (const n of [total, a.length, b.length]) if (n * 4 > MAX_BUF) throw new Error('張量 ' + n + ' 個元素超過單一儲存緩衝區上限（128 MB），退 CPU');
    const u = new Int32Array([pl.B, pl.M, pl.K, pl.N, pl.Bb, azp || 0, bzp || 0, fl]);
    // 已經是對的型別就不再複製一份（大矩陣的複製本身就是可觀的時間）；o.cacheB：B 是常駐權重時，同一個陣列物件只上傳一次
    const mk = (src) => (isInt ? (src instanceof Int32Array ? src : Int32Array.from(src)) : (src instanceof Float32Array ? src : Float32Array.from(src)));
    // 變體：f32 才有平鋪／vec4 可選（kernel_select 的 applies 會排除太窄的形狀）；整數與太窄的維持簡單版
    // 子群組版（mm_subgroup.js）：只在單一批次、不轉置、有載入模組時用；否則退回簡單版
    const kid0 = isInt ? 'mm_simple_f32' : kernelId;
    const sub = kid0 === 'mm_subgroup_f32' && !!SG && pl.B === 1 && !fl;
    // split-K（R3）：單一批次、不轉置、有載入模組、形狀在規則的適用範圍內；兩段核心（部分和＋歸約）在同一個批次、一次 submit 送出
    const sk = kid0 === 'mm_splitk_f32' && !!SK && pl.B === 1 && !isInt && (fl ? pl.M === 1 : SK.splitkApplies(pl.M, pl.K, pl.N));
    const kid = sk ? 'mm_splitk_f32' : (sub ? 'mm_subgroup_f32' : ((kid0 === 'mm_subgroup_f32' || kid0 === 'mm_splitk_f32') ? 'mm_simple_f32' : kid0));
    const tiled = kid !== 'mm_simple_f32' && kid !== 'mm_subgroup_f32' && kid !== 'mm_splitk_f32';
    o.lastKernel = kid;
    if (sk) {
      const S = SK.pickSplits(pl.K);
      const bt = nn.createBatch(dev);
      const hA = bt.upload(mk(a)), hB = bt.upload(mk(b));
      const hP = bt.alloc(S * pl.M * pl.N), hY = bt.alloc(pl.M * pl.N);
      const uni = new Uint32Array([pl.M, pl.K, pl.N, S, fl, 0, 0, 0]);
      bt.dispatchRaw(SK.WGSL_SPLITK_PARTIAL, [hA.buf, hB.buf, hP.buf], uni, SK.dispatchPartial(pl.M, pl.N, S));
      bt.dispatchRaw(SK.WGSL_SPLITK_REDUCE, [hP.buf, hY.buf], uni, SK.dispatchReduce(pl.M, pl.N));
      const got = await bt.read([[hY, pl.M * pl.N]]);
      return got[0];
    }
    const code = isInt ? WGSL_MM_I32 : (sub ? SG.WGSL_MM_SUBGROUP : (kid === 'mm_vec4_f32' ? WGSL_MM_F32_VEC4 : (tiled ? WGSL_MM_F32_TILED : WGSL_MM_F32)));
    const groups = sub ? SG.dispatchFor(pl.M, pl.N, 4096) : (tiled ? [Math.ceil(pl.N / 64), Math.ceil(pl.M / 64), pl.B] : Math.ceil(total / 64));
    const outs = await nn.runWgsl(dev, code,
      [{ data: mk(a) }, { data: mk(b), cache: !!o.cacheB }, { data: isInt ? new Int32Array(total) : new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), groups);
    return outs[0];
  }, null, cpuPoolRef);
  o.lastInfo = r.info;
  return { y: r.result, dims: pl.dims };
}
// 異質運算（plus）：CPU 核心數為 0（預設）時 CPU_SHARE.run 立刻回 shared:false，完全走原本的 GPU 路徑，行為與沒有這段時相同。
// 只在單一批次、不轉置 A、f32、Float32Array 輸入時分工；任何一邊出錯也退回原路徑（整個運算重算一次，結果仍正確）。
let CPU_SHARE = null;
try { CPU_SHARE = require('./cpu_share.js'); } catch (_) { CPU_SHARE = null; }
// 整個運算卸載給 CPU（小形狀）：卸載交界點來自 Profile 的實測（faProfilePlan 的 crossoverFlops，存在 localStorage fa_gpu_profile）。
// 沒有實測值（null）就不卸載，維持原本的 GPU 路徑；不寫死任何門檻。
let OFFLOAD = null;
try { OFFLOAD = require('./cpu_gemm_offload.js'); } catch (_) { OFFLOAD = null; }
let OFFLOAD_CROSSOVER = undefined;   // undefined＝還沒讀；null＝沒有實測；數字＝實測交界點（flops）
function setOffloadCrossover(v) { OFFLOAD_CROSSOVER = (v === null || v === undefined || !Number.isFinite(Number(v))) ? (v === Infinity ? Infinity : null) : Number(v); }
function crossoverNow() {
  if (OFFLOAD_CROSSOVER !== undefined) return OFFLOAD_CROSSOVER;
  try {
    if (typeof localStorage !== 'undefined') {
      const rec = JSON.parse(localStorage.getItem('fa_gpu_profile') || 'null');
      const x = rec && rec.crossoverFlops;
      OFFLOAD_CROSSOVER = rec && rec.crossoverAllCpu ? Infinity : (x === null || x === undefined ? null : Number(x));
      return OFFLOAD_CROSSOVER;
    }
  } catch (_) { /* 讀不到就當沒有實測 */ }
  OFFLOAD_CROSSOVER = null;
  return null;
}
const matmul = async (a, aD, b, bD, ops) => {
  const o = ops || {};
  if (OFFLOAD && CPU_SHARE && o.gpu !== false && !o.transA && a instanceof Float32Array && b instanceof Float32Array) {
    const p0 = plan(aD, bD);
    if (p0.B === 1 && p0.Bb === 1) {
      const dec = OFFLOAD.offloadDecision({ m: p0.M, k: p0.K, n: p0.N, gpuReady: true, crossoverFlops: crossoverNow() });
      if (dec.route === 'cpu') {
        const rr = await CPU_SHARE.getShared().runCpuOnly(a, b, p0.M, p0.K, p0.N, { transB: !!o.transB, bKey: o.cacheB ? b : null });
        o.lastInfo = { layer: 'cpu-simd', reason: dec.reason, share: rr.info };
        o.lastKernel = 'offload-cpu';
        return { y: rr.y, dims: p0.dims };
      }
    }
  }
  const sh = CPU_SHARE && !o._noShare && o.gpu !== false && !o.transA ? CPU_SHARE.getShared() : null;
  if (sh && sh.cores() > 0 && a instanceof Float32Array && b instanceof Float32Array) {
    const pl = plan(aD, bD);
    if (pl.B === 1 && pl.Bb === 1) {
      let gpuInfo = null;
      const r = await sh.run(async (aRows, mG) => {
        const io = Object.assign({}, o, { _noShare: true });
        const g = await run('f32', aRows, [mG, pl.K], b, bD, 0, 0, io);
        gpuInfo = io.lastInfo; return g.y;
      }, a, b, pl.M, pl.K, pl.N, { transB: !!o.transB, bKey: o.cacheB ? b : null, cpuSegment: o.cpuSegment });
      if (r.shared) { o.lastInfo = { layer: ((gpuInfo && gpuInfo.layer) || 'T1') + '+cpu', reason: null, share: r.info }; o.lastKernel = 'hetero'; return { y: r.y, dims: pl.dims }; }
    }
  }
  return run('f32', a, aD, b, bD, 0, 0, ops);
};
const matmulInt = (a, aD, b, bD, azp, bzp, ops) => run('int', a, aD, b, bD, azp, bzp, ops);

// ---------- 競賽（G4）：對一個形狀，所有適用的 f32 變體先驗證（對 CPU 參考）再計時 ----------
// opts：{ navigator, store（variant_race.createStore，勝者寫入）, budgetMs, runs, K, cancel, now }
// 沒有真 GPU（退 cpu-js）就不競賽、回傳 { noGpu: true }，免得拿 CPU 的時間當結果。
// 計時包含上傳與回讀（與派發路徑的實際成本一致），同一組輸入、先暖機一次。
// 單次派發超過這個預估時間（毫秒）的候選，在該形狀不參賽。這台 GT 720 的數字：64×1024×1024 的 simple 約 65 ms（會跑），
// 512×1024×1024 的 tiled 約 215 ms（不跑，維持現行保護）。更強的機器算出來的時間短，會跑全部形狀。
const SAFE_DISPATCH_MS = 150;
// 相對 simple 的速度（本機實測：tiled 4.99 ÷ simple 2.06 GFLOP/s ≈ 2.42）；沒量過的候選一律當 1（最保守）。
const REL_SPEED = { mm_simple_f32: 1, mm_tiled_f32: 2.42 };
const flopsOf = (sh) => 2 * sh.M * sh.K * sh.N;
// GFLOP/s = flops ÷ (ms × 1e6)；所以 ms = flops ÷ (GFLOP/s × 1e6)
function estimateMs(sh, id, gSimple) { return flopsOf(sh) / (gSimple * (REL_SPEED[id] || 1) * 1e6); }
// 逐候選判斷：預估單次派發超過 safeMs 的不參賽。回傳 { run: [id], skipped: [{ id, estMs, reason }] }
function gateCandidates(sh, ids, gSimple, safeMs) {
  const run = [], skipped = [];
  for (const id of ids) {
    const est = estimateMs(sh, id, gSimple);
    if (est > safeMs) skipped.push({ id: id, estMs: est, reason: '略過：預估逾時（約 ' + Math.round(est) + ' ms，上限 ' + safeMs + ' ms）' });
    else run.push(id);
  }
  return { run: run, skipped: skipped };
}
// 單次派發的 GPU 失敗：run() 會退回 CPU（layer cpu-js）。競賽要把它當失敗，不能拿 CPU 的結果當成該變體通過。
function dispatchOk(info) {
  if (/cpu-js/.test((info || {}).layer || '')) throw new Error('GPU 派發失敗，退回 CPU：' + String((info || {}).reason || '原因不明').slice(0, 200));
}
function isLostText(t) { return /lost|遺失/i.test(String(t || '')); }

// ---------- 核心時間、編譯時間、屋頂（R0）：不含上傳與回讀；一次提交多次派發，等 GPU 完成才停表 ----------
const BUF = { STORAGE: 0x80, UNIFORM: 0x40, COPY_DST: 0x8, COPY_SRC: 0x4 };
const CORE_SAMPLE_MS = 100;      // 每個樣本的目標時間：夠多次派發，讓提交延遲不主導計時
const CORE_MAX_BATCH = 64;
function nowMsCore() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
// 一個樣本要派發幾次：單次約 estMs，一批目標 budgetMs；至少 1、至多 CORE_MAX_BATCH
// 把 n 次派發拆成多個提交：每個提交依校準時間估的總時間不超過 limitMs（估計超過就拆）。回傳每個提交的派發數。
const CORE_SPLIT_MS = 100, ROOF_SPLIT_MS = 100;
function splitRuns(n, estMs, limitMs) {
  const per = Math.max(estMs, 1e-6), cap = Math.max(1, Math.floor(limitMs / per));
  const out = []; let left = Math.max(0, Math.floor(n));
  while (left > 0) { const c = Math.min(cap, left); out.push(c); left -= c; }
  return out;
}
function pickBatch(estMs, budgetMs) { return Math.max(1, Math.min(CORE_MAX_BATCH, Math.floor(budgetMs / Math.max(estMs, 0.01)))); }
// 編譯時間 ＝ 第一次（含編譯與第一次派發）的總時間 － 穩定時間的中位數；不小於 0；沒有樣本就 null
function compileFromSamples(firstTotalMs, samples) {
  const xs = (samples || []).filter((x) => isFinite(x) && x >= 0).slice().sort((p, q) => p - q);
  if (!xs.length || !isFinite(firstTotalMs)) return null;
  return Math.max(0, Math.round((firstTotalMs - xs[xs.length >> 1]) * 100) / 100);
}
// 用兩個迭代數的單次時間線性估出固定開銷 a 與每次迭代 b，再挑單次派發約 targetMs 的迭代數（限 64 ～ 65536）
function pickRooflineIters(t1, iters1, t2, iters2, targetMs) {
  const b = (t2 - t1) / (iters2 - iters1);
  if (!(b > 0)) return Math.max(64, Math.min(1 << 16, iters2));
  const a = t1 - b * iters1;
  return Math.max(64, Math.min(1 << 16, Math.floor((targetMs - a) / b)));
}
// GFLOP/s ＝ flops ÷ (ms × 1e6)
function gflopsFrom(flops, ms) { return ms > 0 ? flops / (ms * 1e6) : null; }
// 峰值：從快取找這張卡（同 adapter、同能力簽名）的實測屋頂；沒有就 null，呼叫端改用內建表或顯示原因
function peakFromEntries(entries, sig, adapterDesc) {
  const hit = (entries || []).find((e) => { const p = String(e.key).split('|'); return p[0] === 'ROOF' && p[2] === sig && (!adapterDesc || p[1] === adapterDesc) && e.value && e.value.gflops > 0; });
  return hit ? { gflops: hit.value.gflops, basis: '本機實測（純 FMA 核心，' + hit.value.iters + ' 次迭代、' + hit.value.batch + ' 次一批）', measured: true } : null;
}
function gpuBuf(dev, src, bytes) {
  const b = dev.createBuffer({ size: Math.max(4, bytes), usage: BUF.STORAGE | BUF.COPY_DST | BUF.COPY_SRC });
  if (src) dev.queue.writeBuffer(b, 0, src);
  return b;
}
// 核心工作：編譯（含第一次派發）只做一次；reps(n) 把 n 次派發塞進同一次提交，等 GPU 完成才返回
async function coreJob(dev, code, bufs, uniform, groups) {
  const t0 = nowMsCore();
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: code }), entryPoint: 'main' } });
  const ub = dev.createBuffer({ size: 32, usage: BUF.UNIFORM | BUF.COPY_DST });
  dev.queue.writeBuffer(ub, 0, uniform);
  const ents = bufs.map((b, i) => ({ binding: i, resource: { buffer: b } }));
  ents.push({ binding: bufs.length, resource: { buffer: ub } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: ents });
  const reps = async (n) => {
    const enc = dev.createCommandEncoder();
    for (let r = 0; r < n; r++) { const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(groups[0], groups[1] || 1, groups[2] || 1); pass.end(); }
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
  };
  await reps(1);
  return { reps: reps, compileTotal: nowMsCore() - t0, destroy: () => ub.destroy() };
}
// 屋頂（R0）用的純 FMA 核心：每執行緒 4 條獨立的 fma 依賴鏈，迭代數由 P.x 決定
const ROOF_WGSL = `
@group(0) @binding(0) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(1) var<uniform> P: vec4<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // 16 條獨立的依賴鏈（4 個 vec4）：單條鏈受延遲限制，鏈不夠多時量到的不是峰值
  let s: f32 = f32(gid.x & 1023u) * 0.000001 + 0.5;
  var x0: vec4<f32> = vec4<f32>(s, s + 0.25, s + 0.125, s + 0.0625);
  var x1: vec4<f32> = x0 + vec4<f32>(0.03125);
  var x2: vec4<f32> = x0 + vec4<f32>(0.015625);
  var x3: vec4<f32> = x0 + vec4<f32>(0.0078125);
  let m: vec4<f32> = vec4<f32>(0.9999);
  let c: vec4<f32> = vec4<f32>(0.0001);
  for (var i: u32 = 0u; i < P.x; i = i + 1u) {
    x0 = fma(x0, m, c); x1 = fma(x1, m, c); x2 = fma(x2, m, c); x3 = fma(x3, m, c);
  }
  let t: vec4<f32> = x0 + x1 + x2 + x3;
  if (t.x + t.y + t.z + t.w == -1.0) { OUT[gid.x] = t.x; }
}`;
// 屋頂（R0）：安全校準（管理者指示，2026-11-18）。大迭代數的量測已移除（第二次實測單次 786 ms，會逼近 GPU 逾時）。
// 流程：1) 暖機（編譯）；2) 兩個極小派發（8、32 次迭代）計時，線性外推出「單次約 ROOF_TARGET_MS」的迭代數，硬上限 ROOF_MAX_ITERS；
// 3) 用外推的迭代數派發一次確認；4) 每次提交的總時間約 ROOF_TARGET_MS，取 ROOF_SAMPLES 個樣本的中位數。
// 任何一次派發或提交超過 ROOF_ABORT_MS 就中止，標「屋頂量測不可信」，之後不再派發更大的（絕不放大重試）。整體也有時間上限。
// rooflineCalibrate 是純函式：派發由呼叫端注入（真裝置或測試用的假裝置），所以外推、上限、中止都能用 node 測。
const ROOF_TARGET_MS = 30, ROOF_ABORT_MS = 150, ROOF_MAX_ITERS = 4096, ROOF_MAX_TOTAL_MS = 1500, ROOF_SAMPLES = 3;
const ROOF_CAL_LO = 8, ROOF_CAL_HI = 32;
// dispatch(iters, n)：提交 n 次派發（每次 iters 次迭代），回傳這次提交的耗時（毫秒，Promise）。now()：取時間（測試可注入）。
async function rooflineCalibrate(opts) {
  const dispatch = opts.dispatch, now = opts.now || nowMsCore;
  const VR = require('./variant_race.js');
  const t0 = now();
  const untrusted = (why) => ({ ok: false, untrusted: true, reason: '屋頂量測不可信：' + why + '（已中止，不再放大迭代數）' });
  await dispatch(ROOF_CAL_LO, 1);                           // 暖機（編譯），不計時
  const tA = await dispatch(ROOF_CAL_LO, 1);
  if (!(tA <= ROOF_ABORT_MS)) return untrusted('極小派發 ' + tA + ' ms');
  const tB = await dispatch(ROOF_CAL_HI, 1);
  if (!(tB <= ROOF_ABORT_MS)) return untrusted('32 次迭代的派發 ' + tB + ' ms');
  const b = Math.max((tB - tA) / (ROOF_CAL_HI - ROOF_CAL_LO), 1e-6);   // 每次迭代的時間
  const a = Math.max(tA - ROOF_CAL_LO * b, 0);                         // 固定開銷
  const iters = Math.max(1, Math.min(ROOF_MAX_ITERS, Math.floor((ROOF_TARGET_MS - a) / b)));
  const predicted = a + b * iters;
  const tS = await dispatch(iters, 1);                                 // 確認：外推的迭代數只派發一次
  if (!(tS <= ROOF_ABORT_MS)) return untrusted('外推的 ' + iters + ' 次迭代派發 ' + tS + ' ms，預估 ' + predicted.toFixed(1) + ' ms');
  const single = Math.max(tS, 0.01);
  const batch = Math.max(1, Math.min(64, Math.floor(ROOF_TARGET_MS / single)));
  const per = [];
  const chunks = splitRuns(batch, single, ROOF_SPLIT_MS);   // 估計總時間 >100 ms 就拆成多個提交（每個提交都檢查中止條件）
  for (let s = 0; s < ROOF_SAMPLES; s++) {
    if (now() - t0 > ROOF_MAX_TOTAL_MS) break;
    let tot = 0;
    for (const c of chunks) {
      const tt = await dispatch(iters, c);
      if (!(tt <= ROOF_ABORT_MS)) return untrusted('一次提交 ' + c + ' 次派發共 ' + tt + ' ms');
      tot += tt;
    }
    per.push(tot / batch);
  }
  if (!per.length) return { ok: false, reason: '時間上限內沒有完成任何樣本' };
  return { ok: true, iters: iters, batch: batch, perDispatchMs: VR.medianOf(per), predicted: predicted, samples: per.length, totalMs: now() - t0 };
}
// 真裝置版：只包一層（建 pipeline 與 buffer，派發時計時並等 GPU 完成）。結果存進同一份快取，鍵為 ROOF|adapter|能力簽名。量不到回傳原因（不影響競賽）。
// 對外入口：要拿 GPU 量測互斥鎖（前景排隊）。競賽內部呼叫時傳 locked:true，避免同一把鎖重入造成死結。
function measureRoofline(o) {
  const opts = o || {};
  if (opts.locked) return measureRooflineInner(opts);
  return nn.withMeasureLock(() => measureRooflineInner(opts));
}
async function measureRooflineInner(o) {
  const opts = o || {};
  const VR = require('./variant_race.js');
  const gd = await nn.getDevice(opts.navigator);
  if (!gd.dev) return { ok: false, reason: '沒有 WebGPU（' + (gd.reason || '原因不明') + '）' };
  const dev = gd.dev;
  let lost = null; try { dev.lost.then((i) => { lost = (i && i.message) || 'lost'; }); } catch (_) { /* 監聽失敗不影響量測 */ }
  const caps = CAPS || KS.probeCaps(null, dev);
  const sig = require('./profile_priors.js').capSig(caps), adapter = opts.adapterDesc || ADAPTER;
  const threads = 256 * 256, flopsPerIter = threads * 16 * 2;   // 每次迭代每執行緒 16 個 fma（每個 2 flop）
  const out = gpuBuf(dev, null, threads * 4);
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: ROOF_WGSL }), entryPoint: 'main' } });
  const ub = dev.createBuffer({ size: 16, usage: BUF.UNIFORM | BUF.COPY_DST });
  const finish = (r) => { try { out.destroy(); ub.destroy(); } catch (_) { /* */ } return r; };
  const dispatch = async (iters, n) => {
    if (lost) throw new Error('裝置遺失：' + lost);
    dev.queue.writeBuffer(ub, 0, new Uint32Array([iters, 0, 0, 0]));
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }, { binding: 1, resource: { buffer: ub } }] });
    const enc = dev.createCommandEncoder();
    for (let r = 0; r < n; r++) { const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(256); pass.end(); }
    const t = nowMsCore();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    return nowMsCore() - t;
  };
  try {
    const cal = await rooflineCalibrate({ dispatch: dispatch, now: nowMsCore });
    if (lost) return finish({ ok: false, reason: '裝置遺失：' + lost });
    if (!cal.ok) return finish(cal);
    const gflops = gflopsFrom(flopsPerIter * cal.iters, cal.perDispatchMs);
    const value = { gflops: Math.round(gflops * 100) / 100, iters: cal.iters, batch: cal.batch, perDispatchMs: Math.round(cal.perDispatchMs * 1000) / 1000, adapter: adapter, sig: sig, at: Date.now() };
    const store = opts.store || TUNE.store || (TUNE.store = VR.createStore({}));
    try { await store.set('ROOF|' + adapter + '|' + sig, value); } catch (_) { /* 退記憶體 */ }
    return finish({ ok: true, gflops: value.gflops, value: value, totalMs: Math.round(cal.totalMs) });
  } catch (e) {
    return finish({ ok: false, reason: '量測失敗：' + String((e && e.message) || e).slice(0, 160) });
  }
}
// 校正：在最小的形狀上量一次 mm_simple_f32（先暖機＝編譯，再計時），得到這台機器的實測 GFLOP/s。
async function calibrateSimple(sh, o) {
  const opts = o || {};
  const clock = () => (typeof performance !== 'undefined' ? performance : Date).now();
  const M = sh.M, K = sh.K, N = sh.N;
  let s = 11; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  const a = Float32Array.from({ length: M * K }, rnd), b = Float32Array.from({ length: K * N }, rnd);
  const warm = { navigator: opts.navigator, kernel: 'mm_simple_f32' };
  await matmul(a, [M, K], b, [K, N], warm);
  if (/cpu-js/.test((warm.lastInfo || {}).layer || '')) return { noGpu: true, reason: (warm.lastInfo || {}).reason || '' };
  // 計時 3 次取中位數（單次量測會受首次提交等雜訊影響，偏慢或偏快都不可靠）
  const xs = [];
  for (let i = 0; i < 3; i++) {
    const t = { navigator: opts.navigator, kernel: 'mm_simple_f32' };
    const t0 = clock();
    await matmul(a, [M, K], b, [K, N], t);
    dispatchOk(t.lastInfo);
    xs.push(Math.max(clock() - t0, 0.01));
  }
  xs.sort((p, q) => p - q);
  const ms = xs[1];
  return { noGpu: false, ms: ms, gSimple: flopsOf(sh) / (ms * 1e6) };
}

async function raceMatmul(M, K, N, opts) {
  const VR = require('./variant_race.js');
  const o = opts || {};
  const sh = { M: M, K: K, N: N };
  const key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
  const clock = () => (typeof performance !== 'undefined' ? performance : Date).now();
  let s = 7; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  let ids = KS.VARIANTS.matmul.filter((v) => !v.applies || v.applies(sh)).map((v) => v.id);
  let gated = [];
  if (o.gSimple) {
    // 有校正：逐候選依預估時間判斷；全部超過上限就一次都不派發
    const g = gateCandidates(sh, ids, o.gSimple, o.safeMs || SAFE_DISPATCH_MS);
    ids = g.run; gated = g.skipped;
    if (!ids.length) return { noGpu: false, winner: null, timings: {}, bad: [], skipped: [], cancelled: false, gated: gated, key: key };
  } else {
    // 沒有校正：暖機兼偵測，退 cpu-js 就不競賽
    const wa = Float32Array.from({ length: M * K }, rnd), wb = Float32Array.from({ length: K * N }, rnd);
    const warm = { navigator: o.navigator, kernel: 'mm_simple_f32' };
    await matmul(wa, [M, K], wb, [K, N], warm);
    if (/cpu-js/.test((warm.lastInfo || {}).layer || '')) return { noGpu: true, winner: null, timings: {}, bad: [], skipped: [], cancelled: false, gated: [], key: key };
  }
  // 只有真的要跑的形狀才產生輸入與 CPU 參考（參考在主執行緒算，大形狀會卡住頁面，所以被略過的形狀不做）
  const a = Float32Array.from({ length: M * K }, rnd), b = Float32Array.from({ length: K * N }, rnd);
  const ref = matmulRef(a, [M, K], b, [K, N]).y;
  let scale = 0; for (let i = 0; i < ref.length; i++) scale = Math.max(scale, Math.abs(ref[i]));
  // 計時改成「核心時間」：不含上傳與回讀。每個候選各編譯一次管線（編譯 ms 另記）；
  // 一批派發放進同一次提交，等 GPU 完成才停表，除以批次數。驗證仍走完整路徑（對 CPU 參考）。
  const gd = await nn.getDevice(o.navigator);
  const dev = gd && gd.dev;
  if (!dev) return { noGpu: true, winner: null, timings: {}, bad: [], skipped: [], cancelled: false, gated: gated, key: key, reason: (gd && gd.reason) || '' };
  const bufA = gpuBuf(dev, a, M * K * 4), bufB = gpuBuf(dev, b, K * N * 4), bufY = gpuBuf(dev, null, M * N * 4);
  const uni = new Int32Array([1, M, K, N, 1, 0, 0, 0]);   // 與 run() 的 u 相同欄位：B, M, K, N, Bb, azp, bzp, fl
  const jobs = {};
  const jobFor = async (id) => {
    if (!jobs[id]) {
      const simple = id === 'mm_simple_f32';
      const code = id === 'mm_vec4_f32' ? WGSL_MM_F32_VEC4 : (simple ? WGSL_MM_F32 : WGSL_MM_F32_TILED);
      const groups = simple ? [Math.ceil(M * N / 64), 1, 1] : [Math.ceil(N / 64), Math.ceil(M / 64), 1];
      const job = await coreJob(dev, code, [bufA, bufB, bufY], uni, groups);
      job.samples = [];
      jobs[id] = job;
    }
    return jobs[id];
  };
  const cands = ids.map((id) => ({
    id: id,
    verify: async () => {
      const ops = Object.assign({}, o, { kernel: id });
      const r = await matmul(a, [M, K], b, [K, N], ops);
      dispatchOk(ops.lastInfo);
      let d = 0; for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(r.y[i] - ref[i]));
      return d / Math.max(scale, 1e-30);
    },
    run: async () => {
      const job = await jobFor(id);
      if (!job.est) { const t = clock(); await job.reps(1); job.est = Math.max(clock() - t, 0.01); }
      const n = pickBatch(job.est, CORE_SAMPLE_MS);
      let tot = 0;
      for (const c of splitRuns(n, job.est, CORE_SPLIT_MS)) { const t = clock(); await job.reps(c); tot += clock() - t; }   // 估計超過 100 ms 就拆成多個提交
      const per = tot / n;
      job.samples.push(per);
      return per;
    },
  }));
  let res;
  try {
    res = await VR.race(cands, { tol: 1e-5, budgetMs: o.budgetMs || VR.DEFAULT_BUDGET_MS, runs: o.runs || 3, K: o.K || 3, cancel: o.cancel, now: o.now || (() => clock()) });
  } finally {
    for (const k of Object.keys(jobs)) { try { jobs[k].destroy(); } catch (_) { /* */ } }
    for (const x of [bufA, bufB, bufY]) { try { x.destroy(); } catch (_) { /* */ } }
  }
  res.gated = gated;
  if (res.winner) {
    const key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
    const wj = jobs[res.winner.id];
    const compile = wj ? compileFromSamples(wj.compileTotal, wj.samples) : null;
    const value = { id: res.winner.id, median: res.winner.median, timings: res.timings, basis: 'kernel-only', compile: compile };
    WINNERS.set(key, value);
    if (o.store) { try { await o.store.set(key, value); } catch (_) { /* 退記憶體（已在 WINNERS） */ } }
  }
  res.key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
  return res;
}

// ---------- 啟動接線（G4）：載入勝者；簽名變了（或從未量過）的形狀才背景重跑 ----------
// 自動重跑只用小形狀（64×1024×1024）：CPU 參考在主執行緒算，大形狀會卡住頁面；大形狀由設定頁「重跑」手動做。
const TUNE = { started: false, store: null };
const AUTO_SHAPES = [{ M: 64, K: 1024, N: 1024 }];
// 重跑（設定頁「重跑」用）：先清掉這些形狀的勝者（記憶體與儲存），再競賽一次；派發在競賽期間用規則，不會被擋住。
// 注意：舊勝者在競賽前就清掉了；取消、沒有 GPU、或競賽失敗時，這些形狀就退回規則（下次競賽會再補上）。
async function rerunMatmul(shapes, o) {
  const opts = o || {};
  const list = (shapes || []).filter((sh) => sh && sh.M > 0 && sh.K > 0 && sh.N > 0);
  const store = opts.store || TUNE.store;
  for (const sh of list) {
    const key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
    WINNERS.delete(key);
    if (store && typeof store.remove === 'function') { try { await store.remove(key); } catch (_) { /* 記憶體已清 */ } }
  }
  return startMatmulRace(list, opts);
}
// 窗格（設定頁）建立快取時要用的同一組鍵條件：adapter 描述與能力表。窗格若用別的值，就查不到這裡的勝者。
function getMatmulTuneContext() { return { adapter: ADAPTER, caps: CAPS }; }

// initMatmulTuning({ device, adapterDesc, store, shapes })：探測能力、從 store 整批載入勝者，回報缺勝者的形狀（簽名變了就會缺）。
// 只讀，不量；量測由 startMatmulRace 做。store 沒給就用 variant_race 的預設（與 kernel_race 共用的 localStorage 快取，node 退記憶體）。
async function initMatmulTuning(o) {
  const opts = o || {};
  const VR = require('./variant_race.js');
  // 已經設定過的能力（例如設定頁用 adapter 探測的結果）就沿用，不被裝置探測蓋掉：
  // 兩種探測的欄位來源不同（adapter 的功能 vs 請求過的裝置功能），會讓同一張卡的競賽鍵飄移，設定頁的表格就查不到勝者。
  const caps = CAPS || KS.probeCaps(null, opts.device || null);
  const desc = opts.adapterDesc || 'unknown';
  if (!CAPS) setMatmulCaps(caps, desc);
  const store = opts.store || VR.createStore({});
  let entries = [];
  try { entries = await store.entries(); } catch (_) { entries = []; }
  setMatmulWinners(entries);
  TUNE.store = store;
  const sig = KS.capsHash(caps);
  const missing = (opts.shapes || []).filter((sh) => !WINNERS.has(KS.cacheKey(desc, 'matmul', sh, caps)));
  const stale = entries.filter((e) => String(e.key).split('|').pop() !== sig).length;
  return { tier: KS.tierOf(caps), capsSig: sig, loaded: entries.length, stale: stale, missing: missing };
}
// startMatmulRace(shapes, o)：逐形狀跑 raceMatmul（每形狀預算 2 秒，可取消）。o.navigator 必須給瀏覽器的 navigator 才會用 GPU。
// 回傳每個形狀一筆：{ shape, key, winner, noGpu, bad, skipped（依預估略過的候選）, cancelled, error }。
// 逐形狀獨立：某形狀丟例外只記在它自己那筆，後面照跑；裝置遺失就標原因並停止（其餘形狀標「未執行」）；取消在形狀之間與候選之間生效。
// opts.onProgress({ i, n, shape, msg })：狀態列用。opts.raceOne／opts.calibrate 可注入（測試用）。
// 競賽入口：整個競賽在 GPU 量測互斥鎖之內（前景排隊；opts.background 為真時，有量測在跑就跳過，不重疊）
function startMatmulRace(shapes, o) {
  const opts = o || {};
  return nn.withMeasureLock(() => startMatmulRaceInner(shapes, opts), { background: !!opts.background });
}
async function startMatmulRaceInner(shapes, o) {
  const opts = o || {};
  const list = (shapes || []).filter((sh) => sh && sh.M > 0 && sh.K > 0 && sh.N > 0);
  const n = list.length, out = [];
  const say = (i, sh, msg) => { try { if (opts.onProgress) opts.onProgress({ i: i + 1, n: n, shape: sh, msg: msg }); } catch (_) { /* 顯示失敗不影響競賽 */ } };
  const raceOne = opts.raceOne || raceMatmul;
  const calibrate = opts.calibrate || calibrateSimple;
  if (!n) return out;
  // 競賽勝者要寫進表格讀的那個儲存（TUNE.store）：沒有就建一個，表格之後也讀同一個，否則表格看不到這次的結果
  if (!TUNE.store) TUNE.store = require('./variant_race.js').createStore({});
  // 校正在最小的形狀上做（派發量最少，也是現行保護過的那個形狀）
  let calib = null, calibErr = null;
  try { calib = await calibrate(list.slice().sort((x, y) => flopsOf(x) - flopsOf(y))[0], opts); } catch (e) { calibErr = String((e && e.message) || e).slice(0, 200); }
  if (calibErr || (calib && calib.noGpu)) {
    const why = calibErr || ('沒有 GPU（' + String((calib && calib.reason) || '退回 CPU').slice(0, 160) + '）');
    for (const sh of list) out.push({ shape: sh, key: null, winner: null, noGpu: !calibErr, bad: [], skipped: [], cancelled: false, error: why });
    return out;
  }
  // 占峰值（屋頂 R0）：只在真的競賽時量一次，結果放 TUNE.roofline；量不到只記原因，不影響競賽
  if (!opts.raceOne && opts.roofline !== false) {
    try { TUNE.roofline = await measureRoofline({ navigator: opts.navigator, store: TUNE.store, locked: true }); }
    catch (e) { TUNE.roofline = { ok: false, reason: '量測失敗：' + String((e && e.message) || e).slice(0, 160) }; }
  }
  let stop = null;
  for (let i = 0; i < n; i++) {
    const sh = list[i];
    if (stop) { out.push({ shape: sh, key: null, winner: null, noGpu: false, bad: [], skipped: [], cancelled: stop === '已取消', error: '未執行：' + stop }); continue; }
    if (opts.cancel && opts.cancel()) { stop = '已取消'; out.push({ shape: sh, key: null, winner: null, noGpu: false, bad: [], skipped: [], cancelled: true, error: '未執行：已取消' }); continue; }
    say(i, sh, '驗證與計時中');
    try {
      const r = await raceOne(sh.M, sh.K, sh.N, { navigator: opts.navigator, store: TUNE.store, budgetMs: opts.budgetMs, cancel: opts.cancel, gSimple: calib.gSimple, safeMs: opts.safeMs, runs: opts.runs, K: opts.K, now: opts.now });
      out.push({ shape: sh, key: r.key || null, winner: r.winner || null, noGpu: !!r.noGpu, bad: r.bad || [], skipped: r.gated || [], cancelled: !!r.cancelled, error: null });
      if ((r.bad || []).some((b) => isLostText(b.reason))) stop = '裝置遺失（之後的形狀不再執行）';
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      out.push({ shape: sh, key: null, winner: null, noGpu: false, bad: [], skipped: [], cancelled: false, error: msg });
      if (isLostText(msg)) stop = '裝置遺失（之後的形狀不再執行）';
    }
    if (out[out.length - 1].cancelled) stop = '已取消';
  }
  return out;
}

module.exports = { setOffloadCrossover, rerunMatmul, getMatmulTuneContext, matmulRef, matmul, matmulIntRef, matmulInt, WGSL_MM_F32, WGSL_MM_F32_TILED, WGSL_MM_F32_VEC4, WGSL_MM_I32, plan, pickMatmulKernel, setMatmulCaps, getMatmulCaps: () => CAPS, setMatmulWinners, raceMatmul, initMatmulTuning, startMatmulRace, calibrateSimple, gateCandidates, estimateMs, flopsOf, SAFE_DISPATCH_MS, REL_SPEED, AUTO_SHAPES, TUNE, measureRoofline, pickBatch, compileFromSamples, pickRooflineIters, gflopsFrom, peakFromEntries, CORE_SAMPLE_MS, ROOF_TARGET_MS, ROOF_ABORT_MS, ROOF_MAX_ITERS, rooflineCalibrate, splitRuns, CORE_SPLIT_MS };
