'use strict';
// MOSS 整條管線（全域解碼一步＋本地取樣）走真 WebGPU，對 ORT 參考幀比對（同一個 seed，幀必須完全一致）。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:<埠>/）。參考 json 來自 cudaweb_moss_pipeline_check.js 的第四參數輸出。
// 注意：WebGPU 的每次運算都會重建 pipeline（runWgsl），速度很慢，這裡只驗正確性。
// 用法：node scripts/eval/cudaweb_moss_pipeline_gpu_check.js <MOSS 資料夾> <ref json> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [DIR, REF] = [process.argv[2], process.argv[3]];
const PORT = Number(process.argv[4]) || 18776;
if (!DIR || !REF) { console.error('用法：node scripts/eval/cudaweb_moss_pipeline_gpu_check.js <MOSS 資料夾> <ref json> [埠]'); process.exit(2); }
const FILES = {
  global: path.join(DIR, 'moss_tts_decode_step.onnx'), globalData: path.join(DIR, 'moss_tts_global_shared.data'),
  local: path.join(DIR, 'moss_tts_local_decoder.onnx'), localData: path.join(DIR, 'moss_tts_local_shared.data'),
};
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';
const MODS = ['nn_ops', 'onnx_lite', 'moss_decoder', 'moss_gpu', 'moss_local', 'moss_sampling', 'moss_core'];
const MODPATH = { moss_core: 'renderer/src/tts/moss_core.js' };
const modFile = (n) => MODPATH[n] || ('renderer/src/gpu/' + n + '.js');

const PAGE = `<!doctype html><meta charset="utf-8"><title>MOSS 管線 GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>MOSS 管線：全域一步＋本地取樣走 WebGPU，對 ORT 參考幀</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const M = window.__mods.moss_core, MG = window.__mods.moss_decoder, MGPU = window.__mods.moss_gpu, ML = window.__mods.moss_local, MS = window.__mods.moss_sampling;
    const ref = await (await fetch('/ref.json')).json();
    const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    let t0 = performance.now();
    const gOnnx = await get('/global.onnx'), gData = await get('/data/global.bin');
    const lOnnx = await get('/local.onnx'), lData = await get('/data/local.bin');
    R.載入ms = Math.round(performance.now() - t0);
    const gModel = MG.loadMossDecodeStep(gOnnx, { 'moss_tts_global_shared.data': gData });
    const lModel = ML.loadMossLocal(lOnnx, { 'moss_tts_local_shared.data': lData });
    const ops = MGPU.makeGpuOps({ navigator });
    const ids = Int32Array.from(ref.ids), rows = ref.rows;
    const runners = {
      prefill: async (ids2, n) => {
        let caches = null, hidden = null;
        for (let r = 0; r < n; r++) { const o = await MG.decodeStep(gModel, ids2.subarray(r * M.ROW, (r + 1) * M.ROW), caches, ops); caches = o.caches; hidden = o.hidden; R.進度 = '預填 ' + (r + 1) + '/' + n; }
        return { hidden: hidden, past: caches };
      },
      decode: async (row, len, past) => { const o = await MG.decodeStep(gModel, row, past, ops); return { hidden: o.hidden, past: o.caches }; },
      sample: async (hidden, seen, u1, u2) => { const s = await MS.sampleFrame(lModel, hidden, seen, u1[0], u2, ops); return { cont: s.shouldContinue === 1, frame: s.frameTokenIds }; },
    };
    t0 = performance.now();
    const g = await M.generate(runners, ref.cfg, { ids: ids, rows: rows }, { maxFrames: ref.maxFrames, seed: ref.seed });
    R.生成ms = Math.round(performance.now() - t0);
    const same = g.count === ref.ortCount && g.frames.length === ref.ortFrames.length && ref.ortFrames.every((v, i) => v === g.frames[i]);
    R.幀數 = { GPU: g.count, ORT: ref.ortCount }; R.幀完全一致 = same; R.停止 = g.stopped;
    R.tiers = JSON.parse(JSON.stringify(ops.tiers));
    R.pass = same;
    R.done = true;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_moss_pipeline_gpu_check.result.json');
function sendFile(res, file, type, extra) {
  const st = fs.statSync(file);
  res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' }, extra || {}));
  fs.createReadStream(file).pipe(res);
}
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + MODS.map((n) => SHIM(n, modFile(n))).join('\n'));
  if (req.url === '/ref.json') return send(200, 'application/json', fs.readFileSync(REF));
  if (req.url === '/global.onnx') return sendFile(res, FILES.global, 'application/octet-stream');
  if (req.url === '/local.onnx') return sendFile(res, FILES.local, 'application/octet-stream');
  if (req.url === '/data/global.bin') return sendFile(res, FILES.globalData, 'application/octet-stream');
  if (req.url === '/data/local.bin') return sendFile(res, FILES.localData, 'application/octet-stream');
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('MOSS 管線 GPU 驗證：http://127.0.0.1:' + PORT + '/'));
