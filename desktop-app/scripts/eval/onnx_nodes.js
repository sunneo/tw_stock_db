// 最小 ONNX 節點讀取（只抽 GraphProto.node：op_type、input、output、name、attribute 的整數與浮點）。
// 給 scripts/eval 的盤點與對拍用；不做完整的 protobuf 解析。
'use strict';
const fs = require('fs');

function readFields(b, s, e) {
  const out = []; const p = { i: s };
  const v = () => { let r = 0n, sh = 0n, c; do { c = b[p.i++]; r |= BigInt(c & 0x7f) << sh; sh += 7n; } while (c & 0x80); return r; };
  while (p.i < e) {
    const key = Number(v()); const fn = key >>> 3, wt = key & 7;
    if (wt === 0) out.push([fn, 0, Number(v())]);
    else if (wt === 2) { const len = Number(v()); out.push([fn, 2, [p.i, p.i + len]]); p.i += len; }
    else if (wt === 5) { out.push([fn, 5, b.readFloatLE(p.i)]); p.i += 4; }
    else if (wt === 1) { p.i += 8; }
    else throw new Error('onnx_nodes：不認得的 wire type ' + wt);
  }
  return out;
}

// 回傳 [{ op, name, inputs[], outputs[], attrs{ 名稱: 值 } }]
function readNodes(file) {
  const b = fs.readFileSync(file);
  const top = readFields(b, 0, b.length);
  const g = top.find(([fn]) => fn === 7);
  if (!g) throw new Error('onnx_nodes：找不到 graph');
  const nodes = [];
  for (const [fn, wt, v] of readFields(b, g[2][0], g[2][1])) {
    if (fn !== 1 || wt !== 2) continue;
    const n = { op: '', name: '', inputs: [], outputs: [], attrs: {} };
    for (const [f2, w2, v2] of readFields(b, v[0], v[1])) {
      if (f2 === 1) n.inputs.push(b.subarray(v2[0], v2[1]).toString('utf8'));
      else if (f2 === 2) n.outputs.push(b.subarray(v2[0], v2[1]).toString('utf8'));
      else if (f2 === 3) n.name = b.subarray(v2[0], v2[1]).toString('utf8');
      else if (f2 === 4) n.op = b.subarray(v2[0], v2[1]).toString('utf8');
      else if (f2 === 5 && w2 === 2) {
        let an = ''; let ai = null; let af = null; const ints = [];
        for (const [f3, w3, v3] of readFields(b, v2[0], v2[1])) {
          if (f3 === 1) an = b.subarray(v3[0], v3[1]).toString('utf8');
          else if (f3 === 3) ai = w3 === 0 ? v3 : ai;
          else if (f3 === 2) af = w3 === 5 ? v3 : af;
          else if (f3 === 8) { if (w3 === 0) ints.push(v3); else if (w3 === 2) { let q = v3[0]; while (q < v3[1]) { let r = 0, sh = 0, c; do { c = b[q++]; r += (c & 0x7f) * Math.pow(2, sh); sh += 7; } while (c & 0x80); ints.push(r); } } }
        }
        n.attrs[an] = ai !== null ? ai : (af !== null ? af : (ints.length ? ints : null));
      }
    }
    nodes.push(n);
  }
  return nodes;
}


// 把指定的中間結果名稱加成 graph.output（只在記憶體中改寫，不寫檔）。ORT 不允許直接要求中間結果名稱，這是唯一的做法。
function varint(n){ const o=[]; n=BigInt(n); do { let b=Number(n & 0x7fn); n >>= 7n; if (n) b|=0x80; o.push(b); } while (n); return Buffer.from(o); }
function withExtraOutputs(file, names) {
  const b = fs.readFileSync(file);
  const top = readFields(b, 0, b.length);
  const g = top.find(([fn]) => fn === 7);
  const gs = g[2][0], ge = g[2][1];
  const lenBytes = varint(ge - gs);
  const tagPos = gs - lenBytes.length - 1;
  if (b[tagPos] !== 0x3a) throw new Error("onnx_nodes：graph 欄位位置不符");
  const extras = names.map((nm) => { const nb = Buffer.from(nm, "utf8"); const vi = Buffer.concat([Buffer.from([0x0a]), varint(nb.length), nb]); return Buffer.concat([Buffer.from([0x62]), varint(vi.length), vi]); });
  const newGraph = Buffer.concat([b.subarray(gs, ge), ...extras]);
  return Buffer.concat([b.subarray(0, tagPos), Buffer.from([0x3a]), varint(newGraph.length), newGraph, b.subarray(ge)]);
}

module.exports = { readNodes, withExtraOutputs };
