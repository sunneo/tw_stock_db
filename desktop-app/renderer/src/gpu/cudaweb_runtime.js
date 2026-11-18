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
      return pickFn ? pickFn(dev.features) : { precision: 'f32', accum: 'f32', reason: '無精度選擇函式' };
    };
    // 前向用 f16 的條件：呼叫端要求（opts.f16Forward）且裝置真的有 shader-f16；否則一律 f32。
    const f16On = async () => opts.f16Forward === true && (await rt.precision()).precision === 'f16';
    const a32 = (x) => (x instanceof Float32Array ? x : Float32Array.from(x));

    // LoRA 投影群組（前向）：每個投影的 X·A、X·W、(X·A)·B、y＝base＋s·br 全部在同一次提交；回傳 y 與 xA。
    // specs：[{ x, W, A, B, s, T, din, dout }]；W 是 din×dout，A 是 din×r，B 是 r×dout。
    // f16 模式（opts.f16Forward 且有 shader-f16）：只有 X·W（基底）用 f16 矩陣乘；X·A 與 (X·A)·B 仍 f32（XA 是中間值，不轉 f16）。
    rt.loraFwdMany = async (specs) => {
      const dev = await device(); const b = opts.nn.createBatch(dev); const f16 = await f16On();
      const hs = specs.map((sp) => {
        const r = sp.A.length / sp.din;
        const X = b.upload(a32(sp.x));
        const XA = b.matmul(X, b.upload(a32(sp.A)), sp.T, sp.din, r);
        const base = f16 ? b.matmul(b.uploadF16(a32(sp.x)), b.uploadF16(a32(sp.W)), sp.T, sp.din, sp.dout, { f16: true })
          : b.matmul(X, b.upload(a32(sp.W)), sp.T, sp.din, sp.dout);
        const br = b.matmul(XA, b.upload(a32(sp.B)), sp.T, r, sp.dout);
        const y = b.axpy(base, br, sp.s);
        return { y: y, xA: XA, T: sp.T, dout: sp.dout, r: r };
      });
      const flat = []; hs.forEach((h) => { flat.push([h.y, h.T * h.dout], [h.xA, h.T * h.r]); });
      const outs = await b.read(flat);
      return { results: hs.map((h, i) => ({ y: outs[2 * i], xA: outs[2 * i + 1] })), f16: f16 };
    };

    // LoRA 投影群組（反向）：一次提交。與 lossAndGradsAsync 的 loraLinBwd 公式逐項相同（s 用 scal，dx 用 axpy 相加）。
    // specs：[{ dy, x, W, A, B, xA, s, T, din, dout }]；回傳 dA（din×r）、dB（r×dout）、dx（T×din）。
    rt.loraBwdMany = async (specs) => {
      const dev = await device(); const b = opts.nn.createBatch(dev);
      const hs = specs.map((sp) => {
        const r = sp.A.length / sp.din;
        const DY = b.upload(a32(sp.dy)), X = b.upload(a32(sp.x)), XA = b.upload(a32(sp.xA));
        const W = b.upload(a32(sp.W)), A = b.upload(a32(sp.A)), B = b.upload(a32(sp.B));
        const dB = b.scal(b.matmul(XA, DY, r, sp.T, sp.dout, { transA: true }), sp.s);          // s·XAᵀ·dy
        const dxA = b.scal(b.matmul(DY, B, sp.T, sp.dout, r, { transB: true }), sp.s);          // s·dy·Bᵀ
        const dA = b.matmul(X, dxA, sp.din, sp.T, r, { transA: true });                          // Xᵀ·dxA
        const dx = b.matmul(DY, W, sp.T, sp.dout, sp.din, { transB: true });                     // dy·Wᵀ
        const dx2 = b.matmul(dxA, A, sp.T, r, sp.din, { transB: true });                         // dxA·Aᵀ
        const dxs = b.axpy(dx, dx2, 1);
        return { dA: dA, dB: dB, dx: dxs, din: sp.din, r: r, dout: sp.dout, T: sp.T };
      });
      const flat = []; hs.forEach((h) => { flat.push([h.dA, h.din * h.r], [h.dB, h.r * h.dout], [h.dx, h.T * h.din]); });
      const outs = await b.read(flat);
      return { results: hs.map((h, i) => ({ dA: outs[3 * i], dB: outs[3 * i + 1], dx: outs[3 * i + 2] })) };
    };

    // 前饋區塊（前向）：g＝x·Wg、u＝x·Wu、a＝silu(g)·u、dn＝a·Wd，一次提交；回傳 g、u、a、dn。
    // f16 模式：g、u 用 f16 矩陣乘（X 與權重直接上傳成 f16）；a 與 dn 仍 f32。
    rt.mlpFwd = async (a) => {
      const { x, Wg, Wu, Wd, T, d, F } = a;
      const dev = await device(); const b = opts.nn.createBatch(dev); const f16 = await f16On();
      const G = f16 ? b.matmul(b.uploadF16(a32(x)), b.uploadF16(a32(Wg)), T, d, F, { f16: true })
        : b.matmul(b.upload(a32(x)), b.upload(a32(Wg)), T, d, F);
      const U = f16 ? b.matmul(b.uploadF16(a32(x)), b.uploadF16(a32(Wu)), T, d, F, { f16: true })
        : b.matmul(b.upload(a32(x)), b.upload(a32(Wu)), T, d, F);
      const SG = b.silu(G);
      const A = b.mul(SG, U);
      const DN = b.matmul(A, b.upload(a32(Wd)), T, F, d);
      const [g, u, av, dn] = await b.read([[G, T * F], [U, T * F], [A, T * F], [DN, T * d]]);
      return { g: g, u: u, a: av, dn: dn, f16: f16 };
    };
    return rt;
  }

  return { createRuntime: createRuntime };
}));
