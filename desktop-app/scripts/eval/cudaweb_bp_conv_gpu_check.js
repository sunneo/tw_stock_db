'use strict';
// Basic Pitch（nmp.onnx）的 32 個 Conv：每個以 ORT 實際看到的輸入，走共用 conv_ops.conv2d（T1 WGSL）重算，對 ORT 的輸出比對。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:18785/）。參考來自 cudaweb_bp_conv_dump.js。
// 通過條件：預填與解碼一步的 logits 相對誤差 < 1e-3、argmax 一致、所有投影都在 T1。
// 用法：node scripts/eval/cudaweb_bp_conv_gpu_check.js <nmp.onnx（未用，保留參數位置）> <cudaweb_bp_conv_dump.js 的 outDir> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [MODEL, REF] = [process.argv[2], process.argv[3]]; // REF = 資料夾（feats.f32、ort_out.f32）
const PORT = Number(process.argv[4]) || 18785;
if (!MODEL || !REF) { console.error('用法：node scripts/eval/cudaweb_bp_conv_gpu_check.js <模型> <dump 資料夾> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>basic pitch conv GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>Basic Pitch 全部 Conv：conv_ops.conv2d（WebGPU）對 ORT</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [] };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const CONV = window.__mods.conv_ops;
    const cases = await (await fetch('/cases.json')).json();
    const rd = async (n) => new Float32Array(await (await fetch('/' + n)).arrayBuffer());
    R.worst = 0; R.layers = {};
    for (const c of cases) {
      const d = c.dims, x = await rd(c.x), w = await rd(c.w), b = c.b ? await rd(c.b) : null, y = await rd(c.y), o = { navigator };
      const t0 = performance.now();
      const g = await CONV.conv2d(x, d.N, d.C, d.H, d.W, w, d.M, d.Cg, d.KH, d.KW, b, c.p, o);
      let df = 0, mx = 0; for (let i = 0; i < y.length; i++) { df = Math.max(df, Math.abs(g[i] - y[i])); mx = Math.max(mx, Math.abs(y[i])); }
      const rel = df / (mx || 1); R.worst = Math.max(R.worst, rel); R.layers[o.lastInfo.layer] = (R.layers[o.lastInfo.layer] || 0) + 1;
      R.cases.push({ dims: [d.C, d.H, d.W, d.M, d.KH + 'x' + d.KW].join(','), strides: c.p.strides.join(','), rel: +rel.toExponential(2), layer: o.lastInfo.layer, reason: o.lastInfo.reason || undefined, ms: Math.round(performance.now() - t0), len: g.length === y.length });
      show();
    }
    R.done = true;
    R.pass = R.worst < 1e-4 && Object.keys(R.layers).length === 1 && !!R.layers.T1 && R.cases.every((c) => c.len);
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_bp_conv_gpu_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'conv_ops'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (/^\/t\d+\.f32$/.test(req.url) || req.url === '/cases.json') { const b = fs.readFileSync(path.join(REF, req.url.slice(1))); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('basic pitch conv GPU 驗證：http://127.0.0.1:' + PORT + '/'));
