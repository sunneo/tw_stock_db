'use strict';
// midigenai 解碼器：投影（MatMulNBits）走真 WebGPU（T1），其餘（RMSNorm、RoPE、注意力、SiLU）仍是 CPU，對 ORT 參考 logits 比對。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:18772/）。參考 logits 來自 cudaweb_midi_decoder_check.js 的第三參數輸出。
// 通過條件：預填與解碼一步的 logits 相對誤差 < 1e-3、argmax 一致、所有投影都在 T1。
// 用法：node scripts/eval/cudaweb_midi_gpu_check.js <midigen 模型> <ORT 參考 json> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [MODEL, REF] = [process.argv[2], process.argv[3]];
const PORT = Number(process.argv[4]) || 18772;
if (!MODEL || !REF) { console.error('用法：node scripts/eval/cudaweb_midi_gpu_check.js <模型> <ORT 參考 json> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>midigen GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>midigenai 解碼器：投影走 WebGPU 對 ORT 參考</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, tiers: {} };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const MD = window.__mods.midi_decoder, G = window.__mods.matmulnbits_gpu;
    const ref = await (await fetch('/ref.json')).json();
    const buf = new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer());
    R.modelBytes = buf.length;
    let t0 = performance.now();
    const model = MD.loadMidiDecoder(buf);
    R.loadMs = performance.now() - t0;
    const tally = (tier) => { R.tiers[tier] = (R.tiers[tier] || 0) + 1; };
    const mm = async (p, X, T) => { const r = await G.matmulNBits(X, T, p.K, p.B, p.S, p.N, { navigator }); tally(r.info.layer); return r.result; };
    const relArg = (a, b) => { let d = 0, m = 0, ia = 0, ib = 0; for (let i = 0; i < b.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); m = Math.max(m, Math.abs(b[i])); if (a[i] > a[ia]) ia = i; if (b[i] > b[ib]) ib = i; } return { rel: d / (m || 1), argJs: ia, argOrt: ib }; };
    t0 = performance.now();
    const pre = await MD.decode(model, ref.pre, null, mm);
    R.prefillMs = performance.now() - t0;
    R.prefill = relArg(pre.logits, Float32Array.from(ref.ortPre));
    show();
    t0 = performance.now();
    const st = await MD.decode(model, ref.step, pre.cache, mm);
    R.stepMs = performance.now() - t0;
    R.step = relArg(st.logits, Float32Array.from(ref.ortStep));
    R.done = true;
    R.pass = R.prefill.rel < 1e-3 && R.step.rel < 1e-3 && R.prefill.argJs === R.prefill.argOrt && R.step.argJs === R.step.argOrt && Object.keys(R.tiers).length === 1 && !!R.tiers.T1;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_midi_gpu_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'onnx_lite', 'matmulnbits_ref', 'matmulnbits_gpu', 'midi_decoder'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/ref.json') return send(200, 'application/json', fs.readFileSync(REF));
  if (req.url === '/model.onnx') { const b = fs.readFileSync(MODEL); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('midigen GPU 驗證：http://127.0.0.1:' + PORT + '/'));
