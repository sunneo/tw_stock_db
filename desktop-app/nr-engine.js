// 原生推論引擎（onnxruntime-node，CPU）：子程序（nr-child.js）用它做真的生成。
// 迴圈與 scripts/eval/native_det_batch.js 相同（已與 WASM 同版本 ORT 逐 logit 比對過）：KV 快取、貪婪或可重現取樣、遇 EOS 停止。
// 只在子程序裡使用（需要 onnxruntime-node，放在執行包內）。生成參數一律由呼叫端傳入（產品端 FaVlm.textGenParams 的結果），這裡不另訂預設。
'use strict';

const fs = require('fs');
const path = require('path');
const { applyTemplate } = require('./nr-template.js');
const { createTokenizer } = require('./nr-tokenizer.js');
const { validateGen, pickToken, makeRng } = require('./nr-gen-params.js');
const crypto = require('crypto');

const LAYERS = 28, KV = 8, HD = 128, EOS = [151645, 151643];
const VOCAB = 151936, HIDDEN = 1024;
const cache = { ort: null, sessPath: '', sessKey: '', sess: null, tokPath: '', tok: null, vsess: null, vKey: '', vHidden: '' };

function ortModule() {
    if (!cache.ort) cache.ort = require(path.join(__dirname, 'node_modules', 'onnxruntime-node'));
    return cache.ort;
}

// lora（選填，預設不用）：{ id, bytes }。模型要是 lora-train/make_lora_onnx.py build 出來的「LoRA 槽版」；bytes 是 lora.bin（Uint8Array／Buffer），
// 以 onnxruntime 的 externalData 交給 session（1.22.0 實測支援，不需把檔案放在模型旁邊）。換 adapter＝傳不同的 id/bytes，session 會重建；沒給＝行為與以前完全一樣。
function loadModel(modelPath, tokenizerPath, threads, lora) {
    if (!cache.tok || cache.tokPath !== tokenizerPath) {
        cache.tok = createTokenizer(JSON.parse(fs.readFileSync(tokenizerPath, 'utf8')));
        cache.tokPath = tokenizerPath;
    }
    // session 的鍵含 sha256：同 id 但內容不同的 adapter 也會重建 session（沒有 sha256 時只用 id，與舊行為相同）
    const sessKey = lora && lora.bytes ? String(lora.id || 'lora') + (lora.sha256 ? ':' + lora.sha256 : '') : '';
    if (!cache.sess || cache.sessPath !== modelPath || cache.sessKey !== sessKey) {
        cache.sess = null;
        const so = { executionProviders: ['cpu'], intraOpNumThreads: threads || 4 };
        if (sessKey) so.externalData = [{ path: 'lora.bin', data: lora.bytes }];
        return ortModule().InferenceSession.create(modelPath, so).then((s) => {
            cache.sess = s; cache.sessPath = modelPath; cache.sessKey = sessKey; return s;
        });
    }
    return Promise.resolve(cache.sess);
}

// 隱藏狀態變體（選填，GPU 版 lm_head 用）：從現有模型在記憶體內改出「不算 lm_head、改輸出 final_norm 結果」的圖（nr-onnx-lite.js），
// 其餘節點、權重、KV 輸出完全不動，所以 present.* 與原模型逐位元相同——任何時候都能換回原 session 接著生成。
// 找不到 lm_head 節點（模型結構不同）就丟出原因，由呼叫端退回原路徑。
async function loadVariant(modelPath, threads, lora) {
    const sessKey = (lora && lora.bytes ? String(lora.id || 'lora') + (lora.sha256 ? ':' + lora.sha256 : '') : '') + '|' + modelPath;
    if (cache.vsess && cache.vKey === sessKey) return cache.vsess;
    const lite = require('./nr-onnx-lite.js');
    let buf = fs.readFileSync(modelPath);
    let built;
    try {
        const model = lite.parseModel(buf);
        const mm = model.nodes.find((n) => n.name === '/lm_head/MatMul');
        if (!mm) throw new Error('模型裡沒有 /lm_head/MatMul 節點，無法做隱藏狀態變體');
        const hiddenName = mm.inputs[0];
        built = lite.buildHiddenStateModel(buf, { dropNodeName: '/lm_head/MatMul', replaceOutput: 'logits', hiddenName, hiddenDims: ['batch_size', 'sequence_length', HIDDEN] });
        built.hiddenName = hiddenName;
    } catch (e) { buf = null; throw e; }
    const so = { executionProviders: ['cpu'], intraOpNumThreads: threads || 4 };
    if (lora && lora.bytes) so.externalData = [{ path: 'lora.bin', data: lora.bytes }];
    let vb = built.buf(); buf = null;
    const sess = await ortModule().InferenceSession.create(new Uint8Array(vb.buffer, vb.byteOffset, vb.length), so);
    vb = null;
    cache.vsess = sess; cache.vKey = sessKey; cache.vHidden = built.hiddenName;
    return sess;
}

