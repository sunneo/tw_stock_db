// 純 JS 的小型 transformer LoRA 參考實作（前向＋手寫反向），給「網頁版訓練 LoRA」研究（DESIGN.TODO.offline-training-studio.md §5.6）當對拍基準。
// 結構對齊 Qwen3 的形狀：RMSNorm、因果注意力（含 RoPE）、SiLU 閘控 MLP、綁定詞嵌入輸出頭；LoRA 加在 q/k/v/o。基底凍結，只對 A/B 求梯度。
// 這份同時是 WGSL 反向引擎「每個算子要算什麼」的規格：每個函式的反向公式就是之後著色器要實作的內容。
// f32 選項：每個算子輸出都 Math.fround，模擬 WebGPU fp32 的捨入（不含累加順序差異），用來估 fp32 對 fp64 的相對誤差。
'use strict';

function makeRng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(rng) { return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()); }
function mat(n, rng, sd) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = randn(rng) * sd; return a; }

function makeModel(cfg, seed) {
    const { V, d, L, H, F, r } = cfg; const rng = makeRng(seed);
    const m = { cfg, emb: mat(V * d, rng, 0.15), nf: new Float64Array(d).fill(1), layers: [], lora: [] };
    for (let l = 0; l < L; l++) {
        m.layers.push({ n1: new Float64Array(d).fill(1), n2: new Float64Array(d).fill(1),
            Wq: mat(d * d, rng, 1 / Math.sqrt(d)), Wk: mat(d * d, rng, 1 / Math.sqrt(d)), Wv: mat(d * d, rng, 1 / Math.sqrt(d)), Wo: mat(d * d, rng, 1 / Math.sqrt(d)),
            Wg: mat(d * F, rng, 1 / Math.sqrt(d)), Wu: mat(d * F, rng, 1 / Math.sqrt(d)), Wd: mat(F * d, rng, 1 / Math.sqrt(F)) });
        const lo = {}; for (const k of ['q', 'k', 'v', 'o']) lo[k] = { A: mat(d * r, rng, 1 / Math.sqrt(d)), B: mat(r * d, rng, 0.05) };
        m.lora.push(lo);
    }
    return m;
}

// C(m×n) = A(m×k) · B(k×n)
function mm(A, B, m, k, n, R) { const C = new Float64Array(m * n); for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) { const a = A[i * k + p]; if (a === 0) continue; const bo = p * n, co = i * n; for (let j = 0; j < n; j++) C[co + j] += a * B[bo + j]; } if (R) for (let i = 0; i < C.length; i++) C[i] = R(C[i]); return C; }
// C(m×n) = A(m×k) · Bᵀ，B 存成 n×k
function mmBt(A, B, m, k, n, R) { const C = new Float64Array(m * n); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let p = 0; p < k; p++) s += A[i * k + p] * B[j * k + p]; C[i * n + j] = R ? R(s) : s; } return C; }
// C(m×n) = Aᵀ · B，A 存成 k×m
function mmAt(A, B, m, k, n, R) { const C = new Float64Array(m * n); for (let p = 0; p < k; p++) for (let i = 0; i < m; i++) { const a = A[p * m + i]; if (a === 0) continue; for (let j = 0; j < n; j++) C[i * n + j] += a * B[p * n + j]; } if (R) for (let i = 0; i < C.length; i++) C[i] = R(C[i]); return C; }

function rmsFwd(x, g, T, d, R) { const y = new Float64Array(T * d), inv = new Float64Array(T); for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < d; i++) s += x[t * d + i] ** 2; const iv = 1 / Math.sqrt(s / d + 1e-6); inv[t] = iv; for (let i = 0; i < d; i++) { const v = x[t * d + i] * iv * g[i]; y[t * d + i] = R ? R(v) : v; } } return { y, inv }; }
function rmsBwd(dy, x, g, inv, T, d) { const dx = new Float64Array(T * d); for (let t = 0; t < T; t++) { let md = 0; for (let i = 0; i < d; i++) md += dy[t * d + i] * g[i] * x[t * d + i] * inv[t]; md /= d; for (let i = 0; i < d; i++) { const xh = x[t * d + i] * inv[t]; dx[t * d + i] = inv[t] * (dy[t * d + i] * g[i] - xh * md); } } return dx; }

