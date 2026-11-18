// 產生 SmolVLM GPU 對拍用的二進位檔（寫入 SMOLVLM_DIR/gpu-test/，不進 git）：
//   vis.bin／vis.json：視覺編碼器權重（骨架排列：patch 權重為 (py,px,c)、線性層為 [out][in]、連接器為 [576][12288]）。
//   vis_ort.bin：ORT 對同一張合成 512 影像算出的 image_features（[64][576]）。
//   img_ids.json：含 64 個影像位置的詞元序列；img_ort.bin：ORT 解碼器對該序列的 logits（[T][vocab]）。
// 影像公式與 smolvlm_vision_real_check.js 相同（512×512，CHW 給 ORT）。
// 用法：SMOLVLM_DIR=<目錄> [ORT_NODE_DIR=...] node scripts/eval/smolvlm_gpu_dump.js
'use strict';
const fs = require('fs');
const path = require('path');
const dir = process.env.SMOLVLM_DIR;
if (!dir) { console.log('請設定 SMOLVLM_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const { readNodes } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const tc = cfg.text_config;
const H = 768, P = 16, C = 3, S = 512, NP = 1024, LAY = 12, F = 3072, LMH = tc.hidden_size, LMV = tc.vocab_size;
const IMG_TOKEN = cfg.image_token_id, NIMG = 64;
const vfile = path.join(dir, 'vision_encoder.onnx');
const outDir = path.join(dir, 'gpu-test');

function f32(raw) { const ab = new ArrayBuffer(raw.length); new Uint8Array(ab).set(raw); return new Float32Array(ab); }
function tr(w, inD, outD) { const o = new Float32Array(inD * outD); for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) o[c * inD + r] = w[r * outD + c]; return o; }

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  // 視覺權重：與 smolvlm_vision_real_check.js 相同的對應（MatMul 權重＝後面 Add 的偏置名稱）
  const nodes = readNodes(vfile);
  const init = new Map();
  for (const t of initializers(vfile)) if (t.dataType === 1 && t.raw) init.set(t.name, { dims: t.dims, data: f32(t.raw) });
  const g = (n) => { const x = init.get(n); if (!x) throw new Error('缺少 ' + n); return x.data; };
  const projMap = { q_proj: 'wq', k_proj: 'wk', v_proj: 'wv', out_proj: 'wo', fc1: 'w1', fc2: 'w2' };
  const mm = new Map();
  for (const n of nodes) if (n.op === 'MatMul') {
    const wName = n.inputs.find((x) => init.has(x) && x.indexOf('onnx::MatMul') === 0);
    if (!wName) continue;
    const add = nodes.find((m) => m.op === 'Add' && m.inputs.indexOf(n.outputs[0]) >= 0 && m.inputs.some((x) => /\.bias$/.test(x)));
    if (!add) continue;
    const bias = add.inputs.find((x) => /\.bias$/.test(x));
    const mmx = /^vision_model\.encoder\.layers\.(\d+)\.(self_attn|mlp)\.(\w+)\.bias$/.exec(bias);
    if (!mmx || !projMap[mmx[3]]) continue;
    mm.set(wName, { layer: Number(mmx[1]), key: projMap[mmx[3]] });
  }
  const layers = []; for (let i = 0; i < LAY; i++) layers.push({});
  for (const [wName, info] of mm) { const w = init.get(wName); layers[info.layer][info.key] = tr(w.data, w.dims[0], w.dims[1]); }
  const tensors = [];
  const add = (name, arr) => tensors.push([name, arr]);
  // patch 權重：HF [out][c][py][px] → 骨架 (py,px,c)
  const conv = g('vision_model.embeddings.patch_embedding.weight');
  const patchW = new Float32Array(H * P * P * C);
  for (let h = 0; h < H; h++) for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) for (let c = 0; c < C; c++)
    patchW[h * P * P * C + (py * P + px) * C + c] = conv[((h * C + c) * P + py) * P + px];
  add('patchW', patchW);
  add('patchB', g('vision_model.embeddings.patch_embedding.bias'));
  add('pos', g('vision_model.embeddings.position_embedding.weight'));
  for (let i = 0; i < LAY; i++) {
    const p = 'vision_model.encoder.layers.' + i + '.';
    const L = layers[i];
    add('v' + i + '.ln1g', g(p + 'layer_norm1.weight')); add('v' + i + '.ln1b', g(p + 'layer_norm1.bias'));
    add('v' + i + '.wq', L.wq); add('v' + i + '.bq', g(p + 'self_attn.q_proj.bias'));
    add('v' + i + '.wk', L.wk); add('v' + i + '.bk', g(p + 'self_attn.k_proj.bias'));
    add('v' + i + '.wv', L.wv); add('v' + i + '.bv', g(p + 'self_attn.v_proj.bias'));
    add('v' + i + '.wo', L.wo); add('v' + i + '.bo', g(p + 'self_attn.out_proj.bias'));
    add('v' + i + '.ln2g', g(p + 'layer_norm2.weight')); add('v' + i + '.ln2b', g(p + 'layer_norm2.bias'));
    add('v' + i + '.w1', L.w1); add('v' + i + '.b1', g(p + 'mlp.fc1.bias'));
    add('v' + i + '.w2', L.w2); add('v' + i + '.b2', g(p + 'mlp.fc2.bias'));
  }
  add('postG', g('vision_model.post_layernorm.weight')); add('postB', g('vision_model.post_layernorm.bias'));
  const connName = [...init.keys()].find((k) => k.indexOf('onnx::MatMul') === 0 && init.get(k).dims[0] === 12288 && init.get(k).dims[1] === LMH);
  if (!connName) throw new Error('找不到連接器 [12288,576]');
  add('connW', tr(init.get(connName).data, 12288, LMH));   // [576][12288]
  // 後面只要合併成一個二進位檔
  let total = 0; const index = [];
  for (const [name, arr] of tensors) { index.push({ name: name, off: total, len: arr.length }); total += arr.length; }
  const bin = Buffer.alloc(total * 4);
  tensors.forEach(([, arr], i) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(bin, index[i].off * 4));
  fs.writeFileSync(path.join(outDir, 'vis.bin'), bin);
  fs.writeFileSync(path.join(outDir, 'vis.json'), JSON.stringify({ H, P, C, NP, LAY, F, S, LMH, tensors: index }));
  console.log('vis.bin', (bin.length / 1048576).toFixed(1), 'MB，張量', index.length, '個；連接器', connName);

  // 同一張合成影像（CHW 給 ORT）
  const chw = new Float32Array(C * S * S);
  for (let c = 0; c < C; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++)
    chw[(c * S + y) * S + x] = Math.sin(0.013 * x + 0.021 * y + c) * 0.8 + Math.cos(0.007 * x * y / S + c);
  const vs = await ORT.InferenceSession.create(vfile, { executionProviders: ['cpu'] });
  const vo = await vs.run({ pixel_values: new ORT.Tensor('float32', chw, [1, 1, C, S, S]),pixel_attention_mask: new ORT.Tensor('bool', new Uint8Array(S * S).fill(1), [1, 1, S, S]) });
  const feat = vo.image_features.data;
  fs.writeFileSync(path.join(outDir, 'vis_ort.bin'), Buffer.from(feat.buffer, feat.byteOffset, feat.byteLength));
  console.log('vis_ort image_features', JSON.stringify(vo.image_features.dims));
  await vs.release();

  // 含影像位置的 LM 序列與 ORT 參考 logits（ORT 的影像嵌入來自上面的 image_features）
  const dfile = path.join(dir, 'decoder_model_merged_q4.onnx');
  const fp32 = path.join(dir, 'decoder_model_merged.onnx');
  const emb = f32(initializers(path.join(dir, 'embed_tokens.onnx')).find((t) => t.name === 'weight').raw);
  const ids = [1, 4].concat(Array(NIMG).fill(IMG_TOKEN), [33, 77]);
  const T = ids.length;
  const inputs = new Float32Array(T * LMH); let k = 0;
  for (let p = 0; p < T; p++) inputs.set(ids[p] === IMG_TOKEN ? feat.subarray(k++ * LMH, k * LMH) : emb.subarray(ids[p] * LMH, ids[p] * LMH + LMH), p * LMH);
  const ds = await ORT.InferenceSession.create(fp32, { executionProviders: ['cpu'] });
  const feeds = {
    inputs_embeds: new ORT.Tensor('float32', inputs, [1, T, LMH]),
    attention_mask: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]),
    position_ids: new ORT.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]),
  };
  for (let i = 0; i < tc.num_hidden_layers; i++) {
    feeds['past_key_values.' + i + '.key'] = new ORT.Tensor('float32', new Float32Array(0), [1, tc.num_key_value_heads, 0, tc.head_dim]);
    feeds['past_key_values.' + i + '.value'] = new ORT.Tensor('float32', new Float32Array(0), [1, tc.num_key_value_heads, 0, tc.head_dim]);
  }
  const lo = await ds.run(feeds);
  fs.writeFileSync(path.join(outDir, 'img_ort.bin'), Buffer.from(lo.logits.data.buffer, lo.logits.data.byteOffset, lo.logits.data.byteLength));
  fs.writeFileSync(path.join(outDir, 'img_ids.json'), JSON.stringify(ids));
  console.log('img_ort logits', JSON.stringify(lo.logits.dims), '（LMV', LMV, '）');
  await ds.release();
  void dfile;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
