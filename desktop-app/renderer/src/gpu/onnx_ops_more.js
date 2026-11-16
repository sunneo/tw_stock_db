'use strict';
// onnx_interp 的補充算子（YAMNet、之後的 Demucs／SDXS／Kokoro 共用）：逐元素、Pad、Split、規約、Expand、Tile、InstanceNormalization、全域平均池化、二維卷積／轉置卷積（GPU）。
// exec(node, ins, ctx, H) → 輸出張量陣列；不認得的算子回傳 undefined（由 onnx_interp 丟「未實作」）。H 是 onnx_interp 的小工具（mk、unop、binop、strides、numel、attr*）。
// 張量格式同 onnx_interp：{ d, t:'f'|'i'|'b', v }。
const CONV = require('./conv_ops.js');
const MM = require('./mm_ops.js');
const INF = require('./infer_ops.js');
const f32 = Math.fround;

// 記錄這次重運算實際跑在哪一層（T1／cpu-js…），整張圖結束後由 graph_session 回報
function rec(ctx, O) { if (ctx.gpu && ctx.gpu.tiers) { const l = (O.lastInfo && O.lastInfo.layer) || '?'; ctx.gpu.tiers[l] = (ctx.gpu.tiers[l] || 0) + 1; } }
function normAxes(axes, r) { return axes.map((a) => (a < 0 ? a + r : a)); }
function reduceAxes(node, ins, H, r) {
  const A = node.attrs; let ax = ins[1] ? Array.from(ins[1].v) : H.attrInts(A.axes);
  const keep = H.attrInt(A.keepdims, 1);
  if (!ax || !ax.length) ax = Array.from({ length: r }, (_, i) => i);
  return { axes: normAxes(ax, r), keep };
}
// 沿 axes 規約：fn(acc, x)、init、fin(acc, count)
function reduceOp(a, axes, keep, init, step, fin, H) {
  const r = a.d.length, isRed = a.d.map((_, i) => axes.indexOf(i) >= 0);
  const od = a.d.map((x, i) => (isRed[i] ? 1 : x)), outD = keep ? od : a.d.filter((_, i) => !isRed[i]);
  const on = H.numel(od), acc = new Float64Array(on).fill(init), cnt = H.numel(a.d.filter((_, i) => isRed[i]));
  const ost = H.strides(od), ist = H.strides(a.d), n = a.v.length;
  for (let k = 0; k < n; k++) { let rem = k, oi = 0; for (let i = 0; i < r; i++) { const c = Math.floor(rem / ist[i]); rem -= c * ist[i]; if (!isRed[i]) oi += c * ost[i]; } acc[oi] = step(acc[oi], a.v[k]); }
  const o = H.mk(outD, a.t === 'f' ? 'f' : 'i'); for (let i = 0; i < on; i++) o.v[i] = fin(acc[i], cnt);
  return o;
}
function padOp(a, pads, cv, mode, H) {
  const r = a.d.length, od = a.d.map((x, i) => x + pads[i] + pads[i + r]);
  const o = H.mk(od, a.t), ost = H.strides(od), ist = H.strides(a.d), n = H.numel(od);
  if (mode === 'constant') o.v.fill(cv);
  for (let k = 0; k < n; k++) {
    let rem = k, ai = 0, inside = true;
    for (let i = 0; i < r; i++) {
      const c = Math.floor(rem / ost[i]); rem -= c * ost[i]; let s = c - pads[i];
      if (s < 0 || s >= a.d[i]) {
        if (mode === 'constant') { inside = false; break; }
        if (mode === 'edge') s = Math.min(Math.max(s, 0), a.d[i] - 1);
        else if (mode === 'reflect') { const P = 2 * (a.d[i] - 1); if (P > 0) { s = ((s % P) + P) % P; if (s >= a.d[i]) s = P - s; } else s = 0; }
        else throw new Error('Pad：不支援的模式 ' + mode);
      }
      ai += s * ist[i];
    }
    if (inside) o.v[k] = a.v[ai];
  }
  return o;
}
function expandOp(a, shape, H) {
  const od = H.bcast(a.d, shape); const map = H.bmap(od, a.d), o = H.mk(od, a.t);
  for (let k = 0; k < map.length; k++) o.v[k] = a.v[map[k]];
  return o;
}
function tileOp(a, reps, H) {
  const r = a.d.length, od = a.d.map((x, i) => x * reps[i]), o = H.mk(od, a.t), ost = H.strides(od), ist = H.strides(a.d), n = H.numel(od);
  for (let k = 0; k < n; k++) { let rem = k, ai = 0; for (let i = 0; i < r; i++) { const c = Math.floor(rem / ost[i]); rem -= c * ost[i]; ai += (c % a.d[i]) * ist[i]; } o.v[k] = a.v[ai]; }
  return o;
}
function splitOp(a, axis, sizes, H) {
  const r = a.d.length; if (axis < 0) axis += r;
  const outer = H.numel(a.d.slice(0, axis)), K = a.d[axis], inner = H.numel(a.d.slice(axis + 1)), outs = []; let off = 0;
  for (const s of sizes) {
    const d = a.d.slice(); d[axis] = s; const o = H.mk(d, a.t);
    for (let x = 0; x < outer; x++) for (let k = 0; k < s; k++) for (let y = 0; y < inner; y++) o.v[(x * s + k) * inner + y] = a.v[(x * K + off + k) * inner + y];
    outs.push(o); off += s;
  }
  return outs;
}
function instNorm(x, sc, bi, eps, H) {
  const N = x.d[0], C = x.d[1], S = H.numel(x.d.slice(2)), o = H.mk(x.d, 'f');
  for (let n = 0; n < N; n++) for (let c = 0; c < C; c++) {
    const b = (n * C + c) * S; let m = 0; for (let i = 0; i < S; i++) m += x.v[b + i]; m /= S;
    let v = 0; for (let i = 0; i < S; i++) { const d = x.v[b + i] - m; v += d * d; } v /= S;
    const g = sc.v[c] / Math.sqrt(v + eps), be = bi.v[c];
    for (let i = 0; i < S; i++) o.v[b + i] = (x.v[b + i] - m) * g + be;
  }
  return o;
}
// 重運算走 GPU（conv_ops／mm_ops：T1 WGSL → cpu-js）；ctx.gpu：{ ops }，ops.gpu===false 強制 CPU。
async function conv2d(node, ins, ctx, H) {
  const [x, w, b] = ins, A = node.attrs, g = H.attrInt(A.group, 1), O = (ctx.gpu && ctx.gpu.ops) || {};
  const p = { strides: H.attrInts(A.strides) || [1, 1], dilations: H.attrInts(A.dilations) || [1, 1], pads: H.attrInts(A.pads) || [0, 0, 0, 0], groups: g };
  const [N, C, Hh, W] = x.d, [M, Cg, KH, KW] = w.d;
  const y = await CONV.conv2d(x.v, N, C, Hh, W, w.v, M, Cg, KH, KW, b ? b.v : null, p, O), q = CONV.norm2(p); rec(ctx, O);
  return [{ d: [N, M, Math.floor((Hh + q.pt + q.pb - q.dh * (KH - 1) - 1) / q.sh) + 1, Math.floor((W + q.pl + q.pr - q.dw * (KW - 1) - 1) / q.sw) + 1], t: 'f', v: y }];
}
async function convT(node, ins, ctx, H) {
  const [x, w, b] = ins, A = node.attrs, g = H.attrInt(A.group, 1), O = (ctx.gpu && ctx.gpu.ops) || {};
  let N, C, Hh, W, KH, KW, p;
  if (x.d.length === 3) { [N, C, W] = x.d; Hh = 1; KH = 1; KW = w.d[2]; const pd = H.attrInts(A.pads) || [0, 0]; p = { strides: [1, (H.attrInts(A.strides) || [1])[0]], pads: [0, pd[0], 0, pd[1]], dilations: [1, (H.attrInts(A.dilations) || [1])[0]], groups: g, outputPadding: [0, (H.attrInts(A.output_padding) || [0])[0]] }; }
  else { [N, C, Hh, W] = x.d; KH = w.d[2]; KW = w.d[3]; p = { strides: H.attrInts(A.strides) || [1, 1], pads: H.attrInts(A.pads) || [0, 0, 0, 0], dilations: H.attrInts(A.dilations) || [1, 1], groups: g, outputPadding: H.attrInts(A.output_padding) || [0, 0] }; }
  const M = w.d[1] * g, d = CONV.convT2dDims(Hh, W, KH, KW, p), y = await CONV.convT2d(x.v, N, C, Hh, W, w.v, M, KH, KW, b ? b.v : null, p, O); rec(ctx, O);
  return [{ d: x.d.length === 3 ? [N, M, d.Wout] : [N, M, d.Hout, d.Wout], t: 'f', v: y }];
}

