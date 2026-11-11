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
function u8Of(M, name) { const t = initOf(M, name); if (t.dataType !== 2 || t.rawStart < 0) throw new Error(name + ' 不是 raw uint8'); return { dims: t.dims, data: M.bytes.subarray(t.rawStart, t.rawEnd) }; }
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

// 反量化寫成 Cast＋Sub＋Mul：WebGPU 後端的 DequantizeLinear 對 uint8／int8 會算錯（逐算子實測，相對誤差 1e7 倍），而 Cast／Sub／Mul 與 uint8 的 Gather 都正確
const dq = (g, x, s, z) => g.mul(g.sub(g.cast(x, 'f32'), z), s);
const D = 1024, H = 16, KV = 8, HD = 128, FF = 3072;
// 共用常數（rope 表、遮罩、純量）
function sharedConsts(g, M, T, rank, alpha) {
    const { C, S, R } = ropeTables(M, T, HD);
    const mask = new Float64Array(T * T); for (let i = 0; i < T; i++) for (let j = i + 1; j < T; j++) mask[i * T + j] = -1e9;
    return { Ct: g.const('rope_c', [T, 1, HD], C), St: g.const('rope_s', [T, 1, HD], S), Rt: g.const('rope_r', [HD, HD], R), maskT: g.const('mask', [T, T], mask), epsT: g.scalar(1e-6), scale: g.scalar(1 / Math.sqrt(HD)), sS: g.scalar((alpha || 2 * rank) / rank) };
}
function rmsOf(g, M, c, h, gname, dim) { const gain = f32Of(M, gname); if (gain.data.length !== dim) throw new Error(gname + ' 長度不符'); const gt = g.const(gname, [dim], gain.data); const ss = g.reduceMean(g.mul(h, h), [-1], true); return g.mul(g.mul(h, g.recip(g.sqrt(g.add(ss, c.epsT)))), gt); }
// 加一層（前向）；回傳 {out, k, v}；LoRA 的 A/B 以 'l<層>.<目標>.A|B' 命名並加入 params
function addLayer(g, M, c, layer, x, T, rank, params) {
    const pre = 'model.layers.' + layer + '.', ln = 'l' + layer + '.';
    const lin = (key, fname, din, dout, h) => {
        const ql = qLinear(M, pre + fname + '.MatMul'); if (ql.dims[0] !== din || ql.dims[1] !== dout) throw new Error(fname + ' 形狀不符 ' + ql.dims);
        const q = g.const(ln + key + '.q', [din, dout], ql.q, 'u8'), sc = g.const(ln + key + '.s', [], Float64Array.of(ql.scale)), zp = g.const(ln + key + '.z', [], Float64Array.of(ql.zp));
        const W = dq(g, q, sc, zp);
        const A = g.input(ln + key + '.A', [din, rank], 'f32', true), B = g.input(ln + key + '.B', [rank, dout], 'f32', true); params.push(A, B);
        return g.add(g.matmul(h, W), g.mul(c.sS, g.matmul(g.matmul(h, A), B)));
    };
    const DB = (t) => { if (c.dbgList && layer === 0) c.dbgList.push(g.output(t)); return t; };
    const rope = (h) => g.add(g.mul(h, c.Ct), g.mul(g.matmul(h, c.Rt), c.St));
    const n1 = rmsOf(g, M, c, x, pre + 'input_layernorm.weight', D);
    const q0 = lin('q', 'attn.q_proj', D, H * HD, n1), k0 = lin('k', 'attn.k_proj', D, KV * HD, n1), v0 = lin('v', 'attn.v_proj', D, KV * HD, n1);
    const q = rope(rmsOf(g, M, c, g.reshape(q0, [T, H, HD]), pre + 'attn.q_norm.layernorm.weight', HD)), k = rope(rmsOf(g, M, c, g.reshape(k0, [T, KV, HD]), pre + 'attn.k_norm.layernorm.weight', HD));
    const v = g.reshape(v0, [T, KV, HD]); DB(q); DB(v);
    const rep = (t) => g.reshape(g.expand(g.reshape(g.transpose(t, [1, 0, 2]), [KV, 1, T, HD]), [KV, H / KV, T, HD]), [H, T, HD]);
    const sc = g.add(g.mul(g.matmul(g.transpose(q, [1, 0, 2]), g.transpose(rep(k), [0, 2, 1])), c.scale), c.maskT);
    const P = DB(g.softmax(DB(sc), -1)); const ctx = DB(g.reshape(g.transpose(g.matmul(P, DB(rep(v))), [1, 0, 2]), [T, H * HD]));
    const h1 = DB(g.add(x, DB(lin('o', 'attn.o_proj', H * HD, D, ctx))));
    const n2 = rmsOf(g, M, c, h1, pre + 'post_attention_layernorm.weight', D);
    DB(n2); const gg = DB(lin('gate', 'mlp.gate_proj', D, FF, n2)), uu = DB(lin('up', 'mlp.up_proj', D, FF, n2));
    const out = g.add(h1, lin('down', 'mlp.down_proj', FF, D, g.mul(g.mul(gg, g.sigmoid(gg)), uu)));
    return { out, k, v };
}
// 單一區塊（對拍用）：輸入 x [T,d]；loss = mean(out ⊙ probe)
function buildBlock(M, layer, T, rank, probe, opts) {
    opts = opts || {}; const g = new Gm.G(); const x = g.input('x', [T, D]); const c = sharedConsts(g, M, T, rank, opts.alpha); const params = [];
    const L = addLayer(g, M, c, layer, x, T, rank, params); g.output(L.k); g.output(L.v);
    const loss = g.reduceMean(g.mul(L.out, g.const('probe', [T, D], probe)), [0, 1], false); g.output(loss);
    return { g, loss, params, k: L.k, v: L.v, out: L.out };
}
// 全模型：token id → 28 層 → 最終 RMSNorm → 綁定嵌入的輸出頭 → 交叉熵（onehot 的整列為 0 代表該位置不計損失）
function buildFull(M, T, rank, opts) {
    opts = opts || {}; const nl = opts.layers === undefined ? 28 : opts.layers; const g = new Gm.G(); const c = sharedConsts(g, M, T, rank, opts.alpha); const params = [];
    c.dbgList = opts.debug ? [] : null;
    const et = initOf(M, 'model.embed_tokens.weight_quantized'); const V = et.dims[0];
    const embQ = g.const('emb.q', [V, D], M.bytes.subarray(et.rawStart, et.rawEnd), 'u8'), embS = g.scalar(scalarOf(M, 'model.embed_tokens.weight_scale')), embZ = g.const('emb.z', [], Float64Array.of(scalarOf(M, 'model.embed_tokens.weight_zero_point')));
    const ids = g.input('ids', [T], 'i64'); const rowmask = g.input('rowmask', [T]);   // rowmask[t] = 該位置權重（1/有效位置數；0＝不計損失）
    let h = opts.hostEmbed ? g.input('x', [T, D]) : dq(g, g.gather(embQ, ids), embS, embZ);   // hostEmbed：嵌入查表在圖外做（WebGPU 後端的 uint8 Gather 實測會輸出全 0）
    const dbg = c.dbgList || []; if (opts.debug) dbg.push(g.output(h));
    for (let l = 0; l < nl; l++) { const L = addLayer(g, M, c, l, h, T, rank, params); h = L.out; if (opts.debug) { dbg.push(g.output(L.k)); dbg.push(g.output(L.out)); } }
    const nf = rmsOf(g, M, c, h, 'model.layers.28.final_norm_layernorm.weight', D);
    // 輸出頭分塊：詞表切成 C 塊（列連續，零拷貝切片），任何時刻只展開 1/C 的 fp32 權重；
    // loss_t = log Σ_c Σ_j exp(logit) − logit[target]（不減最大值：綁定嵌入的 logit 實測在數十以內，f32 的 exp 上限約 88；超過會變 inf，由呼叫端的 loss 檢查攔下）
    const C = opts.headChunks || 8; if (V % C) throw new Error('詞表大小不能被分塊數整除'); const Vc = V / C; let Z = null, TL = null;
    for (let k = 0; k < C; k++) {
        const cq = g.const('head.q' + k, [Vc, D], M.bytes.subarray(et.rawStart + k * Vc * D, et.rawStart + (k + 1) * Vc * D), 'u8'); const oh = g.input('onehot' + k, [T, Vc]);
        const lg = g.matmul(nf, dq(g, g.transpose(cq, [1, 0]), embS, embZ));
        if (opts.debug && k === 0) { dbg.push(g.output(nf)); dbg.push(g.output(lg)); }
        const z = g.reduceSum(g.exp(lg), [1], false), tl = g.reduceSum(g.mul(lg, oh), [1], false);
        Z = Z ? g.add(Z, z) : z; TL = TL ? g.add(TL, tl) : tl;
    }
    const loss = g.reduceSum(g.mul(g.sub(g.log(Z), TL), rowmask), [0], false); g.output(loss);
    return { g, loss, params, V, C, Vc, dbg: dbg.map((t) => t.name) };
}

