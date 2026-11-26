'use strict';
// 通用 CPU 圖解釋器：依 onnx_lite 解析出的節點，逐節點執行 ONNX 算子。
// 用途：整段模型的參考執行（例如 MOSS codec 解碼），之後把熱點算子（MatMul、Conv）換成 GPU 版。
// 張量格式：{ d: number[]（形狀）, t: 'f'（float32）| 'i'（整數，以 Float64 儲存）| 'b'（布林，Uint8）, v: TypedArray }。
// 只實作目前需要的算子；遇到沒實作的算子會直接丟錯（不偷偷略過）。
const lite = require('./onnx_lite.js');
const CONV = require('./conv_ops.js');
const MORE = require('./onnx_ops_more.js');
const MM = require('./mm_ops.js');

const TWO64 = 18446744073709551616;

function numel(d) { let n = 1; for (const x of d) n *= x; return n; }
function strides(d) { const s = new Array(d.length); let acc = 1; for (let i = d.length - 1; i >= 0; i--) { s[i] = acc; acc *= d[i]; } return s; }

// 屬性整數：varint 把負數存成 2^64 形式，這裡還原
function attrInt(a, dflt) {
  if (!a || a.i === null || a.i === undefined) return dflt;
  const v = a.i;
  if (v >= 9223372036854775807) return v === TWO64 ? -1 : v - TWO64;
  return v;
}
function attrF(a, dflt) { return a && a.f !== null && a.f !== undefined ? a.f : dflt; }
function attrInts(a) { return a && a.ints ? a.ints.map((x) => (x >= 9223372036854775807 ? (x === TWO64 ? -1 : x - TWO64) : x)) : null; }

// 輸出位置 → 來源位置的對映：eff[i] 是輸出第 i 維每走一格，來源要走的步距（可為 0 表示廣播）
function mapFromEff(outD, eff, base) {
  const r = outD.length, n = numel(outD);
  const map = new Int32Array(n);
  const idx = new Array(r).fill(0);
  let cur = base || 0;
  for (let k = 0; k < n; k++) {
    map[k] = cur;
    for (let i = r - 1; i >= 0; i--) {
      idx[i]++; cur += eff[i];
      if (idx[i] < outD[i]) break;
      cur -= eff[i] * idx[i]; idx[i] = 0;
    }
  }
  return map;
}
// 廣播：來源形狀 inD 對齊到輸出形狀 outD（右對齊，長度 1 的維度廣播為 0 步距）
function bmap(outD, inD) {
  const r = outD.length, off = r - inD.length, ist = strides(inD);
  const eff = new Array(r).fill(0);
  for (let i = 0; i < inD.length; i++) eff[off + i] = inD[i] === 1 ? 0 : ist[i];
  return mapFromEff(outD, eff, 0);
}
function bcast(a, b) {
  const n = Math.max(a.length, b.length), out = [];
  for (let i = 0; i < n; i++) {
    const x = a.length - n + i >= 0 ? a[a.length - n + i] : 1;
    const y = b.length - n + i >= 0 ? b[b.length - n + i] : 1;
    if (x !== y && x !== 1 && y !== 1) throw new Error('onnx_interp：無法廣播 ' + JSON.stringify(a) + ' 與 ' + JSON.stringify(b));
    out.push(x === 1 ? y : x);
  }
  return out;
}

function mk(d, t) {
  const n = numel(d);
  const v = t === 'b' ? new Uint8Array(n) : (t === 'f' ? new Float32Array(n) : new Float64Array(n));
  return { d: d.slice(), t: t, v: v };
}
function binop(a, b, fn, outT) {
  const od = bcast(a.d, b.d);
  const ma = bmap(od, a.d), mb = bmap(od, b.d);
  const o = mk(od, outT), n = numel(od);
  for (let k = 0; k < n; k++) o.v[k] = fn(a.v[ma[k]], b.v[mb[k]]);
  return o;
}
function unop(a, fn, outT) {
  const o = mk(a.d, outT || a.t);
  for (let k = 0; k < a.v.length; k++) o.v[k] = fn(a.v[k]);
  return o;
}
const arith = (a, b) => (a.t === 'f' || b.t === 'f' ? 'f' : 'i');

