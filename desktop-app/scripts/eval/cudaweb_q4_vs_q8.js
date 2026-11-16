'use strict';
// 第 0 層 MLP（gate／up／down）：網頁版 q4f16 的 MatMulNBits 權重（CPU 參考版反量化計算）對本機 q8 模型的權重，
// 用同一個輸入向量比較輸出。注意：這不是「同一組權重」的位元級對拍（q4 與 q8 是兩次不同的量化），
// 所以預期差距是量化雜訊的量級；用來確認佈局（nibble 順序、block 分組、scale 位置）正確。
// 對照組：刻意把 nibble 順序對調，誤差應該大很多，證明比較有鑑別力。
// 用法：node scripts/eval/cudaweb_q4_vs_q8.js <q4f16 模型路徑>
const fs = require('fs'), path = require('path'), os = require('os');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const R = require('../../renderer/src/gpu/matmulnbits_ref.js');
const q4Path = process.argv[2];
if (!q4Path) { console.error('用法：node scripts/eval/cudaweb_q4_vs_q8.js <q4f16 模型路徑>'); process.exit(2); }
const q8Path = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');

// fp16 → f32（小端序，IEEE 754 半精度）
function f16ToF32(u16) {
  const s = (u16 >> 15) & 1, e = (u16 >> 10) & 31, f = u16 & 1023;
  let v;
  if (e === 0) v = f * Math.pow(2, -24);
  else if (e === 31) v = f ? NaN : Infinity;
  else v = (1 + f / 1024) * Math.pow(2, e - 15);
  return s ? -v : v;
}
function scalesF32(bytes) {
  const n = bytes.length / 2, o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = f16ToF32(bytes[2 * i] | (bytes[2 * i + 1] << 8));
  return o;
}
// 對調 nibble：每個位元組的高低 4 位元互換（用來證明比較會抓到佈局錯誤）
function swapNibbles(B) { const o = new Uint8Array(B.length); for (let i = 0; i < B.length; i++) o[i] = ((B[i] & 15) << 4) | (B[i] >> 4); return o; }

const q4 = lite.parseModel(fs.readFileSync(q4Path));
const q8 = lite.parseModel(fs.readFileSync(q8Path));
const u8 = (m, n) => { const b = lite.tensorBytes(m, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };

// 固定輸入（確定性亂數，與 q4／q8 無關）
let seed = 4242; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };

const specs = [
  { name: 'gate', q4: 'model.layers.0.mlp.gate_proj.MatMul.weight', q8: 'model.layers.0.mlp.gate_proj.MatMul.weight_', K: 1024, N: 3072 },
  { name: 'up', q4: 'model.layers.0.mlp.up_proj.MatMul.weight', q8: 'model.layers.0.mlp.up_proj.MatMul.weight_', K: 1024, N: 3072 },
  { name: 'down', q4: 'model.layers.0.mlp.down_proj.MatMul.weight', q8: 'model.layers.0.mlp.down_proj.MatMul.weight_', K: 3072, N: 1024 },
];

const rows = [];
for (const sp of specs) {
  const { K, N } = sp;
  const Bq4 = u8(q4, sp.q4 + '_Q4');
  const sc4 = scalesF32(lite.tensorBytes(q4, sp.q4 + '_scales'));
  // q8 權重：[K, N]，反量化 w[n,k] = (W[k*N+n] − zp) × scale
  const W8 = u8(q8, sp.q8 + 'quantized'), zp8 = lite.scalar(q8, sp.q8 + 'zero_point'), sc8 = lite.scalar(q8, sp.q8 + 'scale');
  if (W8.length !== K * N) throw new Error(sp.name + '：q8 權重長度 ' + W8.length + ' 與 K×N 不符');
  const w8 = new Float32Array(N * K);
  for (let n = 0; n < N; n++) for (let k = 0; k < K; k++) w8[n * K + k] = (W8[k * N + n] - zp8) * sc8;

  const x = new Float32Array(K); for (let i = 0; i < K; i++) x[i] = rnd();
  // q8 參考輸出
  const y8 = new Float32Array(N);
  for (let n = 0; n < N; n++) { let acc = 0; for (let k = 0; k < K; k++) acc += x[k] * w8[n * K + k]; y8[n] = acc; }
  const maxRef = Math.max(...y8.map(Math.abs));
  const relOf = (y) => { let d = 0; for (let i = 0; i < N; i++) d = Math.max(d, Math.abs(y[i] - y8[i])); return d / (maxRef || 1); };
  const y4 = R.matmulNBitsRef(x, 1, K, Bq4, sc4, N);
  const y4swap = R.matmulNBitsRef(x, 1, K, swapNibbles(Bq4), sc4, N);
  rows.push({ 層: sp.name, K, N, 形狀: [N, R.nBlocksOf(K), 16].join('×'), q4對q8相對差: relOf(y4), 對調nibble對照: relOf(y4swap), 通過: relOf(y4) < 0.1 && relOf(y4swap) > 3 * relOf(y4) });
}
const pass = rows.every((r) => r.通過);
const result = { q4檔: q4Path, 說明: '相對差以 max|Δy|/max|y8| 計；q4 與 q8 是兩次不同量化，預期為量化雜訊量級；對調 nibble 應明顯更大。', 結果: rows, pass };
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(os.tmpdir(), 'cudaweb_q4_vs_q8.result.json'), JSON.stringify(result, null, 1));
process.exitCode = pass ? 0 : 1;
