'use strict';
// MLP 暖機量測（唯讀量測，不改推論路徑）：Qwen3-0.6B 第 0 層 MLP（gate／up／down，q8）。
// 真瀏覽器頁面（Claude in Chrome 開本機 http://127.0.0.1:18767/）量：
//   - GPU（WebGPU，T1）：冷啟動一次，暖機 3 次，再量 20 次取中位數（每次都含 3 次 readback，與目前 mlpForward 的做法相同）
//   - 純 JS 參考版（mmRef）：同樣次數
// 另外用 scripts/eval/cudaweb_mlp_ort.js（真 onnxruntime CPU）量同一層的 MLP。
// 用法：node scripts/eval/cudaweb_mlp_warm.js 18767 ；驗證完呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18767;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const w = poc.extractWeights(lite.parseModel(fs.readFileSync(modelPath)), 0);
const meta = {
  eps: w.eps, normW: Array.from(w.normW),
  gate: { K: w.gate.K, N: w.gate.N, zp: w.gate.zp, scale: w.gate.scale }, up: { K: w.up.K, N: w.up.N, zp: w.up.zp, scale: w.up.scale },
  down: { K: w.down.K, N: w.down.N, zp: w.down.zp, scale: w.down.scale },
};
const bin = { gate: w.gate.W, up: w.up.W, down: w.down.W };

const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>MLP 暖機量測</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>第 0 層 MLP 暖機量測（真 WebGPU 對純 JS）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, N: 20 };
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  try {
    const P = window.__mods.infer_poc_core;
    const meta = await (await fetch('/meta.json')).json();
    const get = async (n) => new Uint8Array(await (await fetch('/w/' + n)).arrayBuffer());
    const w = { eps: meta.eps, normW: Float32Array.from(meta.normW) };
    for (const k of ['gate', 'up', 'down']) w[k] = Object.assign({ W: await get(k) }, meta[k]);
    if (navigator.gpu) { const a = await navigator.gpu.requestAdapter(); if (a) R.adapter = { vendor: a.info && a.info.vendor, arch: a.info && a.info.architecture, desc: a.info && a.info.description }; }
    // 固定輸入（決定性）：1 個詞元、K=1024
    let seed = 20261116; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const h = Float32Array.from({ length: 1024 }, rnd);
    // GPU：每次呼叫記下各運算層（T1 或退路）
    const sink = [];
    const mmG = P.mmGpu({ navigator }, sink);
    const tc0 = performance.now(); const ref = await P.mlpForward(h, w, P.mmRef); R.jsOnceMs = performance.now() - tc0;
    const tCold0 = performance.now(); await P.mlpForward(h, w, mmG); R.gpuColdMs = performance.now() - tCold0;
    for (let i = 0; i < 3; i++) await P.mlpForward(h, w, mmG);
    const gpuT = [], gpuOut = [];
    for (let i = 0; i < R.N; i++) { const t = performance.now(); const o = await P.mlpForward(h, w, mmG); gpuT.push(performance.now() - t); if (i === 0) gpuOut.push(o); }
    R.gpuWarmMedianMs = med(gpuT); R.gpuWarmMinMs = Math.min(...gpuT); R.gpuWarmMaxMs = Math.max(...gpuT);
    R.gpuLayers = [...new Set(sink.map((x) => (x && x.layer) || (typeof x === 'string' ? x : JSON.stringify(x).slice(0, 40))))];
    // 純 JS（參考版）暖機後多次
    for (let i = 0; i < 3; i++) await P.mlpForward(h, w, P.mmRef);
    const jsT = [];
    for (let i = 0; i < R.N; i++) { const t = performance.now(); await P.mlpForward(h, w, P.mmRef); jsT.push(performance.now() - t); }
    R.jsWarmMedianMs = med(jsT); R.jsWarmMinMs = Math.min(...jsT); R.jsWarmMaxMs = Math.max(...jsT);
    // 正確性：GPU 與參考版的最大相對差（同一個輸入）
    let md = 0, mr = 0; for (let i = 0; i < ref.length; i++) { md = Math.max(md, Math.abs(ref[i] - gpuOut[0][i])); mr = Math.max(mr, Math.abs(ref[i])); }
    R.gpuVsRefRel = md / (mr || 1);
    R.pass = R.gpuVsRefRel < 1e-4;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); R.pass = false; }
  out.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '量測完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_mlp_warm.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={onnx_lite:{}};\n' + ['nn_ops', 'infer_ops', 'infer_poc_core'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/meta.json') return send(200, 'application/json', JSON.stringify(meta));
  if (req.url.startsWith('/w/') && bin[req.url.slice(3)]) { const b = bin[req.url.slice(3)]; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(Buffer.from(b.buffer, b.byteOffset, b.length)); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('MLP 暖機量測：http://127.0.0.1:' + PORT + '/'));
