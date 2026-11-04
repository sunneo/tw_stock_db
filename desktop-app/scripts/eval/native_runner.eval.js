// 原生執行器階段 3：真 Electron 驗證子程序執行器（經 preload 的 desktopAPI.nativeRunner → 主程序 native-runner/ipc.js → 子程序 child.js 假引擎）。
// 需要環境變數 FA_DEBUG_NATIVE_FAKE=1（讓假引擎旋鈕生效）。不載入模型、不下載。
// 用法：FA_DEBUG_NATIVE_FAKE=1 node scripts/eval/run_eval.js scripts/eval/native_runner.eval.js 17943
return (async () => {
    const nr = window.desktopAPI && window.desktopAPI.nativeRunner;
    const R = { checks: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ck('desktopAPI.nativeRunner 存在（桌面版）', !!nr);
    if (!nr) { console.log('[eval-file] native_runner ' + JSON.stringify(R)); return R; }

    const s0 = await nr.status();
    ck('一開始子程序未啟動（懶啟動）', s0.alive === false, s0);

    const toks = []; let startId = null;
    const off = nr.onEvent((ev) => { if (ev.kind === 'token') toks.push(ev.text); if (ev.kind === 'start') startId = ev.id; });
    const r1 = await nr.run({ rid: 'a', stream: true, maxTokens: 50, fake: { reply: 'hello 世界' } });
    ck('run 回傳完整結果（ok 與文字）', r1.ok && r1.result.text === 'hello 世界', r1);
    ck('串流 token 逐字送到渲染程序', toks.join('') === 'hello 世界', toks);

    startId = null;
    const p2 = nr.run({ rid: 'b', stream: true, fake: { reply: 'x'.repeat(300), delay_ms: 20 } });
    for (let i = 0; i < 100 && !startId; i++) await wait(50);
    const c2 = startId ? await nr.cancel(startId) : false;
    const r2 = await p2;
    ck('取消：送出 cancel 後呼叫端收到 cancelled', c2 === true && !r2.ok && r2.code === 'cancelled', { c2, r2 });

    const r3 = await nr.run({ rid: 'c', timeoutMs: 800, fake: { reply: 'y'.repeat(2000), delay_ms: 30, ignore_cancel: true } });
    ck('逾時：拋 timeout=true（寬限後強制結束）', !r3.ok && r3.timeout === true, r3);

    const r4a = await nr.run({ rid: 'd', fake: { crash: true } });
    ck('崩潰一次：呼叫端收到 crashed', !r4a.ok && r4a.code === 'crashed', r4a);
    await wait(800);
    const r4b = await nr.run({ rid: 'e', fake: { crash: true } });
    await wait(800);
    const s4 = await nr.status();
    ck('連續崩潰兩次：停用原生路徑', s4.disabled === true, s4);
    const r4c = await nr.run({ rid: 'f', fake: { reply: 'x' } });
    ck('停用後 run 回傳 native_disabled（真實原因）', !r4c.ok && r4c.code === 'native_disabled', r4c);
    await nr.reenable();
    const r4d = await nr.run({ rid: 'g', fake: { reply: 'back' } });
    ck('reenable 後恢復正常', r4d.ok && r4d.result.text === 'back', r4d);

    await nr.dispose();
    off();
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] native_runner ' + JSON.stringify(R));
    return R;
})();
