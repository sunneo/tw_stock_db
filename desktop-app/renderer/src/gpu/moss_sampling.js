'use strict';
// MOSS-TTS-Nano 整幀取樣（moss_tts_local_fixed_sampled_frame.onnx）的 CPU 參考版，逐節點對照圖後確認。
// 整幀 = 文字續停判斷 + 16 條音訊碼本依序取樣，每條碼本都先跑一次本地解碼器（moss_local.js 的 localDecode）。
//
// 輸入：
//   globalHidden：768 維（全域解碼器輸出）
//   seenMask：Int32Array 長度 16×1024（repetition_seen_mask，[c][v]，非零表示該碼本已出現過 v）
//   uAssistant：單一浮點數 0..1（assistant_random_u，決定續停）
//   uAudio：16 個浮點數 0..1（audio_random_u，第 c 條碼本用 uAudio[c]）
// 輸出：{ shouldContinue: 0|1, frameTokenIds: Int32Array(16) }
//
// 圖中的常數（已從圖讀出，不是猜的）：
//   重複懲罰 1.2：已出現過的詞元，logit<0 時乘、否則除。
//   溫度 0.8：懲罰後的 logit 再除以溫度。
//   Top-K 25（對溫度後的 logit 取前 25）。
//   Top-P 0.95：softmax 後累積機率，排除「前面累積 ≥ 0.95」的候選（第一名必留）。
//   取樣：逆 CDF。過濾後 softmax 的累積和 cum2；計數 n = #{k : cum2[k] < clip(u, 0, 0.9999999404)}；
//         索引 = clip(n, 0, K−1)；輸出 TopK 索引表中該位置的詞元。
//   續停：文字頭兩個 logit（詞元 0、1）的 softmax 第 0 項 p0；shouldContinue = (clip(u) ≤ p0)；
//         下一幀的文字詞元 = shouldContinue ? 9 : 7（本地解碼器的位置 1）。
const ML = require('./moss_local.js');

const NAUDIO = 16, V = 1024, PAD = 1024;
const REP_PENALTY = 1.2, TEMP = 0.8, TOP_K = 25, TOP_P = 0.95;
const U_MAX = 0.9999999403953552;
const TEXT_CONT = 9, TEXT_STOP = 7;

function softmaxF64(arr) {
  let mx = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
  const out = new Float64Array(arr.length);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i] === -Infinity ? 0 : Math.exp(arr[i] - mx);
    out[i] = e; s += e;
  }
  for (let i = 0; i < arr.length; i++) out[i] /= s;
  return out;
}

function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// 一條碼本的取樣：logits（長 V）、seen（長 V，0/1）、u（0..1）→ 詞元 id
function sampleChannel(logits, seen, u) {
  const x = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    let l = logits[v];
    if (seen[v]) l = l < 0 ? l * REP_PENALTY : l / REP_PENALTY;
    x[v] = l / TEMP;
  }
  // TopK：依值由大到小，同值取索引小者在前（若與 ORT 的排序有差異，以 ORT 對拍為準）
  const order = Array.from({ length: V }, (_, i) => i);
  order.sort((a, b) => (x[b] - x[a]) || (a - b));
  const K = Math.min(TOP_K, V);
  const idx = order.slice(0, K);
  const tv = Float64Array.from(idx.map((i) => x[i]));
  // Top-P：前面所有機率之和（cumsum − 自身）≥ top_p 的候選移除
  const p = softmaxF64(tv);
  let cum = 0;
  const tv2 = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const excl = cum;
    cum += p[k];
    tv2[k] = excl >= TOP_P ? -Infinity : tv[k];
  }
  const p2 = softmaxF64(tv2);
  const u0 = clip(u, 0, U_MAX);
  let c2 = 0, n = 0;
  for (let k = 0; k < K; k++) {
    c2 += p2[k];
    if (c2 < u0) n++;
  }
  const j = clip(n, 0, K - 1);
  return idx[j];
}

// 一整幀。model 來自 ML.loadMossLocal。
async function sampleFrame(model, globalHidden, seenMask, uAssistant, uAudio, ops) {
  // 1) 文字頭：位置 0 的隱藏狀態只看得到自己（因果遮罩），故其餘位置用 pad 即可
  const pads = new Array(NAUDIO - 1).fill(PAD);
  const probe = await ML.localDecode(model, globalHidden, TEXT_STOP, pads, ops);
  const p0 = softmaxF64(Float64Array.from([probe.textLogits[0], probe.textLogits[1]]))[0];
  const shouldContinue = clip(uAssistant, 0, U_MAX) <= p0 ? 1 : 0;
  const textTok = shouldContinue ? TEXT_CONT : TEXT_STOP;
  // 2) 16 條音訊碼本依序：第 c 條用位置 c+1 的隱藏狀態，前綴為已取樣的前 c 條
  const prefix = new Array(NAUDIO - 1).fill(PAD);
  const frame = new Int32Array(NAUDIO);
  for (let c = 0; c < NAUDIO; c++) {
    const out = await ML.localDecode(model, globalHidden, textTok, prefix, ops);
    const seen = seenMask.subarray(c * V, (c + 1) * V);
    const tok = sampleChannel(out.audioLogits[c], seen, uAudio[c]);
    frame[c] = tok;
    if (c < NAUDIO - 1) prefix[c] = tok;
  }
  return { shouldContinue, frameTokenIds: frame };
}

module.exports = { sampleFrame, sampleChannel, softmaxF64, REP_PENALTY, TEMP, TOP_K, TOP_P, TEXT_CONT, TEXT_STOP };
