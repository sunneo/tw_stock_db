'use strict';
// MOSS 本地解碼器（非快取）：線性層（c_attn、c_proj、fc_in、fc_out、文字與 16 個音訊 head）走真 WebGPU，其餘在 CPU；對 ORT 參考 logits 比對。
// 真瀏覽器（Claude in Chrome 開 http://127.0.0.1:18774/）。參考來自 cudaweb_moss_local_check.js 的第二參數輸出。
// 通過條件：兩組的文字與音訊 logits 相對誤差 < 1e-3、argmax 一致、所有線性層都在 T1。
// 用法：node scripts/eval/cudaweb_moss_local_gpu_check.js <MOSS 資料夾> <ORT 參考 json> [埠]
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const [DIR, REF] = [process.argv[2], process.argv[3]];
const PORT = Number(process.argv[4]) || 18774;
if (!DIR || !REF) { console.error('用法：node scripts/eval/cudaweb_moss_local_gpu_check.js <MOSS 資料夾> <ORT 參考 json> [埠]'); process.exit(2); }
const DATA = path.join(DIR, 'moss_tts_local_shared.data'), ONNX = path.join(DIR, 'moss_tts_local_decoder.onnx');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>MOSS 本地 GPU 驗證</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>MOSS 本地解碼器：線性層走 WebGPU 對 ORT 參考</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, sets: [] };
  const show = () => { out.textContent = JSON.stringify(R, null, 1); };
  try {
    const ML = window.__mods.moss_local, MG = window.__mods.moss_gpu;
    const ref = await (await fetch('/ref.json')).json();
    const onnxBuf = new Uint8Array(await (await fetch('/model.onnx')).arrayBuffer());
    const dataBuf = new Uint8Array(await (await fetch('/data/local.bin')).arrayBuffer());
    R.dataBytes = dataBuf.length;
    const model = ML.loadMossLocal(onnxBuf, { 'moss_tts_local_shared.data': dataBuf });
    const ops = MG.makeGpuOps({ navigator });
    const rel = (a, b) => { let d = 0, m = 0; for (let i = 0; i < b.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); m = Math.max(m, Math.abs(b[i])); } return d / (m || 1); };
    const argmax = (a) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };
    for (let s = 0; s < ref.refs.length; s++) {
      const r = ref.refs[s];
      const t0 = performance.now();
      const js = await ML.localDecode(model, Float32Array.from(r.gh), r.textId, r.audio, ops);
      const ms = performance.now() - t0;
      const A = r.audioDims[r.audioDims.length - 1], C = r.ortAudio.length / A;
      let worst = 0, agree = 0;
      for (let c = 0; c < C; c++) {
        const oa = r.ortAudio.slice(c * A, (c + 1) * A);
        worst = Math.max(worst, rel(js.audioLogits[c], oa));
        if (argmax(js.audioLogits[c]) === argmax(oa)) agree++;
      }
      R.sets.push({ 組: s, 文字相對誤差: rel(js.textLogits, r.ortText), 文字argmax一致: argmax(js.textLogits) === argmax(r.ortText), 音訊最差相對誤差: worst, 音訊argmax一致數: agree + '/' + C, 耗時毫秒: ms });
      R.tiers = JSON.parse(JSON.stringify(ops.tiers));
      show();
    }
    R.done = true;
    const allT1 = (o) => Object.keys(o).length === 1 && !!o.T1;
    R.pass = R.sets.every((x) => x.文字相對誤差 < 1e-3 && x.音訊最差相對誤差 < 1e-3 && x.文字argmax一致) && allT1(ops.tiers.linear);
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  show();
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_moss_local_gpu_check.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={};\n' + ['nn_ops', 'onnx_lite', 'moss_decoder', 'moss_gpu', 'moss_local'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/ref.json') return send(200, 'application/json', fs.readFileSync(REF));
  if (req.url === '/model.onnx') { const b = fs.readFileSync(ONNX); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(b); }
  if (req.url === '/data/local.bin') { const st = fs.statSync(DATA); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' }); return fs.createReadStream(DATA).pipe(res); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('MOSS 本地 GPU 驗證：http://127.0.0.1:' + PORT + '/'));
