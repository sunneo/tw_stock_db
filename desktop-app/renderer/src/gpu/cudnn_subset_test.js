// node renderer/src/gpu/cudnn_subset_test.js
// 第三階段 cuDNN 子集（CPU 參考版）的測試：反向用有限差分驗證，前向用朴素迴圈對拍，ATen 對應表的狀態需與核心實況一致。
'use strict';
const assert = require('assert');
const S = require('./cudnn_subset.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = ((s % 2001) - 1000) / 500; }
  return out;
}
// 有限差分：對 f(x) 的標量輸出 L = sum(c * y) 取梯度，檢查解析梯度
function fdGrad(f, x, eps) {
  const g = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const o = x[i];
    x[i] = o + eps; const lp = f(x); x[i] = o - eps; const lm = f(x); x[i] = o;
    g[i] = (lp - lm) / (2 * eps);
  }
  return g;
}
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

// 朴素的卷積（另寫一份，當作獨立參考）
function naiveConv(x, w, b, d, stride, pad) {
  const HO = S.convOutSize(d.H, d.KH, stride, pad), WO = S.convOutSize(d.W, d.KW, stride, pad);
  const y = new Float64Array(d.N * d.O * HO * WO);
  for (let n = 0; n < d.N; n++) for (let o = 0; o < d.O; o++) for (let i = 0; i < HO; i++) for (let j = 0; j < WO; j++) {
    let acc = b ? b[o] : 0;
    for (let c = 0; c < d.C; c++) for (let kh = 0; kh < d.KH; kh++) for (let kw = 0; kw < d.KW; kw++) {
      const hi = i * stride + kh - pad, wi = j * stride + kw - pad;
      if (hi >= 0 && hi < d.H && wi >= 0 && wi < d.W) acc += x[((n * d.C + c) * d.H + hi) * d.W + wi] * w[((o * d.C + c) * d.KH + kh) * d.KW + kw];
    }
    y[((n * d.O + o) * HO + i) * WO + j] = acc;
  }
  return y;
}

const convDims = { N: 2, C: 3, H: 5, W: 6, O: 4, KH: 3, KW: 2 };

check('conv2d 前向與朴素迴圈一致（步幅 2、填補 1）', () => {
  const x = seeded(2 * 3 * 5 * 6, 1), w = seeded(4 * 3 * 3 * 2, 2), b = seeded(4, 3);
  const got = S.conv2dForward(x, w, b, convDims, 2, 1).y;
  const want = naiveConv(x, w, b, convDims, 2, 1);
  assert.ok(maxDiff(got, want) < 1e-12, '差 ' + maxDiff(got, want));
});

check('conv2d 反向 dx、dw、db 與有限差分一致（步幅 1、填補 0）', () => {
  const x = seeded(2 * 3 * 5 * 6, 4), w = seeded(4 * 3 * 3 * 2, 5), b = seeded(4, 6);
  const dyFix = seeded(2 * 4 * 3 * 5, 7); // 步幅 1、填補 0：HO=3、WO=5
  const L = (xx, ww, bb) => { const y = S.conv2dForward(xx, ww, bb, convDims, 1, 0).y; let s = 0; for (let i = 0; i < y.length; i++) s += dyFix[i] * y[i]; return s; };
  const r = S.conv2dBackward(x, w, dyFix, convDims, 1, 0, true);
  assert.ok(maxDiff(r.dx, fdGrad((xx) => L(xx, w, b), x.slice(), 1e-6)) < 1e-6, 'dx');
  assert.ok(maxDiff(r.dw, fdGrad((ww) => L(x, ww, b), w.slice(), 1e-6)) < 1e-6, 'dw');
  assert.ok(maxDiff(r.db, fdGrad((bb) => L(x, w, bb), b.slice(), 1e-6)) < 1e-6, 'db');
});

check('conv2d 反向在步幅 2、填補 1 時 dx 仍與有限差分一致', () => {
  const x = seeded(2 * 3 * 5 * 6, 8), w = seeded(4 * 3 * 3 * 2, 9);
  const HO = S.convOutSize(5, 3, 2, 1), WO = S.convOutSize(6, 2, 2, 1);
  const dyFix = seeded(2 * 4 * HO * WO, 10);
  const L = (xx) => { const y = S.conv2dForward(xx, w, null, convDims, 2, 1).y; let s = 0; for (let i = 0; i < y.length; i++) s += dyFix[i] * y[i]; return s; };
  const r = S.conv2dBackward(x, w, dyFix, convDims, 2, 1, false);
  assert.ok(maxDiff(r.dx, fdGrad(L, x.slice(), 1e-6)) < 1e-6);
});

check('最大池化前向與反向（K=2、S=2）：反向只回傳到最大值位置', () => {
  const d = { N: 1, C: 1, H: 4, W: 4 };
  const x = Float64Array.from([1, 5, 2, 0, 3, 4, 9, 1, 0, 0, 0, 0, 7, 2, 1, 8]);
  const p = S.maxPool2dForward(x, d, 2, 2);
  assert.deepStrictEqual(Array.from(p.y), [5, 9, 7, 8]);
  const dy = Float64Array.from([1, 2, 3, 4]);
  const b = S.maxPool2dBackward(dy, p.arg, x.length);
  assert.strictEqual(b.dx[1], 1); assert.strictEqual(b.dx[6], 2); assert.strictEqual(b.dx[12], 3); assert.strictEqual(b.dx[15], 4);
  assert.strictEqual(b.dx[0], 0);
});

