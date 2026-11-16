'use strict';
// 網頁版 Qwen3 q4f16 的第 0 層 MLP（gate／up／down）MatMulNBits 節點與權重的中繼資料探查（只讀，不改權重）。
// 用法：node scripts/eval/cudaweb_q4_probe.js <模型路徑>
const fs = require('fs');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const p = process.argv[2];
if (!p) { console.error('用法：node scripts/eval/cudaweb_q4_probe.js <模型路徑>'); process.exit(2); }
const m = lite.parseModel(fs.readFileSync(p));
const pick = m.nodes.filter((n) => n.op === 'MatMulNBits' && /layers\.0\/mlp/.test(n.name || n.outputs[0] || ''));
const out = { nodes: [] };
for (const n of pick) {
  const attrs = {};
  for (const k of Object.keys(n.attrs)) { const a = n.attrs[k]; attrs[k] = a.i !== undefined ? a.i : (a.f !== undefined ? a.f : a.s !== undefined ? a.s : null); }
  const inits = {};
  for (const inp of n.inputs) {
    const t = m.inits[inp];
    if (t) inits[inp] = { dims: t.dims, dtype: t.dtype || t.data_type || null, rawBytes: t.raw ? t.raw[1] - t.raw[0] : null };
  }
  out.nodes.push({ name: n.name, outputs: n.outputs, inputs: n.inputs, attrs, inits });
}
out.total = m.nodes.length;
console.log(JSON.stringify(out, null, 1));
