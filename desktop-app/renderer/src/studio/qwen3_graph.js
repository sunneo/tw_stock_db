/* 從真的 Qwen3 ONNX（ORT-GenAI 風格的 q8 融合圖，例如 model_quantized.onnx）讀出權重，建成 onnx_grad_core 的「無快取、固定序列長度」訓練圖。
 *  這是型樣辨識式的降級（不是通用轉換）：把
 *    DynamicQuantizeLinear＋MatMulInteger＋Cast＋縮放 Mul → DequantizeLinear(uint8 權重, 整張量縮放, 零點)＋MatMul（激活不量化＝直通估計）
 *    SimplifiedLayerNormalization／SkipSimplifiedLayerNormalization → RMSNorm 基本運算子
 *    RotaryEmbedding(interleaved=0，rotate-half) → x*cos + (x·R)*sin
 *    GroupQueryAttention(16 個查詢頭、8 個 KV 頭、scale=1/√128) → 無快取版：KV 頭重複（Expand）、因果遮罩、Softmax
 *  LoRA 加在每層 7 個線性層（q／k／v／o／gate／up／down，與 196 = 28×7 一致）。
 *  讀不到的欄位一律丟明確錯誤。 */
'use strict';
const Gm = require('./onnx_grad_core.js');
const P = require('./onnx_patch_core.js');

function openModel(bytes) { return { bytes, ix: P.indexModel(bytes) }; }
function initOf(M, name) { const t = M.ix.inits.get(name); if (!t) throw new Error('模型沒有初始值：' + name); return t; }
function f32Of(M, name) { const t = initOf(M, name); if (t.dataType !== 1) throw new Error(name + ' 不是 float32'); if (t.rawStart >= 0) { const raw = M.bytes.slice(t.rawStart, t.rawEnd); return { dims: t.dims, data: Float64Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)) }; } if (t.floatData) return { dims: t.dims, data: Float64Array.from(t.floatData) }; throw new Error(name + ' 讀不到資料'); }
function u8Of(M, name) { const t = initOf(M, name); if (t.dataType !== 2 || t.rawStart < 0) throw new Error(name + ' 不是 raw uint8'); return { dims: t.dims, data: Float64Array.from(M.bytes.subarray(t.rawStart, t.rawEnd)) }; }
function scalarOf(M, name) { const t = initOf(M, name); if (t.dataType === 1) return t.floatData ? t.floatData[0] : f32Of(M, name).data[0]; if (t.int32Data) return t.int32Data[0]; if (t.rawStart >= 0) return M.bytes[t.rawStart]; throw new Error(name + ' 讀不到純量'); }

// 讀一個量化線性層：回傳 {q(uint8 as f64), dims, scale, zp}
function qLinear(M, prefix) {
    const w = u8Of(M, prefix + '.weight_quantized');
    return { q: w.data, dims: w.dims, scale: scalarOf(M, prefix + '.weight_scale'), zp: scalarOf(M, prefix + '.weight_zero_point') };
}

function ropeTables(M, T, hd) {
    const cos = f32Of(M, 'cos_cache'), sin = f32Of(M, 'sin_cache'), half = hd / 2; if (cos.dims[1] !== half) throw new Error('cos_cache 維度不是 head_dim/2');
    const C = new Float64Array(T * hd), S = new Float64Array(T * hd), R = new Float64Array(hd * hd);
    for (let t = 0; t < T; t++) for (let i = 0; i < half; i++) { C[t * hd + i] = C[t * hd + half + i] = cos.data[t * half + i]; S[t * hd + i] = S[t * hd + half + i] = sin.data[t * half + i]; }
    for (let i = 0; i < half; i++) { R[(i + half) * hd + i] = -1; R[i * hd + half + i] = 1; }
    return { C, S, R };
}

