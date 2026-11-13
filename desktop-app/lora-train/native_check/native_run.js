#!/usr/bin/env node
/* 原生（onnxruntime-node 1.22.0，app 的 native-runtime 同一套件）貪婪解碼 16 token，三組：
 *   a) q8 基底（native-models 的 model_quantized.onnx）
 *   b) 槽版圖＋全零 lora.bin（應與 a 逐 token 相同）
 *   c) 槽版圖＋bench adapter 的 lora.bin（pack_bench.py 產生）
 * 與 hf_ref.py 的 fp32 合併模型比對 token 一致數與第一步 logits 餘弦。
 * 槽版圖是 app 自己建出來的那一份（native-lora/slot-model/<hash>/），只「硬連結」到暫存資料夾，不改快取。
 * 用法：node lora-train/native_check/native_run.js
 */
const fs = require('fs'), path = require('path'), os = require('os');
const HOME = os.homedir();
const ROOT = path.join(__dirname, '..', '..');
const RT = path.join(HOME, '.config/floating-assistant-desktop/native-runtime/1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const OUT = path.join(HOME, 'fa-work/native_check');
const BIN = path.join(OUT, 'bin');
const Q8 = path.join(HOME, '.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8/onnx/model_quantized.onnx');
const SLOT = path.join(HOME, '.config/floating-assistant-desktop/native-lora/slot-model/ccf8734e59fdf7475b2dc0c117005e267a3a08342c1d951e0a79f0bce57bf62a/model_quantized.onnx');
const LAYERS = 28, KV = 8, HD = 128, STEPS = 16;
const TAG = process.env.FA_TAG || '';  // 與 hf_ref.py／pack_bench.py 的 FA_TAG 對應；空字串＝原本的 bench 組
const BENCH = TAG ? 'lora_' + TAG + '.bin' : 'lora_bench.bin';
const HFP = TAG ? 'hf_' + TAG + '_' : 'hf_';

function variant(name, model, bin) {
    const d = path.join(OUT, 'run_' + name); fs.mkdirSync(d, { recursive: true });
    const m = path.join(d, 'model_quantized.onnx');
    if (!fs.existsSync(m)) { try { fs.linkSync(model, m); } catch (e) { fs.copyFileSync(model, m); } }
    if (bin) fs.copyFileSync(bin, path.join(d, 'lora.bin'));
    return m;
}
const kvEmpty = () => { const o = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) o[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return o; };
async function run(modelPath, ids) {
    const sess = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 4 });
    let past = kvEmpty(), pastLen = 0, next = null, out = [], firstLogits = null;
    for (let s = 0; s < STEPS; s++) {
        const q = s === 0 ? ids : [next], len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(q.map((_, i) => BigInt(pastLen + i))), [1, q.length]);
        const r = await sess.run(feed), V = r.logits.dims[2], row = r.logits.data.subarray((q.length - 1) * V, q.length * V);
        if (s === 0) firstLogits = Float32Array.from(row);
        let b = 0; for (let i = 1; i < V; i++) if (row[i] > row[b]) b = i;
        next = b; out.push(b); pastLen = len;
        past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    await sess.release();
    return { out, firstLogits };
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const agree = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return n; };

