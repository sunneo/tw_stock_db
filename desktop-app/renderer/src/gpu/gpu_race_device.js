// gpu_race_device.js — 競賽用的裝置轉接（清單 O9）：把「每個變體的 launch／讀回輸出」變成 kernel_select.raceVariants 要的 { run(id) → ms, verify(id) → 相對誤差 }。
// 計時：now（預設 performance.now）量 launch＋等 GPU 做完（預設 device.queue.onSubmittedWorkDone）。全部可注入，node 用假時鐘與假 GPU 測試。
// 未驗證：真 GPU 上的計時精度與 onSubmittedWorkDone 的行為尚未在真 Chrome 測過。
// UMD：node 用 module.exports；瀏覽器用 self.FaGpuRaceDevice（目前未嵌入 embed-code-ui 清單，接線時再加）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaGpuRaceDevice = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-12;

  // 相對誤差：max|a−b| / max(max|b|, EPS)。長度不同、含非有限值，回傳 Infinity（驗證一定不過）。
  function relErr(out, ref) {
    if (!out || !ref || out.length !== ref.length) return Infinity;
    let num = 0, den = 0;
    for (let i = 0; i < ref.length; i++) {
      const a = out[i], b = ref[i];
      if (!isFinite(a) || !isFinite(b)) return Infinity;
      const d = Math.abs(a - b);
      if (d > num) num = d;
      const m = Math.abs(b);
      if (m > den) den = m;
    }
    return num / Math.max(den, EPS);
  }

  // 計時器：time(launch) → 毫秒。先 launch（把工作送進佇列），再等 GPU 做完，時間差就是這次的耗時。
  function createTimer(opts) {
    opts = opts || {};
    const now = opts.now, awaitGpu = opts.awaitGpu;
    if (typeof now !== 'function' || typeof awaitGpu !== 'function') throw new Error('gpu_race_device：計時器需要 now 與 awaitGpu');
    return {
      time: async function (launch) {
        const t0 = now();
        await launch();
        await awaitGpu();
        return now() - t0;
      }
    };
  }

  // 瀏覽器預設計時器：performance.now ＋ device.queue.onSubmittedWorkDone（WebGPU 標準 API）
  function browserTimer(gpuDevice) {
    if (!gpuDevice || !gpuDevice.queue || typeof gpuDevice.queue.onSubmittedWorkDone !== 'function') {
      throw new Error('gpu_race_device：browserTimer 需要 GPUDevice（queue.onSubmittedWorkDone）');
    }
    return createTimer({
      now: function () { return performance.now(); },
      awaitGpu: function () { return gpuDevice.queue.onSubmittedWorkDone(); }
    });
  }

  // 競賽裝置。opts：
  //   variants：{ [id]: { launch: async () => void, readOut: async () => 陣列 } }（launch 把此變體的工作送進佇列；readOut 讀回輸出）
  //   reference：async () => 陣列（CPU 參考輸出，第一次用到時算一次並快取）
  //   timer：createTimer／browserTimer 的結果
  // run(id)：第一次先暖機（不計時，含編譯與首次配置），之後每次 timer.time(launch) → 毫秒
  // verify(id)：launch 一次、讀回、與參考比相對誤差
  function createRaceDevice(opts) {
    opts = opts || {};
    const variants = opts.variants || {};
    const timer = opts.timer;
    const reference = opts.reference;
    if (!timer || typeof timer.time !== 'function') throw new Error('gpu_race_device：需要 timer');
    if (typeof reference !== 'function') throw new Error('gpu_race_device：需要 reference（CPU 參考輸出）');
    const warmed = {};
    let refP = null;
    function ref() { if (!refP) refP = Promise.resolve().then(reference); return refP; }
    function get(id) {
      const v = variants[id];
      if (!v || typeof v.launch !== 'function' || typeof v.readOut !== 'function') throw new Error('gpu_race_device：沒有變體 ' + id);
      return v;
    }
    return {
      run: async function (id) {
        const v = get(id);
        if (!warmed[id]) { await timer.time(v.launch); warmed[id] = true; }  // 丟掉這次的時間；失敗就不標記，下次再暖
        return timer.time(v.launch);
      },
      verify: async function (id) {
        const v = get(id);
        await v.launch();
        const out = await v.readOut();
        return relErr(out, await ref());
      }
    };
  }

  return { relErr: relErr, createTimer: createTimer, browserTimer: browserTimer, createRaceDevice: createRaceDevice };
}));