// 建單一區塊（第 layer 層）的訓練圖：輸入 x [T,d]（區塊輸入隱藏狀態，不求梯度），LoRA A/B 是可訓練輸入
// probe：長度 T*d 的探測權重，loss = mean(out ⊙ probe)（只為了得到純量，驗證梯度）
function buildBlock(M, layer, T, rank, probe, opts) {
    opts = opts || {}; const d = 1024, H = 16, KV = 8, hd = 128, F = 3072, alpha = opts.alpha || 2 * rank, s = alpha / rank, eps = 1e-6;
    const g = new Gm.G(); const pre = 'model.layers.' + layer + '.';
    const x = g.input('x', [T, d]);
    const { C, S, R } = ropeTables(M, T, hd);
    const Ct = g.const('rope_c', [T, 1, hd], C), St = g.const('rope_s', [T, 1, hd], S), Rt = g.const('rope_r', [hd, hd], R);
    const mask = new Float64Array(T * T); for (let i = 0; i < T; i++) for (let j = i + 1; j < T; j++) mask[i * T + j] = -1e9;
    const maskT = g.const('mask', [T, T], mask), epsT = g.scalar(eps), scale = g.scalar(1 / Math.sqrt(hd)), sS = g.scalar(s);
    const params = []; const lin = (key, fname, din, dout, h) => {
        const ql = qLinear(M, pre + fname + '.MatMul'); if (ql.dims[0] !== din || ql.dims[1] !== dout) throw new Error(fname + ' 形狀不符 ' + ql.dims);
        const q = g.const(key + '.q', [din, dout], ql.q, 'u8'), sc = g.const(key + '.s', [], Float64Array.of(ql.scale)), zp = g.const(key + '.z', [], Float64Array.of(ql.zp), 'u8');
        const W = g.dequant(q, sc, zp);
        const A = g.input(key + '.A', [din, rank], 'f32', true), B = g.input(key + '.B', [rank, dout], 'f32', true); params.push(A, B);
        return g.add(g.matmul(h, W), g.mul(sS, g.matmul(g.matmul(h, A), B)));
    };
    const rms = (h, gname, dim) => { const gain = f32Of(M, gname); if (gain.data.length !== dim) throw new Error(gname + ' 長度不符'); const gt = g.const(gname, [dim], gain.data); const ss = g.reduceMean(g.mul(h, h), [-1], true); return g.mul(g.mul(h, g.recip(g.sqrt(g.add(ss, epsT)))), gt); };
    const rope = (h) => g.add(g.mul(h, Ct), g.mul(g.matmul(h, Rt), St));
    const n1 = rms(x, pre + 'input_layernorm.weight', d);
    const q0 = lin('q', 'attn.q_proj', d, H * hd, n1), k0 = lin('k', 'attn.k_proj', d, KV * hd, n1), v0 = lin('v', 'attn.v_proj', d, KV * hd, n1);
    const q = rope(rms(g.reshape(q0, [T, H, hd]), pre + 'attn.q_norm.layernorm.weight', hd)), k = rope(rms(g.reshape(k0, [T, KV, hd]), pre + 'attn.k_norm.layernorm.weight', hd));
    const v = g.reshape(v0, [T, KV, hd]);
    g.output(k); g.output(v);                                        // 與真模型的 present.N.key／value 對照用（key 已含 k_norm＋RoPE）
    const rep = (t) => g.reshape(g.expand(g.reshape(g.transpose(t, [1, 0, 2]), [KV, 1, T, hd]), [KV, H / KV, T, hd]), [H, T, hd]);
    const sc = g.add(g.mul(g.matmul(g.transpose(q, [1, 0, 2]), g.transpose(rep(k), [0, 2, 1])), scale), maskT);
    const ctx = g.reshape(g.transpose(g.matmul(g.softmax(sc, -1), rep(v)), [1, 0, 2]), [T, H * hd]);
    const h1 = g.add(x, lin('o', 'attn.o_proj', H * hd, d, ctx));
    const n2 = rms(h1, pre + 'post_attention_layernorm.weight', d);
    const gg = lin('gate', 'mlp.gate_proj', d, F, n2), uu = lin('up', 'mlp.up_proj', d, F, n2);
    const out = g.add(h1, lin('down', 'mlp.down_proj', F, d, g.mul(g.mul(gg, g.sigmoid(gg)), uu)));
    const pr = g.const('probe', [T, d], probe);
    const loss = g.reduceMean(g.mul(out, pr), [0, 1], false); g.output(loss);
    return { g, loss, params, k, v, out };
}

// 把 token id 經量化嵌入表取成 float 隱藏狀態 [T,d]
function embed(M, ids) { const t = initOf(M, 'model.embed_tokens.weight_quantized'); if (t.dataType !== 2 || t.rawStart < 0) throw new Error('嵌入表不是 raw uint8'); const sc = scalarOf(M, 'model.embed_tokens.weight_scale'), zp = scalarOf(M, 'model.embed_tokens.weight_zero_point'); const d = t.dims[1]; const o = new Float64Array(ids.length * d); ids.forEach((id, i) => { for (let j = 0; j < d; j++) o[i * d + j] = (M.bytes[t.rawStart + id * d + j] - zp) * sc; }); return o; }

module.exports = { openModel, buildBlock, embed, f32Of, scalarOf, ropeTables };
