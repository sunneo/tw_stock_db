'use strict';
// MLP 尺寸掃描（唯讀量測，不改推論路徑）：Qwen3-0.6B 第 0 層 MLP（gate／up／down，q8），M = 1、8、64、256、1024 個詞元。
// 真瀏覽器頁面（Claude in Chrome 開 http://127.0.0.1:18769/）每個 M 量暖機後中位數：
//   - GPU（WebGPU，T1）：含每個矩陣乘的 readback，以及 CPU 上的 RMSNorm、量化、SiLU（與 mlpM 的流程相同）
//   - 純 JS 參考版（mmRef）
// 另有 lm_head（嵌入表 q8，V=151936、K=1024）：M=1 與 M=64 的 GPU（逐列 q8lm）與純 JS（q8lmRef）。
// 次數：M=1、8、64 各 20 次；M=256 5 次；M=1024 3 次（純 JS 很慢）。結果寫到系統暫存資料夾的 cudaweb_mlp_sweep.result.json。
// 用法：node scripts/eval/cudaweb_mlp_sweep.js 18769 ；驗證完呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18769;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const m = lite.parseModel(fs.readFileSync(modelPath));
const w = poc.extractWeights(m, 0);
const emb = 'model.embed_tokens.weight_';
const embBytes = lite.tensorBytes(m, emb + 'quantized');
const meta = {
  eps: w.eps, normW: Array.from(w.normW),
  gate: { K: w.gate.K, N: w.gate.N, zp: w.gate.zp, scale: w.gate.scale }, up: { K: w.up.K, N: w.up.N, zp: w.up.zp, scale: w.up.scale },
  down: { K: w.down.K, N: w.down.N, zp: w.down.zp, scale: w.down.scale },
  lm: { V: m.inits[emb + 'quantized'].dims[0], K: m.inits[emb + 'quantized'].dims[1], zp: lite.scalar(m, emb + 'zero_point'), scale: lite.scalar(m, emb + 'scale') },
};
const bin = { gate: w.gate.W, up: w.up.W, down: w.down.W, lm: new Uint8Array(embBytes.buffer, embBytes.byteOffset, embBytes.length) };