// erf：|x|<2.5 用 Taylor 級數，之後用連分式求 erfc（雙精度）
function erf(x) {
  const ax = Math.abs(x);
  if (ax < 2.5) {
    let sum = 0, term = x;
    for (let n = 0; n < 300; n++) {
      sum += term / (2 * n + 1);
      term *= -x * x / (n + 1);
      if (Math.abs(term) < 1e-18) break;
    }
    return 2 / Math.sqrt(Math.PI) * sum;
  }
  let t = ax;
  for (let k = 80; k >= 1; k--) t = ax + (k / 2) / t;
  const erfc = Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * t);
  return x < 0 ? erfc - 1 : 1 - erfc;
}

function half(h) { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * Math.pow(2, -14) * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + m / 1024); }
// 初始值：依 dtype 讀成張量（raw 或外部資料）
function readInitBytes(m, t, dataFiles) {
  if (t.raw) return m.buf.subarray(t.raw[0], t.raw[1]);
  if (t.ext && t.ext.location) {
    const f = dataFiles[t.ext.location];
    if (!f) throw new Error('onnx_interp：缺少外部資料檔 ' + t.ext.location);
    const off = Number(t.ext.offset || 0), len = Number(t.ext.length);
    return f.subarray(off, off + len);
  }
  if (t.floats) return Uint8Array.from(new Uint8Array(Float32Array.from(t.floats).buffer));
  if (t.ints) return Uint8Array.from(new Uint8Array(Float64Array.from(t.ints).buffer));
  return new Uint8Array(0);
}
function tensorFromInit(m, t, dataFiles) {
  // 小的整數張量（例如量化的 zero point）常以 int32_data／int64_data 欄位存（t.ints），不是 raw：直接用，不能當成 raw 位元組讀
  if (!t.raw && !(t.ext && t.ext.location) && t.ints && [2, 3, 5, 6, 7].indexOf(t.dtype) >= 0) {
    const arr = t.dtype === 2 ? Uint8Array.from(t.ints, (x) => x & 255) : t.dtype === 3 ? Int8Array.from(t.ints, (x) => (x << 24) >> 24) : Float64Array.from(t.ints, (x) => (x >= 9223372036854775807 ? (x === TWO64 ? -1 : x - TWO64) : x));
    return { d: t.dims.slice(), t: 'i', v: arr };
  }
  const bytes = readInitBytes(m, t, dataFiles);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = numel(t.dims);
  if (t.dtype === 1) { const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = dv.getFloat32(i * 4, true); return { d: t.dims.slice(), t: 'f', v: v }; }
  if (t.dtype === 6) { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = dv.getInt32(i * 4, true); return { d: t.dims.slice(), t: 'i', v: v }; }
  if (t.dtype === 7) { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = Number(dv.getBigInt64(i * 8, true)); return { d: t.dims.slice(), t: 'i', v: v }; }
  if (t.dtype === 9) { const v = new Uint8Array(n); for (let i = 0; i < n; i++) v[i] = bytes[i] ? 1 : 0; return { d: t.dims.slice(), t: 'b', v: v }; }
  if (t.dtype === 2) return { d: t.dims.slice(), t: 'i', v: Uint8Array.from(bytes.subarray(0, n)) };   // 量化權重留成緊湊的型別陣列（不轉 Float64：幾百 MB 的權重會撐爆記憶體）
  if (t.dtype === 3) return { d: t.dims.slice(), t: 'i', v: new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n)) };
  if (t.dtype === 10) { const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = half(dv.getUint16(i * 2, true)); return { d: t.dims.slice(), t: 'f', v: v }; }
  throw new Error('onnx_interp：不支援的初始值 dtype ' + t.dtype + '（' + t.name + '）');
}
// Constant 節點的值 → 張量
function tensorFromConstant(m, node) {
  const c = lite.constantValue(m, node);
  const n = numel(c.dims);
  if (c.dtype === 1) return { d: c.dims.slice(), t: 'f', v: Float32Array.from(c.values || new Float32Array(n)) };
  if (c.dtype === 6 || c.dtype === 7) return { d: c.dims.slice(), t: 'i', v: Float64Array.from(c.values || []) };
  if (c.dtype === 9) return { d: c.dims.slice(), t: 'b', v: Uint8Array.from(c.values || []) };
  if (c.dtype === 10 && c.values && c.values.length === n * 2) { const dv = new DataView(c.values.buffer, c.values.byteOffset, c.values.byteLength), v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = half(dv.getUint16(i * 2, true)); return { d: c.dims.slice(), t: 'f', v }; }
  if (c.dtype === 11 && c.values && c.values.length === n * 8) { const dv = new DataView(c.values.buffer, c.values.byteOffset, c.values.byteLength), v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = dv.getFloat64(i * 8, true); return { d: c.dims.slice(), t: 'f', v }; }
  throw new Error('onnx_interp：不支援的常數 dtype ' + c.dtype);
}

