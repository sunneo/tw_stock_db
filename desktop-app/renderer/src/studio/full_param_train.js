'use strict';
// 全參數訓練（P1）：小型密集 transformer，每個基底權重都求梯度（不是 LoRA）。
// 架構與 lora_ref_train.js 的前向相同：RMSNorm（eps 1e-6）、RoPE（交錯成對，與該檔 rope() 相同）、
// 因果注意力、SiLU 閘控 MLP、綁定詞嵌入輸出頭。差別：沒有 LoRA 分支，每個線性層都求 dW，
// 嵌入梯度＝輸入查表梯度＋輸出頭梯度，RMSNorm 增益也求梯度。
// 純 CPU 的 f64 參考實作（矩陣乘可注入 be.matmul，給 cudaweb 換成 GPU 矩陣乘）。
// 真值是 PyTorch autograd：renderer/src/studio/full_param_ref_torch.py（本檔不自我比對）。
// 權重布局（行優先）：線性層 W 為 [輸入維, 輸出維]，前向 y = x·W；emb 為 [V, d]。

const EPS = 1e-6;
const sig = (x) => 1 / (1 + Math.exp(-x));

function tr(X, r, c) {
  const Y = new Float64Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) Y[j * r + i] = X[i * c + j];
  return Y;
}
// 矩陣乘（A: m×k，B: k×n）。be.matmul 可以是 async；這裡一律 await。
async function mm(be, A, B, m, k, n) {
  return Float64Array.from(await be.matmul(A, B, m, k, n));
}
function cpuBackend() {
  const mmJs = (A, B, m, k, n) => {
    const C = new Float64Array(m * n);
    for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) { const a = A[i * k + p]; if (a === 0) continue; const bo = p * n, co = i * n; for (let j = 0; j < n; j++) C[co + j] += a * B[bo + j]; }
    return C;
  };
  return { id: 'cpu-js', layer: 'cpu-js', async matmul(A, B, m, k, n) { return mmJs(A, B, m, k, n); } };
}

// RMSNorm 前向：y = x·inv·g，inv[t] = 1/√(mean(x²)+eps)
function rmsFwd(x, g, T, d) {
  const y = new Float64Array(T * d), inv = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0; for (let i = 0; i < d; i++) s += x[t * d + i] * x[t * d + i];
    const iv = 1 / Math.sqrt(s / d + EPS); inv[t] = iv;
    for (let i = 0; i < d; i++) y[t * d + i] = x[t * d + i] * iv * g[i];
  }
  return { y, inv };
}
// RMSNorm 反向：回傳對 x 的梯度 dx 與對增益 g 的梯度 dg
function rmsBwd(dy, x, g, inv, T, d) {
  const dx = new Float64Array(T * d), dg = new Float64Array(d);
  for (let t = 0; t < T; t++) {
    let md = 0;
    for (let i = 0; i < d; i++) md += dy[t * d + i] * g[i] * x[t * d + i] * inv[t];
    md /= d;
    for (let i = 0; i < d; i++) {
      const xh = x[t * d + i] * inv[t];
      dx[t * d + i] = inv[t] * (dy[t * d + i] * g[i] - xh * md);
      dg[i] += dy[t * d + i] * xh;
    }
  }
  return { dx, dg };
}
// RoPE（交錯成對）：dir=+1 前向，dir=-1 為反向（旋轉的逆）。與 lora_ref_train.js 的 rope() 相同。
function rope(x, T, H, hd, dir) {
  const y = new Float64Array(x.length), d = H * hd;
  for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < hd / 2; i++) {
    const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th);
    const o = t * d + h * hd + 2 * i; const a = x[o], b = x[o + 1];
    y[o] = a * c - b * s; y[o + 1] = a * s + b * c;
  }
  return y;
}

