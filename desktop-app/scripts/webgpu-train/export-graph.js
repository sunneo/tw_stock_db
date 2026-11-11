#!/usr/bin/env node
// 把全 28 層 Qwen3 LoRA 訓練圖輸出成檔案，給「瀏覽器頁面」(page.html) 用 ORT-web 的 WebGPU／WASM 執行：
//   node scripts/webgpu-train/export-graph.js <model_quantized.onnx> <輸出資料夾> [T=32] [rank=8] [layers=28] [chunks=8]
// 輸出：train.onnx、meta.json（輸入規格、輸出名稱、優化器狀態對應、ids/targets）、init.bin（所有可訓練張量的初始值，float32 串接；A 隨機、B 為 0）
const fs = require('fs'), path = require('path');
const [modelPath, outDir, TS, rS, lyS, chS] = process.argv.slice(2); if (!modelPath || !outDir) { console.error('用法見檔頭'); process.exit(2); }
const T = +(TS || 32), rank = +(rS || 8), nl = +(lyS || 28), chunks = +(chS || 8);
const Ref = require('../../renderer/src/studio/lora_ref_train.js'), Gm = require('../../renderer/src/studio/onnx_grad_core.js'), Q = require('../../renderer/src/studio/qwen3_graph.js');
const buf = fs.readFileSync(modelPath); const M = Q.openModel(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
const rng = Ref.makeRng(5); const seq = Array.from({ length: T + 1 }, () => 1000 + Math.floor(rng() * 50000)); const ids = seq.slice(0, T), tgt = seq.slice(1);
const hostEmbed = process.env.FA_HOST_EMBED === '1'; const blk = Q.buildFull(M, T, rank, { layers: nl, headChunks: chunks, hostEmbed, debug: process.env.FA_DEBUG === '1' }); const { g } = blk;
const gr = Gm.grad(g, blk.loss, blk.params.map((p) => p.name)); const st = Gm.adam(g, blk.params, gr, {});
const probeGrads = blk.params.filter((p) => ['l0.q.A', 'l0.q.B', 'l' + (nl - 1) + '.down.A', 'l' + (nl - 1) + '.down.B'].includes(p.name)).map((p) => { g.output(gr.get(p.name)); return { param: p.name, out: gr.get(p.name).name }; });
fs.mkdirSync(outDir, { recursive: true });
const bytes = Gm.toOnnx(g, { name: 'qwen3_full' }); fs.writeFileSync(path.join(outDir, 'train.onnx'), bytes);
const total = blk.params.reduce((a, p) => a + Gm.prod(p.shape), 0); const init = new Float32Array(total); let o = 0;
for (const p of blk.params) { const n = Gm.prod(p.shape); if (/\.A$/.test(p.name)) for (let i = 0; i < n; i++) init[o + i] = Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()) / Math.sqrt(p.shape[0]); o += n; }
fs.writeFileSync(path.join(outDir, 'init.bin'), Buffer.from(init.buffer));
if (hostEmbed) fs.writeFileSync(path.join(outDir, 'x.bin'), Buffer.from(Float32Array.from(Q.embed(M, ids)).buffer));
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ dbg: blk.dbg, hostEmbed, T, rank, layers: nl, chunks: blk.C, Vc: blk.Vc, ids, tgt, loss: blk.loss.name, params: blk.params.map((p) => ({ name: p.name, shape: p.shape })), state: st, probeGrads }));
console.log('輸出 ' + outDir + '：train.onnx ' + (bytes.length / 1048576).toFixed(0) + 'MB、節點 ' + g.nodes.length + '、可訓練 ' + total + ' 個參數');
