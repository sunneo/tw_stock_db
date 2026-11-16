'use strict';
// 逐節點 GPU 對拍的驗證頁（cudaweb_node_dump.js 的案例）：每個案例以 node_eval.evalNode（conv_ops／mm_ops，T1 WGSL）重算，對 ORT 的輸出比對。
// 浮點：最大絕對差／最大絕對值 < 1e-4 且層級必須是 T1；整數（MatMulInteger）：必須逐位相同。
// 用法：node scripts/eval/cudaweb_node_gpu_check.js <dump 資料夾> <結果名稱> [埠]；Chrome 開 http://127.0.0.1:<埠>/；結果寫到 $TMP/cudaweb_node_gpu_<結果名稱>.result.json
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [REF, NAME] = [process.argv[2], process.argv[3]];
const PORT = Number(process.argv[4]) || 18786;
if (!REF || !NAME) { console.error('用法：node scripts/eval/cudaweb_node_gpu_check.js <dump 資料夾> <結果名稱> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';
const PAGE = `<!doctype html><meta charset="utf-8"><title>逐節點 GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>${NAME}：逐節點 WebGPU 對 ORT</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, n: 0, byOp: {}, layers: {}, worst: 0, intBad: 0, cases: [] };
  const show = () => { out.textContent = JSON.stringify(Object.assign({}, R, { cases: R.cases.slice(-6) }), null, 1); };
  const CT = { float32: Float32Array, uint8: Uint8Array, int8: Int8Array, int32: Int32Array };
  try {
    const NE = window.__mods.node_eval;
    const cases = await (await fetch('/cases.json')).json();
    const rd = async (t) => new CT[t.type](await (await fetch('/' + t.f)).arrayBuffer());
    for (const c of cases) {
      const ins = []; for (const t of c.ins) ins.push(t ? { data: await rd(t), dims: t.dims } : null);
      const y = await rd(c.out), o = { navigator };
      const t0 = performance.now();
      const g = await NE.evalNode(c.op, c.attrs, ins, o);
      const info = o.lastInfo || {};
      let rel = 0, ok;
      if (c.op === 'MatMulInteger' || c.op === 'ConvInteger') { let bad = 0; for (let i = 0; i < y.length; i++) if (g.y[i] !== y[i]) bad++; R.intBad += bad; ok = bad === 0; rel = bad; }
      else { let df = 0, mx = 0; for (let i = 0; i < y.length; i++) { df = Math.max(df, Math.abs(g.y[i] - y[i])); mx = Math.max(mx, Math.abs(y[i])); } rel = df / (mx || 1); R.worst = Math.max(R.worst, rel); ok = rel < 1e-4; }
      ok = ok && g.y.length === y.length && g.dims.join() === c.out.dims.join();
      R.n++; R.byOp[c.op] = (R.byOp[c.op] || 0) + 1; R.layers[info.layer] = (R.layers[info.layer] || 0) + 1;
      const rec = { op: c.op, name: c.name.slice(-48), dims: c.ins[0].dims.join('x') + '*' + c.ins[1].dims.join('x'), rel: +Number(rel).toExponential(2), layer: info.layer, reason: info.reason || undefined, ms: Math.round(performance.now() - t0), ok };
      if (!ok || info.layer !== 'T1') R.cases.push(rec); else if (R.cases.length < 3) R.cases.push(rec);
      if (R.n % 5 === 0) show();
    }
    R.done = true;
    R.nonT1 = R.n - (R.layers.T1 || 0);
    R.pass = R.n === cases.length && R.worst < 1e-4 && R.intBad === 0 && R.nonT1 === 0 && !R.cases.some((c) => !c.ok);
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_node_gpu_' + NAME + '.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'conv_ops', 'mm_ops', 'node_eval'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (/^\/t\d+\.bin$/.test(req.url) || req.url === '/cases.json') { const b = fs.readFileSync(path.join(REF, req.url.slice(1))); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('逐節點 GPU 驗證：http://127.0.0.1:' + PORT + '/'));
