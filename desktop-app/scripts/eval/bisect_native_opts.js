// 二分法（原生側內部一致性）：同一模型、同一串輸入（前 4 題），比較不同 ORT 設定的第一步 logits：
// 圖最佳化等級（disabled／basic／all）與執行緒數（1／4）。若同一引擎內的設定差異已經造成大的偏差，
// 表示 q8 內核的數值對執行方式很敏感，而不是輸入組裝錯誤。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP = process.env.TEMP || os.tmpdir();
const ort = require(path.join(TEMP, 'ort-node-test', 'node_modules', 'onnxruntime-node'));
const MODEL = path.join(TEMP, 'ort-node-test', 'models', 'qwen3-0.6b-cpu.onnx');
const native = JSON.parse(fs.readFileSync(path.join(TEMP, 'nvw-out', 'first-native.json'), 'utf8')).slice(0, 4);
async function firstLogits(opts, ids) {
    const sess = await ort.InferenceSession.create(MODEL, Object.assign({ executionProviders: ['cpu'] }, opts));
    const n = ids.length; const f = {};
    for (const name of sess.inputNames) if (name.indexOf('past_key_values.') === 0) f[name] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
    f.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
    f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
    f.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
    const r = await sess.run(f); const V = r.logits.dims[2], last = (n - 1) * V;
    await sess.release();
    return Float32Array.from(r.logits.data.subarray(last, last + V));
}
function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }
(async () => {
    const configs = {
        all_t4: { graphOptimizationLevel: 'all', intraOpNumThreads: 4 },
        all_t1: { graphOptimizationLevel: 'all', intraOpNumThreads: 1 },
        basic_t4: { graphOptimizationLevel: 'basic', intraOpNumThreads: 4 },
        disabled_t4: { graphOptimizationLevel: 'disabled', intraOpNumThreads: 4 },
    };
    const res = {};
    for (const [name, opts] of Object.entries(configs)) {
        res[name] = [];
        for (const r of native) res[name].push(await firstLogits(opts, r.ids));
        console.log('[opts] done', name);
    }
    const out = {};
    for (const name of Object.keys(configs)) {
        const cs = native.map((_, i) => cos(res.all_t4[i], res[name][i]));
        out[name + ' vs all_t4'] = { cos_min: Math.min(...cs), cos_mean: cs.reduce((x, y) => x + y, 0) / cs.length };
    }
    console.log(JSON.stringify(out));
    process.exit(0);
})().catch((e) => { console.log('ERR', String((e && e.stack) || e).slice(0, 400)); process.exit(1); });
