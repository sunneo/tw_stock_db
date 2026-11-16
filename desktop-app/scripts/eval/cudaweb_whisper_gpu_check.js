'use strict';
// Whisper 編碼器（q8）整條走真 WebGPU（一維卷積 conv_ops.conv1d、整數矩陣乘、全注意力、LN、GELU 都是 WGSL T1），輸出對真 ORT 的 last_hidden_state。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:18784/）。參考來自 cudaweb_whisper_check.js。
// 通過條件：預填與解碼一步的 logits 相對誤差 < 1e-3、argmax 一致、所有投影都在 T1。
// 用法：node scripts/eval/cudaweb_whisper_gpu_check.js <encoder onnx> <cudaweb_whisper_check.js 的 outDir> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [MODEL, REF] = [process.argv[2], process.argv[3]]; // REF = 資料夾（feats.f32、ort_out.f32）
const PORT = Number(process.argv[4]) || 18784;
if (!MODEL || !REF) { console.error('用法：node scripts/eval/cudaweb_whisper_gpu_check.js <模型> <ORT 參考 json> [埠]'); process.exit(2); }
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>whisper GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>Whisper q8 編碼器：整條走 WebGPU 對 ORT</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const WE = window.__mods.whisper_enc, G = window.__mods.whisper_gpu;
    const buf = new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer());
    const feats = new Float32Array(await (await fetch('/feats.f32')).arrayBuffer());
    const rd = async (n) => new Float32Array(await (await fetch('/' + n + '.f32')).arrayBuffer());
    let t0 = performance.now();
    const W = WE.loadEncoder(buf); R.loadMs = performance.now() - t0;
    const ops = G.makeWhisperOps({ navigator });
    const rel = (a, b) => { let d = 0, m = 0, sd = 0; for (let i = 0; i < a.length; i++) { const e = Math.abs(a[i] - b[i]); d = Math.max(d, e); sd += e; m = Math.max(m, Math.abs(b[i])); } return { 最大相對: d / m, 平均絕對: sd / a.length }; };
    R.stages = {}; R.ok = true;
    // 階段 1：特徵 → conv1 → conv2 → +pos（對 ORT 中間張量；遇 pos 即停）
    t0 = performance.now();
    const refs = { conv1: await rd('ort_conv1'), conv2: await rd('ort_conv2'), pos: await rd('ort_pos') };
    try { await WE.encode(W, feats, ops, (l, t) => { if (refs[l]) { R.stages[l] = rel(t, refs[l]); R.stages[l].ms = performance.now() - t0; R.tiers = ops.tiers; show(); } if (l === 'pos') throw { stop: true }; }); } catch (e) { if (!e || !e.stop) throw e; }
    for (const l of ['conv1', 'conv2', 'pos']) if (!(R.stages[l].最大相對 < 1e-5)) R.ok = false;
    // 階段 2：逐層教師強迫（每層餵 ORT 的上一層輸出，隔離動態量化對輸入的混沌放大）
    let prev = refs.pos;
    for (let i = 0; i < 6; i++) {
      t0 = performance.now();
      const y = await WE.runLayer(W, i, prev, ops), ref = await rd('ort_layer' + i);
      R.stages['layer' + i] = rel(y, ref); R.stages['layer' + i].ms = performance.now() - t0; R.tiers = ops.tiers; show();
      if (!(R.stages['layer' + i].最大相對 < 2e-2 && R.stages['layer' + i].平均絕對 < 2e-3)) R.ok = false;
      prev = ref;
    }
    R.tiers = ops.tiers; R.done = true;
    R.pass = R.ok && Object.values(ops.tiers).every((x) => x === 'T1');
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_whisper_gpu_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'onnx_lite', 'conv_ops', 'whisper_enc', 'whisper_gpu'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (/^\/[a-z0-9_]+\.f32$/.test(req.url)) { const b = fs.readFileSync(path.join(REF, req.url.slice(1))); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/model.onnx') { const b = fs.readFileSync(MODEL); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('whisper GPU 驗證：http://127.0.0.1:' + PORT + '/'));
