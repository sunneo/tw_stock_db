'use strict';
// 28 層 MLP 的派發串接量測（唯讀量測，不改推論路徑）。真瀏覽器頁面（Claude in Chrome 開 http://127.0.0.1:18768/）量三種做法，都是 84 次 q8 矩陣乘（28 層 × gate／up／down，M=1）：
//   A：每次派發各自 submit 並讀回（與目前 mlpForward 相同的做法）
//   B：84 次派發串在同一個 command buffer，最後只讀回一次（不是每次 readback）
//   C：純 JS 參考版（q8mmRef），同樣 84 次
// 注意（如實）：28 層用同一組第 0 層權重與不同的輸入向量重複計算。計時與權重數值無關，所以這是 MLP 派發的成本量測，不是完整的 28 層推論。
// 注意：這裡沒有 GPU 端的動態量化與 SiLU，層與層之間沒有真實的資料相依，所以 B 的成本是「沒有相依」下的下限。
// 用法：node scripts/eval/cudaweb_mlp_chain.js 18768 ；驗證完呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 18768;
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const modelPath = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const w = poc.extractWeights(lite.parseModel(fs.readFileSync(modelPath)), 0);
const meta = {
  gate: { K: w.gate.K, N: w.gate.N, zp: w.gate.zp, scale: w.gate.scale }, up: { K: w.up.K, N: w.up.N, zp: w.up.zp, scale: w.up.scale },
  down: { K: w.down.K, N: w.down.N, zp: w.down.zp, scale: w.down.scale },
};
const bin = { gate: w.gate.W, up: w.up.W, down: w.down.W };

const SHIM = (name, file) => 'window.__mods=window.__mods||{};window.__mods[' + JSON.stringify(name) + ']=(function(){var module={exports:{}};var exports=module.exports;function require(n){var k=n.replace(/^\\.\\//,"").replace(/\\.js$/,"");if(window.__mods[k])return window.__mods[k];if(k==="gpu_core")return window.FaGpuCore;throw new Error("no "+n)}\n' + rd(file) + '\nreturn module.exports})();';