const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>MLP 尺寸掃描</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>MLP 尺寸掃描（真 WebGPU 對純 JS）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, mlp: [], lm: [], note: 'M 個詞元；每個 M 暖機後中位數；GPU 含 readback 與 CPU 上的 RMSNorm／量化／SiLU。' };
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const repsOf = (M) => (M >= 1024 ? 3 : (M >= 256 ? 5 : 20));
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  try {
    const P = window.__mods.infer_poc_core, IO = window.__mods.infer_ops;
    const meta = await (await fetch('/meta.json')).json();
    const get = async (n) => new Uint8Array(await (await fetch('/w/' + n)).arrayBuffer());
    const W = { eps: meta.eps, normW: Float32Array.from(meta.normW) };
    for (const k of ['gate', 'up', 'down']) W[k] = Object.assign({ W: await get(k) }, meta[k]);
    const lmW = await get('lm');
    const K = meta.gate.K;
    let seed = 20261117; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    // 一個 MLP 的整段流程，支援 M 列（與 infer_poc_core.mlpForward 相同的步驟，只是逐列 RMSNorm）
    const mlpM = async (H, M, mm) => {
      const xn = new Float32Array(M * K);
      for (let r = 0; r < M; r++) xn.set(P.rmsnormHost(H.subarray(r * K, (r + 1) * K), W.normW, W.eps), r * K);
      const a = IO.quantizeDynamicRef(xn);
      const xi = new Int32Array(a.q.length); for (let i = 0; i < xi.length; i++) xi[i] = a.q[i] - a.zp;
      const gate = await mm(xi, W.gate.W, W.gate.zp, M, W.gate.K, W.gate.N, Math.fround(a.scale * W.gate.scale));
      const up = await mm(xi, W.up.W, W.up.zp, M, W.up.K, W.up.N, Math.fround(a.scale * W.up.scale));
      const act = new Float32Array(gate.length); for (let i = 0; i < act.length; i++) act[i] = (gate[i] / (1 + Math.exp(-gate[i]))) * up[i];
      const b = IO.quantizeDynamicRef(act);
      const bi = new Int32Array(b.q.length); for (let i = 0; i < bi.length; i++) bi[i] = b.q[i] - b.zp;
      return await mm(bi, W.down.W, W.down.zp, M, W.down.K, W.down.N, Math.fround(b.scale * W.down.scale));
    };
    const sink = [];
    const mmG = P.mmGpu({ navigator }, sink);
    for (const M of [1, 8, 64, 256, 1024]) {
      const H = Float32Array.from({ length: M * K }, rnd);
      const reps = repsOf(M);
      const row = { M, reps };
      await mlpM(H, M, mmG); // 暖機（GPU）
      const tg = []; let og = null;
      for (let i = 0; i < reps; i++) { await yieldNow(); const t = performance.now(); og = await mlpM(H, M, mmG); tg.push(performance.now() - t); }
      row.gpuMedianMs = med(tg); row.gpuMin = Math.min(...tg); row.gpuMax = Math.max(...tg);
      await mlpM(H, M, P.mmRef); // 暖機（JS）
      const tj = []; let oj = null;
      for (let i = 0; i < reps; i++) { await yieldNow(); const t = performance.now(); oj = await mlpM(H, M, P.mmRef); tj.push(performance.now() - t); }
      row.jsMedianMs = med(tj); row.jsMin = Math.min(...tj); row.jsMax = Math.max(...tj);
      let md = 0, mr = 0; for (let i = 0; i < oj.length; i++) { md = Math.max(md, Math.abs(oj[i] - og[i])); mr = Math.max(mr, Math.abs(oj[i])); }
      row.gpuVsJsRel = md / (mr || 1);
      row.gpuOverJs = row.jsMedianMs / row.gpuMedianMs; // >1 表示 GPU 比較快
      R.mlp.push(row);
      out.textContent = JSON.stringify(R, null, 1);
    }
    // lm_head：嵌入表 q8（V×K），M=1 與 M=64；GPU 逐列 q8lm（權重切塊常駐），JS 逐列 q8lmRef
    const V = meta.lm.V, Kl = meta.lm.K;
    const chunks = IO.planChunks(lmW, V, Kl, IO.MAX_CHUNK_BYTES);
    const xs = (M) => Array.from({ length: M }, () => Float32Array.from({ length: Kl }, rnd));
    for (const M of [1, 64]) {
      const X = xs(M); const reps = M === 1 ? 20 : 3;
      const row = { M, reps };
      const runG = async () => { let last = null; for (const x of X) { const r = await IO.q8lm(x, chunks, meta.lm.zp, Kl, meta.lm.scale, { navigator }); last = r.result; } return last; };
      const runJ = () => { let last = null; for (const x of X) last = IO.q8lmRef(x, lmW, meta.lm.zp, V, Kl, Math.fround(meta.lm.scale)); return last; };
      await runG();
      const tg = []; let og = null;
      for (let i = 0; i < reps; i++) { await yieldNow(); const t = performance.now(); og = await runG(); tg.push(performance.now() - t); }
      row.gpuMedianMs = med(tg); row.gpuMin = Math.min(...tg); row.gpuMax = Math.max(...tg);
      runJ();
      const tj = []; let oj = null;
      for (let i = 0; i < reps; i++) { await yieldNow(); const t = performance.now(); oj = runJ(); tj.push(performance.now() - t); }
      row.jsMedianMs = med(tj); row.jsMin = Math.min(...tj); row.jsMax = Math.max(...tj);
      let md = 0, mr = 0; for (let i = 0; i < oj.length; i++) { md = Math.max(md, Math.abs(oj[i] - og[i])); mr = Math.max(mr, Math.abs(oj[i])); }
      row.gpuVsJsRel = md / (mr || 1);
      row.gpuOverJs = row.jsMedianMs / row.gpuMedianMs;
      R.lm.push(row);
      out.textContent = JSON.stringify(R, null, 1);
    }
    R.done = true;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  out.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '掃描完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_mlp_sweep.result.json');
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
}).listen(PORT, '127.0.0.1', () => console.log('MLP 尺寸掃描：http://127.0.0.1:' + PORT + '/'));
