'use strict';
// 多工作者（multiprocessing 墊片）的純排程邏輯，不碰 Worker／Pyodide。由 floating-assistant.js 的 _mpWorkerCap、_mpAcquire、_mpSubmit 接上。
// 內容：(1) 工作者上限（低階裝置降到 1 到 2）；(2) 建立工作者失敗時的退回（已有工作者就改等它們，一個都沒有才丟錯）；
// (3) 依序分派、結果保持輸入順序；(4) 任務出錯：不再開始新任務、等在飛中的任務結束後丟出第一個錯誤；(5) 取消（AbortSignal）同樣不再開始新任務，在飛中的任務會跑完（Web Worker 中途不能強殺單一任務）。

// 工作者上限。opts: { maxWorkers, hardwareConcurrency, deviceMemory }
// 原本的公式：max(2, min(8, 核心數))，再受 maxWorkers 限制；這裡加上低階裝置的降級：
//   deviceMemory ≤ 2 GB → 1；核心數 ≤ 2 → 最多 2。結果一定在 [1, 8]。
function mpWorkerCap(opts) {
  opts = opts || {};
  const hc = Number(opts.hardwareConcurrency) > 0 ? Number(opts.hardwareConcurrency) : 4;
  const mem = Number(opts.deviceMemory) > 0 ? Number(opts.deviceMemory) : 0;
  let cap = Math.max(2, Math.min(8, hc));
  if (Number(opts.maxWorkers) > 0) cap = Math.min(cap, Number(opts.maxWorkers));
  if (mem && mem <= 2) cap = 1;
  else if (hc <= 2) cap = Math.min(cap, 2);
  return Math.max(1, Math.min(8, Math.floor(cap)));
}

// 建立工作者失敗時該怎麼辦。liveCount：目前仍可用的工作者數。
// 有工作者：不丟錯，改等它們，並把上限降到目前的數量（記憶體可能吃緊，之後不再嘗試多開）。
// 沒有工作者：丟錯（沒有任何東西能跑），上限降為 1。
function afterCreateFailure(liveCount) {
  const n = Math.max(0, Math.floor(Number(liveCount) || 0));
  if (n > 0) return { action: 'wait', cap: n, reason: '建立工作者失敗（可能記憶體不足），改用已有的 ' + n + ' 個工作者' };
  return { action: 'throw', cap: 1, reason: '建立工作者失敗，而且沒有任何可用的工作者' };
}

// 依序分派任務，最多 concurrency 個同時執行。
// opts: { items, concurrency, runTask(item, index) → Promise, signal? }
// 回傳與 items 同順序的結果陣列；第一個錯誤或取消會讓之後的任務不再開始，等在飛中的任務結束後丟出。
async function runMap(opts) {
  const items = Array.from((opts && opts.items) || []);
  const runTask = opts && opts.runTask;
  if (typeof runTask !== 'function') throw new TypeError('runMap：需要 runTask(item, index)');
  const signal = opts && opts.signal;
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const n = Math.max(1, Math.min(Math.floor(Number(opts.concurrency) || 1), items.length));
  let next = 0, firstErr = null, stopped = false;
  const onAbort = () => {
    if (!firstErr) { const e = new Error('已取消'); e.name = 'AbortError'; firstErr = e; }
    stopped = true;
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const runner = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try {
        results[i] = await runTask(items[i], i);
      } catch (e) {
        if (!firstErr) firstErr = e;
        stopped = true;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: n }, runner));
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (firstErr) throw firstErr;
  return results;
}

module.exports = { mpWorkerCap, afterCreateFailure, runMap };
