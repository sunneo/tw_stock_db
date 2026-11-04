// 執行提供者對照（node，onnxruntime-node）：CPU 與 DirectML 同一模型、同一份 ids（nr-template.js＋tokenizer.js）、貪婪解碼＋重複懲罰 1.08（與桌面版 WASM 路徑相同）。
// 交錯：每題先 CPU、再 DML。記錄：每題耗時、第一步 logits 的 top-1 是否相同、top-5 重疊數、餘弦相似度；
// 封閉題（8 題）以程式算出的標準答案核對答對數（與 colu 相同的出題程式）。
// 逐題進度輸出到 stdout；總時間上限 10 分鐘；結果寫入 test-reports/native-vs-wasm/ep-bench-<時間>.json。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/eval/ort_ep_bench.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ort = require(path.join(process.env.TEMP || os.tmpdir(), 'ort-node-test', 'node_modules', 'onnxruntime-node'));
const { applyTemplate } = require('../../nr-template.js');
const { createTokenizer } = require('../../nr-tokenizer.js');

const TEMP = process.env.TEMP || os.tmpdir();
const ORT_DIR = path.join(TEMP, 'ort-node-test');
const MODEL = path.join(ORT_DIR, 'models', 'qwen3-0.6b-cpu.onnx');
const TOK = JSON.parse(fs.readFileSync(path.join(ORT_DIR, 'tok', 'tokenizer.json'), 'utf8'));
const tok = createTokenizer(TOK);
const PROMPTS = path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'prompts.json');
const OUT = path.join(__dirname, '..', '..', 'test-reports', 'native-vs-wasm', 'ep-bench-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
const LAYERS = 28, KV = 8, HD = 128, MAX_NEW = 16, REP = 1.08, BUDGET_MS = 10 * 60 * 1000;
const EOS = [151645, 151643];

// 封閉題標準答案（與 native_vs_wasm.eval.js 同一出題程式，種子 20261104）
function closedAnswers() {
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const r = rng(20261104); const out = [];
    for (let i = 0; i < 8; i++) {
        let ans; const k = i % 4;
        if (k === 0) { const a = 11 + Math.floor(r() * 38), b = 11 + Math.floor(r() * 38); ans = a * b; }
        else if (k === 1) { const a = 100 + Math.floor(r() * 900), b = 7 + Math.floor(r() * 13); ans = a % b; }
        else if (k === 2) { let x = 1 + Math.floor(r() * 5); for (let j = 0; j < 3; j++) x = 2 * x + 1; ans = 2 * x + 1; }
        else { const a = 2 + Math.floor(r() * 8), b = 2 + Math.floor(r() * 8), c = 2 + Math.floor(r() * 8), d = 1 + Math.floor(r() * 9); ans = (a + b) * c - d; }
        const opts = [ans]; while (opts.length < 4) { const cand = ans + (Math.floor(r() * 19) - 9); if (cand > 0 && opts.indexOf(cand) < 0) opts.push(cand); }
        for (let j = opts.length - 1; j > 0; j--) { const m = Math.floor(r() * (j + 1)); [opts[j], opts[m]] = [opts[m], opts[j]]; }
        out.push({ id: 'c' + i, letter: 'ABCD'[opts.indexOf(ans)] });
    }
    return out;
}
function parseLetter(text) {
    const m = String(text || '').match(/\{[^{}]*\}/); if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o.answer === 'string') return o.answer.trim().toUpperCase().slice(0, 1); } catch (_) { /* */ } }
    const l = String(text || '').match(/\b([A-D])\b/); return l ? l[1] : null;
}
function kvEmpty() { const out = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) out[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]); return out; }
function applyRep(logits, seen) {
    const s = new Set(seen);
    for (const t of s) { const v = logits[t]; logits[t] = v > 0 ? v / REP : v * REP; }
}
function top(arr, k) { const idx = Array.from(arr.keys()); idx.sort((a, b) => arr[b] - arr[a]); return idx.slice(0, k); }
async function gen(sess, promptIds, firstLogitsOut) {
    let past = kvEmpty(), next = null, out = [], pastLen = 0, seen = promptIds.slice();
    const steps = [];
    for (let s = 0; s < MAX_NEW; s++) {
        const q = s === 0 ? promptIds : [next];
        const len = pastLen + q.length;
        const feed = Object.assign({}, past);
        feed.input_ids = new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]);
        feed.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(len).fill(1n)), [1, len]);
        feed.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: q.length }, (_, i) => BigInt(pastLen + i))), [1, q.length]);
        const t = Date.now(); const r = await sess.run(feed); steps.push(Date.now() - t);
        const V = r.logits.dims[2], last = (q.length - 1) * V;
        const row = Float32Array.from(r.logits.data.subarray(last, last + V));
        if (s === 0 && firstLogitsOut) firstLogitsOut.push(Float32Array.from(row));
        applyRep(row, seen);
        let best = 0, bv = -Infinity; for (let i = 0; i < V; i++) if (row[i] > bv) { bv = row[i]; best = i; }
        next = best; out.push(best); seen.push(best); pastLen = len;
        if (EOS.includes(best)) break;
        past = {}; for (let l = 0; l < LAYERS; l++) { past[`past_key_values.${l}.key`] = r[`present.${l}.key`]; past[`past_key_values.${l}.value`] = r[`present.${l}.value`]; }
    }
    return { ids: out, steps };
}
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); }

