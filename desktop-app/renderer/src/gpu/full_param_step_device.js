'use strict';
// 全參數整步（密集 transformer）：所有線性層、嵌入、輸出頭、RMSNorm 增益都求權重梯度，全部留在 GPU。
// 以 train_step_device.js 的 trainStepDevice 為底（不改它）。差別：
//   · 基底權重可訓練（dW = Xᵀ·dY，用 matmul 的 transA 旗標；不再是 LoRA）；
//   · 嵌入查表用 one-hot 矩陣乘（不經 JS 陣列）；嵌入梯度 = onehotᵀ·dh（＋輸出頭梯度）；
//   · RMSNorm 增益梯度 = 列加總(dy ∘ x̂)，x̂ = rmsnorm(x, 1)（用矩陣乘加上一列 1，不新增核心）；
//   · 梯度裁剪在 GPU 上做：總平方和 → 裁剪係數（一個新的純量核心）→ 梯度乘係數；
//   · AdamW 沿用 train_fused.js 的 WGSL_ADAMW_ACCUM（已驗證的 decoupled weight decay）。
// 狀態（參數、m、v）是常駐的 GPU 緩衝區（不在批次的暫存池裡），AdamW 原地更新；步末只讀回損失列與梯度平方和。
// 限制（明寫）：dense（kvH＝H、無 qk-norm），f32；GQA 與 qk-norm 的 GPU 路徑尚未做（attn 核心假設 H 個 kv 頭）。
const TS = require('./train_step_device.js');
const TF = require('./train_fused.js');

const USAGE_STORAGE = 0x80, USAGE_COPY_SRC = 0x4, USAGE_COPY_DST = 0x8;
const f32 = Math.fround;

// 裁剪係數核心：coef = min(1, maxNorm / (√tot + 1e-6))；tot 是總平方和（單一元素緩衝）
const WGSL_CLIP_COEF = `
struct P { maxn: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<storage, read> tot: array<f32>;
@group(0) @binding(1) var<storage, read_write> coef: array<f32>;
@group(0) @binding(2) var<uniform> u: P;
// @kernel clip_coef
@compute @workgroup_size(1)
fn main() {
  let nrm = sqrt(tot[0]);
  coef[0] = min(1.0, u.maxn / (nrm + 1e-6));
}
`;

// 批次運算（與 train_step_device.js 的 extend 相同的核心，這裡重新掛上以免改動它）
function extend(b) {
  const r = {};
  r.attnFwd = (q, k, v, T, H, hd) => {
    const ao = b.alloc(T * H * hd), pm = b.alloc(H * T * T);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    b.dispatchRaw(TS.WGSL_ATTN_FWD, [q.buf, k.buf, v.buf, ao.buf, pm.buf], uni, Math.ceil(T * H / 64));
    return { ao: ao, pm: pm };
  };
  r.attnBwd = (dao, q, k, v, ao, pm, T, H, hd) => {
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = 1 / Math.sqrt(hd);
    const dk = b.alloc(T * H * hd), dv = b.alloc(T * H * hd), dq = b.alloc(T * H * hd);
    b.dispatchRaw(TS.WGSL_ATTN_BWD_KV, [q.buf, v.buf, dao.buf, pm.buf, ao.buf, dk.buf, dv.buf], uni, Math.ceil(T * H / 64));
    b.dispatchRaw(TS.WGSL_ATTN_BWD_Q, [k.buf, v.buf, dao.buf, pm.buf, ao.buf, dq.buf], uni, Math.ceil(T * H / 64));
    return { dq: dq, dk: dk, dv: dv };
  };
  r.rmsnormBwd = (dy, x, g, T, d, eps) => {
    const dx = b.alloc(T * d);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([T, d]); new Float32Array(uni, 8, 1)[0] = eps;
    b.dispatchRaw(TS.WGSL_RMS_BWD, [dy.buf, x.buf, g.buf, dx.buf], uni, Math.ceil(T / 64));
    return dx;
  };
  r.mlpBwd = (da, g, u, n) => {
    const dg = b.alloc(n), du = b.alloc(n);
    const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = n;
    b.dispatchRaw(TS.WGSL_MLP_BWD, [da.buf, g.buf, u.buf, dg.buf, du.buf], uni, Math.ceil(n / 64));
    return { dg: dg, du: du };
  };
  r.clipCoef = (tot, maxNorm) => {
    const coef = b.alloc(1);
    const uni = new ArrayBuffer(16); new Float32Array(uni, 0, 1)[0] = maxNorm;
    b.dispatchRaw(WGSL_CLIP_COEF, [tot.buf, coef.buf], uni, 1);
    return coef;
  };
  // AdamW：p、m、v 是常駐緩衝區（原地更新）；g 已平均與裁剪；fl 同 train_fused 的佈局
  r.adamw = (p, g, m, v, n, fl) => {
    const uni = new ArrayBuffer(48); new Uint32Array(uni, 0, 2).set([n, 1]); new Float32Array(uni, 8, 10).set(fl);
    b.dispatchRaw(TF.WGSL_ADAMW_ACCUM, [p.buf, g.buf, m.buf, v.buf], uni, Math.ceil(n / 64));
  };
  return Object.assign(r, { b: b });
}

