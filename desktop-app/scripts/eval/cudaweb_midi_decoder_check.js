'use strict';
// midigenai 解碼器：手寫 CPU 參考版（renderer/src/gpu/midi_decoder.js）對真 ORT（CPU EP，同一個 q4 模型）比對。
// 步驟：(1) 3 個詞元預填，比對最後一個位置的 logits；(2) 用各自的快取再解碼 1 個詞元，比對 logits。
// 通過條件：兩次的相對誤差都 < 1e-3，且 argmax 一致。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_midi_decoder_check.js <midigen 模型路徑>
const fs = require('fs'), path = require('path');
const MD = require('../../renderer/src/gpu/midi_decoder.js');
const modelPath = process.argv[2];
if (!modelPath) { console.error('用法：... cudaweb_midi_decoder_check.js <midigen 模型路徑>'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));

function cmp(a, b) { let d = 0, r = 0; for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); r = Math.max(r, Math.abs(b[i])); } return { rel: d / (r || 1), maxAbs: d }; }
const argmax = (a) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };

(async () => {
  const buf = fs.readFileSync(modelPath);
  const model = MD.loadMidiDecoder(buf);
  const sess = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
  const ortRun = async (ids, past) => {
    const feeds = { ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, ids.length]) };
    for (let i = 0; i < MD.NL; i++) {
      feeds['past_k' + i] = past ? past[i].k : new ort.Tensor('float32', new Float32Array(0), [1, MD.H, 0, MD.HD]);
      feeds['past_v' + i] = past ? past[i].v : new ort.Tensor('float32', new Float32Array(0), [1, MD.H, 0, MD.HD]);
    }
    const o = await sess.run(feeds);
    const cache = [];
    for (let i = 0; i < MD.NL; i++) cache.push({ k: o['present_k' + i], v: o['present_v' + i] });
    return { logits: Float32Array.from(o.logits.data), cache };
  };
  const pre = [7, 123, 45], step = [300];
  // (1) 預填
  const ortPre = await ortRun(pre, null);
  const jsPre = await MD.decode(model, pre, null);
  const r1 = cmp(jsPre.logits, ortPre.logits);
  // (2) 解碼一步：各自用自己的快取
  const ortStep = await ortRun(step, ortPre.cache);
  const jsStep = await MD.decode(model, step, jsPre.cache);
  const r2 = cmp(jsStep.logits, ortStep.logits);
  const res = {
    模型: modelPath, 詞彙數: jsPre.logits.length,
    預填三詞元_logits: { 相對誤差: r1.rel, argmaxJs: argmax(jsPre.logits), argmaxOrt: argmax(ortPre.logits) },
    解碼一步_logits: { 相對誤差: r2.rel, argmaxJs: argmax(jsStep.logits), argmaxOrt: argmax(ortStep.logits) },
    pass: r1.rel < 1e-3 && r2.rel < 1e-3 && argmax(jsPre.logits) === argmax(ortPre.logits) && argmax(jsStep.logits) === argmax(ortStep.logits),
  };
  console.log(JSON.stringify(res, null, 1));
  // 可選第三參數：把 ORT 參考 logits 寫成 JSON（給瀏覽器 GPU 驗證頁當比對目標）
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({ pre, step, ortPre: Array.from(ortPre.logits), ortStep: Array.from(ortStep.logits) }));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
