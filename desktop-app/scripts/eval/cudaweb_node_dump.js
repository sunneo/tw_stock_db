'use strict';
// 逐節點對真 ORT 對拍（共用）：挑出圖中指定算子的節點，把每個節點「ORT 實際看到的輸入與算出的輸出」加成 ORT 額外輸出取回，
// 以 renderer/src/gpu/node_eval.js（conv_ops／mm_ops，CPU 參考）重算並與 ORT 輸出比對；同時把案例寫到 <outDir>（cases.json＋*.bin），
// 給 GPU 驗證頁 cudaweb_node_gpu_check.js 用。（做法同 cudaweb_bp_conv_dump.js，推廣到 ConvTranspose、MatMul、MatMulInteger 與整數張量。）
// 用法：node scripts/eval/cudaweb_node_dump.js <model.onnx> <outDir> <preset> <ops 逗號分隔> [每批節點數=40] [張量元素上限=8000000] [只取每種形狀前 K 個=0（不限）]
// preset：demucs | yamnet | kokoro | sdxs-te | sdxs-unet | sdxs-vae | whisper 等（見 PRESETS）。輸入全是確定性合成資料，不是真音樂／真文字。
const fs = require('fs'), path = require('path'), os = require('os');
const lite = require('../../renderer/src/gpu/onnx_lite.js'), NE = require('../../renderer/src/gpu/node_eval.js');
const [modelPath, outDir, preset, opsCsv] = process.argv.slice(2, 6);
const BATCH = Number(process.argv[6]) || 40, MAXEL = Number(process.argv[7]) || 8000000, PERSHAPE = Number(process.argv[8]) || 0;
if (!modelPath || !outDir || !preset || !opsCsv) { console.error('用法：... <model.onnx> <outDir> <preset> <ops> [批次] [元素上限] [每形狀上限]'); process.exit(2); }
const ort = require(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
function readVar(b, p) { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return [v, p]; }
function addOutputs(buf, names) { // 在 graph 尾端加只有名稱的 value_info 當輸出（型別由 ORT 推得）
  const parts = []; let p = 0, graph = null;
  while (p < buf.length) { const s = p; let tag; [tag, p] = readVar(buf, p); const wt = tag & 7, fld = tag >> 3; let e;
    if (wt === 0) { [, e] = readVar(buf, p); } else if (wt === 2) { let l; [l, p] = readVar(buf, p); e = p + l; } else if (wt === 1) e = p + 8; else e = p + 4;
    if (fld === 7) graph = { s, hs: p, e }; else parts.push(buf.subarray(s, e)); p = e; }
  const body = [buf.subarray(graph.hs, graph.e)];
  for (const n of names) { const nm = Buffer.from(n), vi = Buffer.concat([Buffer.from([10]), varint(nm.length), nm]); body.push(Buffer.concat([Buffer.from([98]), varint(vi.length), vi])); }
  const gb = Buffer.concat(body);
  return Buffer.concat(parts.concat([Buffer.concat([Buffer.from([58]), varint(gb.length), gb])]));
}
const lcg = (seed) => { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; }; };
const PRESETS = {
  demucs: () => { const n = 343980, a = new Float32Array(2 * n), r = lcg(7); for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) a[c * n + i] = 0.3 * Math.sin(2 * Math.PI * (110 + 40 * c) * i / 44100) + 0.2 * Math.sin(2 * Math.PI * 880 * i / 44100 * (1 + 0.1 * Math.sin(i / 20000))) + 0.05 * (r() - 0.5) + (i % 22050 < 400 ? 0.4 * (r() - 0.5) : 0); return { mix: new ort.Tensor('float32', a, [1, 2, n]) }; },
  yamnet: () => { const n = 16000 * 6, a = new Float32Array(n), r = lcg(3); for (let i = 0; i < n; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * (300 + 200 * Math.sin(i / 8000)) * i / 16000) + 0.1 * (r() - 0.5); return { waveform: new ort.Tensor('float32', a, [n]) }; },
  kokoro: () => { const ids = [0, 50, 83, 54, 156, 57, 135, 63, 16, 156, 70, 156, 85, 123, 16, 0]; const st = new Float32Array(256), r = lcg(5); for (let i = 0; i < 256; i++) st[i] = (r() - 0.5) * 0.4;
    if (process.env.KOKORO_VOICE) { const v = fs.readFileSync(process.env.KOKORO_VOICE); const f = new Float32Array(v.buffer, v.byteOffset, v.length / 4); const row = Math.min(ids.length, 509) - 2; st.set(f.subarray(row * 256, row * 256 + 256)); }
    return { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]), style: new ort.Tensor('float32', st, [1, 256]), speed: new ort.Tensor('float32', Float32Array.from([1]), [1]) }; },
  'sdxs-vae': () => { const a = new Float32Array(4 * 64 * 64), r = lcg(11); for (let i = 0; i < a.length; i++) a[i] = (r() + r() + r() - 1.5) * 1.2; return { latent_sample: new ort.Tensor('float32', a, [1, 4, 64, 64]) }; },
  'sdxs-unet': () => { const r = lcg(13), g = (n, s) => Float32Array.from({ length: n }, () => (r() + r() + r() - 1.5) * s); return { sample: new ort.Tensor('float32', g(4 * 64 * 64, 1), [1, 4, 64, 64]), timestep: new ort.Tensor('float32', Float32Array.from([500]), [1]), encoder_hidden_states: new ort.Tensor('float32', g(77 * 768, 0.5), [1, 77, 768]) }; },
  'sdxs-te': () => { const ids = new Int32Array(77).fill(49407); [49406, 320, 1125, 539, 320, 2368, 49407].forEach((v, i) => { ids[i] = v; }); return { input_ids: new ort.Tensor('int32', ids, [1, 77]) }; },
};
const TY = { float32: [1, Float32Array], uint8: [2, Uint8Array], int8: [3, Int8Array], int32: [6, Int32Array] };
const f16 = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024); };
function initTensor(m, name) {
  const t = m.inits[name]; if (!t) return null;
  let bytes; try { bytes = lite.tensorBytes(m, name); } catch (e) { return null; } if (!bytes) return null;
  const ab = new ArrayBuffer(bytes.length); new Uint8Array(ab).set(bytes);
  const dt = { 1: Float32Array, 2: Uint8Array, 3: Int8Array, 6: Int32Array }[t.dtype];
  if (dt) return { data: new dt(ab), dims: t.dims.slice() };
  if (t.dtype === 10) { const u = new Uint16Array(ab), o = new Float32Array(u.length); for (let i = 0; i < u.length; i++) o[i] = f16(u[i]); return { data: o, dims: t.dims.slice() }; }
  return null;
}
const attrsOf = (n) => { const a = {}; for (const k in n.attrs) { const v = n.attrs[k]; if (v.ints && v.ints.length) a[k] = v.ints.map(Number); else if (v.i !== undefined && v.i !== null) a[k] = Number(v.i); } return a; };
function cmp(op, y, ref) {
  if (op === 'MatMulInteger' || op === 'ConvInteger') { let bad = 0; for (let i = 0; i < ref.length; i++) if (y[i] !== ref[i]) bad++; return { exact: bad === 0, rel: bad }; }
  let d = 0, mx = 0; for (let i = 0; i < ref.length; i++) { d = Math.max(d, Math.abs(y[i] - ref[i])); mx = Math.max(mx, Math.abs(ref[i])); }
  return { rel: d / (mx || 1) };
}
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const buf = fs.readFileSync(modelPath), m = lite.parseModel(buf), want = new Set(opsCsv.split(','));
  let nodes = m.nodes.filter((n) => want.has(n.op));
  const feeds = PRESETS[preset]();
  const cases = [], skipped = [], files = new Map(); let worst = 0, nbad = 0; const shapeCount = {};
  const save = (key, arr) => { if (!files.has(key)) { const fn = 't' + files.size + '.bin'; fs.writeFileSync(path.join(outDir, fn), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); files.set(key, fn); } return files.get(key); };
  for (let bi = 0; bi < nodes.length; bi += BATCH) {
    const batch = nodes.slice(bi, bi + BATCH), extra = new Set(), initIns = new Map();
    for (const n of batch) { extra.add(n.outputs[0]); for (const nm of n.inputs) { if (!nm) continue; const t = initTensor(m, nm); if (t) initIns.set(nm, t); else extra.add(nm); } }
    const sess = await ort.InferenceSession.create(addOutputs(buf, Array.from(extra)), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
    const o = await sess.run(feeds);
    for (const n of batch) {
      const get = (nm) => { if (!nm) return null; if (initIns.has(nm)) return { t: initIns.get(nm), key: 'i:' + nm }; const t = o[nm]; return t ? { t: { data: t.data, dims: t.dims.slice(), type: t.type }, key: 'o:' + nm } : undefined; };
      const ins = n.inputs.map(get), yo = get(n.outputs[0]);
      if (ins.some((v) => v === undefined) || !yo) { skipped.push({ name: n.outputs[0], reason: '取不到張量' }); continue; }
      const big = Math.max(yo.t.data.length, ...ins.filter(Boolean).map((v) => v.t.data.length));
      if (big > MAXEL) { skipped.push({ name: n.outputs[0], op: n.op, 元素: big, reason: '張量超過上限' }); continue; }
      const sk = n.op + ':' + ins.slice(0, 2).map((v) => v.t.dims.join('x')).join('|') + JSON.stringify(attrsOf(n));
      shapeCount[sk] = (shapeCount[sk] || 0) + 1; if (PERSHAPE && shapeCount[sk] > PERSHAPE) { skipped.push({ name: n.outputs[0], op: n.op, reason: '同形狀已取 ' + PERSHAPE + ' 個' }); continue; }
      const a = attrsOf(n), tin = ins.map((v) => (v ? { data: v.t.data, dims: v.t.dims } : null));
      let ref; try { ref = await NE.evalNode(n.op, a, tin, { gpu: false }); } catch (e) { skipped.push({ name: n.outputs[0], op: n.op, reason: '參考未支援：' + e.message }); continue; }
      const dimsOk = ref.dims.join() === yo.t.dims.join();
      const c = cmp(n.op, ref.y, yo.t.data); worst = Math.max(worst, (n.op === 'MatMulInteger' || n.op === 'ConvInteger') ? 0 : c.rel); if (!dimsOk || ((n.op === 'MatMulInteger' || n.op === 'ConvInteger') ? !c.exact : c.rel > 1e-3)) nbad++;
      const typ = (t) => (t.type || (t.data instanceof Float32Array ? 'float32' : t.data instanceof Uint8Array ? 'uint8' : t.data instanceof Int8Array ? 'int8' : 'int32'));
      cases.push({ op: n.op, name: n.outputs[0], attrs: a, ins: ins.map((v) => (v ? { f: save(v.key, v.t.data), type: typ(v.t), dims: v.t.dims } : null)), out: { f: save(yo.key, yo.t.data), type: typ(yo.t), dims: yo.t.dims }, cpuRel: c.rel, dimsOk });
    }
    console.error('批次 ' + (bi / BATCH + 1) + '/' + Math.ceil(nodes.length / BATCH) + '：累計 ' + cases.length + ' 個案例，最差相對 ' + worst.toExponential(2));
  }
  fs.writeFileSync(path.join(outDir, 'cases.json'), JSON.stringify(cases));
  const byOp = {}; for (const c of cases) byOp[c.op] = (byOp[c.op] || 0) + 1;
  const res = { 節點總數: nodes.length, 案例數: cases.length, 各算子: byOp, 略過: skipped.length, 略過摘要: skipped.slice(0, 12), CPU參考對ORT最差相對誤差: worst, 不符數: nbad, pass: nbad === 0 && cases.length > 0 };
  fs.writeFileSync(path.join(outDir, 'dump.result.json'), JSON.stringify(Object.assign({}, res, { 略過全部: skipped })));
  console.log(JSON.stringify(res));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