// 常駐狀態：每個可訓練張量一個 GPU 緩衝區（參數、m、v）。名稱與 full_param_train.js 的 eachParam 相同。
function paramList(cfg) {
  const { V, d, L, F, H } = cfg; const hd = d / H;
  const list = [['emb', V * d], ['nf', d]];
  for (let l = 0; l < L; l++) {
    list.push(['L' + l + '.n1', d], ['L' + l + '.n2', d], ['L' + l + '.Wq', d * d], ['L' + l + '.Wk', d * d], ['L' + l + '.Wv', d * d], ['L' + l + '.Wo', d * d], ['L' + l + '.Wg', d * F], ['L' + l + '.Wu', d * F], ['L' + l + '.Wd', F * d]);
  }
  void hd;
  return list;
}
function makeResidentState(device, cfg, init) {
  const mk = (n, data) => {
    const buf = device.createBuffer({ size: Math.max(4, n * 4), usage: USAGE_STORAGE | USAGE_COPY_SRC | USAGE_COPY_DST });
    if (data) device.queue.writeBuffer(buf, 0, data instanceof Float32Array ? data : Float32Array.from(data));
    return { buf: buf, n: n };
  };
  const P = {}, M = {}, Vv = {};
  for (const [name, n] of paramList(cfg)) {
    const src = init ? initFor(init, name) : null;
    P[name] = mk(n, src);
    M[name] = mk(n, null); Vv[name] = mk(n, null);
  }
  // 常數一：長度足夠的 1，給列加總與廣播用（只讀）
  const maxN = Math.max(...paramList(cfg).map((x) => x[1]), cfg.T * cfg.d, cfg.T * cfg.F, cfg.T * cfg.V);
  const ones = mk(maxN, new Float32Array(maxN).fill(1));
  // RoPE 排列矩陣（d×d，0/1）：把 rotate-half 的配對（i 與 i+hd/2）換成核心的交錯配對（2i、2i+1）。
  // 乘以排列矩陣只搬資料、不做算術（0 與 1 的乘加是精確的），所以結果與 rotate-half 逐位元等價。
  const perm = mk(cfg.d * cfg.d, permMatrix(cfg.d, cfg.H));
  return { P: P, M: M, V: Vv, ones: ones, perm: perm, t: 0, cfg: cfg };
}
// perm[src*d + j] = 1，其中 j 是交錯位置、src 是 rotate-half 來源位置（每個頭內）
function permMatrix(d, H) {
  const hd = d / H, half = hd / 2, Pm = new Float32Array(d * d);
  for (let h = 0; h < H; h++) for (let i = 0; i < half; i++) {
    Pm[(h * hd + i) * d + (h * hd + 2 * i)] = 1;
    Pm[(h * hd + i + half) * d + (h * hd + 2 * i + 1)] = 1;
  }
  return Pm;
}
function initFor(init, name) {
  if (name === 'emb') return init.emb;
  if (name === 'nf') return init.nf;
  const mm = /^L(\d+)\.(\w+)$/.exec(name); return init.layers[+mm[1]][mm[2]];
}

