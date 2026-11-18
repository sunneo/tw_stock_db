'use strict';
// 卸載交界點（純函式）：矩陣乘的運算量（2·m·k·n）小於交界點時走 CPU（省上傳與讀回），否則走 GPU。
// 交界點來自 Profile 的實測（faProfilePlan 的 crossoverFlops）；沒有實測值時回到「維持 GPU」，不自己編門檻。
// 特殊值：crossoverFlops === Infinity 表示 CPU 在各種大小都不輸（全走 CPU）；0 或負數 = 永遠走 GPU。

function flopsOf(m, k, n) { return 2 * m * k * n; }

// 回傳 { route: 'cpu' | 'gpu', flops, reason }
function offloadDecision(o) {
  const { m, k, n } = o || {};
  const flops = flopsOf(m, k, n);
  if (o.gpuReady === false) return { route: 'cpu', flops, reason: '沒有可用的 GPU' };
  const x = o.crossoverFlops;
  if (x === null || x === undefined || Number.isNaN(Number(x))) return { route: 'gpu', flops, reason: '尚未量測卸載交界點，維持 GPU' };
  if (x === Infinity) return { route: 'cpu', flops, reason: 'Profile 量測：CPU 在各種大小都不輸 GPU' };
  if (!(x > 0)) return { route: 'gpu', flops, reason: 'Profile 量測：交界點不為正，永遠走 GPU' };
  if (flops < x) return { route: 'cpu', flops, reason: `運算量 ${flops} 小於交界點 ${x}，CPU 較快且省傳輸` };
  return { route: 'gpu', flops, reason: `運算量 ${flops} 不小於交界點 ${x}，走 GPU` };
}

module.exports = { offloadDecision, flopsOf };
