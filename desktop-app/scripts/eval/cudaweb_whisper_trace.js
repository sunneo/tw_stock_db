'use strict';
// Whisper 編碼器逐階段對拍：把 ORT 圖的中間張量（conv1、conv2、pos、layer0…5 輸出）加成額外輸出，與 whisper_enc.js 參考逐階段比較相對誤差，找出誤差從哪一階段出現。
// 用法：node scripts/eval/cudaweb_whisper_trace.js <encoder onnx> <特徵 feats.f32 所在資料夾>
const fs = require('fs'), path = require('path'), os = require('os');
const WE = require('../../renderer/src/gpu/whisper_enc.js');
const [modelPath, dir] = [process.argv[2], process.argv[3]];
const ort = require(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
function readVar(b, p) { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return [v, p]; }
// 在 ModelProto 的 graph（field 7）尾端加 value_info 形式的輸出（field 12，float 張量，無形狀）
function addOutputs(buf, names) {
  const parts = []; let p = 0, graph = null;
  while (p < buf.length) { const s = p; let tag; [tag, p] = readVar(buf, p); const wt = tag & 7, fld = tag >> 3; let e;
    if (wt === 0) { [, e] = readVar(buf, p); } else if (wt === 2) { let l; [l, p] = readVar(buf, p); e = p + l; } else if (wt === 1) e = p + 8; else e = p + 4;
    if (fld === 7) graph = { s, hs: p, e }; else parts.push(buf.subarray(s, e)); p = e; }
  const body = [buf.subarray(graph.hs, graph.e)];
  for (const n of names) { const nm = Buffer.from(n), tt = Buffer.concat([Buffer.from([8, 1])]), tp = Buffer.concat([Buffer.from([10]), varint(tt.length), tt]), vi = Buffer.concat([Buffer.from([10]), varint(nm.length), nm, Buffer.from([18]), varint(tp.length), tp]); body.push(Buffer.concat([Buffer.from([98]), varint(vi.length), vi])); }
  const gb = Buffer.concat(body);
  return Buffer.concat(parts.concat([Buffer.concat([Buffer.from([58]), varint(gb.length), gb])]));
}
const rel = (a, b) => { let d = 0, m = 0, sd = 0, sm = 0; for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); sd += Math.abs(a[i] - b[i]); m = Math.max(m, Math.abs(b[i])); sm += Math.abs(b[i]); } return { 最大相對: +(d / m).toExponential(2), 平均絕對: +(sd / a.length).toExponential(2), 參考平均幅度: +(sm / a.length).toFixed(4) }; };
(async () => {
  const buf = fs.readFileSync(modelPath), fb = fs.readFileSync(path.join(dir, 'feats.f32')), feats = new Float32Array(fb.buffer, fb.byteOffset, fb.length / 4);
  const map = { conv1: '/Mul_1_output_0', conv2: '/Mul_3_output_0', pos: '/Add_2_output_0' }; for (let i = 0; i < 6; i++) map['layer' + i] = '/layers.' + i + '/Add_1_output_0';
  const sess = await ort.InferenceSession.create(addOutputs(buf, Object.values(map)), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const o = await sess.run({ input_features: new ort.Tensor('float32', feats, [1, 80, 3000]) });
  const W = WE.loadEncoder(buf), res = { 自由跑對ORT: {}, 逐層教師強迫: {} };
  for (const l of Object.keys(map)) fs.writeFileSync(path.join(dir, 'ort_' + l + '.f32'), Buffer.from(Float32Array.from(o[map[l]].data).buffer));
  const prev = (i) => Float32Array.from(o[i === 0 ? map.pos : map['layer' + (i - 1)]].data);
  for (let i = 0; i < 6; i++) res.逐層教師強迫['layer' + i] = rel(await WE.runLayer(W, i, prev(i), null), o[map['layer' + i]].data);
  if (!process.argv.includes('--skip-free')) await WE.encode(W, feats, null, (l, t) => { if (t && map[l]) res.自由跑對ORT[l] = rel(t, o[map[l]].data); });
  console.log(JSON.stringify(res, null, 1));
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