// 把主程序傳來的 lora 規格 {id, path, sha256, size?} 讀成 {id, bytes, sha256}：大小與 sha256 都要核對（不符就丟出具體原因，不載入）。
// 另外核對「模型是 LoRA 槽版」：模型資料夾要有 make_lora_onnx.py build 產生的 layout.json，且 adapter 檔大小必須等於 layout.total_bytes；
// 否則 onnxruntime 會靜默忽略沒被引用的外部資料，看起來成功其實沒套用——這裡寧可明確失敗。fsImpl 可注入（測試用）。
function resolveLora(spec, modelPath, fsImpl) {
    const f = fsImpl || fs;
    if (!spec || typeof spec !== 'object' || !spec.path) throw new Error('lora 規格不完整（需要 id、path、sha256）');
    let bytes;
    try { bytes = f.readFileSync(spec.path); } catch (e) { throw new Error('讀不到 LoRA 檔案 ' + spec.path + '：' + ((e && e.message) || e)); }
    if (spec.size != null && bytes.length !== Number(spec.size)) throw new Error('LoRA 檔案大小不符：預期 ' + spec.size + '，實際 ' + bytes.length);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!spec.sha256) throw new Error('lora 規格缺 sha256，拒絕載入（不接受沒有雜湊的 adapter）');
    if (sha !== spec.sha256) throw new Error('LoRA 檔案 sha256 不符（預期 ' + String(spec.sha256).slice(0, 12) + '…，實際 ' + sha.slice(0, 12) + '…），拒絕載入');
    if (modelPath === null) return { id: String(spec.id || 'lora'), bytes, sha256: sha }; // 假引擎（沒有模型檔）：只驗檔案與雜湊
    let layout = null;
    try { layout = JSON.parse(f.readFileSync(path.join(path.dirname(modelPath), 'layout.json'), 'utf8')); } catch (_) { layout = null; }
    if (!layout || !(layout.total_bytes > 0)) throw new Error('目前的模型不是 LoRA 槽版（模型資料夾沒有 make_lora_onnx.py build 產生的 layout.json），無法套用 adapter');
    if (layout.total_bytes !== bytes.length) throw new Error('adapter 大小 ' + bytes.length + ' 與模型的 LoRA 槽（' + layout.total_bytes + '，rank ' + layout.rank + '）不符');
    return { id: String(spec.id || 'lora'), bytes, sha256: sha };
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
    const sess = await loadModel(opts.modelPath, opts.tokenizerPath, opts.threads, opts.lora);
    const ort = ortModule(), tok = cache.tok;
    const promptIds = tok.encode(applyTemplate(opts.template || 'qwen3-chatml', opts.messages || [], { enable_thinking: false, prefill: opts.prefill }));
    const rng = gen.do_sample ? makeRng(opts.seed != null ? opts.seed : 1) : null;
    const maxNew = Math.max(1, opts.maxTokens || 512);
    // GPU 版 lm_head（選填）：opts.head(hidden:Float32Array) → Promise<Float32Array(VOCAB)>。任何失敗（變體建不起來、head 丟錯、長度不對）
    // 都只退回原 session（KV 與原模型逐位元相同，接著生成），原因寫進回傳的 head.fallback；不中斷生成。
    const headInfo = { requested: !!opts.head, used: 0, fallback: '' };
    let vsess = null;
    if (opts.head) {
        try { vsess = await loadVariant(opts.modelPath, opts.threads, opts.lora); }
        catch (e) { headInfo.fallback = '隱藏狀態變體建立失敗：' + String((e && e.message) || e); }
    }
    let past = kvEmpty(ort), next = null, out = [], pastLen = 0, emitted = 0, finish = 'length';
    for (let s = 0; s < maxNew; s++) {
        if (opts.isCancelled && opts.isCancelled()) return { cancelled: true, text: '', ids: out, finish_reason: 'cancelled' };
        const q = s === 0 ? promptIds : [next];
        const len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
        let r = null, row = null;
        if (vsess) {
            try {
                r = await vsess.run(feed);
                const hd = r[cache.vHidden];
                const H = hd.dims[2], hl = (q.length - 1) * H;
                const got = await opts.head(Float32Array.from(hd.data.subarray(hl, hl + H)));
                if (!got || got.length !== VOCAB) throw new Error('head 回傳的 logits 長度 ' + (got && got.length) + '，預期 ' + VOCAB);
                row = got; headInfo.used++;
            } catch (e) {
                headInfo.fallback = 'GPU lm_head 失敗，改用 CPU：' + String((e && e.message) || e);
                vsess = null; r = null; row = null;
            }
        }
        if (!row) {
            r = await sess.run(feed);
            const V = r.logits.dims[2], last = (q.length - 1) * V;
            row = Float32Array.from(r.logits.data.subarray(last, last + V));
        }
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
    return { cancelled: false, text: cleanText(tok, out), ids: out, finish_reason: finish, head: headInfo };
}

// 測試用：注入假的 onnxruntime 模組、重設快取（不用於產品路徑）
function _testHooks() { return { setOrt(o) { cache.ort = o; }, reset() { cache.vsess = null; cache.vKey = ''; cache.ort = null; cache.sessPath = ''; cache.sessKey = ''; cache.sess = null; cache.tokPath = ''; cache.tok = null; } }; }

module.exports = { generate, loadModel, loadVariant, cleanText, resolveLora, _testHooks, VOCAB };
