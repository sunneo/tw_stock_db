/* conv_im2col.js — R5 卷積：im2col（把每個輸出位置的輸入視窗展開成一欄）＋矩陣乘（權重 M×K′ 乘 col K′×P）。
 * 列序 k′ = (c·KH + kh)·KW + kw，與直接卷積（conv_ops.conv2dRef）的累加順序相同；欄 p = i·Wout + j；越界為 0。
 * 輸出 y[n][m][p] = Σ_k′ W[m][k′]·col[k′][p]，即 [N, M, Hout, Wout]。只支援 groups = 1。
 * 這裡只有 CPU 參考與 im2col 的 WGSL；矩陣乘交給 mm_ops（平鋪核心）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaConvIm2col。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaConvIm2col = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function norm(p) {
    const o = p || {};
    const pd = o.pads || [0, 0, 0, 0];
    return { sh: (o.strides || [1, 1])[0], sw: (o.strides || [1, 1])[1], pt: pd[0], pl: pd[1], pb: pd[2], pr: pd[3], dh: (o.dilations || [1, 1])[0], dw: (o.dilations || [1, 1])[1], groups: o.groups || 1 };
  }
  function dims(C, H, W, KH, KW, p) {
    const q = norm(p);
    const Hout = Math.floor((H + q.pt + q.pb - q.dh * (KH - 1) - 1) / q.sh) + 1;
    const Wout = Math.floor((W + q.pl + q.pr - q.dw * (KW - 1) - 1) / q.sw) + 1;
    return { Hout: Hout, Wout: Wout, K: C * KH * KW, P: Hout * Wout };
  }

  // 單一批次的 im2col（CPU 參考）：x 為 [C, H, W]；回傳 K′×P 的列主序矩陣
  function im2colRef(x, C, H, W, KH, KW, p) {
    const q = norm(p), d = dims(C, H, W, KH, KW, p);
    const col = new Float32Array(d.K * d.P);
    for (let c = 0; c < C; c++) for (let kh = 0; kh < KH; kh++) for (let kw = 0; kw < KW; kw++) {
      const kp = (c * KH + kh) * KW + kw;
      for (let i = 0; i < d.Hout; i++) for (let j = 0; j < d.Wout; j++) {
        const ih = i * q.sh - q.pt + kh * q.dh, iw = j * q.sw - q.pl + kw * q.dw;
        col[kp * d.P + i * d.Wout + j] = (ih >= 0 && ih < H && iw >= 0 && iw < W) ? x[(c * H + ih) * W + iw] : 0;
      }
    }
    return col;
  }

  // 卷積（im2col＋矩陣乘，CPU 版，供測試）：w 為 [M, C, KH, KW]；回傳 [N, M, Hout, Wout]
  function convViaIm2colRef(x, N, C, H, W, w, M, KH, KW, p) {
    const q = norm(p);
    if (q.groups !== 1) throw new Error('conv_im2col：目前只支援 groups = 1（收到 ' + q.groups + '）');
    const d = dims(C, H, W, KH, KW, p);
    const y = new Float32Array(N * M * d.P);
    for (let n = 0; n < N; n++) {
      const col = im2colRef(x.subarray(n * C * H * W, (n + 1) * C * H * W), C, H, W, KH, KW, p);
      for (let m = 0; m < M; m++) for (let pp = 0; pp < d.P; pp++) {
        let acc = 0;
        for (let k = 0; k < d.K; k++) acc = Math.fround(acc + Math.fround(w[m * d.K + k] * col[k * d.P + pp]));
        y[(n * M + m) * d.P + pp] = acc;
      }
    }
    return y;
  }

  // im2col 的 WGSL：一個執行緒算 col[k′][p] 的一個元素（每個工作群組 64 個）。x 為一個批次的 [C, H, W]。
  const WGSL_IM2COL = `
struct P { C: u32, H: u32, W: u32, KH: u32, KW: u32, Hout: u32, Wout: u32, sh: u32, sw: u32, pt: u32, pl: u32, dh: u32, dw: u32, total: u32, p0: u32, p1: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> col: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= p.total) { return; }
  let P_ = p.Hout * p.Wout;
  let kp = idx / P_;
  let pc = idx % P_;
  let kwi = kp % p.KW;
  let khi = (kp / p.KW) % p.KH;
  let c = kp / (p.KH * p.KW);
  let i = pc / p.Wout;
  let j = pc % p.Wout;
  let ih = i32(i * p.sh) - i32(p.pt) + i32(khi * p.dh);
  let iw = i32(j * p.sw) - i32(p.pl) + i32(kwi * p.dw);
  var v: f32 = 0.0;
  if (ih >= 0 && ih < i32(p.H) && iw >= 0 && iw < i32(p.W)) { v = x[(c * p.H + u32(ih)) * p.W + u32(iw)]; }
  col[idx] = v;
}`;

  return { dims, im2colRef, convViaIm2colRef, WGSL_IM2COL };
}));
