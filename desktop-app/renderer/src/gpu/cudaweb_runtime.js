/* cudaweb_runtime.js — 訓練器用的 cudaweb 執行期（O8）：提供 matmul（逐個）與 matmulMany（一次提交多個互不相依的矩陣乘）。
 * 給 studio/lora_ref_train.js 的 cudawebMatmulBackend(rt) 使用：rt.matmul(A,B,m,k,n) → { result, info }；rt.matmulMany(items) → { results, info }。
 * 依賴注入：o.nn（nn_ops，提供 getDevice、createBatch）、o.mm（mm_ops，提供 matmul）、o.navigator；o.device 可直接給 GPU 裝置（沒給就用 nn.getDevice）。
 * 沒有 GPU 時 nn.getDevice 會丟錯，呼叫端應退回 CPU 後端（與既有的 cudaweb 退路相同）。
 * UMD：node 用 module.exports；瀏覽器掛在 self.FaCudawebRuntime。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaCudawebRuntime = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createRuntime(o) {
    const opts = o || {};
    let devP = null;
    const device = () => {
      if (opts.device) return Promise.resolve(opts.device);
      if (!devP) devP = opts.nn.getDevice(opts.navigator).then((r) => r.dev).catch((e) => { devP = null; throw e; });
      return devP;
    };
    const rt = { id: 'cudaweb-runtime' };
    // 逐個矩陣乘（經 mm_ops，會走選擇器與退路）
    // fl（選用）：{ transA, transB }。A 以 k×m 儲存（transA）、B 以 n×k 儲存（transB）；m、k、n 仍是邏輯維度。
    // 沒給就是原本的行為（不轉置）。
    rt.matmul = async (A, B, m, k, n, fl) => {
      const mo = { navigator: opts.navigator, transA: !!(fl && fl.transA), transB: !!(fl && fl.transB) };
      const r = await opts.mm.matmul(Float32Array.from(A), [m, k], Float32Array.from(B), [k, n], mo);
      return { result: r.y, info: { layer: mo.lastInfo && mo.lastInfo.layer ? mo.lastInfo.layer : 'T1', reason: null } };
    };
    // 批次：所有矩陣乘放進同一個命令編碼器，一次 submit，讀回只在最後
    rt.matmulMany = async (items) => {
      const dev = await device();
      const b = opts.nn.createBatch(dev);
      const hs = items.map((it) => ({ h: b.matmul(b.upload(Float32Array.from(it[0])), b.upload(Float32Array.from(it[1])), it[2], it[3], it[4]), n: it[2] * it[4] }));
      const outs = await b.read(hs.map((x) => [x.h, x.n]));
      return { results: outs, info: { layer: 'T1', reason: null } };
    };
    return rt;
  }

  return { createRuntime: createRuntime };
}));