// ---- 量化／Resize／Trilu ----
function resizeOp(x, scalesT, sizesT, mode, coord, H) {
  const r = x.d.length; let od;
  if (sizesT && sizesT.v.length) od = Array.from(sizesT.v); else od = x.d.map((d, i) => Math.floor(d * scalesT.v[i] + 1e-6));
  const sc = od.map((o, i) => (sizesT && sizesT.v.length ? o / x.d[i] : scalesT.v[i]));
  const o = H.mk(od, 'f'), ost = H.strides(od), ist = H.strides(x.d), n = H.numel(od);
  const src = (c, i) => { // 輸出座標 → 輸入浮點座標
    if (coord === 'asymmetric') return c / sc[i];
    if (coord === 'half_pixel') return (c + 0.5) / sc[i] - 0.5;
    if (coord === 'align_corners') return od[i] === 1 ? 0 : c * (x.d[i] - 1) / (od[i] - 1);
    throw new Error('Resize：不支援的 coordinate_transformation_mode ' + coord);
  };
  if (mode === 'nearest') {
    for (let k = 0; k < n; k++) { let rem = k, ai = 0; for (let i = 0; i < r; i++) { const c = Math.floor(rem / ost[i]); rem -= c * ost[i]; ai += Math.min(Math.max(Math.floor(src(c, i)), 0), x.d[i] - 1) * ist[i]; } o.v[k] = x.v[ai]; }
    return o;
  }
  if (mode === 'linear') {
    for (let k = 0; k < n; k++) {
      let rem = k; let acc = 0; const cs = [];
      for (let i = 0; i < r; i++) { const c = Math.floor(rem / ost[i]); rem -= c * ost[i]; cs.push(c); }
      // 對每個維度取左右兩點與權重，做 2^r 組合（r 小；只有被縮放的維度才展開）
      let terms = [{ off: 0, w: 1 }];
      for (let i = 0; i < r; i++) {
        if (sc[i] === 1 && od[i] === x.d[i]) { terms = terms.map((t) => ({ off: t.off + cs[i] * ist[i], w: t.w })); continue; }
        const f = src(cs[i], i), f0 = Math.floor(f), w1 = f - f0, a0 = Math.min(Math.max(f0, 0), x.d[i] - 1), a1 = Math.min(Math.max(f0 + 1, 0), x.d[i] - 1), nt = [];
        for (const t of terms) { nt.push({ off: t.off + a0 * ist[i], w: t.w * (1 - w1) }); nt.push({ off: t.off + a1 * ist[i], w: t.w * w1 }); }
        terms = nt;
      }
      for (const t of terms) acc += t.w * x.v[t.off];
      o.v[k] = acc;
    }
    return o;
  }
  throw new Error('Resize：不支援的 mode ' + mode);
}
function triluOp(a, k, upper, H) {
  const o = H.mk(a.d, a.t), R = a.d[a.d.length - 2], C = a.d[a.d.length - 1], B = a.v.length / (R * C);
  for (let b = 0; b < B; b++) for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { const keep = upper ? (j - i >= k) : (j - i <= k); o.v[(b * R + i) * C + j] = keep ? a.v[(b * R + i) * C + j] : 0; }
  return o;
}