// 一步（K 條序列）。o: { nn, device, state, seqs, lr, wd, clip }
// 回傳 { loss, gradNorm, submits, dispatches, ms }。參數與狀態在 GPU 內原地更新，不讀回。
async function fullParamStepDevice(o) {
  const { nn, device, state: S, seqs, lr, wd = 0, clip = 1.0 } = o;
  const cfg = S.cfg; const { V, d, L, H, F } = cfg; const hd = d / H; const K = seqs.length;
  const B = nn.createBatch(device), X = extend(B);
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const ONES = (n) => ({ buf: S.ones.buf, n: n });
  const onesRow = (T) => ({ buf: S.ones.buf, n: T });
  // 加權：column-sum(dy ∘ x̂)，x̂ = rmsnorm(x, 1)
  const gainGrad = (dy, x, T) => {
    const y1 = B.rmsnorm(x, { buf: S.ones.buf, n: d }, T, d, 1e-6);
    return B.matmul(onesRow(T), B.mul(dy, y1), 1, T, d);
  };
  const gacc = {}; const accum = (name, h) => { gacc[name] = gacc[name] ? B.axpy(gacc[name], h, 1) : h; };
  // rotate-half RoPE：排列 → 交錯 RoPE 核心（dir）→ 反排列（transB 即乘排列矩陣的轉置＝逆）
  const rp = (x, dir, T) => { const xp = B.matmul(x, S.perm, T, d, d); const z = B.rope(xp, T, H, hd, dir); return B.matmul(z, S.perm, T, d, d, { transB: true }); };
  const lossRows = [];
  for (const tokens of seqs) {
    const T = tokens.length - 1, inp = tokens.slice(0, T), tgt = tokens.slice(1);
    // 嵌入查表：one-hot(T×V) · emb(V×d)（one-hot 是輸入，不是中間結果）
    const oh = new Float32Array(T * V); for (let i = 0; i < T; i++) oh[i * V + inp[i]] = 1;
    const ohH = B.upload(oh);
    let h = B.matmul(ohH, S.P['emb'], T, V, d);
    const cache = [];
    for (let l = 0; l < L; l++) {
      const pre = 'L' + l + '.'; const P = (k) => S.P[pre + k], c = { hIn: h };
      c.n1 = B.rmsnorm(h, P('n1'), T, d, 1e-6);
      const q0 = B.matmul(c.n1, P('Wq'), T, d, d), k0 = B.matmul(c.n1, P('Wk'), T, d, d), v0 = B.matmul(c.n1, P('Wv'), T, d, d);
      c.q = rp(q0, 1, T); c.k = rp(k0, 1, T); c.v = v0;
      const at = X.attnFwd(c.q, c.k, c.v, T, H, hd); c.ao = at.ao; c.pm = at.pm;
      const o2 = B.matmul(c.ao, P('Wo'), T, d, d);
      c.h1 = B.axpy(h, o2, 1);
      c.n2 = B.rmsnorm(c.h1, P('n2'), T, d, 1e-6);
      c.g = B.matmul(c.n2, P('Wg'), T, d, F); c.u = B.matmul(c.n2, P('Wu'), T, d, F);
      c.a = B.mul(B.silu(c.g), c.u);
      const dn = B.matmul(c.a, P('Wd'), T, F, d);
      h = B.axpy(c.h1, dn, 1);
      cache.push(c);
    }
    // 頭：norm → logits（與嵌入共用）→ 交叉熵（dl 已含 1/T）
    const nfH = S.P['nf'], embH = S.P['emb'];
    const nf = B.rmsnorm(h, nfH, T, d, 1e-6);
    const logits = B.matmul(nf, embH, T, d, V, { transB: true });
    const ce = B.crossEntropy(logits, B.uploadU32(Uint32Array.from(tgt)), T, V, 1 / T);
    lossRows.push({ rows: ce.rows, T: T });
    accum('nf', gainGrad(B.matmul(ce.dl, embH, T, V, d), h, T));
    accum('emb', B.matmul(ce.dl, nf, V, T, d, { transA: true }));
    let dh = X.rmsnormBwd(B.matmul(ce.dl, embH, T, V, d), h, nfH, T, d, 1e-6);
    for (let l = L - 1; l >= 0; l--) {
      const pre = 'L' + l + '.'; const P = (k) => S.P[pre + k], c = cache[l];
      const da = B.matmul(dh, P('Wd'), T, d, F, { transB: true });
      accum(pre + 'Wd', B.matmul(c.a, dh, F, T, d, { transA: true }));
      const mg = X.mlpBwd(da, c.g, c.u, T * F);
      accum(pre + 'Wg', B.matmul(c.n2, mg.dg, d, T, F, { transA: true }));
      accum(pre + 'Wu', B.matmul(c.n2, mg.du, d, T, F, { transA: true }));
      const dn2 = B.axpy(B.matmul(mg.dg, P('Wg'), T, F, d, { transB: true }), B.matmul(mg.du, P('Wu'), T, F, d, { transB: true }), 1);
      accum(pre + 'n2', gainGrad(dn2, c.h1, T));
      const dh1 = B.axpy(X.rmsnormBwd(dn2, c.h1, P('n2'), T, d, 1e-6), dh, 1);
      accum(pre + 'Wo', B.matmul(c.ao, dh1, d, T, d, { transA: true }));
      const dao = B.matmul(dh1, P('Wo'), T, d, d, { transB: true });
      const ab = X.attnBwd(dao, c.q, c.k, c.v, c.ao, c.pm, T, H, hd);
      const dq0 = rp(ab.dq, -1, T), dk0 = rp(ab.dk, -1, T), dv0 = ab.dv;
      accum(pre + 'Wq', B.matmul(c.n1, dq0, d, T, d, { transA: true }));
      accum(pre + 'Wk', B.matmul(c.n1, dk0, d, T, d, { transA: true }));
      accum(pre + 'Wv', B.matmul(c.n1, dv0, d, T, d, { transA: true }));
      const dn1 = B.axpy(B.axpy(B.matmul(dq0, P('Wq'), T, d, d, { transB: true }), B.matmul(dk0, P('Wk'), T, d, d, { transB: true }), 1), B.matmul(dv0, P('Wv'), T, d, d, { transB: true }), 1);
      accum(pre + 'n1', gainGrad(dn1, c.hIn, T));
      dh = B.axpy(X.rmsnormBwd(dn1, c.hIn, P('n1'), T, d, 1e-6), dh1, 1);
    }
    // 嵌入輸入梯度：onehotᵀ · dh
    accum('emb', B.matmul(ohH, dh, V, T, d, { transA: true }));
  }
  // 平均（K 條序列）
  const names = Object.keys(gacc);
  const gavg = {}; for (const nm of names) gavg[nm] = B.scal(gacc[nm], 1 / K);
  // 總平方和：每個張量 ‖g‖² = onesᵀ·(g∘g)（1×n · n×1）
  let total = null;
  for (const nm of names) {
    const n = S.P[nm].n;
    const s = B.matmul(ONES(n), B.mul(gavg[nm], gavg[nm]), 1, n, 1);
    total = total ? B.axpy(total, s, 1) : s;
  }
  const coef = X.clipCoef(total, clip);
  // 梯度乘裁剪係數：廣播 coef（n×1 · 1×1 → n×1）後逐元素相乘
  const t = S.t + 1, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
  const fl = [lr, b1, 1 - b1, b2, 1 - b2, eps, wd, c1, c2, 1].map(f32);
  for (const nm of names) {
    const n = S.P[nm].n;
    const bc = B.matmul(ONES(n), coef, n, 1, 1);
    X.adamw(S.P[nm], B.mul(gavg[nm], bc), S.M[nm], S.V[nm], n, fl);
  }
  // 步末唯一讀回：損失列與總平方和
  const specs = lossRows.map((r) => [r.rows, r.T]); specs.push([total, 1]);
  const outs = await B.read(specs);
  let loss = 0; lossRows.forEach((r, k) => { let sr = 0; for (let i = 0; i < r.T; i++) sr += outs[k][i]; loss += (sr / r.T) / K; });
  S.t = t;
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  return { loss: loss, gradNorm: Math.sqrt(outs[lossRows.length][0]), ms: ms, stats: B.stats || null };
}

module.exports = { fullParamStepDevice, makeResidentState, paramList, WGSL_CLIP_COEF, extend };