// 模型：init 為外部給的權重（形狀見 zeroGrads）。cfg = {V, d, L, H, F}。
function fromInit(cfg, init) {
  const cp = (a) => Float64Array.from(a);
  const m = { cfg, emb: cp(init.emb), nf: cp(init.nf), layers: [] };
  for (const L of init.layers) {
    m.layers.push({ n1: cp(L.n1), n2: cp(L.n2), Wq: cp(L.Wq), Wk: cp(L.Wk), Wv: cp(L.Wv), Wo: cp(L.Wo), Wg: cp(L.Wg), Wu: cp(L.Wu), Wd: cp(L.Wd) });
  }
  return m;
}
const LAYER_KEYS = ['n1', 'n2', 'Wq', 'Wk', 'Wv', 'Wo', 'Wg', 'Wu', 'Wd'];
// 依 cfg 的形狀配置零梯度（與權重同形）
function zeroGrads(m) {
  const z = (a) => new Float64Array(a.length);
  const g = { emb: z(m.emb), nf: z(m.nf), layers: [] };
  for (const L of m.layers) { const o = {}; for (const k of LAYER_KEYS) o[k] = z(L[k]); g.layers.push(o); }
  return g;
}

// 前向＋損失：tokens 長度 T+1，輸入 tokens[0..T)、目標 tokens[1..T]。回傳 { loss, cache }。
async function forward(m, tokens, be) {
  const { V, d, H, F } = m.cfg; const hd = d / H; const T = tokens.length - 1;
  const inp = tokens.slice(0, T), tgt = tokens.slice(1);
  let h = new Float64Array(T * d);
  for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) h[t * d + i] = m.emb[inp[t] * d + i];
  const C = [];
  const sc = 1 / Math.sqrt(hd);
  for (let l = 0; l < m.layers.length; l++) {
    const P = m.layers[l], c = { h0: h };
    const n1 = rmsFwd(h, P.n1, T, d); c.n1 = n1;
    const q0 = await mm(be, n1.y, P.Wq, T, d, d), k0 = await mm(be, n1.y, P.Wk, T, d, d), v = await mm(be, n1.y, P.Wv, T, d, d);
    const q = rope(q0, T, H, hd, 1), k = rope(k0, T, H, hd, 1);
    // 因果注意力：每個 (頭, 查詢位置 i) 只對 j≤i 做 softmax
    const Pm = new Float64Array(H * T * T), ao = new Float64Array(T * d);
    for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
      const row = (hh * T + i) * T; let mx = -Infinity;
      for (let j = 0; j <= i; j++) { let z = 0; for (let u = 0; u < hd; u++) z += q[i * d + hh * hd + u] * k[j * d + hh * hd + u]; Pm[row + j] = z * sc; if (Pm[row + j] > mx) mx = Pm[row + j]; }
      let s = 0; for (let j = 0; j <= i; j++) { Pm[row + j] = Math.exp(Pm[row + j] - mx); s += Pm[row + j]; }
      for (let j = 0; j <= i; j++) Pm[row + j] /= s;
      for (let u = 0; u < hd; u++) { let z = 0; for (let j = 0; j <= i; j++) z += Pm[row + j] * v[j * d + hh * hd + u]; ao[i * d + hh * hd + u] = z; }
    }
    c.q = q; c.k = k; c.v = v; c.P = Pm; c.ao = ao;
    const o = await mm(be, ao, P.Wo, T, d, d);
    const h1 = new Float64Array(T * d); for (let i = 0; i < h1.length; i++) h1[i] = h[i] + o[i]; c.h1 = h1;
    const n2 = rmsFwd(h1, P.n2, T, d); c.n2 = n2;
    const g = await mm(be, n2.y, P.Wg, T, d, F), u = await mm(be, n2.y, P.Wu, T, d, F);
    const a = new Float64Array(T * F); for (let i = 0; i < a.length; i++) a[i] = g[i] * sig(g[i]) * u[i];
    const dn = await mm(be, a, P.Wd, T, F, d);
    c.g = g; c.u = u; c.a = a;
    const h2 = new Float64Array(T * d); for (let i = 0; i < h2.length; i++) h2[i] = h1[i] + dn[i];
    h = h2; C.push(c);
  }
  const nf = rmsFwd(h, m.nf, T, d);
  const embT = tr(m.emb, V, d);
  const logits = await mm(be, nf.y, embT, T, d, V);
  // 交叉熵（平均）與 dlogits = (softmax − onehot)/T
  const dl = new Float64Array(T * V); let loss = 0;
  for (let t = 0; t < T; t++) {
    let mx = -Infinity; for (let j = 0; j < V; j++) if (logits[t * V + j] > mx) mx = logits[t * V + j];
    let s = 0; for (let j = 0; j < V; j++) { dl[t * V + j] = Math.exp(logits[t * V + j] - mx); s += dl[t * V + j]; }
    loss += -Math.log(dl[t * V + tgt[t]] / s);
    for (let j = 0; j < V; j++) dl[t * V + j] = (dl[t * V + j] / s - (j === tgt[t] ? 1 : 0)) / T;
  }
  loss /= T;
  return { loss, cache: { C, nf, h, inp, T, dl } };
}