function castTo(a, to) {
  if (to === 1) return { d: a.d.slice(), t: 'f', v: Float32Array.from(a.v) };
  if (to === 6 || to === 7) { const v = new Float64Array(a.v.length); for (let i = 0; i < v.length; i++) v[i] = Math.trunc(a.v[i]); return { d: a.d.slice(), t: 'i', v: v }; }
  if (to === 9) { const v = new Uint8Array(a.v.length); for (let i = 0; i < v.length; i++) v[i] = a.v[i] ? 1 : 0; return { d: a.d.slice(), t: 'b', v: v }; }
  throw new Error('onnx_interp：Cast 不支援的目標型別 ' + to);
}

function gatherOp(data, idx, axis) {
  const r = data.d.length; if (axis < 0) axis += r;
  const outer = numel(data.d.slice(0, axis)), K = data.d[axis], inner = numel(data.d.slice(axis + 1));
  const od = data.d.slice(0, axis).concat(idx.d, data.d.slice(axis + 1));
  const o = mk(od, data.t), ni = idx.v.length;
  for (let a = 0; a < outer; a++) for (let j = 0; j < ni; j++) {
    let ix = idx.v[j]; if (ix < 0) ix += K;
    for (let b = 0; b < inner; b++) o.v[(a * ni + j) * inner + b] = data.v[(a * K + ix) * inner + b];
  }
  return o;
}

function concatOp(ins, axis) {
  const r = ins[0].d.length; if (axis < 0) axis += r;
  const outer = numel(ins[0].d.slice(0, axis)), inner = numel(ins[0].d.slice(axis + 1));
  let total = 0; for (const x of ins) total += x.d[axis];
  const od = ins[0].d.slice(); od[axis] = total;
  const o = mk(od, ins[0].t);
  let off = 0;
  for (const x of ins) {
    const K = x.d[axis];
    for (let a = 0; a < outer; a++) for (let k = 0; k < K; k++) for (let b = 0; b < inner; b++)
      o.v[(a * total + off + k) * inner + b] = x.v[(a * K + k) * inner + b];
    off += K;
  }
  return o;
}

function transposeOp(a, perm) {
  const r = a.d.length; const p = perm || Array.from({ length: r }, (_, i) => r - 1 - i);
  const ist = strides(a.d);
  const od = p.map((i) => a.d[i]);
  const eff = p.map((i) => ist[i]);
  const map = mapFromEff(od, eff, 0);
  const o = mk(od, a.t);
  for (let k = 0; k < map.length; k++) o.v[k] = a.v[map[k]];
  return o;
}

function reshapeOp(a, shapeVals) {
  const sh = shapeVals.slice();
  for (let i = 0; i < sh.length; i++) if (sh[i] === 0) sh[i] = a.d[i];
  const neg = sh.indexOf(-1);
  if (neg >= 0) { let p = 1; for (let i = 0; i < sh.length; i++) if (i !== neg) p *= sh[i]; sh[neg] = numel(a.d) / p; }
  if (numel(sh) !== numel(a.d)) throw new Error('onnx_interp：Reshape 元素數不符 ' + JSON.stringify(a.d) + ' → ' + JSON.stringify(sh));
  return { d: sh, t: a.t, v: a.v };
}

