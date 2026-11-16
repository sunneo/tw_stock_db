// onnx_lite.js — 極簡 ONNX 讀取器（只讀 protobuf 的節點與權重，不需要任何套件）。
// 用途：推論概念驗證（DESIGN.webgpu-cuda.md §7.3）從現有 q8 模型檔取出權重。純 UMD，node 可 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaOnnxLite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 讀 varint，回傳 [值, 新位置]；值用 Number（模型檔不會超過 2^53）
  function varint(buf, pos) {
    let r = 0, mul = 1;
    for (;;) {
      const b = buf[pos++];
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) break;
      mul *= 128;
    }
    return [r, pos];
  }
  // 走一段訊息，對每個欄位呼叫 fn(欄位號, 線型, 值或[起,迄])；線型 2 的值是 [起, 迄]
  function walk(buf, start, end, fn) {
    let pos = start;
    while (pos < end) {
      let t; [t, pos] = varint(buf, pos);
      const field = Math.floor(t / 8), wt = t % 8;
      if (wt === 0) { let v; [v, pos] = varint(buf, pos); fn(field, 0, v); }
      else if (wt === 2) { let len; [len, pos] = varint(buf, pos); fn(field, 2, [pos, pos + len]); pos += len; }
      else if (wt === 5) { fn(field, 5, [pos, pos + 4]); pos += 4; }
      else if (wt === 1) { fn(field, 1, [pos, pos + 8]); pos += 8; }
      else throw new Error('onnx_lite：不支援的線型 ' + wt);
    }
  }
  const str = (buf, r) => buf.toString('utf8', r[0], r[1]);

  function parseTensor(buf, r) {
    const t = { name: '', dims: [], dtype: 0, raw: null, ext: {} };
    walk(buf, r[0], r[1], (f, wt, v) => {
      if (f === 1) { if (wt === 0) t.dims.push(v); else { let p = v[0]; while (p < v[1]) { let x; [x, p] = varint(buf, p); t.dims.push(x); } } }
      else if (f === 2) t.dtype = v;
      else if (f === 8) t.name = str(buf, v);
      else if (f === 9) t.raw = v;  // [起, 迄]，不複製
      else if (f === 4) { if (!t.floats) t.floats = []; if (wt === 2) { for (let p = v[0]; p < v[1]; p += 4) t.floats.push(buf.readFloatLE(p)); } else t.floats.push(buf.readFloatLE(v[0])); }
      else if (f === 5) { if (!t.ints) t.ints = []; if (wt === 2) { let p = v[0]; while (p < v[1]) { let x; [x, p] = varint(buf, p); t.ints.push(x); } } else t.ints.push(v); }
      else if (f === 13) { // external_data：StringStringEntryProto
        let k = '', val = '';
        walk(buf, v[0], v[1], (ff, w2, vv) => { if (ff === 1) k = str(buf, vv); else if (ff === 2) val = str(buf, vv); });
        t.ext[k] = val;
      }
    });
    return t;
  }
  function parseAttr(buf, r) {
    const a = { name: '', i: null, f: null, ints: [], s: null };
    walk(buf, r[0], r[1], (f, wt, v) => {
      if (f === 1) a.name = str(buf, v);
      else if (f === 3) a.i = v;
      else if (f === 2) a.f = buf.readFloatLE(v[0]);
      else if (f === 8) { if (wt === 0) a.ints.push(v); }
      else if (f === 4) a.s = str(buf, v);
    });
    return a;
  }
  function parseNode(buf, r) {
    const n = { name: '', op: '', inputs: [], outputs: [], attrs: {} };
    walk(buf, r[0], r[1], (f, wt, v) => {
      if (f === 1) n.inputs.push(str(buf, v));
      else if (f === 2) n.outputs.push(str(buf, v));
      else if (f === 3) n.name = str(buf, v);
      else if (f === 4) n.op = str(buf, v);
      else if (f === 5) { const a = parseAttr(buf, v); n.attrs[a.name] = a; }
    });
    return n;
  }
  // 讀整個模型：回傳 { buf, nodes, inits（名稱→張量資訊）}
  function parseModel(buf) {
    let graph = null;
    walk(buf, 0, buf.length, (f, wt, v) => { if (f === 7) graph = v; });
    if (!graph) throw new Error('onnx_lite：找不到 graph');
    const nodes = [], inits = {};
    walk(buf, graph[0], graph[1], (f, wt, v) => {
      if (f === 1) nodes.push(parseNode(buf, v));
      else if (f === 5) { const t = parseTensor(buf, v); inits[t.name] = t; }
    });
    return { buf: buf, nodes: nodes, inits: inits };
  }
  // 取張量的位元組（raw_data；外部資料不支援）
  function tensorBytes(model, name) {
    const t = model.inits[name];
    if (!t) throw new Error('onnx_lite：沒有權重 ' + name);
    if (!t.raw) throw new Error('onnx_lite：權重 ' + name + ' 沒有 raw_data（可能是外部資料或欄位型）');
    return model.buf.subarray(t.raw[0], t.raw[1]);
  }
  // 取純量（scale 為 float、zero_point 為整數）：raw 或 floats／ints 欄位都接受
  function scalar(model, name) {
    const t = model.inits[name];
    if (!t) throw new Error('onnx_lite：沒有權重 ' + name);
    if (t.floats && t.floats.length) return t.floats[0];
    if (t.ints && t.ints.length) return t.ints[0];
    if (t.raw) { const b = model.buf; return t.dtype === 1 ? b.readFloatLE(t.raw[0]) : b[t.raw[0]]; }
    throw new Error('onnx_lite：權重 ' + name + ' 沒有可讀的純量');
  }
  const DTYPE = { 1: 'float32', 2: 'uint8', 3: 'int8', 6: 'int32', 7: 'int64', 10: 'float16' };
  return { parseModel, tensorBytes, scalar, DTYPE };
});