// 反向：回傳與模型同形的梯度（全參數）
async function backward(m, cache, be) {
  const { V, d, H, F } = m.cfg; const hd = d / H; const { C, nf, h, inp, T, dl } = cache;
  const sc = 1 / Math.sqrt(hd);
  const grads = zeroGrads(m);
  // 輸出頭（綁定詞嵌入）：dEmb_head = dlᵀ·nf（V×d），dnf = dl·emb
  const dEmbHead = await mm(be, tr(dl, T, V), nf.y, V, T, d);
  const dnfy = await mm(be, dl, m.emb, T, V, d);
  const bf = rmsBwd(dnfy, h, m.nf, nf.inv, T, d);
  grads.nf = bf.dg;
  let dh = bf.dx;
  for (let l = m.layers.length - 1; l >= 0; l--) {
    const P = m.layers[l], c = C[l], G = grads.layers[l];
    // MLP：h2 = h1 + a·Wd，a = silu(g)·u
    G.Wd = await mm(be, tr(c.a, T, F), dh, F, T, d);
    const da = await mm(be, dh, tr(P.Wd, F, d), T, d, F);
    const dg = new Float64Array(T * F), du = new Float64Array(T * F);
    for (let i = 0; i < da.length; i++) {
      const s = sig(c.g[i]), silu = c.g[i] * s;
      du[i] = da[i] * silu;
      dg[i] = da[i] * c.u[i] * s * (1 + c.g[i] * (1 - s));
    }
    G.Wg = await mm(be, tr(c.n2.y, T, d), dg, d, T, F);
    G.Wu = await mm(be, tr(c.n2.y, T, d), du, d, T, F);
    const dn2a = await mm(be, dg, tr(P.Wg, d, F), T, F, d), dn2b = await mm(be, du, tr(P.Wu, d, F), T, F, d);
    const dn2 = new Float64Array(T * d); for (let i = 0; i < dn2.length; i++) dn2[i] = dn2a[i] + dn2b[i];
    const b2 = rmsBwd(dn2, c.h1, P.n2, c.n2.inv, T, d); G.n2 = b2.dg;
    const dh1 = new Float64Array(T * d); for (let i = 0; i < dh1.length; i++) dh1[i] = b2.dx[i] + dh[i];
    // 注意力輸出投影：h1 = h0 + ao·Wo
    G.Wo = await mm(be, tr(c.ao, T, d), dh1, d, T, d);
    const dao = await mm(be, dh1, tr(P.Wo, d, d), T, d, d);
    // 注意力反向：dV、dQ、dK（每個 (頭, i) 只對 j≤i）
    const dq = new Float64Array(T * d), dk = new Float64Array(T * d), dv = new Float64Array(T * d);
    for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
      const row = (hh * T + i) * T; const dP = new Float64Array(i + 1); let dot = 0;
      for (let j = 0; j <= i; j++) {
        let z = 0; for (let u = 0; u < hd; u++) { z += dao[i * d + hh * hd + u] * c.v[j * d + hh * hd + u]; dv[j * d + hh * hd + u] += c.P[row + j] * dao[i * d + hh * hd + u]; }
        dP[j] = z; dot += z * c.P[row + j];
      }
      for (let j = 0; j <= i; j++) {
        const dS = c.P[row + j] * (dP[j] - dot) * sc;
        for (let u = 0; u < hd; u++) { dq[i * d + hh * hd + u] += dS * c.k[j * d + hh * hd + u]; dk[j * d + hh * hd + u] += dS * c.q[i * d + hh * hd + u]; }
      }
    }
    const dq0 = rope(dq, T, H, hd, -1), dk0 = rope(dk, T, H, hd, -1);
    G.Wq = await mm(be, tr(c.n1.y, T, d), dq0, d, T, d);
    G.Wk = await mm(be, tr(c.n1.y, T, d), dk0, d, T, d);
    G.Wv = await mm(be, tr(c.n1.y, T, d), dv, d, T, d);
    const dxq = await mm(be, dq0, tr(P.Wq, d, d), T, d, d), dxk = await mm(be, dk0, tr(P.Wk, d, d), T, d, d), dxv = await mm(be, dv, tr(P.Wv, d, d), T, d, d);
    const dx = new Float64Array(T * d); for (let i = 0; i < dx.length; i++) dx[i] = dxq[i] + dxk[i] + dxv[i];
    const b1 = rmsBwd(dx, c.h0, P.n1, c.n1.inv, T, d); G.n1 = b1.dg;
    const dh0 = new Float64Array(T * d); for (let i = 0; i < dh0.length; i++) dh0[i] = b1.dx[i] + dh1[i];
    dh = dh0;
  }
  // 嵌入：輸入查表的梯度（列加總）＋輸出頭梯度
  const gEmb = grads.emb;
  for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) gEmb[inp[t] * d + i] += dh[t * d + i];
  for (let i = 0; i < gEmb.length; i++) gEmb[i] += dEmbHead[i];
  return grads;
}

