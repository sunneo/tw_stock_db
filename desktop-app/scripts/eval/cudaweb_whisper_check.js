'use strict';
// Whisper 編碼器（q8）：手寫參考（renderer/src/gpu/whisper_enc.js，CPU）對真 ORT（encoder_model_quantized.onnx）。
// 輸入是確定性的合成 log-mel 形狀特徵 [1,80,3000]（沒有真音訊；數值範圍仿 Whisper 正規化後的 log-mel）。輸出 ORT 的 last_hidden_state 與輸入到 <outDir>（給 GPU 驗證頁）。
// 用法：node scripts/eval/cudaweb_whisper_check.js <encoder onnx> <outDir> [--skip-cpu]
const fs = require('fs'), path = require('path'), os = require('os');
const WE = require('../../renderer/src/gpu/whisper_enc.js');
const [modelPath, outDir] = [process.argv[2], process.argv[3]];
if (!modelPath || !outDir) { console.error('用法：... <encoder onnx> <outDir> [--skip-cpu]'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
function synthFeats() { // 80×3000：低頻起伏＋偽隨機，範圍約 [-0.8, 1.6]
  let s = 20260101; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
  const x = new Float32Array(80 * 3000);
  for (let m = 0; m < 80; m++) for (let t = 0; t < 3000; t++) x[m * 3000 + t] = -0.6 + 1.2 * (0.5 + 0.5 * Math.sin(t / 37 + m / 9)) * (0.6 + 0.4 * Math.sin(t / 411)) + 0.5 * (rnd() - 0.5) + (t > 2400 ? -0.2 : 0);
  return x;
}
const cmp = (a, b) => { let d = 0, r = 0, sd = 0; for (let i = 0; i < a.length; i++) { const e = Math.abs(a[i] - b[i]); d = Math.max(d, e); sd += e; r = Math.max(r, Math.abs(b[i])); } return { 最大相對誤差: d / r, 最大絕對誤差: d, 平均絕對誤差: sd / a.length, 參考最大值: r }; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const buf = fs.readFileSync(modelPath), feats = synthFeats();
  const sess = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
  let t0 = Date.now();
  const o = await sess.run({ input_features: new ort.Tensor('float32', feats, [1, 80, 3000]) });
  const ortOut = Float32Array.from(o.last_hidden_state.data);
  const res = { 形狀: o.last_hidden_state.dims, ort毫秒: Date.now() - t0 };
  fs.writeFileSync(path.join(outDir, 'feats.f32'), Buffer.from(feats.buffer));
  fs.writeFileSync(path.join(outDir, 'ort_out.f32'), Buffer.from(ortOut.buffer));
  if (!process.argv.includes('--skip-cpu')) {
    const W = WE.loadEncoder(buf); t0 = Date.now();
    const js = await WE.encode(W, feats, null, (l) => process.stderr.write(l + ' '));
    res.cpu毫秒 = Date.now() - t0; res.cpu對ort = cmp(js, ortOut);
    res.pass = res.cpu對ort.最大相對誤差 < 5e-3;
    fs.writeFileSync(path.join(outDir, 'cpu_out.f32'), Buffer.from(js.buffer));
    process.exitCode = res.pass ? 0 : 1;
  }
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