function sliceOp(a, starts, ends, axes, steps) {
  const r = a.d.length;
  const st = new Array(r).fill(0), en = a.d.slice(), sp = new Array(r).fill(1);
  for (let i = 0; i < starts.length; i++) {
    let ax = axes ? axes[i] : i; if (ax < 0) ax += r;
    const K = a.d[ax], step = steps ? steps[i] : 1;
    let s = starts[i], e = ends[i];
    if (s < 0) s += K; if (e < 0) e += K;
    if (step > 0) { s = Math.min(Math.max(s, 0), K); e = Math.min(Math.max(e, 0), K); }
    else { s = Math.min(Math.max(s, -1), K - 1); e = Math.min(Math.max(e, -1), K - 1); }
    st[ax] = s; sp[ax] = step;
    en[ax] = Math.max(0, Math.ceil((e - s) / step));
  }
  const ist = strides(a.d);
  const od = en;
  const eff = od.map((_, i) => ist[i] * sp[i]);
  let base = 0; for (let i = 0; i < r; i++) base += st[i] * ist[i];
  const map = mapFromEff(od, eff, base);
  const o = mk(od, a.t);
  for (let k = 0; k < map.length; k++) o.v[k] = a.v[map[k]];
  return o;
}

function softmaxOp(a, axis) {
  const r = a.d.length; if (axis < 0) axis += r;
  const outer = numel(a.d.slice(0, axis)), K = a.d[axis], inner = numel(a.d.slice(axis + 1));
  const o = mk(a.d, 'f');
  for (let u = 0; u < outer; u++) for (let b = 0; b < inner; b++) {
    let mx = -Infinity;
    for (let k = 0; k < K; k++) { const x = a.v[(u * K + k) * inner + b]; if (x > mx) mx = x; }
    let s = 0;
    for (let k = 0; k < K; k++) { const e = Math.exp(a.v[(u * K + k) * inner + b] - mx); o.v[(u * K + k) * inner + b] = e; s += e; }
    for (let k = 0; k < K; k++) o.v[(u * K + k) * inner + b] /= s;
  }
  return o;
}

function layerNormOp(x, scale, bias, axis, eps) {
  const r = x.d.length; if (axis < 0) axis += r;
  const outer = numel(x.d.slice(0, axis)), M = numel(x.d.slice(axis));
  const o = mk(x.d, 'f');
  for (let u = 0; u < outer; u++) {
    let mean = 0; for (let j = 0; j < M; j++) mean += x.v[u * M + j]; mean /= M;
    let vr = 0; for (let j = 0; j < M; j++) { const dd = x.v[u * M + j] - mean; vr += dd * dd; } vr /= M;
    const inv = 1 / Math.sqrt(vr + eps);
    for (let j = 0; j < M; j++) {
      let y = (x.v[u * M + j] - mean) * inv;
      if (scale) y *= scale.v[j];
      if (bias) y += bias.v[j];
      o.v[u * M + j] = y;
    }
  }
  return o;
}

// 一維卷積（NCL 佈局）。W：[M, C/group, K]
function conv1dOp(x, w, b, attrs) {
  const N = x.d[0], C = x.d[1], L = x.d[2];
  const M = w.d[0], Cg = w.d[1], K = w.d[2];
  const strides1 = (attrs.strides ? attrs.strides[0] : 1);
  const dil = (attrs.dilations ? attrs.dilations[0] : 1);
  const pads = attrs.pads || [0, 0];
  const group = attrs.group || 1;
  const Lout = Math.floor((L + pads[0] + pads[1] - dil * (K - 1) - 1) / strides1) + 1;
  const o = mk([N, M, Lout], 'f');
  const Mg = M / group;
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) {
    const g = Math.floor(m / Mg);
    for (let t = 0; t < Lout; t++) {
      let acc = b ? b.v[m] : 0;
      for (let c = 0; c < Cg; c++) {
        const ic = g * Cg + c;
        for (let k = 0; k < K; k++) {
          const pos = t * strides1 - pads[0] + k * dil;
          if (pos < 0 || pos >= L) continue;
          acc += x.v[(n * C + ic) * L + pos] * w.v[(m * Cg + c) * K + k];
        }
      }
      o.v[(n * M + m) * Lout + t] = acc;
    }
  }
  return o;
}

