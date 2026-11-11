/* 把 lora_ref_train.js 的小型 transformer（同一份權重）建成 onnx_grad_core 的靜態圖：
 *  RMSNorm、RoPE（相鄰兩維一組；寫成 x*cos + (x·R)*sin，R 是固定的 ±1 置換矩陣，所以反向只靠 MatMul／Mul 規則）、
 *  因果注意力（Reshape／Transpose／MatMul／加遮罩／Softmax）、SiLU 閘控前饋、綁定詞嵌入輸出頭、交叉熵。
 *  基底權重：可選擇存成 int8（每輸出欄一個縮放，DequantizeLinear 進圖＝直通估計：權重凍結、梯度只穿過激活）。
 *  LoRA 的 A／B 是可訓練輸入。 */
'use strict';
const Gm = require('./onnx_grad_core.js');

function ropeMats(T, d, H) {
    const hd = d / H, C = new Float64Array(T * d), S = new Float64Array(T * d), R = new Float64Array(d * d);
    for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < hd / 2; i++) { const th = t * Math.pow(10000, -2 * i / hd); const o = t * d + h * hd + 2 * i; C[o] = C[o + 1] = Math.cos(th); S[o] = S[o + 1] = Math.sin(th); }
    for (let i = 0; i < d; i += 2) { R[i * d + i + 1] = 1; R[(i + 1) * d + i] = -1; }   // (x·R)[2i] = -x[2i+1]，(x·R)[2i+1] = x[2i]
    return { C, S, R };
}

function quantCols(W, rows, cols) { // 對稱 int8，每輸出欄一個縮放
    const q = new Float64Array(rows * cols), sc = new Float64Array(cols);
    for (let j = 0; j < cols; j++) { let mx = 0; for (let i = 0; i < rows; i++) mx = Math.max(mx, Math.abs(W[i * cols + j])); sc[j] = mx / 127 || 1; for (let i = 0; i < rows; i++) q[i * cols + j] = Math.max(-127, Math.min(127, Math.round(W[i * cols + j] / sc[j]))); }
    return { q, sc };
}

// opts.quant：基底線性層權重改存 int8＋縮放（回傳的 effective 權重放在 model.layers 的 Wq_eff… 供參考實作對拍）
function build(m, tokens, opts) {
    opts = opts || {}; const { V, d, L, H, F, r } = m.cfg; const hd = d / H, T = tokens.length - 1, s = (m.cfg.alpha || r) / r;
    const g = new Gm.G(); const eff = [];
    const ids = g.input('ids', [T], 'i64'), onehot = g.input('onehot', [T, V]);
    const emb = g.const('emb', [V, d], m.emb), embT = g.transpose(emb, [1, 0]);
    const { C, S, R } = ropeMats(T, d, H); const Ct = g.const('rope_c', [T, d], C), St = g.const('rope_s', [T, d], S), Rt = g.const('rope_r', [d, d], R);
    const mask = new Float64Array(T * T); for (let i = 0; i < T; i++) for (let j = i + 1; j < T; j++) mask[i * T + j] = -1e9;
    const maskT = g.const('mask', [T, T], mask), eps = g.scalar(1e-6), scale = g.scalar(1 / Math.sqrt(hd)), sS = g.scalar(s);
    const W = (name, data, rows, cols) => {
        if (!opts.quant) return g.const(name, [rows, cols], data);
        const { q, sc } = quantCols(data, rows, cols); const qt = g.const(name + '.q', [rows, cols], q, 'i8'), st = g.const(name + '.s', [cols], sc);
        const dq = g.dequant(qt, st, null, 1); const e = new Float64Array(rows * cols); for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) e[i * cols + j] = q[i * cols + j] * sc[j]; eff.push([name, e]); return dq;
    };
    const rms = (x, gain, name) => { const gt = g.const(name, [d], gain); const ss = g.reduceMean(g.mul(x, x), [-1], true); const inv = g.recip(g.sqrt(g.add(ss, eps))); return g.mul(g.mul(x, inv), gt); };
    const lora = (x, Wt, A, B) => g.add(g.matmul(x, Wt), g.mul(sS, g.matmul(g.matmul(x, A), B)));
    const heads = (x) => g.transpose(g.reshape(x, [T, H, hd]), [1, 0, 2]);
    let h = g.gather(emb, ids); const params = [];
    for (let l = 0; l < L; l++) {
        const P = m.layers[l], lo = m.lora[l]; const ab = {};
        for (const k of ['q', 'k', 'v', 'o']) { ab[k] = { A: g.input('l' + l + '.' + k + '.A', [d, r], 'f32', true), B: g.input('l' + l + '.' + k + '.B', [r, d], 'f32', true) }; params.push(ab[k].A, ab[k].B); }
        const n1 = rms(h, P.n1, 'l' + l + '.n1');
        let q = lora(n1, W('l' + l + '.Wq', P.Wq, d, d), ab.q.A, ab.q.B), k = lora(n1, W('l' + l + '.Wk', P.Wk, d, d), ab.k.A, ab.k.B), v = lora(n1, W('l' + l + '.Wv', P.Wv, d, d), ab.v.A, ab.v.B);
        q = g.add(g.mul(q, Ct), g.mul(g.matmul(q, Rt), St)); k = g.add(g.mul(k, Ct), g.mul(g.matmul(k, Rt), St));
        const sc = g.add(g.mul(g.matmul(heads(q), g.transpose(heads(k), [0, 2, 1])), scale), maskT);
        const ao = g.reshape(g.transpose(g.matmul(g.softmax(sc, -1), heads(v)), [1, 0, 2]), [T, d]);
        const h1 = g.add(h, lora(ao, W('l' + l + '.Wo', P.Wo, d, d), ab.o.A, ab.o.B));
        const n2 = rms(h1, P.n2, 'l' + l + '.n2');
        const gg = g.matmul(n2, W('l' + l + '.Wg', P.Wg, d, F)), uu = g.matmul(n2, W('l' + l + '.Wu', P.Wu, d, F));
        h = g.add(h1, g.matmul(g.mul(g.mul(gg, g.sigmoid(gg)), uu), W('l' + l + '.Wd', P.Wd, F, d)));
    }
    const logits = g.matmul(rms(h, m.nf, 'nf'), embT);
    const sel = g.reduceSum(g.mul(g.softmax(logits, -1), onehot), [1], false);
    const loss = g.neg(g.reduceMean(g.log(sel), [0], false));
    g.output(loss);
    const feeds = { ids: Float64Array.from(tokens.slice(0, T)), onehot: (() => { const o = new Float64Array(T * V); for (let t = 0; t < T; t++) o[t * V + tokens[t + 1]] = 1; return o; })() };
    return { g, loss, params, feeds, eff };
}

module.exports = { build };
