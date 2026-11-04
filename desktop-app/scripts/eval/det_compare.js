// 確定性模式比對（node）：原生（native-det-penalty.json，gen = 產品的 deterministic textGenParams）對 WASM（deterministic:true，同一套參數）。
// (1) 文字：完全相同的題數、第一個分歧的字元位置（以 WASM 文字為準）；
// (2) 第一步 logits：兩邊都套用同一個重複懲罰（以 prompt ids 為已出現的 token），比 top-1、top-5 重疊、餘弦相似度；
// (3) 準確率：8 封閉題的答對數（標準答案）。
// 結果寫入 test-reports/native-vs-wasm/det-compare.json。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyRepetitionPenalty } = require('../../nr-gen-params.js');
const TEMP = process.env.TEMP || os.tmpdir();
const R = path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm');
const native = JSON.parse(fs.readFileSync(path.join(R, 'native-det-penalty.json'), 'utf8'));
const wasmRows = fs.readFileSync(path.join(R, 'wasm-threads1.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const wById = new Map(wasmRows.map((r) => [r.id, r]));
const firstNat = JSON.parse(fs.readFileSync(path.join(TEMP, 'nvw-out', 'first-native.json'), 'utf8'));
const firstWasm = JSON.parse(fs.readFileSync(path.join(TEMP, 'nvw-out', 'first-wasm.json'), 'utf8'));
const fwById = new Map(firstWasm.rows.map((r) => [r.id, r]));
const f32 = (b64) => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
function top(arr, k) { const idx = Array.from(arr.keys()); idx.sort((a, b) => arr[b] - arr[a]); return idx.slice(0, k); }
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }
const GEN_REP = native.gen.repetition_penalty;

// (1) 文字
const textRows = native.rows.map((n) => {
    const w = wById.get(n.id);
    const wt = w.text == null ? '' : String(w.text);
    let d = -1; const m = Math.min(n.text.length, wt.length);
    for (let i = 0; i < m; i++) if (n.text[i] !== wt[i]) { d = i; break; }
    if (d < 0 && n.text.length !== wt.length) d = m;
    return { id: n.id, same: n.text === wt, first_diff_char: n.text === wt ? null : d, native: n.text, wasm: wt };
});
const strip = (s) => String(s).replace(/\s+/g, '');
// (2) 第一步 logits（同一重複懲罰）
const logitRows = firstNat.map((n) => {
    const a = f32(n.logits_b64), b = f32(fwById.get(n.id).logits_b64);
    applyRepetitionPenalty(a, n.ids, GEN_REP);
    applyRepetitionPenalty(b, n.ids, GEN_REP);
    const ta = top(a, 5), tb = top(b, 5);
    return { id: n.id, top1_same: ta[0] === tb[0], top5_overlap: ta.filter((x) => tb.indexOf(x) >= 0).length, cosine: Math.round(cosine(a, b) * 1e6) / 1e6 };
});
// (3) 準確率（8 封閉題）
const ans = (() => {
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const r = rng(20261104); const out = [];
    for (let i = 0; i < 8; i++) {
        let a0; const k = i % 4;
        if (k === 0) { const a = 11 + Math.floor(r() * 38), b = 11 + Math.floor(r() * 38); a0 = a * b; }
        else if (k === 1) { const a = 100 + Math.floor(r() * 900), b = 7 + Math.floor(r() * 13); a0 = a % b; }
        else if (k === 2) { let x = 1 + Math.floor(r() * 5); for (let j = 0; j < 3; j++) x = 2 * x + 1; a0 = 2 * x + 1; }
        else { const a = 2 + Math.floor(r() * 8), b = 2 + Math.floor(r() * 8), c = 2 + Math.floor(r() * 8), d = 1 + Math.floor(r() * 9); a0 = (a + b) * c - d; }
        const opts = [a0]; while (opts.length < 4) { const cand = a0 + (Math.floor(r() * 19) - 9); if (cand > 0 && opts.indexOf(cand) < 0) opts.push(cand); }
        for (let j = opts.length - 1; j > 0; j--) { const m = Math.floor(r() * (j + 1)); [opts[j], opts[m]] = [opts[m], opts[j]]; }
        out.push('ABCD'[opts.indexOf(a0)]);
    }
    return out;
})();
const letter = (t) => { const m = String(t || '').match(/\{[^{}]*\}/); if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o.answer === 'string') return o.answer.trim().toUpperCase().slice(0, 1); } catch (_) { /* */ } } const l = String(t || '').match(/\b([A-D])\b/); return l ? l[1] : null; };
const closedNative = native.rows.filter((r) => r.group === 'closed').map((r) => ({ id: r.id, ok: letter(r.text) === ans[+r.id.slice(1)] }));
const closedWasm = wasmRows.filter((r) => r.group === 'closed').map((r) => ({ id: r.id, ok: letter(r.text) === ans[+r.id.slice(1)] }));
const out = {
    note: '確定性模式：native gen = {do_sample:false, repetition_penalty:1.08}（產品 textGenParams，deterministic:true）；WASM 同設定（wasm-threads1.jsonl）。',
    text: { n: textRows.length, exact_same: textRows.filter((r) => r.same).length, same_ignoring_whitespace: textRows.filter((r) => strip(r.native) === strip(r.wasm)).length, rows: textRows },
    first_step_with_penalty: { n: logitRows.length, top1_same: logitRows.filter((r) => r.top1_same).length, top5_overlap_mean: Math.round(100 * logitRows.reduce((x, r) => x + r.top5_overlap, 0) / logitRows.length) / 100, cosine_mean: Math.round(1e6 * logitRows.reduce((x, r) => x + r.cosine, 0) / logitRows.length) / 1e6, cosine_min: Math.min(...logitRows.map((r) => r.cosine)), rows: logitRows },
    accuracy_closed8: { native: closedNative.filter((r) => r.ok).length + '/8', wasm: closedWasm.filter((r) => r.ok).length + '/8', answers: ans.join('') },
};
fs.writeFileSync(path.join(R, 'det-compare.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ text: { n: out.text.n, exact: out.text.exact_same, ignoring_ws: out.text.same_ignoring_whitespace }, first_step_with_penalty: { top1: out.first_step_with_penalty.top1_same + '/16', top5: out.first_step_with_penalty.top5_overlap_mean, cos_mean: out.first_step_with_penalty.cosine_mean, cos_min: out.first_step_with_penalty.cosine_min }, accuracy: out.accuracy_closed8 }));
