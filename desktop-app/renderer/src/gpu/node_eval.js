'use strict';
// 以 ONNX 節點的屬性與實際輸入張量，走共用 GPU 運算（conv_ops／mm_ops，T1 WGSL → cpu-js）算出該節點輸出；
// 給「逐節點對真 ORT 對拍」（scripts/eval/cudaweb_node_*.js）用，Demucs、YAMNet、SDXS、Kokoro 共用。
//   evalNode(op, attrs, ins, ops) → Promise<{ y, dims }>
//   ins = [{ data: TypedArray, dims }|null, ...]（照 ONNX 輸入順序）；attrs = { strides, pads, dilations, group, output_padding }（整數陣列／數字）
//   ops.gpu === false 強制 CPU 參考；ops.navigator 指定 WebGPU 入口；ops.lastInfo 回報層級。
const CONV = require('./conv_ops.js');
const MM = require('./mm_ops.js');

function scalar(t) { return t ? Number(t.data[0]) : 0; }
async function evalNode(op, attrs, ins, ops) {
  const a = attrs || {}, o = ops || {}, x = ins[0], w = ins[1];
  if (op === 'Conv') {
    const b = ins[2] ? ins[2].data : null, g = a.group || 1;
    if (x.dims.length === 3) {
      const [N, C, L] = x.dims, [M, Cg, K] = w.dims, pads = a.pads && a.pads.length ? a.pads : [0, 0];
      const y = await CONV.conv1d(x.data, N, C, L, w.data, M, Cg, K, b, { stride: (a.strides || [1])[0], pads, dilation: (a.dilations || [1])[0], groups: g }, o);
      return { y, dims: [N, M, Math.floor((L + pads[0] + pads[1] - (a.dilations || [1])[0] * (K - 1) - 1) / (a.strides || [1])[0]) + 1] };
    }
    const [N, C, H, W] = x.dims, [M, Cg, KH, KW] = w.dims, p = { strides: a.strides || [1, 1], dilations: a.dilations || [1, 1], pads: a.pads && a.pads.length ? a.pads : [0, 0, 0, 0], groups: g };
    const y = await CONV.conv2d(x.data, N, C, H, W, w.data, M, Cg, KH, KW, b, p, o);
    const q = CONV.norm2(p);
    return { y, dims: [N, M, Math.floor((H + q.pt + q.pb - q.dh * (KH - 1) - 1) / q.sh) + 1, Math.floor((W + q.pl + q.pr - q.dw * (KW - 1) - 1) / q.sw) + 1] };
  }
  if (op === 'ConvTranspose') {
    const b = ins[2] ? ins[2].data : null, g = a.group || 1;
    let N, C, H, W, KH, KW, p;
    if (x.dims.length === 3) {
      [N, C, W] = x.dims; H = 1; KH = 1; KW = w.dims[2];
      const pd = a.pads && a.pads.length ? a.pads : [0, 0];
      p = { strides: [1, (a.strides || [1])[0]], pads: [0, pd[0], 0, pd[1]], dilations: [1, (a.dilations || [1])[0]], groups: g, outputPadding: [0, (a.output_padding || [0])[0]] };
    } else {
      [N, C, H, W] = x.dims; KH = w.dims[2]; KW = w.dims[3];
      p = { strides: a.strides || [1, 1], pads: a.pads && a.pads.length ? a.pads : [0, 0, 0, 0], dilations: a.dilations || [1, 1], groups: g, outputPadding: a.output_padding || [0, 0] };
    }
    const M = w.dims[1] * g, d = CONV.convT2dDims(H, W, KH, KW, p);
    const y = await CONV.convT2d(x.data, N, C, H, W, w.data, M, KH, KW, b, p, o);
    return { y, dims: x.dims.length === 3 ? [N, M, d.Wout] : [N, M, d.Hout, d.Wout] };
  }
  if (op === 'ConvInteger') {
    const [N, C, L] = x.dims, [M, Cg, K] = w.dims, pads = a.pads && a.pads.length ? a.pads : [0, 0], st = (a.strides || [1])[0], dl = (a.dilations || [1])[0];
    const y = await CONV.convInt1d(x.data, N, C, L, w.data, M, Cg, K, scalar(ins[2]), scalar(ins[3]), { stride: st, pads, dilation: dl, groups: a.group || 1 }, o);
    return { y, dims: [N, M, Math.floor((L + pads[0] + pads[1] - dl * (K - 1) - 1) / st) + 1] };
  }
  if (op === 'MatMul') return MM.matmul(x.data, x.dims, w.data, w.dims, o);
  if (op === 'MatMulInteger') return MM.matmulInt(x.data, x.dims, w.data, w.dims, scalar(ins[2]), scalar(ins[3]), o);
  throw new Error('node_eval：未支援的算子 ' + op);
}
module.exports = { evalNode };
