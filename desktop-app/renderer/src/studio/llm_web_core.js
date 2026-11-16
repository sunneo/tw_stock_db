/* llm_web_core.js — 網頁版 LLM 推論核心（純函式，UMD）。DESIGN.lora-training.md §25；lm_head 的 GPU 接線見 DESIGN.webgpu-cuda.md §7.3。
 *
 * 不依賴 Node：
 *   - 分詞器：BPE（tokenizer.json，與 nr-tokenizer.js 同一套規則，改用 TextEncoder／TextDecoder）
 *   - 推論：onnxruntime-web 由呼叫端注入（ort 物件），session 用 executionProviders:['wasm']
 *   - 貪婪解碼（temperature 0）＋ KV cache：past_key_values.{l}.{key|value}，28 層、8 KV 頭、head_dim 128（Qwen3-0.6B）
 *   - 可選的隱藏狀態頭（opts.head）：變體圖輸出 final_norm 的隱藏狀態，lm_head 由呼叫端的 run() 算（GPU）。
 *     任何失敗（沒有 GPU、逾時、長度不對、開頭幾步的對拍不合）都退回原本的 session，生成不中斷；原因與層別寫進診斷。
 *
 * 匯出：
 *   createTokenizer(tokenizerJson) → { encode(text), decode(ids), specials }
 *   greedyGenerate(ort, session, promptIds, opts) → { tokens, stoppedBy, head:{診斷} }
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

    function withTimeout(p, ms, what) {
        if (!(ms > 0)) return p;
        let tm = null;
        return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(what + '逾時（' + ms + ' 毫秒）')), ms); })])
            .finally(() => clearTimeout(tm));
    }
    function argmaxOf(row) { let best = 0, bv = -Infinity; for (let v = 0; v < row.length; v++) { const x = row[v]; if (x > bv) { bv = x; best = v; } } return best; }
    // 兩組 logits 的相對差（以參考組的最大絕對值為尺度）與 argmax 是否相同
    function compareRows(got, ref) {
        let maxAbs = 0, refMax = 0;
        for (let v = 0; v < ref.length; v++) { const d = Math.abs(got[v] - ref[v]); if (d > maxAbs) maxAbs = d; const a = Math.abs(ref[v]); if (a > refMax) refMax = a; }
        return { maxRel: refMax > 0 ? maxAbs / refMax : 0, argmaxSame: argmaxOf(got) === argmaxOf(ref) };
    }

    // ---- 貪婪解碼＋KV cache ----
    // 形狀由模型決定：層數、KV 頭數、head_dim 從 opts 來（預設 Qwen3-0.6B：28 / 8 / 128）
    // opts.gpuDecode（可選，Qwen3 q8 整段 GPU 解碼，DESIGN.webgpu-cuda.md §7.13）：{ engine（qwen_gpu 的 createGpuEngine 結果：step(ids)→{token}、reset()）,
    //   verifyTol 不用（動態量化讓數值有百分之幾的雜訊，只比 argmax）, timeoutMs（每步，預設 20000） }
    //   開頭：GPU 預填與原圖預填各跑一次，第一個詞元不同就整段退回原路徑；之後每步只跑 GPU。任何一步失敗：用原圖把「已生成但原圖還沒吃進 KV」的詞元補進去，接著照原路徑走。
    // opts.head（可選）：{ variant（隱藏狀態變體的 session）, hiddenName（變體圖的隱藏狀態輸出名）, run(hidden:Float32Array)→Promise<Float32Array(V)>,
    //   timeoutMs（預設 8000）, verifySteps（預設 1：開頭幾步同時跑原圖，argmax 與相對誤差對拍）, verifyTol（預設 1e-3） }
    function greedyGenerate(ort, session, promptIds, opts) {
        const o = opts || {};
        const L = o.layers || 28, KV = o.kvHeads || 8, HD = o.headDim || 128;
        const maxNew = o.maxNew || 16, eos = new Set(o.eosIds || []);
        const stopCheck = typeof o.isStopRequested === 'function' ? o.isStopRequested : () => false;
        if (!promptIds || !promptIds.length) throw new Error('prompt 是空的');
        const H = o.head && o.head.variant && typeof o.head.run === 'function' ? o.head : null;
        const timeoutMs = H ? (H.timeoutMs === undefined ? 8000 : H.timeoutMs) : 0;
        const verifySteps = H ? (H.verifySteps === undefined ? 1 : H.verifySteps) : 0;
        const verifyTol = H ? (H.verifyTol === undefined ? 1e-3 : H.verifyTol) : 0;
        const diag = { requested: !!H, used: 0, steps: 0, verify: [], fallbackAt: -1, reason: '', headMs: 0, variantMs: 0, origMs: 0 };
        const GD = o.gpuDecode && o.gpuDecode.engine && typeof o.gpuDecode.engine.step === 'function' ? o.gpuDecode : null;
        const gdiag = { requested: !!GD, used: 0, verify: null, fallbackAt: -1, reason: '', gpuMs: 0, origMs: 0 };
        return (async () => {
            let past = {};
            for (let l = 0; l < L; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
            let pastLen = 0, q = promptIds.slice(), out = [], stoppedBy = 'max';
            let headOn = !!H;
            let s0 = 0;
            if (GD) {
                // ---- GPU 整段解碼階段 ----
                const gTimeout = GD.timeoutMs === undefined ? 20000 : GD.timeoutMs;
                let gpuTok = null, ortTok = null, r0 = null, ortLen = 0;
                try {
                    const feed0 = Object.assign({}, past);
                    feed0.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
                    feed0.attention_mask = new ort.Tensor('int64', BigInt64Array.from(new Array(q.length).fill(1n)), [1, q.length]);
                    feed0.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(i))), [1, q.length]);
                    GD.engine.reset();
                    const t0 = Date.now();
                    gpuTok = (await withTimeout(Promise.resolve().then(() => GD.engine.step(q)), gTimeout, 'GPU 解碼預填 ')).token;
                    gdiag.gpuMs += Date.now() - t0;
                    const t1 = Date.now();
                    r0 = await session.run(feed0);
                    gdiag.origMs += Date.now() - t1;
                    const V0 = r0.logits.dims[2], last = (q.length - 1) * V0;
                    ortTok = argmaxOf(r0.logits.data.subarray(last, last + V0));
                    ortLen = q.length;
                    gdiag.verify = { gpuToken: gpuTok, ortToken: ortTok, argmaxSame: gpuTok === ortTok };
                } catch (e) {
                    gdiag.reason = 'GPU 解碼失敗，改用原路徑：' + String((e && e.message) || e); gdiag.fallbackAt = 0; gpuTok = null;
                }
                if (r0) {
                    // 原圖的第一步已經有了：不論 GPU 是否一致，這一步都以原圖為準
                    out.push(ortTok); diag.steps++; s0 = 1;
                    past = {}; for (let l = 0; l < L; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = r0[`present.${l}.${k}`];
                    pastLen = ortLen;
                    if (typeof o.onToken === 'function') o.onToken(ortTok, out.length);
                    if (eos.has(ortTok)) return { tokens: out, stoppedBy: 'eos', head: diag, gpuDecode: gdiag };
                    if (gpuTok !== null && gpuTok !== ortTok) { gdiag.fallbackAt = 0; gdiag.reason = '第一個詞元與原圖不同（GPU ' + gpuTok + '、原圖 ' + ortTok + '），改用原路徑'; gpuTok = null; }
                    let pending = [ortTok];   // 已生成、但原圖的 KV 還沒吃進去的詞元
                    if (gpuTok !== null) {
                        let cur = ortTok;
                        for (let s = 1; s < maxNew; s++) {
                            if (stopCheck()) { stoppedBy = 'stop'; return { tokens: out, stoppedBy, head: diag, gpuDecode: gdiag }; }
                            let t;
                            try {
                                const t2 = Date.now();
                                t = (await withTimeout(Promise.resolve().then(() => GD.engine.step([cur])), gTimeout, 'GPU 解碼 ')).token;
                                gdiag.gpuMs += Date.now() - t2;
                            } catch (e) { gdiag.fallbackAt = s; gdiag.reason = 'GPU 解碼第 ' + s + ' 步失敗，改用原路徑：' + String((e && e.message) || e); break; }
                            out.push(t); diag.steps++; gdiag.used++; pending.push(t); cur = t;
                            if (typeof o.onToken === 'function') o.onToken(t, out.length);
                            if (eos.has(t)) return { tokens: out, stoppedBy: 'eos', head: diag, gpuDecode: gdiag };
                            s0 = out.length;
                        }
                        if (gdiag.fallbackAt < 0) return { tokens: out, stoppedBy: 'max', head: diag, gpuDecode: gdiag };
                    }
                    q = pending.slice();
                    // 之後走原路徑迴圈；out 已有 s0 個詞元
                    s0 = out.length;
                }
            }
            for (let s = s0; s < maxNew; s++) {
                if (stopCheck()) { stoppedBy = 'stop'; break; }
                const len = pastLen + q.length;
                const feed = Object.assign({}, past);
                feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
                feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(new Array(len).fill(1n)), [1, len]);
                feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
                diag.steps++;
                let row = null, presentSrc = null;
                if (headOn) {
                    try {
                        const t0 = Date.now();
                        const rv = await H.variant.run(feed);
                        diag.variantMs += Date.now() - t0;
                        const hd = rv[H.hiddenName];
                        if (!hd) throw new Error('變體圖沒有輸出 ' + H.hiddenName);
                        const Hd = hd.dims[2], hl = (q.length - 1) * Hd;
                        const hidden = Float32Array.from(hd.data.subarray(hl, hl + Hd));
                        const t1 = Date.now();
                        const lg = await withTimeout(Promise.resolve().then(() => H.run(hidden)), timeoutMs, 'GPU lm_head ');
                        diag.headMs += Date.now() - t1;
                        if (!lg || (H.vocab && lg.length !== H.vocab)) throw new Error('GPU lm_head 回傳長度 ' + (lg && lg.length) + '，預期 ' + H.vocab);
                        row = lg; presentSrc = rv;
                        if (diag.verify.length < verifySteps) {
                            // 開頭幾步：原圖也跑一次，比對 argmax 與相對誤差；不合就退回原路徑（本步用原圖的結果）
                            const t2 = Date.now();
                            const r0 = await session.run(feed);
                            diag.origMs += Date.now() - t2;
                            const V0 = r0.logits.dims[2], last = (q.length - 1) * V0;
                            const ref = r0.logits.data.subarray(last, last + V0);
                            const cmp = compareRows(lg, ref);
                            diag.verify.push({ step: s, maxRel: cmp.maxRel, argmaxSame: cmp.argmaxSame });
                            if (!cmp.argmaxSame || !(cmp.maxRel <= verifyTol)) {
                                headOn = false; diag.fallbackAt = s;
                                diag.reason = '結果不合（第 ' + s + ' 步：相對誤差 ' + cmp.maxRel.toExponential(2) + '，argmax ' + (cmp.argmaxSame ? '一致' : '不一致') + '），改用原路徑';
                                row = null; presentSrc = r0;
                                const V1 = r0.logits.dims[2], l1 = (q.length - 1) * V1;
                                row = Float32Array.from(r0.logits.data.subarray(l1, l1 + V1));
                            }
                        }
                        if (headOn) diag.used++;
                    } catch (e) {
                        headOn = false; diag.fallbackAt = s;
                        diag.reason = 'GPU lm_head 失敗，改用原路徑：' + String((e && e.message) || e);
                        row = null; presentSrc = null;
                    }
                }
                if (!row) {
                    const t3 = Date.now();
                    const r = await session.run(feed);
                    diag.origMs += Date.now() - t3;
                    const V = r.logits.dims[2], last = (q.length - 1) * V;
                    row = Float32Array.from(r.logits.data.subarray(last, last + V));
                    presentSrc = r;
                }
                const best = argmaxOf(row);
                out.push(best);
                if (eos.has(best)) { stoppedBy = 'eos'; break; }
                past = {};
                for (let l = 0; l < L; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = presentSrc[`present.${l}.${k}`];
                pastLen = len; q = [best];
                if (typeof o.onToken === 'function') o.onToken(best, out.length);
            }
            return { tokens: out, stoppedBy, head: diag, gpuDecode: gdiag };
        })();
    }

    return { createTokenizer, loadSession, greedyGenerate, bytesToUnicode };
});
