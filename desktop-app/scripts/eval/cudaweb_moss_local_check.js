'use strict';
// MOSS-TTS-Nano 本地解碼器（非快取）：手寫 CPU 參考版（renderer/src/gpu/moss_local.js）對真 ORT（CPU EP）比對。
// 兩組輸入（不同的全域隱藏狀態、文字詞元、15 條音訊前綴，含 pad），比對 text_logits 與 audio_logits 的相對誤差與 argmax。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_moss_local_check.js <MOSS 資料夾>
const fs = require('fs'), path = require('path');
const ML = require('../../renderer/src/gpu/moss_local.js');
const dir = process.argv[2];
if (!dir) { console.error('用法：... cudaweb_moss_local_check.js <MOSS 資料夾>'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

function cmp(a, b) { let d = 0, r = 0; for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); r = Math.max(r, Math.abs(b[i])); } return { rel: d / (r || 1) }; }
const argmax = (a) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };

(async () => {
  const onnxPath = path.join(dir, 'moss_tts_local_decoder.onnx');
  const dataBuf = fs.readFileSync(path.join(dir, 'moss_tts_local_shared.data'));
  const dataFiles = { 'moss_tts_local_shared.data': new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.length) };
  const model = ML.loadMossLocal(fs.readFileSync(onnxPath), dataFiles);
  const sess = await ort.InferenceSession.create(onnxPath, { executionProviders: ['cpu'] });
  const res = { 步驟: [] };
  const refs = [];
  for (let s = 0; s < 2; s++) {
    const gh = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.013 + s) * 0.7);
    const textId = (s * 911 + 17) % 16000;
    const audio = Array.from({ length: 15 }, (_, c) => (c === s + 3 ? ML.PAD : (s * 97 + c * 31 + 5) % 1024));
    const o = await sess.run({
      global_hidden: new ort.Tensor('float32', gh, [1, 768]),
      text_token_id: new ort.Tensor('int32', Int32Array.from([textId]), [1]),
      audio_prefix_token_ids: new ort.Tensor('int32', Int32Array.from(audio), [1, 15]),
    });
    const ortText = Float32Array.from(o.text_logits.data), ortAudio = Float32Array.from(o.audio_logits.data);
    const js = await ML.localDecode(model, gh, textId, audio);
    refs.push({ gh: Array.from(gh), textId, audio, ortText: Array.from(ortText), ortAudio: Array.from(ortAudio), audioDims: o.audio_logits.dims });
    const rt = cmp(js.textLogits, ortText);
    const audioDims = o.audio_logits.dims;
    const A = audioDims[audioDims.length - 1], C = ortAudio.length / A;
    let worstA = 0; let agree = 0;
    for (let c = 0; c < C; c++) {
      const oa = ortAudio.subarray(c * A, (c + 1) * A);
      const ja = js.audioLogits[c];
      worstA = Math.max(worstA, cmp(ja, oa).rel);
      if (argmax(ja) === argmax(oa)) agree++;
    }
    res.步驟.push({ 步: s, 文字logits相對誤差: rt.rel, 文字argmax一致: argmax(js.textLogits) === argmax(ortText), 音訊logits最差相對誤差: worstA, 音訊argmax一致數: agree + '/' + C, ort文字維度: o.text_logits.dims, ort音訊維度: audioDims });
  }
  res.pass = res.步驟.every((x) => x.文字logits相對誤差 < 1e-3 && x.音訊logits最差相對誤差 < 1e-3 && x.文字argmax一致);
  console.log(JSON.stringify(res, null, 1));
  // 可選第二參數：把兩組輸入與 ORT 參考 logits 寫成 JSON（給瀏覽器 GPU 驗證頁當比對目標）
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({ refs }));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
