'use strict';
// cudaweb：WebGPU 優先、WebGL2 次之、純 JS 最後的 GPU 運算後端（DESIGN.webgpu-cuda.md §7.1）。
// 目前狀態：運算核心（向量加、矩陣乘、歸約、第二階段的 axpy／scal／dot／nrm2／gemv）已可用，但訓練熱點（LoRA、AdamW、注意力）尚未接入。
// 所以 probe 回報 available:false，reason 寫明目前實際走哪一層；訓練方法一律拒絕並說明，不假裝可以訓練。
const B = require('./backend_core.js');

function layerText(bi) {
  const last = bi && bi.last;
  if (!bi || (!bi.deviceReady && !(bi.webgl2 && bi.webgl2.available))) return null;
  const path = bi.deviceReady ? 'WebGPU（T1）' : 'WebGL2（T3）';
  return '能力檔 ' + (bi.profile || '未知') + '，目前走 ' + path + (last ? '，最後一次呼叫的層為 ' + last.layer : '');
}

function createCudawebBackend(o) {
  const id = 'cudaweb';
  const no = async () => { throw new Error('cudaweb 尚未接入訓練熱點（LoRA、AdamW、注意力仍走原本路徑）'); };
  return {
    id, planned: false, capabilities: { perStep: true, run: false, fp16: false }, kinds: B.KIND_BACKENDS,
    async probe(ctx) {
      // 運算核心只在渲染行程（有 WebGPU／WebGL2）或 Python 模擬器裡存在；主行程沒有 GPU 上下文，o.envProbe 由呼叫端注入
      let bi = null;
      try { bi = o && o.envProbe ? await o.envProbe() : null; } catch (e) { bi = null; }
      if (!bi) return B.probeResult(false, '此執行環境沒有 GPU 運算核心（cudaweb 需要在有 WebGPU 或 WebGL2 的渲染行程裡執行）', { name: id }, { backend: id });
      const lt = layerText(bi);
      const why = lt ? '核心已可用（' + lt + '），但訓練熱點尚未接入，目前仍走原本路徑' : '沒有可用的 WebGPU 裝置或 WebGL2 上下文（' + (bi.probeReason || (bi.webgl2 && bi.webgl2.reason) || '原因未知') + '）';
      return B.probeResult(false, why, { name: id }, { backend: id, profile: bi.profile || null, lastLayer: bi.last ? bi.last.layer : null });
    },
    async benchmark() { return { ok: false, reason: '訓練熱點尚未接入', numericCheck: { pass: false, failed: ['尚未接入訓練熱點'] } }; },
    init: no, step: no, evalLoss: no, saveCheckpoint: no, loadCheckpoint: no,
    async dispose() {},
  };
}

module.exports = { createCudawebBackend, layerText };
