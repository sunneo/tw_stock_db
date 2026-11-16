'use strict';
// Whisper 編碼器 GPU 接線端到端驗證（真 Chrome，軟體 WebGPU）：用「嵌入的」FA_QWEN_SRC 裡的 whisper.attach／enc／gpu，接到假的 transformers.js 編碼器 session，
// 餵真實 mel 特徵（ORT 的輸入），把 session.run 回傳的 last_hidden_state 與真 ORT 的輸出比對；也驗證原 run 被保留當退路（假 session 的 origRun 會被計數）。
// 用法：node scripts/eval/cudaweb_whisper_attach_browser.js <encoder onnx> <資料夾（feats.f32、ort_out.f32）> [埠=18792]；結果寫 $TMP/cudaweb_whisper_attach_browser.result.json
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..'), [MODEL, DIR] = [process.argv[2], process.argv[3]], PORT = Number(process.argv[4]) || 18792;
if (!MODEL || !DIR) { console.error('用法見檔頭'); process.exit(2); }
const faSrc = fs.readFileSync(path.join(ROOT, 'renderer/src/floating-assistant.js'), 'utf8');
const line = faSrc.split('\n').find((l) => l.startsWith('const FA_QWEN_SRC = '));
const QWEN_SRC = vm.runInNewContext(line.replace(/^const FA_QWEN_SRC = /, '(').replace(/;\s*$/, ')'));
const PAGE = `<!doctype html><meta charset="utf-8"><title>whisper 接線驗證</title><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/qwen_src.js"></script>
<script>
(async () => {
  const R = { pass: false }; const out = document.getElementById('out');
  try {
    const M = (new Function(window.FA_QWEN_SRC))();
    const bytes = new Uint8Array(await (await fetch('/model')).arrayBuffer()); const f32 = async (n) => new Float32Array(await (await fetch('/' + n)).arrayBuffer());
    const feats = await f32('feats.f32'), ref = await f32('ort_out.f32');
    class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
    let origCalls = 0; const sess = { async run() { origCalls++; return { last_hidden_state: new Tensor('float32', new Float32Array(1500 * 512), [1, 1500, 512]) }; } };
    const t0 = performance.now(); const enc = M.whisper.enc.loadEncoder(bytes); const ops = M.whisper.gpu.makeWhisperOps({ navigator });
    const notes = []; const h = M.whisper.attach.attach({ sess, enc, WE: M.whisper.enc, ops, say: (t) => notes.push(t) });
    const r = await sess.run({ input_features: new Tensor('float32', feats, [1, 80, 3000]) });
    const o = r.last_hidden_state; const cmp = (x, y) => { let d = 0, n = 0, dot = 0, na = 0, mx = 0, md = 0; for (let i = 0; i < y.length; i++) { d += (x[i] - y[i]) ** 2; n += y[i] ** 2; dot += x[i] * y[i]; na += x[i] ** 2; mx = Math.max(mx, Math.abs(y[i])); md = Math.max(md, Math.abs(x[i] - y[i])); } return { relL2: Math.sqrt(d / n), cos: dot / Math.sqrt(na * n), maxRel: md / mx }; };
    R.vsOrt = cmp(o.data, ref); R.vsCpuRef = cmp(o.data, await f32('cpu_out.f32'));
    R.dims = o.dims; R.ctorOk = o instanceof Tensor; R.gpu = h.gpu; R.origCalls = origCalls; R.tiers = h.stat.tiers; R.ms = Math.round(performance.now() - t0); R.notes = notes;
    // 逐層教師強迫已在 cudaweb_whisper_gpu_check.js 驗過（最大相對 ≤ 7.7e-3）。整條自由跑受動態量化混沌放大：同樣數學的 JS CPU 參考對 ORT 就是 relL2 5.7e-2、cos 0.9984（cudaweb_whisper_check.js 的 cpu_out）。
    // 通過：GPU、CPU 參考、ORT 三者互相都落在同一個雜訊球內（兩兩 relL2 < 0.1，對 ORT 另要 cos > 0.995；實測都約 5.6e-2、cos 0.9984）、全 T1、沒退回原 run。同數學的 GPU 與 CPU 參考之間也有 5.6e-2——不是 GPU 算錯，是混沌放大
    R.pass = R.ctorOk && R.gpu === true && origCalls === 0 && R.vsCpuRef.relL2 < 0.1 && R.vsOrt.relL2 < 0.1 && R.vsOrt.cos > 0.995 && Object.values(R.tiers).every((x) => /^T1/.test(x));
  } catch (e) { R.error = String((e && e.stack) || e); }
  document.title = R.pass ? '驗證完成：通過' : '驗證完成：未通過'; out.textContent = JSON.stringify(R, null, 1); await fetch('/result', { method: 'POST', body: JSON.stringify(R) });
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_whisper_attach_browser.result.json');
const srv = http.createServer((req, res) => {
  const send = (t, b) => { res.writeHead(200, { 'Content-Type': t }); res.end(b); };
  if (req.url === '/') return send('text/html; charset=utf-8', PAGE);
  if (req.url === '/gpu_core.js') return send('text/javascript', fs.readFileSync(path.join(ROOT, 'renderer/src/gpu/gpu_core.js')));
  if (req.url === '/qwen_src.js') return send('text/javascript', 'window.FA_QWEN_SRC = ' + JSON.stringify(QWEN_SRC) + ';');
  if (req.url === '/model') return send('application/octet-stream', fs.readFileSync(MODEL));
  if (/^\/(feats|ort_out|cpu_out)\.f32$/.test(req.url)) return send('application/octet-stream', fs.readFileSync(path.join(DIR, req.url.slice(1))));
  if (req.method === 'POST' && req.url === '/result') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { fs.writeFileSync(RESULT, b); res.writeHead(200); res.end('ok'); }); return; }
  if (req.url === '/quit') { res.writeHead(200); res.end('bye'); srv.close(() => process.exit(0)); return; }
  res.writeHead(404); res.end('no');
});
srv.listen(PORT, '127.0.0.1', () => console.log('http://127.0.0.1:' + PORT + '/'));
