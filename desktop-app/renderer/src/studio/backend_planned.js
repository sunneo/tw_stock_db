'use strict';
// webgpu／directml／vulkan：先登錄為「尚未實作」，probe 回 §5.2 的具體阻礙，不假裝可用。所有操作方法都拒絕並說明原因。
const B = require('./backend_core.js');

const BLOCKERS = {
  webgpu: { reason: 'WebGPU 的 LoRA 反向傳播引擎尚未實作：onnxruntime-web 推論套件不含訓練，需自寫 WGSL 前向／反向（階段 4 研究，單層梯度對拍通過前不點亮）', unblock: '階段 4 (a)→(b)→(c) 依序通過：單層梯度 ≤1e-3、區塊 ≤5e-3、全模型 20 步 loss 與 cpu-py 差 ≤2%' },
  directml: { reason: 'DirectML 尚未實作：onnxruntime 的 DirectML 只做推論，且 qwen3-0.6b 在 onnxruntime-node 1.22.0／1.31.1 於 SkipSimplifiedLayerNormalization 節點 E_INVALIDARG；torch-directml 能否跑 LoRA 反向未驗證', unblock: '在隔離資料夾實測 torch-directml 跑通 train_lora.py 前向／反向且與 CPU 數值對得上（階段 5，下載前需使用者同意）' },
  vulkan: { reason: 'Vulkan 後端尚未實作：llama.cpp 的 Vulkan LoRA 微調是否進主線、是否支援 Qwen3、所需算子（OUT_PROD、OPT_STEP_ADAMW）是否有 Vulkan 實作都未驗證，且輸出的 GGUF adapter 還沒有轉成 safetensors／ONNX LoRA 的轉換器', unblock: '讀上游原始碼與 PR 確認算子、在隔離資料夾跑通一次小訓練並與 cpu-py 對拍（階段 5，下載前需使用者同意）' },
};

function createPlannedBackend(id, o) {
  const bl = BLOCKERS[id]; if (!bl) throw new Error('不是登錄中的規劃後端：' + id);
  const no = async () => { throw new Error(id + ' 尚未實作：' + bl.reason); };
  return {
    id, planned: true, blocker: bl, capabilities: { perStep: true, run: false, fp16: true },
    async probe(ctx) {
      // 環境偵測可由呼叫端注入（例如瀏覽器有無 navigator.gpu），僅補充到 device，不改變「尚未實作」的結論
      let env = null; try { env = o && o.envProbe ? await o.envProbe(id, ctx) : null; } catch (e) {}
      return B.probeResult(false, bl.reason, { name: (env && env.name) || '', vendor: (env && env.vendor) || '' }, Object.assign({ backend: id, engine_version: 'not-implemented' }, env && env.fingerprint));
    },
    async benchmark() { return { ok: false, reason: bl.reason, numericCheck: { pass: false, failed: ['尚未實作'] } }; },
    init: no, step: no, evalLoss: no, saveCheckpoint: no, loadCheckpoint: no,
    async dispose() {},
  };
}
const createWebgpuBackend = (o) => createPlannedBackend('webgpu', o), createDirectmlBackend = (o) => createPlannedBackend('directml', o), createVulkanBackend = (o) => createPlannedBackend('vulkan', o);

module.exports = { BLOCKERS, createPlannedBackend, createWebgpuBackend, createDirectmlBackend, createVulkanBackend };
