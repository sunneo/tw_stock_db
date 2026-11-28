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

// RoPE：rotate-half（與 llm_scratch、Qwen 推論一致）：每個 head 內第 i 維與第 i+hd/2 維成一對；dir=-1 即反向（轉置旋轉）。
// 與 nn_ops.ropeRef 相同（ROPE_CONVENTION = 'rotate-half-v1'）。舊版交錯成對的 LoRA 檢查點不能再載入（見 ROPE_CONVENTION 檢查）。
const ROPE_CONVENTION = 'rotate-half-v1';
function rope(x, T, H, hd, dir) { const y = new Float64Array(x.length); const d = H * hd, half = hd / 2; for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < half; i++) { const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th); const o = t * d + h * hd; const a = x[o + i], b = x[o + i + half]; y[o + i] = a * c - b * s; y[o + i + half] = b * c + a * s; } return y; }

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

// ===== 非同步變體（給 GPU 後端用；同步路徑上面一字不改，當退路與參考實作）=====
// 只有矩陣乘（前向與反向的全部 matmul／轉置相乘）改成 await be.matmul(A,B,m,k,n)；
// RMSNorm、softmax、RoPE、SiLU、注意力的逐元素部分仍在 CPU（Float64）。
// be.matmul 回傳 Float64Array（或可轉成的陣列）。轉置相乘在 CPU 先轉成普通相乘再送出，因此後端只需要實作一個 matmul。
// 注意：目前這裡沒有做「一個訓練步的多個核心批次提交、中間結果留在 GPU」——每次 matmul 仍是一次往返，這是尚未完成的部分。
function cpuMatmulBackend() {
    return { id: 'cpu-js', layer: 'cpu-js', async matmul(A, B, m, k, n) { return mm(A, B, m, k, n, null); } };
}
function tr2(X, rows, cols) { const Y = new Float64Array(rows * cols); for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) Y[j * rows + i] = X[i * cols + j]; return Y; }
async function amm(be, A, B, m, k, n) { return be.matmul(A, B, m, k, n); }                       // C = A·B
// 後端有 transFlags（cudaweb）就直接用 O5 平鋪核心的轉置旗標，不做 CPU 轉置複製；否則照舊複製（CPU 路徑不變）。
async function ammBt(be, A, B, m, k, n) { return be.transFlags ? be.matmul(A, B, m, k, n, { transB: true }) : be.matmul(A, tr2(B, n, k), m, k, n); }  // C = A·Bᵀ，B 存成 n×k
async function ammAt(be, A, B, m, k, n) { return be.transFlags ? be.matmul(A, B, m, k, n, { transA: true }) : be.matmul(tr2(A, k, m), B, m, k, n); }  // C = Aᵀ·B，A 存成 k×m

