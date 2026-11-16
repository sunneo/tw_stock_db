'use strict';
// LoRA 訓練端到端 GPU 驗證（清單 I）：真 Chrome WebGPU（無 GPU 時 SwiftShader）跑 20 步，與 CPU 同步參考的 loss 軌跡逐步對拍。
// 矩陣乘走 cudaweb 執行期，rmsnorm／softmax／silu／rope／adamw 走 nn_ops.trainerOps（T1 WGSL）。
// 用法：node scripts/eval/cudaweb_train_browser.js [埠=18783]；結果 POST /result，寫 $TMP/cudaweb_train_browser.result.json；完成後呼叫 /quit。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = Number(process.argv[2]) || 18783;
const rd = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const shim = (name, src, map) => 'window.' + name + '=function(){var module={exports:{}};var exports=module.exports;function require(n){var m=' + JSON.stringify(map || {}) + ';if(n in m)return eval(m[n]);throw new Error("no "+n)}\n' + src + '\nreturn module.exports};';
const PAGE = `<!doctype html><meta charset=utf-8><title>train</title><pre id=o>running</pre>
<script src="/gpu_core.js"></script><script src="/nn_ops.js"></script><script src="/train.js"></script>
<script>
(async () => {
  const R = { steps: [] }; const o = document.getElementById('o');
  try {
    const NN = window.__nnLoad(), T = window.__trainLoad(), rt = window.FaGpuCore.createRuntime({ navigator });
    const cfg = { V: 11, d: 8, L: 2, H: 2, F: 12, r: 2, alpha: 4 };
    const toks = [1, 4, 7, 2, 9, 3, 0, 5, 8], N = 20, lr = 0.02;
    const mk = () => { const m = T.makeModel(cfg, 3); for (const lo of m.lora) for (const k of ['q', 'k', 'v', 'o']) for (let i = 0; i < lo[k].B.length; i++) lo[k].B[i] *= 4; return m; };
    const mc = mk(), ac = T.adamInit(mc), cpu = [];
    for (let s = 0; s < N; s++) { const r = T.lossAndGrads(mc, toks); T.adamStep(mc, r.grads, ac, lr); cpu.push(r.loss); }
    const mg = mk(), ag = T.adamInit(mg), be = T.cudawebMatmulBackend(rt), ops = NN.trainerOps({ navigator }), t0 = performance.now(), gpu = [];
    for (let s = 0; s < N; s++) { const r = await T.lossAndGradsAsync(mg, toks, { backend: be, ops }); await T.adamStepAsync(mg, r.grads, ag, lr, ops); gpu.push(r.loss); }
    R.ms = Math.round(performance.now() - t0); R.layers = ops.stats.layers; R.matmulLayer = be.layer; R.matmulReason = be.reason; R.matmulCalls = be.calls;
    let worst = 0;
    for (let s = 0; s < N; s++) { const rel = Math.abs(gpu[s] - cpu[s]) / Math.abs(cpu[s]); if (rel > worst) worst = rel; R.steps.push({ s, cpu: cpu[s], gpu: gpu[s], rel }); }
    R.worstRel = worst; R.decreasing = gpu[N - 1] < gpu[0] && cpu[N - 1] < cpu[0];
    R.allT1 = Object.keys(R.layers).every((k) => k.endsWith(':T1'));
    R.pass = worst < 1e-3 && R.decreasing && R.allT1; // 門檻 1e-3：f32 GPU 對 f64 CPU 的 20 步軌跡漂移（Adam 放大），第 0 步約 1e-6 R.done = true;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 1500); }
  o.textContent = JSON.stringify(R, null, 1);
  try { await fetch('/result', { method: 'POST', body: JSON.stringify(R) }); } catch (_) {}
  document.title = '驗證完成';
})();
</script>`;
const RESULT = path.join(os.tmpdir(), 'cudaweb_train_browser.result.json');
const srv = http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.url === '/' || req.url.startsWith('/?')) return send(200, 'text/html', PAGE);
  if (req.url === '/gpu_core.js') return send(200, 'application/javascript', rd('renderer/src/gpu/gpu_core.js'));
  if (req.url === '/nn_ops.js') return send(200, 'application/javascript', shim('__nnLoad', rd('renderer/src/gpu/nn_ops.js'), { './gpu_core.js': 'window.FaGpuCore' }));
  if (req.url === '/train.js') return send(200, 'application/javascript', shim('__trainLoad', rd('renderer/src/studio/lora_ref_train.js')));
  if (req.url === '/result' && req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.writeFileSync(RESULT, b); console.log('結果已寫入 ' + RESULT); send(200, 'text/plain', 'ok'); }); return; }
  if (req.url === '/quit') { send(200, 'text/plain', 'bye'); setTimeout(() => { srv.close(); process.exit(0); }, 100); return; }
  send(404, 'text/plain', 'nf');
});
srv.listen(PORT, '127.0.0.1', () => console.log('http://127.0.0.1:' + PORT + '/'));
