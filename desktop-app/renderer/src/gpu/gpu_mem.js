'use strict';
// gpu_mem.js — GPU 記憶體上限：設定值解析、實測探測（probe）與建議值（DESIGN.webgpu-cuda.md §7.30）。
// 設定 gpuMemMB（MB，0＝自動）。自動＝用探測結果（localStorage 快取）× 保守比例；沒探測過就用保守預設 1 GiB。
// 探測只在使用者按「偵測／基準」時做：先小後大逐步配置測試緩衝區（每塊 ≤256 MiB、總量有上限與逾時），每步用 out-of-memory 錯誤範圍
// 接住失敗，並量寫入頻寬——頻寬掉到起始值的 40% 以下視為「已經溢出到系統記憶體」（WDDM 會讓配置成功但變很慢），建議值停在溢出之前。
// 遇到 device lost 立刻停止並標記；結束一定釋放所有測試緩衝區與裝置；軟體 WebGPU（SwiftShader 等）不量。
// 純 UMD；可在 node 用假 WebGPU 測（gpu_mem.test.js）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaGpuMem = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MiB = 1048576, GiB = 1073741824;
  const DEFAULT_AUTO_BYTES = GiB;          // 沒探測過時的保守預設
  const SAFETY = 0.75;                     // 建議值＝實測可用量 × 0.75（留給系統與其他程式）
  const SPILL_RATIO = 0.4;                 // 寫入頻寬低於起始值的這個比例＝疑似溢出
  const SOFT_RE = /swiftshader|llvmpipe|software|lavapipe|microsoft basic render/i;
  const USAGE = { COPY_DST: 0x0008, STORAGE: 0x0080 };
  const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

  const fmt = (b) => (b >= GiB ? (b / GiB).toFixed(2) + ' GiB' : Math.round(b / MiB) + ' MiB');

  // 設定值（可能是字串、負數、NaN）→ MB 整數；0＝自動
  function parseMB(v) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1 << 20) : 0; }

  // 決定上限：手動 > 探測快取 > 保守預設。回 { bytes, source, why }
  function resolveBudget(opts) {
    const o = opts || {}, mb = parseMB(o.settingMB);
    if (mb > 0) return { bytes: mb * MiB, source: 'manual', why: '設定 ' + mb + ' MB' };
    const p = o.probe;
    if (p && p.ok && p.suggestBytes > 0) return { bytes: p.suggestBytes, source: 'probe', why: '偵測建議 ' + fmt(p.suggestBytes) };
    return { bytes: DEFAULT_AUTO_BYTES, source: 'default', why: '自動（尚未偵測，保守 ' + fmt(DEFAULT_AUTO_BYTES) + '；按「偵測／基準」可找出實際值）' };
  }

  // 由步驟結果算建議值。steps：[{bytes, ok, mbps}]（遞增、含失敗的最後一步）
  function analyze(steps, cap) {
    let usable = 0, spill = false, base = 0;
    for (const s of steps) {
      if (!s.ok) break;
      if (!base && s.mbps > 0) base = s.mbps;
      if (base && s.mbps > 0 && s.mbps < base * SPILL_RATIO) { spill = true; break; }
      usable = s.bytes;
    }
    const failed = steps.some((s) => !s.ok);
    const suggest = usable > 0 ? Math.max(256 * MiB, Math.floor(usable * SAFETY / (64 * MiB)) * 64 * MiB) : 0;
    return { usableBytes: usable, spillSuspected: spill, hitFailure: failed, hitCap: !failed && !spill && usable >= cap, suggestBytes: suggest };
  }

  // 探測。nav＝navigator（或假物件）；opts：maxProbeBytes（預設 4 GiB）、timeoutMs（預設 20000）、bench(dev)→GFLOP/s（可選）、log(s)
  async function probe(nav, opts) {
    const o = opts || {}, nowF = o.now || now, cap = o.maxProbeBytes || 4 * GiB, deadline = nowF() + (o.timeoutMs || 20000), log = o.log || (() => {});
    const R = { ok: false, at: Date.now(), soft: false, adapter: null, limits: null, steps: [], writeMBps: 0, gflops: 0, lost: '', truncated: false, reason: '' };
    if (!nav || !nav.gpu) { R.reason = '這個環境沒有 WebGPU'; return R; }
    const ad = await nav.gpu.requestAdapter(); if (!ad) { R.reason = 'WebGPU 沒有可用的介面卡'; return R; }
    const ai = ad.info || (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : {}) || {};
    R.adapter = { vendor: ai.vendor || '', architecture: ai.architecture || '', device: ai.device || '', description: ai.description || '', fallback: !!(ad.isFallbackAdapter || ai.isFallbackAdapter) };
    R.limits = { maxBufferSize: ad.limits.maxBufferSize, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize };
    R.soft = R.adapter.fallback || SOFT_RE.test([R.adapter.vendor, R.adapter.architecture, R.adapter.device, R.adapter.description].join(' '));
    if (R.soft) { R.reason = '軟體 WebGPU（沒有真 GPU），不量'; return R; }
    const need = {}; for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize']) need[k] = Math.min(ad.limits[k], GiB);
    const dev = await ad.requestDevice({ requiredLimits: need });
    let lost = ''; dev.lost.then((i) => { lost = (i && (i.reason + ' ' + (i.message || ''))) || 'lost'; });
    const bufs = [], piece = Math.min(256 * MiB, need.maxBufferSize);
    const scratch = new Uint8Array(16 * MiB);
    const release = () => { while (bufs.length) { try { bufs.pop().destroy(); } catch (_) { /* 已釋放 */ } } };
    const settle = async () => { if (dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone(); };
    // 配置到累計 target 位元組；回 { ok, mbps }
    const alloc = async (target) => {
      dev.pushErrorScope('out-of-memory'); dev.pushErrorScope('validation');
      let have = bufs.reduce((a, b) => a + b.size, 0), last = null, ms = 0;
      try {
        while (have < target) {
          const n = Math.min(piece, target - have); const b = dev.createBuffer({ size: n, usage: USAGE.STORAGE | USAGE.COPY_DST }); bufs.push(b); have += n; last = b;
          dev.queue.writeBuffer(b, 0, scratch, 0, 256);   // 觸碰：逼驅動真的提交這塊記憶體
        }
        await settle();
        if (last) { const t = nowF(); const w = Math.min(scratch.length, last.size & ~3); dev.queue.writeBuffer(last, 0, scratch, 0, w); await settle(); ms = Math.max(0.001, nowF() - t); }
      } catch (e) { /* 下面看錯誤範圍 */ }
      const e1 = await dev.popErrorScope(), e2 = await dev.popErrorScope();
      const err = e1 || e2;
      return { ok: !err && !lost, mbps: ms ? (Math.min(scratch.length, last.size) / MiB) / (ms / 1000) : 0 };
    };
    try {
      if (o.bench) { try { R.gflops = await o.bench(dev); } catch (_) { /* 基準失敗不影響探測 */ } }
      // 階段一：倍增（256 MiB 起）
      let okB = 0, failB = 0, t = 256 * MiB;
      while (t <= cap) {
        if (nowF() > deadline) { R.truncated = true; break; }
        const r = await alloc(t); R.steps.push({ bytes: t, ok: r.ok, mbps: +r.mbps.toFixed(0) }); log('探測 ' + fmt(t) + '：' + (r.ok ? '成功 ' + r.mbps.toFixed(0) + ' MB/s' : '失敗'));
        if (!r.ok) { failB = t; break; }
        okB = t; if (lost) break; t *= 2;
      }
      // 階段二：在 (okB, failB) 之間二分三次（解析度到 1/8 區間）
      for (let i = 0; i < 3 && failB && !lost && okB; i++) {
        if (nowF() > deadline) { R.truncated = true; break; }
        const mid = Math.floor((okB + failB) / 2 / (64 * MiB)) * 64 * MiB; if (mid <= okB || mid >= failB) break;
        release(); const r = await alloc(mid); R.steps.push({ bytes: mid, ok: r.ok, mbps: +r.mbps.toFixed(0) });
        log('二分 ' + fmt(mid) + '：' + (r.ok ? '成功' : '失敗')); if (r.ok) okB = mid; else failB = mid;
      }
      R.lost = lost;
      const a = analyze(R.steps.slice().sort((x, y) => x.bytes - y.bytes), cap);
      Object.assign(R, a); R.writeMBps = (R.steps.find((s) => s.ok && s.mbps > 0) || {}).mbps || 0;
      R.ok = a.suggestBytes > 0;
      R.reason = lost ? 'GPU 裝置在探測中遺失（' + lost + '），結果不可信' : !R.ok ? '連 256 MiB 都配置失敗'
        : '實測可用約 ' + fmt(a.usableBytes) + (a.spillSuspected ? '（再往上寫入頻寬掉到 ' + Math.round(SPILL_RATIO * 100) + '% 以下，疑似溢出到系統記憶體）' : a.hitCap ? '（到探測上限仍成功，實際可能更多）' : '') + '，建議上限 ' + fmt(a.suggestBytes) + '（×' + SAFETY + '）';
      if (lost) R.ok = false;
    } finally {
      release(); try { dev.destroy && dev.destroy(); } catch (_) { /* */ }
    }
    return R;
  }

  return { probe, analyze, resolveBudget, parseMB, fmt, DEFAULT_AUTO_BYTES, SAFETY, SPILL_RATIO, MiB, GiB };
});
