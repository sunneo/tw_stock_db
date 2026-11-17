'use strict';
// Qwen3 q8 整段 GPU 解碼的瀏覽器端驗證伺服器（只綁 127.0.0.1）。
// 用法：node scripts/eval/cudaweb_qwen_gpu_browser.js <參考資料夾（ref*.json，由 cudaweb_qwen_greedy.js 產生）> [埠，預設 18781]
// 頁面（真 Chrome 的 WebGPU；沒有 GPU 的機器用 --use-webgpu-adapter=swiftshader 的軟體實作）：
//   載入 q8 模型 → 建 GPU 引擎 → 對每組參考提示貪婪生成 → 與 CPU 參考引擎、ORT 的詞元逐一比對。
// 結果 POST 回 /result，寫到系統暫存資料夾的 cudaweb_qwen_gpu_browser.result.json。完成後呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const REFDIR = process.argv[2];
const PORT = Number(process.argv[3]) || 18781;
if (!REFDIR) { console.error('用法：node cudaweb_qwen_gpu_browser.js <參考資料夾> [埠]'); process.exit(2); }
const base = process.env.FA_BASE || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop');
const modelPath = process.env.QWEN_Q8 || path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const rd = (p) => fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'gpu', p), 'utf8');
const refs = fs.readdirSync(REFDIR).filter((f) => /^ref.*\.json$/.test(f)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(REFDIR, f), 'utf8')));

const MODS = ['onnx_lite', 'nn_ops', 'infer_ops', 'attn_ops', 'qwen_decode', 'qwen_gpu', 'gpu_mem'];
let bundle = 'window.__Q = (function () {\nvar MODS = {}, CACHE = {};\n';
bundle += 'function req(p) { var n = String(p).replace(/^\\.\\//, "").replace(/\\.js$/, ""); if (n === "gpu_core") return window.FaGpuCore; if (CACHE[n]) return CACHE[n].exports; if (!MODS[n]) throw new Error("沒有模組 " + p); var m = { exports: {} }; CACHE[n] = m; MODS[n].call(m.exports, m, m.exports, req); return m.exports; }\n';
for (const n of MODS) bundle += 'MODS[' + JSON.stringify(n) + '] = function (module, exports, require) {\n' + rd(n + '.js') + '\n};\n';
bundle += 'return { decode: req("qwen_decode"), gpu: req("qwen_gpu"), mem: req("gpu_mem") };\n})();\n';

