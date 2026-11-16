'use strict';
// MOSS 音訊編解碼器（moss_audio_tokenizer_decode_full.onnx）：通用 CPU 圖解釋器（renderer/src/gpu/onnx_interp.js）對真 ORT（CPU EP）比對。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_codec_interp_check.js <MOSS 資料夾> [T]
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const OI = require('../../renderer/src/gpu/onnx_interp.js');
const dir = process.argv[2];
const T = Number(process.argv[3] || 4);
if (!dir) { console.error('用法：... cudaweb_codec_interp_check.js <MOSS 資料夾> [T]'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

function cmp(a, b) {
  let d = 0, r = 0;
  for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); r = Math.max(r, Math.abs(b[i])); }
  return { abs: d, rel: d / (r || 1) };
}

(async () => {
  const onnxPath = path.join(dir, 'moss_audio_tokenizer_decode_full.onnx');
  const buf = fs.readFileSync(onnxPath);
  const dataBuf = fs.readFileSync(path.join(dir, 'moss_audio_tokenizer_decode_shared.data'));
  const dataFiles = { 'moss_audio_tokenizer_decode_shared.data': new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length) };
  const model = lite.parseModel(buf);
  const sess = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  const names = sess.inputNames;
  const codes = new Float64Array(16 * T);
  // 佈局 [1, T, 16]（最後一維是 16 條碼本）
  for (let t = 0; t < T; t++) for (let c = 0; c < 16; c++) codes[t * 16 + c] = (c * 37 + t * 101 + 5) % 1024;
  const ortFeeds = {}, jsFeeds = {};
  for (const nm of names) {
    if (/length/i.test(nm)) {
      ortFeeds[nm] = new ort.Tensor('int32', Int32Array.from([T]), [1]);
      jsFeeds[nm] = { d: [1], t: 'i', v: Float64Array.from([T]) };
    } else {
      ortFeeds[nm] = new ort.Tensor('int32', Int32Array.from(codes), [1, T, 16]);
      jsFeeds[nm] = { d: [1, T, 16], t: 'i', v: codes };
    }
  }
  console.log('輸入名稱：', JSON.stringify(names), '輸出名稱：', JSON.stringify(sess.outputNames));
  const t0 = Date.now();
  const ro = await sess.run(ortFeeds);
  const tOrt = Date.now() - t0;
  const t1 = Date.now();
  const jo = OI.run(model, jsFeeds, dataFiles);
  const tJs = Date.now() - t1;
  const res = { T: T, 耗時ms: { ORT: tOrt, 解釋器: tJs }, 輸出: {} };
  for (const nm of sess.outputNames) {
    const o = ro[nm];
    const j = jo[nm];
    const oa = Float32Array.from(o.data, Number);
    const ja = j ? (j.t === 'f' ? j.v : Float64Array.from(j.v)) : null;
    const same = ja && ja.length === oa.length;
    res.輸出[nm] = { ort維度: o.dims, js維度: j ? j.d : null, 元素數一致: same, 誤差: same ? cmp(ja, oa) : null, ort樣本: Array.from(oa.slice(0, 4)) };
  }
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
