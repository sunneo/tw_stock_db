// 原生執行器階段 2：真 Electron 驗證統一後端順序（FaVlm.backendOrder）。
// 不載入模型、不下載；檢查：(1) 函式存在於真桌面版；(2) 沒有原生時與 resolveDevice 完全相同；
// (3) 原生可用時 native 排第一；(4) 目前產品的實際路徑（_coluDeviceOf／_omDevicePrefOf）行為不變。
// 用法：node scripts/eval/run_eval.js scripts/eval/backend_order.eval.js 17942
return (async () => {
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    ck('FaVlm.backendOrder 存在', typeof FaVlm.backendOrder === 'function');
    const m = FaVlm.byId('qwen3-0.6b');
    const gpu = await fa._omGpuInfo();
    const pref = fa._omDevicePrefOf(m);
    const base = FaVlm.resolveDevice(m, pref, gpu.available, gpu.f16);
    const off = FaVlm.backendOrder(m, pref, gpu.available, gpu.f16, false);
    ck('沒有原生時 backendOrder 與 resolveDevice 相同（真實環境）', JSON.stringify(off) === JSON.stringify(base), { off, base });
    const on = FaVlm.backendOrder(m, pref, gpu.available, gpu.f16, true);
    ck('原生可用時 native 排第一', on.order[0] === 'native' && on.native === true, on);
    const dev = await fa._coluDeviceOf({ model: m });
    ck('_coluDeviceOf 仍回傳有效的裝置（產品路徑不變）', !!dev && typeof dev === 'string' || (dev && dev.device), dev);
    R.gpu = { available: gpu.available, f16: gpu.f16, name: gpu.name };
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] backend_order ' + JSON.stringify(R));
    return R;
})();