const PAGE = `<!doctype html><meta charset="utf-8"><title>Qwen3 GPU 解碼驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>Qwen3-0.6B q8 整段 GPU 解碼（WGSL）對 CPU 參考與 ORT</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/bundle.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const log = (s) => { out.textContent += '\\n' + s; fetch('/log', { method: 'POST', body: s }).catch(() => {}); };
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, cases: [], pass: false };
  try {
    const Q = window.__Q.decode, G = window.__Q.gpu;
    let t = performance.now();
    const buf = new Uint8Array(await (await fetch('/model')).arrayBuffer());
    R.loadMs = Math.round(performance.now() - t); log('模型 ' + buf.length + ' 位元組，下載 ' + R.loadMs + ' ms');
    t = performance.now();
    const W = Q.loadWeights(buf);
    R.parseMs = Math.round(performance.now() - t); log('解析權重 ' + R.parseMs + ' ms');
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) throw new Error('沒有 WebGPU 介面卡');
    R.adapter = { vendor: (ad.info || {}).vendor, arch: (ad.info || {}).architecture, desc: (ad.info || {}).description, maxBuf: ad.limits.maxStorageBufferBindingSize };
    const need = {}; for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize']) need[k] = Math.min(ad.limits[k], 1 << 30);
    const dev = await ad.requestDevice({ requiredLimits: need });
    dev.lost.then((i) => log('裝置遺失：' + i.reason + ' ' + i.message));
    dev.addEventListener && dev.addEventListener('uncapturederror', (e) => log('uncapturederror：' + e.error.message));
    t = performance.now();
    const eng = await G.createGpuEngine(dev, W, { maxT: 64, maxM: 32, chunkM: ${Number(process.env.QWEN_CHUNKM) || 16} });
    R.setupMs = Math.round(performance.now() - t); R.engine = eng.info; log('GPU 引擎就緒 ' + R.setupMs + ' ms，派發 ' + eng.info.dispatches + ' 個，lm_head ' + eng.info.lmChunks + ' 塊');
    // GPU 記憶體上限：估算要與實際配置逐位元組相符；超過 budgetBytes 要在配置前丟 GPU_BUDGET；探測在軟體 WebGPU 上不量
    R.estimate = G.estimateEngineBytes(W, { maxT: 64, maxM: 32 }); R.actualBytes = eng.info.gpuBytes;
    try { await G.createGpuEngine(dev, W, { maxT: 64, maxM: 32, budgetBytes: 1 << 20 }); R.budgetErr = { code: 'none' }; } catch (e) { R.budgetErr = { code: e.code, msg: e.message }; }
    R.probe = await window.__Q.mem.probe(navigator, {});
    const REFS = ${JSON.stringify(refs)};
    for (const r of REFS) {
      eng.reset();
      t = performance.now();
      const toks = await Q.greedy(eng, r.prompt, r.n);
      const ms = Math.round(performance.now() - t);
      const item = { prompt: r.prompt, gpuTokens: toks, cpuTokens: r.cpuTokens, ortTokens: r.ortTokens, eqCpu: JSON.stringify(toks) === JSON.stringify(r.cpuTokens), eqOrt: JSON.stringify(toks) === JSON.stringify(r.ortTokens), ms, msPerStep: Math.round(ms / (r.n)) };
      R.cases.push(item); log(JSON.stringify(item));
    }
    // 診斷：第 3 組（第一個詞元就和 CPU 參考不同的那組）逐層殘差流對 CPU 參考引擎
    {
      const dp = REFS.find((r) => r.prompt[0] === 9707) || REFS[0];
      eng.reset(); const g = await eng.step(dp.prompt, { trace: true, logits: true });
      const ce = Q.createCpuEngine(W, { maxT: 16, trace: true }); const cl = ce.step(dp.prompt);
      const rel = (a, b) => { let ma = 0, mr = 0; for (let i = 0; i < b.length; i++) { ma = Math.max(ma, Math.abs(a[i] - b[i])); mr = Math.max(mr, Math.abs(b[i])); } return +(ma / (mr || 1)).toExponential(2); };
      R.trace = { prompt: dp.prompt, perLayerRel: g.trace.map((x, l) => rel(x, ce.lastTrace[l])), logitsRel: rel(g.logits, cl), gpuArg: Q.argmax(g.logits), cpuArg: Q.argmax(cl) };
      log('逐層：' + JSON.stringify(R.trace));
    }
    // 第一步 logits 對 ORT（只有第一組有前 16 個）
    eng.reset(); const f = await eng.step(REFS[REFS.length - 1].prompt, { logits: true });
    R.firstLogits16 = Array.from(f.logits.subarray(0, 16)); R.ortLogits16 = REFS[REFS.length - 1].ortLogits0;
    let ma = 0, mr = 0; for (let i = 0; i < 16; i++) { ma = Math.max(ma, Math.abs(R.firstLogits16[i] - R.ortLogits16[i])); mr = Math.max(mr, Math.abs(R.ortLogits16[i])); }
    R.firstLogitsRel16 = ma / (mr || 1);
    // 通過：GPU 與 CPU 參考引擎在所有組都相同（同樣數學）；與 ORT 相同的組數另外回報
    R.pass = R.cases.length > 0 && R.cases.every((x) => x.eqCpu);
    R.ortAgree = R.cases.filter((x) => x.eqOrt).length + '/' + R.cases.length;
  } catch (e) { R.error = String((e && e.stack) || e); }
  out.textContent = (R.pass ? '驗證通過' : '驗證未通過') + '\\n' + JSON.stringify(R, null, 1);
  document.title = R.pass ? '驗證完成：通過' : '驗證完成：未通過';
  await fetch('/result', { method: 'POST', body: JSON.stringify(R) }).catch(() => {});
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_qwen_gpu_browser.result.json');
const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (req.method === 'GET' && req.url === '/gpu_core.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(rd('gpu_core.js')); }
  if (req.method === 'GET' && req.url === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bundle); }
  if (req.method === 'GET' && req.url === '/model') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(modelPath).size }); return fs.createReadStream(modelPath).pipe(res); }
  if (req.method === 'POST' && (req.url === '/result' || req.url === '/log')) {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      if (req.url === '/result') { fs.writeFileSync(RESULT, body); console.log('結果已寫入 ' + RESULT); } else console.log('[頁面] ' + body.slice(0, 400));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.url === '/quit') { res.writeHead(200); res.end('bye'); srv.close(() => process.exit(0)); return; }
  res.writeHead(404); res.end('not found');
});
srv.listen(PORT, '127.0.0.1', () => console.log('Qwen3 GPU 解碼驗證：http://127.0.0.1:' + PORT + '/'));
