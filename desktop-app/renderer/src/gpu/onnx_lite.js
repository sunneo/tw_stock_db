/* onnx_lite.js — 極簡 ONNX 讀取器與改寫器（只用 Uint8Array，Node 與瀏覽器都能跑，不需要 Buffer）。
 * 用途：從現有 q8 模型檔取出權重（推論概念驗證），以及產生「輸出隱藏狀態、不算 lm_head」的變體圖（DESIGN.webgpu-cuda.md §7.3）。
 * 純 UMD。桌面版的 nr-onnx-lite.js 是這份檔案的拷貝（改一邊要同步）。
 *
 * parseModel 的回傳形狀：
 *   { buf, nodes, inits（物件：名稱→張量資訊，舊呼叫端用 m.inits[名稱]）, inputs, outputs（名稱字串）,
 *     graph: { nodes, inits（Map：名稱→同一批張量資訊）, inputs, outputs }（llm_q8_onnx 用）}
 * 2026-11-19 修正：O12f（ffbd0462d）把回傳改成只有 { graph }，舊呼叫端的 m.inits／m.nodes 變成 undefined，
 * 於是 Qwen3 GPU 整段解碼報「Cannot read properties of undefined」與「m.nodes is not iterable」。這裡把舊形狀還原，graph 保留給 O12f。
 * 輸入不合法（空檔、文字／網頁、截斷、缺 graph）會丟出寫明位元組數與檔頭的錯誤，不再回傳 undefined。
 */
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

  // 位元組的描述：長度與前 16 位元組（十六進位）。錯誤訊息用，讓人看得出是截斷、空檔還是網頁。
  function describe(u8) {
    const head = Array.from(u8.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return u8.length + ' 位元組，前 16 位元組：' + (head || '（無）');
  }
  // 讀 varint，回傳 [值, 新位置]；超出檔案範圍就丟錯（截斷的檔案會在這裡露出來）
  function varint(buf, pos) {
    let r = 0, mul = 1;
    for (;;) {
      if (pos >= buf.length) throw new Error('onnx_lite：varint 讀到檔案結尾（位置 ' + pos + '，共 ' + buf.length + ' 位元組，可能是截斷）');
      const b = buf[pos++];
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) break;
      mul *= 128;
    }
    return [r, pos];
  }
  // 一段長度為 len 的欄位內容必須在 end 與檔案長度之內；否則丟出寫明數字的錯誤
  function checkRange(buf, pos, len, field, end) {
    const limit = Math.min(end, buf.length);
    if (pos + len > limit) throw new Error('onnx_lite：欄位 ' + field + ' 宣告 ' + len + ' 位元組，但只剩 ' + Math.max(0, limit - pos) + ' 位元組（位置 ' + pos + '，檔案共 ' + buf.length + ' 位元組）；檔案可能被截斷');
  }
  // 走一段訊息，對每個欄位呼叫 fn(欄位號, 線型, 值或[起,迄])；線型 2 的值是 [起, 迄]
  function walk(buf, start, end, fn) {
    let pos = start;
    while (pos < end) {
      let t; [t, pos] = varint(buf, pos);
      const field = Math.floor(t / 8), wt = t % 8;
      if (wt === 0) { let v; [v, pos] = varint(buf, pos); fn(field, 0, v); }
      else if (wt === 2) { let len; [len, pos] = varint(buf, pos); checkRange(buf, pos, len, field, end); fn(field, 2, [pos, pos + len]); pos += len; }
      else if (wt === 5) { checkRange(buf, pos, 4, field, end); fn(field, 5, [pos, pos + 4]); pos += 4; }
      else if (wt === 1) { checkRange(buf, pos, 8, field, end); fn(field, 1, [pos, pos + 8]); pos += 8; }
      else throw new Error('onnx_lite：不支援的線型 ' + wt + '（位置 ' + (pos - 1) + '）');
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
      else if (f === 7) { if (!t.ints) t.ints = []; if (wt === 2) { let p = v[0]; while (p < v[1]) { let x; [x, p] = varint(buf, p); t.ints.push(x); } } else t.ints.push(v); }   // int64_data（小的 int64 常數，例如 Split 的 splits）
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
      else if (f === 5) a.tensor = v;  // TensorProto 範圍（Constant 節點的 value）
      else if (f === 6) a.graph = v;   // GraphProto 範圍（If／Loop 的子圖）
      else if (f === 9) { if (!a.strings) a.strings = []; a.strings.push(str(buf, v)); }
    });
    return a;
  }
  // 取得 Constant 節點的值：{ dims, dtype, values（Float32Array 或 BigInt/數字陣列） }
  function constantValue(m, node) {
    const a = node.attrs && node.attrs.value;
    if (!a || !a.tensor) throw new Error('onnx_lite：節點 ' + node.name + ' 不是 tensor 常數');
    const t = parseTensor(m.buf, a.tensor);
    let values = null;
    if (t.floats) values = Float32Array.from(t.floats);
    else if (t.ints) values = t.ints.slice();
    else if (t.raw) {
      const bytes = m.buf.subarray(t.raw[0], t.raw[1]);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = bytes.byteLength;
      if (t.dtype === 1) { values = new Float32Array(n / 4); for (let i = 0; i < n / 4; i++) values[i] = dv.getFloat32(i * 4, true); }
      else if (t.dtype === 6) { values = new Int32Array(n / 4); for (let i = 0; i < n / 4; i++) values[i] = dv.getInt32(i * 4, true); }
      else if (t.dtype === 7) { values = []; for (let i = 0; i < n / 8; i++) values.push(Number(dv.getBigInt64(i * 8, true))); }
      else if (t.dtype === 9) { values = Array.from(bytes); }
      else values = bytes.slice();
    }
    return { dims: t.dims, dtype: t.dtype, values };
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
  // 解析一個 GraphProto（範圍 [起, 迄]）：節點、初始值（物件：名稱→張量資訊）、圖輸入名、圖輸出名（輸入不含初始值）
  function parseGraph(buf, graph) {
    const nodes = [], inits = {}, inputs = [], outputs = [];
    const vname = (r) => { let s = ''; walk(buf, r[0], r[1], (f, wt, v) => { if (f === 1) s = str(buf, v); }); return s; };
    walk(buf, graph[0], graph[1], (f, wt, v) => {
      if (f === 1) nodes.push(parseNode(buf, v));
      else if (f === 5) { const t = parseTensor(buf, v); inits[t.name] = t; }
      else if (f === 11) inputs.push(vname(v));
      else if (f === 12) outputs.push(vname(v));
    });
    return { nodes: nodes, inits: inits, inputs: inputs.filter((x) => !inits[x]), outputs: outputs };
  }
  // 輸入檢查：空檔、看起來是文字或網頁的內容，要在解析前就說清楚（否則會變成不知所云的例外）
  function checkInput(buf) {
    if (!buf || typeof buf.length !== 'number' || !(buf instanceof Uint8Array)) throw new Error('onnx_lite：輸入不是位元組（需要 Uint8Array）');
    if (buf.length === 0) throw new Error('onnx_lite：檔案是空的（0 位元組）；常見原因是下載中斷或快取寫入失敗');
    const n = Math.min(buf.length, 64);
    let text = true;
    for (let i = 0; i < n; i++) { const b = buf[i]; if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) { text = false; break; } }
    if (text) throw new Error('onnx_lite：看起來是文字或網頁，不是 ONNX 二進位（' + describe(buf) + '）；常見原因是下載到錯誤頁');
  }
  // 讀整個模型。回傳形狀見檔案開頭。
  function parseModel(buf) {
    checkInput(buf);
    let graph = null; const top = new Set();
    walk(buf, 0, buf.length, (f, wt, v) => { top.add(f); if (f === 7) graph = v; });
    if (!graph) throw new Error('onnx_lite：找不到 graph（ModelProto 欄位 7）；頂層欄位號：[' + Array.from(top).sort((a, b) => a - b).join(', ') + ']（' + describe(buf) + '）');
    const g = parseGraph(buf, graph);
    const initMap = new Map(Object.keys(g.inits).map((k) => [k, g.inits[k]]));
    return { buf: buf, nodes: g.nodes, inits: g.inits, inputs: g.inputs, outputs: g.outputs,
      graph: { nodes: g.nodes, inits: initMap, inputs: g.inputs, outputs: g.outputs } };
  }

  // ---- 張量的 typed array（llm_q8_onnx 用）：raw_data 不對齊時複製一份；小張量用 float_data／int 欄位 ----
  const TYPED = { 1: Float32Array, 2: Uint8Array, 3: Int8Array, 6: Int32Array, 10: Uint16Array };
  function tensorArray(buf, t) {
    const elems = t.dims.reduce((a, b) => a * b, 1);
    const C = TYPED[t.dtype];
    if (t.raw) {
      if (!C) throw new Error('onnx_lite：dtype ' + t.dtype + ' 暫不取陣列（' + t.name + '）');
      const bytes = buf.subarray(t.raw[0], t.raw[1]);
      const need = elems * C.BYTES_PER_ELEMENT;
      if (bytes.length !== need) throw new Error('onnx_lite：' + t.name + ' 的 raw_data 長度 ' + bytes.length + ' 與形狀需要的 ' + need + ' 不符');
      if (bytes.byteOffset % C.BYTES_PER_ELEMENT === 0) return new C(bytes.buffer, bytes.byteOffset, elems);
      return new C(bytes.slice().buffer, 0, elems);
    }
    if (t.dtype === 1 && t.floats) return Float32Array.from(t.floats.slice(0, elems || t.floats.length));
    if (t.dtype === 7 && t.ints) return BigInt64Array.from(t.ints.slice(0, elems || t.ints.length), (x) => BigInt(x));
    if (t.ints && C) return C.from(t.ints.slice(0, elems || t.ints.length));
    throw new Error('onnx_lite：' + t.name + ' 沒有 raw_data，也不是可讀的 float_data／int 欄位（dtype ' + t.dtype + '）');
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
      else if (wt === 2) { let len; [len, pos] = varint(buf, pos); checkRange(buf, pos, len, f, b); vr = [pos, pos + len]; pos += len; }
      else if (wt === 5) { checkRange(buf, pos, 4, f, b); vr = [pos, pos + 4]; pos += 4; }
      else if (wt === 1) { checkRange(buf, pos, 8, f, b); vr = [pos, pos + 8]; pos += 8; }
      else throw new Error('onnx_lite：不支援的線型 ' + wt + '（位置 ' + start + '）');
      out.push({ f: f, wt: wt, start: start, end: pos, vr: vr });
    }
    return out;
  }
  // 把模型改成：移除 dropNodeName 節點與之後不再被使用的節點，並把圖輸出 replaceOutput 換成 hiddenName（float32，維度 hiddenDims）
  // 權重位元組原樣沿用（subarray，不複製）；回傳 { removed, buf():Uint8Array }
  function buildHiddenStateModel(buf, o) {
    checkInput(buf);
    const top = fieldsOf(buf, 0, buf.length);
    const gf = top.find((x) => x.f === 7);
    if (!gf) throw new Error('onnx_lite：找不到 graph（ModelProto 欄位 7）（' + describe(buf) + '）');
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
  return { parseModel: parseModel, parseGraph: parseGraph, tensorBytes: tensorBytes, tensorArray: tensorArray, scalar: scalar,
    buildHiddenStateModel: buildHiddenStateModel, constantValue: constantValue, DTYPE: DTYPE, describe: describe };
});
