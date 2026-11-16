'use strict';
// MOSS-TTS-Nano 全域解碼一步：手寫 CPU 參考版（renderer/src/gpu/moss_decoder.js）對真 ORT（CPU EP）比對。
// 三步解碼（含音訊 pad 列），每步各自用自己的 KV 快取；比對最終隱藏狀態（global_hidden）的相對誤差與 ORT 的權重維度。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_moss_check.js <MOSS 模型資料夾>
const fs = require('fs'), path = require('path');
const MS = require('../../renderer/src/gpu/moss_decoder.js');
const dir = process.argv[2];
if (!dir) { console.error('用法：... cudaweb_moss_check.js <MOSS 模型資料夾>'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

function cmp(a, b) { let d = 0, r = 0; for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); r = Math.max(r, Math.abs(b[i])); } return { rel: d / (r || 1), maxAbs: d }; }

(async () => {
  const onnxPath = path.join(dir, 'moss_tts_decode_step.onnx');
  const dataBuf = fs.readFileSync(path.join(dir, 'moss_tts_global_shared.data'));
  const dataFiles = { 'moss_tts_global_shared.data': new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length) };
  const model = MS.loadMossDecodeStep(fs.readFileSync(onnxPath), dataFiles);
  const L0 = model.layers[0];
  const dimsInfo = { cAttnW: L0.dims.cAttnW, cProjW: L0.dims.cProjW, fcInW: L0.dims.fcInW, fcOutW: L0.dims.fcOutW };
  const sess = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  // ORT 的 KV 快取（每層一對），形狀 [1, L, 12, 64]
  let ortCache = null, jsCache = null;
  const res = { 權重維度: dimsInfo, 步驟: [] };
  const refSteps = [];
  for (let t = 0; t < 3; t++) {
    const ids = [(t * 37 + 5) % 1000];
    for (let c = 0; c < 16; c++) ids.push(c === t ? MS.PAD : (t * 13 + c * 7 + 3) % 1024);
    const past = t;
    const feeds = {
      input_ids: new ort.Tensor('int32', Int32Array.from(ids), [1, 1, 17]),
      past_valid_lengths: new ort.Tensor('int32', Int32Array.from([past]), [1]),
    };
    for (let li = 0; li < MS.NL; li++) {
      const kK = ortCache ? ortCache[li].k : new ort.Tensor('float32', new Float32Array(0), [1, 0, MS.H, MS.HD]);
      const kV = ortCache ? ortCache[li].v : new ort.Tensor('float32', new Float32Array(0), [1, 0, MS.H, MS.HD]);
      feeds['past_key_' + li] = kK; feeds['past_value_' + li] = kV;
    }
    const o = await sess.run(feeds);
    ortCache = []; for (let li = 0; li < MS.NL; li++) ortCache.push({ k: o['present_key_' + li], v: o['present_value_' + li] });
    const ortHidden = Float32Array.from(o.global_hidden.data);
    const js = await MS.decodeStep(model, ids, jsCache);
    jsCache = js.caches;
    const r = cmp(js.hidden, ortHidden);
    res.步驟.push({ 步: t, 過去長度: past, 相對誤差: r.rel, 最大絕對誤差: r.maxAbs, ort維度: o.global_hidden.dims });
    refSteps.push({ ids, ortHidden: Array.from(ortHidden) });
  }
  res.pass = res.步驟.every((s) => s.相對誤差 < 1e-3);
  console.log(JSON.stringify(res, null, 1));
  // 可選第二參數：把三步的 ids 與 ORT 隱藏狀態寫成 JSON（給瀏覽器 GPU 驗證頁當比對目標）
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({ steps: refSteps }));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
