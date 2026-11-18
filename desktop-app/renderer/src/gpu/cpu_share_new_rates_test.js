'use strict';
// 新速率下的分攤決策（假裝置，node）：新核心 CPU 12.6 GFLOP/s 與 GPU 約 11.7 GFLOP/s（實測量級）→ 決策應接近各半（上限 0.5）；
// 舊的 CPU 速率（0.70e6 flops/ms，舊核心／工作者慢路徑）→ 決策只給很小的比例。並檢查平衡點附近確實接近最佳。
const assert = require('assert');
const HS = require('./hetero_split.js');

const W = 2 * 512 * 512 * 512;                 // 512³ 矩陣乘的 flop 數
const GPU_RATE = 11712862;                     // 實測（flops/ms）
const CPU_NEW = 12600000;                      // 新核心主執行緒 12.6 GFLOP/s（flops/ms）
const CPU_OLD = 703000;                        // 上一次真機快取的舊速率（flops/ms）

const dec = (cpuRate, extra) => HS.decideSplit(Object.assign({
  work: W, gpuAvailable: true, cpuAvailable: true, gpuRate: GPU_RATE, cpuRate,
  gpuOverheadMs: 1, cpuOverheadMs: 0.5,
}, extra || {}));

// 1. 新速率：切分，比例接近上限（各半）
{
  const d = dec(CPU_NEW);
  assert.strictEqual(d.mode, 'split', '新速率應切分：' + d.reason);
  assert.ok(d.fraction > 0.45 && d.fraction <= 0.5, '比例應接近各半（上限 0.5），實得 ' + d.fraction);
  assert.ok(d.saving > 0.35, '預測省下的比例應明顯（實得 ' + d.saving + '）');
  console.log(`ok 新速率：切分，CPU 比例 ${d.fraction.toFixed(3)}，預測省 ${(d.saving * 100).toFixed(0)}%`);
}

// 2. 舊速率：比例很小（說明上一次真機為什麼只分到 8%）
{
  const d = dec(CPU_OLD);
  assert.ok(d.mode === 'gpu' || d.fraction < 0.15, '舊速率下比例應很小或全給 GPU，實得 ' + d.mode + ' ' + d.fraction);
  console.log(`ok 舊速率：${d.mode}，比例 ${d.fraction.toFixed(3)}（說明先前只分到小比例的原因）`);
}

// 3. 平衡點附近接近最佳：在 f ∈ [0,0.5] 掃描，預測時間最小值與決策值差距 ≤ 2%
{
  const d = dec(CPU_NEW);
  const G = W / GPU_RATE, C = W / CPU_NEW;
  const predict = (f) => Math.max((1 - f) * G + 1, f * C + 0.5);
  let best = Infinity, bestF = 0;
  for (let f = 0; f <= 0.5; f += 0.001) { const t = predict(f); if (t < best) { best = t; bestF = f; } }
  const chosen = predict(d.fraction);
  assert.ok(chosen <= best * 1.02, `決策 f=${d.fraction} 預測 ${chosen.toFixed(2)} ms，最佳 f=${bestF.toFixed(3)} ${best.toFixed(2)} ms，差距超過 2%`);
  console.log(`ok 平衡點：決策 f=${d.fraction.toFixed(3)}，掃描最佳 f=${bestF.toFixed(3)}，預測差距 ${((chosen / best - 1) * 100).toFixed(2)}%`);
}

// 4. 沒有 CPU 速率（尚未量測）：保守全給 GPU（不瞎猜）
assert.strictEqual(dec(0).mode, 'gpu');
console.log('ok CPU 速率未量測：全給 GPU');
console.log('cpu_share_new_rates_test：全部通過');
