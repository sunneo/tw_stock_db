'use strict';
// 全參數訓練（P1）：小型密集 transformer，每個基底權重都求梯度（不是 LoRA）。
// 架構對齊 llm_scratch.py 的密集 Block（build_model_classes）：
//   RMSNorm（eps 1e-6）→ q/k/v 投影 →（可選）每頭 qk-norm（RMSNorm，寬度 head_dim）→ rotate-half RoPE
//   → 因果注意力（分組查詢：kvHeads ≤ heads，query 頭 hh 用 kv 頭 floor(hh / (heads/kvHeads))）
//   → o 投影 → 殘差 → RMSNorm → SiLU 閘控 MLP → 殘差；最後 RMSNorm＋綁定詞嵌入輸出頭。
// cfg = { V, d, L, H, F, kvH（預設＝H）, qkNorm（預設 false） }。權重布局（行優先）：線性層 W 為 [輸入, 輸出]，y = x·W。
// 純 CPU 的 f64 參考實作；矩陣乘可注入 be.matmul（cudaweb 用 cudawebBackend）。
// 真值是 PyTorch autograd：full_param_ref_torch.py（本檔不自我比對）。

const EPS = 1e-6;
const sig = (x) => 1 / (1 + Math.exp(-x));

function tr(X, r, c) {
  const Y = new Float64Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) Y[j * r + i] = X[i * c + j];
  return Y;
}
// 矩陣乘（A: m×k，B: k×n）
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
// cudaweb 矩陣乘後端：所有線性層與注意力的矩陣乘都走 rt.matmul（cudaweb 執行期）。
// 其餘逐元素運算目前在 CPU（f64）；盤點見 INVENTORY §1。rt.matmul 回傳 { result, info:{ layer, reason } }。
function cudawebBackend(rt) {
  const be = { id: 'cudaweb', layer: null, reason: null, calls: 0 };
  be.matmul = async (A, B, m, k, n) => {
    const r = await rt.matmul(Array.from(A), Array.from(B), m, k, n);
    be.calls++; be.layer = r.info.layer; be.reason = r.info.reason || null;
    return Float64Array.from(r.result);
  };
  return be;
}

// RMSNorm 前向：y = x·inv·g，inv[t] = 1/√(mean(x²)+eps)。x 為 rows×width。
function rmsFwd(x, g, rows, width) {
  const y = new Float64Array(rows * width), inv = new Float64Array(rows);
  for (let t = 0; t < rows; t++) {
    let s = 0; for (let i = 0; i < width; i++) s += x[t * width + i] * x[t * width + i];
    const iv = 1 / Math.sqrt(s / width + EPS); inv[t] = iv;
    for (let i = 0; i < width; i++) y[t * width + i] = x[t * width + i] * iv * g[i];
  }
  return { y, inv, x };
}
// RMSNorm 反向：回傳對 x 的梯度 dx 與對增益 g 的梯度 dg
function rmsBwd(dy, x, g, inv, rows, width) {
  const dx = new Float64Array(rows * width), dg = new Float64Array(width);
  for (let t = 0; t < rows; t++) {
    let md = 0;
    for (let i = 0; i < width; i++) md += dy[t * width + i] * g[i] * x[t * width + i] * inv[t];
    md /= width;
    for (let i = 0; i < width; i++) {
      const xh = x[t * width + i] * inv[t];
      dx[t * width + i] = inv[t] * (dy[t * width + i] * g[i] - xh * md);
      dg[i] += dy[t * width + i] * xh;
    }
  }
  return { dx, dg };
}
// RoPE（rotate-half，與 llm_scratch.py 的 rot_half 相同）：每個頭內，第 i 與第 i+hd/2 維配成一對，
// 角度 θ = t·10000^(−2i/hd)；dir=+1 前向，dir=-1 為反向（旋轉的逆）。x 為 T×(H·hd)。
function rope(x, T, H, hd, dir) {
  const y = new Float64Array(x.length), d = H * hd, half = hd / 2;
  for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < half; i++) {
    const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th);
    const o = t * d + h * hd;
    const a = x[o + i], b = x[o + i + half];
    y[o + i] = a * c - b * s;
    y[o + i + half] = b * c + a * s;
  }
  return y;
}

