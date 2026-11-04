// 原生樣板驗收（node）：用 native-runner/template.js 與 native-runner/tokenizer.js 產生文字與 input ids，
// 與 WASM 側（template_validate.eval.js 取得的 transformers.js 結果）逐組比對。
// 比對項目：(1) 樣板文字完全相同；(2) input ids 完全相同。不同時列出第一個差異位置與兩邊的文字片段。
// 用法：node scripts/eval/template_validate.js [WASM 結果 JSON] [分詞器 tokenizer.json]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyTemplate } = require('../../native-runner/template.js');
const { createTokenizer } = require('../../native-runner/tokenizer.js');

const TEMP = process.env.TEMP || os.tmpdir();
const WASM = process.argv[2] || path.join(TEMP, 'nvw-out', 'template-wasm.json');
const TOK = process.argv[3] || path.join(TEMP, 'ort-node-test', 'tok', 'tokenizer.json');
const CASES = path.join(__dirname, 'template_cases.json');

const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
const wasm = JSON.parse(fs.readFileSync(WASM, 'utf8'));
const tok = createTokenizer(JSON.parse(fs.readFileSync(TOK, 'utf8')));
const wById = new Map(wasm.rows.map((r) => [r.id, r]));

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}
let pass = 0; const fails = [];
for (const c of cases) {
    const w = wById.get(c.id);
    if (!w) { fails.push({ id: c.id, why: 'WASM 結果缺少此題' }); continue; }
    const nText = applyTemplate('qwen3-chatml', c.messages, { enable_thinking: c.enable_thinking, prefill: c.prefill || '' });
    const nIds = tok.encode(nText);
    const textOk = nText === w.text;
    const idsOk = nIds.length === w.ids.length && nIds.every((v, i) => v === w.ids[i]);
    if (textOk && idsOk) { pass++; continue; }
    const d = firstDiff(nText, w.text);
    const di = firstDiff(nIds.map(String), w.ids.map(String));
    fails.push({
        id: c.id,
        text_same: textOk,
        ids_same: idsOk,
        text_first_diff_char: textOk ? null : d,
        native_text_near: textOk ? null : JSON.stringify(nText.slice(Math.max(0, d - 20), d + 20)),
        wasm_text_near: textOk ? null : JSON.stringify(w.text.slice(Math.max(0, d - 20), d + 20)),
        ids_first_diff_pos: idsOk ? null : di,
        native_id_at_diff: idsOk ? null : nIds[di],
        wasm_id_at_diff: idsOk ? null : w.ids[di],
        native_len: nIds.length, wasm_len: w.ids.length,
    });
}
console.log(JSON.stringify({ total: cases.length, pass, fail: fails.length, wasm_file: WASM, tokenizer: TOK, vocab_size: tok.vocabSize }, null, 1));
for (const f of fails) console.log('FAIL', JSON.stringify(f));
process.exit(fails.length ? 1 : 0);