// RoPE：每個 head 內相鄰兩維為一對；dir=-1 即反向（轉置旋轉）
function rope(x, T, H, hd, dir) { const y = new Float64Array(x.length); const d = H * hd; for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < hd / 2; i++) { const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th); const o = t * d + h * hd + 2 * i; const a = x[o], b = x[o + 1]; y[o] = a * c - b * s; y[o + 1] = a * s + b * c; } return y; }

const sig = (x) => 1 / (1 + Math.exp(-x));

function loraLin(x, W, lo, s, T, din, dout, R, cache) {
    const xA = mm(x, lo.A, T, din, lo.A.length / din, R); const r = lo.A.length / din;
    const base = mm(x, W, T, din, dout, R), br = mm(xA, lo.B, T, r, dout, R);
    const y = new Float64Array(T * dout); for (let i = 0; i < y.length; i++) { const v = base[i] + s * br[i]; y[i] = R ? R(v) : v; }
    cache.xA = xA; return y;
}
function loraLinBwd(dy, x, W, lo, s, xA, T, din, dout, grads, key) {
    const r = lo.A.length / din;
    const dB = mmAt(xA, dy, r, T, dout); for (let i = 0; i < dB.length; i++) dB[i] *= s;
    const dxA = mmBt(dy, lo.B, T, dout, r); for (let i = 0; i < dxA.length; i++) dxA[i] *= s;
    const dA = mmAt(x, dxA, din, T, r);
    grads[key] = { A: dA, B: dB };
    const dx = mmBt(dy, W, T, dout, din), dx2 = mmBt(dxA, lo.A, T, r, din);
    for (let i = 0; i < dx.length; i++) dx[i] += dx2[i];
    return dx;
}