function dims(cfg) {
  const H = cfg.H, d = cfg.d, hd = d / H, kvH = cfg.kvH || H;
  if (H % kvH !== 0) throw new Error('kvH 必須整除 H');
  return { H, d, hd, kvH, kd: kvH * hd, F: cfg.F, V: cfg.V, qkNorm: !!cfg.qkNorm };
}

// 模型：init 為外部給的權重（行優先一維陣列）。qkNorm 時每層多 qn、kn（寬度 hd）。
function fromInit(cfg, init) {
  const cp = (a) => Float64Array.from(a);
  const m = { cfg, emb: cp(init.emb), nf: cp(init.nf), layers: [] };
  for (const L of init.layers) {
    const o = {};
    for (const k of Object.keys(L)) o[k] = cp(L[k]);
    m.layers.push(o);
  }
  return m;
}
// 每層的權重名（依模型實際內容，保證 zeroGrads／adamInit／eachParam 形狀一致）
function layerKeys(m) { return Object.keys(m.layers[0]); }
function zeroGrads(m) {
  const z = (a) => new Float64Array(a.length);
  const g = { emb: z(m.emb), nf: z(m.nf), layers: [] };
  for (const L of m.layers) { const o = {}; for (const k of Object.keys(L)) o[k] = z(L[k]); g.layers.push(o); }
  return g;
}

