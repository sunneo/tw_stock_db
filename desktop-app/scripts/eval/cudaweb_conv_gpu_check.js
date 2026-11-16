'use strict';
// 共用卷積核心（renderer/src/gpu/conv_ops.js）的 WebGPU（T1）路徑：用 MOSS codec 的真實卷積案例（cudaweb_conv_dump.js 產生）比對。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:<埠>/）。結果寫系統暫存的 cudaweb_conv_gpu_check.result.json。
// 通過條件：每個案例的相對誤差 < 1e-4，且 layer 為 T1（WebGPU）。
// 用法：node scripts/eval/cudaweb_conv_gpu_check.js <案例資料夾> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CASES = process.argv[2];
const PORT = Number(process.argv[3]) || 18778;
if (!CASES) { console.error('用法：node scripts/eval/cudaweb_conv_gpu_check.js <案例資料夾> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';
const MODS = ['nn_ops', 'conv_ops'];

const PAGE = `<!doctype html><meta charset="utf-8"><title>卷積 GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>共用卷積（conv1d）WebGPU 對 codec 真實案例</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [] };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const CV = window.__mods.conv_ops;
    const idx = await (await fetch('/cases/index.json')).json();
    const f32 = async (n) => new Float32Array(await (await fetch('/cases/' + n)).arrayBuffer());
    for (const c of idx.cases) {
      const x = await f32(c.x), w = await f32(c.w), y = await f32(c.y), b = c.b ? await f32(c.b) : null;
      const ops = { navigator: navigator };
      const t0 = performance.now();
      const info = {};
      const got = await CV.conv1d(x, c.N, c.C, c.L, w, c.M, c.Cg, c.K, b, c.p, ops);
      let d = 0, m = 0; for (let i = 0; i < y.length; i++) { d = Math.max(d, Math.abs(got[i] - y[i])); m = Math.max(m, Math.abs(y[i])); }
      R.cases.push({ id: c.id, rel: d / (m || 1), ms: Math.round(performance.now() - t0), layer: ops.lastInfo ? ops.lastInfo.layer : 'unknown', reason: ops.lastInfo ? ops.lastInfo.reason : '' });
      show();
    }
    R.pass = R.cases.length > 0 && R.cases.every((x) => x.rel < 1e-4 && x.layer === 'T1');
    R.done = true;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_conv_gpu_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + [SHIM('nn_ops', 'renderer/src/gpu/nn_ops.js'), SHIM('conv_ops', 'renderer/src/gpu/conv_ops.js')].join('\n'));
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url.startsWith('/cases/')) {
    const name = path.basename(decodeURIComponent(req.url.slice(7)));
    const f = path.join(CASES, name);
    if (!fs.existsSync(f)) return send(404, 'text/plain', 'not found');
    const b = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('卷積 GPU 驗證：http://127.0.0.1:' + PORT + '/'));