// 回傳 { loss, grads }；grads[l] = { q:{A,B}, k, v, o }
function lossAndGrads(m, tokens, opts) {
    opts = opts || {}; const R = opts.f32 ? Math.fround : null; const { V, d, L, H, F, r } = m.cfg; const hd = d / H; const s = (m.cfg.alpha || r) / r;
    const T = tokens.length - 1; const inp = tokens.slice(0, T), tgt = tokens.slice(1);
    let h = new Float64Array(T * d); for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) h[t * d + i] = m.emb[inp[t] * d + i];
    const C = [];
    for (let l = 0; l < L; l++) {
        const P = m.layers[l], lo = m.lora[l], c = { h0: h };
        const n1 = rmsFwd(h, P.n1, T, d, R); c.n1 = n1; const cq = {}, ck = {}, cv = {}, co = {};
        const q0 = loraLin(n1.y, P.Wq, lo.q, s, T, d, d, R, cq), k0 = loraLin(n1.y, P.Wk, lo.k, s, T, d, d, R, ck), v = loraLin(n1.y, P.Wv, lo.v, s, T, d, d, R, cv);
        const q = rope(q0, T, H, hd, 1), k = rope(k0, T, H, hd, 1); Object.assign(c, { cq, ck, cv, co, q, k, v });
        const Pm = new Float64Array(H * T * T), ao = new Float64Array(T * d), sc = 1 / Math.sqrt(hd);
        for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
            let mx = -Infinity; const row = (hh * T + i) * T;
            for (let j = 0; j <= i; j++) { let z = 0; for (let u = 0; u < hd; u++) z += q[i * d + hh * hd + u] * k[j * d + hh * hd + u]; z *= sc; Pm[row + j] = z; if (z > mx) mx = z; }
            let sum = 0; for (let j = 0; j <= i; j++) { Pm[row + j] = Math.exp(Pm[row + j] - mx); sum += Pm[row + j]; }
            for (let j = 0; j <= i; j++) Pm[row + j] = R ? R(Pm[row + j] / sum) : Pm[row + j] / sum;
            for (let u = 0; u < hd; u++) { let z = 0; for (let j = 0; j <= i; j++) z += Pm[row + j] * v[j * d + hh * hd + u]; ao[i * d + hh * hd + u] = R ? R(z) : z; }
        }
        c.P = Pm; c.ao = ao;
        const o = loraLin(ao, P.Wo, lo.o, s, T, d, d, R, co);
        const h1 = new Float64Array(T * d); for (let i = 0; i < h1.length; i++) h1[i] = R ? R(h[i] + o[i]) : h[i] + o[i]; c.h1 = h1;
        const n2 = rmsFwd(h1, P.n2, T, d, R); c.n2 = n2;
        const g = mm(n2.y, P.Wg, T, d, F, R), u = mm(n2.y, P.Wu, T, d, F, R), a = new Float64Array(T * F);
        for (let i = 0; i < a.length; i++) { const v2 = g[i] * sig(g[i]) * u[i]; a[i] = R ? R(v2) : v2; }
        c.g = g; c.u = u; c.a = a;
        const dn = mm(a, P.Wd, T, F, d, R); const h2 = new Float64Array(T * d); for (let i = 0; i < h2.length; i++) h2[i] = R ? R(h1[i] + dn[i]) : h1[i] + dn[i];
        h = h2; C.push(c);
    }
    const nf = rmsFwd(h, m.nf, T, d, R); const logits = mmBt(nf.y, m.emb, T, d, V, R);
    let loss = 0; const dl = new Float64Array(T * V);
    for (let t = 0; t < T; t++) { let mx = -Infinity; for (let j = 0; j < V; j++) if (logits[t * V + j] > mx) mx = logits[t * V + j]; let sum = 0; for (let j = 0; j < V; j++) { dl[t * V + j] = Math.exp(logits[t * V + j] - mx); sum += dl[t * V + j]; } loss += -Math.log(dl[t * V + tgt[t]] / sum); for (let j = 0; j < V; j++) dl[t * V + j] = (dl[t * V + j] / sum - (j === tgt[t] ? 1 : 0)) / T; }
    loss /= T; if (opts.noGrad) return { loss };
    // 反向
    let dh = rmsBwd(mm(dl, m.emb, T, V, d), h, m.nf, nf.inv, T, d); const grads = new Array(L);
    for (let l = L - 1; l >= 0; l--) {
        const P = m.layers[l], lo = m.lora[l], c = C[l]; const G = {};
        const da = mmBt(dh, P.Wd, T, d, F); const dg = new Float64Array(T * F), du = new Float64Array(T * F);
        for (let i = 0; i < da.length; i++) { const sg = sig(c.g[i]); du[i] = da[i] * c.g[i] * sg; dg[i] = da[i] * c.u[i] * sg * (1 + c.g[i] * (1 - sg)); }
        const dn2 = mmBt(dg, P.Wg, T, F, d), dn2b = mmBt(du, P.Wu, T, F, d); for (let i = 0; i < dn2.length; i++) dn2[i] += dn2b[i];
        const dh1 = rmsBwd(dn2, c.h1, P.n2, c.n2.inv, T, d); for (let i = 0; i < dh1.length; i++) dh1[i] += dh[i];
        const dao = loraLinBwd(dh1, c.ao, P.Wo, lo.o, s, c.co.xA, T, d, d, G, 'o');
        const dq = new Float64Array(T * d), dk = new Float64Array(T * d), dv = new Float64Array(T * d), sc = 1 / Math.sqrt(hd);
        for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
            const row = (hh * T + i) * T; const dP = new Float64Array(i + 1); let dot = 0;
            for (let j = 0; j <= i; j++) { let z = 0; for (let u = 0; u < hd; u++) { z += dao[i * d + hh * hd + u] * c.v[j * d + hh * hd + u]; dv[j * d + hh * hd + u] += c.P[row + j] * dao[i * d + hh * hd + u]; } dP[j] = z; dot += z * c.P[row + j]; }
            for (let j = 0; j <= i; j++) { const dS = c.P[row + j] * (dP[j] - dot) * sc; for (let u = 0; u < hd; u++) { dq[i * d + hh * hd + u] += dS * c.k[j * d + hh * hd + u]; dk[j * d + hh * hd + u] += dS * c.q[i * d + hh * hd + u]; } }
        }
        const dq0 = rope(dq, T, H, hd, -1), dk0 = rope(dk, T, H, hd, -1);
        const dx = loraLinBwd(dq0, c.n1.y, P.Wq, lo.q, s, c.cq.xA, T, d, d, G, 'q');
        const dx2 = loraLinBwd(dk0, c.n1.y, P.Wk, lo.k, s, c.ck.xA, T, d, d, G, 'k'), dx3 = loraLinBwd(dv, c.n1.y, P.Wv, lo.v, s, c.cv.xA, T, d, d, G, 'v');
        for (let i = 0; i < dx.length; i++) dx[i] += dx2[i] + dx3[i];
        const dh0 = rmsBwd(dx, c.h0, P.n1, c.n1.inv, T, d); for (let i = 0; i < dh0.length; i++) dh0[i] += dh1[i];
        dh = dh0; grads[l] = G;
    }
    return { loss, grads };
}