// 前向＋損失：tokens 長度 T+1，輸入 tokens[0..T)、目標 tokens[1..T]。回傳 { loss, cache }。
// ---- 運算介面（ops）：CPU 預設；cudaweb 用 gpuOps（nn_ops 的 WGSL 核心）----
// rmsOp 回傳 { y, inv, x }：y 由 ops 算（可能在 GPU），inv 在 CPU 算（反向要用，且每列只一次平方和）。
function invOf(x, rows, width) {
  const inv = new Float64Array(rows);
  for (let t = 0; t < rows; t++) { let s = 0; for (let i = 0; i < width; i++) s += x[t * width + i] * x[t * width + i]; inv[t] = 1 / Math.sqrt(s / width + EPS); }
  return inv;
}
async function rmsOp(O, x, g, rows, width) {
  const y = Float64Array.from(await O.rmsnorm(x, g, rows, width));
  return { y, inv: invOf(x, rows, width), x };
}
const CPU_OPS = {
  rmsnorm: async (x, g, rows, width) => rmsFwd(x, g, rows, width).y,
  softmax: async (x, rows, cols) => {
    const out = new Float64Array(x.length);
    for (let r = 0; r < rows; r++) {
      let mx = -Infinity; for (let j = 0; j < cols; j++) if (x[r * cols + j] > mx) mx = x[r * cols + j];
      let s = 0; for (let j = 0; j < cols; j++) { out[r * cols + j] = Math.exp(x[r * cols + j] - mx); s += out[r * cols + j]; }
      for (let j = 0; j < cols; j++) out[r * cols + j] /= s;
    }
    return out;
  },
  silu: async (x) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * sig(x[i]); return y; },
  rope: async (x, T, H, hd, dir) => rope(x, T, H, hd, dir),
};
// GPU 運算（nn_ops）：RMSNorm、softmax、SiLU、AdamW 直接用 nn_ops 的 trainerOps（T1 WGSL → T3 → cpu-js 三層降級）。
// RoPE：nn_ops.rope 是交錯成對，本模組是 rotate-half；兩者用純資料排列（無算術）互換，結果等價。
function gpuOpsFrom(NN, navigator) {
  const base = NN.trainerOps({ navigator });
  return {
    rmsnorm: async (x, g, rows, width) => base.rmsnorm(Float32Array.from(x), Float32Array.from(g), rows, width, EPS),
    softmax: async (x, rows, cols) => base.softmax(Float32Array.from(x), rows, cols),
    silu: async (x) => base.silu(Float32Array.from(x)),
    rope: async (x, T, H, hd, dir) => Float64Array.from(await base.rope(Float32Array.from(x), T, H, hd, dir)),
    adamw: async (p, g, m, v, t, lr, b1, b2, eps, wd) => base.adamw(Float32Array.from(p), Float32Array.from(g), Float32Array.from(m), Float32Array.from(v), t, lr, b1, b2, eps, wd),
  };
}
async function forward(m, tokens, be, ops) {
  const O = ops || CPU_OPS;
  const { H, d, hd, kvH, kd, F, V, qkNorm } = dims(m.cfg); const T = tokens.length - 1;
  const rep = H / kvH;
  const inp = tokens.slice(0, T), tgt = tokens.slice(1);
  let h = new Float64Array(T * d);
  for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) h[t * d + i] = m.emb[inp[t] * d + i];
  const C = [];
  const sc = 1 / Math.sqrt(hd);
  for (let l = 0; l < m.layers.length; l++) {
    const P = m.layers[l], c = { h0: h };
    const n1 = await rmsOp(O, h, P.n1, T, d); c.n1 = n1;
    let q0 = await mm(be, n1.y, P.Wq, T, d, d), k0 = await mm(be, n1.y, P.Wk, T, d, kd), v = await mm(be, n1.y, P.Wv, T, d, kd);
    // qk-norm：每個頭（每列 hd 維）獨立做 RMSNorm，增益 qn／kn 寬度 hd（與 llm_scratch 行 249 相同，在 RoPE 之前）
    if (qkNorm) {
      c.qn = await rmsOp(O, q0.slice(), P.qn, T * H, hd); q0 = c.qn.y;
      c.kn = await rmsOp(O, k0.slice(), P.kn, T * kvH, hd); k0 = c.kn.y;
    }
    const q = await O.rope(q0, T, H, hd, 1), k = await O.rope(k0, T, kvH, hd, 1);
    // 因果注意力：query 頭 hh 用 kv 頭 floor(hh/rep)。分數（上三角為 −1e30）→ ops.softmax → 加權和
    const S = new Float64Array(H * T * T), ao = new Float64Array(T * d);
    for (let hh = 0; hh < H; hh++) {
      const kh = Math.floor(hh / rep);
      for (let i = 0; i < T; i++) for (let j = 0; j < T; j++) {
        const idx = (hh * T + i) * T + j;
        if (j > i) { S[idx] = -1e30; continue; }
        let z = 0; for (let u = 0; u < hd; u++) z += q[i * d + hh * hd + u] * k[j * kd + kh * hd + u];
        S[idx] = z * sc;
      }
    }
    const Pm = Float64Array.from(await O.softmax(S, H * T, T));
    for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
      const row = (hh * T + i) * T;
      for (let u = 0; u < hd; u++) { let z = 0; for (let j = 0; j <= i; j++) z += Pm[row + j] * v[j * kd + (Math.floor(hh / rep)) * hd + u]; ao[i * d + hh * hd + u] = z; }
    }
    c.q = q; c.k = k; c.v = v; c.P = Pm; c.ao = ao;
    const o = await mm(be, ao, P.Wo, T, d, d);
    const h1 = new Float64Array(T * d); for (let i = 0; i < h1.length; i++) h1[i] = h[i] + o[i]; c.h1 = h1;
    const n2 = await rmsOp(O, h1, P.n2, T, d); c.n2 = n2;
    const g = await mm(be, n2.y, P.Wg, T, d, F), u = await mm(be, n2.y, P.Wu, T, d, F);
    const sg = Float64Array.from(await O.silu(g));
    const a = new Float64Array(T * F); for (let i = 0; i < a.length; i++) a[i] = sg[i] * u[i];
    const dn = await mm(be, a, P.Wd, T, F, d);
    c.g = g; c.u = u; c.a = a;
    const h2 = new Float64Array(T * d); for (let i = 0; i < h2.length; i++) h2[i] = h1[i] + dn[i];
    h = h2; C.push(c);
  }
  const nf = await rmsOp(O, h, m.nf, T, d);
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
  const { H, d, hd, kvH, kd, F, qkNorm } = dims(m.cfg); const { C, nf, h, inp, T, dl } = cache;
  const rep = H / kvH;
  const sc = 1 / Math.sqrt(hd);
  const grads = zeroGrads(m);
  // 輸出頭（綁定詞嵌入）：dEmbHead = dlᵀ·nf（V×d），dnf = dl·emb
  const dEmbHead = await mm(be, tr(dl, T, m.cfg.V), nf.y, m.cfg.V, T, d);
  const dnfy = await mm(be, dl, m.emb, T, m.cfg.V, d);
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
    // 注意力反向：dV、dQ、dK。kv 頭 kh 的梯度由所有對應的 query 頭加總（GQA）
    const dq = new Float64Array(T * d), dk = new Float64Array(T * kd), dv = new Float64Array(T * kd);
    for (let hh = 0; hh < H; hh++) {
      const kh = Math.floor(hh / rep);
      for (let i = 0; i < T; i++) {
        const row = (hh * T + i) * T; const dP = new Float64Array(i + 1); let dot = 0;
        for (let j = 0; j <= i; j++) {
          let z = 0;
          for (let u = 0; u < hd; u++) { z += dao[i * d + hh * hd + u] * c.v[j * kd + kh * hd + u]; dv[j * kd + kh * hd + u] += c.P[row + j] * dao[i * d + hh * hd + u]; }
          dP[j] = z; dot += z * c.P[row + j];
        }
        for (let j = 0; j <= i; j++) {
          const dS = c.P[row + j] * (dP[j] - dot) * sc;
          for (let u = 0; u < hd; u++) { dq[i * d + hh * hd + u] += dS * c.k[j * kd + kh * hd + u]; dk[j * kd + kh * hd + u] += dS * c.q[i * d + hh * hd + u]; }
        }
      }
    }
    // RoPE 反向，再接 qk-norm 反向（每頭）
    let dq0 = rope(dq, T, H, hd, -1), dk0 = rope(dk, T, kvH, hd, -1);
    if (qkNorm) {
      const bq = rmsBwd(dq0, c.qn.x, P.qn, c.qn.inv, T * H, hd); G.qn = bq.dg; dq0 = bq.dx;
      const bk = rmsBwd(dk0, c.kn.x, P.kn, c.kn.inv, T * kvH, hd); G.kn = bk.dg; dk0 = bk.dx;
    }
    G.Wq = await mm(be, tr(c.n1.y, T, d), dq0, d, T, d);
    G.Wk = await mm(be, tr(c.n1.y, T, d), dk0, d, T, kd);
    G.Wv = await mm(be, tr(c.n1.y, T, d), dv, d, T, kd);
    const dxq = await mm(be, dq0, tr(P.Wq, d, d), T, d, d), dxk = await mm(be, dk0, tr(P.Wk, d, kd), T, kd, d), dxv = await mm(be, dv, tr(P.Wv, d, kd), T, kd, d);
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

