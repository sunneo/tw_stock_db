// 原生量測（交錯版）：onnxruntime-node CPU，由 run_interleaved.js 逐題發號（讀 live 資料夾的 turn.json）。
// 用 Electron 的 node 模式執行（ELECTRON_RUN_AS_NODE=1），因為套件只提供 x64，本機 node 是 ia32。
// 參數（環境變數）：NVW_LIVE（live 資料夾）、NVW_MODEL（ONNX 檔）、NVW_TOK（tokenizer.json）、NVW_THREADS（執行緒數）。
// 分詞器（位元組級 BPE）與樣板（enable_thinking=false）與先前 nvw.js 相同。
'use strict';
// onnxruntime-node 安裝在隔離資料夾（不在倉庫），由 NVW_ORT_MODULE 指定絕對路徑
const ort = require(process.env.NVW_ORT_MODULE || 'onnxruntime-node');
const fs = require('fs');
const path = require('path');
const LIVE = process.env.NVW_LIVE;
const MODEL = process.env.NVW_MODEL;
const TOK = process.env.NVW_TOK;
const THREADS = Number(process.env.NVW_THREADS || 4);
const LAYERS = 28, KV = 8, HD = 128, MAX_NEW = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokj = JSON.parse(fs.readFileSync(TOK, 'utf8'));
const bs = []; for (let b = 33; b <= 126; b++) bs.push(b); for (let b = 161; b <= 172; b++) bs.push(b); for (let b = 174; b <= 255; b++) bs.push(b);
const cs = bs.slice(); let nn = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + nn); nn++; }
const b2u = {}; const u2b = {}; bs.forEach((b, i) => { const c = String.fromCharCode(cs[i]); b2u[b] = c; u2b[c] = b; });
const vocab = tokj.model.vocab; const ranks = new Map();
tokj.model.merges.forEach((m, i) => { const pair = Array.isArray(m) ? m : m.split(' '); ranks.set(pair[0] + '\u0001' + pair[1], i); });
const added = tokj.added_tokens.map((t) => ({ content: t.content, id: t.id }));
const addedMap = new Map(added.map((t) => [t.content, t.id]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const addedRe = new RegExp('(' + added.map((t) => reEsc(t.content)).sort((a, b) => b.length - a.length).join('|') + ')');
const preRe = new RegExp(tokj.pre_tokenizer.pretokenizers[0].pattern.Regex, 'gu');
function bpe(word) {
    let parts = Array.from(word);
    while (parts.length > 1) {
        let best = null, bi = -1;
        for (let i = 0; i < parts.length - 1; i++) { const r = ranks.get(parts[i] + '\u0001' + parts[i + 1]); if (r !== undefined && (best === null || r < best)) { best = r; bi = i; } }
        if (bi < 0) break;
        parts = parts.slice(0, bi).concat([parts[bi] + parts[bi + 1]], parts.slice(bi + 2));
    }
    return parts;
}
function encodeChunk(text) {
    const ids = []; preRe.lastIndex = 0; let m;
    while ((m = preRe.exec(text))) {
        const piece = Array.from(Buffer.from(m[0], 'utf8'), (b) => b2u[b]).join('');
        for (const tok of bpe(piece)) { const id = vocab[tok]; if (id === undefined) throw new Error('unknown token ' + tok); ids.push(id); }
    }
    return ids;
}
function encode(text) {
    const out = [];
    for (const part of text.split(addedRe)) { if (!part) continue; if (addedMap.has(part)) out.push(addedMap.get(part)); else out.push(...encodeChunk(part.normalize('NFC'))); }
    return out;
}
const idToTok = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
for (const t of added) idToTok.set(t.id, t.content);
function decode(ids) { const s = ids.map((i) => idToTok.get(i) || '').join(''); return Buffer.from(Array.from(s, (c) => (u2b[c] !== undefined ? u2b[c] : 0))).toString('utf8'); }
function chat(messages) {
    let s = ''; for (const m of messages) s += '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n';
    return s + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
}
function kvEmpty() { const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return out; }
async function gen(sess, promptIds) {
    let past = kvEmpty(), next = null, out = [], steps = [], pastLen = 0;
    for (let s = 0; s < MAX_NEW; s++) {
        const q = s === 0 ? promptIds : [next];
        const len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
        const t = Date.now(); const r = await sess.run(feed); steps.push(Date.now() - t);
        const V = r.logits.dims[2], last = (q.length - 1) * V; let best = 0, bv = -Infinity;
        for (let i = 0; i < V; i++) { const v = r.logits.data[last + i]; if (v > bv) { bv = v; best = i; } }
        next = best; out.push(best); pastLen = len;
        if (best === 151645 || best === 151643) break;
        past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    return { ids: out, steps };
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
(async () => {
    const sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'], intraOpNumThreads: THREADS, interOpNumThreads: 1 });
    // 題目由 WASM 端寫出後才開始
    let items = null;
    while (!(items = readJson(path.join(LIVE, 'prompts.json')))) await sleep(200);
    fs.writeFileSync(path.join(LIVE, 'ready-native.txt'), JSON.stringify({ threads: THREADS, at: new Date().toISOString() }));
    for (let i = 0; i < items.length; i++) {
        let turn = null;
        for (;;) {
            turn = readJson(path.join(LIVE, 'turn.json'));
            if (turn && turn.who === 'stop') break;
            if (turn && turn.who === 'native' && turn.i === i) break;
            await sleep(100);
        }
        if (turn && turn.who === 'stop') break;
        const p = items[i];
        const ids = encode(chat(p.messages));
        const t = Date.now();
        const r = await gen(sess, ids);
        const q_ms = Date.now() - t;
        const text = decode(r.ids).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
        fs.writeFileSync(path.join(LIVE, 'res-native-' + i + '.json'), JSON.stringify({ i, id: p.id, group: p.group, text, ms: q_ms, prompt_tokens: ids.length, gen_tokens: r.ids.length, prefill_ms: r.steps[0], steps_ms: r.steps }));
    }
    const mem = process.memoryUsage();
    fs.writeFileSync(path.join(LIVE, 'native-done.json'), JSON.stringify({ threads: THREADS, rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576) }));
    process.exit(0);
})().catch((e) => { fs.writeFileSync(path.join(LIVE, 'native-error.txt'), String((e && e.stack) || e)); process.exit(1); });
