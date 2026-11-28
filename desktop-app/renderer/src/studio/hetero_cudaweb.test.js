'use strict';
// cudaweb 梯度配接器的 glue 測試（假的 fullParamStepDevice／loadResident；沒有 WebGPU）。用法：node renderer/src/studio/hetero_cudaweb.test.js
// 這裡只驗「呼叫形狀、參數寫入、梯度轉換、applyUpdate:false、錯誤回報」；真 GPU 的數值對拍尚未做。
const { createCudawebResource } = require('./hetero_cudaweb.js');
const R = require('./hetero_resources.js');
const S = require('./hetero_step.js');

let ok = 0, bad = 0;
const check = (name, c, d) => { if (c) { ok++; console.log('ok   ' + name); } else { bad++; console.log('FAIL ' + name + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 300))); } };

const state = { P: { emb: { n: 4 }, 'L0.Wq': { n: 3 } }, M: {}, V: {}, t: 0 };
const loads = [];
const calls = [];
const fakeLoad = (device, S0, snap) => {
  const P = {}; for (const k of Object.keys(snap.P)) P[k] = Array.from(snap.P[k]);
  loads.push({ P, M: Object.keys(snap.M) }); return S0;
};
const fakeFps = async (o) => {
  calls.push({ applyUpdate: o.applyUpdate, lr: o.lr, n: o.seqs.length });
  const grads = {};
  for (const k of Object.keys(o.state.P)) grads[k] = Float32Array.from(Array.from({ length: o.state.P[k].n }, (_, i) => (i + 1) * 0.5 * o.seqs.length));
  return { loss: 2.5, grads, applied: false, ms: 3 };
};

(async () => {
  const res = createCudawebResource({ id: 'gpu0', rate: 4, nn: {}, device: {}, state, clip: 1, fullParamStepDevice: fakeFps, loadResident: fakeLoad });
  check('資源描述：kind cudaweb、速率', res.kind === 'cudaweb' && res.rate === 4);
  const params = { emb: Float64Array.from([1, 2, 3, 4]), 'L0.Wq': Float64Array.from([0.5, -0.5, 0.25]) };
  const r = await res.impl.gradient({ params, seqs: [[1, 2, 3], [4, 5, 6]] });
  check('呼叫 loadResident 一次，參數寫成 Float32 且等於協調端參數', loads.length === 1 && loads[0].P.emb.join() === '1,2,3,4' && loads[0].P['L0.Wq'].join() === '0.5,-0.5,0.25', loads);
  check('M、V 為零（更新不在裝置上做）', loads[0].M.join() === 'emb,L0.Wq');
  check('fullParamStepDevice 以 applyUpdate:false、lr:0 呼叫', calls.length === 1 && calls[0].applyUpdate === false && calls[0].lr === 0 && calls[0].n === 2, calls);
  check('回傳序列數、損失、Float64 梯度', r.n === 2 && r.loss === 2.5 && r.grads.emb instanceof Float64Array && r.grads.emb[0] === 1 && r.grads['L0.Wq'][2] === 3, r);
  let missing = false;
  const bad1 = createCudawebResource({ id: 'x', state, fullParamStepDevice: async () => ({ loss: 0 }), loadResident: fakeLoad });
  try { await bad1.impl.gradient({ params, seqs: [[1, 2]] }); } catch (e) { missing = /applyUpdate/.test(e.message); }
  check('沒有梯度回傳 → 丟錯（不默默當成 0）', missing);
  let shape = false;
  try { await res.impl.gradient({ params: { emb: Float64Array.from([1, 2]), 'L0.Wq': params['L0.Wq'] }, seqs: [[1, 2]] }); } catch (e) { shape = /長度不符/.test(e.message); }
  check('參數長度不符 → 丟錯', shape);

  // 與協調端串接：cudaweb（假）＋ 另一個假資源，協調一步後參數已更新、份額存在
  const set = R.createResourceSet();
  set.add(res);
  const other = { id: 'cpu', kind: 'cpu-py', rate: 4, impl: { gradient: async ({ seqs }) => ({ loss: 1, n: seqs.length, grads: { emb: new Float64Array(4), 'L0.Wq': new Float64Array(3) }, ms: 2 }) } };
  set.add(other);
  const coord = S.createCoordinator({ resources: set, params, lr: 0.01, wd: 0, clip: 1, eps: 1e-8 });
  const out = await coord.step([[1, 2], [3, 4], [5, 6], [7, 8]]);
  check('協調一步：兩資源各分到 2 個序列、回報份額與參數更新', out.n === 4 && out.timing.length === 2 && Object.keys(out.shares).length === 2 && coord.getParams().emb[0] !== 1, out);

  console.log('\n' + ok + ' passed, ' + bad + ' failed');
  if (bad) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
