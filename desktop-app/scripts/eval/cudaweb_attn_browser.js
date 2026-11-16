'use strict';
// 注意力核心 GPU 版的真瀏覽器驗證伺服器（只綁 127.0.0.1）。用法：node scripts/eval/cudaweb_attn_browser.js [埠，預設 18766]
// 用 Claude in Chrome 開 http://127.0.0.1:18766/ ：頁面在真 WebGPU 上跑 attn_gpu（WGSL）與 attn_ops（CPU 參考版）比對，
// 結果 POST 回 /result，寫到系統暫存資料夾的 cudaweb_attn_browser.result.json。驗證完呼叫 /quit 關掉伺服器。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18766;
const rd = (p) => fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'gpu', p), 'utf8');

// 模組束：gpu_core 由頁面另外以 script 載入（window.FaGpuCore）；其餘用最小 require 墊片串起來
const MODS = ['nn_ops', 'attn_ops', 'attn_gpu'];
let bundle = 'window.__A = (function () {\nvar MODS = {}, CACHE = {};\n';
bundle += 'function req(p) { var n = String(p).replace(/^\\.\\//, "").replace(/\\.js$/, ""); if (n === "gpu_core") return window.FaGpuCore; if (CACHE[n]) return CACHE[n].exports; if (!MODS[n]) throw new Error("沒有模組 " + p); var m = { exports: {} }; CACHE[n] = m; MODS[n].call(m.exports, m, m.exports, req); return m.exports; }\n';
for (const n of MODS) bundle += 'MODS[' + JSON.stringify(n) + '] = function (module, exports, require) {\n' + rd(n + '.js') + '\n};\n';
bundle += 'return { attn_ops: req("attn_ops"), attn_gpu: req("attn_gpu") };\n})();\n';

const PAGE = `<!doctype html><meta charset="utf-8"><title>注意力核心驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>注意力核心（真 WebGPU，WGSL）對 CPU 參考版</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/bundle.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [], pass: false };
  try {
    const A = window.__A.attn_ops, G = window.__A.attn_gpu;
    const H = 16, Hkv = 8, hd = 128, scale = 1 / Math.sqrt(hd);
    let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const cases = [
      { name: '解碼 S=1，過去 0', S: 1, past: 0 },
      { name: '預填 S=4，過去 0', S: 4, past: 0 },
      { name: '解碼 S=1，過去 40', S: 1, past: 40 },
      { name: '混合 S=3，過去 20', S: 3, past: 20 },
    ];
    for (const c of cases) {
      const T = c.past + c.S;
      const cache = A.createKvCache(Hkv, hd, T);
      const k = Float32Array.from({ length: T * Hkv * hd }, rnd), v = Float32Array.from({ length: T * Hkv * hd }, rnd);
      A.kvAppend(cache, k, v, T);
      const q = Float32Array.from({ length: c.S * H * hd }, rnd);
      const t0 = performance.now();
      const g = await G.attnCoreGpu(q, c.S, c.past, cache, H, scale, { navigator });
      const tg = performance.now() - t0;
      const t1 = performance.now();
      const ref = A.attnCore(q, c.S, c.past, cache, H, scale);
      const tc = performance.now() - t1;
      let maxAbs = 0, maxRef = 0;
      for (let i = 0; i < ref.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(ref[i] - g.result[i])); maxRef = Math.max(maxRef, Math.abs(ref[i])); }
      const rel = maxAbs / (maxRef || 1);
      const item = { name: c.name, layer: g.info.layer, reason: g.info.reason, maxAbs, rel, gpuMs: tg, cpuMs: tc, pass: g.info.layer === 'T1' && rel < 1e-4 };
      R.cases.push(item);
      out.textContent = JSON.stringify(R.cases, null, 1);
    }
    R.pass = R.cases.length > 0 && R.cases.every((x) => x.pass);
  } catch (e) { R.error = String((e && e.stack) || e); }
  out.textContent = (R.pass ? '驗證通過' : '驗證未通過') + '\\n' + JSON.stringify(R, null, 1);
  await fetch('/result', { method: 'POST', body: JSON.stringify(R) }).catch(() => {});
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_attn_browser.result.json');
const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.method === 'GET' && req.url === '/gpu_core.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(rd('gpu_core.js')); }
  if (req.method === 'GET' && req.url === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bundle); }
  if (req.method === 'POST' && req.url === '/result') {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      fs.writeFileSync(RESULT, body); console.log('結果已寫入 ' + RESULT); res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.url === '/quit') { res.writeHead(200); res.end('bye'); srv.close(() => process.exit(0)); return; }
  res.writeHead(404); res.end('not found');
});
srv.listen(PORT, '127.0.0.1', () => console.log('注意力核心驗證：http://127.0.0.1:' + PORT + '/'));
