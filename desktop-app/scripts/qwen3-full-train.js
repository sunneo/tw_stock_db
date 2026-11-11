#!/usr/bin/env node
// 全 28 層 Qwen3 的 LoRA 訓練圖（前向＋反向＋圖內 Adam）交給 onnxruntime-web（WASM）執行，量步時間、記憶體、loss 下降。
// 用 Electron 內建 node 執行：
//   ELECTRON_RUN_AS_NODE=1 <electron.exe> scripts/qwen3-full-train.js <model_quantized.onnx> <onnxruntime-web 安裝資料夾> [T=32] [rank=8] [steps=6] [layers=28] [--real-ce]
// --real-ce：只用真模型（原始 q8 圖）算同一序列的交叉熵，與訓練圖第 0 步（B=0，LoRA 不起作用）的 loss 對照。
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--')); const realCE = process.argv.includes('--real-ce');
const [modelPath, ortDir, TS, rS, stS, lyS] = args; if (!modelPath || !ortDir) { console.error('用法見檔頭'); process.exit(2); }
const T = +(TS || 32), rank = +(rS || 8), steps = +(stS || 6), nl = +(lyS || 28);
const Ref = require('../renderer/src/studio/lora_ref_train.js'), Gm = require('../renderer/src/studio/onnx_grad_core.js'), Q = require('../renderer/src/studio/qwen3_graph.js');
const ort = require(path.join(ortDir, 'node_modules', 'onnxruntime-web')); ort.env.wasm.numThreads = +(process.env.FA_ORT_THREADS || 1);
const mb = (x) => (x / 1048576).toFixed(0) + 'MB';
const rss = () => mb(process.memoryUsage().rss);
(async () => {
    const buf = fs.readFileSync(modelPath); const M = Q.openModel(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    const rng = Ref.makeRng(5); const seq = Array.from({ length: T + 1 }, () => 1000 + Math.floor(rng() * 50000)); const ids = seq.slice(0, T), tgt = seq.slice(1);
    if (realCE) {
        const rs = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.length), { executionProviders: ['wasm'] });
        const inp = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, T]), attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, T]), position_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, T]) };
        for (const nm of rs.inputNames) if (/^past_key_values/.test(nm)) inp[nm] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
        const lg = (await rs.run(inp)).logits.data, V = lg.length / T; let ce = 0;
        for (let t = 0; t < T; t++) { let mx = -Infinity; for (let j = 0; j < V; j++) mx = Math.max(mx, lg[t * V + j]); let s = 0; for (let j = 0; j < V; j++) s += Math.exp(lg[t * V + j] - mx); ce += -(lg[t * V + tgt[t]] - mx - Math.log(s)); }
        console.log('真模型（原始 q8 圖）同序列交叉熵 = ' + (ce / T).toFixed(5) + '（T=' + T + '）'); process.exit(0);
    }
    let t0 = Date.now(); const blk = Q.buildFull(M, T, rank, { layers: nl, headChunks: +(process.env.FA_HEAD_CHUNKS || 8) }); const { g } = blk;
    const gr = Gm.grad(g, blk.loss, blk.params.map((p) => p.name)); const st = Gm.adam(g, blk.params, gr, {});
    const tBuild = Date.now() - t0; t0 = Date.now(); const bytes = Gm.toOnnx(g, { name: 'qwen3_full' }); const tSer = Date.now() - t0;
    console.log('層數 ' + nl + '、T=' + T + '、rank=' + rank + '：節點 ' + g.nodes.length + '、可訓練張量 ' + blk.params.length + '（' + blk.params.reduce((a, p) => a + Gm.prod(p.shape), 0) + ' 個參數）；建圖 ' + tBuild + ' ms、序列化 ' + mb(bytes.length) + '（' + tSer + ' ms）；RSS ' + rss());
    t0 = Date.now(); const sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: process.env.FA_ORT_OPT || 'disabled' }); console.log('ORT-web 建立工作階段 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒；RSS ' + rss());
    const V = blk.V, Vc = blk.Vc; const feeds = { ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [T]), rowmask: new ort.Tensor('float32', new Float32Array(T).fill(1 / T), [T]) };
    for (let k = 0; k < blk.C; k++) { const oh = new Float32Array(T * Vc); tgt.forEach((id, t) => { if (id >= k * Vc && id < (k + 1) * Vc) oh[t * Vc + id - k * Vc] = 1; }); feeds['onehot' + k] = new ort.Tensor('float32', oh, [T, Vc]); }
    for (const p of blk.params) { const n = Gm.prod(p.shape), a = new Float32Array(n); if (/\.A$/.test(p.name)) { for (let i = 0; i < n; i++) a[i] = Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()) / Math.sqrt(p.shape[0]); } feeds[p.name] = new ort.Tensor('float32', a, p.shape); feeds[p.name + '.m'] = new ort.Tensor('float32', new Float32Array(n), p.shape); feeds[p.name + '.v'] = new ort.Tensor('float32', new Float32Array(n), p.shape); }
    const lr = +(process.env.FA_LR || 0.005); const losses = [], times = [];
    for (let i = 1; i <= steps; i++) {
        feeds.adam_alpha = new ort.Tensor('float32', Float32Array.of(lr / (1 - Math.pow(0.9, i))), []); feeds.adam_c2 = new ort.Tensor('float32', Float32Array.of(1 / (1 - Math.pow(0.999, i))), []);
        const t = Date.now(); const out = await sess.run(feeds); times.push(Date.now() - t); losses.push(out[blk.loss.name].data[0]);
        for (const s of st) { feeds[s.param] = out[s.p]; feeds[s.m] = out[s.m2]; feeds[s.v] = out[s.v2]; }
        console.log('步 ' + i + '：loss ' + losses[i - 1].toFixed(5) + '，' + times[i - 1] + ' ms，RSS ' + rss());
    }
    console.log('第 0 步（B=0）loss = ' + losses[0].toFixed(5) + '；最後一步 loss = ' + losses[losses.length - 1].toFixed(5) + '；暖機後平均 ' + (times.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, times.length - 1) / 1000).toFixed(2) + ' 秒／步；每步 ' + T + ' token ≈ ' + (T / (times.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, times.length - 1) / 1000)).toFixed(1) + ' token/s；峰值 RSS ' + mb(process.resourceUsage().maxRSS * 1024));
    process.exit(losses[losses.length - 1] < losses[0] ? 0 : 1);
})().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });
