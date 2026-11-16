'use strict';
// 產品「一般聊天 GPU 整段解碼」的參考：用桌面版原生子程序同一份引擎（nr-engine＋onnxruntime-node，貪婪）生成，輸出 json 給 cudaweb_qwen_chat_browser.js 對拍。
// 用法：node scripts/eval/cudaweb_qwen_chat_ref.js <out.json> [maxTokens=10]；環境變數 FA_BASE（預設 ~/.config/floating-assistant-desktop）。
const fs = require('fs'), os = require('os'), path = require('path');
const base = process.env.FA_BASE || path.join(os.homedir(), '.config', 'floating-assistant-desktop');
const rt = path.join(base, 'native-runtime', '1.22.0-1');
const E = require(path.join(rt, 'nr-engine.js'));
const FaVlm = require('../../renderer/src/vlm/vlm_core.js');
const mp = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx'), tp = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'tokenizer.json');
const N = Number(process.argv[3]) || 10;
const tool = { type: 'function', function: { name: 'ref_lookup', description: '查參考資料', parameters: { type: 'object', properties: { q: { type: 'string', description: '關鍵字' } }, required: ['q'] } } };
const CASES = [
  { name: 'plain', messages: [{ role: 'system', content: '你是一個友善、簡潔的助理。請用繁體中文回答。' }, { role: 'user', content: '你好，請用一句話介紹台北。' }], tools: [], prefill: '' },
  { name: 'tools', messages: [{ role: 'user', content: '幫我查一下 Qwen3 是什麼' }], tools: [tool], prefill: '' },
  { name: 'prefill', messages: [{ role: 'user', content: '1+1 等於多少？' }], tools: [], prefill: '答案是' },
];
(async () => {
  const out = [];
  for (const c of CASES) {
    const tm = FaVlm.nativeToolMessages(c.messages, c.tools); if (!tm.ok) throw new Error(tm.why);
    const r = await E.generate({ modelPath: mp, tokenizerPath: tp, template: 'qwen3-chatml', messages: tm.messages, prefill: c.prefill || undefined, gen: { do_sample: false }, maxTokens: N, threads: 4 });
    out.push(Object.assign({}, c, { ortIds: r.ids, ortText: r.text, finish: r.finish_reason })); console.log(c.name, JSON.stringify(r.text));
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out)); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
