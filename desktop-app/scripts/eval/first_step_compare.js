// 第一步比對（node）：原生 CPU（first-native.json）與 WASM（first-wasm.json）同一串 ids 的第一步 logits：top-1 是否相同、top-5 重疊、餘弦相似度。
// 結果寫入 test-reports/native-vs-wasm/first-step.json。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP = process.env.TEMP || os.tmpdir();
const nat = JSON.parse(fs.readFileSync(path.join(TEMP, 'nvw-out', 'first-native.json'), 'utf8'));
const wasm = JSON.parse(fs.readFileSync(path.join(TEMP, 'nvw-out', 'first-wasm.json'), 'utf8'));
const wById = new Map(wasm.rows.map((r) => [r.id, r]));
const f32 = (b64) => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
function top(arr, k) { const idx = Array.from(arr.keys()); idx.sort((a, b) => arr[b] - arr[a]); return idx.slice(0, k); }
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }
const rows = [];
for (const n of nat) {
    const w = wById.get(n.id);
    const a = f32(n.logits_b64), b = f32(w.logits_b64);
    const tn = top(a, 5), tw = top(b, 5);
    rows.push({ id: n.id, n_tokens: n.ids.length, top1_same: tn[0] === tw[0], top1_native: tn[0], top1_wasm: tw[0], top5_overlap: tn.filter((x) => tw.indexOf(x) >= 0).length, cosine: Math.round(cosine(a, b) * 1e6) / 1e6 });
}
const s = rows.length;
const summary = {
    n: s,
    top1_same: rows.filter((r) => r.top1_same).length,
    top5_overlap_mean: Math.round(100 * rows.reduce((x, r) => x + r.top5_overlap, 0) / s) / 100,
    cosine_min: Math.min(...rows.map((r) => r.cosine)), cosine_mean: Math.round(1e6 * rows.reduce((x, r) => x + r.cosine, 0) / s) / 1e6,
};
const out = { note: '同一串 token id、第一步（整段預填）、最後位置 logits、無重複懲罰；原生=onnxruntime-node CPU；WASM=transformers.js(cpu q8, wasm)', summary, rows };
fs.writeFileSync(path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'first-step.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(summary));
