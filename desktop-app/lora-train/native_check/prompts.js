#!/usr/bin/env node
/* 產生 6 題測試提示的 token ids（用 app 同一份 nr-template／nr-tokenizer），寫到 ~/fa-work/native_check/ids.json。
 * 這些句子不在 bench 訓練檔（bench-train.jsonl 只有「基準測試問題 N」）裡。
 * 用法：node lora-train/native_check/prompts.js [tokenizer.json]
 */
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..', '..');
const { createTokenizer } = require(path.join(ROOT, 'nr-tokenizer.js'));
const { applyTemplate } = require(path.join(ROOT, 'nr-template.js'));
const TOK = process.argv[2] || path.join(os.homedir(), '.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8/tokenizer.json');
const OUT_DIR = path.join(os.homedir(), 'fa-work/native_check'); fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPTS = [
    '請用三句話說明什麼是 LoRA 微調。',
    '把這句話翻成英文：今天的會議延到下週二舉行。',
    '列出三個適合初學者的 Python 練習題。',
    '解釋為什麼 CPU 上的矩陣乘法通常比 GPU 慢。',
    '幫我寫一封簡短的請假信，說明明天不能參加晨會。',
    'What is the difference between a process and a thread?',
];
const tok = createTokenizer(JSON.parse(fs.readFileSync(TOK, 'utf8')));
const rows = PROMPTS.map((text, i) => {
    const prompt = applyTemplate('qwen3-chatml', [{ role: 'user', content: text }], { enable_thinking: false, prefill: '' });
    const s = typeof prompt === 'string' ? prompt : prompt.text;
    const ids = tok.encode(s);
    return { i, text, prompt: s, ids };
});
fs.writeFileSync(path.join(OUT_DIR, 'ids.json'), JSON.stringify({ tokenizer: TOK, rows }, null, 1));
console.log('wrote', path.join(OUT_DIR, 'ids.json'), rows.map((r) => r.ids.length + ' tok').join(', '));
