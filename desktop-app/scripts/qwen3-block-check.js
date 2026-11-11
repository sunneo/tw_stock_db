#!/usr/bin/env node
// 真 Qwen3 單一區塊的反向圖對拍（DESIGN.TODO.offline-training-studio.md §5.6 階段 2）。
// 用 Electron 內建 node 執行（ORT-web 的 WASM 在 node 16 會閃退）：
//   ELECTRON_RUN_AS_NODE=1 <electron.exe> scripts/qwen3-block-check.js <model_quantized.onnx> <onnxruntime-web 安裝資料夾> [層號=0] [T=8] [rank=8] [--real-forward]
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--')); const real = process.argv.includes('--real-forward');
const [modelPath, ortDir, layerS, TS, rS] = args; if (!modelPath || !ortDir) { console.error('用法見檔頭'); process.exit(2); }
const layer = +(layerS || 0), T = +(TS || 8), rank = +(rS || 8);
const Ref = require('../renderer/src/studio/lora_ref_train.js'), Gm = require('../renderer/src/studio/onnx_grad_core.js'), Q = require('../renderer/src/studio/qwen3_graph.js');
const ort = require(path.join(ortDir, 'node_modules', 'onnxruntime-web')); ort.env.wasm.numThreads = 1;
const relL2 = (a, b) => { let n = 0, d = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - b[i]) ** 2; d += b[i] ** 2; } return Math.sqrt(n / (d || 1)); };
(async () => {
    const buf = fs.readFileSync(modelPath); const M = Q.openModel(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    const rng = Ref.makeRng(5); const ids = Array.from({ length: T }, () => 1000 + Math.floor(rng() * 50000));
    const x = Q.embed(M, ids), probe = new Float64Array(T * 1024); for (let i = 0; i < probe.length; i++) probe[i] = (rng() - 0.5) * 2;
    const blk = Q.buildBlock(M, layer, T, rank, probe); const { g } = blk;
    const gr = Gm.grad(g, blk.loss, blk.params.map((p) => p.name)); blk.params.forEach((p) => g.output(gr.get(p.name)));
    const feeds = { x }; for (const p of blk.params) { const n = Gm.prod(p.shape), a = new Float64Array(n), sd = /\.A$/.test(p.name) ? 0.03 : 0.02; for (let i = 0; i < n; i++) a[i] = (rng() - 0.5) * 2 * sd; feeds[p.name] = a; }
    console.log('區塊 ' + layer + '：節點 ' + g.nodes.length + '、可訓練張量 ' + blk.params.length + '、T=' + T + '、rank=' + rank);
    let t0 = Date.now(); const vals = Gm.run(g, feeds); const tInterp = Date.now() - t0;
    // 有限差分（fp64 直譯器）
    let worst = 0, n = 0; const eps = 1e-4; t0 = Date.now();
    for (const p of blk.params) for (let s = 0; s < 2; s++) {
        const i = Math.floor(rng() * feeds[p.name].length), o = feeds[p.name][i];
        feeds[p.name][i] = o + eps; const lp = Gm.run(g, feeds).get(blk.loss.name).data[0]; feeds[p.name][i] = o - eps; const lm = Gm.run(g, feeds).get(blk.loss.name).data[0]; feeds[p.name][i] = o;
        const num = (lp - lm) / (2 * eps), gg = vals.get(gr.get(p.name).name).data[i]; const rel = Math.abs(gg - num) / Math.max(Math.abs(gg), Math.abs(num), 1e-12); if (!(rel <= worst)) worst = rel; n++;
    }
    console.log('手寫對照＝有限差分：' + n + ' 個抽樣（每個 LoRA 張量 2 個）最大相對誤差 ' + worst.toExponential(2) + '（' + ((Date.now() - t0) / 1000).toFixed(0) + ' 秒；直譯器單次 ' + tInterp + ' ms）');
    // 交給真 ORT（fp32、WASM）
    const bytes = Gm.toOnnx(g, { name: 'qwen3_block' + layer }); console.log('序列化 ONNX ' + (bytes.length / 1048576).toFixed(1) + ' MB');
    t0 = Date.now(); const sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }); const tLoad = Date.now() - t0;
    const of = {}; for (const t of g.inputs) of[t.name] = new ort.Tensor('float32', Float32Array.from(feeds[t.name]), t.shape);
    let out; const ts = []; for (let i = 0; i < 3; i++) { const t = Date.now(); out = await sess.run(of); ts.push(Date.now() - t); }
    let gw = 0; for (const p of blk.params) gw = Math.max(gw, relL2(out[gr.get(p.name).name].data, vals.get(gr.get(p.name).name).data));
    const lossErr = Math.abs(out[blk.loss.name].data[0] - vals.get(blk.loss.name).data[0]) / Math.abs(vals.get(blk.loss.name).data[0]);
    console.log('ORT-web WASM fp32：載入 ' + tLoad + ' ms；單步（前向＋反向）' + ts.join('/') + ' ms；loss 相對誤差 ' + lossErr.toExponential(2) + '；全部 ' + blk.params.length + ' 個梯度對 fp64 最大相對 L2 誤差 ' + gw.toExponential(2));
    console.log('→ 外推 28 層：約 ' + (ts[2] * 28 / 1000).toFixed(1) + ' 秒／步（T=' + T + '，不含詞表輸出頭與逐層重算）；WASM 單執行緒，未用 WebGPU');
    if (real) {
        // 真模型前向對照：k（含 k_norm＋RoPE）與 v 對 present.<layer>.key/value
        const mb = buf; sess.release && sess.release();
        const rs = await ort.InferenceSession.create(new Uint8Array(mb.buffer, mb.byteOffset, mb.length), { executionProviders: ['wasm'] });
        const inp = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, T]), attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, T]), position_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, T]) };
        for (const nm of rs.inputNames) if (/^past_key_values/.test(nm)) inp[nm] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
        const ro = await rs.run(inp); const pk = ro['present.' + layer + '.key'], pv = ro['present.' + layer + '.value'];
        const kk = vals.get(blk.k.name).data, vv = vals.get(blk.v.name).data; // [T,8,128] → 對 [1,8,T,128]
        const tr = (a) => { const o = new Float64Array(a.length); for (let t = 0; t < T; t++) for (let h = 0; h < 8; h++) for (let j = 0; j < 128; j++) o[(h * T + t) * 128 + j] = a[(t * 8 + h) * 128 + j]; return o; };
        console.log('真模型前向對照（層 ' + layer + '）：key 相對 L2 誤差 ' + relL2(tr(kk), Array.from(pk.data)).toExponential(2) + '；value ' + relL2(tr(vv), Array.from(pv.data)).toExponential(2) + '（差異來源：真模型激活做 8 位元動態量化，訓練圖用浮點直通）');
    }
    process.exit(worst < 1e-3 ? 0 : 1);
})().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });
