'use strict';
// 全參數訓練對 PyTorch 參考（autograd）的逐步對拍（P1 S1、S2）。
// fixture 由 full_param_ref_torch.py --dtype float64 產生（真值＝PyTorch fp64）。
// 比對：每步 loss、每步梯度範數、步 1 的全部梯度（逐參數）、全部步結束後的權重。
const fs = require('fs');
const path = require('path');
const T = require('./full_param_train.js');

let fail = 0;
const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };

const fixPath = path.join(__dirname, 'fixtures', 'full_param_parity_f64.json');
if (!fs.existsSync(fixPath)) { ok(false, '找不到 fixture ' + fixPath + '（先跑 full_param_ref_torch.py --out ... --dtype float64）'); process.exit(1); }
const fx = JSON.parse(fs.readFileSync(fixPath, 'utf8'));

// 逐個數值比較：回傳最大絕對誤差與最大相對誤差（分母下限 1e-12）
function cmp(a, b) {
  let abs = 0, rel = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > abs) abs = d;
    const r = d / Math.max(Math.abs(b[i]), 1e-12);
    if (r > rel) rel = r;
  }
  return { abs, rel };
}

(async () => {
  const cfg = fx.cfg;
  const m = T.fromInit(cfg, fx.init);
  const st = T.adamInit(m);
  const opt = { lr: fx.lr, wd: fx.wd, clip: fx.clip };

  // 步 1 的梯度：前向＋反向（不更新），逐參數對 PyTorch
  {
    const be = T.cpuBackend();
    const f = await T.forward(m, fx.batches[0], be);
    const g = await T.backward(m, f.cache, be);
    const flatG = {};
    T.eachParam(m, g, (p, gg, name) => { flatG[name] = gg; });
    let worst = { name: '', abs: 0, rel: 0 };
    for (const name of Object.keys(fx.step1Grads)) {
      const ref = fx.step1Grads[name];
      const r = cmp(flatG[name], Float64Array.from(ref).length ? Float64Array.from(ref) : ref);
      if (r.abs > worst.abs) worst = { name, abs: r.abs, rel: r.rel };
    }
    ok(worst.abs < 1e-9, '步 1 梯度（全部參數）對 PyTorch 逐參數', 'max abs=' + worst.abs.toExponential(2) + ' max rel=' + worst.rel.toExponential(2) + ' 最差=' + worst.name);
    ok(Math.abs(f.loss - fx.perStep[0].loss) < 1e-12, '步 1 損失對 PyTorch', 'JS=' + f.loss.toFixed(12) + ' PT=' + fx.perStep[0].loss.toFixed(12));
  }

  // 重新初始化，跑完整訓練步數，逐步比對 loss 與梯度範數
  const m2 = T.fromInit(cfg, fx.init);
  const st2 = T.adamInit(m2);
  let maxLossDiff = 0, maxGnDiff = 0;
  for (let s = 0; s < fx.steps; s++) {
    const r = await T.trainStep(m2, fx.batches[s], st2, opt);
    maxLossDiff = Math.max(maxLossDiff, Math.abs(r.loss - fx.perStep[s].loss));
    maxGnDiff = Math.max(maxGnDiff, Math.abs(r.gradNorm - fx.perStep[s].gradNorm));
  }
  ok(maxLossDiff < 1e-9, '全部 ' + fx.steps + ' 步損失對 PyTorch', 'max abs diff=' + maxLossDiff.toExponential(2));
  ok(maxGnDiff < 1e-9, '全部步梯度範數對 PyTorch', 'max abs diff=' + maxGnDiff.toExponential(2));

  // 最後權重對 PyTorch
  let worstW = 0, worstName = '';
  T.eachParam(m2, T.zeroGrads(m2), (p, _g, name) => {
    const ref = fx.final[name];
    const r = cmp(p, Float64Array.from(ref));
    if (r.abs > worstW) { worstW = r.abs; worstName = name; }
  });
  ok(worstW < 1e-8, '最後權重（全部參數）對 PyTorch', 'max abs=' + worstW.toExponential(2) + ' 最差=' + worstName);

  console.log(fail === 0 ? '全部通過' : fail + ' 項失敗');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL 例外：' + (e && e.stack || e)); process.exit(1); });