// 批次版（O8 前向）：be 有 matmulMany 就把互不相依的矩陣乘放進一次提交；沒有就逐個 be.matmul（CPU 路徑不變）。
// items：[[A, B, m, k, n], ...]，回傳與 items 同序的結果陣列。
async function ammMany(be, items) {
    if (be.matmulMany) return be.matmulMany(items);
    const out = []; for (const it of items) out.push(await be.matmul(it[0], it[1], it[2], it[3], it[4], it[5])); return out;
}
// 與 loraLinA 的算式完全相同（xA＝x·A；base＝x·W；br＝xA·B；y＝base＋s·br），但同一階段的矩陣乘一起送出：
// 第一階段（只依賴 x）：每個投影的 xA 與 base；第二階段：每個投影的 br。specs：[{ W, lo, cache, dout }]
async function loraLinManyA(be, x, specs, s, T, din) {
    // 後端有 loraFwdMany（O8 每群組一次提交）：整組投影在裝置上完成，回讀 y 與 xA
    if (be.loraFwdMany) {
        const R = await be.loraFwdMany(specs.map((sp) => ({ x: x, W: sp.W, A: sp.lo.A, B: sp.lo.B, s: s, T: T, din: din, dout: sp.dout })));
        return specs.map((sp, i) => { sp.cache.xA = R[i].xA; return R[i].y; });
    }
    const items1 = [];
    for (const sp of specs) { const r = sp.lo.A.length / din; items1.push([x, sp.lo.A, T, din, r], [x, sp.W, T, din, sp.dout]); }
    const r1 = await ammMany(be, items1);
    const items2 = specs.map((sp, i) => { const r = sp.lo.A.length / din; return [r1[2 * i], sp.lo.B, T, r, sp.dout]; });
    const r2 = await ammMany(be, items2);
    return specs.map((sp, i) => {
        const xA = r1[2 * i], base = r1[2 * i + 1], br = r2[i], dout = sp.dout;
        const y = new Float64Array(T * dout); for (let j = 0; j < y.length; j++) y[j] = base[j] + s * br[j];
        sp.cache.xA = xA; return y;
    });
}
async function loraLinA(be, x, W, lo, s, T, din, dout, cache) {
    const r = lo.A.length / din;
    const xA = await amm(be, x, lo.A, T, din, r);
    const base = await amm(be, x, W, T, din, dout), br = await amm(be, xA, lo.B, T, r, dout);
    const y = new Float64Array(T * dout); for (let i = 0; i < y.length; i++) y[i] = base[i] + s * br[i];
    cache.xA = xA; return y;
}
// 反向批次版（O8）：與 loraLinBwdA 的算式逐項相同（ammAt／ammBt 的轉置在這裡先轉好），矩陣乘分兩階段各一次提交。
// 批次項目（與 ammAt／ammBt 同一算式）：後端有 transFlags 就帶旗標，否則照舊在 CPU 轉置。
const mkAt = (be, A, B, m, k, n) => be.transFlags ? [A, B, m, k, n, { transA: true }] : [tr2(A, k, m), B, m, k, n];   // C = Aᵀ·B
const mkBt = (be, A, B, m, k, n) => be.transFlags ? [A, B, m, k, n, { transB: true }] : [A, tr2(B, n, k), m, k, n];   // C = A·Bᵀ
// specs：[{ dy, x, W, lo, xA, key }]，回傳與 specs 同序的 dx 陣列，並把 grads[key] = { A, B } 寫入。
async function loraLinBwdManyA(be, specs, s, T, din, dout, grads) {
    // 後端有 loraBwdMany（O8 每群組一次提交）：dA、dB、dx 一次回讀
    if (be.loraBwdMany) {
        const R = await be.loraBwdMany(specs.map((sp) => ({ dy: sp.dy, x: sp.x, W: sp.W, A: sp.lo.A, B: sp.lo.B, xA: sp.xA, s: s, T: T, din: din, dout: dout })));
        return specs.map((sp, i) => { grads[sp.key] = { A: R[i].dA, B: R[i].dB }; return R[i].dx; });
    }
    const rs = specs.map((sp) => sp.lo.A.length / din);
    const P1 = [];
    specs.forEach((sp, i) => { P1.push(mkAt(be, sp.xA, sp.dy, rs[i], T, dout), mkBt(be, sp.dy, sp.lo.B, T, dout, rs[i]), mkBt(be, sp.dy, sp.W, T, dout, din)); });
    const r1 = await ammMany(be, P1);
    const dBs = [], dxAs = [];
    specs.forEach((sp, i) => {
        const dB = r1[3 * i], dxA = r1[3 * i + 1];
        for (let j = 0; j < dB.length; j++) dB[j] *= s;
        for (let j = 0; j < dxA.length; j++) dxA[j] *= s;
        dBs.push(dB); dxAs.push(dxA);
    });
    const P2 = [];
    specs.forEach((sp, i) => { P2.push(mkAt(be, sp.x, dxAs[i], din, T, rs[i]), mkBt(be, dxAs[i], sp.lo.A, T, rs[i], din)); });
    const r2 = await ammMany(be, P2);
    return specs.map((sp, i) => {
        const dA = r2[2 * i], dx = r1[3 * i + 2], dx2 = r2[2 * i + 1];
        for (let j = 0; j < dx.length; j++) dx[j] += dx2[j];
        grads[sp.key] = { A: dA, B: dBs[i] };
        return dx;
    });
}
async function loraLinBwdA(be, dy, x, W, lo, s, xA, T, din, dout, grads, key) {
    const r = lo.A.length / din;
    const dB = await ammAt(be, xA, dy, r, T, dout); for (let i = 0; i < dB.length; i++) dB[i] *= s;
    const dxA = await ammBt(be, dy, lo.B, T, dout, r); for (let i = 0; i < dxA.length; i++) dxA[i] *= s;
    const dA = await ammAt(be, x, dxA, din, T, r);
    grads[key] = { A: dA, B: dB };
    const dx = await ammBt(be, dy, W, T, dout, din), dx2 = await ammBt(be, dxA, lo.A, T, r, din);
    for (let i = 0; i < dx.length; i++) dx[i] += dx2[i];
    return dx;
}