// 矩陣乘（numpy 語意，批次維度廣播）
function matmulOp(a0, b0) {
  const a = a0.d.length === 1 ? { d: [1, a0.d[0]], v: a0.v } : a0;
  const b = b0.d.length === 1 ? { d: [b0.d[0], 1], v: b0.v } : b0;
  const M = a.d[a.d.length - 2], K = a.d[a.d.length - 1], N = b.d[b.d.length - 1];
  if (b.d[b.d.length - 2] !== K) throw new Error('onnx_interp：MatMul 維度不符');
  const ab = a.d.slice(0, -2), bb = b.d.slice(0, -2);
  const bd = bcast(ab, bb);
  const ma = numel(ab) === 0 ? [0] : bmap(bd, ab), mb = numel(bb) === 0 ? [0] : bmap(bd, bb);
  const nb = numel(bd);
  let od = bd.concat([M, N]);
  if (a0.d.length === 1) od = od.slice(0, -2).concat([N]);
  if (b0.d.length === 1) od = od.slice(0, -1);
  const o = mk(od, 'f');
  const acc = new Float64Array(N);
  for (let z = 0; z < nb; z++) {
    const ao = ma[z] * M * K, bo = mb[z] * K * N, oo = z * M * N;
    for (let i = 0; i < M; i++) {
      acc.fill(0);
      for (let k = 0; k < K; k++) {
        const av = a.v[ao + i * K + k];
        if (av === 0) continue;
        const bro = bo + k * N;
        for (let j = 0; j < N; j++) acc[j] += av * b.v[bro + j];
      }
      for (let j = 0; j < N; j++) o.v[oo + i * N + j] = acc[j];
    }
  }
  return o;
}

function rangeOp(s, l, dl) {
  const n = Math.max(0, Math.ceil((l.v[0] - s.v[0]) / dl.v[0]));
  const o = mk([n], s.t === 'f' ? 'f' : 'i');
  for (let i = 0; i < n; i++) o.v[i] = s.v[0] + i * dl.v[0];
  return o;
}

function constantOfShape(shapeT, valueT) {
  const d = Array.from(shapeT.v, (x) => x);
  const val = valueT || { t: 'f', v: Float32Array.from([0]) };
  const o = mk(d, val.t);
  o.v.fill(val.v[0]);
  return o;
}

// MatMul：ctx.gpu（{ ops }）有給且夠大才走 mm_ops（T1 WGSL → cpu-js）；其餘用 CPU 參考
async function matmulGpu(a, b, ctx) {
  if (!ctx.gpu || a.t !== 'f' || b.t !== 'f' || a.d.length < 2 || b.d.length < 2) return matmulOp(a, b);
  const M = a.d[a.d.length - 2], K = a.d[a.d.length - 1], N = b.d[b.d.length - 1];
  const B = numel(a.d.slice(0, -2)), Bb = numel(b.d.slice(0, -2));
  const sameLead = b.d.length === 2 || (a.d.length === b.d.length && a.d.slice(0, -2).every((x, i) => x === b.d[i]));
  if (B * M * K * N < (ctx.gpu.minMacs || 1 << 20) || !(Bb === 1 || (Bb === B && sameLead))) return matmulOp(a, b);
  // 派發：2 維的矩陣乘先問路由器（ops.route：釘選＞量測＞預設，見 floating-assistant.js 的 _gpuRouteOps）；選了 ORT 後端就用 ops.ortMatmul；
  // 失敗就這一次退回 cudaweb，並回報（ops.onRecord），不靜默。
  const ops0 = ctx.gpu.ops || {};
  if (typeof ops0.route === 'function' && a.d.length === 2 && b.d.length === 2) {
    const shape = M + 'x' + K + 'x' + N; let rt = null; try { rt = ops0.route('matmul', shape); } catch (_) { rt = null; }
    if (rt && rt.backend && rt.backend !== 'cudaweb' && typeof ops0.ortMatmul === 'function') {
      try { const y = await ops0.ortMatmul(rt.backend, M, K, N, a.v, b.v); if (ops0.onRecord) ops0.onRecord({ op: 'matmul', shape, backend: rt.backend, used: true, reason: rt.reason }); return { d: [M, N], t: 'f', v: y }; }
      catch (e) { if (ops0.onRecord) ops0.onRecord({ op: 'matmul', shape, backend: rt.backend, error: String((e && e.message) || e), fallback: 'cudaweb' }); }
    }
  }
  const r = await MM.matmul(a.v, a.d, b.v, b.d, ctx.gpu.ops || {}); MORE.rec(ctx, ctx.gpu.ops || {});
  return { d: r.dims, t: 'f', v: r.y };
}
const HELP = { mk, unop, binop, strides, numel, bcast, bmap, attrInt, attrF, attrInts };

