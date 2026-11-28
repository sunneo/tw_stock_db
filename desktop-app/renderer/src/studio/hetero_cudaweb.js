'use strict';
// cudaweb 梯度資源（配接器）：把 fullParamStepDevice({applyUpdate:false}) 包成協調端的資源（hetero_resources）。
// 每次 gradient：先用 loadResident 把協調端的參數寫進裝置（覆寫裝置上的權重；M、V 用零，因為更新不在裝置上做），
// 再以 applyUpdate:false 只算平均梯度（不更新、不前進步數），把梯度轉成 Float64Array 回傳。
// 依賴以參數注入（fullParamStepDevice、loadResident 由呼叫端從 gpu/ 目錄傳入），本檔本身不 require GPU 程式。
//
//   createCudawebResource({ id, rate?, nn, device, state, clip?, fullParamStepDevice, loadResident })
//     state：makeResidentState(device, cfg, init) 的結果（state.P[名稱].n 是長度）
//   → { id, kind:'cudaweb', rate, impl:{ gradient({params, seqs}) } }
//
// 注意：這個配接器在 Node 測試裡只用假的 fullParamStepDevice／loadResident 驗證「呼叫形狀與數值轉換」；
// 真的 WebGPU 上的梯度對拍與速度量測尚未做（需要真 Electron 評估，見 DESIGN 補充節）。
function createCudawebResource(opts) {
  const o = Object.assign({ clip: 1.0 }, opts || {});
  if (typeof o.fullParamStepDevice !== 'function') throw new Error('需要 fullParamStepDevice');
  if (typeof o.loadResident !== 'function') throw new Error('需要 loadResident');
  if (!o.state || !o.state.P) throw new Error('需要 state（makeResidentState 的結果）');
  const names = Object.keys(o.state.P);
  const impl = {
    async gradient({ params, seqs }) {
      const t0 = Date.now();
      const snap = { P: {}, M: {}, V: {}, t: 0 };
      for (const k of names) {
        const len = o.state.P[k].n;
        const v = params[k];
        if (!v || v.length !== len) throw new Error('參數 ' + k + ' 長度不符');
        snap.P[k] = Float32Array.from(v);
        snap.M[k] = new Float32Array(len);
        snap.V[k] = new Float32Array(len);
      }
      o.loadResident(o.device, o.state, snap);
      const r = await o.fullParamStepDevice({ nn: o.nn, device: o.device, state: o.state, seqs, lr: 0, wd: 0, clip: o.clip, applyUpdate: false });
      if (!r || !r.grads) throw new Error('fullParamStepDevice 沒有回傳梯度（applyUpdate:false 未生效）');
      const grads = {};
      for (const k of names) grads[k] = Float64Array.from(r.grads[k]);
      return { loss: r.loss, n: seqs.length, grads, ms: Date.now() - t0 };
    },
  };
  return { id: o.id, kind: 'cudaweb', rate: typeof o.rate === 'number' && o.rate > 0 ? o.rate : null, impl };
}

module.exports = { createCudawebResource };
