'use strict';
// 評估用的 Qwen3 原生（onnxruntime-node，CPU）生成適配器：複用桌面版原生引擎的分詞（nr-tokenizer）、提示樣板（nr-template）、取樣（nr-gen-params）與 KV 快取迴圈，
// 但**支援思考模式（enableThinking）與 prefill**——生產用的 nr-engine.js 寫死 enable_thinking:false 且沒有 prefill，所以這裡另寫，不動生產程式。
// 回傳的 generate(req) 就是 jsonStep／FaCodeAgent.makeBackend 要的形狀：req = {messages, maxTokens, prefill, enableThinking, timeoutMs}，回傳字串
// （關思考且有 prefill 時，回傳的字串包含 prefill——jsonStep 的約定；開思考時不帶 prefill，與 jsonStep 一致）。
//   makeNativeGenerate({modelDir, ortDir, threads, sampling}) → generate；generate.stats＝{calls, promptTokens, newTokens, ms}
//   modelDir：含 tokenizer.json 與 onnx/model_quantized.onnx；ortDir：含 node_modules/onnxruntime-node（建議 1.22.0，與桌面版 WASM 的 ORT-web 同版本，逐 logit 相同）
const fs = require('fs'); const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { applyTemplate } = require(path.join(REPO, 'nr-template.js')); const { createTokenizer } = require(path.join(REPO, 'nr-tokenizer.js')); const { validateGen, pickToken, makeRng } = require(path.join(REPO, 'nr-gen-params.js'));
const EOS = [151645, 151643];

