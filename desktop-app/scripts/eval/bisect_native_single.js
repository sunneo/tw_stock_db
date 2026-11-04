// 二分法 第 1 步（原生側，onnxruntime-node）：與 bisect_wasm_single.eval.js 相同的輸入（同一串 ids、attention_mask、position_ids 0..n-1、空的 past），單次 forward。
// 記錄輸入清單與 metadata（名稱、dtype、形狀），模型檔的大小與 md5；逐題比對 logits（最大絕對誤差、餘弦）。
// 輸出 %TEMP%\nvw-out\bisect-native-single.json 與標準比較結果。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const TEMP = process.env.TEMP || os.tmpdir();
const ort = require(path.join(TEMP, 'ort-node-test', 'node_modules', 'onnxruntime-node'));
const MODEL = path.join(TEMP, 'ort-node-test', 'models', 'qwen3-0.6b-cpu.onnx');
const NV = path.join(TEMP, 'nvw-out');
const native = JSON.parse(fs.readFileSync(path.join(NV, 'first-native.json'), 'utf8'));
const wasm = JSON.parse(fs.readFileSync(path.join(NV, 'bisect-wasm-single.json'), 'utf8'));
const wById = new Map(wasm.rows.map((r) => [r.id, r]));
const f32 = (b64) => new Float32Array(Buffer.from(b64, 'base64').buffer.slice(0));
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
(async () => {
    const sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'], intraOpNumThreads: 4 });
    const meta = sess.inputMetadata; // 名稱 → { type, dims, isTensor }
    const inputMeta = Object.keys(meta).slice(0, 6).map((k) => ({ name: k, dtype: meta[k].type, dims: meta[k].dims }));
    const names = sess.inputNames;
    const file = { path: MODEL, size: fs.statSync(MODEL).size, md5: md5(MODEL) };
    const rows = [];
    for (const r of native) {
        const n = r.ids.length;
        const feeds = {};
        feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(r.ids.map(BigInt)), [1, n]);
        feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
        if (names.indexOf('position_ids') >= 0) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
        for (const name of names) if (name.indexOf('past_key_values.') === 0) feeds[name] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
        const out = await sess.run(feeds);
        const lg = out.logits;
        const V = lg.dims[2], last = (n - 1) * V;
        const a = Float32Array.from(lg.data.subarray(last, last + V));
        const b = f32(wById.get(r.id).logits_b64);
        let maxAbs = 0, d = 0, na = 0, nb = 0;
        for (let i = 0; i < V; i++) { maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i])); d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        const t = (arr) => Array.from(arr.keys()).sort((x, y) => arr[y] - arr[x]).slice(0, 1)[0];
        rows.push({ id: r.id, n, dims: lg.dims, max_abs_err: Math.round(maxAbs * 1e5) / 1e5, cosine: Math.round((d / Math.sqrt(na * nb)) * 1e7) / 1e7, top1_native: t(a), top1_wasm: t(b) });
    }
    const out = { file, native_inputs: names, native_input_metadata_head: inputMeta, wasm_inputs: wasm.meta.inputNames, names_equal: JSON.stringify(names) === JSON.stringify(wasm.meta.inputNames), rows };
    fs.writeFileSync(path.join(NV, 'bisect-native-single.json'), JSON.stringify(out));
    const cos = rows.map((r) => r.cosine);
    console.log(JSON.stringify({ names_equal: out.names_equal, file, cos_min: Math.min(...cos), cos_mean: cos.reduce((x, y) => x + y, 0) / cos.length, top1_same: rows.filter((r) => r.top1_native === r.top1_wasm).length, max_abs_err_max: Math.max(...rows.map((r) => r.max_abs_err)) }));
    process.exit(0);
})().catch((e) => { console.log('ERR', String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