async function execNode(node, ins, ctx) {
  const A = node.attrs;
  const op = node.op;
  const a = ins[0], b = ins[1];
  switch (op) {
    case 'Identity': return [a];
    case 'Constant': return [tensorFromConstant(ctx.model, node)];
    case 'Add': return [binop(a, b, (x, y) => x + y, arith(a, b))];
    case 'Sub': return [binop(a, b, (x, y) => x - y, arith(a, b))];
    case 'Mul': return [binop(a, b, (x, y) => x * y, arith(a, b))];
    case 'Div': return [binop(a, b, (x, y) => (arith(a, b) === 'i' ? Math.trunc(x / y) : x / y), arith(a, b))];
    case 'Mod': {
      const fmod = attrInt(A.fmod, 0) === 1;
      return [binop(a, b, (x, y) => (fmod ? x % y : (((x % y) + y) % y)), arith(a, b))];
    }
    case 'Pow': return [binop(a, b, (x, y) => Math.pow(x, y), arith(a, b))];
    case 'Equal': return [binop(a, b, (x, y) => (x === y ? 1 : 0), 'b')];
    case 'Less': return [binop(a, b, (x, y) => (x < y ? 1 : 0), 'b')];
    case 'LessOrEqual': return [binop(a, b, (x, y) => (x <= y ? 1 : 0), 'b')];
    case 'Greater': return [binop(a, b, (x, y) => (x > y ? 1 : 0), 'b')];
    case 'GreaterOrEqual': return [binop(a, b, (x, y) => (x >= y ? 1 : 0), 'b')];
    case 'And': return [binop(a, b, (x, y) => (x && y ? 1 : 0), 'b')];
    case 'Or': return [binop(a, b, (x, y) => (x || y ? 1 : 0), 'b')];
    case 'Xor': return [binop(a, b, (x, y) => ((!x) !== (!y) ? 1 : 0), 'b')];
    case 'Not': return [unop(a, (x) => (x ? 0 : 1), 'b')];
    case 'Where': {
      const c = ins[0], x = ins[1], y = ins[2];
      const od = bcast(bcast(c.d, x.d), y.d);
      const mc = bmap(od, c.d), mx = bmap(od, x.d), my = bmap(od, y.d);
      const o = mk(od, arith(x, y));
      for (let k = 0; k < o.v.length; k++) o.v[k] = c.v[mc[k]] ? x.v[mx[k]] : y.v[my[k]];
      return [o];
    }
    case 'Sqrt': return [unop(a, Math.sqrt, 'f')];
    case 'Exp': return [unop(a, Math.exp, 'f')];
    case 'Sin': return [unop(a, Math.sin, 'f')];
    case 'Cos': return [unop(a, Math.cos, 'f')];
    case 'Tanh': return [unop(a, Math.tanh, 'f')];
    case 'Erf': return [unop(a, erf, 'f')];
    case 'Reciprocal': return [unop(a, (x) => 1 / x, 'f')];
    case 'Neg': return [unop(a, (x) => -x, a.t)];
    case 'Cast': return [castTo(a, attrInt(A.to, 1))];
    case 'Shape': return [{ d: [a.d.length], t: 'i', v: Float64Array.from(a.d) }];
    case 'Gather': return [gatherOp(a, b, attrInt(A.axis, 0))];
    case 'Concat': return [concatOp(ins, attrInt(A.axis, 0))];
    case 'Transpose': return [transposeOp(a, attrInts(A.perm))];
    case 'Reshape': return [reshapeOp(a, Array.from(b.v, (x) => x))];
    case 'Unsqueeze': {
      const axes = ins.length > 1 ? Array.from(b.v) : attrInts(A.axes);
      const r = a.d.length + axes.length;
      const norm = axes.map((x) => (x < 0 ? x + r : x)).sort((p, q) => p - q);
      const d = []; let j = 0;
      for (let i = 0; i < r; i++) { if (norm.includes(i)) d.push(1); else d.push(a.d[j++]); }
      return [{ d: d, t: a.t, v: a.v }];
    }
    case 'Squeeze': {
      const axes = ins.length > 1 ? Array.from(b.v) : attrInts(A.axes);
      const r = a.d.length;
      const norm = axes ? axes.map((x) => (x < 0 ? x + r : x)) : a.d.map((x, i) => (x === 1 ? i : -1)).filter((i) => i >= 0);
      return [{ d: a.d.filter((x, i) => !norm.includes(i)), t: a.t, v: a.v }];
    }
    case 'Slice': {
      const starts = Array.from(b.v), ends = Array.from(ins[2].v);
      const axes = ins.length > 3 && ins[3] ? Array.from(ins[3].v) : null;
      const steps = ins.length > 4 && ins[4] ? Array.from(ins[4].v) : null;
      const clampEnd = ends.map((e) => (e > 9e18 ? Number.MAX_SAFE_INTEGER : (e < -9e18 ? -Number.MAX_SAFE_INTEGER : e)));
      return [sliceOp(a, starts, clampEnd, axes, steps)];
    }
    case 'ConstantOfShape': {
      const val = A.value && A.value.tensor ? tensorFromConstant(ctx.model, node) : null;
      return [constantOfShape(a, val)];
    }
    case 'Range': return [rangeOp(a, b, ins[2])];
    case 'Softmax': return [softmaxOp(a, attrInt(A.axis, -1))];
    case 'LayerNormalization': return [layerNormOp(a, b, ins[2], attrInt(A.axis, -1), attrF(A.epsilon, 1e-5))];
    case 'Conv': {
      if (a.d.length === 4) return MORE.conv2d(node, ins, ctx, HELP);
      const attrs = {
        strides: attrInts(A.strides), dilations: attrInts(A.dilations), pads: attrInts(A.pads), group: attrInt(A.group, 1),
      };
      const N = a.d[0], C = a.d[1], L = a.d[2], M = b.d[0], Cg = b.d[1], K = b.d[2];
      const pr = { stride: attrs.strides ? attrs.strides[0] : 1, pads: attrs.pads || [0, 0], dilation: attrs.dilations ? attrs.dilations[0] : 1, groups: attrs.group };
      const yv = await CONV.conv1d(a.v, N, C, L, b.v, M, Cg, K, ins[2] ? ins[2].v : null, pr, ctx.gpu ? ctx.gpu.ops : ctx.convOps); if (ctx.gpu) MORE.rec(ctx, ctx.gpu.ops);
      const Lout = Math.floor((L + pr.pads[0] + pr.pads[1] - pr.dilation * (K - 1) - 1) / pr.stride) + 1;
      return [{ d: [N, M, Lout], t: 'f', v: yv }];
    }
    case 'MatMul': return [await matmulGpu(a, b, ctx)];
    case 'Clip': {
      const lo = ins[1] ? ins[1].v[0] : -Infinity, hi = ins[2] ? ins[2].v[0] : Infinity;
      return [unop(a, (x) => Math.min(Math.max(x, lo), hi), a.t)];
    }
    case 'If': {
      const branch = a.v[0] ? A.then_branch : A.else_branch;
      if (!branch || !branch.graph) throw new Error('onnx_interp：If 缺少分支');
      const sub = lite.parseGraph(ctx.model.buf, branch.graph);
      const env = Object.create(ctx.env);
      await runNodes(sub.nodes, env, ctx);
      return sub.outputs.map((name) => lookup(env, name, ctx));
    }
    default: {
      const r = await MORE.exec(node, ins, ctx, HELP);
      if (r) return r;
      throw new Error('onnx_interp：未實作的算子 ' + op + '（' + node.name + '）');
    }
  }
}

