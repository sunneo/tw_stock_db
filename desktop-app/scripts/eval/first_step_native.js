// 第一步比對（原生側）：用 nr-template.js＋tokenizer.js 產生 ids，取 onnxruntime-node CPU 在「第一步」（整段預填）的最後位置 logits。
// 輸出 %TEMP%\nvw-out\first-native.json（每題的 ids 與 logits 的 base64 Float32）。WASM 側的對應檔由 first_step_wasm.eval.js 產生。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ort = require(path.join(process.env.TEMP || os.tmpdir(), 'ort-node-test', 'node_modules', 'onnxruntime-node'));
const { applyTemplate } = require('../../nr-template.js');
const { createTokenizer } = require('../../nr-tokenizer.js');
const TEMP = process.env.TEMP || os.tmpdir();
const ORT_DIR = path.join(TEMP, 'ort-node-test');
const tok = createTokenizer(JSON.parse(fs.readFileSync(path.join(ORT_DIR, 'tok', 'tokenizer.json'), 'utf8')));
const prompts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'prompts.json'), 'utf8'));
const L = 28, KV = 8, HD = 128;
(async () => {
    const sess = await ort.InferenceSession.create(path.join(ORT_DIR, 'models', 'qwen3-0.6b-cpu.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 4 });
    const out = [];
    for (const p of prompts) {
        const ids = tok.encode(applyTemplate('qwen3-chatml', p.messages, { enable_thinking: false }));
        const n = ids.length; const f = {};
        for (let l = 0; l < L; l++) for (const k of ['key', 'value']) f[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
        f.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
        f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
        f.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
        const r = await sess.run(f);
        const V = r.logits.dims[2], last = (n - 1) * V;
        const row = Float32Array.from(r.logits.data.subarray(last, last + V));
        out.push({ id: p.id, ids, logits_b64: Buffer.from(row.buffer).toString('base64'), vocab: V });
        console.log('[first-native]', p.id, 'n', n, 'V', V);
    }
    fs.mkdirSync(path.join(TEMP, 'nvw-out'), { recursive: true });
    fs.writeFileSync(path.join(TEMP, 'nvw-out', 'first-native.json'), JSON.stringify(out));
    process.exit(0);
})().catch((e) => { console.log('ERR', String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
