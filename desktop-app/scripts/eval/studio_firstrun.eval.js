// 一般使用者第一次使用的實機檢查（真 Electron）。用法：FA_SHOT_DIR=… xvfb-run -a node scripts/eval/studio_firstrun.run.js（FA_TPL=1 用工作目錄的未嵌入樣板）
// 只讀畫面文字、按鈕與下拉選項，並以 "[shot] 名稱" 請啟動器截圖。隔離的 user-data-dir，不寫使用者資料。
return (async () => {
    const R = { text: {}, buttons: {}, selects: {}, walk: {} };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    const TPL = globalThis.__FA_TPL || FA_STUDIO_VIEWER_HTML;
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const srv = await fa._studioServer();
    const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    const d = FaStudio.FaStudioLayout.defaults();
    const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || !curFrame || ev.source !== curFrame.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg);
    let curFrame = null;
    // 開一個探測畫面：left/right 指定哪個分頁放在哪個窗格；回傳 iframe
    const open = async (left, right) => {
        if (curFrame) curFrame.remove();
        const rest = d.panes.left.concat(d.panes.right).filter((x) => left.indexOf(x) < 0 && right.indexOf(x) < 0);
        await route('POST', '/api/prefs', { layout: { panes: { left, right }, split: 0.5 } });
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
        f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:1000px;z-index:99999;background:#fff';
        const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' };
        const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
        f.srcdoc = TPL.replace('__CFG__', () => JSON.stringify({ title: '首次使用' }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
        document.body.appendChild(f); curFrame = f;
        await until(() => f.contentDocument && f.contentDocument.querySelector('#pL') && f.contentDocument.querySelector('#pL').innerText.length > 10, 20000);
        await wait(900); return f;
    };
    const txt = (f, sel) => { const e = f.contentDocument.querySelector(sel); return e ? e.innerText : ''; };
    const btnTexts = (f) => Array.from(f.contentDocument.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean);
    const clickBtn = async (f, re) => { const b = Array.from(f.contentDocument.querySelectorAll('button')).find((x) => re.test(x.textContent.trim())); if (!b) return false; b.click(); await wait(900); return true; };
    const clickCard = async (f, re) => { const c = Array.from(f.contentDocument.querySelectorAll('.card')).find((x) => re.test(x.textContent)); if (!c) return false; c.click(); await wait(700); return true; };

    // 1. 各分頁：文字與按鈕（左窗格放要看的分頁）
    const tabs = ['assets', 'lora', 'ingest', 'datasets', 'domains', 'eval'];
    for (const t of tabs) {
        const f = await open([t], ['train']);
        R.text[t] = txt(f, '#pL').slice(0, 1400); R.buttons[t] = btnTexts(f).slice(0, 40);
        console.log('[shot] 10-tab-' + t);
    }
    // 2. 訓練（簡單模式）逐步走一遍
    let f = await open(['assets'], ['train']);
    R.walk.s1 = txt(f, '#pR').slice(0, 500);
    await clickCard(f, /🏋 訓練/); await clickBtn(f, /下一步/);
    R.walk.s2 = txt(f, '#pR').slice(0, 500);
    await clickCard(f, /CoLU 排名/); await clickBtn(f, /下一步/);
    R.walk.s3 = txt(f, '#pR').slice(0, 700); console.log('[shot] 20-wizard-confirm');
    await clickBtn(f, /開始訓練/); await wait(2500);
    R.walk.s4 = txt(f, '#pR').slice(0, 900); console.log('[shot] 21-wizard-running');
    R.selects.train = Array.from(f.contentDocument.querySelectorAll('select')).map((s) => Array.from(s.options).map((o) => o.textContent.trim()));
    if (curFrame) curFrame.remove(); curFrame = null; window.removeEventListener('message', onMsg);
    return R;
})();