check('softmax 每列和為 1，且與朴素版一致；大數值下不溢位', () => {
  const x = Float64Array.from([1, 2, 3, 1000, 1001, 1002]);
  const y = S.softmaxRows(x, 2, 3).y;
  assert.ok(Math.abs(y[0] + y[1] + y[2] - 1) < 1e-12 && Math.abs(y[3] + y[4] + y[5] - 1) < 1e-12);
  const e = [Math.exp(1), Math.exp(2), Math.exp(3)], s = e[0] + e[1] + e[2];
  assert.ok(Math.abs(y[2] - e[2] / s) < 1e-12);
  assert.ok(Number.isFinite(y[5]));
});

check('batchnorm 前向輸出的每通道均值 0、變異數 ≈1（gamma=1, beta=0）', () => {
  const d = { N: 3, C: 2, H: 2, W: 2 };
  const x = seeded(3 * 2 * 4, 11);
  const r = S.batchNormForward(x, [1, 1], [0, 0], d, 1e-5);
  for (let c = 0; c < 2; c++) {
    let m = 0, v = 0;
    for (let n = 0; n < 3; n++) for (let p = 0; p < 4; p++) m += r.y[(n * 2 + c) * 4 + p];
    m /= 12;
    for (let n = 0; n < 3; n++) for (let p = 0; p < 4; p++) v += (r.y[(n * 2 + c) * 4 + p] - m) ** 2;
    v /= 12;
    assert.ok(Math.abs(m) < 1e-10 && Math.abs(v - 1) < 1e-3, '通道 ' + c + ' 均值 ' + m + ' 變異 ' + v);
  }
});

check('batchnorm 反向 dx、dgamma、dbeta 與有限差分一致', () => {
  const d = { N: 3, C: 2, H: 2, W: 2 };
  const x = seeded(3 * 2 * 4, 12), gamma = seeded(2, 13), beta = seeded(2, 14);
  const dyFix = seeded(3 * 2 * 4, 15);
  const L = (xx, gg, bb) => { const r = S.batchNormForward(xx, gg, bb, d, 1e-5); let s = 0; for (let i = 0; i < r.y.length; i++) s += dyFix[i] * r.y[i]; return s; };
  const f = S.batchNormForward(x, gamma, beta, d, 1e-5);
  const r = S.batchNormBackward(dyFix, f.xhat, f.inv, gamma, d);
  assert.ok(maxDiff(r.dx, fdGrad((xx) => L(xx, gamma, beta), x.slice(), 1e-6)) < 1e-5, 'dx');
  assert.ok(maxDiff(r.dgamma, fdGrad((gg) => L(x, gg, beta), gamma.slice(), 1e-6)) < 1e-6, 'dgamma');
  assert.ok(maxDiff(r.dbeta, fdGrad((bb) => L(x, gamma, bb), beta.slice(), 1e-6)) < 1e-6, 'dbeta');
});

check('relu 與 gelu（tanh 近似）的已知值', () => {
  assert.deepStrictEqual(Array.from(S.reluForward([-1, 0, 2]).y), [0, 0, 2]);
  const g = S.geluTanhForward([0, 1]).y;
  assert.strictEqual(g[0], 0);
  assert.ok(Math.abs(g[1] - 0.841192) < 1e-5, 'gelu(1)=' + g[1]);
});

check('單頭注意力：因果遮罩下第一列只看自己，輸出等於 V 的第一列', () => {
  const T = 3, D = 2, E = 2;
  const Q = seeded(T * D, 21), K = seeded(T * D, 22), V = seeded(T * E, 23);
  const r = S.attentionForward(Q, K, V, T, T, D, E, true);
  assert.ok(Math.abs(r.P[0] - 1) < 1e-12 && r.P[1] === 0);
  assert.ok(Math.abs(r.O[0] - V[0]) < 1e-12 && Math.abs(r.O[1] - V[1]) < 1e-12);
  for (let i = 0; i < T; i++) { let s = 0; for (let j = 0; j < T; j++) s += r.P[i * T + j]; assert.ok(Math.abs(s - 1) < 1e-12); }
});

check('所有子集函式的 info 都標示 cpu-js 與原因（不假裝 GPU）', () => {
  const r = S.reluForward([1]);
  assert.strictEqual(r.info.layer, 'cpu-js');
  assert.ok(r.info.reason.includes('CPU 參考版'));
});

check('ATen 對應表：不在子集內的運算回傳 unsupported', () => {
  assert.strictEqual(S.atenStatus('aten::not_a_real_op').status, 'unsupported');
});

// 以執行期的 backendInfo().ops 為準（公開介面）：標 gpu-t1 的 ATen 項目，對應的核心必須在 WebGPU 上為 native
(async () => {
  const core = require('./gpu_core.js');
  const { fakeNavigator } = require('./gpu_fakes.js');
  const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
  const ops = (await rt.backendInfo()).ops;
  const claimed = { 'aten::mm': 'matmul', 'aten::add': 'vector_add', 'aten::sum': 'sum', 'aten::index_add': 'scatter_add' };
  let ok = true, msg = '';
  for (const [aten, op] of Object.entries(claimed)) {
    if (S.ATEN_MAP[aten].status !== 'gpu-t1') { ok = false; msg += aten + ' 狀態不是 gpu-t1; '; }
    if (!ops[op] || ops[op].webgpu !== 'native') { ok = false; msg += aten + ' 對應的 ' + op + ' 在 backendInfo 不是 native; '; }
  }
  if (ok) { pass++; console.log('ok   ATen 對應表：gpu-t1 項目都對應到 backendInfo 回報為 native 的核心'); }
  else { fail++; console.log('FAIL ATen 對應表：' + msg); }
  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
