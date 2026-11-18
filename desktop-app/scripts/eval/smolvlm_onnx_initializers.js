// 最小 protobuf 讀取：只抽 ModelProto.graph.initializer（name、dims、data_type、raw_data 或 float_data）
const fs = require('fs');
function readVarint(b, p) { let r = 0n, s = 0n, c; do { c = b[p.i++]; r |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80); return r; }
function fields(b, start, end) {
  const out = []; let i = start; const p = { i };
  while (p.i < end) {
    const key = Number(readVarint(b, p)); const fn = key >>> 3, wt = key & 7;
    if (wt === 0) { out.push([fn, 0, Number(readVarint(b, p))]); }
    else if (wt === 2) { const len = Number(readVarint(b, p)); out.push([fn, 2, [p.i, p.i + len]]); p.i += len; }
    else if (wt === 5) { out.push([fn, 5, b.subarray(p.i, p.i + 4)]); p.i += 4; }
    else if (wt === 1) { out.push([fn, 1, b.subarray(p.i, p.i + 8)]); p.i += 8; }
    else throw new Error('wire type ' + wt);
  }
  return out;
}
function tensor(b, [s, e]) {
  const t = { dims: [], name: '', dataType: 0, raw: null, floats: null };
  for (const [fn, wt, v] of fields(b, s, e)) {
    if (fn === 1) t.dims.push(v); else if (fn === 2) t.dataType = v; else if (fn === 8) t.name = b.subarray(v[0], v[1]).toString('utf8');
    else if (fn === 9) t.raw = b.subarray(v[0], v[1]); else if (fn === 4 && wt === 2) t.floats = b.subarray(v[0], v[1]);
  }
  return t;
}
function initializers(file, wantNames) {
  const b = fs.readFileSync(file);
  const top = fields(b, 0, b.length);
  const g = top.find(([fn]) => fn === 7);
  const res = [];
  for (const [fn, wt, v] of fields(b, g[2][0], g[2][1])) if (fn === 5) res.push(tensor(b, v));
  return res;
}
module.exports = { initializers };
if (require.main === module) {
  const arr = initializers(process.argv[2]);
  console.log('count', arr.length);
  for (const t of arr.slice(0, Number(process.argv[3] || 40))) console.log(t.name, JSON.stringify(t.dims), t.dataType, t.raw ? t.raw.length : 0);
}
