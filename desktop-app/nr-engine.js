// 原生推論引擎（onnxruntime-node，CPU）：子程序（nr-child.js）用它做真的生成。
// 迴圈與 scripts/eval/native_det_batch.js 相同（已與 WASM 同版本 ORT 逐 logit 比對過）：KV 快取、貪婪或可重現取樣、遇 EOS 停止。
// 只在子程序裡使用（需要 onnxruntime-node，放在執行包內）。生成參數一律由呼叫端傳入（產品端 FaVlm.textGenParams 的結果），這裡不另訂預設。
'use strict';

const fs = require('fs');
const path = require('path');
const { applyTemplate } = require('./nr-template.js');
const { createTokenizer } = require('./nr-tokenizer.js');
const { validateGen, pickToken, makeRng } = require('./nr-gen-params.js');

const LAYERS = 28, KV = 8, HD = 128, EOS = [151645, 151643];
const cache = { ort: null, sessPath: '', sess: null, tokPath: '', tok: null };

function ortModule() {
    if (!cache.ort) cache.ort = require(path.join(__dirname, 'node_modules', 'onnxruntime-node'));
    return cache.ort;
}

function loadModel(modelPath, tokenizerPath, threads) {
    if (!cache.tok || cache.tokPath !== tokenizerPath) {
        cache.tok = createTokenizer(JSON.parse(fs.readFileSync(tokenizerPath, 'utf8')));
        cache.tokPath = tokenizerPath;
    }
    if (!cache.sess || cache.sessPath !== modelPath) {
        cache.sess = null;
        return ortModule().InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: threads || 4 }).then((s) => {
            cache.sess = s; cache.sessPath = modelPath; return s;
        });
    }
    return Promise.resolve(cache.sess);
}

function kvEmpty(ort) {
    const out = {};
    for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
    return out;
}

// 清理輸出：與 native_det_batch.js 相同（遇到對話結束標記就截斷）
function cleanText(tok, ids) {
    return tok.decode(ids).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
}

// 生成。回傳 { text, ids, finish_reason }。onToken(增量文字)、isCancelled()、onProgress(已生成數) 由呼叫端提供。
async function generate(opts) {
    const gen = validateGen(opts.gen);
    const sess = await loadModel(opts.modelPath, opts.tokenizerPath, opts.threads);
    const ort = ortModule(), tok = cache.tok;
    const promptIds = tok.encode(applyTemplate(opts.template || 'qwen3-chatml', opts.messages || [], { enable_thinking: false }));
    const rng = gen.do_sample ? makeRng(opts.seed != null ? opts.seed : 1) : null;
    const maxNew = Math.max(1, opts.maxTokens || 512);
    let past = kvEmpty(ort), next = null, out = [], pastLen = 0, emitted = 0, finish = 'length';
    for (let s = 0; s < maxNew; s++) {
        if (opts.isCancelled && opts.isCancelled()) return { cancelled: true, text: '', ids: out, finish_reason: 'cancelled' };
        const q = s === 0 ? promptIds : [next];
        const len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
        const r = await sess.run(feed);
        const V = r.logits.dims[2], last = (q.length - 1) * V;
        const row = Float32Array.from(r.logits.data.subarray(last, last + V));
        next = pickToken(row, promptIds, out, gen, rng);
        out.push(next); pastLen = len;
        if (opts.onToken) {
            const full = cleanText(tok, out);
            // 最後一個字若是不完整的多位元組字元（替代字元），先不送，等下一個 token 補齊
            if (full.length > emitted && !/�$/.test(full)) { opts.onToken(full.slice(emitted)); emitted = full.length; }
        }
        if (opts.onProgress && out.length % 8 === 0) opts.onProgress(out.length);
        if (EOS.includes(next)) { finish = 'stop'; break; }
        past = {};
        for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    return { cancelled: false, text: cleanText(tok, out), ids: out, finish_reason: finish };
}

module.exports = { generate, loadModel, cleanText };
