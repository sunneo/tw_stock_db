// Florence-2（DaViT 視覺編碼器）patch 嵌入的真權重對拍（CPU，fp32）。
// 圖：Conv(7×7, stride 4, pad 3) → Transpose → Reshape（成 token） → LayerNorm（分解成 ReduceMean／Sub／Pow／Sqrt／Div／Mul／Add）。
// 做法：withExtraOutputs 把四個中間結果加成圖的輸出（只在記憶體中改寫），ORT 的值當參考；JS 參考用同一份 fp32 權重算。
// 用法：FLORENCE_DIR=<含 vision_encoder.onnx 的目錄> [ORT_NODE_DIR=<onnxruntime-node 目錄>] node scripts/eval/florence2_patch_embed_check.js
'use strict';
const path = require('path');
const dir = process.env.FLORENCE_DIR;
if (!dir) { console.log('請設定 FLORENCE_DIR'); process.exit(2); }
const ORT = require(process.env.ORT_NODE_DIR || 'onnxruntime-node');
const { withExtraOutputs } = require('./onnx_nodes.js');
const { initializers } = require('./smolvlm_onnx_initializers.js');

const file = path.join(dir, 'vision_encoder.onnx');
const CONV = '/convs.0/proj/Conv_output_0';
const TOK = '/convs.0/Reshape_output_0';
const LN = '/convs.0/norm/Add_1_output_0';
const EPS = '/convs.0/norm/Constant_1_output_0';
const POW = '/convs.0/norm/Constant_output_0';

function f32map(f) {
  const m = new Map();
  for (const t of initializers(f)) if (t.dataType === 1 && t.raw) { const ab = new ArrayBuffer(t.raw.length); new Uint8Array(ab).set(t.raw); m.set(t.name, { dims: t.dims, data: new Float32Array(ab) }); }
  return m;
}
function cmp(a, b) {
  let mx = 0, ss = 0, sr = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; ss += d * d; sr += b[i] * b[i]; }
  return { maxAbs: mx, relRms: Math.sqrt(ss / (sr || 1)) };
}

(async () => {
  const W = f32map(file);
  const get = (n) => { const x = W.get(n); if (!x) throw new Error('缺少權重 ' + n); return x; };
  const cw = get('vision_tower.convs.0.proj.weight'), cb = get('vision_tower.convs.0.proj.bias');
  const lg = get('vision_tower.convs.0.norm.weight'), lb = get('vision_tower.convs.0.norm.bias');
  const [O, I, KH, KW] = cw.dims;
  const S = 768, STR = 4, PAD = 3;
  const OH = Math.floor((S + 2 * PAD - KH) / STR) + 1, OW = Math.floor((S + 2 * PAD - KW) / STR) + 1;
  const C = O;
  console.log('權重：卷積', JSON.stringify(cw.dims), '，LayerNorm', JSON.stringify(lg.dims), '，輸出網格', OH, 'x', OW);

  // 同一張合成影像（NCHW，與 ORT 的 pixel_values 相同）
  const x = new Float32Array(I * S * S);
  for (let c = 0; c < I; c++) for (let y = 0; y < S; y++) for (let q = 0; q < S; q++)
    x[(c * S + y) * S + q] = Math.sin(0.011 * q + 0.017 * y + 0.7 * c) * 0.9 + Math.cos(0.005 * q * y / S + c);

  // ORT：圖的輸出加上中間結果
  // eps 與次方是純量常數（initializer），直接從權重表讀；它們在 ORT 的輸出裡不會出現
  const eps = get(EPS).data[0], powC = get(POW).data[0];
  // 注意：多個名稱一起要求時，ORT 回傳的鍵與值會錯位（實測：要求 conv 與 LN 時，兩者都掛在 image_features 下）。
  // 所以每個中間結果各開一個工作階段、只要求一個名稱；單獨要求時回傳的形狀與要求的名稱一致。
  async function fetchOne(name) {
    const sess = await ORT.InferenceSession.create(withExtraOutputs(file, [name]), { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
    const o = await sess.run({ pixel_values: new ORT.Tensor('float32', x, [1, I, S, S]) }, [name]);
    const v = o[name] || o[Object.keys(o)[0]];
    await sess.release();
    return v;
  }
  const vConv = await fetchOne(CONV), vTok = await fetchOne(TOK), vLn = await fetchOne(LN);
  const ortConv = vConv.data, ortTok = vTok.data, ortLn = vLn.data;
  console.log('ORT 形狀：conv', JSON.stringify(vConv.dims), 'token', JSON.stringify(vTok.dims), 'LN', JSON.stringify(vLn.dims), 'eps', eps, 'pow', powC);
  if (powC !== 2) throw new Error('LayerNorm 的次方不是 2，參考實作不適用：' + powC);

  // JS 參考：卷積（NCHW 輸出）
  const conv = new Float32Array(O * OH * OW);
  for (let o = 0; o < O; o++) for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
    let s = cb.data[o];
    for (let c = 0; c < I; c++) for (let ky = 0; ky < KH; ky++) {
      const iy = oy * STR - PAD + ky; if (iy < 0 || iy >= S) continue;
      for (let kx = 0; kx < KW; kx++) {
        const ix = ox * STR - PAD + kx; if (ix < 0 || ix >= S) continue;
        s += cw.data[((o * I + c) * KH + ky) * KW + kx] * x[(c * S + iy) * S + ix];
      }
    }
    conv[(o * OH + oy) * OW + ox] = s;
  }
  const rConv = cmp(conv, ortConv);
  console.log('卷積輸出 vs ORT：', JSON.stringify(rConv));

  // token 排列：ORT 的 TOK 形狀應為 [1, OH*OW, C]；比較 token p=(y*OW+x)、通道 c 是否等於 conv[c][y][x]
  const nTok = OH * OW;
  const tokRef = new Float32Array(nTok * C);
  for (let p = 0; p < nTok; p++) for (let c = 0; c < C; c++) tokRef[p * C + c] = conv[(c * OH + Math.floor(p / OW)) * OW + (p % OW)];
  const rTok = cmp(tokRef, ortTok);
  console.log('token 排列（NCHW 攤平成 [HW][C]）vs ORT：', JSON.stringify(rTok));

  // LayerNorm（沿通道維度）：y = (x-μ)/sqrt(var+eps)·g + b
  const lnRef = new Float32Array(nTok * C);
  for (let p = 0; p < nTok; p++) {
    let m = 0; for (let c = 0; c < C; c++) m += ortTok[p * C + c]; m /= C;
    let v = 0; for (let c = 0; c < C; c++) { const d = ortTok[p * C + c] - m; v += d * d; } v /= C;
    const inv = 1 / Math.sqrt(v + eps);
    for (let c = 0; c < C; c++) lnRef[p * C + c] = (ortTok[p * C + c] - m) * inv * lg.data[c] + lb.data[c];
  }
  const rLn = cmp(lnRef, ortLn);
  console.log('LayerNorm 輸出 vs ORT（以 ORT 的 token 為輸入）：', JSON.stringify(rLn));
  const pass = rConv.relRms < 1e-5 && rTok.relRms < 1e-5 && rLn.relRms < 1e-5;
  console.log(pass ? '通過：patch 嵌入（卷積＋排列＋LayerNorm）與 ORT 相符' : '不通過：見上面的數字');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.log('ERR', e.stack || e.message); process.exit(1); });
