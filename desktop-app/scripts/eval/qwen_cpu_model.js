// scripts/eval/qwen_cpu_model.js — 真模型（qwen3-0.6b q8，純 JS CPU 參考引擎 qwen_decode.js，貪婪解碼）的共用載入器。
// 給 news_real_run.js 同樣的 tokenizer 與對話格式（makeTokenizer 從 news_real_run.js 搬過來；news_real_run.js 保持不動）。
const fs = require('fs'); const path = require('path'); const os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const Q = require(path.join(ROOT, 'renderer/src/gpu/qwen_decode.js'));
const MODEL_DIR = path.join(os.homedir(), '.config', 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8');

function makeTokenizer(json) {
    const vocab = json.model.vocab; const inv = []; for (const k of Object.keys(vocab)) inv[vocab[k]] = k;
    const ranks = new Map(); json.model.merges.forEach((m, i) => ranks.set(Array.isArray(m) ? m.join(' ') : m, i));
    const added = (json.added_tokens || []).map((t) => ({ content: t.content, id: t.id }));
    const b2u = (() => { const bs = []; for (let i = 33; i < 127; i++) bs.push(i); for (let i = 161; i < 173; i++) bs.push(i); for (let i = 174; i < 256; i++) bs.push(i);
        const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
        const m = {}; bs.forEach((b, i) => { m[b] = String.fromCharCode(cs[i]); }); return m; })();
    const u2b = {}; for (const b of Object.keys(b2u)) u2b[b2u[b]] = Number(b);
    const PRE = /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
    function bpe(word) {
        let parts = [...word];
        for (;;) {
            let best = -1, bi = -1;
            for (let i = 0; i < parts.length - 1; i++) { const r = ranks.get(parts[i] + ' ' + parts[i + 1]); if (r !== undefined && (best < 0 || r < best)) { best = r; bi = i; } }
            if (bi < 0) break;
            parts.splice(bi, 2, parts[bi] + parts[bi + 1]);
        }
        return parts;
    }
    function encodeChunk(text) {
        const ids = [];
        for (const piece of text.match(PRE) || []) {
            const s = Array.from(Buffer.from(piece, 'utf8'), (b) => b2u[b]).join('');
            for (const t of bpe(s)) { if (vocab[t] === undefined) throw new Error('詞元不在詞表：' + t); ids.push(vocab[t]); }
        }
        return ids;
    }
    function encode(text) {
        const out = []; let rest = String(text); // 先切出特殊詞元（<|im_start|> 等）
        while (rest.length) {
            let hit = null; for (const a of added) { const i = rest.indexOf(a.content); if (i >= 0 && (!hit || i < hit.i || (i === hit.i && a.content.length > hit.a.content.length))) hit = { i, a }; }
            if (!hit) { out.push(...encodeChunk(rest)); break; }
            if (hit.i > 0) out.push(...encodeChunk(rest.slice(0, hit.i)));
            out.push(hit.a.id); rest = rest.slice(hit.i + hit.a.content.length);
        }
        return out;
    }
    function decode(ids) {
        const s = ids.map((i) => inv[i] || '').join('');
        const bytes = Buffer.from(Array.from(s, (c) => (u2b[c] !== undefined ? u2b[c] : 63)));
        return bytes.toString('utf8');
    }
    // 特殊詞元（<|im_end|> 等）在 added_tokens 裡，不在 model.vocab
    const special = (c) => { const t = added.find((x) => x.content === c); if (!t) throw new Error('找不到特殊詞元 ' + c); return t.id; };
    return { encode, decode, vocab, special };
}

// 回傳給 _planLocalSummarize 等用的 M：{ model, ensure, gen(req) }；gen 只回答文字（思考區塊去掉）
async function loadModel(opts) {
    const o = opts || {}; const log = o.log || (() => {});
    const tok = makeTokenizer(JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'tokenizer.json'), 'utf8')));
    const bin = fs.readFileSync(path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx'));
    const W = Q.loadWeights(new Uint8Array(bin.buffer, bin.byteOffset, bin.length));
    const engine = Q.createCpuEngine(W, { maxT: 1024 });
    log('模型載入完成');
    const IM_END = tok.special('<|im_end|>');
    const chat = (messages) => messages.map((m) => '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n').join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    return {
        model: { id: 'qwen3-0.6b' },
        ensure: async () => null,
        gen: async (a) => {
            engine.reset();
            const ids = tok.encode(chat(a.messages));
            const out = await Q.greedy(engine, ids, Math.min(a.maxTokens || 200, 200), [IM_END]);
            return tok.decode(out).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        },
    };
}

module.exports = { loadModel, makeTokenizer, MODEL_DIR };
