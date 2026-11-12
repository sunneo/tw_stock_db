// 評量分頁的「模型評測」區（真 Electron）。用法：FA_TPL=1 FA_INJECT=model_eval_core FA_EVAL=studio_eval_models xvfb-run -a node scripts/eval/studio_firstrun.run.js
// 未嵌入的伺服器路由由探測端的同一個純函式（model_eval_core）補上：目標判斷與錯誤原因與伺服器相同；LoRA 路徑需要宿主執行器，這裡回 501 的說明。隔離資料夾。
return (async () => {
    const R = { steps: {} };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(150); } return null; };
    for (const m of (globalThis.__FA_INJECT || [])) (0, eval)(m.src);
    const ME = window.FaStudioModelEval;
    const TPL = globalThis.__FA_TPL || FA_STUDIO_VIEWER_HTML;
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const srv = await fa._studioServer();
    const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    const shimRoute = async (m, u, b) => {
        if (u.pathname !== '/api/eval/model') return null;
        const tg = (b && b.target) || {}; const plan = ME.planTarget(tg);
        if (!plan.ok) return { s: 400, j: { ok: false, error: plan.reason } };
        return { s: 501, j: { ok: false, error: '這個環境還沒有接上模型評測的執行器（h.modelEval）。LoRA 的留出題評測需要桌面版的原生推論，請在桌面版執行；網頁版目前不能做這個評測。' } };
    };
    let cur = null;
    const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || !cur || ev.source !== cur.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg);
    const origRoute = srv.core.route; srv.core.route = async (m, u, b) => { const sh = await shimRoute(m, u, b); return sh || origRoute(m, u, b); };
    const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:1000px;z-index:99999;background:#fff'; cur = f;
    await route('POST', '/api/prefs', { layout: { panes: { left: ['assets'], right: ['eval'] }, split: 0.5 } });
    const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' };
    const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
    f.srcdoc = TPL.replace('__CFG__', () => JSON.stringify({ title: '評量' }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
    document.body.appendChild(f);
    await until(() => f.contentDocument && f.contentDocument.querySelector('#pR') && /模型評測/.test(f.contentDocument.querySelector('#pR').innerText), 20000);
    await wait(900);
    const pane = f.contentDocument.querySelector('#pR');
    const snap = async (name) => { R.steps[name] = pane.innerText.slice(0, 1500); console.log('[shot] ' + (globalThis.__FA_THEME || 'light') + '-' + name); await wait(1800); };
    const sel = Array.from(pane.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => /完整模型/.test(o.textContent)));
    R.options = sel ? Array.from(sel.options).map((o) => o.textContent) : [];
    const runBtn = () => Array.from(pane.querySelectorAll('button')).find((b) => /跑留出題/.test(b.textContent));
    await snap('eval-model-panel');
    sel.value = 'full|full'; sel.dispatchEvent(new Event('change')); runBtn().click(); await until(() => /完整模型的載入評測待|沒有|需要/.test(pane.innerText.slice(-600)) && !/評測中/.test(pane.innerText), 8000); await wait(500);
    await snap('eval-model-full');
    R.textFull = pane.innerText.slice(pane.innerText.indexOf('模型評測'), pane.innerText.indexOf('模型評測') + 900);
    srv.core.route = origRoute; window.removeEventListener('message', onMsg); f.remove(); cur = null;
    return R;
})();
