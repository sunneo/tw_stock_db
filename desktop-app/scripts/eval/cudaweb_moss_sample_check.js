'use strict';
// MOSS-TTS-Nano 整幀取樣（moss_tts_local_fixed_sampled_frame.onnx）：手寫 CPU 參考版（renderer/src/gpu/moss_sampling.js）對真 ORT（CPU EP）比對。
// 多組輸入（不同的全域隱藏狀態、遮罩、隨機數），比對 should_continue 與 frame_token_ids 是否完全一致。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_moss_sample_check.js <MOSS 資料夾>
const fs = require('fs'), path = require('path');
const ML = require('../../renderer/src/gpu/moss_local.js');
const MS = require('../../renderer/src/gpu/moss_sampling.js');
const dir = process.argv[2];
if (!dir) { console.error('用法：... cudaweb_moss_sample_check.js <MOSS 資料夾>'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

(async () => {
  const onnxPath = path.join(dir, 'moss_tts_local_fixed_sampled_frame.onnx');
  const dataBuf = fs.readFileSync(path.join(dir, 'moss_tts_local_shared.data'));
  const dataFiles = { 'moss_tts_local_shared.data': new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length) };
  const model = ML.loadMossLocal(fs.readFileSync(path.join(dir, 'moss_tts_local_decoder.onnx')), dataFiles);
  const sess = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  const cases = [];
  const N = 3;
  for (let s = 0; s < N; s++) {
    const gh = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.011 + s * 1.7) * 0.8);
    const mask = new Int32Array(16 * 1024);
    for (let c = 0; c < 16; c++) for (let v = 0; v < 1024; v++) mask[c * 1024 + v] = ((v * 7 + c * 13 + s * 5) % 9 === 0) ? 1 : 0;
    const uA = [0.13, 0.62, 0.97][s];
    const uAud = Float32Array.from({ length: 16 }, (_, c) => ((c * 0.0613 + s * 0.31) % 1));
    const o = await sess.run({
      global_hidden: new ort.Tensor('float32', gh, [1, 768]),
      repetition_seen_mask: new ort.Tensor('int32', mask, [1, 16, 1024]),
      assistant_random_u: new ort.Tensor('float32', Float32Array.from([uA]), [1]),
      audio_random_u: new ort.Tensor('float32', uAud, [1, 16]),
    });
    const ortCont = Number(o.should_continue.data[0]);
    const ortFrame = Array.from(o.frame_token_ids.data, Number);
    const js = await MS.sampleFrame(model, gh, mask, uA, uAud);
    const jsFrame = Array.from(js.frameTokenIds);
    const frameMatch = jsFrame.length === ortFrame.length && jsFrame.every((v, i) => v === ortFrame[i]);
    cases.push({ 組: s, ort_should_continue: ortCont, js_should_continue: js.shouldContinue, 續停一致: ortCont === js.shouldContinue, 幀詞元一致: frameMatch, ort幀: ortFrame, js幀: jsFrame, ort幀維度: o.frame_token_ids.dims, ort續停維度: o.should_continue.dims });
  }
  const pass = cases.every((x) => x.續停一致 && x.幀詞元一致);
  console.log(JSON.stringify({ 案例: cases, pass }, null, 1));
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
