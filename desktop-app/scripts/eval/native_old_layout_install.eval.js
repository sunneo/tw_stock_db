// 舊安裝版面的「按安裝」路徑（真 Electron，渲染程序）：走 fa._omNativeInstall（按鈕的同一個函式），確認對話框同意後安裝，
// 再用原生生成一題（選 CPU）確認真推論，最後按移除。前置：執行包來源與模型檔由環境變數給（見 scripts/eval/native_old_layout_install.js）。
return (async () => {
    const R = { checks: [], detail: {} };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const root = document.createElement('div');
    const savedRoot = fa._omPaneRoot; fa._omPaneRoot = root;
    const savedDialog = fa.requestUserForm;
    let asked = null;
    fa.requestUserForm = async (o) => { asked = o; return { confirmed: true, answer: o.choices[0] }; };
    try {
        localStorage.removeItem('fa.native.enabled');
        root.innerHTML = '<div>' + fa._omNativeBoxHtml() + '</div>';
        ck('按鈕存在（安裝原生執行包）', !!root.querySelector('[data-om="native-install"]'));
        await fa._omNativeInstall();
        const prog = root.querySelector('[data-om-native-progress]').textContent;
        R.detail.progress = prog;
        ck('按安裝後顯示安裝完成（沒有 require 錯誤）', /安裝完成/.test(prog) && !/Cannot find module|安裝失敗/.test(prog), prog.slice(0, 200));
        ck('安裝後開關開啟', fa._nrOptIn() === true);
        ck('確認對話框列出檔名與來源', asked && /onnxruntime-node-1\.22\.0\.tgz/.test(asked.description) && /registry\.npmjs\.org/.test(asked.description));
        // 真推論：選 CPU（偏好 cpu）→ 原生
        const savedDevice = fa._omSettings ? null : null;
        const model = FaVlm.byId('qwen3-0.6b');
        const prevPref = fa._omDevicePrefOf(model);
        fa.advancedSettings.offlineDevicePreference = 'cpu';
        const logs = [];
        const text = await fa._llmGenerate(model, { messages: [{ role: 'system', content: '你是答題助手。只回 JSON，不要多說話。' }, { role: 'user', content: '29 × 37 等於多少？\nA. 1066　B. 1073　C. 1074　D. 1070\n只回這個格式：{"answer":"字母"}' }], maxTokens: 16, deterministic: true }, { log: (s) => logs.push(String(s)) });
        fa.advancedSettings.offlineDevicePreference = prevPref;
        R.detail.text = String(text); R.detail.logs = logs.slice(0, 3);
        ck('選 CPU 時真推論走原生', logs.some((s) => /後端：原生/.test(s)), logs.slice(0, 2));
        ck('原生生成結果等於參考答案', String(text) === '{"answer": "C"}', String(text).slice(0, 60));
        await fa._omNativeRefresh();
        R.detail.status = root.querySelector('[data-om-native-status]').textContent;
        // 移除
        fa.requestUserForm = async () => ({ confirmed: true, answer: '移除' });
        await fa._omNativeRemove();
        ck('移除後回到未安裝', fa._nrOptIn() === false);
    } catch (e) {
        ck('流程沒有例外', false, String((e && e.message) || e));
    } finally {
        fa.requestUserForm = savedDialog; fa._omPaneRoot = savedRoot; localStorage.removeItem('fa.native.enabled');
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_old_layout_install ' + JSON.stringify(R));
    return R;
})();
