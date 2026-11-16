'use strict';
// 整圖對 ORT 不符時找第一個分歧的節點：把每個節點的輸出都加成 ORT 額外輸出（做法同 cudaweb_node_dump.js 的 addOutputs），
// graph_session 的解釋器逐節點執行，每個節點算完就跟 ORT 的同名張量比相對 L2，印出第一批超過門檻的節點（含其輸入名，方便看是哪個算子的語意不同）。
// 用法：node scripts/eval/cudaweb_graph_bisect.js <kind> <model.onnx> [門檻=1e-3] [最多列幾個=8]
const fs = require('fs'), os = require('os'), path = require('path');
const base = process.env.FA_BASE || path.join(os.homedir(), '.config', 'floating-assistant-desktop');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const lite = require('../../renderer/src/gpu/onnx_lite.js'), I = require('../../renderer/src/gpu/onnx_interp.js'), GS = require('../../renderer/src/gpu/graph_session.js');
const { CASES } = require('./cudaweb_graph_cases.js');
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
function readVar(b, p) { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128; } while (c & 128); return [v, p]; }
function addOutputs(buf, names) {
  const parts = []; let p = 0, graph = null;
  while (p < buf.length) { const s = p; let tag; [tag, p] = readVar(buf, p); const wt = tag & 7, fld = tag >> 3; let e;
    if (wt === 0) { [, e] = readVar(buf, p); } else if (wt === 2) { let l; [l, p] = readVar(buf, p); e = p + l; } else if (wt === 1) e = p + 8; else e = p + 4;
    if (fld === 7) graph = { s, hs: p, e }; else parts.push(buf.subarray(s, e)); p = e; }
  const body = [buf.subarray(graph.hs, graph.e)];
  for (const n of names) { const nm = Buffer.from(n), vi = Buffer.concat([Buffer.from([10]), varint(nm.length), nm]); body.push(Buffer.concat([Buffer.from([98]), varint(vi.length), vi])); }
  const gb = Buffer.concat(body);
  return Buffer.concat(parts.concat([Buffer.concat([Buffer.from([58]), varint(gb.length), gb])]));
}
(async () => {
  const [kind, file] = process.argv.slice(2), TH = Number(process.argv[4]) || 1e-3, MAXN = Number(process.argv[5]) || 8;
  const buf = fs.readFileSync(file), m = lite.parseModel(new Uint8Array(buf));
  const names = []; for (const n of m.nodes) for (const o of n.outputs) if (o) names.push(o);
  const modBuf = addOutputs(buf, names.filter((n) => !m.outputs.includes(n)));
  const sess = await ort.InferenceSession.create(new Uint8Array(modBuf), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const feeds = await CASES[kind].feeds(ort, file), ref = await sess.run(feeds);
  const f = {}; for (const k of Object.keys(feeds)) f[k] = GS.toInternal(feeds[k]);
  const bad = []; let seen = 0;
  await I.run(m, f, {}, { gpu: { ops: { gpu: false }, tiers: {} }, capture: (node, outs) => {
    for (let i = 0; i < node.outputs.length; i++) { const nm = node.outputs[i], r = ref[nm], o = outs[i]; if (!nm || !r || !o || !o.v || r.type === 'string') continue; seen++;
      const a = o.v, b = r.data; if (a.length !== b.length) { bad.push({ node: node.name, op: node.op, out: nm, why: '長度 ' + a.length + ' vs ' + b.length }); continue; }
      let d = 0, n = 0; for (let j = 0; j < b.length; j++) { const x = Number(a[j]), y = Number(b[j]); d += (x - y) ** 2; n += y * y; } const rel = n > 0 ? Math.sqrt(d / n) : Math.sqrt(d);
      if (rel > TH && bad.length < MAXN) bad.push({ node: node.name, op: node.op, out: nm, ins: node.inputs, rel: +rel.toExponential(2), dims: o.d }); } } });
  console.log(JSON.stringify({ 比對張量數: seen, 前幾個分歧: bad }, null, 1)); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
