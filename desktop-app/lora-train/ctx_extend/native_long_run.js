// 在應用程式的原生執行環境（nr-engine.js，onnxruntime-node）上用長上下文跑一次藏密碼，記錄時間與記憶體。
// 用法：node native_long_run.js <model.onnx> <tokenizer.json> <目標權杖數> [輸出json]
// 需要 desktop-app/node_modules 內有 onnxruntime-node（執行包 1.22）。
'use strict';
const fs = require('fs'), path = require('path');
const engine = require(path.join(__dirname, '..', '..', 'nr-engine.js'));
const [modelPath, tokPath, targetStr, outPath] = process.argv.slice(2);
const target = Number(targetStr);
const docs = fs.readdirSync(path.join(__dirname, '..', '..')).filter((f) => /^DESIGN.*\.md$/.test(f)).sort();
let hay = ''; for (const d of docs) { hay += fs.readFileSync(path.join(__dirname, '..', '..', d), 'utf8') + '\n\n'; if (hay.length > target * 4) break; }
const NUM = '48213';
// 以字元估算：Qwen 分詞對中英混合約 1 權杖 ≈ 1.6 字元；實際權杖數以引擎前的編碼為準，下面會逐步縮到目標內
function build(chars) {
  const body = hay.slice(0, chars); const cut = Math.floor(body.length / 2);
  return body.slice(0, cut) + '\nThe pass key is ' + NUM + '. Remember it. ' + NUM + ' is the pass key.\n' + body.slice(cut) + '\nWhat is the pass key mentioned in the text above? Answer with the number only.';
}
(async () => {
  const { createTokenizer } = require(path.join(__dirname, '..', '..', 'nr-tokenizer.js'));
  const tok = createTokenizer(JSON.parse(fs.readFileSync(tokPath, 'utf8')));
  let chars = Math.floor(target * 1.5), text = build(chars), n = tok.encode(text).length;
  for (let i = 0; i < 6 && Math.abs(n - target) > target * 0.03; i++) { chars = Math.floor(chars * target / n); text = build(chars); n = tok.encode(text).length; }
  const t0 = Date.now(); let peak = 0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 500);
  const r = await engine.generate({ modelPath, tokenizerPath: tokPath, threads: 24, messages: [{ role: 'user', content: text }], gen: { do_sample: false }, maxTokens: 12 });
  clearInterval(iv); peak = Math.max(peak, process.memoryUsage().rss);
  const res = { model: modelPath, prompt_tokens: n, answer: r.text, pass: r.text.includes(NUM), seconds: (Date.now() - t0) / 1000, peak_rss_mb: Math.round(peak / 1048576) };
  console.log(JSON.stringify(res)); if (outPath) fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