(async () => {
    const prompts = JSON.parse(fs.readFileSync(PROMPTS, 'utf8'));
    const ans = closedAnswers();
    const t0 = Date.now();
    const sessions = {};
    const load = {};
    for (const ep of ['cpu', 'dml']) {
        const t = Date.now();
        try {
            sessions[ep] = await ort.InferenceSession.create(MODEL, { executionProviders: ep === 'dml' ? ['dml', 'cpu'] : ['cpu'], intraOpNumThreads: 4 });
            load[ep] = { ok: true, ms: Date.now() - t };
        } catch (e) { load[ep] = { ok: false, ms: Date.now() - t, error: String((e && e.message) || e).slice(0, 800) }; }
        console.log('[ep-bench] load', ep, JSON.stringify(load[ep]).slice(0, 200));
    }
    const rows = [];
    for (let i = 0; i < prompts.length; i++) {
        if (Date.now() - t0 > BUDGET_MS) { console.log('[ep-bench] 總時間上限，停止'); break; }
        const p = prompts[i];
        const ids = tok.encode(applyTemplate('qwen3-chatml', p.messages, { enable_thinking: false }));
        const row = { i, id: p.id, group: p.group, prompt_tokens: ids.length };
        const first = {};
        for (const ep of ['cpu', 'dml']) {
            if (!sessions[ep]) { row[ep] = { error: load[ep].error }; continue; }
            const fl = []; const t = Date.now();
            try {
                const g = await gen(sessions[ep], ids, fl);
                row[ep] = { ms: Date.now() - t, step_med: g.steps.slice().sort((a, b) => a - b)[g.steps.length >> 1], text: tok.decode(g.ids).replace(/<\|im_end\|>[\s\S]*$/, ''), ids: g.ids };
                first[ep] = fl[0];
            } catch (e) { row[ep] = { error: String((e && e.message) || e).slice(0, 400) }; }
        }
        if (first.cpu && first.dml) {
            const tc = top(first.cpu, 5), td = top(first.dml, 5);
            row.first_step = { top1_same: tc[0] === td[0], top5_overlap: tc.filter((x) => td.indexOf(x) >= 0).length, cosine: Math.round(cosine(first.cpu, first.dml) * 1e6) / 1e6 };
        }
        if (p.group === 'closed') {
            const a = ans.find((x) => x.id === p.id.replace(/^c/, 'c'));
            const letter = a ? a.letter : null;
            row.correct = {};
            for (const ep of ['cpu', 'dml']) if (row[ep] && row[ep].text != null) row.correct[ep] = parseLetter(row[ep].text) === letter;
        }
        rows.push(row);
        console.log('[ep-bench]', i, p.id, 'cpu', row.cpu && row.cpu.ms, 'dml', row.dml && row.dml.ms, 'first', JSON.stringify(row.first_step || null));
    }
    const out = { started: new Date(t0).toISOString(), load, total_ms: Date.now() - t0, rows };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log('[ep-bench] 結果檔', OUT);
    process.exit(0);
})().catch((e) => { console.log('[ep-bench] 失敗', String((e && e.stack) || e).slice(0, 600)); process.exit(1); });