// 逐個參數走訪（順序固定：emb、nf、各層的權重名）。fn(p, g, name)
function eachParam(m, g, fn) {
  fn(m.emb, g.emb, 'emb'); fn(m.nf, g.nf, 'nf');
  const keys = layerKeys(m);
  for (let l = 0; l < m.layers.length; l++) for (const k of keys) fn(m.layers[l][k], g.layers[l][k], 'L' + l + '.' + k);
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
  for (const L of m.layers) { const om = {}, ov = {}; for (const k of Object.keys(L)) { om[k] = z(L[k]); ov[k] = z(L[k]); } st.m.layers.push(om); st.v.layers.push(ov); }
  return st;
}
function adamStep(m, g, st, o) {
  const { lr, b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0 } = o;
  st.t++;
  const c1 = 1 - Math.pow(b1, st.t), c2 = 1 - Math.pow(b2, st.t);
  const mvAt = (name) => { const parts = name.split('.'); if (parts.length === 1) return [st.m[name], st.v[name]]; const l = +parts[0].slice(1); return [st.m.layers[l][parts[1]], st.v.layers[l][parts[1]]]; };
  eachParam(m, g, (p, gg, name) => {
    const [mm1, vv] = mvAt(name);
    for (let i = 0; i < p.length; i++) {
      p[i] *= 1 - lr * wd;
      mm1[i] = b1 * mm1[i] + (1 - b1) * gg[i];
      vv[i] = b2 * vv[i] + (1 - b2) * gg[i] * gg[i];
      const mhat = mm1[i] / c1, vhat = vv[i] / c2;
      p[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
    }
  });
}

// 一步訓練：前向、反向、裁剪、AdamW。回傳 { loss, gradNorm, grads }
async function adamStepOps(m, g, st, o, ops) {
  const { lr, b1 = 0.9, b2 = 0.999, eps = 1e-8, wd = 0 } = o;
  st.t++;
  const mvAt = (name) => { const parts = name.split('.'); if (parts.length === 1) return [st.m[name], st.v[name]]; const l = +parts[0].slice(1); return [st.m.layers[l][parts[1]], st.v.layers[l][parts[1]]]; };
  const items = []; eachParam(m, g, (p, gg, name) => items.push({ p, gg, name }));
  for (const it of items) {
    const [mm1, vv] = mvAt(it.name);
    const r = await ops.adamw(it.p, it.gg, mm1, vv, st.t, lr, b1, b2, eps, wd);
    it.p.set(r.p); mm1.set(r.m); vv.set(r.v);
  }
}
async function trainStep(m, tokens, st, o) {
  const be = (o && o.backend) || cpuBackend();
  const ops = (o && o.ops) || null;
  const f = await forward(m, tokens, be, ops);
  const g = await backward(m, f.cache, be);
  const clip = clipGrads(m, g, (o && o.clip) || 1.0);
  if (ops) await adamStepOps(m, g, st, o, ops); else adamStep(m, g, st, o);
  return { loss: f.loss, gradNorm: clip.norm, grads: g };
}

// ---- 檢查點（P1 S5）：沿用 checkpoint_core.js 的 fa-f32 張量容器與 sha256 校驗 ----
// 與 LoRA 檢查點不同：三個張量檔 params.f32、opt_m.f32、opt_v.f32（全參數，檔名固定）。
// 存的是 f32（容器格式），所以續訓與不停的版本只在 f32 捨入的程度內一致，測試以相對誤差判定。
const CK = require('./checkpoint_core.js');

function saveState(m, st, nextBatch, meta) {
  const lp = [], lm = [], lv = [];
  eachParam(m, st.m, (p, _mm, name) => lp.push({ name, data: p, shape: [p.length] }));
  eachParam(m, st.m, (_p, mm1, name) => lm.push({ name, data: mm1, shape: [mm1.length] }));
  eachParam(m, st.v, (_p, vv, name) => lv.push({ name, data: vv, shape: [vv.length] }));
  const files = { 'params.f32': CK.encodeTensors(lp), 'opt_m.f32': CK.encodeTensors(lm), 'opt_v.f32': CK.encodeTensors(lv) };
  const sha256 = {}; Object.keys(files).forEach((f) => { sha256[f] = CK.sha256(files[f]); });
  const ckpt = {
    format: CK.FORMAT, version: CK.VERSION, step: st.t, next_batch: nextBatch, dtype: 'float32',
    cfg: m.cfg, optimizer: { name: 'adamw', lr: meta.lr, b1: 0.9, b2: 0.999, eps: 1e-8, wd: meta.wd, clip: meta.clip },
    sha256, produced_by: (meta && meta.produced_by) || 'full_param_train.js',
  };
  return { ckpt, files };
}

// 載入：先校驗 sha256 與格式，不符就拒絕（不寫入任何狀態）
function loadState(m, st, cp) {
  const bad = [];
  Object.keys(cp.ckpt.sha256 || {}).forEach((f) => { if (!cp.files[f]) bad.push(f + '（檔案不見）'); else if (CK.sha256(cp.files[f]) !== cp.ckpt.sha256[f]) bad.push(f + '（sha256 不符）'); });
  if (cp.ckpt.format !== CK.FORMAT || cp.ckpt.version !== CK.VERSION) bad.push('格式或版本不合');
  if (bad.length) throw new Error('檢查點拒絕載入：' + bad.join('；'));
  const toMap = (buf) => { const mp = new Map(); CK.decodeTensors(buf).forEach((t) => mp.set(t.name, t.data)); return mp; };
  const P = toMap(cp.files['params.f32']), M = toMap(cp.files['opt_m.f32']), V = toMap(cp.files['opt_v.f32']);
  eachParam(m, st.m, (p, _mm, name) => { const src = P.get(name); if (!src || src.length !== p.length) throw new Error('參數 ' + name + ' 形狀不符'); p.set(src); });
  eachParam(m, st.m, (_p, mm1, name) => mm1.set(M.get(name)));
  eachParam(m, st.v, (_p, vv, name) => vv.set(V.get(name)));
  st.t = cp.ckpt.step;
  return { nextBatch: cp.ckpt.next_batch };
}

module.exports = { gpuOpsFrom, CPU_OPS, fromInit, zeroGrads, forward, backward, clipGrads, adamInit, adamStep, trainStep, rmsFwd, rmsBwd, rope, tr, cpuBackend, cudawebBackend, layerKeys, eachParam, EPS, saveState, loadState, dims };
