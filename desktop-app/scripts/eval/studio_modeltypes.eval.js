// 模型類型入口的真 Electron 檢查（簡單＋進階、開關關／開）。用法：FA_MT=1 FA_TPL=1 FA_HALF=0|1 FA_EVAL=studio_modeltypes FA_THEME=light xvfb-run -a node scripts/eval/studio_firstrun.run.js
// 設定頁的開關在宿主頁面；這裡只檢查它的 DOM 有沒有被註冊，並用與宿主相同的方式算出 CFG（登錄表＋守門）給探測框。隔離的使用者資料夾。
return (async () => {
    const R = { half: !!globalThis.__FA_HALF, steps: {}, checks: {} };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    const TPL = globalThis.__FA_TPL || FA_STUDIO_VIEWER_HTML;
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    if (globalThis.__FA_MT_SRC) (0, eval)(globalThis.__FA_MT_SRC);
    const MT = globalThis.__FA_MT_SRC ? window.FaStudioModelTypes : FaStudio.FaStudioModelTypes;
    // 與 floating-assistant.js 的 _studioModelTypesPayload 相同的算法
    const showHalf = R.half; const guards = {};
    MT.TYPES.forEach((t) => { guards[t.id] = { _default: MT.canStart(t.id, (t.outputs[0] || {}).id, showHalf) }; t.outputs.forEach((o) => { guards[t.id][o.id] = MT.canStart(t.id, o.id, showHalf); }); });
    const payload = { showHalf, list: MT.listFor(showHalf), guards };
    R.listed = payload.list.map((t) => t.label);
    const srv = await fa._studioServer();
    const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    let cur = null;
    const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || !cur || ev.source !== cur.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg);
    const open = async () => {
        if (cur) cur.remove();
        await route('POST', '/api/prefs', { layout: { panes: { left: ['assets'], right: ['train'] }, split: 0.5 } });
        const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
        f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:1000px;z-index:99999;background:#fff';
        const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' };
        const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
        const c = { title: '模型類型', theme: globalThis.__FA_THEME || 'light', modelTypes: payload.list, guards: payload.guards, showHalf, modelTypesMissing: false };
        f.srcdoc = TPL.replace('__CFG__', () => JSON.stringify(c).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
        document.body.appendChild(f); cur = f;
        await until(() => f.contentDocument && f.contentDocument.querySelector('#pR select') && f.contentDocument.querySelector('#pR').innerText.length > 10, 20000);
        await wait(900); return f;
    };
    const clickCard = async (f, re) => { const c = Array.from(f.contentDocument.querySelectorAll('#pR .card')).find((x) => re.test(x.textContent)); if (!c) return false; c.click(); await wait(700); return true; };
    const pane = (f) => f.contentDocument.querySelector('#pR');
    const txt = (f) => pane(f).innerText.slice(0, 1800);
    const selOf = (f) => pane(f).querySelector('select');
    const pick = async (f, v) => { const s = selOf(f); s.value = v; s.dispatchEvent(new Event('change')); await wait(900); };
    const btn = (f, re) => Array.from(pane(f).querySelectorAll('button')).find((x) => re.test(x.textContent.trim()));
    const clickBtn = async (f, re) => { const b = btn(f, re); if (!b) return false; b.click(); await wait(900); return true; };
    const snap = async (f, name) => { R.steps[name] = txt(f); R.steps[name + '-options'] = Array.from(selOf(f).options).map((o) => o.textContent.trim()); console.log('[shot] ' + (globalThis.__FA_THEME || 'light') + '-' + (R.half ? 'half' : 'nohalf') + '-' + name); await wait(1800); };

    // 1. 簡單模式（預設 LLM）
    let f = await open();
    await snap(f, 'simple-llm-lora');
    // 2. 輸出改成完整模型，走到確認
    await clickBtn(f, /完整模型/); await snap(f, 'simple-llm-full-picked');
    await clickCard(f, /🏋 訓練/); await clickBtn(f, /下一步/); await wait(600);
    R.steps.simple_goal_with_full = txt(f).slice(0, 900);
    // 3. 換成語音合成（半成品或未開啟時不存在）
    await pick(f, 'speech'); await snap(f, 'simple-speech');
    await clickBtn(f, /開始訓練/); await snap(f, 'simple-speech-start');
    R.checks.speechPresent = Array.from(selOf(f).options).some((o) => /語音合成/.test(o.textContent));
    // 4. 只有設計的類型（開關開時才可選）
    if (R.half) { await pick(f, 'image'); await clickBtn(f, /開始訓練/); await snap(f, 'simple-image-design'); }
    // 5. 進階模式
    await pick(f, 'llm'); await clickBtn(f, /進階模式/); await snap(f, 'adv-llm');
    if (R.half) { await pick(f, 'speech'); await snap(f, 'adv-speech-half'); }
    if (cur) cur.remove(); cur = null; window.removeEventListener('message', onMsg);
    R.checks.hasHalfToggleDom = !!document.getElementById('ai-studio-half-chk');
    return R;
})();
