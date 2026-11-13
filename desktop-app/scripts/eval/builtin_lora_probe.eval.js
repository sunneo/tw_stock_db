// 內建 LoRA 端到端（§33 批 3），在產品視窗（真 Electron 渲染程序）內執行。由 builtin_lora_probe.run.js 啟動。
// 流程（乾淨 userData）：原生執行包與槽版 → 清單 → 第一輪（decompose）路由前下載匯入→原生套用→生成 → 第二輪（toolcall）→
// 閱讀（沒附文章不下載；附文章才下載）→ 總開關關閉（不下載、回基底）→ 刪除後重下 → 六張卡片 DOM 計數。
// 不改產品程式：只呼叫產品的函式與路由；包一層記錄，不改行為。
return (async () => {
    const R = { checks: [], steps: [], t0: Date.now() };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fa = window.fa; fa.advancedSettings.offlineMode = false;
    const fin = (e) => { R.error = e ? String((e && e.stack) || e).slice(0, 1500) : undefined; R.totalMs = Date.now() - R.t0; R.pass = !e && R.checks.every((c) => c.ok); console.log('[eval-file] builtin ' + JSON.stringify(R)); return R; };
    try {
        fa._nrSetOptIn(true);
        fa.advancedSettings.offlineDevicePreference = 'cpu';
        const st0 = await fa._nrCall('status');
        ck('原生執行包就緒（含 lora、prefill）', st0 && st0.runtime && st0.runtime.ok && (st0.runtime.features || []).indexOf('lora') >= 0, st0 && st0.runtime);
        R.slotPrepare = await fa._nrCall('slot_prepare', {}, 60000).catch((e) => ({ ok: false, error: String(e) }));
        for (let i = 0; i < 900; i++) { const s = await fa._nrCall('slot_status', {}, 60000).catch(() => null); R.slot = s; if (s && s.slot && s.slot.model) break; if (s && s.phase === 'failed') break; await wait(1000); }
        ck('LoRA 槽版模型已就緒', !!(R.slot && R.slot.slot && R.slot.slot.model), R.slot);
        const srv = await fa._studioServer();
        const api = async (mth, p, b) => { const t = Date.now(); const x = await srv.core.route(mth, new URL('http://mock.local' + p), b || null); return Object.assign({ _s: x.s || 200, _ms: Date.now() - t }, x.j); };
        const model = FaVlm.byId('qwen3-0.6b');
        let lastRoute = null, lastSwitch = null;
        const origRoute = fa._loraRouteTurn.bind(fa), origSwitch = fa._loraSwitch.bind(fa);
        fa._loraRouteTurn = async (task, text, cb) => { const r = await origRoute(task, text, cb); lastRoute = r && { task: r.task, domain: r.domain, fallback: r.fallback, active: r.active, action: r.action, reason: r.reason }; return r; };
        fa._loraSwitch = async (route) => { const t = Date.now(); const r = await origSwitch(route); lastSwitch = { ms: Date.now() - t, applied: r && r.applied, applyError: r && r.applyError, active: r && r.active, action: r && r.action, fallback: r && r.fallback }; return r; };
        const gen = async (label, task, content, expectNativeNote) => {
            lastRoute = null; lastSwitch = null; const logs = []; const t0 = Date.now(); let text = '', err = null;
            try { text = await fa._llmGenerate(model, { messages: [{ role: 'user', content }], maxTokens: 160, deterministic: true, task }, { log: (s) => logs.push(String(s)) }); }
            catch (e) { err = String((e && e.message) || e); }
            const row = { label, task, ms: Date.now() - t0, err, text: String(text).slice(0, 160), route: lastRoute, sw: lastSwitch, progressLines: logs.filter((s) => /下載|強化模組/.test(s)).slice(0, 4), native: logs.some((s) => /後端：原生/.test(s)) };
            R.steps.push(row); return row;
        };
        // ---- 0. 乾淨狀態 ----
        const v0 = await api('GET', '/api/builtin');
        ck('清單可讀（六顆）', v0.ok && v0.entries.length === 6, { ok: v0.ok, message: v0.message, n: v0.entries && v0.entries.length });
        ck('乾淨：六顆都還沒下載', v0.entries.every((e) => !e.downloaded), v0.entries.filter((e) => e.downloaded).map((e) => e.id));
        // ---- 1. 第一輪 decompose：路由前下載、匯入、套用、生成 ----
        const r1 = await gen('decompose 第一輪', 'decompose', '請把「計算兩數之和並印出結果」拆成函式清單，輸出 JSON，欄位 functions。');
        ck('第一輪先下載 decompose-r4-v2（有「第一次使用」說明）', r1.progressLines.some((s) => /第一次使用.*拆題.*約 40 MB/.test(s)), r1.progressLines);
        ck('第一輪路由選到 decompose-r4-v2 並套用', r1.route && r1.route.fallback === 'lora' && r1.route.active.indexOf('decompose-r4-v2') >= 0 && r1.sw && r1.sw.applied, { route: r1.route, sw: r1.sw });
        ck('第一輪原生生成', r1.native && !r1.err, { native: r1.native, err: r1.err });
        // ---- 2. 第二輪 toolcall：下載 toolcall-r4 ----
        const r2 = await gen('toolcall 第二輪', 'toolcall', '查台北的天氣，用工具呼叫。可用工具：get_weather(city)。');
        ck('第二輪路由選到 toolcall-r4', r2.route && r2.route.fallback === 'lora' && r2.route.active.indexOf('toolcall-r4') >= 0, { route: r2.route, sw: r2.sw });
        // ---- 3. 閱讀：沒附文章不下載；附文章才下載 ----
        const r3 = await gen('reading 沒附文章', 'reading', '台灣的首都是哪裡？');
        ck('閱讀：沒附文章不下載、用基底', !r3.progressLines.length && (!r3.route || r3.route.fallback !== 'lora'), { route: r3.route, progressLines: r3.progressLines });
        const r4 = await gen('reading 附文章', 'reading', '【文章】台北是台灣的首都，位於台灣北部。\n請依文回答：台灣的首都在哪裡？');
        ck('閱讀：附文章才下載 reading-r4', r4.progressLines.some((s) => /閱讀理解/.test(s)), r4.progressLines);
        // ---- 4. 總開關關閉：不下載（用 colu，尚未下載）、回基底 ----
        const off = await api('POST', '/api/builtin/master', { on: false });
        ck('總開關關閉', off.ok && off.master === false, off.master);
        const r5 = await gen('總開關關閉後 colu', 'colu', '請選出正確答案字母 A-E：2+2=？ A.3 B.4 C.5 D.6 E.7。只回一個字母。');
        ck('總開關關閉：不下載 colu、用基底、已載入的 LoRA 清掉', !r5.progressLines.length && (!r5.route || r5.route.fallback !== 'lora') && (!r5.sw || r5.sw.action === 'clear' || r5.sw.active.length === 0), { route: r5.route, sw: r5.sw });
        const on = await api('POST', '/api/builtin/master', { on: true });
        ck('總開關重新打開', on.ok && on.master === true);
        // ---- 5. 刪除後重下：刪 toolcall-r4，再下一輪 toolcall 會重新下載 ----
        const del = await api('POST', '/api/builtin/delete', { id: 'toolcall-r4' });
        ck('刪除 toolcall-r4', del.ok === true, del);
        const r6 = await gen('toolcall 刪除後重下', 'toolcall', '查台北的天氣，用工具呼叫。可用工具：get_weather(city)。');
        ck('刪除後再下載 toolcall-r4', r6.progressLines.some((s) => /工具呼叫/.test(s)), r6.progressLines);
        // ---- 6. 六張卡片 DOM：用產品裡的卡片 HTML 產生器，計數 .card（不是截圖）----
        const v = await api('GET', '/api/builtin');
        const LM = FaStudio.FaStudioLoraManage;
        const host = document.createElement('div'); host.id = 'probe-builtin-cards'; host.innerHTML = LM ? LM.builtinCardsHTML(v) : ''; document.body.appendChild(host);
        R.cardDom = { cards: host.querySelectorAll('.card').length, buttons: host.querySelectorAll('[data-builtin-action]').length, downloadedLabels: Array.from(host.querySelectorAll('.card .kv')).map((x) => x.textContent.slice(0, 60)).slice(0, 6) };
        host.remove();
        ck('六張卡片 DOM 計數 6', R.cardDom.cards === 6, R.cardDom);
        R.finalView = (v.entries || []).map((e) => ({ id: e.id, downloaded: e.downloaded, gatePass: e.gatePass, enabled: e.enabled, sizeMB: e.sizeMB }));
        await fa._studioLoraApplier().then((a) => a.clear()).catch(() => null);
        return fin(null);
    } catch (e) { return fin(e); }
})();
