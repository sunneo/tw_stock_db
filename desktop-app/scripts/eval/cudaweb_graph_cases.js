'use strict';
// 整張圖端到端驗證的輸入案例（cudaweb_graph_check.js 與 cudaweb_graph_browser.js 共用）。feeds(ort) → { 輸入名: ort.Tensor }。
const CASES = {
  yamnet: { minMacs: 1 << 16, argmax: { name: 'output_0', cols: 521 }, feeds: (ort) => { const n = Number(process.env.N) || 16000 * 3, w = new Float32Array(n); let s = 1; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; w[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / 16000) + 0.2 * Math.sin(2 * Math.PI * 1320 * i / 16000) + 0.05 * (s / 4294967296 - 0.5); } return { waveform: new ort.Tensor('float32', w, [n]) }; } },
  demucs: { minMacs: 1 << 18, tolRelL2: 1e-3, feeds: (ort) => { const SEG = 343980, w = new Float32Array(2 * SEG); let s = 7; for (let i = 0; i < SEG; i++) { s = (s * 1664525 + 1013904223) >>> 0; const t = i / 44100, kick = Math.exp(-(t % 0.5) * 18) * Math.sin(2 * Math.PI * 60 * t), bass = 0.3 * Math.sin(2 * Math.PI * 110 * t), mel = 0.2 * Math.sin(2 * Math.PI * (440 + 110 * Math.floor(t * 2) % 5) * t), nz = 0.02 * (s / 4294967296 - 0.5); w[i] = kick + bass + mel + nz; w[SEG + i] = 0.9 * kick + bass - 0.8 * mel + nz; } return { mix: new ort.Tensor('float32', w, [1, 2, SEG]) }; } },
};
// tolRelL2：整圖相對 L2 門檻（沒給＝要最大相對 < 1e-3）。int8 動態量化模型（SDXS 文字編碼器、unet）的第一個分歧是某個 DynamicQuantizeLinear 的進位翻轉（cudaweb_graph_bisect.js 查過），
// 之後放大成整圖約 5e-2 的雜訊，不是算子語意錯誤；門檻放在同量級。
// SDXS 三段（CPU int8 版）：feeds(ort, modelPath) 可為 async；unet 的文字向量用同資料夾 text_encoder 在 ORT 算出（與產品流程一致）
const gauss = (seed, n) => { const o = new Float32Array(n); let s = seed >>> 0 || 1; const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 1) / 4294967297; }; for (let i = 0; i < n; i += 2) { const r = Math.sqrt(-2 * Math.log(u())), t = 2 * Math.PI * u(); o[i] = r * Math.cos(t); if (i + 1 < n) o[i + 1] = r * Math.sin(t); } return o; };
const sdIds = () => { const a = new Int32Array(77).fill(49407); const ids = [49406, 320, 1125, 539, 320, 2368, 4558, 525, 518, 3043, 49407]; ids.forEach((x, i) => { a[i] = x; }); return a; };
CASES.sdxs_te = { minMacs: 1 << 16, tolRelL2: 0.1, feeds: (ort) => ({ input_ids: new ort.Tensor('int32', sdIds(), [1, 77]) }) };
CASES.sdxs_vae = { minMacs: 1 << 16, feeds: (ort) => ({ latent_sample: new ort.Tensor('float32', gauss(11, 4 * 64 * 64), [1, 4, 64, 64]) }) };
CASES.sdxs_unet = { minMacs: 1 << 16, tolRelL2: 0.15, feeds: async (ort, modelPath) => {
  const te = await ort.InferenceSession.create(require('path').join(require('path').dirname(modelPath), 'text_encoder.onnx'), { executionProviders: ['cpu'] });
  const hs = (await te.run({ input_ids: new ort.Tensor('int32', sdIds(), [1, 77]) })).last_hidden_state, x = gauss(5, 4 * 64 * 64); for (let i = 0; i < x.length; i++) x[i] *= 14.6146 / Math.sqrt(14.6146 * 14.6146 + 1);
  return { sample: new ort.Tensor('float32', x, [1, 4, 64, 64]), timestep: new ort.Tensor('float32', Float32Array.from([999]), [1]), encoder_hidden_states: hs }; } };
// Kokoro（q8，TTS）：input_ids／style／speed → waveform。ids 是固定的音素詞元序列（與 cudaweb_node_dump.js 的 kokoro preset 相同），style 由 KOKORO_VOICE（真語音包 .bin）取一列，沒給就用確定性合成值。
CASES.kokoro = { minMacs: 1 << 18, tolRelL2: 0.5, feeds: (ort) => {
  const fs = require('fs'), ids = [0, 50, 83, 54, 156, 57, 135, 63, 16, 156, 70, 156, 85, 123, 16, 0], st = new Float32Array(256); let s = 5; for (let i = 0; i < 256; i++) { s = (s * 1664525 + 1013904223) >>> 0; st[i] = (s / 4294967296 - 0.5) * 0.4; }
  if (process.env.KOKORO_VOICE) { const v = fs.readFileSync(process.env.KOKORO_VOICE), f = new Float32Array(v.buffer, v.byteOffset, v.length / 4), row = Math.min(ids.length, 509) - 2; st.set(f.subarray(row * 256, row * 256 + 256)); }
  return { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), style: new ort.Tensor('float32', st, [1, 256]), speed: new ort.Tensor('float32', Float32Array.from([1]), [1]) }; } };
module.exports = { CASES };
