'use strict';
// llm_full 的 cudaweb 迴圈測試（假的 GPU 函式，不碰 WebGPU）：步號與資料位置、存檔格式、續訓接續、sha256 竄改拒絕。
// 真的 WebGPU 數值對拍與真跑由 Electron 負責（見 PLAN）。用法：node renderer/src/studio/llm_full_run.test.js
const CK = require('./checkpoint_core.js');
const R = require('./llm_full_run.js');
let ok = 0, bad = 0;
const check = (n, c, d) => { if (c) { ok++; console.log('ok   ' + n); } else { bad++; console.log('FAIL ' + n + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 300))); } };

const cfg = { V: 258, d: 4, L: 1, H: 2, kvH: 1, F: 4, T: 3, qkNorm: true };
const names = ['emb', 'nf', 'L0.n1'];
// 假的 GPU 狀態：名稱 → Float32Array；每步把參數加 0.5，損失 = 10 - 步數
function fakeGpu() {
  const dev = {};
  const mk = (init) => { const S = { P: {}, M: {}, V: {}, t: 0 }; names.forEach((n) => { S.P[n] = Float32Array.from(init ? init[n] : [1, 2, 3, 4]); S.M[n] = new Float32Array(S.P[n].length); S.V[n] = new Float32Array(S.P[n].length); }); return S; };
  const fullParamStep = async ({ state }) => { state.t++; names.forEach((n) => { for (let i = 0; i < state.P[n].length; i++) state.P[n][i] += 0.5; }); return { loss: 10 - state.t, gradNorm: 1, ms: 2.5 }; };
  return {
    dev, fullParamStep,
    makeResidentState: (device, c, init) => mk(init && (init.P || null)),
    readResident: async (device, S) => ({ P: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(S.P).map(([k, v]) => [k, Array.from(v)])))), M: Object.fromEntries(Object.entries(S.M).map(([k, v]) => [k, Float32Array.from(v)])), V: Object.fromEntries(Object.entries(S.V).map(([k, v]) => [k, Float32Array.from(v)])) }),
    loadResident: (device, S, snap) => { names.forEach((n) => { S.P[n] = Float32Array.from(snap.P[n]); S.M[n] = Float32Array.from(snap.M[n]); S.V[n] = Float32Array.from(snap.V[n]); }); S.t = snap.t; },
  };
}
const job = { cfg, lr: 0.001, wd: 0.01, clip: 1, steps: 3 };
const rows = [[1, 2, 3, 4], [5, 6, 7, 8]];
const fakeInit = { P: { emb: [1, 2, 3, 4], nf: [1, 2, 3, 4], 'L0.n1': [1, 2, 3, 4] } };

(async () => {
  const G = fakeGpu();
  const seen = [];
  const r1 = await R.runCudaweb({ job, rows, nn: {}, device: G.dev, cfg, init: fakeInit, fullParamStep: G.fullParamStep, makeResidentState: G.makeResidentState, readResident: G.readResident, loadResident: G.loadResident, onStep: (x) => seen.push(x), saveCheckpoint: true, sha256: CK.sha256, encodeTensors: CK.encodeTensors, decodeTensors: CK.decodeTensors });
  check('3 步：步號 1–3、每步有損失與毫秒', r1.records.length === 3 && r1.records.map((x) => x.step).join() === '1,2,3' && r1.records.every((x) => typeof x.loss === 'number' && x.ms === 2.5), r1.records);
  check('onStep 逐步回呼與回傳一致', seen.length === 3 && seen[2].loss === r1.records[2].loss);
  check('資料位置循環：第 1–3 步用列 0、1、0', R.batchIndex(0, 1, 2) === 0 && R.batchIndex(0, 2, 2) === 1 && R.batchIndex(0, 3, 2) === 0 && R.batchIndex(3, 1, 2) === 1);
  check('存檔：fa-ckpt v1、步數 3、資料位置 3、三個 fa-f32 檔', r1.checkpoint && r1.checkpoint.ckpt.format === 'fa-ckpt' && r1.checkpoint.ckpt.version === 1 && r1.checkpoint.ckpt.step === 3 && r1.checkpoint.ckpt.next_batch === 3 && Object.keys(r1.checkpoint.ckpt.sha256).length === 3, r1.checkpoint && r1.checkpoint.ckpt);
  const v = CK.verifyChecksums({ ckpt: r1.checkpoint.ckpt, files: r1.checkpoint.files });
  check('存檔的 sha256 與 checkpoint_core 驗證一致', v.ok, v.bad);
  // 續訓：從第 3 步存的檢查點接續 2 步，步號應為 4、5，資料位置從 3 接續
  const G2 = fakeGpu();
  const job2 = Object.assign({}, job, { steps: 2 });
  const r2 = await R.runCudaweb({ job: job2, rows, nn: {}, device: G2.dev, cfg, init: null, fullParamStep: G2.fullParamStep, makeResidentState: G2.makeResidentState, readResident: G2.readResident, loadResident: G2.loadResident, resumeCkpt: r1.checkpoint, sha256: CK.sha256, encodeTensors: CK.encodeTensors, decodeTensors: CK.decodeTensors, saveCheckpoint: false });
  check('續訓：步號接續為 4、5', r2.records.map((x) => x.step).join() === '4,5', r2.records);
  check('續訓：資料位置從 3 接續（第 4 步用列 1）', R.batchIndex(3, 1, 2) === 1 && r2.nextBatch === 5);
  // 竄改：sha256 不符的檢查點被拒絕
  const tampered = { ckpt: r1.checkpoint.ckpt, files: Object.assign({}, r1.checkpoint.files) };
  tampered.files['opt_m.f32'] = Buffer.from(tampered.files['opt_m.f32'].length ? Buffer.concat([Buffer.from([0]), Buffer.from(tampered.files['opt_m.f32'])]) : []);
  const vv = R.validate(tampered, CK.sha256);
  check('竄改的檢查點被拒絕（sha256 不符）', !vv.ok && vv.errors.some((e) => /sha256 不符/.test(e)), vv);
  const bad2 = R.validate({ ckpt: Object.assign({}, r1.checkpoint.ckpt, { format: 'x' }), files: r1.checkpoint.files }, CK.sha256);
  check('格式不符被拒絕', !bad2.ok && bad2.errors.some((e) => /format/.test(e)));
  let threw = false; try { await R.runCudaweb({ job, rows: [], nn: {}, device: {}, cfg, init: fakeInit, fullParamStep: G.fullParamStep, makeResidentState: G.makeResidentState, readResident: G.readResident, loadResident: G.loadResident }); } catch (e) { threw = /沒有資料列/.test(e.message); }
  check('沒有資料列時拒絕開始', threw);
  console.log(bad ? bad + ' 項失敗，' + ok + ' 項通過' : '全部通過（' + ok + ' 項）');
  process.exit(bad ? 1 : 0);
})();
