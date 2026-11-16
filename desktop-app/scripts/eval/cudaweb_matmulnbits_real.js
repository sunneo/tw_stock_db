'use strict';
// MatMulNBits GPU 核心用網頁版 q4f16 第 0 層 MLP 的真權重，在真 Chrome WebGPU 上對 CPU 參考版比對。
// 權重來源：cudaweb_q4_extract.js 產生的資料夾（只讀）。輸入是確定性亂數。通過條件：全部走 T1，相對誤差 < 1e-4。
// 用法：node scripts/eval/cudaweb_matmulnbits_real.js <權重資料夾> 18771 ；Claude in Chrome 開 http://127.0.0.1:18771/ ；完成後 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIR = process.argv[2], PORT = Number(process.argv[3]) || 18771;
if (!DIR) { console.error('用法：node scripts/eval/cudaweb_matmulnbits_real.js <權重資料夾> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';
const NAMES = ['gate', 'up', 'down'];
const PAGE = `<!doctype html><meta charset="utf-8"><title>MatMulNBits 真權重</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>MatMulNBits 真權重（網頁版 q4f16 第 0 層 MLP）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [] };
  try {
    const REF = window.__mods.matmulnbits_ref, G = window.__mods.matmulnbits_gpu;
    let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const load = async (name) => {
      const meta = await (await fetch('/w/' + name + '.meta.json')).json();
      const q = new Uint8Array(await (await fetch('/w/' + name + '.q4.bin')).arrayBuffer());
      const s = new Float32Array(await (await fetch('/w/' + name + '.scales.f32.bin')).arrayBuffer());
      return { meta, q, s };
    };
    for (const name of ${JSON.stringify(NAMES)}) {
      const w = await load(name);
      const { K, N } = w.meta; const M = name === 'down' ? 1 : 2;
      const A = new Float32Array(M * K); for (let i = 0; i < A.length; i++) A[i] = rnd();
      const exp = REF.matmulNBitsRef(A, M, K, w.q, w.s, N);
      await G.matmulNBits(A, M, K, w.q, w.s, N, { navigator }); // 暖機（含編譯）
      const t0 = performance.now();
      const g = await G.matmulNBits(A, M, K, w.q, w.s, N, { navigator });
      const ms = performance.now() - t0;
      let maxAbs = 0, maxRef = 0;
      for (let i = 0; i < exp.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(g.result[i] - exp[i])); maxRef = Math.max(maxRef, Math.abs(exp[i])); }
      const rel = maxAbs / (maxRef || 1);
      R.cases.push({ name, M, K, N, rel, tier: g.info.layer, reason: g.info.reason, callMs: ms, pass: rel < 1e-4 && g.info.layer === 'T1' });
      out.textContent = JSON.stringify(R, null, 1);
    }
    R.done = true; R.pass = R.cases.every((x) => x.pass);
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  out.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_matmulnbits_real.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'matmulnbits_ref', 'matmulnbits_gpu'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url.startsWith('/w/')) {
    const f = path.join(DIR, path.basename(req.url.slice(3)));
    if (!fs.existsSync(f)) return send(404, 'text/plain', 'not found');
    const b = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('MatMulNBits 真權重驗證：http://127.0.0.1:' + PORT + '/'));