// 與 lossAndGrads 同一組公式（逐行對照）；差別只在矩陣乘走 be.matmul 並以 await 等待
// ===== 逐核心的非同步運算介面 =====
// 預設 cpuNnOps() 是這個檔案的 CPU 版本；cudaweb 版由呼叫端注入（見 backend_cudaweb.js）。
// 介面：rmsnorm(x,g,T,d,eps)→y；softmax(x,rows,cols)→y；silu(x)→y；rope(x,T,H,hd,dir)→y；adamw(p,g,m,v,t,lr,b1,b2,eps,wd)→{p,m,v}
function softmaxRowsCpu(x, rows, cols) {
    const y = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++) {
        let mx = -Infinity; for (let c = 0; c < cols; c++) if (x[r * cols + c] > mx) mx = x[r * cols + c];
        let s = 0; for (let c = 0; c < cols; c++) { const e = Math.exp(x[r * cols + c] - mx); y[r * cols + c] = e; s += e; }
        for (let c = 0; c < cols; c++) y[r * cols + c] /= s;
    }
    return y;
}
function adamwCpu(p, g, m, v, t, lr, b1, b2, eps, wd) {
    const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t), n = p.length;
    const P2 = new Float64Array(n), M2 = new Float64Array(n), V2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        M2[i] = b1 * m[i] + (1 - b1) * g[i]; V2[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
        P2[i] = p[i] - lr * wd * p[i] - lr * (M2[i] / c1) / (Math.sqrt(V2[i] / c2) + eps);
    }
    return { p: P2, m: M2, v: V2 };
}
function cpuNnOps() {
    return {
        rmsnorm: async (x, g, T, d) => rmsFwd(x, g, T, d, null).y,
        softmax: async (x, rows, cols) => softmaxRowsCpu(x, rows, cols),
        silu: async (x) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * sig(x[i]); return y; },
        rope: async (x, T, H, hd, dir) => rope(x, T, H, hd, dir),
        adamw: async (p, g, m, v, t, lr, b1, b2, eps, wd) => adamwCpu(p, g, m, v, t, lr, b1, b2, eps, wd),
    };
}
// RMSNorm：y 來自 ops；inv 在 CPU 上算（反向需要，且只是每列一次平方和）
async function rmsFwdA(ops, x, g, T, d) {
    const y = Float64Array.from(await ops.rmsnorm(x, g, T, d, 1e-6));
    const inv = new Float64Array(T);
    for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < d; i++) s += x[t * d + i] * x[t * d + i]; inv[t] = 1 / Math.sqrt(s / d + 1e-6); }
    return { y, inv };
}