function adamInit(m) { const z = []; for (const lo of m.lora) { const o = {}; for (const k of ['q', 'k', 'v', 'o']) o[k] = { A: { m: new Float64Array(lo[k].A.length), v: new Float64Array(lo[k].A.length) }, B: { m: new Float64Array(lo[k].B.length), v: new Float64Array(lo[k].B.length) } }; z.push(o); } return { t: 0, z }; }
function adamStep(m, grads, st, lr) {
    st.t++; const b1 = 0.9, b2 = 0.999, e = 1e-8, c1 = 1 - Math.pow(b1, st.t), c2 = 1 - Math.pow(b2, st.t);
    for (let l = 0; l < m.lora.length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
        const p = m.lora[l][k][w], g = grads[l][k][w], s = st.z[l][k][w];
        for (let i = 0; i < p.length; i++) { s.m[i] = b1 * s.m[i] + (1 - b1) * g[i]; s.v[i] = b2 * s.v[i] + (1 - b2) * g[i] * g[i]; p[i] -= lr * (s.m[i] / c1) / (Math.sqrt(s.v[i] / c2) + e); }
    }
}

// 0.6B（Qwen3-0.6B 形狀）的計算量與記憶體估算（純算術，不是實測）
function estimate06B(T, rank) {
    const L = 28, d = 1024, F = 3072, H = 16, KV = 8, hd = 128, V = 151936;
    const attnP = d * (H * hd) + 2 * d * (KV * hd) + (H * hd) * d, mlpP = 3 * d * F;
    const perLayer = attnP + mlpP, body = L * perLayer, emb = V * d;
    const fwdFlops = 2 * (body + emb), trainFlops = 2 * fwdFlops;           // 前向＋只對輸入求梯度（基底凍結，不算 dW）
    const ckptFlops = 3 * fwdFlops;                                          // 逐層重算（梯度檢查點）多一次前向
    const loraP = L * (rank * (d + H * hd) + 2 * rank * (d + KV * hd) + rank * (H * hd + d));
    const actPerLayer = T * (8 * d + 3 * F) * 4 + H * T * T * 4;             // 不做檢查點時每層需保存的 f32 激活（粗估）
    return { body, emb, loraParams: loraP, fwdFlopsPerTok: fwdFlops, trainFlopsPerTok: trainFlops, ckptFlopsPerTok: ckptFlops,
        weightsF16MB: (body + emb) * 2 / 1048576, weightsQ8MB: (body + emb) * 1 / 1048576,
        actNoCkptMB: actPerLayer * L / 1048576, actCkptMB: (T * d * 4 * L + actPerLayer) / 1048576, logitsF32MB: T * V * 4 / 1048576,
        adamStateMB: loraP * 4 * 3 / 1048576 };
}

module.exports = { makeModel, lossAndGrads, adamInit, adamStep, estimate06B, makeRng };
