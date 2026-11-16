'use strict';
// 推論概念驗證的真瀏覽器驗證伺服器（只綁 127.0.0.1）。用法：node scripts/eval/cudaweb_infer_browser.js [埠，預設 18765]
// 然後用 Claude in Chrome 開 http://127.0.0.1:18765/ ；頁面從本機取真實 q8 權重（讀自現有 native-models，不下載），
// 在真 WebGPU 上跑 MLP 與 lm_head，與 CPU 參考版比對，結果 POST 回 /result，寫到 cudaweb_infer_browser.result.json。
// 驗證完請 Ctrl+C 或呼叫 /quit 關掉伺服器。
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18765;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const w = poc.extractWeights(lite.parseModel(fs.readFileSync(modelPath)), 0);
const meta = {
  eps: w.eps, normW: Array.from(w.normW),
  gate: { K: w.gate.K, N: w.gate.N, zp: w.gate.zp, scale: w.gate.scale }, up: { K: w.up.K, N: w.up.N, zp: w.up.zp, scale: w.up.scale },
  down: { K: w.down.K, N: w.down.N, zp: w.down.zp, scale: w.down.scale }, lm: { V: w.lm.V, K: w.lm.K, zp: w.lm.zp, scale: w.lm.scale }
};
const bin = { gate: w.gate.W, up: w.up.W, down: w.down.W, lm: w.lm.W };

const SHIM = (name, file, deps) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>推論概念驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>Qwen3-0.6B 推論熱點概念驗證（真 WebGPU）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async()=>{
 const out=document.getElementById('out');
 const R={userAgent:navigator.userAgent,navigatorGpu:!!navigator.gpu};
 try{
  const meta=await (await fetch('/meta.json')).json();
  const get=async(n)=>new Uint8Array(await (await fetch('/w/'+n)).arrayBuffer());
  const w={eps:meta.eps,normW:Float32Array.from(meta.normW)};
  for(const k of ['gate','up','down']) w[k]=Object.assign({W:await get(k)},meta[k]);
  w.lm=Object.assign({W:await get('lm')},meta.lm);
  R.bytes={gate:w.gate.W.length,lm:w.lm.W.length};
  if(navigator.gpu){const a=await navigator.gpu.requestAdapter();if(a){R.adapter={vendor:a.info&&a.info.vendor,arch:a.info&&a.info.architecture,desc:a.info&&a.info.description}}}
  R.result=await window.__mods.infer_poc_core.runPoc(w,{navigator:navigator},()=>performance.now());
  R.pass=!!R.result.pass;
  R.onlyGpu=R.result.mlp.layers.every(l=>l==='T1')&&R.result.lm.layer==='T1';
 }catch(e){R.error=String(e&&e.stack||e).slice(0,1500);R.pass=false}
 out.textContent=JSON.stringify(R,null,1);
 try{await fetch('/result',{method:'POST',body:JSON.stringify(R)})}catch(_){}
 document.title='推論驗證完成：'+(R.pass?'通過':'有項目未過');
})();
</script>`;

const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={onnx_lite:{}};\n' + ['nn_ops', 'infer_ops', 'infer_poc_core'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/meta.json') return send(200, 'application/json', JSON.stringify(meta));
  if (req.url.startsWith('/w/') && bin[req.url.slice(3)]) { const b = bin[req.url.slice(3)]; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(Buffer.from(b.buffer, b.byteOffset, b.length)); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(path.join(__dirname, 'cudaweb_infer_browser.result.json'), b); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('推論概念驗證：http://127.0.0.1:' + PORT + '/'));