const PAGE = `<!doctype html><meta charset="utf-8"><title>28 層 MLP 派發量測</title>
<body style="font:14px/1.5 system-ui;margin:16px"><h3>28 層 MLP 派發量測（真 WebGPU）</h3><pre id="out">執行中…</pre>
<script src="/gpu_core.js"></script><script src="/mods.js"></script>
<script>
(async () => {
  const out = document.getElementById('out');
  const R = { userAgent: navigator.userAgent, navigatorGpu: !!navigator.gpu, layers: 28, matmulsPerRun: 84, M: 1, note: '28 層用同一組第 0 層權重與不同輸入重複計算；沒有 GPU 端動態量化與 SiLU，層間沒有真實相依' };
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  try {
    const NN = window.__mods.nn_ops, IO = window.__mods.infer_ops;
    const meta = await (await fetch('/meta.json')).json();
    const get = async (n) => new Uint8Array(await (await fetch('/w/' + n)).arrayBuffer());
    const Wg = await get('gate'), Wu = await get('up'), Wd = await get('down');
    const g = await NN.getDevice(navigator); if (!g.dev) throw new Error('沒有 WebGPU：' + g.reason);
    const dev = g.dev;
    const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: IO.WGSL_Q8MM }), entryPoint: 'main' } });
    const pad4 = (u8) => { const p = (u8.length + 3) & ~3; if (p === u8.length) return u8; const c = new Uint8Array(p); c.set(u8); return c; };
    const wbuf = (u8) => { const b = dev.createBuffer({ size: pad4(u8).byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST }); dev.queue.writeBuffer(b, 0, pad4(u8)); return b; };
    const gW = wbuf(Wg), uW = wbuf(Wu), dW = wbuf(Wd);
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const mkX = (n) => Int32Array.from({ length: n }, () => Math.floor(rnd() * 255) - 127);
    const SC = 0.01; // 輸入 scale（量測用的固定值）
    const specs = [
      { name: 'gate', wb: gW, W: Wg, K: meta.gate.K, N: meta.gate.N, zp: meta.gate.zp, sc: meta.gate.scale },
      { name: 'up', wb: uW, W: Wu, K: meta.up.K, N: meta.up.N, zp: meta.up.zp, sc: meta.up.scale },
      { name: 'down', wb: dW, W: Wd, K: meta.down.K, N: meta.down.N, zp: meta.down.zp, sc: meta.down.scale },
    ];
    const inputs = {}; for (const s of specs) inputs[s.name] = mkX(s.K);
    const mkOp = (sp) => {
      const xb = dev.createBuffer({ size: sp.K * 4, usage: USAGE.STORAGE | USAGE.COPY_DST });
      dev.queue.writeBuffer(xb, 0, inputs[sp.name]);
      const yb = dev.createBuffer({ size: sp.N * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
      const rb = dev.createBuffer({ size: sp.N * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST });
      const ub = dev.createBuffer({ size: 32, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      const ab = new ArrayBuffer(32), dv = new DataView(ab);
      dv.setUint32(0, 1, true); dv.setUint32(4, sp.K, true); dv.setUint32(8, sp.N, true); dv.setInt32(12, sp.zp, true); dv.setFloat32(16, Math.fround(sp.sc * SC), true);
      dev.queue.writeBuffer(ub, 0, new Uint8Array(ab));
      const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: xb } }, { binding: 1, resource: { buffer: sp.wb } }, { binding: 2, resource: { buffer: yb } }, { binding: 3, resource: { buffer: ub } } ] });
      return { sp, yb, rb, bg };
    };
    const opsList = [];
    for (let l = 0; l < 28; l++) for (const s of specs) opsList.push(mkOp(s));
    const dispatchOne = (enc, o) => { const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, o.bg); pass.dispatchWorkgroups(Math.ceil(o.sp.N / 64), 1); pass.end(); };
    // A：每次派發各自 submit 並讀回
    const runA = async () => { let last = null; for (const o of opsList) { const enc = dev.createCommandEncoder(); dispatchOne(enc, o); enc.copyBufferToBuffer(o.yb, 0, o.rb, 0, o.sp.N * 4); dev.queue.submit([enc.finish()]); await o.rb.mapAsync(1); last = o.rb.getMappedRange().slice(0); o.rb.unmap(); } return new Float32Array(last); };
    // B：84 次派發串在同一個 command buffer，最後只讀回最後一個輸出
    const runB = async () => { const enc = dev.createCommandEncoder(); for (const o of opsList) dispatchOne(enc, o); const L = opsList[opsList.length - 1]; enc.copyBufferToBuffer(L.yb, 0, L.rb, 0, L.sp.N * 4); dev.queue.submit([enc.finish()]); await L.rb.mapAsync(1); const d = new Float32Array(L.rb.getMappedRange().slice(0)); L.rb.unmap(); return d; };
    // C：純 JS 參考版，同樣 84 次
    const xqOf = (x) => x; // 輸入已是整數（扣過 zero point）
    const runC = () => { let last = null; for (let l = 0; l < 28; l++) for (const s of specs) last = IO.q8mmRef(xqOf(inputs[s.name]), s.W, s.zp, 1, s.K, s.N, Math.fround(s.sc * SC)); return last; };
    // 暖機
    await runA(); await runB(); runC();
    const tA = [], tB = [], tC = [];
    let dA = null, dB = null, dC = null;
    for (let i = 0; i < 5; i++) { let t = performance.now(); dA = await runA(); tA.push(performance.now() - t); }
    for (let i = 0; i < 5; i++) { let t = performance.now(); dB = await runB(); tB.push(performance.now() - t); }
    for (let i = 0; i < 3; i++) { let t = performance.now(); dC = runC(); tC.push(performance.now() - t); }
    R.A_readbackEachMedianMs = med(tA); R.A_min = Math.min(...tA); R.A_max = Math.max(...tA);
    R.B_oneCommandBufferMedianMs = med(tB); R.B_min = Math.min(...tB); R.B_max = Math.max(...tB);
    R.C_jsMedianMs = med(tC); R.C_min = Math.min(...tC); R.C_max = Math.max(...tC);
    R.A_perOpMs = R.A_readbackEachMedianMs / 84; R.B_perOpMs = R.B_oneCommandBufferMedianMs / 84; R.C_perOpMs = R.C_jsMedianMs / 84;
    R.speedup_B_vs_A = R.A_readbackEachMedianMs / R.B_oneCommandBufferMedianMs;
    R.speedup_B_vs_C = R.C_jsMedianMs / R.B_oneCommandBufferMedianMs;
    let md = 0, mr = 0; for (let i = 0; i < dC.length; i++) { md = Math.max(md, Math.abs(dC[i] - dB[i])); mr = Math.max(mr, Math.abs(dC[i])); }
    R.B_vs_jsLastOpRel = md / (mr || 1);
    let md2 = 0; for (let i = 0; i < dC.length; i++) md2 = Math.max(md2, Math.abs(dC[i] - dA[i]));
    R.A_vs_jsLastOpRel = md2 / (mr || 1);
    R.pass = R.B_vs_jsLastOpRel < 1e-4;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); R.pass = false; }
  out.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '量測完成';
})();
</script>`;

const RESULT = path.join(os.tmpdir(), 'cudaweb_mlp_chain.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/mods.js') return send(200, 'application/javascript', 'window.__mods={onnx_lite:{}};\n' + ['nn_ops', 'infer_ops'].map((n) => SHIM(n, 'renderer/src/gpu/' + n + '.js')).join('\n'));
  if (req.url === '/meta.json') return send(200, 'application/json', JSON.stringify(meta));
  if (req.url.startsWith('/w/') && bin[req.url.slice(3)]) { const b = bin[req.url.slice(3)]; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); return res.end(Buffer.from(b.buffer, b.byteOffset, b.length)); }
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log('28 層 MLP 派發量測：http://127.0.0.1:' + PORT + '/'));
