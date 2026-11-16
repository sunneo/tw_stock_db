'use strict';
// 把網頁版 q4f16 第 0 層 MLP（gate／up／down）的 MatMulNBits 權重取出成原始檔，供瀏覽器驗證頁讀取：
//   <名稱>.q4.bin（uint8，N×nBlocks×16）、<名稱>.scales.f32.bin（float32 小端序，N×nBlocks，由 fp16 轉成 f32）、<名稱>.meta.json（K、N）。
// 只讀取，不改模型。用法：node scripts/eval/cudaweb_q4_extract.js <q4f16 模型路徑> <輸出資料夾>
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const [q4Path, outDir] = [process.argv[2], process.argv[3]];
if (!q4Path || !outDir) { console.error('用法：node scripts/eval/cudaweb_q4_extract.js <q4f16 模型路徑> <輸出資料夾>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
function f16ToF32(u16) {
  const s = (u16 >> 15) & 1, e = (u16 >> 10) & 31, f = u16 & 1023;
  let v;
  if (e === 0) v = f * Math.pow(2, -24); else if (e === 31) v = f ? NaN : Infinity; else v = (1 + f / 1024) * Math.pow(2, e - 15);
  return s ? -v : v;
}
const m = lite.parseModel(fs.readFileSync(q4Path));
const specs = [
  { name: 'gate', base: 'model.layers.0.mlp.gate_proj.MatMul.weight', K: 1024, N: 3072 },
  { name: 'up', base: 'model.layers.0.mlp.up_proj.MatMul.weight', K: 1024, N: 3072 },
  { name: 'down', base: 'model.layers.0.mlp.down_proj.MatMul.weight', K: 3072, N: 1024 },
];
for (const sp of specs) {
  const q = lite.tensorBytes(m, sp.base + '_Q4');
  fs.writeFileSync(path.join(outDir, sp.name + '.q4.bin'), q);
  const sb = lite.tensorBytes(m, sp.base + '_scales');
  const n = sb.length / 2, f = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) f.writeFloatLE(f16ToF32(sb[2 * i] | (sb[2 * i + 1] << 8)), i * 4);
  fs.writeFileSync(path.join(outDir, sp.name + '.scales.f32.bin'), f);
  fs.writeFileSync(path.join(outDir, sp.name + '.meta.json'), JSON.stringify({ K: sp.K, N: sp.N, nBlocks: sp.K / 32, qBytes: q.length, scales: n }));
  console.log(sp.name, 'q4 位元組', q.length, '，scales 個數', n);
}