(async () => {
    const ids = JSON.parse(fs.readFileSync(path.join(OUT, 'ids.json'), 'utf8')).rows;
    const hf = JSON.parse(fs.readFileSync(path.join(OUT, HFP + 'tokens.json'), 'utf8'));
    const hfFirst = fs.readFileSync(path.join(OUT, HFP + 'first_logits.bin'));
    const V = hfFirst.length / 4 / ids.length;
    const hfLogits = (i) => new Float32Array(hfFirst.buffer.slice(hfFirst.byteOffset + i * V * 4, hfFirst.byteOffset + (i + 1) * V * 4));
    const sizes = { q8: fs.statSync(Q8).size, slot: fs.statSync(SLOT).size, lora_zero: fs.statSync(path.join(BIN, 'lora_zero.bin')).size, lora_bench: fs.statSync(path.join(BIN, BENCH)).size };
    const models = {
        a_q8_base: variant('q8', Q8, null),
        b_slot_zero: variant('zero', SLOT, path.join(BIN, 'lora_zero.bin')),
        c_slot_bench: variant('bench' + (TAG ? '_' + TAG : ''), SLOT, path.join(BIN, BENCH)),
    };
    const hfb = JSON.parse(fs.readFileSync(path.join(OUT, 'hf_base_tokens.json'), 'utf8'));
    const hfbFirst = fs.readFileSync(path.join(OUT, 'hf_base_first_logits.bin'));
    const hfbLogits = (i) => new Float32Array(hfbFirst.buffer.slice(hfbFirst.byteOffset + i * V * 4, hfbFirst.byteOffset + (i + 1) * V * 4));
    const res = { onnxruntime_node: require(path.join(RT, 'node_modules', 'onnxruntime-node', 'package.json')).version, sizes, rows: [] };
    const totals = { a: 0, b: 0, c: 0, n: 0, ab: 0, bb: 0, cb: 0 }, dif = { ac: 0 };
    for (const row of ids) {
        const r = {};
        for (const k of Object.keys(models)) r[k] = await run(models[k], row.ids);
        const h = hf.tokens[row.i], hb = hfb.tokens[row.i];
        const ag = { a: agree(r.a_q8_base.out, h), b: agree(r.b_slot_zero.out, h), c: agree(r.c_slot_bench.out, h) };
        const agb = { a: agree(r.a_q8_base.out, hb), b: agree(r.b_slot_zero.out, hb), c: agree(r.c_slot_bench.out, hb) };
        totals.a += ag.a; totals.b += ag.b; totals.c += ag.c; totals.n += h.length;
        totals.ab += agb.a; totals.bb += agb.b; totals.cb += agb.c;
        const hl = hfLogits(row.i), hbl = hfbLogits(row.i);
        res.rows.push({
            i: row.i, text: row.text, hf_adapter: h, hf_base: hb,
            a_q8: r.a_q8_base.out, b_zero: r.b_slot_zero.out, c_bench: r.c_slot_bench.out,
            agree_with_hf_adapter: ag, agree_with_hf_base: agb,
            first_logit_cos_vs_hf_adapter: { a: +cos(r.a_q8_base.firstLogits, hl).toFixed(4), b: +cos(r.b_slot_zero.firstLogits, hl).toFixed(4), c: +cos(r.c_slot_bench.firstLogits, hl).toFixed(4) },
            first_logit_cos_vs_hf_base: { a: +cos(r.a_q8_base.firstLogits, hbl).toFixed(4), c: +cos(r.c_slot_bench.firstLogits, hbl).toFixed(4) },
            b_equals_a: JSON.stringify(r.a_q8_base.out) === JSON.stringify(r.b_slot_zero.out),
            c_equals_a: JSON.stringify(r.a_q8_base.out) === JSON.stringify(r.c_slot_bench.out),
        });
        console.log('row', row.i, JSON.stringify(ag), 'b==a', JSON.stringify(r.a_q8_base.out) === JSON.stringify(r.b_slot_zero.out), 'c==a', JSON.stringify(r.a_q8_base.out) === JSON.stringify(r.c_slot_bench.out));
    }
    res.totals = {
        tokens: totals.n,
        vs_hf_adapter: { a_q8_base_no_adapter: totals.a, b_slot_zero: totals.b, c_slot_bench: totals.c },
        vs_hf_base: { a_q8_base: totals.ab, b_slot_zero: totals.bb, c_slot_bench: totals.cb },
    };
    fs.writeFileSync(path.join(OUT, TAG ? 'native_results_' + TAG + '.json' : 'native_results.json'), JSON.stringify(res, null, 1));
    console.log('TOTAL', JSON.stringify(res.totals), 'onnxruntime-node', res.onnxruntime_node);
})().catch((e) => { console.error(e); process.exit(1); });
