'use strict';
// cpu_share.js — 異質運算（GPU＋CPU 分工）：把一個 f32 矩陣乘按「列」切成兩段，GPU 算前段、CPU 的 Web Worker 同時算後段，再接起來。
// 目的：內顯（Intel Xe 等）跑矩陣乘時 GPU 滿載、CPU 閒置；內顯與 CPU 共用記憶體，分工沒有 PCIe 搬運成本。
//
//   createCpuShare({ makeWorker, cores, now }) → share
//     share.setCores(n)            CPU 出幾個核心（0＝關閉，完全不分工）
//     share.cores()                目前設定
//     share.run(gpuFn, A, B, m, k, n, opts) → Promise<{ y, info }>
//         gpuFn(Arows, mG) → Promise<Float32Array>   算前 mG 列（呼叫端提供，通常是原本的 GPU 路徑）
//         opts.transB          B 以 n×k 儲存
//         opts.bKey            B 是常駐權重時給同一個物件，Worker 端快取、只送一次
//     share.stats()                最近一次的分工結果（列數、兩邊耗時、採用的比例）
//   cpuRowsRef(A, B, m, k, n, transB) → Float32Array     單執行緒參考實作（Worker 內跑的就是同一個函式）
//
// 不改變數值語意：兩邊都是 f32 累加（GPU 與 CPU 的累加順序不同，差異在 tolerance 內，與既有的 GPU↔CPU 對拍一致）。
// 沒有 Worker（makeWorker 回傳 null／丟錯）或 cores=0 → 一律回報 shared:false，由呼叫端走原路徑。

const HS = require('./hetero_split.js');  // 分攤決策公式（見 docs/DESIGN.cudaweb-hetero.md 第 2 節）
const GQ = require('./gpu_async_queue.js'); // 統一句柄：CPU 段與 GPU 段都是佇列上的提交（見設計文件第 4 節）
const CG = require('./cpu_gemm.js');        // 分塊＋WASM SIMD 主執行緒核心（docs/DESIGN.cpu-gemm.md）
const CW = require('./cpu_gemm_wasm.js');   // WASM 位元組（送給 Worker；不支援 SIMD 時退回 cpuRowsRef）
const CR = require('./cpu_gemm_rows.js');   // Worker 內的列區塊核心（自給自足，可 toString 進 Blob）
const MIN_FLOPS = 2e7;      // M*K*N 小於這個不分工（派發與搬運的固定成本大於收益）
const MIN_ROWS = 16;
const MAX_CPU_RATIO = 0.5;  // CPU 最多分擔一半的列；GPU 慢到比 CPU 還慢時，使用者應直接選 CPU 模式
const FIRST_RATIO_PER_CORE = 0.02;
// 還沒有 CPU 速率時的探測比例：只為了量 CPU 速率，會讓 CPU 做一小份（設計文件第 2 節的例外，見第 9 節）
const PROBE_EVERY = 10;     // 決策說「不切」時，每 10 次強制探測一次，免得 CPU 速率過期
const CPU_OVERHEAD_MS = 0.5; // 每次分工的 CPU 固定成本（送出／接收訊息、拷貝），用於決策

// Worker 內與主執行緒共用的核心：列區塊 C[m×n] = A[m×k]·B（transB：B 是 n×k）。i-k-j 迴圈讓 B 的列連續讀。
function cpuRowsRef(A, B, m, k, n, transB) {
  const C = new Float32Array(m * n);
  if (!transB) {
    for (let i = 0; i < m; i++) {
      const ci = i * n, ai = i * k;
      for (let kk = 0; kk < k; kk++) {
        const a = A[ai + kk]; if (a === 0) continue;
        const bk = kk * n;
        for (let j = 0; j < n; j++) C[ci + j] += a * B[bk + j];
      }
    }
  } else {
    for (let i = 0; i < m; i++) {
      const ai = i * k;
      for (let j = 0; j < n; j++) {
        const bj = j * k; let s = 0;
        for (let kk = 0; kk < k; kk++) s += A[ai + kk] * B[bj + kk];
        C[i * n + j] = s;
      }
    }
  }
  return C;
}

// Worker 原始碼（Blob 用）：從 cpuRowsRef 的原始碼組出，所以測試與實際執行是同一份邏輯
// 主執行緒的 CPU 核心：支援 SIMD 就用分塊＋WASM SIMD（實測約為舊核心 15 倍），否則退回 cpuRowsRef。結果等價（相對誤差 ≤ 1e-5）。
const SIMD_BYTES = (() => { try { return CW.simdSupported() ? CW.buildModule() : null; } catch (_) { return null; } })();
function cpuKernel(A, B, m, k, n, transB, ko) {
  if (SIMD_BYTES) { try { return CG.gemmPackedSimd(A, B, m, k, n, Object.assign({ transB: !!transB }, ko || {})); } catch (_) { /* 退回參考實作 */ } }
  return cpuRowsRef(A, B, m, k, n, transB);
}

