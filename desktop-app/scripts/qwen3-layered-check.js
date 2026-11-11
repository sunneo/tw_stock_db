#!/usr/bin/env node
// 逐層引擎 vs 全圖版對拍：同一組 ids／targets／初始值（取自 export-graph 的輸出資料夾），前 N 步的 loss 應與全圖版相同。
//   ELECTRON_RUN_AS_NODE=1 <electron.exe> scripts/qwen3-layered-check.js <model_quantized.onnx> <onnxruntime-web 安裝資料夾> <export-graph 輸出資料夾> [steps=3] [lr=0.001] [layers=28]
const fs = require('fs'), path = require('path');
const [modelPath, ortDir, dataDir, stS, lrS, lyS] = process.argv.slice(2); if (!modelPath || !ortDir || !dataDir) { console.error('用法見檔頭'); process.exit(2); }
const steps = +(stS || 3), lr = +(lrS || 0.001), nl = +(lyS || 28);
const Q = require('../renderer/src/studio/qwen3_graph.js'), E = require('../renderer/src/studio/qwen3_layered_engine.js');
const ort = require(path.join(ortDir, 'node_modules', 'onnxruntime-web')); ort.env.wasm.numThreads = +(process.env.FA_ORT_THREADS || 1);
const mb = (x) => (x / 1048576).toFixed(0) + 'MB';
(async () => {
    const buf = fs.readFileSync(modelPath); const M = Q.openModel(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8')); const ib = fs.readFileSync(path.join(dataDir, 'init.bin')); const init = new Float32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.length));
    const map = new Map(); let off = 0; for (const p of meta.params) { const n = p.shape.reduce((a, b) => a * b, 1); map.set(p.name, init.slice(off, off + n)); off += n; }
    // 全圖版 meta 的參數名稱順序為 q,k,v,o,gate,up,down 各 A,B（與引擎相同）
    const eng = new E.LayeredEngine({ ort, ep: process.env.FA_EP || 'wasm', M, T: meta.T, rank: meta.rank, layers: nl, headChunks: meta.chunks, lr });
    eng.initParams(map);
    console.log('逐層引擎：層數 ' + nl + '、T=' + meta.T + '、rank=' + meta.rank + '、ep=' + eng.ep + '、RSS ' + mb(process.memoryUsage().rss));
    const losses = []; for (let i = 1; i <= steps; i++) { const r = await eng.step(meta.ids, meta.tgt); losses.push(r.loss); console.log('步 ' + i + '：loss ' + r.loss.toFixed(5) + '，梯度範數 ' + r.gradNorm.toFixed(4) + '，' + r.ms + ' ms，RSS ' + mb(process.memoryUsage().rss) + '，工作階段建立 ' + eng.stats.created + ' 個（' + eng.stats.createMs + ' ms）'); }
    console.log('LOSSES ' + JSON.stringify(losses) + ' 峰值 RSS ' + mb(process.resourceUsage().maxRSS * 1024));
    process.exit(0);
})().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });
