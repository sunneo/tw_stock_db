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
      // 第 6 個元素（選用）是轉置旗標 { transA, transB }，與 rt.matmul 相同
      const hs = items.map((it) => ({ h: b.matmul(b.upload(Float32Array.from(it[0])), b.upload(Float32Array.from(it[1])), it[2], it[3], it[4], it[5]), n: it[2] * it[4] }));
      const outs = await b.read(hs.map((x) => [x.h, x.n]));
      return { results: outs, info: { layer: 'T1', reason: null } };
    };
    // 訓練頭（O8）：logits＝nf·embᵀ → 交叉熵（loss 與 dl）→ dh＝dl·emb，全部在同一個命令編碼器，一次 submit、兩次回讀。
    // emb 是 V×d（與 lossAndGrads 相同的儲存方式）；tgt 是長度 T 的目標索引；回傳 loss（平均）與 dh（T×d，未過 rmsBwd）。
    rt.headStep = async (a) => {
      const { nf, emb, tgt, T, d, V } = a;
      const dev = await device();
      const b = opts.nn.createBatch(dev);
      const NF = b.upload(Float32Array.from(nf)), E = b.upload(Float32Array.from(emb));
      const TG = b.uploadU32(Uint32Array.from(tgt));
      const logits = b.matmul(NF, E, T, d, V, { transB: true });
      const ce = b.crossEntropy(logits, TG, T, V, 1 / T);
      const dh = b.matmul(ce.dl, E, T, V, d);
      const [rows, dhv] = await b.read([[ce.rows, T], [dh, T * d]]);
      let s = 0; for (let t = 0; t < T; t++) s += rows[t];
      return { loss: s / T, dh: Float64Array.from(dhv), info: { layer: 'T1', reason: null, op: 'head' } };
    };
    // 前向精度（O8 能力分支）：有 shader-f16 才可能選 f16；但 f16 矩陣乘尚未接進 mm_ops，所以目前即使有 shader-f16 也如實回報 f32。
    rt.precision = async () => {
      const dev = await device();
      const pickFn = opts.pickForwardPrecision || (typeof require === 'function' ? require('./train_fused.js').pickForwardPrecision : null);
      const pick = pickFn ? pickFn(dev.features) : { precision: 'f32', reason: '無精度選擇函式' };
      if (pick.precision === 'f16' && !opts.mmF16) return { precision: 'f32', accum: 'f32', reason: pick.reason + '；f16 矩陣乘尚未接進 mm_ops，維持 f32' };
      return pick;
    };
    return rt;
  }

  return { createRuntime: createRuntime };
}));
