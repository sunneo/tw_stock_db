'use strict';
// 可攜量測的共用定義：四個規模（S、M、L、XL）與屋頂線預測。cudaweb 量測與 cpu-py 量測都讀這裡，確保同一組設定。
// 屋頂線（每步）：
//   矩陣乘 FLOPs ＝ 6 · T · Nmat（前向 2·T·Nmat，反向約 2 倍前向；Nmat＝所有權重矩陣的元素數，含輸出頭 V·d）
//   注意力 FLOPs ＝ 12 · T² · d · L（QKᵀ 與 AV 的前向＋反向，未計 softmax）
//   記憶體位元組 ＝ 6 · (參數位元組，f32)（參數、梯度、動量、方差的讀寫的粗估；與 REPORT.full-param-cudaweb-speed.md 相同假設）
//   預測時間 ＝ max(FLOPs ÷ 峰值運算, 位元組 ÷ 頻寬)
// 峰值（使用者指定的本機規格預設值，可用參數覆寫）：GT 720 約 0.3 TFLOPS、頻寬約 14 GB/s；較強的卡請用 --peak-tflops、--bw-gbs 覆寫。
const SIZES = [
  { name: 'S', cfg: { V: 258, d: 32, L: 2, H: 4, kvH: 2, F: 64, T: 12, qkNorm: true } },
  { name: 'M', cfg: { V: 512, d: 128, L: 4, H: 8, kvH: 4, F: 256, T: 64, qkNorm: true } },
  { name: 'L', cfg: { V: 2048, d: 256, L: 4, H: 8, kvH: 4, F: 512, T: 128, qkNorm: true } },
  { name: 'XL', cfg: { V: 2048, d: 512, L: 6, H: 8, kvH: 4, F: 1024, T: 256, qkNorm: true } },
];

// 權重矩陣元素數（與 llm_full 的參數表一致；emb 同時是輸出頭，計一次 FLOPs 用 V·d）
function paramCount(cfg) {
  const d = cfg.d, hd = d / cfg.H, kd = cfg.kvH * hd;
  const perLayer = d * d + d * kd + d * kd + d * d + 3 * d * cfg.F + 2 * d + 2 * hd;
  return cfg.V * d + cfg.L * perLayer + d;
}
function matParamCount(cfg) {
  const d = cfg.d, hd = d / cfg.H, kd = cfg.kvH * hd;
  return cfg.V * d + cfg.L * (d * d + 2 * d * kd + d * d + 3 * d * cfg.F);
}
function roofline(cfg, peak) {
  const T = cfg.T;
  const nmat = matParamCount(cfg);
  const flops = 6 * T * nmat + 12 * T * T * cfg.d * cfg.L;
  const bytes = 6 * 4 * paramCount(cfg);
  const tCompute = flops / (peak.tflops * 1e12) * 1e3;   // ms
  const tMemory = bytes / (peak.gbs * 1e9) * 1e3;        // ms
  return { flops, bytes, msCompute: tCompute, msMemory: tMemory, msRoof: Math.max(tCompute, tMemory), params: paramCount(cfg) };
}

module.exports = { SIZES, paramCount, matParamCount, roofline };
