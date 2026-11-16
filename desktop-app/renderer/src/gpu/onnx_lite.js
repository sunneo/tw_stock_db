// onnx_lite.js — 極簡 ONNX 讀取器與改寫器（只用 Uint8Array，Node 與瀏覽器都能跑，不需要 Buffer）。
// 用途：從現有 q8 模型檔取出權重（推論概念驗證），以及產生「輸出隱藏狀態、不算 lm_head」的變體圖（DESIGN.webgpu-cuda.md §7.3）。
// 純 UMD。桌面版的 nr-onnx-lite.js 是這份檔案的拷貝（改一邊要同步）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaOnnxLite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const decodeUtf8 = (u8) => (td ? td.decode(u8) : Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('utf8'));
  const encodeUtf8 = (s) => (te ? te.encode(s) : new Uint8Array(Buffer.from(s, 'utf8')));
  const f32At = (u8, p) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getFloat32(p, true);

  // 讀 varint，回傳 [值, 新位置]；值用 Number（模型檔不會超過 2^53，所以用乘法不用位元運算）
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
  const str = (buf, r) => decodeUtf8(buf.subarray(r[0], r[1]));

  function parseTensor(buf, r) {
    const t = { name: '', dims: [], dtype: 0, raw: null, ext: {} };
    walk(buf, r[0], r[1], (f, wt, v) => {
      if (f === 1) { if (wt === 0) t.dims.push(v); else { let p = v[0]; while (p < v[1]) { let x; [x, p] = varint(buf, p); t.dims.push(x); } } }
      else if (f === 2) t.dtype = v;
      else if (f === 8) t.name = str(buf, v);
      else if (f === 9) t.raw = v;  // [起, 迄]，不複製
      else if (f === 4) { if (!t.floats) t.floats = []; if (wt === 2) { for (let p = v[0]; p < v[1]; p += 4) t.floats.push(f32At(buf, p)); } else t.floats.push(f32At(buf, v[0])); }
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
      else if (f === 2) a.f = f32At(buf, v[0]);
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

  // ---- 位元組組裝（只用 Uint8Array）----
  const enc = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Uint8Array.from(o); };
  const cat = (list) => {
    let len = 0; for (const b of list) len += b.length;
    const out = new Uint8Array(len); let p = 0;
    for (const b of list) { out.set(b, p); p += b.length; }
    return out;
  };
  const fVarB = (f, v) => cat([enc(f * 8), enc(v)]);
  const fBytesB = (f, b) => cat([enc(f * 8 + 2), enc(b.length), b]);
  const fStrB = (f, s) => fBytesB(f, encodeUtf8(s));
  function valueInfo(name, elem, dims) {  // dims：數字或字串（符號維度，dim_param）
    const dimMsgs = dims.map((d) => fBytesB(1, typeof d === 'number' ? fVarB(1, d) : fStrB(2, d)));
    return cat([fStrB(1, name), fBytesB(2, fBytesB(1, cat([fVarB(1, elem), fBytesB(2, cat(dimMsgs))])))]);
  }
  // 依序走一段訊息，回傳每個欄位 { f, wt, start, end, vr }（start..end 是含標籤的整段位元組）
  function fieldsOf(buf, a, b) {
    const out = [];
    let pos = a;
    while (pos < b) {
      const start = pos;
      let t; [t, pos] = varint(buf, pos);
      const f = Math.floor(t / 8), wt = t % 8;
      let vr;
      if (wt === 0) { let v; [v, pos] = varint(buf, pos); vr = v; }
      else if (wt === 2) { let len; [len, pos] = varint(buf, pos); vr = [pos, pos + len]; pos += len; }
      else if (wt === 5) { vr = [pos, pos + 4]; pos += 4; }
      else if (wt === 1) { vr = [pos, pos + 8]; pos += 8; }
      else throw new Error('onnx_lite：不支援的線型 ' + wt);
      out.push({ f: f, wt: wt, start: start, end: pos, vr: vr });
    }
    return out;
  }
  // 把模型改成：移除 dropNodeName 節點與之後不再被使用的節點，並把圖輸出 replaceOutput 換成 hiddenName（float32，維度 hiddenDims）
  // 權重位元組原樣沿用（subarray，不複製）；回傳 { removed, buf():Uint8Array }
  function buildHiddenStateModel(buf, o) {
    const top = fieldsOf(buf, 0, buf.length);
    const gf = top.find((x) => x.f === 7);
    const parts = fieldsOf(buf, gf.vr[0], gf.vr[1]);
    const nodes = [];
    parts.forEach((p, i) => { if (p.f === 1) { const n = parseNode(buf, p.vr); n._i = i; nodes.push(n); } });
    const drop = new Set();
    const target = nodes.find((n) => n.name === o.dropNodeName);
    if (!target) throw new Error('onnx_lite：找不到節點 ' + o.dropNodeName);
    drop.add(target);
    const outNames = new Set(); // 圖輸出（扣掉要換掉的）
    parts.forEach((p) => { if (p.f === 12) { let nm = ''; walk(buf, p.vr[0], p.vr[1], (f, wt, v) => { if (f === 1) nm = str(buf, v); }); if (nm !== o.replaceOutput) outNames.add(nm); } });
    outNames.add(o.hiddenName);
    // 反覆清掉沒有任何使用者、也不是圖輸出的節點
    for (let changed = true; changed;) {
      changed = false;
      const used = new Set(outNames);
      nodes.forEach((n) => { if (!drop.has(n)) n.inputs.forEach((x) => used.add(x)); });
      nodes.forEach((n) => { if (!drop.has(n) && n.outputs.every((x) => !used.has(x))) { drop.add(n); changed = true; } });
    }
    const keepIdx = new Set(); drop.forEach((n) => keepIdx.add(n._i));
    const gp = [];
    parts.forEach((p, i) => {
      if (p.f === 1 && keepIdx.has(i)) return;
      if (p.f === 12) { let nm = ''; walk(buf, p.vr[0], p.vr[1], (f, wt, v) => { if (f === 1) nm = str(buf, v); }); if (nm === o.replaceOutput) { gp.push(fBytesB(12, valueInfo(o.hiddenName, 1, o.hiddenDims))); return; } }
      gp.push(buf.subarray(p.start, p.end));
    });
    const gLen = gp.reduce((s, b) => s + b.length, 0);
    const out = [];
    top.forEach((p) => { if (p === gf) { out.push(cat([enc(7 * 8 + 2), enc(gLen)])); gp.forEach((b) => out.push(b)); } else out.push(buf.subarray(p.start, p.end)); });
    return { removed: Array.from(drop).map((n) => n.name), buf: function () { return cat(out); } };
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
    if (t.raw) { const b = model.buf; return t.dtype === 1 ? f32At(b, t.raw[0]) : b[t.raw[0]]; }
    throw new Error('onnx_lite：權重 ' + name + ' 沒有可讀的純量');
  }
  const DTYPE = { 1: 'float32', 2: 'uint8', 3: 'int8', 6: 'int32', 7: 'int64', 10: 'float16' };
  return { parseModel, tensorBytes, scalar, buildHiddenStateModel, DTYPE };
});
