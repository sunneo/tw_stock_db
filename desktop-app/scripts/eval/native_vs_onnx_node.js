// 原生端：Qwen2 位元組級 BPE（讀快取的 tokenizer.json）＋Qwen3 對話樣板（思考關）＋貪婪解碼 16 步（onnxruntime-node CPU）。
// 用法：electron.exe nvw.js <prompts.json> <wasm.jsonl> <threads> <out.json>
const ort = require('onnxruntime-node');
const fs = require('fs');
const [,, PROMPTS, WASM, THREADS, OUT] = process.argv;
const tokj = JSON.parse(fs.readFileSync('tok/tokenizer.json', 'utf8'));
const LAYERS = 28, KV = 8, HD = 128, MAX_NEW = 16;
// 位元組↔字元對照（GPT-2 bytes_to_unicode）
const bs = []; for (let b = 33; b <= 126; b++) bs.push(b); for (let b = 161; b <= 172; b++) bs.push(b); for (let b = 174; b <= 255; b++) bs.push(b);
const cs = bs.slice(); let n = 0; for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
const b2u = {}; const u2b = {}; bs.forEach((b, i) => { const c = String.fromCharCode(cs[i]); b2u[b] = c; u2b[c] = b; });
const vocab = tokj.model.vocab; const ranks = new Map(); tokj.model.merges.forEach((m, i) => { const pair = Array.isArray(m) ? m : m.split(' '); ranks.set(pair[0] + '\u0001' + pair[1], i); });
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
  const out = []; for (const part of text.split(addedRe)) { if (!part) continue; if (addedMap.has(part)) out.push(addedMap.get(part)); else out.push(...encodeChunk(part.normalize('NFC'))); }
  return out;
}
const idToTok = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
for (const t of added) idToTok.set(t.id, t.content);
function decode(ids) { const s = ids.map((i) => idToTok.get(i) || '').join(''); const bytes = Buffer.from(Array.from(s, (c) => u2b[c] !== undefined ? u2b[c] : 0)); return bytes.toString('utf8'); }
function chat(messages) {
  let s = ''; for (const m of messages) s += '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n';
  if (process.env.NVW_TEMPLATE === 'plain') return s + '<|im_start|>assistant\n';
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
    if (best === 151645 || best === 151643) break; // 與 WASM 路徑相同：遇到 <|im_end|>／<|endoftext|> 即停止
    past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
  }
  return { ids: out, steps };
}
(async () => {
  const prompts = JSON.parse(fs.readFileSync(PROMPTS, 'utf8'));
  const wasmRows = fs.readFileSync(WASM, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const wasmById = new Map(wasmRows.map((r) => [r.id, r]));
  const threads = Number(THREADS) || 4;
  const sess = await ort.InferenceSession.create('models/qwen3-0.6b-cpu.onnx', { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1 });
  const rows = []; const t0 = Date.now();
  for (const p of prompts) {
    const ids = encode(chat(p.messages));
    const tq = Date.now();
    const r = await gen(sess, ids);
    const q_total_ms = Date.now() - tq;
    const text = decode(r.ids).replace(/<\|im_end\|>[\s\S]*$/, '').replace(/<\|endoftext\|>[\s\S]*$/, '');
    const w = wasmById.get(p.id);
    const wtext = w && w.text != null ? String(w.text) : null;
    const steps = r.steps.slice().sort((a, b) => a - b);
    rows.push({ id: p.id, group: p.group, prompt_tokens: ids.length, native_text: text, wasm_text: wtext, same: wtext === text, step_median_ms: steps[Math.floor(steps.length / 2)], prefill_ms: r.steps[0], q_total_ms, gen_tokens: r.ids.length, wasm_ms: w ? w.ms : null, wasm_err: w ? w.err : null });
    console.log('[nvw]', p.id, 'prompt', ids.length, 'step_med', steps[Math.floor(steps.length / 2)], 'same', wtext === text);
  }
  const mem = process.memoryUsage();
  fs.writeFileSync(OUT, JSON.stringify({ threads, total_ms: Date.now() - t0, rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), rows }, null, 1));
  console.log('[nvw] done', OUT);
})().catch((e) => { console.log('ERR', String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
