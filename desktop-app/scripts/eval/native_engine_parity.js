// 真引擎端到端（不經渲染程序）：nr-host.js → nr-child.js（真推論）跑 16 題，與已驗證的原生結果逐題比對，並列出與 WASM 的差異。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/eval/native_engine_parity.js <執行包資料夾> <模型 onnx> <tokenizer.json> <輸出 json>
// 生成參數與產品端 FaVlm.textGenParams({ deterministic: true }) 相同：{ do_sample: false, repetition_penalty: 1.08 }，最多 16 個新 token（與參考結果相同）。
'use strict';
const fs = require('fs');
const path = require('path');
const [, , PKG, MODEL, TOK, OUT] = process.argv;
const repo = path.join(__dirname, '..', '..');
const prompts = JSON.parse(fs.readFileSync(path.join(repo, 'test-reports', 'native-vs-wasm', 'prompts.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(repo, 'test-reports', 'native-vs-wasm', 'native-det-penalty-ort122.json'), 'utf8'));
const wasm = {};
for (const line of fs.readFileSync(path.join(repo, 'test-reports', 'native-vs-wasm', 'wasm-app-default-threads4.jsonl'), 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(line); wasm[r.id] = r.text; }
const { createNativeRunnerHost } = require(path.join(PKG, 'nr-host.js'));
const GEN = { do_sample: false, repetition_penalty: 1.08 };

(async () => {
    const host = createNativeRunnerHost({ childPath: path.join(PKG, 'nr-child.js'), progressFile: path.join(path.dirname(OUT), 'progress.jsonl'), execPath: process.execPath, log: (s) => console.log('[host] ' + s) });
    const rows = []; const t0 = Date.now();
    for (const p of prompts) {
        const t = Date.now();
        const r = await host.run({ messages: p.messages, gen: GEN, maxTokens: 16, stream: true, modelPath: MODEL, tokenizerPath: TOK, timeoutMs: 300000 });
        const refRow = ref.rows.find((x) => x.id === p.id);
        rows.push({ id: p.id, text: r.text, ms: Date.now() - t, finish_reason: r.finish_reason, match_native_ref: refRow ? r.text === refRow.text : null, match_wasm: wasm[p.id] !== undefined ? r.text === wasm[p.id] : null, ref_text: refRow ? refRow.text : null, wasm_text: wasm[p.id] !== undefined ? wasm[p.id] : null });
        console.log('[parity]', p.id, 'ms', Date.now() - t, 'native==ref', rows[rows.length - 1].match_native_ref, 'native==wasm', rows[rows.length - 1].match_wasm);
    }
    host.dispose('完成');
    const summary = { total_ms: Date.now() - t0, native_vs_ref: rows.filter((r) => r.match_native_ref).length, native_vs_wasm_same: rows.filter((r) => r.match_wasm).length, n: rows.length };
    fs.writeFileSync(OUT, JSON.stringify({ gen: GEN, summary, rows }, null, 1));
    console.log('[parity] 結果', JSON.stringify(summary));
    process.exit(0);
})().catch((e) => { console.log('[parity] 失敗', String((e && e.stack) || e).slice(0, 600)); process.exit(1); });
