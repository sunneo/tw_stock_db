// 斜線指令 /offline-training-studio 真桌面版驗證：用法 node scripts/eval/real_electron.run.js ots_slash 17972
// 檢查：指令已註冊、別名存在且從選單隱藏（/training-studio、/訓練工作室）、呼叫 handler 後工作室視窗（沙盒 iframe）真的出現、
// 再用 reset 還原版面不開視窗、最後關掉視窗。不做訓練、不做匯出。
// 只寫不跑：這支評測需要真的桌面版，依使用者要求由使用者自己驗收。
return (async () => {
    const R = { checks: [] }; const fa = window.fa;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    const LIMIT_MS = 500000; const t00 = Date.now();

    ck('斜線指令 /offline-training-studio 已註冊', !!(fa && fa.slashCommands && fa.slashCommands.get('/offline-training-studio')));
    const entry = fa.slashCommands.get('/offline-training-studio');
    ck('指令有 handler 與參數提示 [reset]', entry && typeof entry.handler === 'function' && entry.hint === '[reset]', entry && { hint: entry.hint });
    for (const al of ['/training-studio', '/訓練工作室']) {
        const ae = fa.slashCommands.get(al);
        ck('別名 ' + al + ' 存在且從選單隱藏', !!(ae && ae._menuHidden === true && ae.cmd === al), ae && { cmd: ae.cmd, hidden: ae._menuHidden });
    }

    // 開視窗：呼叫 handler（同 /offline-training-studio 直接打字的路徑）
    await entry.handler('', fa);
    const card = await until(() => document.querySelector('.fwd iframe[sandbox]') && document.querySelector('.fwd'), 20000);
    ck('handler 呼叫後工作室視窗（沙盒 iframe）出現', !!card, { elapsedMs: Date.now() - t00 });
    ck('iframe 沙盒沒有 same-origin', card && !/allow-same-origin/.test(document.querySelector('.fwd iframe').getAttribute('sandbox')));

    // 用別名開：應該開同一個視窗（不重複開一個新的）
    const before = document.querySelectorAll('.fwd').length;
    await fa.slashCommands.get('/訓練工作室').handler('', fa);
    await wait(800);
    ck('別名開的是同一個視窗，不會多開', document.querySelectorAll('.fwd').length <= Math.max(before, 1), { before, after: document.querySelectorAll('.fwd').length });

    // reset 只還原版面，不開新視窗
    await entry.handler('reset', fa);
    await wait(500);
    ck('reset 會還原版面（有提示訊息）', /還原成預設/.test(document.body.innerText || ''));

    // 關閉視窗
    const xb = document.querySelector('.fwd .fwd-bar button');
    ck('視窗有關閉鈕', !!xb);
    if (xb) { xb.click(); await wait(500); }
    ck('關閉後視窗拿掉', !document.querySelector('.fwd iframe[sandbox]'));

    ck('整體在上限 500 秒內完成', Date.now() - t00 < LIMIT_MS, { elapsedMs: Date.now() - t00 });
    R.pass = R.checks.every((c) => c.ok); R.failed = R.checks.filter((c) => !c.ok).map((c) => c.name);
    return { pass: R.pass, failed: R.failed, n: R.checks.length };
})();
