'use strict';
// 整張圖端到端（真 Chrome，軟體 WebGPU）：伺服器端用真 ORT 算參考輸出；頁面用 graph_session（Conv／ConvTranspose／大 MatMul 走 WGSL T1）算同樣的輸入，逐輸出比對。
// 用法：node scripts/eval/cudaweb_graph_browser.js <kind> <model.onnx> [埠=18793]；kind 見 CASES（yamnet）。結果寫 $TMP/cudaweb_graph_<kind>.result.json；/quit 結束。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), [KIND, MODEL] = [process.argv[2], process.argv[3]], PORT = Number(process.argv[4]) || 18793;
const base = process.env.FA_BASE || path.join(os.homedir(), '.config', 'floating-assistant-desktop');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const { CASES } = require('./cudaweb_graph_cases.js');
const rd = (p) => fs.readFileSync(path.join(ROOT, 'renderer/src/gpu', p), 'utf8');
const MODS = ['nn_ops', 'infer_ops', 'onnx_lite', 'conv_ops', 'mm_ops', 'onnx_ops_more', 'onnx_interp', 'graph_session'];
let bundle = 'window.__G=(function(){var MODS={},CACHE={};function req(p){var n=String(p).replace(/^\\.\\//,"").replace(/\\.js$/,"");if(n==="gpu_core")return window.FaGpuCore;if(CACHE[n])return CACHE[n].exports;if(!MODS[n])throw new Error("沒有模組 "+p);var m={exports:{}};CACHE[n]=m;MODS[n].call(m.exports,m,m.exports,req);return m.exports;}\n';
for (const n of MODS) bundle += 'MODS[' + JSON.stringify(n) + ']=function(module,exports,require){\n' + rd(n + '.js') + '\n};\n';
bundle += 'return {GS:req("graph_session")};})();\n';
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
let job = null;
const PAGE = `<!doctype html><meta charset="utf-8"><title>graph GPU 驗證</title><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/bundle.js"></script>
<script>
(async () => {
  const R = { kind: ${JSON.stringify(KIND)}, pass: false }; const out = document.getElementById('out');
  try {
    const job = await (await fetch('/job')).json(); const un = (s, T) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return new T(u.buffer); };
    const bytes = new Uint8Array(await (await fetch('/model')).arrayBuffer());
    class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
    const feeds = {}; for (const k of Object.keys(job.feeds)) { const f = job.feeds[k]; feeds[k] = new Tensor(f.type, un(f.b64, f.type === 'float32' ? Float32Array : f.type === 'int64' ? BigInt64Array : Int32Array), f.dims); }
    const ops = { navigator }; const gs = window.__G.GS.create(bytes, { ops, minMacs: job.minMacs || 1 << 16 });
    const t0 = performance.now(); const o = await gs.run(feeds); R.ms = Math.round(performance.now() - t0); R.tiers = gs.info.tiers; R.outputs = {}; let worst = 0;
    for (const k of Object.keys(job.refs)) { const ref = un(job.refs[k].b64, Float32Array), got = o[k].data; let d = 0, m = 0, d2 = 0, n2 = 0; for (let i = 0; i < ref.length; i++) { const e = Math.abs(got[i] - ref[i]); d = Math.max(d, e); m = Math.max(m, Math.abs(ref[i])); d2 += e * e; n2 += ref[i] * ref[i]; } const r = m > 0 ? d / m : d; const rl2 = Math.sqrt(d2 / (n2 || 1)); worst = Math.max(worst, job.tol ? (r < 1e-3 || rl2 < job.tol ? 0 : r) : r); R.outputs[k] = { dims: o[k].dims, maxRel: r, relL2: rl2 }; }
    R.worstRel = worst; const onlyT1 = Object.keys(R.tiers).every((l) => /^T1/.test(l)); R.allT1 = onlyT1; R.pass = worst < 1e-3 && onlyT1 && Object.keys(R.tiers).length > 0;
    if (job.argmax) { const a = o[job.argmax.name].data, b = un(job.refs[job.argmax.name].b64, Float32Array), C = job.argmax.cols, T = a.length / C; let same = 0; for (let r = 0; r < T; r++) { let x = 0, y = 0; for (let c = 1; c < C; c++) { if (a[r * C + c] > a[r * C + x]) x = c; if (b[r * C + c] > b[r * C + y]) y = c; } if (x === y) same++; } R.argmaxSame = same + '/' + T; }
  } catch (e) { R.error = String((e && e.stack) || e); }
  document.title = R.pass ? '驗證完成：通過' : '驗證完成：未通過'; out.textContent = JSON.stringify(R, null, 1); await fetch('/result', { method: 'POST', body: JSON.stringify(R) });
})();
</script>`;
(async () => {
  const c = CASES[KIND]; if (!c) throw new Error('沒有這個 kind：' + KIND);
  const feeds = await c.feeds(ort, MODEL), sess = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] }), ref = await sess.run(feeds);
  job = { feeds: {}, refs: {}, minMacs: c.minMacs, argmax: c.argmax, tol: c.tolRelL2 || 0 };
  for (const k of Object.keys(feeds)) { const t = feeds[k]; job.feeds[k] = { type: t.type, dims: t.dims, b64: b64(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)) }; }
  for (const k of Object.keys(ref)) { const d = ref[k].data; job.refs[k] = { b64: b64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) }; }
  const RESULT = path.join(os.tmpdir(), 'cudaweb_graph_' + KIND + '.result.json');
  const srv = http.createServer((req, res) => {
    const send = (t, b) => { res.writeHead(200, { 'Content-Type': t }); res.end(b); };
    if (req.url === '/') return send('text/html; charset=utf-8', PAGE);
    if (req.url === '/gpu_core.js') return send('text/javascript', rd('gpu_core.js'));
    if (req.url === '/bundle.js') return send('text/javascript', bundle);
    if (req.url === '/job') return send('application/json', JSON.stringify(job));
    if (req.url === '/model') return send('application/octet-stream', fs.readFileSync(MODEL));
    if (req.method === 'POST' && req.url === '/result') { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { fs.writeFileSync(RESULT, b); res.writeHead(200); res.end('ok'); }); return; }
    if (req.url === '/quit') { res.writeHead(200); res.end('bye'); srv.close(() => process.exit(0)); return; }
    res.writeHead(404); res.end('no');
  });
  srv.listen(PORT, '127.0.0.1', () => console.log('http://127.0.0.1:' + PORT + '/'));
})().catch((e) => { console.error(e); process.exit(1); });
