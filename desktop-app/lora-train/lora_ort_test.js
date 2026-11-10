#!/usr/bin/env node
/* 用 app 實際使用的 onnxruntime-node（native-runtime 的同一個套件）驗證 LoRA 外部資料機制：
 *   1. 原始 q8（基底）與「LoRA 槽＋全零 lora.bin」輸出逐位元相同
 *   2. 載入 adapter_r2 打包出的 lora.bin 後 logits 改變、top-1 改變（對照 python onnxruntime，見 lora_ort_check.py）
 *   3. 量測每個 token 的速度（基底 vs +LoRA）
 *   4. 探測 InferenceSession.create 是否接受 externalData 選項（onnxruntime-node 1.22.0）
 * 用法：node lora_ort_test.js [onnx 目錄=out/onnx]  （需先跑 make_lora_onnx.py build / pack）
 */
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const RT = process.env.NR_RUNTIME || path.join(process.env.APPDATA || '', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const { createTokenizer } = require(path.join(ROOT, 'nr-tokenizer.js'));
const { applyTemplate } = require(path.join(ROOT, 'nr-template.js'));
const D = path.resolve(process.argv[2] || path.join(__dirname, 'out', 'onnx'));
const BASE = path.join(D, 'onnx', 'model_quantized.onnx'), BUILD = path.join(D, 'lora_build');
const LAYERS = 28, KV = 8, HD = 128;
const tok = createTokenizer(JSON.parse(fs.readFileSync(path.join(D, 'tokenizer.json'), 'utf8')));

function variantDir(name, loraFile) {   // 模型硬連結＋指定的 lora.bin，放同一資料夾（ORT 以相對路徑 location 讀外部資料）
    const d = path.join(D, 'run_' + name); fs.mkdirSync(d, { recursive: true });
    const m = path.join(d, 'model_quantized.onnx'); if (!fs.existsSync(m)) { try { fs.linkSync(path.join(BUILD, 'model_quantized.onnx'), m); } catch (e) { fs.copyFileSync(path.join(BUILD, 'model_quantized.onnx'), m); } }
    fs.copyFileSync(path.join(BUILD, loraFile), path.join(d, 'lora.bin')); return m;
}
const kvEmpty = () => { const o = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) o[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return o; };
async function run(model, ids, steps, opts) {
    const sess = await ort.InferenceSession.create(model, Object.assign({ executionProviders: ['cpu'], intraOpNumThreads: 4 }, opts || {}));
    let past = kvEmpty(), pastLen = 0, next = null, out = [], firstLogits = null, t1 = 0, tN = 0;
    for (let s = 0; s < steps; s++) {
        const q = s === 0 ? ids : [next], len = pastLen + q.length, t0 = Date.now();
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(q.map((_, i) => BigInt(pastLen + i))), [1, q.length]);
        const r = await sess.run(feed), V = r.logits.dims[2], row = r.logits.data.subarray((q.length - 1) * V, q.length * V);
        if (s === 0) { firstLogits = Float32Array.from(row); t1 = Date.now() - t0; } else tN += Date.now() - t0;
        let b = 0; for (let i = 1; i < V; i++) if (row[i] > row[b]) b = i;
        next = b; out.push(b); pastLen = len;
        past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    return { out, firstLogits, prefillMs: t1, tokPerSec: steps > 1 ? (steps - 1) / (tN / 1000) : 0 };
}
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

(async () => {
    const rows = fs.readFileSync(path.join(__dirname, 'data', 'heldout.jsonl'), 'utf8').trim().split('\n').slice(0, 3).map(JSON.parse);
    const prompt = applyTemplate('qwen3-chatml', rows[0].messages, { enable_thinking: false, prefill: rows[0].prefill || '' });
    const ids = tok.encode(typeof prompt === 'string' ? prompt : prompt.text);
    console.log('onnxruntime-node', require(path.join(RT, 'node_modules', 'onnxruntime-node', 'package.json')).version, '| prompt tokens', ids.length, '| want', JSON.stringify(rows[0].completion));
    const STEPS = 12, res = {};
    res.base = await run(BASE, ids, STEPS); console.log('base        ', tok.decode(res.base.out), `${res.base.tokPerSec.toFixed(2)} tok/s`);
    res.zero = await run(variantDir('zero', 'lora.bin'), ids, STEPS); console.log('slot+zero   ', tok.decode(res.zero.out), `${res.zero.tokPerSec.toFixed(2)} tok/s`);
    res.r2 = await run(variantDir('r2', 'lora_r2.bin'), ids, STEPS); console.log('slot+adapter', tok.decode(res.r2.out), `${res.r2.tokPerSec.toFixed(2)} tok/s`);
    const dz = maxDiff(res.base.firstLogits, res.zero.firstLogits), dr = maxDiff(res.base.firstLogits, res.r2.firstLogits);
    console.log(`max|logit diff| base vs zero-adapter = ${dz}  (want 0 or ~1e-5)`);
    console.log(`max|logit diff| base vs r2 adapter   = ${dr.toFixed(3)}  (want > 0)`);
    console.log('zero-adapter tokens identical to base:', JSON.stringify(res.base.out) === JSON.stringify(res.zero.out));
    console.log('adapter changes tokens:', JSON.stringify(res.base.out) !== JSON.stringify(res.r2.out));
    fs.writeFileSync(path.join(D, 'ort_node_result.json'), JSON.stringify({ ids, base: res.base.out, zero: res.zero.out, r2: res.r2.out, r2FirstLogitsHead: Array.from(res.r2.firstLogits.slice(0, 8)) }));
    // externalData 選項探測：1.22.0 的 node 綁定有沒有吃這個選項（有的話可以把 lora.bin 的 bytes 直接傳入而不用放在模型旁邊）
    try {
        const bytes = fs.readFileSync(path.join(BUILD, 'lora_r2.bin'));
        const alone = path.join(D, 'run_ext'); fs.mkdirSync(alone, { recursive: true });
        const m = path.join(alone, 'model_quantized.onnx'); if (!fs.existsSync(m)) fs.linkSync(path.join(BUILD, 'model_quantized.onnx'), m);
        try { fs.unlinkSync(path.join(alone, 'lora.bin')); } catch (e) { /* none */ }
        const r = await run(m, ids, 3, { externalData: [{ path: 'lora.bin', data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) }] });
        console.log('externalData option (no lora.bin on disk): loaded, tokens', tok.decode(r.out));
    } catch (e) { console.log('externalData option (no lora.bin on disk): NOT supported ->', String(e.message || e).slice(0, 160)); }
})().catch((e) => { console.error(e); process.exit(1); });
