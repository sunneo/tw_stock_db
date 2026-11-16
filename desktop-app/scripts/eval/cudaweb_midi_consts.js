'use strict';
// midigenai 解碼器圖中的常數張量（Constant 節點的 value、以及 initializer）的讀值探查（只讀）。
// onnx_lite 不匯出 TensorProto 解析，所以這裡用一個小型 protobuf 讀取器直接掃描。
// 用法：node scripts/eval/cudaweb_midi_consts.js <onnx 路徑> [輸出 json]
const fs = require('fs');
const p = process.argv[2];
if (!p) { console.error('用法：node scripts/eval/cudaweb_midi_consts.js <onnx 路徑>'); process.exit(2); }
const buf = fs.readFileSync(p);

function varint(b, o) { let v = 0, s = 1, c; do { c = b[o++]; v += (c & 127) * s; s *= 128; } while (c & 128); return [v, o]; }
// 逐欄位掃描一段 protobuf：回傳 [{f, wt, v}]；wt=2 時 v 是 [start, end]
function fields(b, s, e) {
  const out = []; let o = s;
  while (o < e) {
    let key; [key, o] = varint(b, o);
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { let v; [v, o] = varint(b, o); out.push({ f, wt, v }); }
    else if (wt === 2) { let len; [len, o] = varint(b, o); out.push({ f, wt, v: [o, o + len] }); o += len; }
    else if (wt === 5) { out.push({ f, wt, v: [o, o + 4] }); o += 4; }
    else if (wt === 1) { out.push({ f, wt, v: [o, o + 8] }); o += 8; }
    else throw new Error('wire type ' + wt);
  }
  return out;
}
const str = (r) => buf.toString('utf8', r[0], r[1]);
// TensorProto：dims(1)、data_type(2)、float_data(4，packed)、int64_data(7)、name(8)、raw_data(9)
function tensor(r) {
  const t = { dims: [], dtype: 0, name: '', raw: null, floats: null, ints: null };
  for (const x of fields(buf, r[0], r[1])) {
    if (x.f === 1) { if (x.wt === 0) t.dims.push(x.v); else { let q = x.v[0]; while (q < x.v[1]) { let d; [d, q] = varint(buf, q); t.dims.push(d); } } }
    else if (x.f === 2) t.dtype = x.v;
    else if (x.f === 8) t.name = str(x.v);
    else if (x.f === 9) t.raw = x.v;
    else if (x.f === 4) { if (x.wt === 2) t.floats = [x.v[0], x.v[1]]; }
    else if (x.f === 7) { if (x.wt === 2) t.ints = [x.v[0], x.v[1]]; }
  }
  return t;
}
function values(t) {
  if (t.dtype === 1 && t.raw) { const n = (t.raw[1] - t.raw[0]) / 4, o = []; for (let i = 0; i < n; i++) o.push(buf.readFloatLE(t.raw[0] + 4 * i)); return { type: 'f32', v: o }; }
  if (t.dtype === 1 && t.floats) { const n = (t.floats[1] - t.floats[0]) / 4, o = []; for (let i = 0; i < n; i++) o.push(buf.readFloatLE(t.floats[0] + 4 * i)); return { type: 'f32', v: o }; }
  if (t.dtype === 7 && t.raw) { const n = (t.raw[1] - t.raw[0]) / 8, o = []; for (let i = 0; i < n; i++) o.push(Number(buf.readBigInt64LE(t.raw[0] + 8 * i))); return { type: 'i64', v: o }; }
  if (t.dtype === 7 && t.ints) { let q = t.ints[0], o = []; while (q < t.ints[1]) { let d; [d, q] = varint(buf, q); o.push(d); } return { type: 'i64', v: o }; }
  return { type: 'dtype' + t.dtype, v: null };
}
const top = fields(buf, 0, buf.length);
const graph = top.find((x) => x.f === 7).v;
const g = fields(buf, graph[0], graph[1]);
const consts = {}, inits = {};
for (const x of g) {
  if (x.f === 1) { // NodeProto
    const nf = fields(buf, x.v[0], x.v[1]);
    const op = nf.find((y) => y.f === 4), outs = nf.filter((y) => y.f === 2).map((y) => str(y.v));
    if (!op || str(op.v) !== 'Constant') continue;
    for (const a of nf.filter((y) => y.f === 5)) {
      const af = fields(buf, a.v[0], a.v[1]);
      const nm = str(af.find((y) => y.f === 1).v), tf = af.find((y) => y.f === 5);
      if (nm === 'value' && tf) consts[outs[0]] = values(tensor(tf.v));
    }
  } else if (x.f === 5) { // initializer
    const t = tensor(x.v);
    inits[t.name] = { dims: t.dims, dtype: t.dtype };
    if (['inv_freq'].includes(t.name) || t.dims.reduce((a, b) => a * b, 1) <= 4) inits[t.name].values = values(t);
  }
}
const want = (process.argv[3] ? process.argv.slice(3) : null);
const keys = Object.keys(consts).filter((k) => consts[k].v && consts[k].v.length <= 8);
const small = {};
for (const k of keys) small[k] = consts[k];
const out = { constNodesWithSmallValues: small, initsSmall: Object.fromEntries(Object.entries(inits).filter(([k, v]) => v.values || /inv_freq|norm|blocks.0/.test(k)).map(([k, v]) => [k, { dims: v.dims, dtype: v.dtype, values: v.values ? v.values.v.slice(0, 8) : null }])) };
const pick = ['/attn_norm/Constant_1_output_0', '/attn_norm/Constant_2_output_0', '/attn_norm/Constant_output_0', '/Constant_150_output_0', '/Constant_203_output_0', '/Constant_13_output_0', '/Constant_4_output_0', '/Constant_5_output_0', '/Constant_12_output_0', '/Constant_9_output_0'];
console.log('挑選的常數：');
for (const k of pick) console.log(k, JSON.stringify(consts[k] ? { type: consts[k].type, v: consts[k].v && consts[k].v.slice(0, 4) } : null));
console.log('inv_freq：', JSON.stringify(inits.inv_freq ? { dims: inits.inv_freq.dims, dtype: inits.inv_freq.dtype, first: inits.inv_freq.values ? inits.inv_freq.values.v.slice(0, 4) : null, count: inits.inv_freq.values ? inits.inv_freq.values.v.length : null } : null));
console.log('小常數節點數：', keys.length);
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