function lookup(env, name, ctx) {
  if (name === '') return null;
  let e = env;
  while (e) {
    if (Object.prototype.hasOwnProperty.call(e, name)) return e[name];
    e = Object.getPrototypeOf(e);
    if (e === Object.prototype) break;
  }
  if (ctx.inits[name] === undefined) {
    const t = ctx.model.inits[name];
    if (!t) throw new Error('onnx_interp：找不到張量 ' + name);
    ctx.inits[name] = tensorFromInit(ctx.model, t, ctx.dataFiles);
  }
  return ctx.inits[name];
}

async function runNodes(nodes, env, ctx, freeAfter) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const ins = node.inputs.map((nm) => (nm === '' ? null : lookup(env, nm, ctx)));
    // 量測鉤子（預設關）：globalThis.__FA_OP_TIMING 有值時，依運算類型累計次數與毫秒；沒設就不碰計時，正常路徑不變
    const tm = (typeof globalThis !== 'undefined') ? globalThis.__FA_OP_TIMING : undefined, t0 = tm ? Date.now() : 0;
    const outs = await execNode(node, ins, ctx);
    if (tm) { const k = node.op; const r = tm[k] || (tm[k] = { n: 0, ms: 0 }); r.n++; r.ms += Date.now() - t0; }
    for (let i = 0; i < node.outputs.length; i++) if (node.outputs[i] !== '') env[node.outputs[i]] = outs[i];
    if (ctx.capture) ctx.capture(node, outs);
    if (freeAfter && freeAfter[ni]) for (const nm of freeAfter[ni]) delete env[nm];   // 最後一次用過的中間張量立刻釋放（大圖不然會把每個節點的輸出都留在記憶體裡）
  }
}
// 每個節點之後可以釋放哪些中間張量（最後一次被讀取的位置；模型輸出與初始值不釋放；圖裡有 If 子圖會引用外層名稱，就不做）
function planFree(model) {
  if (model.nodes.some((n) => n.op === 'If' || n.op === 'Loop' || n.op === 'Scan')) return null;
  const last = new Map(), keep = new Set(model.outputs); model.nodes.forEach((n, i) => { for (const nm of n.inputs) if (nm !== '') last.set(nm, i); });
  const produced = new Set(); for (const n of model.nodes) for (const o of n.outputs) if (o !== '') produced.add(o);
  const plan = new Array(model.nodes.length).fill(null);
  for (const [nm, i] of last) if (produced.has(nm) && !keep.has(nm)) (plan[i] = plan[i] || []).push(nm);
  return plan;
}

// 執行整個圖。model = lite.parseModel(buf)；feeds：{輸入名: 張量}；dataFiles：{檔名: Uint8Array}
// 回傳 { 輸出名: 張量 }（只含 model.outputs）
async function run(model, feeds, dataFiles, opts) {
  const env = Object.create(null);
  for (const k of Object.keys(feeds)) env[k] = feeds[k];
  const ctx = { model: model, inits: (opts && opts.initCache) || Object.create(null), dataFiles: dataFiles || {}, env: env, gpu: (opts && opts.gpu) || null, matmul: matmulGpu, capture: (opts && opts.capture) || null };
  await runNodes(model.nodes, env, ctx, (opts && opts.capture) ? null : planFree(model));
  const out = {};
  for (const name of model.outputs) out[name] = lookup(env, name, ctx);
  return out;
}

module.exports = { HELP, run, numel, mapFromEff, bmap, matmulOp, matmulGpu, erf, conv1dOp, layerNormOp, softmaxOp, tensorFromInit, lookup };
