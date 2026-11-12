/* llm_web_core.js — 網頁版 LLM 推論核心（純函式，UMD）。DESIGN.lora-training.md §25。
 *
 * 不依賴 Node：
 *   - 分詞器：BPE（tokenizer.json，與 nr-tokenizer.js 同一套規則，改用 TextEncoder／TextDecoder）
 *   - 推論：onnxruntime-web 由呼叫端注入（ort 物件），session 用 executionProviders:['wasm']
 *   - 貪婪解碼（temperature 0）＋ KV cache：past_key_values.{l}.{key|value}，28 層、8 KV 頭、head_dim 128（Qwen3-0.6B）
 *
 * 匯出：
 *   createTokenizer(tokenizerJson) → { encode(text), decode(ids), specials }
 *   greedyGenerate(ort, session, promptIds, opts) → { tokens, text?, stoppedBy }
 *   loadSession(ort, bytes, opts) → Promise<InferenceSession>
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLlmWeb = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---- byte-level BPE（GPT-2 系）----
    function bytesToUnicode() {
        const bs = []; for (let i = 33; i <= 126; i++) bs.push(i); for (let i = 161; i <= 172; i++) bs.push(i); for (let i = 174; i <= 255; i++) bs.push(i);
        const cs = bs.slice(); let n = 0;
        for (let b = 0; b < 256; b++) if (bs.indexOf(b) < 0) { bs.push(b); cs.push(256 + n); n++; }
        const b2u = new Array(256), u2b = new Map();
        bs.forEach((b, i) => { const c = String.fromCharCode(cs[i]); b2u[b] = c; u2b.set(c, b); });
        return { b2u, u2b };
    }
    const { b2u, u2b } = bytesToUnicode();
    const enc8 = new TextEncoder();
    const dec8 = new TextDecoder('utf-8');
    function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function createTokenizer(tokj) {
        if (!tokj || !tokj.model || tokj.model.type !== 'BPE') throw new Error('只支援 BPE 的 tokenizer.json');
        const vocab = tokj.model.vocab;
        const ranks = new Map();
        tokj.model.merges.forEach((m, i) => { const pair = Array.isArray(m) ? m : m.split(' '); ranks.set(pair[0] + '\u0001' + pair[1], i); });
        const added = (tokj.added_tokens || []).map((t) => ({ content: t.content, id: t.id }));
        const addedMap = new Map(added.map((t) => [t.content, t.id]));
        const addedRe = added.length ? new RegExp('(' + added.map((t) => reEsc(t.content)).sort((a, b) => b.length - a.length).join('|') + ')') : null;
        const pre = tokj.pre_tokenizer && tokj.pre_tokenizer.pretokenizers ? tokj.pre_tokenizer.pretokenizers.find((p) => p.type === 'Split') : null;
        if (!pre || !pre.pattern || !pre.pattern.Regex) throw new Error('tokenizer.json 缺少 Split 預分詞規則');
        // 瀏覽器的 RegExp 不一定支援行內旗標 (?i:...)：展開成大小寫都接受（只處理不含巢狀括號的群組）
        const rx = String(pre.pattern.Regex).replace(/\(\?i:([^()]*)\)/g, (_, body) => '(?:' + body.replace(/[A-Za-z]/g, (ch) => '[' + ch.toLowerCase() + ch.toUpperCase() + ']') + ')');
        const preRe = new RegExp(rx, 'gu');
        const normalizeNFC = !!(tokj.normalizer && tokj.normalizer.type === 'NFC');
        const idToTok = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
        for (const t of added) idToTok.set(t.id, t.content);

        function bpe(word) {
            let parts = Array.from(word);
            while (parts.length > 1) {
                let best = null, bi = -1;
                for (let i = 0; i < parts.length - 1; i++) {
                    const r = ranks.get(parts[i] + '\u0001' + parts[i + 1]);
                    if (r !== undefined && (best === null || r < best)) { best = r; bi = i; }
                }
                if (bi < 0) break;
                parts = parts.slice(0, bi).concat([parts[bi] + parts[bi + 1]], parts.slice(bi + 2));
            }
            return parts;
        }
        function encodeChunk(text) {
            const ids = []; preRe.lastIndex = 0; let m;
            while ((m = preRe.exec(text))) {
                const piece = Array.from(enc8.encode(m[0]), (b) => b2u[b]).join('');
                for (const tok of bpe(piece)) {
                    const id = vocab[tok];
                    if (id === undefined) throw new Error('vocab 找不到 token：' + JSON.stringify(tok));
                    ids.push(id);
                }
            }
            return ids;
        }
        function encode(text) {
            const out = [];
            const parts = addedRe ? String(text).split(addedRe) : [String(text)];
            for (const part of parts) {
                if (!part) continue;
                if (addedMap.has(part)) { out.push(addedMap.get(part)); continue; }
                out.push(...encodeChunk(normalizeNFC ? part.normalize('NFC') : part));
            }
            return out;
        }
        function decode(ids) {
            const specials = new Set(added.map((t) => t.content));
            let out = '', buf = [];
            const flush = () => { if (buf.length) { out += dec8.decode(Uint8Array.from(buf)); buf = []; } };
            for (const tok of ids.map((i) => (idToTok.has(i) ? idToTok.get(i) : ''))) {
                if (specials.has(tok)) { flush(); out += tok; continue; }
                for (const c of Array.from(tok)) buf.push(u2b.has(c) ? u2b.get(c) : 0);
            }
            flush();
            return out;
        }
        return { encode, decode, vocabSize: idToTok.size, specials: added.map((t) => t.content) };
    }

    // ---- ONNX session（注入的 ort＝onnxruntime-web）----
    async function loadSession(ort, bytes, opts) {
        if (!ort || !ort.InferenceSession) throw new Error('沒有 onnxruntime-web（ort.InferenceSession 不存在）');
        const o = opts || {};
        // 圖最佳化預設 disabled：q8 的 MatMulInteger 圖在 wasm 下開 all 會變差（實測 6 題 16 token：all 28/96、disabled 54/96；見 DESIGN §25）
        return ort.InferenceSession.create(bytes, { executionProviders: o.executionProviders || ['wasm'], graphOptimizationLevel: o.graphOptimizationLevel || 'disabled' });
    }

    // ---- 貪婪解碼＋KV cache ----
    // 形狀由模型決定：層數、KV 頭數、head_dim 從 opts 來（預設 Qwen3-0.6B：28 / 8 / 128）
    function greedyGenerate(ort, session, promptIds, opts) {
        const o = opts || {};
        const L = o.layers || 28, KV = o.kvHeads || 8, HD = o.headDim || 128;
        const maxNew = o.maxNew || 16, eos = new Set(o.eosIds || []);
        const stopCheck = typeof o.isStopRequested === 'function' ? o.isStopRequested : () => false;
        if (!promptIds || !promptIds.length) throw new Error('prompt 是空的');
        return (async () => {
            let past = {};
            for (let l = 0; l < L; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
            let pastLen = 0, q = promptIds.slice(), out = [], stoppedBy = 'max';
            for (let s = 0; s < maxNew; s++) {
                if (stopCheck()) { stoppedBy = 'stop'; break; }
                const len = pastLen + q.length;
                const feed = Object.assign({}, past);
                feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
                feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(new Array(len).fill(1n)), [1, len]);
                feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
                const r = await session.run(feed);
                const lg = r.logits.data, V = r.logits.dims[2], off = (q.length - 1) * V;
                let best = 0, bv = -Infinity;
                for (let v = 0; v < V; v++) { const x = lg[off + v]; if (x > bv) { bv = x; best = v; } }
                out.push(best);
                if (eos.has(best)) { stoppedBy = 'eos'; break; }
                past = {};
                for (let l = 0; l < L; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = r[`present.${l}.${k}`];
                pastLen = len; q = [best];
                if (typeof o.onToken === 'function') o.onToken(best, out.length);
            }
            return { tokens: out, stoppedBy };
        })();
    }

    return { createTokenizer, loadSession, greedyGenerate, bytesToUnicode };
});