// 逐個參數走訪（順序固定：emb、nf、各層 LAYER_KEYS）。fn(p, g, name)
function eachParam(m, g, fn) {
  fn(m.emb, g.emb, 'emb'); fn(m.nf, g.nf, 'nf');
  for (let l = 0; l < m.layers.length; l++) for (const k of LAYER_KEYS) fn(m.layers[l][k], g.layers[l][k], 'L' + l + '.' + k);
}

// 全域梯度範數裁剪（與 torch.nn.utils.clip_grad_norm_ 相同：coef = max / (norm + 1e-6)，上限 1）
function clipGrads(m, g, maxNorm) {
  let s = 0; eachParam(m, g, (p, gg) => { for (let i = 0; i < gg.length; i++) s += gg[i] * gg[i]; });
  const norm = Math.sqrt(s);
  const coef = Math.min(1, maxNorm / (norm + 1e-6));
  if (coef < 1) eachParam(m, g, (p, gg) => { for (let i = 0; i < gg.length; i++) gg[i] *= coef; });
  return { norm, coef };
}

// AdamW（與 torch.optim.AdamW 相同：先 p *= (1 − lr·wd)，再 Adam 更新，偏差修正）
function adamInit(m) {
  const z = (a) => new Float64Array(a.length);
  const st = { t: 0, m: { emb: z(m.emb), nf: z(m.nf), layers: [] }, v: { emb: z(m.emb), nf: z(m.nf), layers: [] } };
  for (const L of m.layers) { const om = {}, ov = {}; for (const k of LAYER_KEYS) { om[k] = z(L[k]); ov[k] = z(L[k]); } st.m.layers.push(om); st.v.layers.push(ov); }
  return st;
}
function adamStep(m, g, st, o) {
  const { lr, b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0 } = o;
  st.t++;
  const c1 = 1 - Math.pow(b1, st.t), c2 = 1 - Math.pow(b2, st.t);
  const mAt = (name) => { const parts = name.split('.'); if (parts.length === 1) return [st.m[name], st.v[name]]; const l = +parts[0].slice(1); return [st.m.layers[l][parts[1]], st.v.layers[l][parts[1]]]; };
  eachParam(m, g, (p, gg, name) => {
    const [mm1, vv] = mAt(name);
    for (let i = 0; i < p.length; i++) {
      p[i] *= 1 - lr * wd;
      mm1[i] = b1 * mm1[i] + (1 - b1) * gg[i];
      vv[i] = b2 * vv[i] + (1 - b2) * gg[i] * gg[i];
      const mhat = mm1[i] / c1, vhat = vv[i] / c2;
      p[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
    }
  });
}

// 一步訓練：前向、反向、裁剪、AdamW。回傳 { loss, gradNorm }
async function trainStep(m, tokens, st, o) {
  const be = (o && o.backend) || cpuBackend();
  const f = await forward(m, tokens, be);
  const g = await backward(m, f.cache, be);
  const clip = clipGrads(m, g, (o && o.clip) || 1.0);
  adamStep(m, g, st, o);
  return { loss: f.loss, gradNorm: clip.norm, grads: g };
}

module.exports = { fromInit, zeroGrads, forward, backward, clipGrads, adamInit, adamStep, trainStep, rmsFwd, rmsBwd, rope, tr, cpuBackend, LAYER_KEYS, eachParam, EPS };