// ---- Kokoro 用：LSTM（量化權重解成浮點）、STFT、CumSum、NonZero、FastGelu、SkipLayerNormalization、FusedMatMul ----
// DynamicQuantizeLSTM（com.microsoft）：權重 int8、版面 [方向, 輸入, 4H]（MLAS 版面，和 ONNX LSTM 的 [方向, 4H, 輸入] 轉置），閘順序 iofc；
// 這裡把權重用 scale／zero point 解成浮點後做浮點 LSTM，不重現 ORT 對輸入與隱藏狀態的逐步動態量化（所以與 ORT 有量化等級的差，見 DESIGN §7.27）。
function lstmOp(ins, A, H) {
  const [X, Wq, Rq, B, , h0, c0] = ins, wS = ins[8], wZ = ins[9], rS = ins[10], rZ = ins[11];
  const hid = H.attrInt(A.hidden_size, 0), dirS = (A.direction && A.direction.s) || 'forward', nd = Wq.d[0], seq = X.d[0], bs = X.d[1], inp = X.d[2], G = 4 * hid;
  if (Wq.d[1] !== inp || Wq.d[2] !== G) throw new Error('DynamicQuantizeLSTM：權重版面不是 [方向,輸入,4H]：' + JSON.stringify(Wq.d));
  const Y = H.mk([seq, nd, bs, hid], 'f'), Yh = H.mk([nd, bs, hid], 'f'), Yc = H.mk([nd, bs, hid], 'f');
  const sg = (x) => 1 / (1 + Math.exp(-x));
  for (let d = 0; d < nd; d++) {
    const ws = wS.v[wS.v.length === nd ? d : 0], wz = wZ.v[wZ.v.length === nd ? d : 0], rs = rS.v[rS.v.length === nd ? d : 0], rz = rZ.v[rZ.v.length === nd ? d : 0];
    const W = new Float32Array(inp * G), R = new Float32Array(hid * G); for (let i = 0; i < W.length; i++) W[i] = (Wq.v[d * inp * G + i] - wz) * ws; for (let i = 0; i < R.length; i++) R[i] = (Rq.v[d * hid * G + i] - rz) * rs;
    const bias = new Float32Array(G); if (B) for (let g = 0; g < G; g++) bias[g] = B.v[d * 2 * G + g] + B.v[d * 2 * G + G + g];
    const rev = dirS === 'reverse' || (dirS === 'bidirectional' && d === 1);
    for (let b = 0; b < bs; b++) {
      const h = new Float64Array(hid), c = new Float64Array(hid); if (h0) for (let k = 0; k < hid; k++) h[k] = h0.v[(d * bs + b) * hid + k]; if (c0) for (let k = 0; k < hid; k++) c[k] = c0.v[(d * bs + b) * hid + k];
      const g = new Float64Array(G);
      for (let step = 0; step < seq; step++) {
        const t = rev ? seq - 1 - step : step; for (let q = 0; q < G; q++) g[q] = bias[q];
        const xo = (t * bs + b) * inp; for (let i = 0; i < inp; i++) { const xv = X.v[xo + i]; if (xv !== 0) { const wo = i * G; for (let q = 0; q < G; q++) g[q] += xv * W[wo + q]; } }
        for (let k = 0; k < hid; k++) { const hv = h[k]; if (hv !== 0) { const ro = k * G; for (let q = 0; q < G; q++) g[q] += hv * R[ro + q]; } }
        for (let k = 0; k < hid; k++) { const i_ = sg(g[k]), o_ = sg(g[hid + k]), f_ = sg(g[2 * hid + k]), cc = Math.tanh(g[3 * hid + k]); c[k] = f_ * c[k] + i_ * cc; h[k] = o_ * Math.tanh(c[k]); Y.v[((t * nd + d) * bs + b) * hid + k] = h[k]; }
      }
      for (let k = 0; k < hid; k++) { Yh.v[(d * bs + b) * hid + k] = h[k]; Yc.v[(d * bs + b) * hid + k] = c[k]; }
    }
  }
  return [Y, Yh, Yc];
}
function stftOp(sig, stepT, win, frameLenT, H) {
  const B = sig.d[0], L = sig.d[1], step = stepT.v[0], fl = frameLenT ? frameLenT.v[0] : win.v.length, bins = (fl >> 1) + 1, nf = Math.floor((L - fl) / step) + 1;
  const o = H.mk([B, nf, bins, 2], 'f'); const cs = new Float64Array(fl * bins), sn = new Float64Array(fl * bins);
  for (let k = 0; k < bins; k++) for (let n = 0; n < fl; n++) { const a = -2 * Math.PI * k * n / fl; cs[k * fl + n] = Math.cos(a); sn[k * fl + n] = Math.sin(a); }
  for (let b = 0; b < B; b++) for (let f = 0; f < nf; f++) { const fr = new Float64Array(fl); for (let n = 0; n < fl; n++) fr[n] = sig.v[(b * L + f * step + n) * (sig.d[2] || 1)] * (win ? win.v[n] : 1);
    for (let k = 0; k < bins; k++) { let re = 0, im = 0; for (let n = 0; n < fl; n++) { re += fr[n] * cs[k * fl + n]; im += fr[n] * sn[k * fl + n]; } const oo = ((b * nf + f) * bins + k) * 2; o.v[oo] = re; o.v[oo + 1] = im; } }
  return o;
}
function cumsumOp(a, axis, excl, rev, H) {
  const r = a.d.length, ax = axis < 0 ? axis + r : axis, outer = H.numel(a.d.slice(0, ax)), K = a.d[ax], inner = H.numel(a.d.slice(ax + 1)), o = H.mk(a.d, a.t);
  for (let x = 0; x < outer; x++) for (let y = 0; y < inner; y++) { let acc = 0; for (let q = 0; q < K; q++) { const k = rev ? K - 1 - q : q, ix = (x * K + k) * inner + y; if (excl) { o.v[ix] = acc; acc += a.v[ix]; } else { acc += a.v[ix]; o.v[ix] = acc; } } }
  return o;
}
function nonZeroOp(a, H) {
  const r = a.d.length, st = H.strides(a.d), idx = []; for (let i = 0; i < a.v.length; i++) if (a.v[i]) idx.push(i);
  const o = H.mk([r, idx.length], 'i'); for (let q = 0; q < idx.length; q++) { let rem = idx[q]; for (let d = 0; d < r; d++) { const c = Math.floor(rem / st[d]); rem -= c * st[d]; o.v[d * idx.length + q] = c; } }
  return o;
}
function transLast(a, H) { const r = a.d.length, R = a.d[r - 2], C = a.d[r - 1], B = a.v.length / (R * C), o = H.mk(a.d.slice(0, -2).concat([C, R]), a.t); for (let b = 0; b < B; b++) for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) o.v[(b * C + j) * R + i] = a.v[(b * R + i) * C + j]; return o; }
// 整數矩陣乘：權重元素不多才送 GPU（i32 緩衝區是 4 位元組／元素，且每次呼叫都要上傳）；太大的權重用精確的 CPU 整數參考（結果與 GPU 逐位相同）
async function matmulInteger(ins, ctx, H) {
  const [a, b] = ins, O = (ctx.gpu && ctx.gpu.ops) || {}, azp = ins[2] ? ins[2].v[0] : 0, bzp = ins[3] ? ins[3].v[0] : 0;
  const lim = (ctx.gpu && ctx.gpu.maxIntWeightElems) || (8 << 20);
  const useGpu = ctx.gpu && b.v.length <= lim && a.v.length <= lim;
  const r = useGpu ? await MM.matmulInt(a.v, a.d, b.v, b.d, azp, bzp, O) : MM.matmulIntRef(a.v, a.d, b.v, b.d, azp, bzp);
  if (useGpu) rec(ctx, O); else if (ctx.gpu && ctx.gpu.tiers) ctx.gpu.tiers['cpu-int（權重大）'] = (ctx.gpu.tiers['cpu-int（權重大）'] || 0) + 1;
  return [{ d: r.dims, t: 'i', v: Float64Array.from(r.y) }];
}
async function convInteger(node, ins, ctx, H) {
  const [x, w] = ins, A = node.attrs, O = (ctx.gpu && ctx.gpu.ops) || {};
  if (x.d.length !== 3) throw new Error('ConvInteger：只支援一維');
  const [N, C, L] = x.d, [M, Cg, K] = w.d, pads = H.attrInts(A.pads) || [0, 0], st = (H.attrInts(A.strides) || [1])[0], dl = (H.attrInts(A.dilations) || [1])[0];
  const y = await CONV.convInt1d(x.v, N, C, L, w.v, M, Cg, K, ins[2] ? ins[2].v[0] : 0, ins[3] ? ins[3].v[0] : 0, { stride: st, pads, dilation: dl, groups: H.attrInt(A.group, 1) }, O); rec(ctx, O);
  return [{ d: [N, M, Math.floor((L + pads[0] + pads[1] - dl * (K - 1) - 1) / st) + 1], t: 'i', v: Float64Array.from(y) }];
}
function scatterND(data, idx, upd, H) {
  const o = H.mk(data.d, data.t); o.v.set(data.v);
  const r = data.d.length, k = idx.d[idx.d.length - 1], nIdx = idx.v.length / k, st = H.strides(data.d), inner = H.numel(data.d.slice(k));
  for (let i = 0; i < nIdx; i++) {
    let off = 0; for (let j = 0; j < k; j++) { let c = idx.v[i * k + j]; if (c < 0) c += data.d[j]; off += c * st[j]; }
    for (let q = 0; q < inner; q++) o.v[off + q] = upd.v[i * inner + q];
  }
  return o;
}
async function exec(node, ins, ctx, H) {
  const A = node.attrs, a = ins[0], b = ins[1];
  switch (node.op) {
    case 'Relu': return [H.unop(a, (x) => (x > 0 ? x : 0), 'f')];
    case 'LeakyRelu': { const al = H.attrF(A.alpha, 0.01); return [H.unop(a, (x) => (x >= 0 ? x : x * al), 'f')]; }
    case 'Sigmoid': return [H.unop(a, (x) => 1 / (1 + Math.exp(-x)), 'f')];
    case 'Log': return [H.unop(a, Math.log, 'f')];
    case 'Ceil': return [H.unop(a, Math.ceil, a.t)];
    case 'Floor': return [H.unop(a, Math.floor, a.t)];
    case 'Round': return [H.unop(a, (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }, a.t)];
    case 'Atan': return [H.unop(a, Math.atan, 'f')];
    case 'Abs': return [H.unop(a, Math.abs, a.t)];
    case 'Max': return [ins.reduce((x, y) => H.binop(x, y, (p, q) => (p > q ? p : q), x.t === 'f' || y.t === 'f' ? 'f' : x.t))];
    case 'Min': return [ins.reduce((x, y) => H.binop(x, y, (p, q) => (p < q ? p : q), x.t === 'f' || y.t === 'f' ? 'f' : x.t))];
    case 'Pad': {
      const modeS = (A.mode && A.mode.s) || 'constant';
      if (ins[3]) throw new Error('Pad：axes 輸入未支援');
      return [padOp(a, Array.from(b.v), ins[2] ? ins[2].v[0] : 0, String(modeS), H)];
    }
    case 'Split': {
      const axis = H.attrInt(A.axis, 0), r = a.d.length, ax = axis < 0 ? axis + r : axis; let sizes = ins[1] ? Array.from(ins[1].v) : H.attrInts(A.split);
      if (!sizes) { const n = node.outputs.length, s = a.d[ax] / n; sizes = new Array(n).fill(s); }
      return splitOp(a, axis, sizes, H);
    }
    case 'GlobalAveragePool': { const ax = []; for (let i = 2; i < a.d.length; i++) ax.push(i); return [reduceOp(a, ax, true, 0, (s, x) => s + x, (s, n) => s / n, H)]; }
    case 'ReduceMean': { const { axes, keep } = reduceAxes(node, ins, H, a.d.length); return [reduceOp(a, axes, keep, 0, (s, x) => s + x, (s, n) => s / n, H)]; }
    case 'ReduceSum': { const { axes, keep } = reduceAxes(node, ins, H, a.d.length); return [reduceOp(a, axes, keep, 0, (s, x) => s + x, (s) => s, H)]; }
    case 'ReduceMax': { const { axes, keep } = reduceAxes(node, ins, H, a.d.length); return [reduceOp(a, axes, keep, -Infinity, (s, x) => (x > s ? x : s), (s) => s, H)]; }
    case 'ReduceMin': { const { axes, keep } = reduceAxes(node, ins, H, a.d.length); return [reduceOp(a, axes, keep, Infinity, (s, x) => (x < s ? x : s), (s) => s, H)]; }
    case 'ReduceProd': { const { axes, keep } = reduceAxes(node, ins, H, a.d.length); return [reduceOp(a, axes, keep, 1, (s, x) => s * x, (s) => s, H)]; }
    case 'Expand': return [expandOp(a, Array.from(b.v), H)];
    case 'Tile': return [tileOp(a, Array.from(b.v), H)];
    case 'InstanceNormalization': return [instNorm(a, b, ins[2], H.attrF(A.epsilon, 1e-5), H)];
    case 'ConvTranspose': return convT(node, ins, ctx, H);
    case 'Resize': { const md = (A.mode && A.mode.s) || 'nearest', cd = (A.coordinate_transformation_mode && A.coordinate_transformation_mode.s) || 'half_pixel'; return [resizeOp(a, ins[2], ins[3], md, cd, H)]; }
    case 'Trilu': return [triluOp(a, ins[1] ? ins[1].v[0] : 0, H.attrInt(A.upper, 1), H)];
    case 'DynamicQuantizeLinear': { const q = INF.quantizeDynamicRef(a.v); return [{ d: a.d.slice(), t: 'i', v: Float64Array.from(q.q) }, { d: [], t: 'f', v: Float32Array.of(q.scale) }, { d: [], t: 'i', v: Float64Array.of(q.zp) }]; }
    case 'DequantizeLinear': {
      const o = H.mk(a.d, 'f'), ax = H.attrInt(A.axis, 1);
      if (b.v.length === 1) { const zp = ins[2] ? ins[2].v[0] : 0, sc = b.v[0]; for (let i = 0; i < a.v.length; i++) o.v[i] = (a.v[i] - zp) * sc; return [o]; }
      const r = a.d.length, axx = ax < 0 ? ax + r : ax, inner = H.numel(a.d.slice(axx + 1)), K = a.d[axx];
      for (let i = 0; i < a.v.length; i++) { const c = Math.floor(i / inner) % K; o.v[i] = (a.v[i] - (ins[2] ? ins[2].v[c] : 0)) * b.v[c]; }
      return [o];
    }
    case 'ScatterND': return [scatterND(a, b, ins[2], H)];
    case 'DynamicQuantizeLSTM': return lstmOp(ins, A, H);
    case 'STFT': return [stftOp(a, b, ins[2], ins[3], H)];
    case 'CumSum': return [cumsumOp(a, b.v[0], H.attrInt(A.exclusive, 0), H.attrInt(A.reverse, 0), H)];
    case 'NonZero': return [nonZeroOp(a, H)];
    case 'FastGelu': { const bi = b ? b.v : null, src = bi ? { d: a.d, t: 'f', v: Float32Array.from(a.v, (x, i) => x + bi[i % bi.length]) } : a; return [H.unop(src, (x) => 0.5 * x * (1 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x))), 'f')]; }
    case 'SkipLayerNormalization': {
      const D = a.d[a.d.length - 1], n = a.v.length / D, eps = H.attrF(A.epsilon, 1e-12), o = H.mk(a.d, 'f'), sm = H.mk(a.d, 'f'), g = ins[2], be = ins[3], bi = ins[4];
      for (let r = 0; r < n; r++) { let m = 0; for (let j = 0; j < D; j++) { const v = a.v[r * D + j] + b.v[r * D + j] + (bi ? bi.v[j] : 0); sm.v[r * D + j] = v; m += v; } m /= D; let va = 0; for (let j = 0; j < D; j++) { const d = sm.v[r * D + j] - m; va += d * d; } va /= D; const inv = 1 / Math.sqrt(va + eps); for (let j = 0; j < D; j++) o.v[r * D + j] = (sm.v[r * D + j] - m) * inv * g.v[j] + (be ? be.v[j] : 0); }
      return node.outputs.length > 3 ? [o, null, null, sm] : [o];
    }
    case 'FusedMatMul': { let x = a, y = b; if (H.attrInt(A.transA, 0)) x = transLast(x, H); if (H.attrInt(A.transB, 0)) y = transLast(y, H); const al = H.attrF(A.alpha, 1); const r = await ctx.matmul(x, y, ctx); return [al === 1 ? r : H.unop(r, (q) => q * al, 'f')]; }
    case 'MatMulInteger': return matmulInteger(ins, ctx, H);
    case 'ConvInteger': return convInteger(node, ins, ctx, H);
    default: return undefined;
  }
}
module.exports = { rec, exec, conv2d, padOp, expandOp, tileOp, splitOp, reduceOp, instNorm };
