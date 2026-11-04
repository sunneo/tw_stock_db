// 原生執行器階段 5：真 Electron 驗證離線設定頁的「原生執行器」區塊（渲染、狀態、按鈕接線）。只走標準輸入輸出，沒有伺服器。
// 不改使用者的設定頁：用獨立的分離 DOM 節點接上 _omWirePane，測完還原 _omPaneRoot。
// 用法：FA_DEBUG_NATIVE_FAKE=1 node scripts/eval/run_eval.js scripts/eval/native_settings_ui.eval.js 17945
return (async () => {
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const html = fa._omNativeBoxHtml();
    ck('桌面版渲染原生區塊（含重新啟用、關閉子程序按鈕）', html.indexOf('data-om="native-reenable"') >= 0 && html.indexOf('data-om="native-dispose"') >= 0, html.length);

    const saved = fa._omPaneRoot;
    const root = document.createElement('div');
    fa._omPaneRoot = root;
    try {
        await fa._omRenderPane();
        ck('完整離線設定頁渲染時包含原生區塊（真正的 _omRenderPane）', root.innerHTML.indexOf('data-om="native-reenable"') >= 0, root.innerHTML.length);
        root.innerHTML = '<div>' + html + '</div>';
        await fa._omNativeRefresh();
        const st = root.querySelector('[data-om-native-status]').textContent;
        ck('狀態列顯示子程序狀態（未啟動、可用）', /未啟動/.test(st) && /可用/.test(st), st);

        fa._omWirePane(root);
        await window.desktopAPI.nativeRunner.run({ rid: 'ui', fake: { reply: 'k' } });
        root.querySelector('[data-om="native-dispose"]').click();
        await wait(600);
        const st2 = await window.desktopAPI.nativeRunner.status();
        ck('按「關閉子程序」：子程序結束', st2.alive === false, st2);
    } finally {
        fa._omPaneRoot = saved;
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_settings_ui ' + JSON.stringify(R));
    return R;
})();
