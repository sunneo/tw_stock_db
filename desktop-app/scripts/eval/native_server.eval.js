// 原生執行器階段 4：真 Electron 驗證本機伺服器的啟停與綁定（經 desktopAPI.nativeRunner.server）。
// 限制：伺服器不送 CORS 標頭，渲染程序（file://）無法直接讀取回應，所以這裡只驗證啟停、保留埠、綁定位址；
// 金鑰、路由、錯誤碼由 native-runner/server.test.js（node --experimental-fetch）驗證。
// 用法：node scripts/eval/run_eval.js scripts/eval/native_server.eval.js 17944
return (async () => {
    const nr = window.desktopAPI && window.desktopAPI.nativeRunner;
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    if (!nr || !nr.server) { ck('desktopAPI.nativeRunner.server 存在', false); console.log('[eval-file] native_server ' + JSON.stringify(R)); return R; }

    const st0 = await nr.server.status();
    ck('預設不啟動伺服器', st0.running === false, st0);

    const reserved = await nr.server.start({ port: 17923 });
    ck('保留埠 17923 被拒絕並說明原因', reserved.ok === false && /17923/.test(reserved.message), reserved);

    const s1 = await nr.server.start({ port: 17924 });
    ck('啟動於 17924，回傳金鑰（64 字元）', s1.ok === true && s1.port === 17924 && typeof s1.key === 'string' && s1.key.length === 64, { port: s1.port, keyLen: s1.key && s1.key.length, msg: s1.message });

    ck('實際綁定位址為 127.0.0.1（不是 0.0.0.0）', s1.address === '127.0.0.1', s1.address);

    const st1 = await nr.server.status();
    ck('狀態為執行中且埠正確', st1.running === true && st1.port === 17924, st1);

    const again = await nr.server.start({ port: 17924 });
    ck('重複啟動回傳同一個伺服器（不另開）', again.ok === true && again.already === true, again);

    const stop = await nr.server.stop();
    ck('停止後狀態為未執行', stop.stopped === true && (await nr.server.status()).running === false);

    const s2 = await nr.server.start({ port: 17924 });
    ck('停止後可以再啟動', s2.ok === true, s2);
    await nr.server.stop();

    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_server ' + JSON.stringify(R));
    return R;
})();
