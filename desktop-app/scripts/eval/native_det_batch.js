// 原生端的確定性生成（與桌面版 WASM 的 deterministic:true 相同設定）：onnxruntime-node CPU、同一串 ids（native-runner/template.js＋tokenizer.js）、
// gen 物件與產品端 FaVlm.textGenParams({deterministic:true}) 的輸出相同：{ do_sample:false, repetition_penalty:1.08 }，
// 取樣與懲罰都由 native-runner/gen_params.js 處理（與 transformers.js 的處理器相同做法）。最多 16 個新 token，遇到 EOS 即停止。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/eval/native_det_batch.js  （需要 %TEMP%\ort-node-test 內的模型與套件）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ort = require(path.join(process.env.TEMP || os.tmpdir(), 'ort-node-test', 'node_modules', 'onnxruntime-node'));
const { applyTemplate } = require('../../native-runner/template.js');
const { createTokenizer } = require('../../native-runner/tokenizer.js');
const { validateGen, pickToken } = require('../../native-runner/gen_params.js');

const TEMP = process.env.TEMP || os.tmpdir();
const ORT_DIR = path.join(TEMP, 'ort-node-test');
const tok = createTokenizer(JSON.parse(fs.readFileSync(path.join(ORT_DIR, 'tok', 'tokenizer.json'), 'utf8')));
const prompts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'prompts.json'), 'utf8'));
const GEN = validateGen({ do_sample: false, repetition_penalty: 1.08 }); // = FaVlm.textGenParams(model, { deterministic: true })
const LAYERS = 28, KV = 8, HD = 128, MAX_NEW = 16, EOS = [151645, 151643];
const OUT = path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'native-det-penalty.json');

function kvEmpty() { const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return out; }
async function gen(sess, promptIds, rng, firstOut) {
    let past = kvEmpty(), next = null, out = [], pastLen = 0;
    for (let s = 0; s < MAX_NEW; s++) {
        const q = s === 0 ? promptIds : [next];
        const len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
        const r = await sess.run(feed);
        const V = r.logits.dims[2], last = (q.length - 1) * V;
        const row = Float32Array.from(r.logits.data.subarray(last, last + V));
        if (s === 0 && firstOut) firstOut.push(Float32Array.from(row));
        next = pickToken(row, promptIds, out, GEN, rng);
        out.push(next); pastLen = len;
        if (EOS.includes(next)) break;
        past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    return out;
}

(async () => {
    const sess = await ort.InferenceSession.create(path.join(ORT_DIR, 'models', 'qwen3-0.6b-cpu.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 4 });
    const rows = [];
    const t0 = Date.now();
    for (const p of prompts) {
        const ids = tok.encode(applyTemplate('qwen3-chatml', p.messages, { enable_thinking: false }));
        const t = Date.now();
        const ids2 = await gen(sess, ids, null, null);
        const text = tok.decode(ids2).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
        rows.push({ id: p.id, group: p.group, prompt_tokens: ids.length, gen_ids: ids2, text, ms: Date.now() - t });
        console.log('[det]', p.id, 'ms', Date.now() - t, 'text', JSON.stringify(text.slice(0, 40)));
    }
    fs.writeFileSync(OUT, JSON.stringify({ gen: GEN, total_ms: Date.now() - t0, rows }, null, 1));
    console.log('[det] 結果檔', OUT);
    process.exit(0);
})().catch((e) => { console.log('[det] 失敗', String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
