// LLaVA-Interleave 0.5B：視覺 patch 嵌入的權重排列轉換，與語言模型 rms_norm_eps 的真權重對拍（CPU，fp32）。
// (1) 權重排列：HF 的 conv 權重是 [out][c][py][px]；骨架（vit_skeleton.patchify）的 patch 向量是 (py, px, c) 展開。
//     轉換後用骨架的 patchify＋linear 算出的 patch 嵌入，要與 ORT 的 conv 輸出逐位相同（token 的順序是 gy×W＋gx）。
// (2) 位置嵌入：ORT 的 Add 輸出 = patch 嵌入 + position_embedding[token]；這裡一併對拍。
// (3) rms_norm_eps：從 decoder_model_merged_q4.onnx 的 RMSNorm 常數讀出（量化不影響這個純量常數），與骨架使用的 1e-6 比較。
// 用法：LLAVA_DIR=<含 vision_encoder.onnx 與 decoder_model_merged_q4.onnx 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/llava_patch_embed_check.js
'use strict';
const path = require('path');
const fs = require('fs');
const dir = process.env.LLAVA_DIR;
if (!dir) { console.log('請設定 LLAVA_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const VIT = require(path.join(__dirname, '../../renderer/src/gpu/vit_skeleton.js'));
const { readNodes, withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const vfile = path.join(dir, 'vision_encoder.onnx');
const dfile = path.join(dir, 'decoder_model_merged_q4.onnx');
const CONVW = 'vision_tower.vision_model.embeddings.patch_embedding.weight';
const CONVB = 'vision_tower.vision_model.embeddings.patch_embedding.bias';
const POSW = '/vision_tower/vision_model/embeddings/position_embedding/Gather_output_0';   // 位置嵌入是常數 [1][729][1152]
const CONV_OUT = '/vision_tower/vision_model/embeddings/patch_embedding/Conv_output_0';
const EMB_OUT = '/vision_tower/vision_model/embeddings/Add_output_0';
const S = 384, P = 14, C = 3, HID = 1152;

// 只複製需要的權重（1.6GB 模型全部複製會佔太多記憶體）
function pick(file, names) {
  const out = new Map();
  for (const t of initializers(file)) if (names(t.name) && t.dataType === 1 && t.raw) { const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); out.set(t.name, { dims: t.dims, data: new Float32Array(ab) }); }
  return out;
}
function cmp(a, b) {
  let mx = 0, ss = 0, sr = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; ss += d * d; sr += b[i] * b[i]; }
  return { maxAbs: mx, relRms: Math.sqrt(ss / (sr || 1)) };
}
async function fetchOne(file, name, feeds) {
  const sess = await ORT.InferenceSession.create(withExtraOutputs(file, [name]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
  const o = await sess.run(feeds, [name]);
  const v = o[name] || o[Object.keys(o)[0]];
  await sess.release();
  return v;
}

(async () => {
  // (3) rms_norm_eps：先找 RMSNorm 的 Add 節點（Add(ReduceMean 輸出, eps 常數)）
  const dnodes = readNodes(dfile);
  const rmsAdds = dnodes.filter((n) => n.op === 'Add' && /layernorm\/Add$/.test(n.name) && n.inputs.some((x) => /ReduceMean/.test(x)));
  const dinit = new Map(); for (const t of initializers(dfile)) if (t.dataType === 1 && t.raw && t.raw.length === 4 && t.dims.length === 0) dinit.set(t.name, t.raw.readFloatLE(0));
  const epsVals = new Set();
  for (const n of rmsAdds) { const c = n.inputs.find((x) => dinit.has(x)); if (c !== undefined) epsVals.add(dinit.get(c)); }
  console.log('RMSNorm 節點', rmsAdds.length, '個，讀到的 eps 值：', JSON.stringify([...epsVals]));
  const epsOk = epsVals.size === 1 && Math.abs([...epsVals][0] - 1e-6) < 1e-12;
  console.log(epsOk ? 'rms_norm_eps 與骨架一致：1e-6' : '注意：rms_norm_eps 與骨架的 1e-6 不符，請修正');

  // (1)(2) patch 嵌入
  const W = pick(vfile, (n) => n === CONVW || n === CONVB || n === POSW);
  const cw = W.get(CONVW), cb = W.get(CONVB), pw = W.get(POSW);
  if (!cw || !cb || !pw) throw new Error('缺少 patch 權重');
  console.log('conv 權重形狀', JSON.stringify(cw.dims), '，位置嵌入形狀', JSON.stringify(pw.dims));
  const H = HID, G = Math.floor(S / P), NP = G * G;   // 384／14 向下取整 = 27
  // HF 排列 [out][c][py][px] → 骨架排列 (py,px,c)
  const patchW = new Float32Array(H * P * P * C);
  for (let h = 0; h < H; h++) for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) for (let c = 0; c < C; c++)
    patchW[h * P * P * C + (py * P + px) * C + c] = cw.data[((h * C + c) * P + py) * P + px];
  // 同一張合成影像：CHW 給 ORT，HWC 給骨架
  const chw = new Float32Array(C * S * S), hwc = new Float32Array(S * S * C);
  for (let c = 0; c < C; c++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = Math.sin(0.011 * x + 0.017 * y + 0.7 * c) * 0.9 + Math.cos(0.005 * x * y / S + c);
    chw[(c * S + y) * S + x] = v; hwc[(y * S + x) * C + c] = v;
  }
  const feeds = { pixel_values: new ORT.Tensor('float32', chw, [1, C, S, S]) };
  const ortConv = (await fetchOne(vfile, CONV_OUT, feeds));
  console.log('ORT conv 輸出形狀', JSON.stringify(ortConv.dims));
  const ortEmb = (await fetchOne(vfile, EMB_OUT, feeds));
  console.log('ORT 嵌入輸出形狀', JSON.stringify(ortEmb.dims));

  // 骨架的 patchify＋linear（與 vit_skeleton.encode 的第一步相同）
  // 384 不是 14 的倍數：骨架先裁成左上角 378×378（與 llava_skeleton.cropToPatch 相同），stride-14 卷積也只取到 27 格
  const SC = G * P, hwcCrop = new Float32Array(SC * SC * C);
  for (let y = 0; y < SC; y++) for (let x = 0; x < SC; x++) for (let c = 0; c < C; c++) hwcCrop[(y * SC + x) * C + c] = hwc[(y * S + x) * C + c];
  const patches = VIT.patchify(hwcCrop, SC, SC, C, P);      // [NP][588]，(py,px,c)
  const tok = patches.map((v) => VIT.linear(patchW, cb.data, H, v.length, v));   // [NP][H]
  // ORT conv 形狀 [1][H][G][G]：第 (c, gy, gx) 元素；比較 tok[gy*G+gx][c]
  const refConv = new Float32Array(NP * H), skConv = new Float32Array(NP * H);
  for (let p = 0; p < NP; p++) for (let c = 0; c < H; c++) { refConv[p * H + c] = ortConv.data[c * NP + p]; skConv[p * H + c] = tok[p][c]; }
  const rConv = cmp(skConv, refConv);
  console.log('patch 嵌入（骨架排列，不含位置）vs ORT conv：', JSON.stringify(rConv));
  // 反證：若不做排列轉換（直接用 [out][c][py][px] 當 (py,px,c)），結果應該錯
  const wrong = new Float32Array(H * P * P * C);
  for (let i = 0; i < wrong.length; i++) wrong[i] = cw.data[i];
  const tokWrong = patches.map((v) => VIT.linear(wrong, cb.data, H, v.length, v));
  const wrongRef = new Float32Array(NP * H); for (let p = 0; p < NP; p++) for (let c = 0; c < H; c++) wrongRef[p * H + c] = tokWrong[p][c];
  console.log('對照（沒有排列轉換）vs ORT conv：', JSON.stringify(cmp(wrongRef, refConv)));

  // 加上位置嵌入：ORT Add 輸出 [1][NP][H] = conv token + pos[p]
  const refEmb = ortEmb.data, skEmb = new Float32Array(NP * H);
  for (let p = 0; p < NP; p++) for (let c = 0; c < H; c++) skEmb[p * H + c] = tok[p][c] + pw.data[p * H + c];
  const rEmb = cmp(skEmb, refEmb);
  console.log('patch＋位置嵌入 vs ORT：', JSON.stringify(rEmb));

  const pass = rConv.relRms < 1e-5 && rEmb.relRms < 1e-5 && epsOk;
  console.log(pass ? '通過：patch 權重排列轉換、位置嵌入與 rms_norm_eps 與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
