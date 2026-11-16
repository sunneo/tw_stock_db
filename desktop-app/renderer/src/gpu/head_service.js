// head_service.js — 渲染程序端的 GPU 版 lm_head 服務（DESIGN.webgpu-cuda.md §7.3 接線）。純 UMD，node 可 require。
// 主程序用信箱檔轉來每個詞元的隱藏狀態（head-<runId>-<seq>.req）；這裡用 cudaweb 的 q8lm 算 logits，寫回 head-<runId>-<seq>.res。
// 原則：只接受 GPU（T1）的結果。沒有 WebGPU、或掉到 WebGL2／純 JS（比原生 ORT 的 CPU 還慢）時一律回 error，
// 由子程序自己退回 CPU 的 lm_head（結果與原路徑相同，只是沒有加速），並把原因帶回「done.gpu_head.fallback」。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./infer_ops.js'));
  else root.FaHeadService = factory(root.FaInferOps);
})(typeof self !== 'undefined' ? self : this, function (inferOps) {
  'use strict';
  const CHUNK_BYTES = 64 * 1024 * 1024;  // 預設裝置的儲存緩衝上限 128 MiB，照詞表列切塊

  const b64ToBytes = (s) => {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
    const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
  };
  const bytesToB64 = (u8) => {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s);
  };
  const toF32 = (u8) => { const ab = new ArrayBuffer(u8.length); new Uint8Array(ab).set(u8); return new Float32Array(ab); };

  // opts：{ meta:{V,K,zp,scale}, loadWeights:()=>Promise<Uint8Array>, navigator, ops（測試可注入） }
  function createHeadService(opts) {
    const ops = opts.ops || inferOps;
    let chunks = null, loading = null;
    const stats = { served: 0, errors: 0, lastMs: 0, lastLayer: '', lastError: '' };
    async function load() {
      if (chunks) return;
      if (!loading) loading = (async () => {
        const w = await opts.loadWeights();
        const m = opts.meta;
        if (w.length !== m.V * m.K) throw new Error('lm_head 權重大小 ' + w.length + ' 與 V×K=' + (m.V * m.K) + ' 不符');
        chunks = ops.planChunks(w, m.V, m.K, CHUNK_BYTES);
      })();
      try { await loading; } catch (e) { loading = null; throw e; }
    }
    // 回傳 logits 的 base64；失敗丟例外（呼叫端寫成 error 回應）
    async function compute(hiddenB64) {
      const t0 = Date.now();
      await load();
      const m = opts.meta;
      const hidden = toF32(b64ToBytes(hiddenB64));
      if (hidden.length !== m.K) throw new Error('隱藏狀態長度 ' + hidden.length + '，預期 ' + m.K);
      const r = await ops.q8lm(hidden, chunks, m.zp, m.K, m.scale, { navigator: opts.navigator });
      stats.lastLayer = r.info.layer;
      if (r.info.layer !== 'T1') throw new Error('沒有用到 WebGPU（實際層：' + r.info.layer + '；' + (r.info.reason || '無原因') + '）');
      stats.served++; stats.lastMs = Date.now() - t0;
      const lg = r.result;
      return bytesToB64(new Uint8Array(lg.buffer, lg.byteOffset, lg.byteLength));
    }
    // 處理一個請求檔的內容（JSON 字串），回傳回應檔的內容（JSON 字串）；永不丟例外
    async function handleReq(text) {
      try {
        const req = JSON.parse(text);
        return JSON.stringify({ logits: await compute(req.hidden) });
      } catch (e) {
        stats.errors++; stats.lastError = String((e && e.message) || e);
        return JSON.stringify({ error: stats.lastError });
      }
    }
    return { load, compute, handleReq, stats };
  }

  // 輪詢信箱：io = { list():Promise<string[]>（檔名）, read(name):Promise<string|null>, write(name,text):Promise<void>, remove(name):Promise<void> }
  // runId 限定只處理這次生成的請求；回傳 { stop() }。請求檔寫到一半（JSON 壞掉）時等下一輪，不回錯誤。
  function startPolling(service, io, runId, intervalMs) {
    let stopped = false, busy = false;
    // runId 為 null：不限定這次生成（渲染程序看不到主程序的請求 id；一次只跑一個生成，所以只會有一組請求）
    const re = runId == null ? /^head-[\w-]+-(\d+)\.req$/ : new RegExp('^head-' + String(runId).replace(/[^\w-]/g, '') + '-(\\d+)\\.req$');
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const names = (await io.list()).filter((n) => re.test(n));
        for (const n of names) {
          const text = await io.read(n);
          if (!text) continue;
          try { JSON.parse(text); } catch (_) { continue; }
          const out = await service.handleReq(text);
          const base = n.slice(0, -4);
          // 有改名（rename）就先寫 .res.tmp 再改名（原子）；沒有就直接寫 .res（主程序讀到寫一半的 JSON 會等下一輪）
          if (io.rename) { await io.write(base + '.res.tmp', out); await io.rename(base + '.res.tmp', base + '.res'); }
          else await io.write(base + '.res', out);
          await io.remove(n);
        }
      } catch (_) { /* 下一輪再試 */ }
      busy = false;
    };
    const timer = setInterval(tick, intervalMs || 3);
    return { stop() { stopped = true; clearInterval(timer); } };
  }

  return { createHeadService, startPolling, b64ToBytes, bytesToB64, CHUNK_BYTES };
});
