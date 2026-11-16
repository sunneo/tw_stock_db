'use strict';
// Basic Pitch（nmp.onnx）所有 Conv 節點的真 ORT 對拍案例：把每個 Conv 的輸入與輸出加成 ORT 的額外輸出，
// 輸入用確定性合成音訊 [1,43844,1]（440＋660 Hz 與雜訊，22050 Hz）。每個 Conv 以 ORT 實際看到的輸入，用 conv_ops.conv2dRef（CPU）重算並比對 ORT 的輸出；
// 同時把案例寫到 <outDir>（cases.json＋各張量 .f32），給 GPU 驗證頁（cudaweb_bp_conv_gpu_check.js）用。
// 用法：node scripts/eval/cudaweb_bp_conv_dump.js <nmp.onnx> <outDir>
const fs = require('fs'), path = require('path'), os = require('os');
const lite = require('../../renderer/src/gpu/onnx_lite.js'), CONV = require('../../renderer/src/gpu/conv_ops.js');
const [modelPath, outDir] = [process.argv[2], process.argv[3]];
if (!modelPath || !outDir) { console.error('用法：... <nmp.onnx> <outDir>'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
function readVar(b, p) { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return [v, p]; }
function addOutputs(buf, names) { // 見 cudaweb_whisper_trace.js
  const parts = []; let p = 0, graph = null;
  while (p < buf.length) { const s = p; let tag; [tag, p] = readVar(buf, p); const wt = tag & 7, fld = tag >> 3; let e;
    if (wt === 0) { [, e] = readVar(buf, p); } else if (wt === 2) { let l; [l, p] = readVar(buf, p); e = p + l; } else if (wt === 1) e = p + 8; else e = p + 4;
    if (fld === 7) graph = { s, hs: p, e }; else parts.push(buf.subarray(s, e)); p = e; }
  const body = [buf.subarray(graph.hs, graph.e)];
  for (const n of names) { const nm = Buffer.from(n), tt = Buffer.from([8, 1]), tp = Buffer.concat([Buffer.from([10]), varint(tt.length), tt]), vi = Buffer.concat([Buffer.from([10]), varint(nm.length), nm, Buffer.from([18]), varint(tp.length), tp]); body.push(Buffer.concat([Buffer.from([98]), varint(vi.length), vi])); }
  const gb = Buffer.concat(body);
  return Buffer.concat(parts.concat([Buffer.concat([Buffer.from([58]), varint(gb.length), gb])]));
}
const f32 = (b) => { const o = new Float32Array(b.length / 4); new Uint8Array(o.buffer).set(b); return o; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const buf = fs.readFileSync(modelPath), m = lite.parseModel(buf);
  const convs = m.nodes.filter((n) => n.op === 'Conv');
  const names = Array.from(new Set(convs.flatMap((n) => [n.inputs[0], n.outputs[0]])));
  const sess = await ort.InferenceSession.create(addOutputs(buf, names), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const audio = new Float32Array(43844); let s = 99; for (let i = 0; i < audio.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; audio[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / 22050) + 0.2 * Math.sin(2 * Math.PI * 660 * i / 22050) + 0.05 * ((s >>> 0) / 4294967296 - 0.5); }
  const o = await sess.run({ [m.inputs[0]]: new ort.Tensor('float32', audio, [1, 43844, 1]) });
  const cases = [], saved = new Set(), save = (key, arr) => { const fn = 't' + saved.size + '.f32'; const id = key; if (!saved.has(id)) { saved.add(id); fs.writeFileSync(path.join(outDir, fn), Buffer.from(new Float32Array(arr).buffer)); saved.map = saved.map || {}; saved.map[id] = fn; } return saved.map[id]; };
  let worst = 0;
  for (const n of convs) {
    const xt = o[n.inputs[0]], yt = o[n.outputs[0]], wi = m.inits[n.inputs[1]], w = f32(lite.tensorBytes(m, n.inputs[1])), b = n.inputs[2] ? f32(lite.tensorBytes(m, n.inputs[2])) : null;
    const a = n.attrs, [N, C, H, W] = xt.dims, [M, Cg, KH, KW] = wi.dims;
    const pr = { strides: a.strides ? a.strides.ints : [1, 1], dilations: a.dilations ? a.dilations.ints : [1, 1], pads: a.pads && a.pads.ints.length ? a.pads.ints : [0, 0, 0, 0], groups: a.group && a.group.i ? a.group.i : 1 };
    const ref = CONV.conv2dRef(xt.data, N, C, H, W, w, M, Cg, KH, KW, b, pr);
    let d = 0, mx = 0; for (let i = 0; i < ref.length; i++) { d = Math.max(d, Math.abs(ref[i] - yt.data[i])); mx = Math.max(mx, Math.abs(yt.data[i])); }
    const rel = d / (mx || 1); worst = Math.max(worst, rel);
    cases.push({ name: n.outputs[0], dims: { N, C, H, W, M, Cg, KH, KW }, p: pr, x: save('x:' + n.inputs[0], xt.data), w: save('w:' + n.inputs[1], w), b: b ? save('b:' + n.inputs[2], b) : null, y: save('y:' + n.outputs[0], yt.data), cpuRel: rel, outDims: yt.dims });
  }
  fs.writeFileSync(path.join(outDir, 'cases.json'), JSON.stringify(cases));
  const res = { 卷積數: cases.length, CPU參考對ORT最差相對誤差: worst, 各案例: cases.map((c) => ({ dims: Object.values(c.dims).join('x'), 步幅: c.p.strides.join(','), pads: c.p.pads.join(','), rel: +c.cpuRel.toExponential(2) })), pass: worst < 1e-4 };
  console.log(JSON.stringify(res));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
