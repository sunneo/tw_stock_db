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
function workerSource() {
  return cpuRowsRef.toString() + `
const CACHE = new Map();
self.onmessage = (ev) => {
  const d = ev.data;
  try {
    let B = d.B;
    if (d.bKey != null) { if (B) { CACHE.set(d.bKey, B); if (CACHE.size > 4) CACHE.delete(CACHE.keys().next().value); } else B = CACHE.get(d.bKey); }
    if (!B) { self.postMessage({ id: d.id, miss: true }); return; }
    const C = cpuRowsRef(d.A, B, d.m, d.k, d.n, d.transB);
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
  const pool = [];                 // { w, busy, pending: Map id→{resolve,reject}, bKeys:Set }
  let seq = 0;
  let broken = null;               // 建立 Worker 失敗的原因；非 null 就不再嘗試
  // 兩邊的實測速率（flops/ms，指數平均）；沒有資料前用保守的初始比例
  const rate = { gpu: 0, cpu: 0 };
  let last = null;
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
    const d = HS.decideSplit({ work, gpuAvailable: true, cpuAvailable: want > 0, gpuRate: rate.gpu, cpuRate: rate.cpu, gpuOverheadMs: 0, cpuOverheadMs: CPU_OVERHEAD_MS });
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
    const cpuP = (async () => {
      const parts = [];
      for (let w = 0; w < nW; w++) {
        const r0 = mG + w * per, r1 = Math.min(m, r0 + per); if (r1 <= r0) break;
        const slot = pool[w];
        const msg = { id: ++seq, A: A.slice(r0 * k, r1 * k), m: r1 - r0, k, n, transB: !!r.transB };
        if (bId != null) {
          msg.bKey = bId;
          if (!slot.bKeys.has(bId)) { msg.B = B; slot.bKeys.add(bId); if (slot.bKeys.size > 4) slot.bKeys.delete(slot.bKeys.values().next().value); }
        } else msg.B = B;
        parts.push(post(slot, msg).catch(async (e) => {
          if (!e || !e.miss) throw e;
          slot.bKeys.delete(bId);
          return post(slot, Object.assign({}, msg, { id: ++seq, B }));   // Worker 端快取被擠掉：補送一次
        }));
      }
      const out = await Promise.all(parts);
      cpuMs = now() - t0;
      return out;
    })();
    const gpuP = (async () => { const y = await gpuFn(A.subarray(0, mG * k), mG); gpuMs = now() - t0; return y; })();
    let cpuParts, yG;
    try { [yG, cpuParts] = await Promise.all([gpuP, cpuP]); }
    catch (e) { return { shared: false, why: 'error', error: String((e && e.message) || e) }; }
    const y = new Float32Array(m * n);
    y.set(yG.length === mG * n ? yG : yG.subarray(0, mG * n), 0);
    let off = mG * n; cpuParts.forEach((c) => { y.set(c, off); off += c.length; });
    // 段耗時回饋：這次實測的 GPU 段與 CPU 段耗時，算出讓兩段相等的比例；下一次的比例不會超過它（CPU 段慢 → 往下修）
    fbFrac = HS.feedbackFraction(mC / m, gpuMs, cpuMs, MAX_CPU_RATIO);
    // 回饋：兩邊各自的速率（用各自完成的時間，不是總時間），下一次的比例據此調整
    if (gpuMs > 0) rate.gpu = ema(rate.gpu, (2 * mG * k * n) / gpuMs);
    if (cpuMs > 0) rate.cpu = ema(rate.cpu, (2 * mC * k * n) / cpuMs);
    last = { shared: true, m, mGpu: mG, mCpu: mC, workers: nW, ratio: Math.round(ratio * 1000) / 1000, gpuMs: Math.round(gpuMs * 10) / 10, cpuMs: Math.round(cpuMs * 10) / 10, totalMs: Math.round((now() - t0) * 10) / 10, flops };
    return { shared: true, y, info: last };
  }

  function stats() { return { cores: want, workers: pool.length, broken, rate: { gpu: rate.gpu, cpu: rate.cpu }, feedback: fbFrac, last }; }
  function dispose() { want = 0; ensurePool(); }
  // _setRates／_ratioNow 只給測試用（底線開頭）：直接設定兩邊速率，讓決策可以確定地走到切分或不切
  return { setCores, cores: () => want, run, stats, dispose, _ratioNow: ratioNow, _setRates: (g, c) => { rate.gpu = Number(g) || 0; rate.cpu = Number(c) || 0; fbFrac = null; } };
}

// 全域單例：mm_ops 與設定頁共用
let SHARED = null;
function getShared() { if (!SHARED) SHARED = createCpuShare({}); return SHARED; }

module.exports = { createCpuShare, cpuRowsRef, workerSource, getShared, MIN_FLOPS, MIN_ROWS, MAX_CPU_RATIO };
