// LLaVA-Interleave 0.5B 的語言模型（Qwen2，24 層，有 q／k／v 偏置，嵌入與 lm_head 共用）整體 logits 對拍（CPU，fp32，真權重）。
// 左邊：ORT 跑 decoder_model_merged.onnx（fp32）。右邊：renderer/src/gpu/llm_skeleton.js 的 stepVec，權重從同一個 ONNX 抽出，描述表依 config.json 的 text_config。
// 影像嵌入：vision_encoder.onnx（ORT）對同一張合成 384 影像的 image_features（729 個），這裡只取前 K 個（K 預設 32）放進影像位置，
//   目的是讓 JS 的語言模型計算量可控；這是「語言模型的對拍」，不是完整的看圖對拍（完整的視覺路徑已在 llava_siglip_check.js 對拍）。
// 每個位置比較 logits：最大絕對差、最大相對誤差（最大絕對差 ÷ 該位置 logits 的最大絕對值）、top-5 是否相同、argmax 是否相同。
// 用法：LLAVA_DIR=<目錄> [LLAVA_IMG_TOKENS=32] [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/llava_lm_check.js
'use strict';
const path = require('path');
const fs = require('fs');
const dir = process.env.LLAVA_DIR;
if (!dir) { console.log('請設定 LLAVA_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const LLM = require(path.join(__dirname, '../../renderer/src/gpu/llm_skeleton.js'));
const { readNodesDeep, readNodes, withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const tc = cfg.text_config;
const K = Number(process.env.LLAVA_IMG_TOKENS || 32);
const IMAGE_TOKEN = cfg.image_token_index;
const ARCH = {
  family: 'qwen2', status: 'supported', verified: false,
  layers: tc.num_hidden_layers, hidden: tc.hidden_size, heads: tc.num_attention_heads, kvHeads: tc.num_key_value_heads,
  headDim: tc.hidden_size / tc.num_attention_heads, ffn: tc.intermediate_size,
  norm: 'rmsnorm', eps: 1e-6, qkNorm: false,   // config 沒有 rms_norm_eps；1e-6 已從 decoder_model_merged_q4.onnx 的 RMSNorm 常數讀出（llava_patch_embed_check.js）
  rope: { base: tc.rope_theta, scaling: null, style: 'half' },
  act: 'silu_mul', bias: true, tiedEmbeddings: !!tc.tie_word_embeddings,
  vocab: tc.vocab_size, quant: ['f32'],
};
function f32map(file, pickName) {
  const m = new Map();
  for (const t of initializers(file)) if (t.dataType === 1 && t.raw && pickName(t.name)) { const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); m.set(t.name, { dims: t.dims, data: new Float32Array(ab) }); }
  return m;
}
function transposeIO(w) { // ONNX MatMul [in][out] → 骨架 [out][in]
  const inD = w.dims[0], outD = w.dims[1]; const o = new Float32Array(inD * outD);
  for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) o[c * inD + r] = w.data[r * outD + c];
  return o;
}
function cmpRows(sk, ort, T, V) {
  let worstAbs = 0, worstRel = 0, top5 = 0, arg = 0;
  for (let p = 0; p < T; p++) {
    const a = sk[p], b = ort.subarray(p * V, (p + 1) * V);
    let mx = 0, mref = 0;
    for (let i = 0; i < V; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; if (Math.abs(b[i]) > mref) mref = Math.abs(b[i]); }
    if (mx > worstAbs) worstAbs = mx;
    if (mx / mref > worstRel) worstRel = mx / mref;
    const top = (v) => Array.from(v.keys()).sort((i, j) => v[j] - v[i]).slice(0, 5);
    const ta = top(a), tb = top(b);
    if (ta.join(',') === tb.join(',')) top5++;
    if (ta[0] === tb[0]) arg++;
  }
  return { worstAbs, worstRel, top5, arg };
}

(async () => {
  const dfile = path.join(dir, 'decoder_model_merged.onnx');
  const nodes = readNodesDeep(dfile);
  const find = (suffix) => { const n = nodes.find((x) => x.name === suffix); if (!n) throw new Error('找不到節點 ' + suffix); return n; };
  const L = ARCH.layers;
  // 投影權重：節點名稱固定（/model/layers.N/…/MatMul），權重是第二個輸入
  const mmName = (n, p) => '/model/layers.' + n + '/' + p + '/MatMul';
  const wNames = [];
  for (let n = 0; n < L; n++) for (const p of ['self_attn/q_proj', 'self_attn/k_proj', 'self_attn/v_proj', 'self_attn/o_proj', 'mlp/gate_proj', 'mlp/up_proj', 'mlp/down_proj']) wNames.push([n, p, find(mmName(n, p)).inputs[1]]);
  const need = new Set(wNames.map((x) => x[2]));
  const Wraw = f32map(dfile, (name) => need.has(name) || /^model\.layers\.\d+\.(self_attn\.[qkv]_proj\.bias|input_layernorm\.weight|post_attention_layernorm\.weight)$/.test(name) || /^model\.norm\.weight$/.test(name) || /embed_tokens/.test(name));
  const get = (name) => { const x = Wraw.get(name); if (!x) throw new Error('缺少權重 ' + name); return x.data; };
  // 嵌入表在另一個檔案 embed_tokens.onnx（常數 weight，[vocab][hidden]）；解碼器本身不含嵌入表
  const embedW = f32map(path.join(dir, 'embed_tokens.onnx'), (n) => n === 'weight').get('weight');
  if (!embedW) throw new Error('embed_tokens.onnx 裡找不到 weight');
  const embed = embedW.data;   // [vocab][hidden]
  const embedName = 'embed_tokens.onnx:weight';
  const layers = [];
  for (let n = 0; n < L; n++) {
    const byP = {}; for (const [ln, p, w] of wNames) if (ln === n) byP[p] = w;
    const bp = 'model.layers.' + n + '.';
    layers.push({
      attnNorm: get(bp + 'input_layernorm.weight'), ffnNorm: get(bp + 'post_attention_layernorm.weight'),
      wq: transposeIO(Wraw.get(byP['self_attn/q_proj'])), wk: transposeIO(Wraw.get(byP['self_attn/k_proj'])),
      wv: transposeIO(Wraw.get(byP['self_attn/v_proj'])), wo: transposeIO(Wraw.get(byP['self_attn/o_proj'])),
      bq: get(bp + 'self_attn.q_proj.bias'), bk: get(bp + 'self_attn.k_proj.bias'), bv: get(bp + 'self_attn.v_proj.bias'),
      wGate: transposeIO(Wraw.get(byP['mlp/gate_proj'])), wUp: transposeIO(Wraw.get(byP['mlp/up_proj'])), wDown: transposeIO(Wraw.get(byP['mlp/down_proj'])),
    });
  }
  const weights = { embed: embed, finalNorm: get('model.norm.weight'), lmHead: null, layers: layers };
  console.log('權重就緒：層', L, '，隱藏', ARCH.hidden, '，KV 頭', ARCH.kvHeads, '，嵌入', embedName, '，tied', ARCH.tiedEmbeddings);

  // 影像嵌入：ORT 視覺編碼器（同一張合成 384 影像）
  const S = cfg.vision_config.image_size, C = 3;
  const chw = new Float32Array(C * S * S);
  for (let c = 0; c < C; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) chw[(c * S + y) * S + x] = Math.sin(0.011 * x + 0.017 * y + 0.7 * c) * 0.9 + Math.cos(0.005 * x * y / S + c);
  const vs = await ORT.InferenceSession.create(path.join(dir, 'vision_encoder.onnx'), { executionProviders: ['cpu'] });
  const vo = await vs.run({ pixel_values: new ORT.Tensor('float32', chw, [1, C, S, S]) });
  const img = vo.image_features.data; const NI = vo.image_features.dims[1];
  await vs.release();
  const H = ARCH.hidden;
  const imgEmb = []; for (let t = 0; t < K; t++) imgEmb.push(img.subarray(t * H, t * H + H));
  console.log('影像嵌入：ORT 輸出', NI, '個，使用前', K, '個');

  // 序列：前綴＋K 個影像位置＋後綴（詞元 id 在詞表內即可，這裡只對拍數值）
  const ids = [151644, 872, 198].concat(Array(K).fill(IMAGE_TOKEN), [151645, 198, 3838, 374]);
  const T = ids.length;
  const inputs = new Float32Array(T * H); let k = 0;
  for (let p = 0; p < T; p++) inputs.set(ids[p] === IMAGE_TOKEN ? imgEmb[k++] : embed.subarray(ids[p] * H, ids[p] * H + H), p * H);

  // ORT 解碼器（無快取的第一步）：past 為長度 0
  const dsess = await ORT.InferenceSession.create(dfile, { executionProviders: ['cpu'] });
  const kvh = ARCH.kvHeads, hd = ARCH.headDim;
  const feeds = {
    inputs_embeds: new ORT.Tensor('float32', inputs, [1, T, H]),
    attention_mask: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]),
    position_ids: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]),
  };
  for (let i = 0; i < L; i++) {
    feeds['past_key_values.' + i + '.key'] = new ORT.Tensor('float32', new Float32Array(0), [1, kvh, 0, hd]);
    feeds['past_key_values.' + i + '.value'] = new ORT.Tensor('float32', new Float32Array(0), [1, kvh, 0, hd]);
  }
  const t0 = Date.now();
  const dout = await dsess.run(feeds);
  const ortLogits = dout.logits.data;
  console.log('ORT 解碼器完成，logits 形狀', JSON.stringify(dout.logits.dims), '，耗時', Date.now() - t0, 'ms');
  await dsess.release();

  // 骨架：逐位置 stepVec（與 llava_skeleton.js 的 forward 相同的輸入組裝：影像位置換成影像嵌入）
  const st = LLM.createState(ARCH, weights);
  const t1 = Date.now();
  const sk = [];
  k = 0;
  for (let p = 0; p < T; p++) {
    const x = ids[p] === IMAGE_TOKEN ? imgEmb[k++] : embed.subarray(ids[p] * H, ids[p] * H + H);
    sk.push(LLM.stepVec(st, x));
  }
  console.log('骨架解碼完成，耗時', Date.now() - t1, 'ms');
  const r = cmpRows(sk, ortLogits, T, ARCH.vocab);
  console.log('位置數', T, '最大絕對差', r.worstAbs.toExponential(3), '最大相對誤差', r.worstRel.toExponential(3));
  console.log('top-5 完全相同的位置', r.top5 + '/' + T, 'argmax 相同的位置', r.arg + '/' + T);
  const pass = r.worstRel < 1e-3 && r.top5 === T;
  console.log(pass ? '通過：Qwen2 語言模型（含偏置、tied 嵌入）整體 logits 與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
