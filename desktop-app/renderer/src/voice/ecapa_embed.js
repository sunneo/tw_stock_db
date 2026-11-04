/* ECAPA 聲紋嵌入（UMD，純邏輯；ort 與 session 由呼叫端注入，不自己載入模型）。
 * 測試：scripts/voice-tests/ecapa_embed.test.js。真模型探測：scripts/eval/ecapa_probe.eval.js（已確認）。
 *
 * 已確認（真 Electron，onnxruntime-web 1.22.0）：輸入名 "feats"、形狀 [1, T, 80]；輸出名 "emb"、形狀 [1, 1, 192]。
 * 未確認：前處理是否與來源模型訓練時一致（log-mel 參數、是否做每句平均正規化）。cmn 參數可開關，用真音檔量測決定。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaEcapaEmbed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIM = 192, NMELS = 80, MIN_FRAMES = 50;   // 約 0.5 秒以上才有意義

  // 每個 mel 維度減去整句的平均（沿時間方向）。
  function cmnInPlace(data, frames, nMels) {
    for (var m = 0; m < nMels; m++) {
      var s = 0;
      for (var t = 0; t < frames; t++) s += data[t * nMels + m];
      var mean = s / frames;
      for (var t2 = 0; t2 < frames; t2++) data[t2 * nMels + m] -= mean;
    }
    return data;
  }

  function l2(vec) {
    var s = 0;
    for (var i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    var n = Math.sqrt(s);
    if (!(n > 0)) throw new Error('嵌入向量是零向量');
    var out = new Float32Array(vec.length);
    for (var j = 0; j < vec.length; j++) out[j] = vec[j] / n;
    return out;
  }

  // opts：{ ort, session, fbank（FaFbank 模組）, cmn（預設 true）}
  function createEmbedder(opts) {
    opts = opts || {};
    if (!opts.ort || !opts.session || !opts.fbank) throw new Error('需要 ort、session、fbank');
    var ort = opts.ort, session = opts.session, fb = opts.fbank;
    var cmn = opts.cmn !== false;
    var inputName = (session.inputNames && session.inputNames[0]) || 'feats';
    var outputName = (session.outputNames && session.outputNames[0]) || 'emb';

    // samples：16kHz 單聲道 Float32Array。回傳 L2 正規化後的 192 維向量。
    async function embed(samples) {
      var f = fb.fbank(samples, 16000);
      if (f.frames < MIN_FRAMES) throw new Error('語音太短（需要至少約 0.5 秒）');
      var data = Float32Array.from(f.data);
      if (cmn) cmnInPlace(data, f.frames, NMELS);
      var x = new ort.Tensor('float32', data, [1, f.frames, NMELS]);
      var out = await session.run({ [inputName]: x });
      var emb = out[outputName].data;
      if (emb.length !== DIM) throw new Error('嵌入維度不符：' + emb.length);
      return l2(Float32Array.from(emb));
    }

    return { embed: embed, dim: DIM, cmn: cmn, inputName: inputName, outputName: outputName };
  }

  return { createEmbedder: createEmbedder, cmnInPlace: cmnInPlace, DIM: DIM, NMELS: NMELS, MIN_FRAMES: MIN_FRAMES };
});
