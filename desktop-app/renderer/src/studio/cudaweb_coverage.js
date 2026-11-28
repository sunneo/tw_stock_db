'use strict';
// cudaweb 全參數訓練的運算覆蓋（設計 §4f：全有或全無）。
// 每個運算標明「是否在 GPU 上執行」；只要有一個不在 GPU，覆蓋就不完整，probe 必須回報缺項，不可悄悄退回 CPU。
// 資料來源：INVENTORY.cudaweb-training.md 與 full_param_train.js 的實際路徑（2026-11-28）。
const DENSE_FULL_PARAM_OPS = [
  // 2026-11-28：以下全部由 gpu/full_param_step_device.js 在 GPU 上執行（真機對 PyTorch 通過：dense 與 gqa_qkn）
  { name: '矩陣乘（前向與反向，含轉置）', gpu: true, where: 'rt.matmul / B.matmul（createBatch）' },
  { name: '嵌入查表與嵌入梯度（one-hot 矩陣乘）', gpu: true, where: 'full_param_step_device.js' },
  { name: 'RMSNorm 前向（含 qk-norm）', gpu: true, where: 'nn_ops 批次 rmsnorm' },
  { name: 'RMSNorm 反向與增益梯度', gpu: true, where: 'TS.WGSL_RMS_BWD＋列加總矩陣乘' },
  { name: 'softmax 前向與反向（注意力內）', gpu: true, where: 'TS.WGSL_ATTN_FWD／WGSL_ATTN_BWD_*' },
  { name: 'SiLU 前向與反向（閘控）', gpu: true, where: 'B.silu／TS.WGSL_MLP_BWD' },
  { name: 'RoPE 前向與反向（rotate-half，經排列矩陣）', gpu: true, where: 'nn_ops 批次 rope＋排列矩陣' },
  { name: '分組查詢擴張與加總', gpu: true, where: '0/1 擴張矩陣（矩陣乘）' },
  { name: '交叉熵前向與反向', gpu: true, where: 'B.crossEntropy' },
  { name: '梯度範數與裁剪', gpu: true, where: 'WGSL_CLIP_COEF＋矩陣乘廣播' },
  { name: 'AdamW 更新', gpu: true, where: 'TF.WGSL_ADAMW_ACCUM（常駐緩衝區）' },
];
// MoE（llm_scratch 的 MoE，行 193–230）：路由 topk、稀疏分派、逐專家矩陣乘、負載平衡損失與其反向，cudaweb 都沒有（P4）
const MOE_FULL_PARAM_OPS = [
  { name: '路由 topk 與重新正規化', gpu: false, where: '未實作' },
  { name: '稀疏分派（gather／index_add）', gpu: false, where: '未實作' },
  { name: '逐專家 SwiGLU 矩陣乘（三維專家參數）', gpu: false, where: '未實作' },
  { name: '負載平衡輔助損失與反向', gpu: false, where: '未實作' },
];
// 推理（思考＋答案）與強化學習（GRPO）：取樣（sample_cached）、群組優勢、策略梯度與可驗證獎勵，cudaweb 都沒有（P5）
const REASONING_GRPO_OPS = [
  { name: '自回歸取樣（sample_cached）', gpu: false, where: '未實作' },
  { name: 'GRPO 策略梯度與群組優勢', gpu: false, where: '未實作' },
];
const COVERAGE = { 'dense-full-param': DENSE_FULL_PARAM_OPS, 'moe-full-param': MOE_FULL_PARAM_OPS, 'reasoning-grpo': REASONING_GRPO_OPS };

// 回傳 { complete, missing:[名稱], onGpu, total }。complete 只有在全部運算都在 GPU 時才為 true。
function coverageFor(kind) {
  const ops = COVERAGE[kind];
  if (!ops) return { complete: false, missing: ['（未知的覆蓋種類：' + kind + '）'], onGpu: 0, total: 0 };
  const missing = ops.filter((o) => !o.gpu).map((o) => o.name);
  return { complete: missing.length === 0, missing, onGpu: ops.length - missing.length, total: ops.length };
}
// 給使用者看的原因（缺項逐一列出；不假裝能跑）
function reasonFor(kind) {
  const c = coverageFor(kind);
  if (c.complete) return '';
  return 'cudaweb 還缺 ' + c.missing.length + ' 項運算在 GPU 上執行（' + c.missing.join('、') + '）；全有或全無，缺任何一項都不啟用，不退回 CPU 假裝是 GPU 訓練。';
}
module.exports = { DENSE_FULL_PARAM_OPS, MOE_FULL_PARAM_OPS, REASONING_GRPO_OPS, coverageFor, reasonFor };
