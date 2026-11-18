/* o1m_uniform.js — O1m (c)：rope 表與偏置放進 uniform（而不是 storage）的打包與檢查。
 * WebGPU 的 uniform 緩衝區上限預設 64 KiB（maxUniformBufferBindingSize），而且陣列元素要 16 位元組對齊（vec4）。
 * packVec4：偏置向量 → vec4 陣列（長度補到 4 的倍數）；超過上限丟錯。
 * ropeTable：cos 與 sin 表（每列 hd/2 組）；超過上限丟錯。
 * 只做資料與檢查，不碰 GPU。UMD：node 用 module.exports；瀏覽器掛在 self.FaO1mUniform。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaO1mUniform = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const UNIFORM_MAX = 65536;

  function packVec4(v) {
    const n = Math.ceil(v.length / 4) * 4;
    if (n * 4 > UNIFORM_MAX) throw new Error('o1m_uniform：' + (n * 4) + ' 位元組超過 uniform 上限（' + UNIFORM_MAX + '）');
    const out = new Float32Array(n);
    out.set(v);
    return out;
  }

  function ropeTable(T, hd, base) {
    const half = hd / 2, bytes = T * half * 4;
    if (bytes > UNIFORM_MAX) throw new Error('o1m_uniform：rope 表 ' + bytes + ' 位元組超過 uniform 上限（' + UNIFORM_MAX + '）');
    const cos = new Float32Array(T * half), sin = new Float32Array(T * half);
    for (let t = 0; t < T; t++) for (let i = 0; i < half; i++) {
      const th = t * Math.pow(base, -2 * i / hd);
      cos[t * half + i] = Math.cos(th);
      sin[t * half + i] = Math.sin(th);
    }
    return { cos: cos, sin: sin, T: T, hd: hd, bytes: bytes };
  }

  return { packVec4, ropeTable, UNIFORM_MAX };
}));
