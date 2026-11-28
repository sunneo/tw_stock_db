'use strict';
// cudaweb 後端接線測試（只驗接線，不是 GPU 結果）：用假執行期（同介面、內部走 CPU 矩陣乘）跑同一份 fixture，
// 確認（a）所有矩陣乘都經過 rt.matmul（呼叫次數＝每步的矩陣乘數）、（b）結果與直接用 CPU 後端逐位元相同。
// 真正的 GPU 對拍要在 Electron 渲染行程裡跑（見 PLAN P1 S1、S2、S6）。
const fs = require('fs');
const path = require('path');
const T = require('./full_param_train.js');
let fail = 0;
const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'full_param_parity_f64.json'), 'utf8'));
const cpu = T.cpuBackend();
let rtCalls = 0;
const fakeRt = { matmul: async (A, B, m, k, n) => { rtCalls++; return { result: await cpu.matmul(Float64Array.from(A), Float64Array.from(B), m, k, n), info: { layer: 'fake-cpu', reason: '假執行期' } }; } };
(async () => {
  const mA = T.fromInit(fx.cfg, fx.init), mB = T.fromInit(fx.cfg, fx.init);
  const stA = T.adamInit(mA), stB = T.adamInit(mB);
  const be = T.cudawebBackend(fakeRt);
  const a = await T.trainStep(mA, fx.batches[0], stA, { lr: fx.lr, wd: fx.wd, clip: fx.clip, backend: be });
  const b = await T.trainStep(mB, fx.batches[0], stB, { lr: fx.lr, wd: fx.wd, clip: fx.clip, backend: cpu });
  ok(a.loss === b.loss, '經 cudaweb 接線的一步損失與 CPU 後端逐位元相同', 'loss=' + a.loss.toFixed(12));
  // 每層：前向 q,k,v,o,g,u,d＝7 次；反向 Wd,da,Wg,Wu,dn2a,dn2b,Wo,dao,Wq,Wk,Wv,dxq,dxk,dxv＝14 次；頭：前向 1 次、反向 2 次（dEmbHead、dnf）
  const L = fx.cfg.L; const expect = L * (7 + 14) + 1 + 2;
  ok(rtCalls === expect, '每步矩陣乘全數經過 rt.matmul', 'calls=' + rtCalls + ' 預期=' + expect);
  ok(be.layer === 'fake-cpu' && be.calls === expect, 'probe 層與呼叫數記錄正確', 'layer=' + be.layer + ' calls=' + be.calls);
  console.log(fail === 0 ? '全部通過（接線測試，非 GPU 結果）' : fail + ' 項失敗');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL 例外：' + (e && e.stack || e)); process.exit(1); });
