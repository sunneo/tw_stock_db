// 「如何使用」簡報對照用的真畫面截圖（真 Electron）。用法：FA_EVAL=studio_howto_shots FA_THEME=light|dark FA_TPL=1 xvfb-run -a node scripts/eval/studio_firstrun.run.js
// 逐步操作工作室的簡單模式（五步）、更新資產、進階模式（捲動截圖），每一步截圖並回傳該窗格的文字。隔離的 user-data-dir，不下載、不寫使用者資料。
return (async () => {
    const R = { theme: globalThis.__FA_THEME || 'light', steps: {} };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    const TPL = globalThis.__FA_TPL || FA_STUDIO_VIEWER_HTML;
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const srv = await fa._studioServer();
    const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    let cur = null;
    const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || !cur || ev.source !== cur.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg);
    const open = async (right) => {
        if (cur) cur.remove();
        await route('POST', '/api/prefs', { layout: { panes: { left: ['assets'], right: right || ['train'] }, split: 0.5 } });
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
        f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:1000px;z-index:99999;background:#fff';
        const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' };
        const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
        f.srcdoc = TPL.replace('__CFG__', () => JSON.stringify({ title: '教學對照', theme: R.theme }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
        document.body.appendChild(f); cur = f;
        await until(() => f.contentDocument && f.contentDocument.querySelector('#pR') && f.contentDocument.querySelector('#pR').innerText.length > 10, 20000);
        await wait(900); return f;
    };
    const pane = (f) => f.contentDocument.querySelector('#pR');
    const txt = (f) => pane(f).innerText.slice(0, 1600);
    const btn = (f, re) => Array.from(f.contentDocument.querySelectorAll('button')).find((x) => re.test(x.textContent.trim()));
    const clickBtn = async (f, re) => { const b = btn(f, re); if (!b) return false; b.click(); await wait(900); return true; };
    const clickCard = async (f, re) => { const c = Array.from(f.contentDocument.querySelectorAll('#pR .card')).find((x) => re.test(x.textContent)); if (!c) return false; c.click(); await wait(700); return true; };
    // 截圖由啟動器在收到 [shot] 後才擷取，所以等一下再往下做（否則畫面可能已經進到下一步）
    const snap = async (f, name) => { R.steps[name] = txt(f); console.log('[shot] ' + R.theme + '-' + name); await wait(1800); };

    // A. 簡單模式：五步（1 想做什麼 → 2 目標 → 3 資料（LoRA）→ 4 確認 → 5 開始）
    let f = await open();
    await snap(f, 's1-what');
    await clickCard(f, /🏋 訓練/); await clickBtn(f, /下一步/); await snap(f, 's2-goal');
    await clickCard(f, /訓練語言模型/); await clickBtn(f, /下一步/); await snap(f, 's3-data-lora');
    await clickBtn(f, /上一步/); await clickCard(f, /CoLU 排名/); await clickBtn(f, /下一步/); await snap(f, 's4-confirm');
    await clickBtn(f, /開始訓練/); await wait(2500); await snap(f, 's5-start');

    // B. 更新資產（需要一份自己的資產：先用 API 存一份離線訓練器快照）
    f = await open();
    await clickCard(f, /更新資產/); await clickBtn(f, /下一步/); await snap(f, 'u1-pick-empty');
    const snapRes = await route('POST', '/api/trainer/snapshot', { name: 'my-trainer' }); R.snapRes = snapRes.ok === false ? snapRes.error : 'ok';
    f = await open();
    await clickCard(f, /更新資產/); await clickBtn(f, /下一步/);
    await until(() => Array.from(f.contentDocument.querySelectorAll('#pR .card')).some((x) => /trainer\//.test(x.textContent)), 8000);
    await snap(f, 'u1-pick');
    await clickCard(f, /trainer\//); await clickBtn(f, /下一步/); await snap(f, 'u2-what');

    // C. 進階模式：整頁，捲動截圖
    f = await open();
    await clickBtn(f, /進階模式/); await wait(1200);
    const scroller = () => f.contentDocument.querySelector('#pR .body') || pane(f);
    for (let i = 0; i < 8; i++) {
        const el = scroller(); el.scrollTop = i * 640; await wait(400);
        await snap(f, 'a' + (i + 1) + '-adv');
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) break;
    }
    // D. 整體：預設分頁（左右窗格）
    f = await open(); await wait(600); console.log('[shot] ' + R.theme + '-tabs-default'); await wait(1800);
    if (cur) cur.remove(); cur = null; window.removeEventListener('message', onMsg);
    return R;
})();
