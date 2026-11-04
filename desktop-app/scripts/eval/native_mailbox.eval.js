// 不重裝版（8-C）真 Electron 驗證：渲染程序經 desktopAPI.rawfs 信箱呼叫主程序 nr-ipc.js（由 main-ext.js 註冊）。
// 檢查：(1) 不用 desktopAPI.nativeRunner 也能取得狀態；(2) reenable 有回應；(3) run 在沒有真引擎時回傳 no_engine（不假裝成功）；
// (4) 設定頁區塊的狀態列由信箱更新。用法：node scripts/eval/run_eval.js scripts/eval/native_mailbox.eval.js 17953
return (async () => {
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    ck('不依賴 desktopAPI.nativeRunner（preload 沒有這個欄位）', !(window.desktopAPI && window.desktopAPI.nativeRunner));
    ck('渲染程序有 rawfs 與 diag.mainExt', fa._nrAvailable());
    const t0s = Date.now(); const st = await fa._nrCall('status'); const dtS = Date.now() - t0s;
    ck('status 經信箱回應 ok', st && st.ok === true && st.status && typeof st.status.alive === 'boolean', { st, ms: dtS });
    const re = await fa._nrCall('reenable');
    ck('reenable 經信箱回應 ok', re && re.ok === true, re);
    const run = await fa._nrCall('run', { messages: [{ role: 'user', content: 'x' }], maxTokens: 4 });
    ck('run 沒有真引擎時回傳 no_engine（不假裝成功）', run && run.ok === false && run.code === 'no_engine', run);
    const saved = fa._omPaneRoot; const root = document.createElement('div');
    fa._omPaneRoot = root;
    try {
        root.innerHTML = '<div>' + fa._omNativeBoxHtml() + '</div>';
        await fa._omNativeRefresh();
        const txt = root.querySelector('[data-om-native-status]').textContent;
        ck('設定頁區塊的狀態列由信箱更新', /子程序：/.test(txt), txt);
    } finally { fa._omPaneRoot = saved; }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_mailbox ' + JSON.stringify(R));
    return R;
})();
