'use strict';
// 端到端：真 ORT＋真模型，貪婪生成 24 個詞元，比較「原路徑」與「隱藏狀態變體＋外部 lm_head」的文字與詞元是否相同，
// 並驗證失敗時自動退回（head 丟錯、回傳長度不對）仍能完成且結果相同。外部 lm_head 這裡用 CPU 參考版（q8lmRef）代替 GPU，
// 因為 GPU 版需要瀏覽器；GPU 與參考版的一致性另由 cudaweb_infer_browser.js 驗證。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_head_e2e.js
const fs = require('fs'), path = require('path');
const engine = require('../../nr-engine.js');
const lite = require('../../nr-onnx-lite.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
const modelPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const tokPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'tokenizer.json');
(async () => {
  engine._testHooks().setOrt(require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node')));
  const m = lite.parseModel(fs.readFileSync(modelPath));
  const q = (n) => { const b = lite.tensorBytes(m, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const W = q('model.embed_tokens.weight_quantized'), zp = lite.scalar(m, 'model.embed_tokens.weight_zero_point'), sc = lite.scalar(m, 'model.embed_tokens.weight_scale');
  const V = engine.VOCAB, K = 1024;
  const cpuHead = async (h) => Float32Array.from(ops.q8lmRef(h, W, zp, V, K, Math.fround(sc)));
  const common = { modelPath, tokenizerPath: tokPath, messages: [{ role: 'user', content: '用一句話介紹台北。' }], gen: { do_sample: false }, maxTokens: 24, threads: 4 };
  const out = { cases: [] };
  const run = async (name, head) => { const t0 = Date.now(); const r = await engine.generate(Object.assign({}, common, head ? { head } : {})); out.cases.push({ name, ms: Date.now() - t0, text: r.text, ids: r.ids, head: r.head }); return r; };
  const a = await run('原路徑', null);
  const b = await run('變體＋外部 lm_head（CPU 參考版代替 GPU）', cpuHead);
  let calls = 0;
  const c = await run('head 第 5 次起丟錯→自動退回', async (h) => { if (++calls > 4) throw new Error('模擬 GPU 失效'); return cpuHead(h); });
  const d = await run('head 回傳長度錯誤→自動退回', async () => new Float32Array(10));
  const same = (x, y) => JSON.stringify(x.ids) === JSON.stringify(y.ids);
  out.checks = [
    { name: '外部 lm_head 與原路徑詞元相同', pass: same(a, b) && b.head.used === a.ids.length && !b.head.fallback },
    { name: '中途失敗自動退回、詞元仍相同', pass: same(a, c) && c.head.used === 4 && /GPU lm_head 失敗/.test(c.head.fallback) },
    { name: '長度錯誤自動退回、詞元仍相同', pass: same(a, d) && d.head.used === 0 && /長度/.test(d.head.fallback) },
  ];
  out.pass = out.checks.every((x) => x.pass);
  fs.writeFileSync(path.join(__dirname, 'cudaweb_head_e2e.result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ checks: out.checks, ms: out.cases.map((x) => x.ms), head: out.cases.map((x) => x.head), text: a.text }));
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
