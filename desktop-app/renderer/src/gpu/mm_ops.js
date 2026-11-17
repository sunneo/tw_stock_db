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
const MAX_BUF = 134217728;

// ---------- 變體選擇（G4 接線）：規則＋已存的競賽勝者（kernel_select.pickWithCache）----------
// WINNERS：key（KS.cacheKey）→ { id, median, timings }，由 variant_race 的 IndexedDB 存儲在啟動時整批載入（setMatmulWinners）。
// 同步查表：派發路徑不能等 IndexedDB；載入前或失敗時就是規則結果。
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
  const ref = () => (isInt ? matmulIntRef(a, aDims, b, bDims, azp, bzp) : matmulRef(a, aDims, b, bDims)).y;
  if (o.gpu === false) return { y: ref(), dims: pl.dims };
  const kernelId = isInt ? 'mm_simple_f32' : pickMatmulKernel(pl.M, pl.K, pl.N, o).id;
  const r = await nn.tryLayers(isInt ? 'matmulInt' : 'matmul', { navigator: o.navigator }, async (dev) => {
    for (const n of [total, a.length, b.length]) if (n * 4 > MAX_BUF) throw new Error('張量 ' + n + ' 個元素超過單一儲存緩衝區上限（128 MB），退 CPU');
    const u = new Int32Array([pl.B, pl.M, pl.K, pl.N, pl.Bb, azp || 0, bzp || 0, 0]);
    // 已經是對的型別就不再複製一份（大矩陣的複製本身就是可觀的時間）；o.cacheB：B 是常駐權重時，同一個陣列物件只上傳一次
    const mk = (src) => (isInt ? (src instanceof Int32Array ? src : Int32Array.from(src)) : (src instanceof Float32Array ? src : Float32Array.from(src)));
    // 變體：f32 才有平鋪／vec4 可選（kernel_select 的 applies 會排除太窄的形狀）；整數與太窄的維持簡單版
    const kid = isInt ? 'mm_simple_f32' : kernelId;
    const tiled = kid !== 'mm_simple_f32';
    o.lastKernel = kid;
    const code = isInt ? WGSL_MM_I32 : (kid === 'mm_vec4_f32' ? WGSL_MM_F32_VEC4 : (tiled ? WGSL_MM_F32_TILED : WGSL_MM_F32));
    const outs = await nn.runWgsl(dev, code,
      [{ data: mk(a) }, { data: mk(b), cache: !!o.cacheB }, { data: isInt ? new Int32Array(total) : new Float32Array(total), out: true }],
      new Uint8Array(u.buffer), tiled ? [Math.ceil(pl.N / 64), Math.ceil(pl.M / 64), pl.B] : Math.ceil(total / 64));
    return outs[0];
  }, null, ref);
  o.lastInfo = r.info;
  return { y: r.result, dims: pl.dims };
}
const matmul = (a, aD, b, bD, ops) => run('f32', a, aD, b, bD, 0, 0, ops);
const matmulInt = (a, aD, b, bD, azp, bzp, ops) => run('int', a, aD, b, bD, azp, bzp, ops);

// ---------- 競賽（G4）：對一個形狀，所有適用的 f32 變體先驗證（對 CPU 參考）再計時 ----------
// opts：{ navigator, store（variant_race.createStore，勝者寫入）, budgetMs, runs, K, cancel, now }
// 沒有真 GPU（退 cpu-js）就不競賽、回傳 { noGpu: true }，免得拿 CPU 的時間當結果。
// 計時包含上傳與回讀（與派發路徑的實際成本一致），同一組輸入、先暖機一次。
async function raceMatmul(M, K, N, opts) {
  const VR = require('./variant_race.js');
  const o = opts || {};
  const sh = { M: M, K: K, N: N };
  const clock = () => (typeof performance !== 'undefined' ? performance : Date).now();
  let s = 7; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
  const a = Float32Array.from({ length: M * K }, rnd), b = Float32Array.from({ length: K * N }, rnd);
  const ref = matmulRef(a, [M, K], b, [K, N]).y;
  let scale = 0; for (let i = 0; i < ref.length; i++) scale = Math.max(scale, Math.abs(ref[i]));
  // 暖機兼偵測：退 cpu-js 就不競賽
  const warm = { navigator: o.navigator, kernel: 'mm_simple_f32' };
  await matmul(a, [M, K], b, [K, N], warm);
  if (/cpu-js/.test((warm.lastInfo || {}).layer || '')) return { noGpu: true, winner: null, timings: {}, bad: [], skipped: [] };
  const ids = KS.VARIANTS.matmul.filter((v) => !v.applies || v.applies(sh)).map((v) => v.id);
  const cands = ids.map((id) => ({
    id: id,
    verify: async () => {
      const r = await matmul(a, [M, K], b, [K, N], Object.assign({}, o, { kernel: id }));
      let d = 0; for (let i = 0; i < ref.length; i++) d = Math.max(d, Math.abs(r.y[i] - ref[i]));
      return d / Math.max(scale, 1e-30);
    },
    run: async () => {
      const t0 = clock();
      await matmul(a, [M, K], b, [K, N], Object.assign({}, o, { kernel: id }));
      return clock() - t0;
    },
  }));
  const res = await VR.race(cands, { tol: 1e-5, budgetMs: o.budgetMs || VR.DEFAULT_BUDGET_MS, runs: o.runs || 3, K: o.K || 3, cancel: o.cancel, now: o.now || (() => clock()) });
  if (res.winner) {
    const key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
    const value = { id: res.winner.id, median: res.winner.median, timings: res.timings };
    WINNERS.set(key, value);
    if (o.store) { try { await o.store.set(key, value); } catch (_) { /* 退記憶體（已在 WINNERS） */ } }
  }
  res.key = KS.cacheKey(ADAPTER, 'matmul', sh, CAPS);
  return res;
}

module.exports = { matmulRef, matmul, matmulIntRef, matmulInt, WGSL_MM_F32, WGSL_MM_F32_TILED, WGSL_MM_F32_VEC4, WGSL_MM_I32, plan, pickMatmulKernel, setMatmulCaps, setMatmulWinners, raceMatmul };
