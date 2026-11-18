/* onnx_lite.js — 讀 ONNX 檔的最小 protobuf 解析（O12e）：只取圖的節點、屬性與 initializer 的位置，不複製大權重。
 * 只支援本專案需要的欄位；遇到不認得的欄位直接略過。權重以 [off, len] 指向原始位元組（raw_data），需要時再取 typed array。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaOnnxLite。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaOnnxLite = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ONNX TensorProto.DataType
  const DTYPE = { 1: 'float32', 2: 'uint8', 3: 'int8', 5: 'int16', 6: 'int32', 7: 'int64', 9: 'bool', 10: 'float16', 11: 'float64', 16: 'bfloat16' };
  const BYTES = { float32: 4, uint8: 1, int8: 1, int16: 2, int32: 4, int64: 8, bool: 1, float16: 2, float64: 8, bfloat16: 2 };

  // 讀一個 varint；回傳 [值, 新位置]（值超過 2^53 時精度會丟，本檔案只用於長度與小數值）
  // varint 用 BigInt 累加再以 64 位元有號解讀：protobuf 的負數 int32／int64 會編成 10 個位元組（sign-extended），不能用浮點數直接算。
  function varint(u8, p) {
    let v = 0n, sh = 0n, b;
    do { b = u8[p++]; v |= BigInt(b & 0x7f) << sh; sh += 7n; } while (b & 0x80);
    return [Number(BigInt.asIntN(64, v)), p];
  }
  // 讀一個訊息範圍 [s, e) 的所有欄位：回傳 [{ num, wt, v, off, len }]（wt 2 的 off／len 指向原位元組；wt 0 的 v 是數值）
  function fields(u8, s, e) {
    const out = [];
    let p = s;
    while (p < e) {
      let key; [key, p] = varint(u8, p);
      const num = Math.floor(key / 8), wt = key % 8;
      if (wt === 0) { let v; [v, p] = varint(u8, p); out.push({ num, wt, v }); }
      else if (wt === 2) { let len; [len, p] = varint(u8, p); out.push({ num, wt, off: p, len }); p += len; }
      else if (wt === 5) { out.push({ num, wt, off: p, len: 4 }); p += 4; }
      else if (wt === 1) { out.push({ num, wt, off: p, len: 8 }); p += 8; }
      else throw new Error('onnx_lite：不支援的 wire type ' + wt + '（位置 ' + p + '）');
    }
    return out;
  }
  const str = (u8, f) => decodeUtf8(u8, f.off, f.len);
  function decodeUtf8(u8, off, len) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8.subarray(off, off + len));
    return Buffer.from(u8.buffer, u8.byteOffset + off, len).toString('utf8');
  }
  // 陣列型欄位（repeated varint，可能是 packed）
  function ints(u8, f) {
    if (f.wt === 0) return [f.v];
    const r = []; let p = f.off; const e = f.off + f.len;
    while (p < e) { let v; [v, p] = varint(u8, p); r.push(v); }
    return r;
  }

  function parseTensor(u8, s, e) {
    const fs = fields(u8, s, e);
    const t = { name: '', dims: [], dtype: null, rawOff: -1, rawLen: 0, ints: null, floats: null };
    for (const f of fs) {
      if (f.num === 1) t.dims.push(...ints(u8, f));
      else if (f.num === 2) t.dtype = DTYPE[f.v] || ('dtype' + f.v);
      else if (f.num === 8) t.name = str(u8, f);
      else if (f.num === 9) { t.rawOff = f.off; t.rawLen = f.len; }
      else if (f.num === 4) {   // float_data：單一 fixed32（wt 5）或 packed（wt 2）
        t.floatVals = t.floatVals || [];
        if (f.wt === 5) t.floatVals.push(new DataView(u8.buffer, u8.byteOffset + f.off, 4).getFloat32(0, true));
        else for (let q = f.off; q < f.off + f.len; q += 4) t.floatVals.push(new DataView(u8.buffer, u8.byteOffset + q, 4).getFloat32(0, true));
      }
      else if (f.num === 5 || f.num === 7) { t.intVals = t.intVals || []; t.intVals.push(...ints(u8, f)); }   // int32_data／int64_data（小的 zero point 與 scale 常用）
    }
    t.elems = t.dims.reduce((a, b) => a * b, 1);
    return t;
  }
  function parseAttr(u8, s, e) {
    const a = { name: '', type: 0 };
    for (const f of fields(u8, s, e)) {
      if (f.num === 1) a.name = str(u8, f);
      else if (f.num === 20) a.type = f.v;
      else if (f.num === 2) { const dv = new DataView(u8.buffer, u8.byteOffset + f.off, 4); a.f = dv.getFloat32(0, true); }
      else if (f.num === 3) a.i = f.v;
      else if (f.num === 4) a.s = str(u8, f);
      else if (f.num === 8) { a.ints = a.ints || []; a.ints.push(...ints(u8, f)); }
      else if (f.num === 5) a.t = parseTensor(u8, f.off, f.off + f.len);
    }
    return a;
  }
  function parseNode(u8, s, e) {
    const n = { name: '', op: '', inputs: [], outputs: [], attrs: {}, domain: '' };
    for (const f of fields(u8, s, e)) {
      if (f.num === 1) n.inputs.push(str(u8, f));
      else if (f.num === 2) n.outputs.push(str(u8, f));
      else if (f.num === 3) n.name = str(u8, f);
      else if (f.num === 4) n.op = str(u8, f);
      else if (f.num === 5) { const a = parseAttr(u8, f.off, f.off + f.len); n.attrs[a.name] = a; }
      else if (f.num === 7) n.domain = str(u8, f);
    }
    return n;
  }
  function parseValueInfo(u8, s, e) {
    const v = { name: '' };
    for (const f of fields(u8, s, e)) if (f.num === 1) v.name = str(u8, f);
    return v;
  }

  // u8：整個 .onnx 檔案的 Uint8Array。回傳 { producer, graph: { name, nodes, inits: Map(name→tensor), inputs, outputs } }
  function parseModel(u8) {
    const top = fields(u8, 0, u8.length);
    const g = top.find((f) => f.num === 7);
    if (!g) throw new Error('onnx_lite：找不到 graph（ModelProto.graph）');
    const graph = { name: '', nodes: [], inits: new Map(), inputs: [], outputs: [] };
    for (const f of fields(u8, g.off, g.off + g.len)) {
      if (f.num === 1) graph.nodes.push(parseNode(u8, f.off, f.off + f.len));
      else if (f.num === 2) graph.name = str(u8, f);
      else if (f.num === 5) { const t = parseTensor(u8, f.off, f.off + f.len); graph.inits.set(t.name, t); }
      else if (f.num === 11) graph.inputs.push(parseValueInfo(u8, f.off, f.off + f.len));
      else if (f.num === 12) graph.outputs.push(parseValueInfo(u8, f.off, f.off + f.len));
    }
    return { graph: graph };
  }

  // 取得 initializer 的 typed array（指向原檔案，不複製；不對齊時複製一份）。int8／uint8 直接回傳 view。
  function tensorArray(u8, t) {
    if (t.rawOff < 0) {   // 小張量：值放在 float_data／int32_data
      if (t.floatVals && t.dtype === 'float32') return Float32Array.from(t.floatVals.slice(0, t.elems || t.floatVals.length));
      if (t.intVals && (t.dtype === 'int8' || t.dtype === 'uint8' || t.dtype === 'int32')) {
        const Ctor = { int8: Int8Array, uint8: Uint8Array, int32: Int32Array }[t.dtype];
        return Ctor.from(t.intVals.slice(0, t.elems || t.intVals.length));
      }
      throw new Error('onnx_lite：' + t.name + ' 沒有 raw_data，也不是可讀的 float_data／int32_data（' + t.dtype + '）');
    }
    const bytes = BYTES[t.dtype];
    if (!bytes) throw new Error('onnx_lite：不支援的 dtype ' + t.dtype + '（' + t.name + '）');
    const need = t.elems * bytes;
    if (t.rawLen !== need) throw new Error('onnx_lite：' + t.name + ' 的 raw_data 長度 ' + t.rawLen + ' 與形狀需要的 ' + need + ' 不符');
    const buf = u8.buffer, base = u8.byteOffset + t.rawOff;
    const make = { float32: Float32Array, int8: Int8Array, uint8: Uint8Array, int32: Int32Array, int64: BigInt64Array, float16: Uint16Array, bfloat16: Uint16Array }[t.dtype];
    if (!make) throw new Error('onnx_lite：' + t.dtype + ' 暫不取陣列（' + t.name + '）');
    if (base % BYTES[t.dtype] === 0) return new make(buf, base, t.elems);
    return new make(buf.slice(base, base + need), 0, t.elems);   // 未對齊：複製一份
  }

  return { parseModel: parseModel, tensorArray: tensorArray, DTYPE: DTYPE, BYTES: BYTES };
}));
