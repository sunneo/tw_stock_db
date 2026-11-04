// 同版本比對（原生側）：用指定的 onnxruntime-node 版本（環境變數 ORT_MODULE）對同一串 ids 做單次 forward，
// 與 WASM（ORT-web 1.22.0，bisect-wasm-single.json）及 1.31.1（first-native.json）比對：最大絕對誤差、餘弦、top-1。
// 用法：ORT_MODULE=<node_modules\onnxruntime-node 絕對路徑> ORT_TAG=1.22.0 ELECTRON_RUN_AS_NODE=1 electron.exe scripts/eval/bisect_ort_version.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP = process.env.TEMP || os.tmpdir();
const ort = require(process.env.ORT_MODULE);
const TAG = process.env.ORT_TAG || 'unknown';
const MODEL = path.join(TEMP, 'ort-node-test', 'models', 'qwen3-0.6b-cpu.onnx');
const NV = path.join(TEMP, 'nvw-out');
const native = JSON.parse(fs.readFileSync(path.join(NV, 'first-native.json'), 'utf8'));
const wasmRows = new Map(JSON.parse(fs.readFileSync(path.join(NV, 'bisect-wasm-single.json'), 'utf8')).rows.map((r) => [r.id, r]));
const ref131 = native.map((r) => r.logits_b64);
const f32 = (b64) => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const top1 = (a) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };
(async () => {
    const sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'], intraOpNumThreads: 4 });
    const rows = [];
    for (const r of native) {
        const n = r.ids.length; const f = {};
        f.input_ids = new ort.Tensor('int64', BigInt64Array.from(r.ids.map(BigInt)), [1, n]);
        f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
        f.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
        for (const name of sess.inputNames) if (name.indexOf('past_key_values.') === 0) f[name] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
        const out = await sess.run(f);
        const V = out.logits.dims[2], last = (n - 1) * V;
        const a = Float32Array.from(out.logits.data.subarray(last, last + V));
        const w = f32(wasmRows.get(r.id).logits_b64), b131 = f32(ref131[rows.length]);
        let mx = 0; for (let i = 0; i < V; i++) mx = Math.max(mx, Math.abs(a[i] - w[i]));
        rows.push({ id: r.id, cos_vs_wasm: +cos(a, w).toFixed(7), top1_eq_wasm: top1(a) === top1(w), max_abs_vs_wasm: +mx.toFixed(4), cos_vs_131: +cos(a, b131).toFixed(7), top1_eq_131: top1(a) === top1(b131) });
    }
    const mean = (k) => rows.reduce((x, r) => x + r[k], 0) / rows.length;
    const summary = { ort_tag: TAG, n: rows.length, cos_vs_wasm_mean: +mean('cos_vs_wasm').toFixed(6), cos_vs_wasm_min: Math.min(...rows.map((r) => r.cos_vs_wasm)), top1_eq_wasm: rows.filter((r) => r.top1_eq_wasm).length, cos_vs_131_mean: +mean('cos_vs_131').toFixed(6), top1_eq_131: rows.filter((r) => r.top1_eq_131).length, max_abs_vs_wasm_max: Math.max(...rows.map((r) => r.max_abs_vs_wasm)) };
    fs.writeFileSync(path.join(NV, 'bisect-ort-' + TAG + '.json'), JSON.stringify({ summary, rows }));
    console.log(JSON.stringify(summary));
    process.exit(0);
})().catch((e) => { console.log('ERR', String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
