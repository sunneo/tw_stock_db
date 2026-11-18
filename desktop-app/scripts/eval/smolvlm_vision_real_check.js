// 真權重對拍：vision_encoder.onnx（ORT）對 smolvlm 骨架（CPU 參考，權重從 ONNX initializer 抽出）。
const fs = require('fs');
const SCR = (process.env.SMOLVLM_CHECK_OUT || require('os').tmpdir()) + '/';
const ROOT = require('path').join(__dirname, '../../renderer/src/gpu') + '/';
const MODEL_DIR = (process.env.SMOLVLM_DIR || '') + '/';
if (!process.env.SMOLVLM_DIR) { console.log('請設定 SMOLVLM_DIR 為放 vision_encoder.onnx 的目錄'); process.exit(2); }
const ONNX = MODEL_DIR + 'vision_encoder.onnx';
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const VIT = require(ROOT + 'vit_skeleton.js');
const SMOL = require(ROOT + 'smolvlm_skeleton.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

// 讀 ONNX 節點（NodeProto：1 input、2 output、4 op_type）
function nodesOf(file) {
  const b = fs.readFileSync(file);
  function rd(s, e) {
    const out = []; const p = { i: s };
    const v = () => { let r = 0n, sh = 0n, c; do { c = b[p.i++]; r |= BigInt(c & 0x7f) << sh; sh += 7n; } while (c & 0x80); return r; };
    while (p.i < e) {
      const key = Number(v()); const fn = key >>> 3, wt = key & 7;
      if (wt === 0) v();
      else if (wt === 2) { const len = Number(v()); out.push([fn, p.i, p.i + len]); p.i += len; }
      else if (wt === 5) p.i += 4;
      else if (wt === 1) p.i += 8;
    }
    return out;
  }
  const top = rd(0, b.length);
  const g = top.find((x) => x[0] === 7);
  const nodes = [];
  for (const [fn, s, e] of rd(g[1], g[2])) if (fn === 1) {
    const n = { in: [], out: [], op: '' };
    for (const [f2, s2, e2] of rd(s, e)) {
      const str = b.subarray(s2, e2).toString('utf8');
      if (f2 === 1) n.in.push(str); else if (f2 === 2) n.out.push(str); else if (f2 === 4) n.op = str;
    }
    nodes.push(n);
  }
  return nodes;
}
function f32(raw) { const ab = new ArrayBuffer(raw.length); new Uint8Array(ab).set(raw); return new Float32Array(ab); }

(async () => {
  const inits = initializers(ONNX);
  const W = new Map();
  for (const t of inits) if (t.dataType === 1 && t.raw) W.set(t.name, { dims: t.dims, data: f32(t.raw) });
  const nodes = nodesOf(ONNX);
  // 把匿名 MatMul 權重接到它後面的 Add 偏置，得到 layers[i] 的投影名稱
  const projMap = { q_proj: 'wq', k_proj: 'wk', v_proj: 'wv', out_proj: 'wo', fc1: 'w1', fc2: 'w2' };
  const matmulOf = new Map();
  for (const n of nodes) if (n.op === 'MatMul') {
    const wName = n.in.find((x) => W.has(x) && x.indexOf('onnx::MatMul') === 0);
    if (!wName) continue;
    const o = n.out[0];
    const add = nodes.find((m) => m.op === 'Add' && m.in.indexOf(o) >= 0 && m.in.some((x) => /\.bias$/.test(x)));
    if (!add) continue;
    const bias = add.in.find((x) => /\.bias$/.test(x));
    const mm = /^vision_model\.encoder\.layers\.(\d+)\.(self_attn|mlp)\.(\w+)\.bias$/.exec(bias);
    if (!mm) continue;
    const key = projMap[mm[3]];
    if (!key) continue;
    matmulOf.set(wName, { layer: Number(mm[1]), key: key });
  }
  const layers = [];
  for (let i = 0; i < 12; i++) layers.push({});
  for (const [wName, info] of matmulOf) {
    const w = W.get(wName); const inD = w.dims[0], outD = w.dims[1];
    // ONNX MatMul 權重是 [in][out]，骨架要 [out][in]
    const tr = new Float32Array(inD * outD);
    for (let r = 0; r < inD; r++) for (let c = 0; c < outD; c++) tr[c * inD + r] = w.data[r * outD + c];
    layers[info.layer][info.key] = tr;
  }
  const g = (name) => { const x = W.get(name); if (!x) throw new Error('缺少 ' + name); return x.data; };
  for (let i = 0; i < 12; i++) {
    const p = 'vision_model.encoder.layers.' + i + '.';
    const L = layers[i];
    L.ln1g = g(p + 'layer_norm1.weight'); L.ln1b = g(p + 'layer_norm1.bias');
    L.ln2g = g(p + 'layer_norm2.weight'); L.ln2b = g(p + 'layer_norm2.bias');
    L.bq = g(p + 'self_attn.q_proj.bias'); L.bk = g(p + 'self_attn.k_proj.bias');
    L.bv = g(p + 'self_attn.v_proj.bias'); L.bo = g(p + 'self_attn.out_proj.bias');
    L.b1 = g(p + 'mlp.fc1.bias'); L.b2 = g(p + 'mlp.fc2.bias');
    for (const k of ['wq', 'wk', 'wv', 'wo', 'w1', 'w2']) if (!L[k]) throw new Error('層 ' + i + ' 缺少 ' + k);
  }
  // 圖塊嵌入：Conv 權重 [H][C][py][px] → 骨架 patchify 的順序 (py,px,c)
  const conv = g('vision_model.embeddings.patch_embedding.weight');
  const H = 768, C = 3, P = 16;
  const patchW = new Float32Array(H * P * P * C);
  for (let h = 0; h < H; h++) for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) for (let c = 0; c < C; c++)
    patchW[h * P * P * C + (py * P + px) * C + c] = conv[((h * C + c) * P + py) * P + px];
  const w = {
    patchW: patchW, patchB: g('vision_model.embeddings.patch_embedding.bias'),
    pos: g('vision_model.embeddings.position_embedding.weight'), layers: layers,
    postG: g('vision_model.post_layernorm.weight'), postB: g('vision_model.post_layernorm.bias'),
  };
  // 連接器：唯一形狀 [12288,576] 的匿名 MatMul
  const connName = [...W.keys()].find((k) => k.indexOf('onnx::MatMul') === 0 && W.get(k).dims[0] === 12288 && W.get(k).dims[1] === 576);
  if (!connName) throw new Error('找不到連接器權重 [12288,576]');
  const cw = W.get(connName).data; const cIn = 12288, cOut = 576;
  const connW = new Float32Array(cIn * cOut);
  for (let r = 0; r < cIn; r++) for (let c = 0; c < cOut; c++) connW[c * cIn + r] = cw[r * cOut + c];
  console.log('mapped: layers 12, connector', connName, 'pos rows', w.pos.length / 768);

  // 同一張合成影像：CHW 給 ORT，HWC 給骨架
  const S = 512;
  const chw = new Float32Array(3 * S * S); const hwc = new Float32Array(S * S * 3);
  for (let c = 0; c < 3; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = Math.sin(0.013 * x + 0.021 * y + c) * 0.8 + Math.cos(0.007 * x * y / S + c);
    chw[(c * S + y) * S + x] = v; hwc[(y * S + x) * 3 + c] = v;
  }
  const sess = await ORT.InferenceSession.create(ONNX, { executionProviders: ['cpu'] });
  const out = await sess.run({
    pixel_values: new ORT.Tensor('float32', chw, [1, 1, 3, S, S]),
    pixel_attention_mask: new ORT.Tensor('bool', new Uint8Array(S * S).fill(1), [1, 1, S, S]),
  });
  const ref = out.image_features.data; // [64][576]
  const arch = { layers: 12, hidden: 768, heads: 12, ffn: 3072, patch: 16, channels: 3, eps: 1e-6 };
  const t0 = Date.now();
  const enc = VIT.encode(arch, w, hwc, S, S); // [1024][768]
  console.log('encoder ms', Date.now() - t0, 'tokens', enc.length);
  // 兩種順序：A＝骨架現行 (dy,dx,c)；B＝(c,dy,dx)
  const r = 4;
  const shuffleA = SMOL.pixelShuffle(enc, 32, 32, 768, r);
  const shuffleB = shuffleA.map((t) => {
    const u = new Float32Array(t.length);
    for (let dd = 0; dd < 16; dd++) for (let c = 0; c < 768; c++) u[c * 16 + dd] = t[dd * 768 + c];
    return u;
  });
  const zb = new Float32Array(576);
  const conA = SMOL.connector(connW, zb, 576, 12288, shuffleA);
  const conB = SMOL.connector(connW, zb, 576, 12288, shuffleB);
  function cmp(got) {
    let mx = 0, sumsq = 0, sumref = 0;
    for (let t = 0; t < 64; t++) for (let d = 0; d < 576; d++) {
      const a = got[t][d], b = ref[t * 576 + d]; const df = Math.abs(a - b);
      if (df > mx) mx = df; sumsq += df * df; sumref += b * b;
    }
    return { maxAbs: mx, relRms: Math.sqrt(sumsq / sumref) };
  }
  const resA = cmp(conA), resB = cmp(conB);
  console.log('ORDER_A (dy,dx,c) vs ORT:', JSON.stringify(resA));
  console.log('ORDER_B (c,dy,dx) vs ORT:', JSON.stringify(resB));
  fs.writeFileSync(SCR + 'vision_compare_result.json', JSON.stringify({ A: resA, B: resB, encoderMs: Date.now() - t0 }, null, 1));
  await sess.release();
  console.log(resA.relRms < 1e-4 ? '通過：ORDER_A（骨架現行順序）與 ORT 相符' : '不通過：ORDER_A 與 ORT 差距 relRms=' + resA.relRms);
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
