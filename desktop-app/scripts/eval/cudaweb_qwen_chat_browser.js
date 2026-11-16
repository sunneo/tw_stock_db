'use strict';
// 產品「一般聊天 GPU 整段解碼」端到端驗證（真 Chrome，軟體 WebGPU）：頁面用「嵌入的」FA_QWEN_SRC（floating-assistant.js 裡的那份）、
// FaLlmWeb 分詞器、FaVlm.nativeToolMessages、qwen3-chatml 樣板，走與 _qwenGpuChat 相同的流程貪婪生成，對 cudaweb_qwen_chat_ref.js 的 ORT（原生引擎）參考。
// 用法：node scripts/eval/cudaweb_qwen_chat_browser.js <ref.json> [埠=18791]；結果寫 $TMP/cudaweb_qwen_chat_browser.result.json；/quit 結束。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..'), PORT = Number(process.argv[3]) || 18791;
const refs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = process.env.FA_BASE || path.join(os.homedir(), '.config', 'floating-assistant-desktop');
const dir = path.join(base, 'native-models', 'qwen3-0.6b-q8');
const faSrc = fs.readFileSync(path.join(ROOT, 'renderer/src/floating-assistant.js'), 'utf8');
const line = faSrc.split('\n').find((l) => l.startsWith('const FA_QWEN_SRC = ')); if (!line) throw new Error('找不到 FA_QWEN_SRC');
const QWEN_SRC = vm.runInNewContext(line.replace(/^const FA_QWEN_SRC = /, '(').replace(/;\s*$/, ')'));
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE = `<!doctype html><meta charset="utf-8"><title>聊天 GPU 解碼驗證</title><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/llm_web_core.js"></script><script src="/vlm_core.js"></script><script src="/qwen_src.js"></script>
<script>
(async () => {
  const out = document.getElementById('out'); const log = (s) => { out.textContent += '\\n' + s; fetch('/log', { method: 'POST', body: s }).catch(() => {}); };
  const R = { cases: [], pass: false };
  try {
    const M = (new Function(window.FA_QWEN_SRC))();
    const FaVlm = window.FaVlm || self.FaVlm; const tokj = await (await fetch('/tokenizer')).json(); const tok = self.FaLlmWeb.createTokenizer(tokj);
    const bytes = new Uint8Array(await (await fetch('/model')).arrayBuffer()); log('模型 ' + bytes.length);
    const ad = await navigator.gpu.requestAdapter(); const need = {}; for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize']) need[k] = Math.min(ad.limits[k], 1 << 30);
    const dev = await ad.requestDevice({ requiredLimits: need });
    const eng = await M.gpu.createGpuEngine(dev, M.decode.loadWeights(bytes), { maxT: 2048, maxM: 256 }); log('引擎就緒');
    const REFS = ${JSON.stringify(refs)};
    for (const r of REFS) {
      const tm = FaVlm.nativeToolMessages(r.messages, r.tools); if (!tm.ok) throw new Error(tm.why);
      const prompt = M.tpl.applyTemplate('qwen3-chatml', tm.messages, { enable_thinking: false, prefill: r.prefill || undefined });
      const ids = tok.encode(prompt); const t = performance.now();
      const g = await M.chat.generate({ engine: eng, tok, promptIds: ids, maxNew: r.ortIds.length, gen: { do_sample: false }, stepTimeoutMs: 0 });
      const item = { name: r.name, promptLen: ids.length, gpuIds: g.ids, ortIds: r.ortIds, eq: JSON.stringify(g.ids) === JSON.stringify(r.ortIds), gpuText: g.text, ortText: r.ortText, ms: Math.round(performance.now() - t), gpu: g.gpu };
      R.cases.push(item); log(JSON.stringify(item));
    }
    // 取樣路徑（讀回 logits、主機端取樣）：同一 seed 兩次結果相同，且產生了可解碼的文字
    const tm = FaVlm.nativeToolMessages(REFS[0].messages, []); const ids = tok.encode(M.tpl.applyTemplate('qwen3-chatml', tm.messages, { enable_thinking: false }));
    const gen = { do_sample: true, temperature: 0.4, top_p: 0.9, repetition_penalty: 1.08 };
    const s1 = await M.chat.generate({ engine: eng, tok, promptIds: ids, maxNew: 6, gen, seed: 7, stepTimeoutMs: 0 }), s2 = await M.chat.generate({ engine: eng, tok, promptIds: ids, maxNew: 6, gen, seed: 7, stepTimeoutMs: 0 });
    R.sampled = { ids: s1.ids, text: s1.text, repeatable: JSON.stringify(s1.ids) === JSON.stringify(s2.ids), sampledFlag: s1.gpu.sampled }; log('取樣 ' + JSON.stringify(R.sampled));
    R.eqCount = R.cases.filter((x) => x.eq).length + '/' + R.cases.length;
    R.pass = R.cases.length > 0 && R.cases.every((x) => x.eq) && R.sampled.repeatable && R.sampled.sampledFlag;
  } catch (e) { R.error = String((e && e.stack) || e); }
  document.title = R.pass ? '驗證完成：通過' : '驗證完成：未通過';
  out.textContent = JSON.stringify(R, null, 1); await fetch('/result', { method: 'POST', body: JSON.stringify(R) }).catch(() => {});
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_qwen_chat_browser.result.json');
const srv = http.createServer((req, res) => {
  const send = (t, b) => { res.writeHead(200, { 'Content-Type': t }); res.end(b); };
  if (req.method === 'GET' && req.url === '/') return send('text/html; charset=utf-8', PAGE);
  if (req.url === '/gpu_core.js') return send('text/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/llm_web_core.js') return send('text/javascript', rd('renderer/src/studio/llm_web_core.js'));
  if (req.url === '/vlm_core.js') return send('text/javascript', rd('renderer/src/vlm/vlm_core.js'));
  if (req.url === '/qwen_src.js') return send('text/javascript', 'window.FA_QWEN_SRC = ' + JSON.stringify(QWEN_SRC) + ';');
  if (req.url === '/tokenizer') return send('application/json', fs.readFileSync(path.join(dir, 'tokenizer.json')));
  if (req.url === '/model') { const p = path.join(dir, 'onnx', 'model_quantized.onnx'); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(p).size }); return fs.createReadStream(p).pipe(res); }
  if (req.method === 'POST' && (req.url === '/result' || req.url === '/log')) { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { if (req.url === '/result') { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); } else console.log('[頁面] ' + b.slice(0, 300)); res.writeHead(200); res.end('ok'); }); return; }
  if (req.url === '/quit') { res.writeHead(200); res.end('bye'); srv.close(() => process.exit(0)); return; }
  res.writeHead(404); res.end('no');
});
srv.listen(PORT, '127.0.0.1', () => console.log('http://127.0.0.1:' + PORT + '/'));