// 把 token id 經量化嵌入表取成 float 隱藏狀態 [T,d]
function embed(M, ids) { const t = initOf(M, 'model.embed_tokens.weight_quantized'); if (t.dataType !== 2 || t.rawStart < 0) throw new Error('嵌入表不是 raw uint8'); const sc = scalarOf(M, 'model.embed_tokens.weight_scale'), zp = scalarOf(M, 'model.embed_tokens.weight_zero_point'); const d = t.dims[1]; const o = new Float64Array(ids.length * d); ids.forEach((id, i) => { for (let j = 0; j < d; j++) o[i * d + j] = (M.bytes[t.rawStart + id * d + j] - zp) * sc; }); return o; }

// ───────── 逐層圖（網頁版逐層訓練用）─────────
// 前向圖 F：x、本層 LoRA 參數 → y；
// 反向圖 B：x、dy、本層 LoRA 參數 → y（前向重算，等於 activation checkpointing）、dx、本層 14 個梯度；
// 頭部圖：h → loss、dh。每張圖只含一層的權重（約 15MB），所以任何時刻 WASM 記憶體都遠低於 4GB。
function layerParamNames(layer) { const o = []; for (const k of ['q', 'k', 'v', 'o', 'gate', 'up', 'down']) { o.push('l' + layer + '.' + k + '.A', 'l' + layer + '.' + k + '.B'); } return o; }
function buildLayerF(M, layer, T, rank, opts) {
    opts = opts || {}; const g = new Gm.G(); const x = g.input('x', [T, D]); const c = sharedConsts(g, M, T, rank, opts.alpha); const params = [];
    const L = addLayer(g, M, c, layer, x, T, rank, params); g.output(L.out); return { g, params, out: L.out };
}
function buildLayerB(M, layer, T, rank, opts) {
    opts = opts || {}; const g = new Gm.G(); const x = g.input('x', [T, D]); const dy = g.input('dy', [T, D]); const c = sharedConsts(g, M, T, rank, opts.alpha); const params = [];
    const L = addLayer(g, M, c, layer, x, T, rank, params);
    const gr = Gm.grad(g, L.out, ['x'].concat(params.map((p) => p.name)), dy);
    g.output(gr.get('x')); const names = params.map((p) => { g.output(gr.get(p.name)); return p.name; });
    return { g, params, dx: gr.get('x'), gradNames: names, gradOuts: params.map((p) => gr.get(p.name).name) };
}
function buildHead(M, T, opts) {
    opts = opts || {}; const g = new Gm.G(); const h = g.input('h', [T, D]); const c = sharedConsts(g, M, T, 1, opts.alpha); const chunks = opts.headChunks || 8;
    const et = initOf(M, 'model.embed_tokens.weight_quantized'); const V = et.dims[0], Vc = V / chunks; if (V % chunks) throw new Error('詞表大小不能被分塊數整除');
    const embS = g.scalar(scalarOf(M, 'model.embed_tokens.weight_scale')), embZ = g.const('emb.z', [], Float64Array.of(scalarOf(M, 'model.embed_tokens.weight_zero_point')));
    const rowmask = g.input('rowmask', [T]); const nf = rmsOf(g, M, c, h, 'model.layers.28.final_norm_layernorm.weight', D); let Z = null, TL = null;
    for (let k = 0; k < chunks; k++) {
        const cq = g.const('head.q' + k, [Vc, D], M.bytes.subarray(et.rawStart + k * Vc * D, et.rawStart + (k + 1) * Vc * D), 'u8'); const oh = g.input('onehot' + k, [T, Vc]);
        const lg = g.matmul(nf, dq(g, g.transpose(cq, [1, 0]), embS, embZ)); const z = g.reduceSum(g.exp(lg), [1], false), tl = g.reduceSum(g.mul(lg, oh), [1], false);
        Z = Z ? g.add(Z, z) : z; TL = TL ? g.add(TL, tl) : tl;
    }
    const loss = g.reduceSum(g.mul(g.sub(g.log(Z), TL), rowmask), [0], false);
    const gr = Gm.grad(g, loss, ['h']); g.output(loss); g.output(gr.get('h'));
    return { g, loss, dh: gr.get('h'), V, Vc, chunks };
}

module.exports = { layerParamNames, buildLayerF, buildLayerB, buildHead, openModel, buildBlock, buildFull, embed, f32Of, scalarOf, ropeTables };
