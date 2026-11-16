'use strict';
// MatMulNBits GPU 核心的真瀏覽器驗證（Claude in Chrome 開 http://127.0.0.1:18770/）。
// 頁面用合成權重（確定性亂數，與 CPU 參考版共用同一組 q／scales／A），比較 GPU（T1 WGSL）與 CPU 參考版。
// 三個形狀：接近 MLP（M=1、K=1024、N=3072）、K 不是 32 倍數（M=3、K=40、N=5）、中等（M=8、K=1024、N=64）。
// 結果寫到系統暫存資料夾的 cudaweb_matmulnbits_browser.result.json。用法：node scripts/eval/cudaweb_matmulnbits_browser.js 18770 ；完成後 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18770;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>MatMulNBits 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>MatMulNBits GPU 核心（真 WebGPU 對 CPU 參考版）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [] };
  try {
    const REF = window.__mods.matmulnbits_ref, G = window.__mods.matmulnbits_gpu;
    let seed = 777;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const cases = [
      { name: 'MLP 形狀 M=1 K=1024 N=3072', M: 1, K: 1024, N: 3072 },
      { name: 'K=40 末尾 padding M=3 N=5', M: 3, K: 40, N: 5 },
      { name: 'M=8 K=1024 N=64', M: 8, K: 1024, N: 64 },
    ];
    for (const c of cases) {
      const { M, K, N } = c, nb = REF.nBlocksOf(K);
      const q = new Uint8Array(N * K); for (let i = 0; i < q.length; i++) q[i] = Math.floor(rnd() * 16);
      const scales = new Float32Array(N * nb); for (let i = 0; i < scales.length; i++) scales[i] = 0.01 + rnd() * 0.1;
      const A = new Float32Array(M * K); for (let i = 0; i < A.length; i++) A[i] = rnd() * 2 - 1;
      const B = REF.packQ4(q, N, K);
      const exp = REF.matmulNBitsRef(A, M, K, B, scales, N);
      await G.matmulNBits(A, M, K, B, scales, N, { navigator }); // 暖機（含編譯）
      const t0 = performance.now();
      const g = await G.matmulNBits(A, M, K, B, scales, N, { navigator });
      const ms = performance.now() - t0;
      let maxAbs = 0, maxRef = 0;
      for (let i = 0; i < exp.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(g.result[i] - exp[i])); maxRef = Math.max(maxRef, Math.abs(exp[i])); }
      R.cases.push({ name: c.name, M, K, N, rel: maxAbs / (maxRef || 1), tier: g.info.layer, reason: g.info.reason, callMs: ms, pass: maxAbs / (maxRef || 1) < 1e-4 && g.info.layer === 'T1' });
      out.textContent = JSON.stringify(R, null, 1);
    }
    R.done = true;
    R.pass = R.cases.every((x) => x.pass);
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  out.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_matmulnbits_browser.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'matmulnbits_ref', 'matmulnbits_gpu'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('MatMulNBits 驗證：http://127.0.0.1:' + PORT + '/'));
