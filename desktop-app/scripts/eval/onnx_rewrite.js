'use strict';
// onnx_rewrite.js — 改寫 ONNX 圖的輸出清單（評估用）。ORT 的 run 不允許 fetch 中間張量，所以把圖的輸出換成要看的中間張量。
// 只重寫 ModelProto.graph（field 7）裡的輸出（field 12）；其餘位元組原樣保留，不改權重。
// 新輸出宣告為 FLOAT、不宣告 shape（ORT 會自己推）。
function readVarint(b, p) { let v = 0, sh = 0; for (;;) { const c = b[p++]; v += (c & 0x7f) * Math.pow(2, sh); sh += 7; if (!(c & 0x80)) break; } return [v, p]; }
function fieldsOf(b, s, e) {
  const out = []; let p = s;
  while (p < e) {
    const st = p; let key; [key, p] = readVarint(b, p);
    const f = Math.floor(key / 8), wt = key % 8; let vs = p, ve;
    if (wt === 0) { [, p] = readVarint(b, p); ve = p; }
    else if (wt === 2) { let len; [len, p] = readVarint(b, p); vs = p; ve = p + len; p = ve; }
    else if (wt === 5) { vs = p; ve = p + 4; p = ve; }
    else if (wt === 1) { vs = p; ve = p + 8; p = ve; }
    else throw new Error('protobuf 不支援的 wire type ' + wt);
    out.push({ f, wt, start: st, vs, ve, end: p });
  }
  return out;
}
function encVarint(n) { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
function bytesField(f, data) { return Buffer.concat([encVarint(f * 8 + 2), encVarint(data.length), data]); }
function rewriteOutputs(buf, names) {
  const top = fieldsOf(buf, 0, buf.length);
  const gf = top.find((x) => x.f === 7);
  const gparts = fieldsOf(buf, gf.vs, gf.ve);
  const keep = gparts.filter((p) => p.f !== 12).map((p) => buf.subarray(p.start, p.end));
  const outs = names.map((nm) => bytesField(12, Buffer.concat([bytesField(1, Buffer.from(nm, 'utf8')), bytesField(2, bytesField(1, Buffer.from([0x08, 0x01])))])));
  const g = Buffer.concat(keep.concat(outs));
  return Buffer.concat(top.map((p) => (p === gf ? bytesField(7, g) : buf.subarray(p.start, p.end))));
}
module.exports = { rewriteOutputs, fieldsOf };
