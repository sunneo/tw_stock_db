// 工作室「網頁版頁內訓練」真 Electron 驗證（由 studio_webtrain.run.js 啟動並餵本機模型／分詞器）：
// 從工作室「訓練」分頁的真畫面（同源探測框）選「網頁處理器」、按「開始訓練」跑小資料數步 → 暫停 → 匯出 .fackpt → 換名稱匯入 → 續訓，記錄畫面文字與 loss。
return (async () => {
    const R = { checks: [], screens: {}, trace: [], alerts: [] }; const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: ok || extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 20000, gap = 300) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) { /* */ } await wait(gap); } return null; };
    const PORT = __PORT__; window.__FA_WEBTRAIN_TEST = { modelUrl: 'http://127.0.0.1:' + PORT + '/model.onnx', remoteHost: 'http://127.0.0.1:' + PORT + '/' };
    R.loaded = Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s));
    ck('載入的是工作目錄的 floating-assistant.js', R.loaded.some((s) => /desktop-app[\\/]renderer[\\/]floating-assistant/i.test(decodeURIComponent(s))), R.loaded);
    ck('Worker 原始碼已嵌入', typeof FA_WEBTRAIN_WORKER_SRC === 'string' && FA_WEBTRAIN_WORKER_SRC.length > 100000, typeof FA_WEBTRAIN_WORKER_SRC === 'string' ? FA_WEBTRAIN_WORKER_SRC.length : typeof FA_WEBTRAIN_WORKER_SRC);
    R.env = { origin: location.origin, protocol: location.protocol, caches: typeof caches, crossOriginIsolated: self.crossOriginIsolated, worker: typeof Worker };
    await fa._studioCommand(''); await until(() => document.querySelector('.fwd iframe[sandbox]'));
    const srv = await fa._studioServer(); const route = async (m, p, b) => { const x = await srv.core.route(m, new URL('http://mock.local' + p), b); return Object.assign({ _s: x.s || 200 }, x.j); };
    const store = await fa._studioStorage();
    // 小資料集（資產 lora/e2e-tiny，data/train.jsonl：messages＋completion）
    const rows = [['台灣的首都是哪裡？', '台北'], ['2 加 3 等於多少？', '5'], ['水的化學式是什麼？', 'H2O'], ['一週有幾天？', '七天'], ['太陽從哪個方向升起？', '東方'], ['一年有幾個月？', '十二個月']].map((x, i) => ({ id: 'r' + i, split: 'train', domain: 'e2e', messages: [{ role: 'user', content: x[0] }], completion: x[1], meta: {} }));
    const files = { 'data/train.jsonl': new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join('\n') + '\n') };
    await store.saveAsset({ manifest: FaStudio.FaStudioAsset.createManifest({ kind: 'lora', name: 'e2e-tiny', files, counts: { samples: rows.length }, owner: 'user' }), files }, { replace: true });
    ck('資料資產存在', !!(await store.loadManifest('lora', 'e2e-tiny')));
    const info = await route('GET', '/api/info'); ck('info.webTrain 為真（宿主已接上）', info.webTrain === true, info);
    const tb0 = Date.now(); const be = await route('GET', '/api/backends?kind=lora'); R.t_backends_1 = Date.now() - tb0; const tb1 = Date.now(); await route('GET', '/api/backends?kind=lora'); R.t_backends_2 = Date.now() - tb1; const tp0 = Date.now(); await fa._studioWebTrain().probe(); R.t_webtrain_probe = Date.now() - tp0; R.backendsApi = be.backends && be.backends.map((b) => b.id + ':' + b.available + (b.reason ? '(' + String(b.reason).slice(0, 60) + ')' : '')); R.backendsNote = be.note;
    ck('網頁版後端清單 wasm-web 可用且 webTrain 旗標為真', be.webTrain === true && be.backends.some((b) => b.id === 'wasm-web' && b.available), R.backendsApi);

    // 注意：桌面版 /api/backends 在這台機器要 44～53 秒（主行程探測 Python 套件，不是頁內宿主：webTrain.probe 只要 1 ms），超過檢視器網路層的 20 秒逾時，
    // 畫面會出現「Failed to fetch（mock伺服器20秒沒有回應）」。為了驗證頁內訓練本身，這裡讓畫面第二次起拿到「第一次的結果」（快取），並在報告裡如實記錄這個延遲。
    const cachedBE = be; const origRoute = srv.core.route.bind(srv.core); srv.core.route = async (method, url, body) => { if (method === 'GET' && url.pathname === '/api/backends') return { s: 200, j: cachedBE }; return origRoute(method, url, body); };
    // ===== 開檢視器（同源探測框）並切到「訓練」分頁 =====
    const L = FaStudio.FaStudioLayout; const d0 = L.defaults(); const all = d0.panes.left.concat(d0.panes.right).filter((x) => x !== 'train');
    await route('POST', '/api/prefs', { layout: { panes: { left: ['train'].concat(all.slice(0, 4)), right: all.slice(4) }, split: 0.9 } });
    const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals'); iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px';
    const cfg = { hosts: ['mock.local'], prefixes: null, block: true, allow_hosts: [], deny: fa._sandboxDenyHosts(), backend: 'iframe' }; const shim = '<script>(' + __faMockShim.toString() + ')(' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ')</' + 'script>';
    iframe.srcdoc = FA_STUDIO_VIEWER_HTML.replace('__CFG__', () => JSON.stringify({ title: '網頁版訓練驗證' }).replace(/</g, '\\u003c')).replace('__SHIM__', () => shim).replace('__LAYOUT__', () => FA_STUDIO_LAYOUT_SRC.replace(/<\/script/gi, '<\\/script'));
    const onMsg = (ev) => { const m = ev.data; if (!m || m.__fa_mock !== 1 || ev.source !== iframe.contentWindow) return; const src = ev.source; srv.handle(m, (r, tr) => { try { src.postMessage(Object.assign({ __fa_mock_r: 1 }, r), '*', tr || []); } catch (_) { /* */ } }); };
    window.addEventListener('message', onMsg); document.body.appendChild(iframe);
    await until(() => iframe.contentDocument && iframe.contentDocument.querySelector('#pL') && iframe.contentDocument.querySelector('#pL').innerText.length > 30, 20000);
    const doc = iframe.contentDocument; const win = iframe.contentWindow; win.alert = (m) => { R.alerts.push(String(m).slice(0, 300)); }; win.confirm = () => true; win.prompt = () => 'x';
    R.jsErrors = []; win.addEventListener('error', (e) => R.jsErrors.push(String(e.message) + '@' + e.lineno)); win.addEventListener('unhandledrejection', (e) => R.jsErrors.push('rej:' + String(e.reason && e.reason.message || e.reason)));
    const text = () => doc.querySelector('#pL').innerText;
    const btn = (label) => Array.from(doc.querySelectorAll('#pL button')).find((b) => b.textContent.indexOf(label) === 0);
    const bsel = await until(() => Array.from(doc.querySelectorAll('#pL select')).find((s) => Array.from(s.options).some((o) => o.value === 'wasm-web')), 180000, 1000);   // 桌面版的後端探測（硬體／Python）要等主行程，可能超過一分鐘
    ck('後端下拉出現「網頁處理器」', !!bsel, text().slice(0, 600)); if (!bsel) { R.screens.noBackend = text(); R.dbg = { t: [R.t_backends_1, R.t_backends_2, R.t_webtrain_probe], jsErrors: R.jsErrors, body: doc.body.innerText.slice(0, 1500), html: doc.querySelector('#pL').innerHTML.slice(0, 1500), selects: Array.from(doc.querySelectorAll('select')).map((x) => Array.from(x.options).map((o) => o.value).join('|')) }; window.removeEventListener('message', onMsg); return R; }
    R.options = Array.from(bsel.options).map((o) => o.textContent + (o.disabled ? '(停用)' : ''));
    bsel.value = 'wasm-web'; bsel.dispatchEvent(new Event('change')); await wait(300);
    ck('選到網頁處理器後「開始訓練」可按（不再要求桌面版）', btn('開始訓練') && !btn('開始訓練').disabled && !/網頁版不能啟動訓練/.test(text()), text().slice(0, 500));
    R.screens.beforeStart = text();
    const input = (pred) => Array.from(doc.querySelectorAll('#pL input[type=text]')).find(pred);
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
    set(input((i) => /資產名稱/.test(i.placeholder || '')), 'e2e-a'); set(input((i) => /訓練資料檔/.test(i.placeholder || '')), 'lora/e2e-tiny');
    const stepsI = input((i) => i.value === '100'); set(stepsI, '4'); const lrI = input((i) => i.value === '0.001'); set(lrI, '0.001');
    // 把 .fackpt 下載與檔案挑選接成可程式控制（避免跳原生對話框）
    const origAClick = HTMLAnchorElement.prototype.click; let dl = null; HTMLAnchorElement.prototype.click = function () { if (this.download) { dl = { name: this.download, href: this.href }; return; } return origAClick.call(this); };
    const origIClick = HTMLInputElement.prototype.click; let pickBytes = null; HTMLInputElement.prototype.click = function () { if (this.type === 'file' && pickBytes) { const dt = new DataTransfer(); dt.items.add(new File([pickBytes.bytes], pickBytes.name)); this.files = dt.files; this.dispatchEvent(new Event('change')); return; } return origIClick.call(this); };
    const st = async () => route('GET', '/api/train/status');
    const snap = async (tag) => { const s = await st(); R.trace.push({ tag, t: Math.round((Date.now() - T0) / 1000), state: s.state, step: s.step, total: s.total, loss: s.loss, phase: s.phase, error: s.error }); return s; };
    const T0 = Date.now();

    // ===== 開始訓練（真的按畫面按鈕）=====
    btn('開始訓練').click(); await wait(1500);
    const s1 = await snap('after-click'); R.screens.afterStart = text();
    ck('按下開始後有工作（不是立刻報錯）', s1.state === 'running' || s1.state === 'idle' || s1.ok !== false, { s1, alerts: R.alerts });
    const got2 = await until(async () => { const s = await snap('poll'); if (s.state === 'error') return s; return s.step >= 2 ? s : null; }, 25 * 60000, 15000);
    ck('訓練跑到至少 2 步', got2 && got2.state !== 'error' && got2.step >= 2, got2);
    R.screens.running = text(); R.lossAtPause = null;
    if (!got2 || got2.state === 'error') { R.final = got2; window.removeEventListener('message', onMsg); return R; }

    // ===== 暫停 → 匯出 =====
    btn('暫停').click(); const paused = await until(async () => { const s = await snap('wait-pause'); return s.state === 'paused' ? s : null; }, 6 * 60000, 5000);
    ck('暫停後狀態 paused 並存了檢查點', paused && paused.state === 'paused', paused); const pausedStep = paused && paused.step; R.pausedStep = pausedStep; R.lossAtPause = paused && paused.lossTail && paused.lossTail.slice(-3);
    R.screens.paused = text();
    btn('匯出續訓檢查點').click(); await until(() => dl, 20000, 200);
    ck('匯出觸發下載（.fackpt）', dl && /e2e-a\.fackpt$/.test(dl.name), dl);
    let ckBytes = null; if (dl) { const bb = await (await fetch(dl.href)).arrayBuffer(); ckBytes = new Uint8Array(bb); } R.fackptBytes = ckBytes && ckBytes.length;
    ck('匯出的檔案是有效 zip（PK 開頭）且夠大', ckBytes && ckBytes[0] === 0x50 && ckBytes[1] === 0x4b && ckBytes.length > 1000000, ckBytes && ckBytes.length);

    // ===== 換名稱匯入 → 續訓 =====
    set(input((i) => /資產名稱/.test(i.placeholder || '')), 'e2e-b'); pickBytes = { name: 'from-other-machine.fackpt', bytes: ckBytes };
    const alertsBefore = R.alerts.length; btn('匯入續訓檢查點').click(); await until(() => R.alerts.length > alertsBefore, 30000, 300);
    R.importAlert = R.alerts[R.alerts.length - 1]; ck('匯入成功並提示步數', /已匯入：\d+ 步/.test(R.importAlert || ''), R.importAlert);
    R.screens.afterImport = text();
    set(stepsI, '5'); btn('續訓').click(); await wait(1500);
    const resumed = await until(async () => { const s = await snap('resume-poll'); if (s.state === 'error') return s; return s.step > pausedStep ? s : null; }, 20 * 60000, 15000);
    ck('續訓從匯入的步數接續並再往前（step > 暫停步數）', resumed && resumed.state !== 'error' && resumed.step > pausedStep, { pausedStep, resumed });
    R.screens.resumed = text(); R.lossAfterResume = resumed && resumed.lossTail && resumed.lossTail.slice(-5);
    await route('POST', '/api/train/stop', {}); await wait(2000); await snap('stopped');
    HTMLAnchorElement.prototype.click = origAClick; HTMLInputElement.prototype.click = origIClick; window.removeEventListener('message', onMsg); iframe.remove();
    R.seconds = Math.round((Date.now() - T0) / 1000); return R;
})();