// 工作者路徑門檻（純函式）：運算量 2·m·k·n 小於門檻就只用主執行緒。
// 依據（真機與節點量測）：512³（約 2.7e8 flops）時工作者慢於主執行緒（真機 9.6／9.4／11.4 vs 12.6 GFLOP/s）；
// 1024³（約 2.1e9）時工作者有加速（節點 1.75× 到 2.7×）。門檻定在兩者之間，768³ 的 2 倍，之後要用真機再校正。
const MIN_WORKER_FLOPS = 2 * 768 * 768 * 768;
function cpuPathFor(o) {
  const m = Number(o.m) || 0, k = Number(o.k) || 0, n = Number(o.n) || 0, w = Math.floor(Number(o.workers) || 0);
  const flops = 2 * m * k * n;
  const thr = o.minFlops == null ? MIN_WORKER_FLOPS : Number(o.minFlops);
  if (w < 1) return { path: 'main', flops, reason: '沒有工作者' };
  if (flops < thr) return { path: 'main', flops, reason: '運算量 ' + flops + ' 小於門檻 ' + thr + '：傳送與拼接成本划不來，只用主執行緒' };
  return { path: 'workers', flops, reason: '運算量大於門檻：沿 M 分給工作者' };
}

function workerSource() {
  return cpuRowsRef.toString() + CR.gemmRowsSimdKernel.toString() + `
const CACHE = new Map();
self.onmessage = (ev) => {
  const d = ev.data;
  try {
    let B = d.B;
    if (d.bKey != null) { if (B) { CACHE.set(d.bKey, B); if (CACHE.size > 4) CACHE.delete(CACHE.keys().next().value); } else B = CACHE.get(d.bKey); }
    if (!B) { self.postMessage({ id: d.id, miss: true }); return; }
    const C = d.wasm
      ? gemmRowsSimdKernel(d.A, B, d.m, d.k, d.n, false, !!d.transB, 0, d.m, d.wasm, 96, 256, 512, null)
      : cpuRowsRef(d.A, B, d.m, d.k, d.n, d.transB);
    self.postMessage({ id: d.id, C }, [C.buffer]);
  } catch (e) { self.postMessage({ id: d.id, error: String((e && e.message) || e) }); }
};`;
}

function defaultMakeWorker() {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
  const w = new Worker(url);
  w.__url = url;
  return w;
}

