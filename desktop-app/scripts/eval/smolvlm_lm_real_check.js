// SmolVLM 256M 語言解碼器的真權重對拍（CPU，fp32）。
// 左邊：ONNX Runtime 跑 decoder_model_merged.onnx（fp32）。右邊：renderer/src/gpu/llm_skeleton.js 的 stepVec，權重從同一個 ONNX 抽出。
// 輸入序列：文字詞元＋影像佔位詞元（id＝image_token_id 49190，數量＝影像詞元數 64）；影像嵌入由 vision_encoder.onnx（ORT）產生，
// 依序取代佔位位置（與 HuggingFace 的 inputs_merger 相同規則）。
// 比較每個位置的 logits：最大絕對差、相對誤差（最大絕對差 ÷ 該位置 logits 的最大絕對值）、top-5 是否相同、argmax 是否相同。
// 用法：SMOLVLM_DIR=<含 onnx 檔與 config.json 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/smolvlm_lm_real_check.js
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.env.SMOLVLM_DIR;
if (!dir) { console.log('請設定 SMOLVLM_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const LLM = require(path.join(__dirname, '../../renderer/src/gpu/llm_skeleton.js'));
const SMOL = require(path.join(__dirname, '../../renderer/src/gpu/smolvlm_skeleton.js'));
const { initializers } = require('./smolvlm_onnx_initializers.js');

const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const tc = cfg.text_config;
const IMAGE_TOKEN = cfg.image_token_id;
const R = cfg.pixel_shuffle_factor || cfg.scale_factor;

// 語言模型描述（與 config.json 的 text_config 對照；不改 gpu/ 的描述表檔）
const ARCH = {
  family: 'llama', status: 'supported', verified: false,
  layers: tc.num_hidden_layers, hidden: tc.hidden_size, heads: tc.num_attention_heads, kvHeads: tc.num_key_value_heads,
  headDim: tc.head_dim, ffn: tc.intermediate_size, norm: 'rmsnorm', eps: tc.rms_norm_eps, qkNorm: false,
  rope: { base: tc.rope_theta, scaling: null, style: tc.rope_interleaved ? 'interleaved' : 'half' },
  act: 'silu_mul', bias: !!tc.attention_bias, tiedEmbeddings: !!tc.tie_word_embeddings,
  vocab: tc.vocab_size, quant: ['f32'],
};
const VIT_ARCH = { layers: cfg.vision_config.num_hidden_layers, hidden: cfg.vision_config.hidden_size, heads: cfg.vision_config.num_attention_heads,
  ffn: cfg.vision_config.intermediate_size, patch: cfg.vision_config.patch_size, channels: cfg.vision_config.num_channels, eps: cfg.vision_config.layer_norm_eps };

function f32(raw) { const ab = new ArrayBuffer(raw.length); new Uint8Array(ab).set(raw); return new Float32Array(ab); }
function loadMap(file) {
  const m = new Map();
  for (const t of initializers(file)) if (t.dataType === 1 && t.raw) m.set(t.name, { dims: t.dims, data: f32(t.raw) });
  return m;
}
// ONNX MatMul 權重是 [in][out]；骨架要 [out][in]
function transposeIO(w) {
  const inD = w.dims[0], outD = w.dims[1]; const tr = new Float32Array(inD * outD);
  for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) tr[c * inD + r] = w.data[r * outD + c];
  return tr;
}
function need(map, name) { const x = map.get(name); if (!x) throw new Error('缺少權重 ' + name); return x; }

(async () => {
  const dec = loadMap(path.join(dir, 'decoder_model_merged.onnx'));
  const emb = loadMap(path.join(dir, 'embed_tokens.onnx'));
  const embed = need(emb, 'weight').data;                       // [vocab][hidden]
  const layers = [];
  for (let i = 0; i < ARCH.layers; i++) {
    const p = 'model.layers.' + i + '.';
    layers.push({
      attnNorm: need(dec, p + 'input_layernorm.weight').data,
      wq: transposeIO(need(dec, p + 'attn.q_proj.MatMul.weight')),
      wk: transposeIO(need(dec, p + 'attn.k_proj.MatMul.weight')),
      wv: transposeIO(need(dec, p + 'attn.v_proj.MatMul.weight')),
      wo: transposeIO(need(dec, p + 'attn.o_proj.MatMul.weight')),
      ffnNorm: need(dec, p + 'post_attention_layernorm.weight').data,
      wGate: transposeIO(need(dec, p + 'mlp.gate_proj.MatMul.weight')),
      wUp: transposeIO(need(dec, p + 'mlp.up_proj.MatMul.weight')),
      wDown: transposeIO(need(dec, p + 'mlp.down_proj.MatMul.weight')),
    });
  }
  const weights = {
    embed: embed,
    finalNorm: need(dec, 'model.layers.' + ARCH.layers + '.final_norm_layernorm.weight').data,
    lmHead: ARCH.tiedEmbeddings ? null : transposeIO(need(dec, 'lm_head.MatMul.weight')),
    layers: layers,
  };
  console.log('權重對應完成：層數', ARCH.layers, '隱藏', ARCH.hidden, '詞表', ARCH.vocab);

  // 影像嵌入：vision_encoder.onnx（ORT）對一張合成 512×512 影像（與 smolvlm_vision_real_check 同一張）
  const S = cfg.vision_config.image_size;
  const chw = new Float32Array(3 * S * S);
  for (let c = 0; c < 3; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++)
    chw[(c * S + y) * S + x] = Math.sin(0.013 * x + 0.021 * y + c) * 0.8 + Math.cos(0.007 * x * y / S + c);
  const ve = await ORT.InferenceSession.create(path.join(dir, 'vision_encoder.onnx'), { executionProviders: ['cpu'] });
  const vo = await ve.run({
    pixel_values: new ORT.Tensor('float32', chw, [1, 1, 3, S, S]),
    pixel_attention_mask: new ORT.Tensor('bool', new Uint8Array(S * S).fill(1), [1, 1, S, S]),
  });
  const imgFeat = vo.image_features.data;                      // [nImg][hidden]
  const nImg = vo.image_features.dims[1], H = ARCH.hidden;
  const imgEmb = []; for (let t = 0; t < nImg; t++) imgEmb.push(imgFeat.subarray(t * H, t * H + H));
  await ve.release();
  console.log('影像詞元', nImg, '（config 的 scale_factor', R, '）');

  // 文字詞元：<|im_start|> 之類的 id 不查 tokenizer，只要在詞表內即可（對拍的是數值，不是內容）
  const pre = [1, 4, 33, 77];
  const post = [5, 102, 9, 250, 310];
  const ids = pre.concat(Array(nImg).fill(IMAGE_TOKEN), post);
  const T = ids.length;

  // ORT：文字嵌入查 embed 表，影像位置換成影像嵌入（與 inputs_merger 相同）
  const inputs = new Float32Array(T * H);
  let k = 0;
  for (let p = 0; p < T; p++) {
    const v = ids[p] === IMAGE_TOKEN ? imgEmb[k++] : embed.subarray(ids[p] * H, ids[p] * H + H);
    inputs.set(v, p * H);
  }
  const dsess = await ORT.InferenceSession.create(path.join(dir, 'decoder_model_merged.onnx'), { executionProviders: ['cpu'] });
  const feeds = {
    inputs_embeds: new ORT.Tensor('float32', inputs, [1, T, H]),
    attention_mask: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]),
    position_ids: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]),
  };
  for (let i = 0; i < ARCH.layers; i++) {
    feeds['past_key_values.' + i + '.key'] = new ORT.Tensor('float32', new Float32Array(0), [1, ARCH.kvHeads, 0, ARCH.headDim]);
    feeds['past_key_values.' + i + '.value'] = new ORT.Tensor('float32', new Float32Array(0), [1, ARCH.kvHeads, 0, ARCH.headDim]);
  }
  const t0 = Date.now();
  const dout = await dsess.run(feeds);
  const ortLogits = dout.logits.data;                          // [T][vocab]
  console.log('ORT 解碼器完成，形狀', JSON.stringify(dout.logits.dims), '耗時', Date.now() - t0, 'ms');
  await dsess.release();

  // 骨架：先用 SMOL.assemble 組序列（與 ORT 那段獨立寫的插入邏輯互相對照），再逐位置 stepVec
  const seq = SMOL.assemble({ hidden: H, vocab: ARCH.vocab }, ids, imgEmb, IMAGE_TOKEN, embed);
  const st = LLM.createState(ARCH, weights);
  const t1 = Date.now();
  const skLogits = seq.map((x) => LLM.stepVec(st, x));
  console.log('骨架解碼完成，耗時', Date.now() - t1, 'ms');

  // 比較
  let worstAbs = 0, worstRel = 0, top5Same = 0, argSame = 0;
  for (let p = 0; p < T; p++) {
    const a = skLogits[p], b = ortLogits.subarray(p * ARCH.vocab, (p + 1) * ARCH.vocab);
    let mx = 0, mref = 0;
    for (let i = 0; i < ARCH.vocab; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; if (Math.abs(b[i]) > mref) mref = Math.abs(b[i]); }
    if (mx > worstAbs) worstAbs = mx;
    if (mx / mref > worstRel) worstRel = mx / mref;
    const top = (v) => Array.from(v.keys()).sort((i, j) => v[j] - v[i]).slice(0, 5);
    const ta = top(a), tb = top(b);
    if (ta.join(',') === tb.join(',')) top5Same++;
    if (ta[0] === tb[0]) argSame++;
  }
  console.log('位置數', T, '最大絕對差', worstAbs.toExponential(3), '最大相對誤差', worstRel.toExponential(3));
  console.log('top-5 完全相同的位置', top5Same + '/' + T, 'argmax 相同的位置', argSame + '/' + T);
  const pass = worstRel < 1e-3 && top5Same === T;
  console.log(pass ? '通過：語言解碼器（fp32）與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
