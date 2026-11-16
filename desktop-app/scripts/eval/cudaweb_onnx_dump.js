'use strict';
// 通用 ONNX 圖傾印（只讀）：每個節點的 op、輸入、輸出、屬性；Constant 節點直接印出小張量的值。
// 用法：node scripts/eval/cudaweb_onnx_dump.js <onnx 路徑> <輸出 txt>
const fs = require('fs');
const [p, out] = [process.argv[2], process.argv[3]];
if (!p || !out) { console.error('用法：node scripts/eval/cudaweb_onnx_dump.js <onnx> <輸出 txt>'); process.exit(2); }
const buf = fs.readFileSync(p);
function varint(b, o) { let v = 0, s = 1, c; do { c = b[o++]; v += (c & 127) * s; s *= 128; } while (c & 128); return [v, o]; }
function fields(b, s, e) {
  const o = []; let q = s;
  while (q < e) {
    let key; [key, q] = varint(b, q);
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { let v; [v, q] = varint(b, q); o.push({ f, wt, v }); }
    else if (wt === 2) { let len; [len, q] = varint(b, q); o.push({ f, wt, v: [q, q + len] }); q += len; }
    else if (wt === 5) { o.push({ f, wt, v: [q, q + 4] }); q += 4; }
    else if (wt === 1) { o.push({ f, wt, v: [q, q + 8] }); q += 8; }
    else throw new Error('wire ' + wt);
  }
  return o;
}
const str = (r) => buf.toString('utf8', r[0], r[1]);
function tensor(r) {
  const t = { dims: [], dtype: 0, raw: null, floats: null, ints: null };
  for (const x of fields(buf, r[0], r[1])) {
    if (x.f === 1) { if (x.wt === 0) t.dims.push(x.v); else { let q = x.v[0]; while (q < x.v[1]) { let d; [d, q] = varint(buf, q); t.dims.push(d); } } }
    else if (x.f === 2) t.dtype = x.v;
    else if (x.f === 9) t.raw = x.v;
    else if (x.f === 4 && x.wt === 2) t.floats = x.v;
    else if (x.f === 7 && x.wt === 2) t.ints = x.v;
  }
  return t;
}
function vals(t) {
  const n = t.dims.reduce((a, b) => a * b, 1);
  if (n > 64) return '[' + t.dims.join('x') + ']';
  if (t.dtype === 1 && (t.raw || t.floats)) { const r = t.raw || t.floats, o = []; for (let i = 0; i < n; i++) o.push(+buf.readFloatLE(r[0] + 4 * i).toPrecision(7)); return 'f32' + JSON.stringify(o); }
  if (t.dtype === 7 && t.raw) { const o = []; for (let i = 0; i < n; i++) o.push(Number(buf.readBigInt64LE(t.raw[0] + 8 * i))); return 'i64' + JSON.stringify(o); }
  if (t.dtype === 7 && t.ints) { let q = t.ints[0], o = []; while (q < t.ints[1]) { let d; [d, q] = varint(buf, q); o.push(d); } return 'i64' + JSON.stringify(o); }
  return 'dtype' + t.dtype;
}
const g = fields(buf, fields(buf, 0, buf.length).find((x) => x.f === 7).v[0], fields(buf, 0, buf.length).find((x) => x.f === 7).v[1]);
const lines = [];
g.forEach((x, i) => {
  if (x.f !== 1) return;
  const nf = fields(buf, x.v[0], x.v[1]);
  const op = str(nf.find((y) => y.f === 4).v);
  const ins = nf.filter((y) => y.f === 1).map((y) => str(y.v));
  const outs = nf.filter((y) => y.f === 2).map((y) => str(y.v));
  const attrs = [];
  let constVal = '';
  for (const a of nf.filter((y) => y.f === 5)) {
    const af = fields(buf, a.v[0], a.v[1]);
    const name = str(af.find((y) => y.f === 1).v);
    const ti = af.find((y) => y.f === 5);
    if (name === 'value' && ti) constVal = vals(tensor(ti.v));
    else { const iv = af.find((y) => y.f === 3), ivs = af.filter((y) => y.f === 8); if (iv) attrs.push(name + '=' + iv.v); else if (ivs.length) attrs.push(name + '=[' + ivs.map((y) => y.v).join(',') + ']'); else if (af.find((y) => y.f === 4)) attrs.push(name + '=' + str(af.find((y) => y.f === 4).v)); }
  }
  lines.push(i + ' ' + op + ' ' + JSON.stringify(ins) + ' -> ' + JSON.stringify(outs) + (constVal ? ' VALUE=' + constVal : '') + (attrs.length ? ' ' + attrs.join(' ') : ''));
});
fs.writeFileSync(out, lines.join('\n'));
console.log('寫入', lines.length, '個節點到', out);