function createCpuShare(o) {
  const opts = o || {};
  const makeWorker = opts.makeWorker || defaultMakeWorker;
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance : Date).now());
  let want = Math.max(0, Math.floor(opts.cores || 0));
  const minWorkerFlops = opts.minWorkerFlops == null ? MIN_WORKER_FLOPS : Number(opts.minWorkerFlops);   // 測試可設 0 以強制走工作者路徑
  const pool = [];                 // { w, busy, pending: Map id→{resolve,reject}, bKeys:Set }
  let seq = 0;
  let broken = null;               // 建立 Worker 失敗的原因；非 null 就不再嘗試
  // 兩邊的實測速率（flops/ms，指數平均）；沒有資料前用保守的初始比例
  const rate = { gpu: 0, cpu: 0 };
  let last = null;
  const profileOn = !!opts.profile;
  // 主執行緒 CPU 核心的呼叫（含計時，評估模式才累加）
  function timedKernel(A, B, m, k, n, transB, ko) {
    const T = profileOn ? {} : null; const w0 = profileOn ? now() : 0;
    const y = cpuKernel(A, B, m, k, n, transB, Object.assign({}, ko || {}, { timing: T }));
    if (T) { cpuBreak.calls++; cpuBreak.wallMs += now() - w0; cpuBreak.packBMs += T.packBMs || 0; cpuBreak.packAMs += T.packAMs || 0; cpuBreak.computeMs += T.computeMs || 0; cpuBreak.blocksReused += T.blocksReused || 0; }
    return y;
  }   // 評估模式：累加主執行緒 CPU 核心的分段計時（打包 B、打包 A、計算、呼叫次數）
  const cpuBreak = { calls: 0, packBMs: 0, packAMs: 0, computeMs: 0, blocksReused: 0, wallMs: 0 };
  let goMs = 0;                    // GPU 段提交時在主執行緒的同步成本（EMA，毫秒）：不隨列數變，當作固定成本放進決策
  let lastCpuOwnMs = 0;            // 最近一次 CPU 段自己執行的時間（不含排在 GPU 提交後面的等待）
  // 速率持久化（可選）：opts.rateStore（hetero_rates.createRateStore）＋ opts.rateKey。建立時載入；每次分工後存回（不等待、失敗不影響執行）。
  const rateStore = opts.rateStore || null, rateKeyStr = opts.rateKey || null;
  if (rateStore && rateKeyStr) {
    rateStore.load(rateKeyStr).then((v) => { if (v && !(rate.gpu > 0)) { rate.gpu = v.gpu; rate.cpu = v.cpu; } }).catch(() => {});
  }
  const saveRates = () => { if (rateStore && rateKeyStr && rate.gpu > 0 && rate.cpu > 0) rateStore.save(rateKeyStr, { gpu: rate.gpu, cpu: rate.cpu, updatedAt: Date.now() }).catch(() => {}); };

  // 統一句柄的執行器：op.device 為 'cpu' 時把列區塊送給 Worker；為 'gpu' 時呼叫呼叫端的 gpuFn
  let streamSeq = 0;
  const queue = GQ.createGpuQueue({
    maxPending: 64,
    execute: (op, a) => {
      if (op.device !== 'cpu') return Promise.resolve(a.fn(a.A, a.mG));
      const s0 = now(); const p = cpuExec(a);
      p.then(() => { lastCpuOwnMs = now() - s0; }, () => { lastCpuOwnMs = now() - s0; });
      return p;
    },
  });
  async function cpuExec(a) {
    const rows = a.m - a.mG;
    if (rows > 0 && cpuPathFor({ m: rows, k: a.k, n: a.n, workers: a.nW, minFlops: minWorkerFlops }).path === 'main') {
      return [timedKernel(a.A.slice(a.mG * a.k, a.m * a.k), a.B, rows, a.k, a.n, !!a.transB, { cacheB: a.bId != null })];
    }
    const parts = [];
    for (let w = 0; w < a.nW; w++) {
      const r0 = a.mG + w * a.per, r1 = Math.min(a.m, r0 + a.per); if (r1 <= r0) break;
      const slot = pool[w];
      const msg = { id: ++seq, A: a.A.slice(r0 * a.k, r1 * a.k), m: r1 - r0, k: a.k, n: a.n, transB: !!a.transB, wasm: SIMD_BYTES };
      if (a.bId != null) {
        msg.bKey = a.bId;
        if (!slot.bKeys.has(a.bId)) { msg.B = a.B; slot.bKeys.add(a.bId); if (slot.bKeys.size > 4) slot.bKeys.delete(slot.bKeys.values().next().value); }
      } else msg.B = a.B;
      parts.push(post(slot, msg).catch(async (e) => {
        if (!e || !e.miss) throw e;
        slot.bKeys.delete(a.bId);
        return post(slot, Object.assign({}, msg, { id: ++seq, B: a.B }));   // Worker 端快取被擠掉：補送一次
      }));
    }
    return Promise.all(parts);
  }
  const bIds = new WeakMap(); let bSeq = 0;

  function ensurePool() {
    while (pool.length < want && !broken) {
      let w = null;
      try { w = makeWorker(); } catch (e) { broken = String((e && e.message) || e); break; }
      if (!w) { broken = '這個環境沒有 Worker'; break; }
      const slot = { w, pending: new Map(), bKeys: new Set() };
      w.onmessage = (ev) => {
        const d = ev.data || {}; const p = slot.pending.get(d.id); if (!p) return;
        slot.pending.delete(d.id);
        if (d.error) p.reject(new Error(d.error)); else if (d.miss) p.reject(Object.assign(new Error('miss'), { miss: true })); else p.resolve(d.C);
      };
      w.onerror = (e) => { slot.pending.forEach((p) => p.reject(new Error(String((e && e.message) || 'worker error')))); slot.pending.clear(); };
      pool.push(slot);
    }
    while (pool.length > want) { const s = pool.pop(); try { s.w.terminate(); if (s.w.__url) URL.revokeObjectURL(s.w.__url); } catch (_) { /* 結束失敗不影響 */ } }
  }

  function setCores(n) {
    want = Math.max(0, Math.min(256, Math.floor(Number(n) || 0)));
    if (want === 0) ensurePool(); else { broken = null; }   // 關閉時立刻收掉 Worker；再開時允許重試
  }

  function post(slot, msg, transfer) {
    return new Promise((resolve, reject) => { slot.pending.set(msg.id, { resolve, reject }); try { slot.w.postMessage(msg, transfer || []); } catch (e) { slot.pending.delete(msg.id); reject(e); } });
  }

  // 比例：兩邊速率都量到了，就用分攤決策（含固定成本與 15% margin，見 hetero_split）；還沒量到就做小份探測。
  // 決策說不切時，每 PROBE_EVERY 次探測一次，免得 CPU 速率過期。未給尺寸時當作大運算（測試與舊呼叫端用）。
  let sinceProbe = 0;
  let fbFrac = null;   // 上一次分工的實測段耗時回饋（null＝還沒有）
  function ratioNow(m, k, n) {
    const probe = Math.min(MAX_CPU_RATIO, want * FIRST_RATIO_PER_CORE);
    if (!(rate.gpu > 0 && rate.cpu > 0)) return probe;
    const work = (m && k && n) ? 2 * m * k * n : 1e9;
    const d = HS.decideSplit({ work, gpuAvailable: true, cpuAvailable: want > 0, gpuRate: rate.gpu, cpuRate: rate.cpu, gpuOverheadMs: goMs, cpuOverheadMs: CPU_OVERHEAD_MS });
    if (d.mode === 'split') {
      sinceProbe = 0;
      const f = fbFrac == null ? d.fraction : Math.min(d.fraction, fbFrac);   // 實測段耗時的回饋只會往下修
      return Math.min(MAX_CPU_RATIO, f);
    }
    if (++sinceProbe >= PROBE_EVERY) { sinceProbe = 0; return probe; }
    return 0;
  }
  const ema = (old, v) => (old > 0 ? old * 0.6 + v * 0.4 : v);

  async function run(gpuFn, A, B, m, k, n, ro) {
    const r = ro || {};
    const flops = 2 * m * k * n;
    if (want <= 0) return { shared: false, why: 'off' };
    if (m < MIN_ROWS || m * k * n < MIN_FLOPS) return { shared: false, why: 'small' };
    ensurePool();
    if (broken || !pool.length) return { shared: false, why: broken || 'no-worker' };
    const ratio = ratioNow(m, k, n);
    let mC = Math.floor(m * ratio);
    mC = Math.min(mC, m - 1);
    if (mC < 1) return { shared: false, why: 'ratio' };
    const mG = m - mC;
    // CPU 段再按列分給各 Worker
    const nW = Math.min(pool.length, mC);
    const per = Math.ceil(mC / nW);
    let bId = null;
    if (r.bKey && typeof r.bKey === 'object') { bId = bIds.get(r.bKey); if (bId == null) { bId = ++bSeq; bIds.set(r.bKey, bId); } }
    const t0 = now();
    let cpuMs = 0, gpuMs = 0;
    // 統一句柄：CPU 段與 GPU 段都是佇列上的一次提交，各自一條 stream（每次分工用新的 stream 編號，失敗不會影響下一次）
    const sG = ++streamSeq * 2, sC = sG + 1;
    let gpuSyncMs = 0;
    const timedGpu = (Asub, mGv) => { const s1 = now(); const rr = gpuFn(Asub, mGv); gpuSyncMs = now() - s1; return rr; };
    const hG = queue.submit({ device: 'gpu', name: 'matmul' }, { fn: timedGpu, A: A.subarray(0, mG * k), mG }, sG);
    const hC = queue.submit({ device: 'cpu', name: 'rows' }, { A, B, m, k, n, transB: !!r.transB, bId, mG, nW, per }, sC);
    const pG = queue.wait(hG).then((v) => { gpuMs = now() - t0; return v; });
    const pC = queue.wait(hC).then((v) => { cpuMs = now() - t0; return v; });
    const settled = await Promise.all([pG, pC].map((p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))));
    try { queue.forget(hG); queue.forget(hC); } catch (_) { /* 句柄已在上面等完，forget 不會失敗；保險起見忽略 */ }
    const bad = settled.find((s) => !s.ok);
    if (bad) return { shared: false, why: 'error', error: String((bad.e && bad.e.message) || bad.e) };
    const yG = settled[0].v, cpuParts = settled[1].v;
    const y = new Float32Array(m * n);
    y.set(yG.length === mG * n ? yG : yG.subarray(0, mG * n), 0);
    let off = mG * n; cpuParts.forEach((c) => { y.set(c, off); off += c.length; });
    // 段耗時回饋：這次實測的 GPU 段與 CPU 段耗時，算出讓兩段相等的比例；下一次的比例不會超過它（CPU 段慢 → 往下修）
    const cpuOwn = lastCpuOwnMs > 0 ? lastCpuOwnMs : cpuMs;
    fbFrac = HS.feedbackFraction(mC / m, gpuMs, cpuOwn, MAX_CPU_RATIO);
    goMs = ema(goMs, gpuSyncMs);
    // 回饋：兩邊各自的速率（用各自完成的時間，不是總時間），下一次的比例據此調整
    if (gpuMs > 0) rate.gpu = ema(rate.gpu, (2 * mG * k * n) / gpuMs);
    if (cpuOwn > 0) rate.cpu = ema(rate.cpu, (2 * mC * k * n) / cpuOwn);
    saveRates();
    last = { shared: true, gpuSyncMs: Math.round(gpuSyncMs * 10) / 10, cpuOwnMs: Math.round(cpuOwn * 10) / 10, m, mGpu: mG, mCpu: mC, workers: nW, ratio: Math.round(ratio * 1000) / 1000, gpuMs: Math.round(gpuMs * 10) / 10, cpuMs: Math.round(cpuMs * 10) / 10, totalMs: Math.round((now() - t0) * 10) / 10, flops };
    return { shared: true, y, info: last };
  }

  // 純 CPU 池（沒有 WebGPU 時用；設計文件第 5 節）：全部列交給 Worker；沒有 Worker 就在主執行緒算；Worker 出錯也退回主執行緒。
  // 回傳一定是 shared:true 且結果正確，info.mode 說明實際走的路徑（cpu-workers／cpu-main）。
  async function runCpuOnly(A, B, m, k, n, ro) {
    const r = ro || {};
    const transB = !!r.transB;
    const mainRun = (why, fallback) => ({ shared: true, y: timedKernel(A, B, m, k, n, transB, { cacheB: !!r.bKey }), info: { mode: 'cpu-main', workers: 0, why, fallback } });
    if (want <= 0) return mainRun('off');
    const pick = cpuPathFor({ m, k, n, workers: want, minFlops: minWorkerFlops });
    if (pick.path === 'main') return { shared: true, y: cpuKernel(A, B, m, k, n, transB), info: { mode: 'cpu-main', workers: 0, why: pick.reason, threshold: true } };
    ensurePool();
    if (broken || !pool.length) return mainRun(broken || 'no-worker');
    const nW = Math.min(pool.length, m);
    if (nW < 1) return mainRun('empty');
    const per = Math.ceil(m / nW);
    let bId = null;
    if (r.bKey && typeof r.bKey === 'object') { bId = bIds.get(r.bKey); if (bId == null) { bId = ++bSeq; bIds.set(r.bKey, bId); } }
    const t0 = now();
    try {
      const parts = await cpuExec({ A, B, m, k, n, transB, bId, mG: 0, nW, per });
      const y = new Float32Array(m * n);
      let off = 0; parts.forEach((c) => { y.set(c, off); off += c.length; });
      return { shared: true, y, info: { mode: 'cpu-workers', workers: nW, rows: m, totalMs: Math.round((now() - t0) * 10) / 10 } };
    } catch (e) {
      return mainRun(null, 'worker-error: ' + String((e && e.message) || e));
    }
  }

  function stats() { return { cores: want, workers: pool.length, broken, rate: { gpu: rate.gpu, cpu: rate.cpu }, feedback: fbFrac, goMs, cpuBreak: profileOn ? Object.assign({}, cpuBreak) : null, last }; }
  function dispose() { want = 0; ensurePool(); }
  // _setRates／_ratioNow 只給測試用（底線開頭）：直接設定兩邊速率，讓決策可以確定地走到切分或不切
  return { setCores, cores: () => want, run, runCpuOnly, stats, dispose, _ratioNow: ratioNow, _setRates: (g, c) => { rate.gpu = Number(g) || 0; rate.cpu = Number(c) || 0; fbFrac = null; } };
}

// 全域單例：mm_ops 與設定頁共用
let SHARED = null;
function getShared() { if (!SHARED) SHARED = createCpuShare({}); return SHARED; }

// CPU 核心的版本識別：核心改了（分塊、微核心、工作者協定）就要換這個字串，速率快取的鍵會跟著變，舊速率自動作廢。
const CPU_KERNEL_ID = 'cpu-simd-pack4x8-v2';

module.exports = { createCpuShare, cpuRowsRef, workerSource, getShared, MIN_FLOPS, MIN_ROWS, MAX_CPU_RATIO, CPU_KERNEL_ID, MIN_WORKER_FLOPS, cpuPathFor };