async function lossAndGradsAsync(m, tokens, opts) {
    opts = opts || {}; const be = opts.backend || cpuMatmulBackend(); const ops = opts.ops || cpuNnOps();
    const { V, d, L, H, F, r } = m.cfg; const hd = d / H; const s = (m.cfg.alpha || r) / r;
    const T = tokens.length - 1; const inp = tokens.slice(0, T), tgt = tokens.slice(1);
    let h = new Float64Array(T * d); for (let t = 0; t < T; t++) for (let i = 0; i < d; i++) h[t * d + i] = m.emb[inp[t] * d + i];
    const C = [];
    for (let l = 0; l < L; l++) {
        const P = m.layers[l], lo = m.lora[l], c = { h0: h };
        const n1 = await rmsFwdA(ops, h, P.n1, T, d); c.n1 = n1; const cq = {}, ck = {}, cv = {}, co = {};
        const qkv = await loraLinManyA(be, n1.y, [{ W: P.Wq, lo: lo.q, cache: cq, dout: d }, { W: P.Wk, lo: lo.k, cache: ck, dout: d }, { W: P.Wv, lo: lo.v, cache: cv, dout: d }], s, T, d);
        const q0 = qkv[0], k0 = qkv[1], v = qkv[2];
        const q = await ops.rope(q0, T, H, hd, 1), k = await ops.rope(k0, T, H, hd, 1); Object.assign(c, { cq, ck, cv, co, q, k, v });
        // 注意力分數：未遮罩的位置算 q·k/√hd，遮罩位置填 −1e30，softmax 之後正好是 0（與只算 j≤i 的版本等價）
        const sc = 1 / Math.sqrt(hd), S = new Float64Array(H * T * T), ao = new Float64Array(T * d);
        for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
            const row = (hh * T + i) * T;
            for (let j = 0; j < T; j++) {
                if (j > i) { S[row + j] = -1e30; continue; }
                let z = 0; for (let u = 0; u < hd; u++) z += q[i * d + hh * hd + u] * k[j * d + hh * hd + u];
                S[row + j] = z * sc;
            }
        }
        const Pm = Float64Array.from(await ops.softmax(S, H * T, T));
        for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
            const row = (hh * T + i) * T;
            for (let u = 0; u < hd; u++) { let z = 0; for (let j = 0; j <= i; j++) z += Pm[row + j] * v[j * d + hh * hd + u]; ao[i * d + hh * hd + u] = z; }
        }
        c.P = Pm; c.ao = ao;
        const o = await loraLinA(be, ao, P.Wo, lo.o, s, T, d, d, co);
        const h1 = new Float64Array(T * d); for (let i = 0; i < h1.length; i++) h1[i] = h[i] + o[i]; c.h1 = h1;
        const n2 = await rmsFwdA(ops, h1, P.n2, T, d); c.n2 = n2;
        let g, u, a, dn;
        if (be.mlpFwd) {
            // 後端有 mlpFwd（O8）：閘門、上投影、silu、相乘、下投影在裝置上一次完成
            const R = await be.mlpFwd({ x: n2.y, Wg: P.Wg, Wu: P.Wu, Wd: P.Wd, T: T, d: d, F: F }); g = R.g; u = R.u; a = R.a; dn = R.dn;
        } else {
            const gu = await ammMany(be, [[n2.y, P.Wg, T, d, F], [n2.y, P.Wu, T, d, F]]); g = gu[0]; u = gu[1]; a = new Float64Array(T * F);
            const sg = await ops.silu(g);
            for (let i = 0; i < a.length; i++) a[i] = sg[i] * u[i];
            dn = await amm(be, a, P.Wd, T, F, d);
        }
        c.g = g; c.u = u; c.a = a; const h2 = new Float64Array(T * d); for (let i = 0; i < h2.length; i++) h2[i] = h1[i] + dn[i];
        h = h2; C.push(c);
    }
    const nf = await rmsFwdA(ops, h, m.nf, T, d);
    let loss = 0, dhHead = null;
    if (be.headStep) {
      // 訓練頭整段在裝置上（logits→交叉熵→dh），一次提交、兩次回讀（O8）
      const H = await be.headStep({ nf: nf.y, emb: m.emb, tgt, T, d, V }); loss = H.loss; dhHead = H.dh;
    } else {
    const logits = await ammBt(be, nf.y, m.emb, T, d, V);
    const dl = new Float64Array(T * V);
    for (let t = 0; t < T; t++) { let mx = -Infinity; for (let j = 0; j < V; j++) if (logits[t * V + j] > mx) mx = logits[t * V + j]; let sum = 0; for (let j = 0; j < V; j++) { dl[t * V + j] = Math.exp(logits[t * V + j] - mx); sum += dl[t * V + j]; } loss += -Math.log(dl[t * V + tgt[t]] / sum); for (let j = 0; j < V; j++) dl[t * V + j] = (dl[t * V + j] / sum - (j === tgt[t] ? 1 : 0)) / T; }
    loss /= T;
    dhHead = await amm(be, dl, m.emb, T, V, d);
    }
    if (opts.noGrad) return { loss };
    let dh = rmsBwd(dhHead, h, m.nf, nf.inv, T, d); const grads = new Array(L);
    for (let l = L - 1; l >= 0; l--) {
        const P = m.layers[l], lo = m.lora[l], c = C[l]; const G = {};
        const da = await ammBt(be, dh, P.Wd, T, d, F); const dg = new Float64Array(T * F), du = new Float64Array(T * F);
        for (let i = 0; i < da.length; i++) { const sg = sig(c.g[i]); du[i] = da[i] * c.g[i] * sg; dg[i] = da[i] * c.u[i] * sg * (1 + c.g[i] * (1 - sg)); }
        const dn2mm = await ammMany(be, [mkBt(be, dg, P.Wg, T, F, d), mkBt(be, du, P.Wu, T, F, d)]); const dn2 = dn2mm[0], dn2b = dn2mm[1]; for (let i = 0; i < dn2.length; i++) dn2[i] += dn2b[i];
        const dh1 = rmsBwd(dn2, c.h1, P.n2, c.n2.inv, T, d); for (let i = 0; i < dh1.length; i++) dh1[i] += dh[i];
        const dao = (await loraLinBwdManyA(be, [{ dy: dh1, x: c.ao, W: P.Wo, lo: lo.o, xA: c.co.xA, key: 'o' }], s, T, d, d, G))[0];
        const dq = new Float64Array(T * d), dk = new Float64Array(T * d), dv = new Float64Array(T * d), sc = 1 / Math.sqrt(hd);
        for (let hh = 0; hh < H; hh++) for (let i = 0; i < T; i++) {
            const row = (hh * T + i) * T; const dP = new Float64Array(i + 1); let dot = 0;
            for (let j = 0; j <= i; j++) { let z = 0; for (let u = 0; u < hd; u++) { z += dao[i * d + hh * hd + u] * c.v[j * d + hh * hd + u]; dv[j * d + hh * hd + u] += c.P[row + j] * dao[i * d + hh * hd + u]; } dP[j] = z; dot += z * c.P[row + j]; }
            for (let j = 0; j <= i; j++) { const dS = c.P[row + j] * (dP[j] - dot) * sc; for (let u = 0; u < hd; u++) { dq[i * d + hh * hd + u] += dS * c.k[j * d + hh * hd + u]; dk[j * d + hh * hd + u] += dS * c.q[i * d + hh * hd + u]; } }
        }
        const dq0 = await ops.rope(dq, T, H, hd, -1), dk0 = await ops.rope(dk, T, H, hd, -1);
        const qkvB = await loraLinBwdManyA(be, [{ dy: dq0, x: c.n1.y, W: P.Wq, lo: lo.q, xA: c.cq.xA, key: 'q' }, { dy: dk0, x: c.n1.y, W: P.Wk, lo: lo.k, xA: c.ck.xA, key: 'k' }, { dy: dv, x: c.n1.y, W: P.Wv, lo: lo.v, xA: c.cv.xA, key: 'v' }], s, T, d, d, G);
        const dx = qkvB[0], dx2 = qkvB[1], dx3 = qkvB[2];
        for (let i = 0; i < dx.length; i++) dx[i] += dx2[i] + dx3[i];
        const dh0 = rmsBwd(dx, c.h0, P.n1, c.n1.inv, T, d); for (let i = 0; i < dh0.length; i++) dh0[i] += dh1[i];
        dh = dh0; grads[l] = G;
    }
    return { loss, grads };
}

