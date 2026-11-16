// head_service.js — GPU 版 lm_head 服務（DESIGN.webgpu-cuda.md §7.3）。純 UMD，node 可 require。
// 桌面版：主程序用信箱檔轉來每個詞元的隱藏狀態（head-<runId>-<seq>.req），這裡用 q8lmAuto 算 logits，寫回 head-<runId>-<seq>.res。
// 網頁版：同一份程式在頁面裡直接用（extractLmHead、buildVariant、createHeadService）。
// 原則：只接受 GPU 的結果（T1 WebGPU 或 T3 WebGL2）。兩者都不可用或失敗就丟錯／回 error，由呼叫端退回 ONNX 路徑，
// 原因照實帶回。純 JS 不列入（比 ORT 慢，沒有意義）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./infer_ops.js'), require('./onnx_lite.js'));
  else root.FaHeadService = factory(root.FaInferOps, root.FaOnnxLite);
})(typeof self !== 'undefined' ? self : this, function (inferOps, lite) {
  'use strict';
  const HIDDEN_NODE = '/lm_head/MatMul';

  // 從模型位元組抽出 lm_head：embed_tokens 的 q8 權重（詞表×隱藏，列主序）與參數
  function extractLmHead(modelBytes) {
    const m = lite.parseModel(modelBytes);
    const t = m.inits['model.embed_tokens.weight_quantized'];
    if (!t || t.dims.length !== 2) throw new Error('模型裡沒有 model.embed_tokens.weight_quantized（不是預期的 q8 格式）');
    const W = lite.tensorBytes(m, 'model.embed_tokens.weight_quantized');
    return { W: W, meta: { V: t.dims[0], K: t.dims[1], zp: lite.scalar(m, 'model.embed_tokens.weight_zero_point'), scale: lite.scalar(m, 'model.embed_tokens.weight_scale') } };
  }
  // 隱藏狀態變體圖：移除 /lm_head/MatMul（與它獨占的解碼節點），圖輸出改成 final_norm 的結果；KV 輸出與原圖相同
  function buildVariant(modelBytes, hiddenDim) {
    const m = lite.parseModel(modelBytes);
    const mm = m.nodes.find((n) => n.name === HIDDEN_NODE);
    if (!mm) throw new Error('模型裡沒有 ' + HIDDEN_NODE + ' 節點，無法做隱藏狀態變體');
    const hiddenName = mm.inputs[0];
    const built = lite.buildHiddenStateModel(modelBytes, { dropNodeName: HIDDEN_NODE, replaceOutput: 'logits', hiddenName: hiddenName, hiddenDims: ['batch_size', 'sequence_length', hiddenDim || 1024] });
    return { bytes: built.buf(), hiddenName: hiddenName, removed: built.removed };
  }

  const b64ToBytes = (s) => {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
    const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
  };
  const bytesToB64 = (u8) => {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s);
  };
  const toF32 = (u8) => { const ab = new ArrayBuffer(u8.length); new Uint8Array(ab).set(u8); return new Float32Array(ab); };

  // opts：{ meta:{V,K,zp,scale}, loadWeights:()=>Promise<Uint8Array>（或 weights：直接給位元組）, navigator, gl, ops（測試可注入） }
  // compute(hidden:Float32Array) → Promise<{ logits: Float32Array, layer:'T1'|'T3', ms, reasons }>；失敗丟例外（reasons 帶每層原因）
  function createHeadService(opts) {
    const ops = opts.ops || inferOps;
    let W = null, loading = null;
    const stats = { served: 0, errors: 0, lastMs: 0, lastLayer: '', lastError: '', layers: { T1: 0, T3: 0 } };
    async function load() {
      if (W) return;
      if (!loading) loading = (async () => {
        const w = opts.weights || await opts.loadWeights();
        const m = opts.meta;
        if (w.length !== m.V * m.K) throw new Error('lm_head 權重大小 ' + w.length + ' 與 V×K=' + (m.V * m.K) + ' 不符');
        W = w;
      })();
      try { await loading; } catch (e) { loading = null; throw e; }
    }
    async function computeF32(hidden) {
      const t0 = Date.now();
      await load();
      const m = opts.meta;
      if (hidden.length !== m.K) throw new Error('隱藏狀態長度 ' + hidden.length + '，預期 ' + m.K);
      const r = await ops.q8lmAuto(hidden, W, m.V, m.K, m.zp, m.scale, { navigator: opts.navigator, gl: opts.gl });
      stats.lastLayer = r.info.layer; stats.layers[r.info.layer] = (stats.layers[r.info.layer] || 0) + 1;
      stats.served++; stats.lastMs = Date.now() - t0;
      return { logits: r.result, layer: r.info.layer, ms: stats.lastMs, reasons: r.info.reasons || [] };
    }
    // 桌面版信箱用：hiddenB64 → logits 的 base64；失敗丟例外
    async function compute(hiddenB64) {
      const out = await computeF32(toF32(b64ToBytes(hiddenB64)));
      return bytesToB64(new Uint8Array(out.logits.buffer, out.logits.byteOffset, out.logits.byteLength));
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
    return { load, compute, computeF32, handleReq, stats };
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

  return { createHeadService, startPolling, extractLmHead, buildVariant, b64ToBytes, bytesToB64 };
});
