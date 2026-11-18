// 把 SmolVLM 256M 語言解碼器的 fp32 權重與 ORT 的參考 logits 寫成瀏覽器可讀的二進位檔（給 GPU 對拍頁使用）。
// 輸出目錄：SMOLVLM_DIR/gpu-test/（在 ai-temp 下，不進 git）。
//   lm.bin：所有權重連續存放（Float32，小端）；lm.json：每個張量的名稱、長度、偏移（以元素計）。
//   ort.bin：ORT 對同一段詞元算出的 logits（[T][vocab]）；ids.json：詞元 id。
// 用法：SMOLVLM_DIR=<含 decoder_model_merged.onnx、embed_tokens.onnx 的目錄> [ORT_NODE_DIR=...] node scripts/eval/smolvlm_lm_gpu_dump.js
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.env.SMOLVLM_DIR;
if (!dir) { console.log('請設定 SMOLVLM_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const tc = cfg.text_config;
const L = tc.num_hidden_layers, H = tc.hidden_size, KV = tc.num_key_value_heads, HD = tc.head_dim, V = tc.vocab_size;
const IDS = [1, 4, 33, 77];   // 純文字，詞元 id 在詞表內（只對拍數值）

function f32map(file) {
  const m = new Map();
  for (const t of initializers(file)) if (t.dataType === 1 && t.raw) { const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); m.set(t.name, { dims: t.dims, data: new Float32Array(ab) }); }
  return m;
}
function tr(w) { const inD = w.dims[0], outD = w.dims[1]; const o = new Float32Array(inD * outD); for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) o[c * inD + r] = w.data[r * outD + c]; return o; }
const dfile = path.join(dir, 'decoder_model_merged.onnx');
const D = f32map(dfile);
const get = (n) => { const x = D.get(n); if (!x) throw new Error('缺少 ' + n); return x; };
const embed = f32map(path.join(dir, 'embed_tokens.onnx')).get('weight');
if (!embed) throw new Error('embed_tokens.onnx 缺 weight');

// 張量清單（名稱 → Float32Array），依 llm_skeleton 的權重格式（矩陣為 [out][in] row-major）
const items = [];
items.push(['embed', embed.data]);
for (let i = 0; i < L; i++) {
  const p = 'model.layers.' + i + '.';
  items.push(['l' + i + '.attnNorm', get(p + 'input_layernorm.weight').data]);
  items.push(['l' + i + '.wq', tr(get(p + 'attn.q_proj.MatMul.weight'))]);
  items.push(['l' + i + '.wk', tr(get(p + 'attn.k_proj.MatMul.weight'))]);
  items.push(['l' + i + '.wv', tr(get(p + 'attn.v_proj.MatMul.weight'))]);
  items.push(['l' + i + '.wo', tr(get(p + 'attn.o_proj.MatMul.weight'))]);
  items.push(['l' + i + '.ffnNorm', get(p + 'post_attention_layernorm.weight').data]);
  items.push(['l' + i + '.wGate', tr(get(p + 'mlp.gate_proj.MatMul.weight'))]);
  items.push(['l' + i + '.wUp', tr(get(p + 'mlp.up_proj.MatMul.weight'))]);
  items.push(['l' + i + '.wDown', tr(get(p + 'mlp.down_proj.MatMul.weight'))]);
}
items.push(['finalNorm', get('model.layers.' + L + '.final_norm_layernorm.weight').data]);
items.push(['lmHead', tr(get('lm_head.MatMul.weight'))]);

(async () => {
  const out = path.join(dir, 'gpu-test');
  fs.mkdirSync(out, { recursive: true });
  let total = 0; const index = [];
  for (const [name, arr] of items) { index.push({ name: name, off: total, len: arr.length }); total += arr.length; }
  const bin = Buffer.alloc(total * 4);
  for (const [i, [, arr]] of items.entries()) Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(bin, index[i].off * 4);
  fs.writeFileSync(path.join(out, 'lm.bin'), bin);
  fs.writeFileSync(path.join(out, 'lm.json'), JSON.stringify({ layers: L, hidden: H, kvHeads: KV, headDim: HD, ffn: tc.intermediate_size, vocab: V, eps: tc.rms_norm_eps, ropeBase: tc.rope_theta, tied: !!tc.tie_word_embeddings, tensors: index }));
  fs.writeFileSync(path.join(out, 'ids.json'), JSON.stringify(IDS));
  console.log('寫入 lm.bin', (bin.length / 1048576).toFixed(1), 'MB，張量', index.length, '個');

  // ORT 參考 logits
  const dsess = await ORT.InferenceSession.create(dfile, { executionProviders: ['cpu'] });
  const T = IDS.length;
  const emb = new Float32Array(T * H);
  for (let p = 0; p < T; p++) emb.set(embed.data.subarray(IDS[p] * H, IDS[p] * H + H), p * H);
  const feeds = {
    inputs_embeds: new ORT.Tensor('float32', emb, [1, T, H]),
    attention_mask: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]),
    position_ids: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]),
  };
  for (let i = 0; i < L; i++) {
    feeds['past_key_values.' + i + '.key'] = new ORT.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
    feeds['past_key_values.' + i + '.value'] = new ORT.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
  }
  const o = await dsess.run(feeds);
  const lg = Buffer.from(o.logits.data.buffer, o.logits.data.byteOffset, o.logits.data.byteLength);
  fs.writeFileSync(path.join(out, 'ort.bin'), lg);
  console.log('ORT logits', JSON.stringify(o.logits.dims), '寫入 ort.bin');
  await dsess.release();
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