function makeNativeGenerate(o) {
    // 模型維度從 config.json 讀（Qwen3-0.6B：28 層／8 KV 頭／128；Qwen2.5-Coder-0.5B：24／2／64）；Qwen2 系列沒有思考區塊，提示不補 <think>
    let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(o.modelDir, 'config.json'), 'utf8')); } catch (e) { /* 沒有就用 Qwen3-0.6B 預設 */ }
    const LAYERS = cfg.num_hidden_layers || 28, KV = cfg.num_key_value_heads || 8, HD = cfg.head_dim || (cfg.hidden_size && cfg.num_attention_heads ? cfg.hidden_size / cfg.num_attention_heads : 128); const noThinkTag = cfg.model_type === 'qwen2';
    const think0 = (v) => (noThinkTag ? undefined : v);
    const ort = require(path.join(o.ortDir, 'node_modules', 'onnxruntime-node'));
    const tok = createTokenizer(JSON.parse(fs.readFileSync(path.join(o.modelDir, 'tokenizer.json'), 'utf8')));
    let sess = null; const stats = { calls: 0, promptTokens: 0, newTokens: 0, ms: 0 };
    const ensure = async () => sess || (sess = await ort.InferenceSession.create(path.join(o.modelDir, 'onnx', 'model_quantized.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: o.threads || 8 }));
    const clean = (ids) => tok.decode(ids).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
    async function generate(req) {
        const t0 = Date.now(); const s = await ensure(); const think = req.enableThinking === true;
        const gen = validateGen(Object.assign({ do_sample: false }, o.sampling || {})); const rng = gen.do_sample ? makeRng(o.seed != null ? o.seed : 1) : null;
        const prompt = applyTemplate('qwen3-chatml', req.messages || [], { enable_thinking: think0(think ? true : false), prefill: !think && req.prefill ? req.prefill : undefined });
        const promptIds = tok.encode(prompt); const maxNew = Math.max(1, req.maxTokens || 512); const deadline = req.timeoutMs ? t0 + req.timeoutMs : 0;
        const empty = () => { const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out['past_key_values.' + l + '.' + k] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return out; };
        let past = empty(), next = null, out = [], pastLen = 0;
        for (let i = 0; i < maxNew; i++) {
            if (deadline && Date.now() > deadline) { const e = new Error('逾時'); e.timeout = true; stats.ms += Date.now() - t0; throw e; }
            const q = i === 0 ? promptIds : [next]; const len = pastLen + q.length; const feed = Object.assign({}, past);
            feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
            feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
            feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, j) => BigInt(pastLen + j))), [1, q.length]);
            const r = await s.run(feed); const V = r.logits.dims[2], last = (q.length - 1) * V;
            next = pickToken(Float32Array.from(r.logits.data.subarray(last, last + V)), promptIds, out, gen, rng); out.push(next); pastLen = len;
            if (EOS.includes(next)) break;
            past = {}; for (let l = 0; l < LAYERS; l++) { past['past_key_values.' + l + '.key'] = r['present.' + l + '.key']; past['past_key_values.' + l + '.value'] = r['present.' + l + '.value']; }
        }
        stats.calls++; stats.promptTokens += promptIds.length; stats.newTokens += out.length; stats.ms += Date.now() - t0;
        const text = clean(out); return !think && req.prefill ? String(req.prefill) + text : text;
    }
    // ---- 游標：約束解碼用。把「題目＋助手回答到目前為止的程式碼」放進 KV 快取，對一組候選字串打分（語言模型的下一個 token 機率），並提交選中的字串。
    // 候選建成 BPE token 的前綴樹精確打分（見 rank）。不開思考（enable_thinking:false），與生產的原生路徑一致。
    //   openCursor(messages, assistantPrefix) → Promise<cursor>   cursor.rank(suffixes[], {topK}) → [{text, logprob}]   cursor.commit(suffix)   cursor.greedy(maxTokens) → 字串（不提交）
    async function openCursor(messages, assistantPrefix) {
        const s = await ensure(); const gen = validateGen({ do_sample: false });
        const prompt = applyTemplate('qwen3-chatml', messages || [], { enable_thinking: think0(false), prefill: assistantPrefix || '' }); const ids = tok.encode(prompt);
        const empty = () => { const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out['past_key_values.' + l + '.' + k] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return out; };
        const run = async (past, pastLen, q) => { const len = pastLen + q.length; const feed = Object.assign({}, past); feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]); feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]); feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, j) => BigInt(pastLen + j))), [1, q.length]); const r = await s.run(feed); const V = r.logits.dims[2]; const np = {}; for (let l = 0; l < LAYERS; l++) { np['past_key_values.' + l + '.key'] = r['present.' + l + '.key']; np['past_key_values.' + l + '.value'] = r['present.' + l + '.value']; } return { past: np, pastLen: len, rows: Array.from({ length: q.length }, (_, i) => Float32Array.from(r.logits.data.subarray(i * V, (i + 1) * V))) }; };
        const lsm = (row) => { let m = -Infinity; for (let i = 0; i < row.length; i++) if (row[i] > m) m = row[i]; let z = 0; for (let i = 0; i < row.length; i++) z += Math.exp(row[i] - m); const lz = m + Math.log(z); return (id) => row[id] - lz; };
        let st = await run(empty(), 0, ids); let last = st.rows[st.rows.length - 1]; stats.calls++; stats.promptTokens += ids.length;
        return {
            // 精確打分：把所有候選的 BPE token 序列建成前綴樹，沿樹走；每個「有後代」的節點只跑一次前向（共用的前綴——例如縮排空白——只算一次，
            // 它的 logits 一次就給出所有下一個 token 的機率）。分數＝沿路 logprob 的總和；超過 maxForwards 次前向的分支分數記 -Infinity（不會被選到，也不會偏高）。
            async rank(suffixes, o2) {
                // 分詞要自然：候選的完整文字 = 當前行已寫的部分（base，不含尾端空白）＋候選（尾端空白已併進候選）；對「整串」分詞（模型自然的切法，
                // 例如 `input())` 裡的 `())` 是一個 token），取所有候選共同的 token 前綴只跑一次前向，再沿前綴樹精確打分。
                // 已提交進 KV 的只有「完整的行」；當前行永遠重新分詞，不會把已寫的 `(` `)` 用非自然的切法留在上下文裡。
                const maxForwards = (o2 && o2.maxForwards) || 120; const base = (o2 && o2.base) || '';
                const full = suffixes.map((x) => tok.encode(base + x)); const lcp = (() => { if (!full.length) return 0; let n = 0; const m = Math.min(...full.map((e) => e.length)); while (n < m && full.every((e) => e[n] === full[0][n])) n++; return n; })();
                let cur = st, lastRow = last; if (lcp > 0) { cur = await run(st.past, st.pastLen, full[0].slice(0, lcp)); lastRow = cur.rows[cur.rows.length - 1]; }
                const enc = full.map((e) => e.slice(lcp)); const root = { ch: new Map(), ends: [] };
                enc.forEach((e, i) => { let n = root; for (const t of e) { if (!n.ch.has(t)) n.ch.set(t, { ch: new Map(), ends: [] }); n = n.ch.get(t); } n.ends.push(i); });
                const total = suffixes.map(() => -Infinity); let forwards = 0;
                const visit = async (node, row, past, pastLen, acc) => {
                    const f = lsm(row);
                    for (const [t, child] of node.ch) {
                        const lp = acc + f(t); for (const i of child.ends) total[i] = lp;
                        if (child.ch.size) { if (forwards >= maxForwards) continue; forwards++; const r = await run(past, pastLen, [t]); await visit(child, r.rows[0], r.past, r.pastLen, lp); }
                    }
                };
                await visit(root, lastRow, cur.past, cur.pastLen, 0);
                return suffixes.map((t, i) => ({ text: t, logprob: total[i], forwards }));
            },
            async commit(suffix) { const e = tok.encode(suffix); if (!e.length) return; st = await run(st.past, st.pastLen, e); last = st.rows[st.rows.length - 1]; stats.newTokens += e.length; },
            // 貪婪續寫（不提交）：從「已提交的完整行＋base（當前行已寫的部分）」接著寫，模型自然的分詞。o2.stopAtLine：寫完一行（遇到內容之後的換行）就停。
            // cursor.eos 記錄這次是不是因為模型自己輸出了結束符而停。
            async greedy(maxTokens, o2) {
                let cur = { past: st.past, pastLen: st.pastLen }; let row = last; this.eos = false;
                if (o2 && o2.base) { const be = tok.encode(o2.base); if (be.length) { const r0 = await run(st.past, st.pastLen, be); cur = r0; row = r0.rows[r0.rows.length - 1]; } }
                const out = []; for (let i = 0; i < (maxTokens || 8); i++) {
                    let best = 0, bv = -Infinity; for (let k = 0; k < row.length; k++) if (row[k] > bv) { bv = row[k]; best = k; }
                    if (EOS.includes(best)) { this.eos = true; break; } out.push(best);
                    if (o2 && o2.stopAtLine && /\S[^\n]*\n/.test(tok.decode(out))) break;
                    const r = await run(cur.past, cur.pastLen, [best]); cur = r; row = r.rows[0];
                } return tok.decode(out);
            }
        };
    }
    // ---- 受限選擇：對一組選項標籤（各自的第一個 token，例如 A、B、C…）只跑一次前向，取下一個位置機率最高的選項。不生成文字、不開思考。
    //   generate.pick(req, labels[]) → Promise<{index, logprobs[]}>；req 同 generate（messages；prefill 可選）
    async function pick(req, labels) {
        const t0 = Date.now(); const s = await ensure(); const prompt = applyTemplate('qwen3-chatml', req.messages || [], { enable_thinking: think0(false), prefill: req.prefill ? String(req.prefill) : undefined }); const ids = tok.encode(prompt);
        const cand = labels.map((l) => tok.encode(l)[0]); const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out['past_key_values.' + l + '.' + k] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
        out.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]); out.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(ids.length).fill(1n)), [1, ids.length]); out.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, j) => BigInt(j))), [1, ids.length]);
        const r = await s.run(out); const V = r.logits.dims[2]; const row = r.logits.data.subarray((ids.length - 1) * V, ids.length * V);
        let m = -Infinity; for (let i = 0; i < V; i++) if (row[i] > m) m = row[i]; let z = 0; for (let i = 0; i < V; i++) z += Math.exp(row[i] - m); const lz = m + Math.log(z);
        const lps = cand.map((c) => row[c] - lz); let best = 0; for (let i = 1; i < lps.length; i++) if (lps[i] > lps[best]) best = i;
        stats.calls++; stats.promptTokens += ids.length; stats.ms += Date.now() - t0; return { index: best, logprobs: lps };
    }
    generate.pick = pick;
    generate.openCursor = openCursor;
    generate.stats = stats; generate.tokenizer = tok; return generate;
}
module.exports = { makeNativeGenerate };