// 非同步版的 AdamW 一步：與 adamStep 相同的步數與公式，逐矩陣交給 ops.adamw（wd=0，與同步版一致）
async function adamStepAsync(m, grads, st, lr, ops) {
    const o = ops || cpuNnOps(); st.t++;
    for (let l = 0; l < m.lora.length; l++) for (const k of ['q', 'k', 'v', 'o']) for (const w of ['A', 'B']) {
        const p = m.lora[l][k][w], g = grads[l][k][w], s = st.z[l][k][w];
        const r = await o.adamw(p, g, s.m, s.v, st.t, lr, 0.9, 0.999, 1e-8, 0);
        p.set(r.p); s.m.set(r.m); s.v.set(r.v);
    }
}

// cudaweb 執行期 → 訓練器的 matmul 後端；記錄最後一次實際使用的層與原因（給後端選單顯示）
function cudawebMatmulBackend(rt) {
    const be = { id: 'cudaweb', layer: null, reason: null, calls: 0, transFlags: true };
    // fl（選用）：{ transA, transB }，走 O5 平鋪核心的轉置旗標（不在 CPU 複製轉置）
    be.matmul = async (A, B, m, k, n, fl) => {
        const r = await rt.matmul(Array.from(A), Array.from(B), m, k, n, fl);
        be.calls++; be.layer = r.info.layer; be.reason = r.info.reason || null;
        return Float64Array.from(r.result);
    };
    // 批次（O8 前向）：執行期有 matmulMany 才提供；一次提交多個互不相依的矩陣乘
    if (typeof rt.matmulMany === 'function') {
        be.matmulMany = async (items) => {
            const r = await rt.matmulMany(items.map((it) => [Array.from(it[0]), Array.from(it[1]), it[2], it[3], it[4], it[5]]));
            be.calls += items.length; be.layer = r.info.layer; be.reason = r.info.reason || null;
            return r.results.map((x) => Float64Array.from(x));
        };
    }
    // O8 每群組一次提交：LoRA 投影群組（前向、反向）與前饋區塊（前向）；執行期有才提供
    const F64 = (v) => Float64Array.from(v);
    if (typeof rt.loraFwdMany === 'function') {
        be.loraFwdMany = async (specs) => {
            const r = await rt.loraFwdMany(specs);
            be.calls += specs.length; be.layer = 'T1'; be.reason = null;
            return r.results.map((x) => ({ y: F64(x.y), xA: F64(x.xA) }));
        };
    }
    if (typeof rt.loraBwdMany === 'function') {
        be.loraBwdMany = async (specs) => {
            const r = await rt.loraBwdMany(specs);
            be.calls += specs.length; be.layer = 'T1'; be.reason = null;
            return r.results.map((x) => ({ dA: F64(x.dA), dB: F64(x.dB), dx: F64(x.dx) }));
        };
    }
    if (typeof rt.mlpFwd === 'function') {
        be.mlpFwd = async (a) => {
            const r = await rt.mlpFwd(a);
            be.calls++; be.layer = 'T1'; be.reason = null;
            return { g: F64(r.g), u: F64(r.u), a: F64(r.a), dn: F64(r.dn) };
        };
    }
    // 訓練頭（O8）：logits→交叉熵→dh 一次提交；執行期有 headStep 才提供
    if (typeof rt.headStep === 'function') {
        be.headStep = async (a) => {
            const r = await rt.headStep({ nf: Array.from(a.nf), emb: Array.from(a.emb), tgt: a.tgt, T: a.T, d: a.d, V: a.V });
            be.calls++; be.layer = r.info.layer; be.reason = r.info.reason || null;
            return { loss: r.loss, dh: Float64Array.from(r.dh) };
        };
    }
    return be;
}

module.exports = { ROPE_CONVENTION, makeModel, lossAndGrads, adamInit, adamStep, estimate06B, makeRng,
    lossAndGradsAsync, adamStepAsync, cpuMatmulBackend, cpuNnOps, cudawebMatmulBackend };
