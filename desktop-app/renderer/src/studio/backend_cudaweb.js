'use strict';
// cudaweb：WebGPU 優先、WebGL2 次之、純 JS 最後的 GPU 運算後端（DESIGN.webgpu-cuda.md §7.1）。
// 目前狀態：運算核心已可用；JS 訓練器（LoRA 小型 transformer）的矩陣乘已接上非同步變體（lora_ref_train.js 的 lossAndGradsAsync）。
// 只涵蓋 JS 訓練器；llm_scratch.py 走它自己的 torch 路徑，不經過這裡。
// probe 依真實能力回報：有可用的 WebGPU 裝置或 WebGL2 上下文、且拿得到運算執行期時才 available:true，reason 寫明實際層。
const B = require('./backend_core.js');
const T = require('./lora_ref_train.js');

function layerText(bi) {
  const last = bi && bi.last;
  if (!bi || (!bi.deviceReady && !(bi.webgl2 && bi.webgl2.available))) return null;
  const path = bi.deviceReady ? 'WebGPU（T1）' : 'WebGL2（T3）';
  return '能力檔 ' + (bi.profile || '未知') + '，目前走 ' + path + (last ? '，最後一次呼叫的層為 ' + last.layer : '');
}

// o.getRuntime()：回傳 cudaweb 執行期（渲染行程才有；沒有就回傳 null）。o.envProbe：可選，直接回傳 backendInfo。
function createCudawebBackend(o) {
  const id = 'cudaweb';
  const opts = o || {};
  function runtime() {
    try { return opts.getRuntime ? opts.getRuntime() : null; } catch (e) { return null; }
  }
  let st = null; // { m, adam, lr, be }
  function need() {
    const rt = runtime();
    if (!rt) throw new Error('cudaweb 不可用：此執行環境沒有 GPU 運算執行期（需要在渲染行程裡執行）');
    return rt;
  }
  return {
    id, planned: false, capabilities: { perStep: true, run: false, fp16: false }, kinds: B.KIND_BACKENDS,
    async probe(ctx) {
      let bi = null;
      try {
        if (opts.envProbe) bi = await opts.envProbe();
        else { const rt = runtime(); bi = rt ? await rt.backendInfo() : null; }
      } catch (e) { bi = null; }
      if (!bi) return B.probeResult(false, '此執行環境沒有 GPU 運算核心（cudaweb 需要在有 WebGPU 或 WebGL2 的渲染行程裡執行）', { name: id }, { backend: id });
      const lt = layerText(bi);
      const ok = !!lt;
      const why = ok ? '可用（' + lt + '）；訓練熱點（矩陣乘）已接入，LayerNorm、softmax、AdamW 仍在 CPU' : '沒有可用的 WebGPU 裝置或 WebGL2 上下文（' + (bi.probeReason || (bi.webgl2 && bi.webgl2.reason) || '原因未知') + '）';
      return B.probeResult(ok, why, { name: id }, { backend: id, profile: bi.profile || null, lastLayer: bi.last ? bi.last.layer : null });
    },
    async benchmark() { return { ok: false, reason: '尚未做效能基準（數值一致性已由 lora_ref_train_async_test.js 驗證）', numericCheck: { pass: false, failed: ['未做效能基準'] } }; },
    async init(spec) {
      const rt = need();
      const s = spec || {};
      const m = T.makeModel(s.cfg, s.seed || 1);
      st = { m, adam: T.adamInit(m), lr: s.lr || 0.01, be: T.cudawebMatmulBackend(rt) };
      return { ok: true, layer: null };
    },
    async step(tokens) {
      if (!st) throw new Error('cudaweb：尚未 init');
      const r = await T.lossAndGradsAsync(st.m, tokens, { backend: st.be });
      T.adamStep(st.m, r.grads, st.adam, st.lr);
      return { loss: r.loss, layer: st.be.layer, reason: st.be.reason };
    },
    async evalLoss(tokens) {
      if (!st) throw new Error('cudaweb：尚未 init');
      const r = await T.lossAndGradsAsync(st.m, tokens, { backend: st.be, noGrad: true });
      return { loss: r.loss, layer: st.be.layer, reason: st.be.reason };
    },
    async saveCheckpoint() {
      if (!st) throw new Error('cudaweb：尚未 init');
      const lora = st.m.lora.map((lo) => { const o2 = {}; for (const k of ['q', 'k', 'v', 'o']) o2[k] = { A: Array.from(lo[k].A), B: Array.from(lo[k].B) }; return o2; });
      return { cfg: st.m.cfg, lora, t: st.adam.t };
    },
    async loadCheckpoint(ck) {
      if (!st) throw new Error('cudaweb：尚未 init');
      st.m.lora.forEach((lo, l) => { for (const k of ['q', 'k', 'v', 'o']) { lo[k].A.set(ck.lora[l][k].A); lo[k].B.set(ck.lora[l][k].B); } });
      st.adam.t = ck.t || 0;
      return { ok: true };
    },
    async dispose() { st = null; },
  };
}

module.exports = { createCudawebBackend, layerText };
