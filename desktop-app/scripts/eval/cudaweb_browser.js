'use strict';
// cudaweb 真瀏覽器驗證用的本機伺服器（只綁 127.0.0.1）。
// 用法：node scripts/eval/cudaweb_browser.js [埠，預設 18765]，然後用真的 Chrome 開 http://127.0.0.1:18765/
// 頁面會載入 renderer/src/gpu/gpu_core.js 與 nn_ops.js（nn_ops 是 CommonJS，這裡包一層 require 墊片），
// 跑 scripts/eval/cudaweb_gpu.eval.js（沿用不改）加上五個訓練核心與 CPU 參考版的逐項比對，
// 結果顯示在頁面上，同時 POST 到 /result，由本伺服器寫到 scripts/eval/cudaweb_browser.result.json。
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18765;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NN_CHECKS = `
return (async () => {
  const R = { checks: [] };
  const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
  const nn = window.FaCudawebNn, core = window.FaGpuCore;
  const rel = (a, b) => { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i]))); return m; };
  const ops = nn.trainerOps({ navigator: navigator });
  const mk = (n, f) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return a; };
  try {
    const T = 7, d = 64, x = mk(T * d, (i) => ((i * 37) % 29) / 7 - 2), g = mk(d, (i) => 0.5 + (i % 5) / 10);
    let r = await ops.rmsnorm(x, g, T, d, 1e-6); let e = rel(r, nn.rmsnormRef(x, g, T, d, 1e-6)); ck('rmsnorm 與 CPU 參考版相對誤差', e < 1e-4, { maxRel: e });
    const rows = 5, cols = 33, xs = mk(rows * cols, (i) => ((i * 53) % 31) / 9 - 1.5);
    r = await ops.softmax(xs, rows, cols); e = rel(r, nn.softmaxRef(xs, rows, cols)); ck('softmax 與 CPU 參考版相對誤差', e < 1e-4, { maxRel: e });
    const xi = mk(1000, (i) => ((i * 7919) % 2001) / 100 - 10);
    r = await ops.silu(xi); e = rel(r, nn.siluRef(xi)); ck('silu 與 CPU 參考版相對誤差', e < 1e-4, { maxRel: e });
    const Tt = 4, H = 2, hd = 8, xr = mk(Tt * H * hd, (i) => ((i * 31) % 17) / 5 - 1.5);
    r = await ops.rope(xr, Tt, H, hd, 1); e = rel(r, nn.ropeRef(xr, Tt, H, hd, 1)); ck('rope 與 CPU 參考版相對誤差', e < 1e-4, { maxRel: e });
    const n = 257, p = mk(n, (i) => ((i * 13) % 11) / 5 - 1), gr = mk(n, (i) => ((i * 7) % 13) / 9 - 0.6), mm = mk(n, () => 0), vv = mk(n, () => 0);
    const a1 = await ops.adamw(p, gr, mm, vv, 1, 1e-3, 0.9, 0.999, 1e-8, 0.01);
    const a2 = nn.adamwRef(p, gr, mm, vv, 1, 1e-3, 0.9, 0.999, 1e-8, 0.01);
    const key = Array.isArray(a1) ? 0 : null;
    const p1 = a1.p || a1[0] || a1, p2 = a2.p || a2[0] || a2;
    e = rel(p1, p2); ck('adamw 參數與 CPU 參考版相對誤差', e < 1e-4, { maxRel: e });
    R.trainerStats = ops.stats || null;
  } catch (err) { R.error = String((err && err.stack) || err).slice(0, 1500); }
  R.pass = !R.error && R.checks.every((c) => c.ok);
  return R;
})();`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>cudaweb 真瀏覽器驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>cudaweb 真瀏覽器驗證</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script>
<script src="/nn_ops.js"></script>
<script>
(async()=>{
 const out=document.getElementById('out');
 const R={userAgent:navigator.userAgent,navigatorGpu:!!navigator.gpu};
 try{
  window.FaCudawebNn=window.__nnLoad();window.NN=window.FaCudawebNn;
  window.__rt=window.FaGpuCore.createRuntime({navigator:navigator});window.fa={_cudawebRuntime:()=>window.__rt};
  const ev=await (await fetch('/eval.js')).text();
  R.eval=await (new Function(ev))();
  const nc=await (await fetch('/nn_checks.js')).text();
  R.nn=await (new Function(nc))();
  R.pass=!!(R.eval&&R.eval.pass&&R.nn&&R.nn.pass);
 }catch(e){R.error=String(e&&e.stack||e).slice(0,1500);R.pass=false}
 out.textContent=JSON.stringify(R,null,1);
 try{await fetch('/result',{method:'POST',body:JSON.stringify(R)})}catch(_){}
 document.title='cudaweb 驗證完成：'+(R.pass?'通過':'有項目未過');
})();
</script>`;

http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
    if (req.url === '/' || req.url.startsWith('/?')) {
        return send(200, 'text/html', PAGE);
    }
    if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
    if (req.url === '/nn_ops.js') return send(200, 'application/javascript', 'window.__nnLoad=function(){var module={exports:{}};var exports=module.exports;function require(n){if(n===\'./gpu_core.js\')return window.FaGpuCore;throw new Error(\'no \'+n)}\n' + rd('renderer/src/gpu/nn_ops.js') + '\nreturn module.exports};');
    if (req.url === '/eval.js') return send(200, 'application/javascript', rd('scripts/eval/cudaweb_gpu.eval.js'));
    if (req.url === '/nn_checks.js') return send(200, 'application/javascript', NN_CHECKS);
    if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(path.join(__dirname, 'cudaweb_browser.result.json'), b); send(200, 'text/plain', 'ok'); }); return; }
    send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('cudaweb 真瀏覽器驗證：http://127.0.0.1:' + PORT + '/'));
