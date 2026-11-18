/* o1m_tex.js — O1m (b)：B 放 rgba32float 貼圖的打包、還原與維度檢查（純資料，不碰 GPU）。
 * 貼圖：寬 N/4、高 K，每個 texel 四個 f32；texel (x, y) 的分量 c 是 B[y][4x + c]（列主序的 K×N 矩陣）。
 * 讀取：WGSL 的 textureLoad(tex, vec2<i32>(n/4, k), 0)[n % 4]（不需要取樣器；rgba32float 不可濾波，所以綁定要用 unfilterable-float）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaO1mTex。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaO1mTex = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TEX_MAX = 8192;   // WebGPU 預設 maxTextureDimension2D

  function checkDims(K, N) {
    const w = N / 4;
    if (w > TEX_MAX) throw new Error('o1m_tex：貼圖寬 ' + w + ' 超過 ' + TEX_MAX + '（N=' + N + '）');
    if (K > TEX_MAX) throw new Error('o1m_tex：貼圖高 ' + K + ' 超過 ' + TEX_MAX);
  }

  function packRgba(B, K, N) {
    if (N % 4 !== 0) throw new Error('o1m_tex：N 必須是 4 的倍數（N=' + N + '）');
    checkDims(K, N);
    const w = N / 4, data = new Float32Array(w * K * 4);
    for (let k = 0; k < K; k++) for (let n = 0; n < N; n++) {
      data[((k * w) + Math.floor(n / 4)) * 4 + (n % 4)] = B[k * N + n];
    }
    return { data: data, width: w, height: K };
  }

  function unpackRgba(p) {
    const N = p.width * 4, K = p.height, B = new Float32Array(K * N);
    for (let k = 0; k < K; k++) for (let n = 0; n < N; n++) {
      B[k * N + n] = p.data[((k * p.width) + Math.floor(n / 4)) * 4 + (n % 4)];
    }
    return B;
  }

  return { packRgba, unpackRgba, checkDims, TEX_MAX };
}));
