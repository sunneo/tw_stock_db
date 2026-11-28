'use strict';
// cudaweb 全參數訓練的運算覆蓋（設計 §4f：全有或全無）。
// 每個運算標明「是否在 GPU 上執行」；只要有一個不在 GPU，覆蓋就不完整，probe 必須回報缺項，不可悄悄退回 CPU。
// 資料來源：INVENTORY.cudaweb-training.md 與 full_param_train.js 的實際路徑（2026-11-28）。
const DENSE_FULL_PARAM_OPS = [
  { name: '矩陣乘（前向與反向，含轉置）', gpu: true, where: 'rt.matmul（mm_ops，T1 WebGPU）' },
  { name: 'RMSNorm 前向', gpu: true, where: 'nn_ops.rmsnorm（gpuOpsFrom）' },
  { name: 'RMSNorm 反向（含增益梯度）', gpu: false, where: 'full_param_train.js rmsBwd（CPU f64）' },
  { name: 'softmax 前向（注意力）', gpu: true, where: 'nn_ops.softmax' },
  { name: 'softmax 反向（注意力）', gpu: false, where: '注意力反向迴圈（CPU）' },
  { name: 'SiLU 前向', gpu: true, where: 'nn_ops.silu' },
  { name: 'SiLU 反向（閘控）', gpu: false, where: 'backward 內的逐元素迴圈（CPU）' },
  { name: 'RoPE 前向', gpu: true, where: 'nn_ops.rope（經純資料排列）' },
  { name: 'RoPE 反向', gpu: true, where: 'nn_ops.rope dir=-1（經純資料排列）' },
  { name: '注意力 QKᵀ 與 PV 小矩陣乘', gpu: false, where: '前向與反向的每頭迴圈（CPU）' },
  { name: '嵌入查表與嵌入梯度（scatter-add）', gpu: false, where: 'CPU 陣列索引' },
  { name: '交叉熵前向與反向', gpu: false, where: 'CPU（nn_ops.crossEntropy 有 GPU 版，訓練器未接）' },
  { name: 'AdamW 更新', gpu: true, where: 'nn_ops.adamw' },
  { name: '梯度範數與裁剪', gpu: false, where: 'clipGrads（CPU）' },
];
const COVERAGE = { 'dense-full-param': DENSE_FULL_PARAM_OPS };

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
module.exports = { DENSE_FULL_PARAM_OPS, coverageFor, reasonFor };
