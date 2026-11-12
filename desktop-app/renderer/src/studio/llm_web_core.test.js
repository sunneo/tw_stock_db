// node renderer/src/studio/llm_web_core.test.js
// 分詞器：與桌面 nr-tokenizer.js 逐位元相同（需要 FA_NR_TOKENIZER 指向 nr-tokenizer.js，否則只測 round-trip）
// 模型推論：見 ~/fa/lora-export-work/driver/web_ort122_check.js（用執行包的 onnxruntime-node 1.22 跑 q8 對照 check.json）
const fs = require('fs'), path = require('path');
const W = require('./llm_web_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const TOKDIR = process.env.FA_TOKENIZER_DIR || path.join(process.env.HOME, 'fa/lora-export-work/studio-onnx-20261112-125938/onnx');
const tokPath = path.join(TOKDIR, 'tokenizer.json');
if (!fs.existsSync(tokPath)) { console.log('SKIP 沒有 tokenizer.json（設定 FA_TOKENIZER_DIR）'); process.exit(0); }
const tj = JSON.parse(fs.readFileSync(tokPath, 'utf8'));
const tok = W.createTokenizer(tj);
const samples = ['台北在哪個國家？', 'def add(a, b):', 'Choose the best tool: A. search B. calc\nAnswer:', '{"name": "get_weather", "arguments": {"city": "Taipei"}}', 'The quick brown fox jumps over', '  多個   空白\t與換行\n\n結尾', "I'm here, it's 2026's \u{1F600} test"];
for (const s of samples) {
    const ids = tok.encode(s);
    check('round-trip：' + JSON.stringify(s).slice(0, 30), tok.decode(ids) === s, { ids: ids.slice(0, 10), back: tok.decode(ids) });
}
if (process.env.FA_NR_TOKENIZER && fs.existsSync(process.env.FA_NR_TOKENIZER)) {
    const NR = require(path.resolve(process.env.FA_NR_TOKENIZER));
    const ref = NR.createTokenizer(tj);
    for (const s of samples) check('與 nr-tokenizer 逐位元相同：' + JSON.stringify(s).slice(0, 30), JSON.stringify(tok.encode(s)) === JSON.stringify(ref.encode(s)), { web: tok.encode(s).slice(0, 8), nr: ref.encode(s).slice(0, 8) });
} else console.log('NOTE 未設 FA_NR_TOKENIZER，跳過與 nr-tokenizer 的對照');
check('specials 含 <|im_start|>', tok.specials.indexOf('<|im_start|>') >= 0, tok.specials.slice(0, 5));
console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
