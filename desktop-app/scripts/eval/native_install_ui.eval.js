// 原生執行包安裝介面（真 Electron，渲染程序）：確認對話框取消不下載；同意後安裝（測試來源＝本機檔案）、狀態顯示已安裝；移除後回到未安裝。
// 前置環境變數：FA_NATIVE_INSTALL_NPM_FILE（onnxruntime-node tgz 路徑）、FA_NATIVE_INSTALL_GH_DIR（分割包資料夾）。
return (async () => {
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const root = document.createElement('div');
    const savedRoot = fa._omPaneRoot; fa._omPaneRoot = root;
    const savedDialog = fa.requestUserForm;
    const asked = [];
    const answerWith = (answer) => { fa.requestUserForm = async (o) => { asked.push(o); return { confirmed: true, answer }; }; };
    try {
        root.innerHTML = '<div>' + fa._omNativeBoxHtml() + '</div>';
        localStorage.removeItem('fa.native.enabled');
        await fa._omNativeRefresh();
        const st0 = root.querySelector('[data-om-native-status]').textContent;
        ck('預設狀態是未安裝（不探測主程序）', fa._nrOptIn() === false && /未安裝/.test(st0), st0);
        answerWith('取消');
        await fa._omNativeInstall();
        ck('按取消時不安裝、不開啟', fa._nrOptIn() === false);
        ck('確認對話框列出檔名、來源、授權、大小', asked.length === 1 && /onnxruntime-node-1\.22\.0\.tgz/.test(asked[0].description) && /registry\.npmjs\.org/.test(asked[0].description) && /MIT/.test(asked[0].description) && /89 MB/.test(asked[0].description), asked[0] && asked[0].description);
        answerWith('同意安裝');
        await fa._omNativeInstall();
        const prog = root.querySelector('[data-om-native-progress]').textContent;
        ck('同意後安裝完成，進度區顯示完成與來源數', fa._nrOptIn() === true && /安裝完成/.test(prog), prog);
        await fa._omNativeRefresh();
        const st1 = root.querySelector('[data-om-native-status]').textContent;
        ck('狀態顯示已安裝與版本', /已安裝/.test(st1) && /1\.22\.0-1/.test(st1), st1);
        answerWith('移除');
        await fa._omNativeRemove();
        const prog2 = root.querySelector('[data-om-native-progress]').textContent;
        ck('移除後回到原路徑（開關關閉、顯示已移除）', fa._nrOptIn() === false && /已移除/.test(prog2), prog2);
        await fa._omNativeRefresh();
        const st2 = root.querySelector('[data-om-native-status]').textContent;
        ck('移除後狀態回到未安裝', /未安裝/.test(st2), st2);
    } finally {
        fa.requestUserForm = savedDialog; fa._omPaneRoot = savedRoot; localStorage.removeItem('fa.native.enabled');
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_install_ui ' + JSON.stringify(R));
    return R;
})();
