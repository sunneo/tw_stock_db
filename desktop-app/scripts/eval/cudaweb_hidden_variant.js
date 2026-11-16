'use strict';
// 驗證「隱藏狀態變體圖」：用 onnx_lite 從現有 q8 模型改出「不算 lm_head、改輸出 final_norm 結果」的變體（記憶體內，不寫檔），
// 用真 ORT 各跑一步：原模型的 logits，與「變體的隱藏狀態 → q8lm（CPU 參考版）」得到的 logits 比對。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_hidden_variant.js
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');
const LAYERS = 28, KV = 8, HD = 128;
(async () => {
  const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
  const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
  const orig = fs.readFileSync(path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx'));
  const model = lite.parseModel(orig);
  const mm = model.nodes.find((n) => n.name === '/lm_head/MatMul');
  const hiddenName = mm.inputs[0];
  const t0 = Date.now();
  const v = lite.buildHiddenStateModel(orig, { dropNodeName: '/lm_head/MatMul', replaceOutput: 'logits', hiddenName: hiddenName, hiddenDims: ['batch_size', 'sequence_length', 1024] });
  const vbuf = v.buf();
  const buildMs = Date.now() - t0;
  const feeds = () => {
    const f = {};
    for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) f['past_key_values.' + l + '.' + k] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
    const ids = [151644, 872, 198, 9707, 11, 1879, 0];  // 任意固定的 7 個詞元
    f.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    f.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, ids.length]);
    return f;
  };
  const so = { executionProviders: ['cpu'] };
  const s1 = await ort.InferenceSession.create(new Uint8Array(orig), so);
  const r1 = await s1.run(feeds());
  const V = r1.logits.dims[2], T = r1.logits.dims[1];
  const lg = r1.logits.data.subarray((T - 1) * V, T * V);
  const s2 = await ort.InferenceSession.create(new Uint8Array(vbuf), so);
  const r2 = await s2.run(feeds());
  const hd = r2[hiddenName]; const H = hd.dims[2];
  const h = Float32Array.from(hd.data.subarray((T - 1) * H, T * H));
  const w = poc.extractWeights(model, 0);
  const mine = ops.q8lmRef(h, w.lm.W, w.lm.zp, w.lm.V, w.lm.K, w.lm.scale);
  const c = poc.compare(mine, lg);
  let a1 = 0, a2 = 0; for (let i = 1; i < V; i++) { if (lg[i] > lg[a1]) a1 = i; if (mine[i] > mine[a2]) a2 = i; }
  // present.* 輸出也要一致（KV 快取不能被變體破壞）
  let kvSame = true; for (const k of ['present.0.key', 'present.27.value']) { const x = r1[k].data, y = r2[k].data; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { kvSame = false; break; } }
  const out = { hiddenName, removed: v.removed, origBytes: orig.length, variantBytes: vbuf.length, buildMs, hiddenDims: hd.dims, maxRel: c.maxRel, refMax: c.refMax, argmaxOrig: a1, argmaxVariant: a2, kvSame, pass: c.maxRel < 1e-4 && a1 === a2 && kvSame };
  fs.writeFileSync(path.join(__dirname, 'cudaweb_hidden_variant.result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
