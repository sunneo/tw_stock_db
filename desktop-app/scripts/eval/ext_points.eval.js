// 擴充點的產品視窗實測（由 ext_points.run.js 啟動；真 Electron、渲染程序）。
// (1) 登錄：工具在 fa.tools、宿主工具領域（host_tools，category host_app）、簡報代理人借用的說明裡看得到；
// (2) 離線路由：_otPlan + _recipeAnswer(planOnly, noModel) 對「為什麼大成鋼今天下跌」選到哪個工具、欄位；
// (3) 執行：呼叫工具（產品的 CORS 代理抓真實公開頁面），記錄每個來源的狀態、抓到與查不到的欄位、簡報每頁與來源、最後一頁聲明。
return (async () => {
    const R = { checks: [], t0: Date.now() };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const TOOL = 'ext_stock_drop_cause', TEXT = '為什麼大成鋼今天下跌';
    const fa = window.fa;
    const fin = (e) => { R.error = e ? String((e && e.stack) || e).slice(0, 1200) : undefined; R.totalMs = Date.now() - R.t0; console.log('[eval-file] ext ' + JSON.stringify(R)); return R; };
    try {
        // (1) 登錄
        const t = fa.tools[TOOL];
        ck('工具已登記在 fa.tools（線上工具表的來源）', !!t, t ? Object.keys(t) : null);
        ck('參數結構含 code／name／date', !!(t && t.parametersSchema && t.parametersSchema.properties && t.parametersSchema.properties.code && t.parametersSchema.properties.date));
        ck('工具說明寫明股票下跌調查', !!(t && /下跌|上漲/.test(t.description)));
        const orphan = fa._getOrphanHostToolNames ? fa._getOrphanHostToolNames() : [];
        ck('歸入宿主工具領域（host_tools，category host_app）', orphan.indexOf(TOOL) >= 0, orphan.length);
        const mpKey = fa._deckDomainKey ? fa._deckDomainKey() : null;
        const note = mpKey && fa.domains[mpKey] ? fa._buildInheritedDomainsNote(fa.domains[mpKey]) : '';
        ck('簡報（media-presentation）的系統提示借用到這個工具', note.indexOf(TOOL) >= 0, { domain: mpKey, len: note.length });
        const hits = fa._capSearchTools(TEXT, 5).map((h) => h.name);
        ck('離線工具目錄搜尋（catalog）找得到（' + TEXT + '）', hits.indexOf(TOOL) >= 0, hits);
        // (2) 離線路由（不用模型：只讓程式決定）
        // 路線與橋接（floating-assistant 的 _otPlan 之後）一樣：目錄搜尋的命中當作 extraTools／extraScores 餵給食譜路由；不用模型
        let rr = null, plan = null;
        const hitObjs = fa._capSearchTools(TEXT, 5); const extraScores = {}; hitObjs.forEach((h) => { extraScores[h.name] = h.score; });
        R.catalogHits = hitObjs.map((h) => h.name + ':' + h.score);
        try { plan = await fa._otPlan(TEXT); rr = await fa._recipeAnswer(TEXT, plan, { fallback: true, planOnly: true, noModel: true, extraTools: hitObjs.map((h) => h.name), extraScores }); } catch (e) { R.routeErr = String((e && e.message) || e).slice(0, 400); }
        try { const S = fa._omSettings(); R.dbg = { recipes: S.recipes, plans: S.plans, planKeys: plan ? Object.keys(plan) : null, decisionChosen: plan && plan.decision && plan.decision.chosen ? plan.decision.chosen.tool : null, altTools: plan && plan.alternatives ? plan.alternatives.map((a) => a.tool) : null, cands: fa._recipeCandidates(plan, null, [TOOL], null, extraScores).map((c) => c.tool + ':' + c.score) }; } catch (e) { R.dbg = 'err ' + e; }
        R.route = rr ? { handled: rr.handled, planned: rr.planned || null, missing: rr.missing || null, header: rr.header || null } : null;
        ck('離線路由（程式決定）選到股票調查工具', !!(rr && rr.planned && rr.planned.tool === TOOL), R.route);
        // (3) 執行（產品路徑：代理抓真實公開頁面）
        // 執行的參數就是離線路由決定的參數（使用者原話、程式填的欄位）；沒有路由決定時才退回固定參數
        const args = rr && rr.planned && rr.planned.tool === TOOL ? Object.assign({}, rr.planned.args) : { code: '2027', name: '大成鋼', date: '20261112' };
        R.runArgs = args;
        let raw = null, ex = null;
        try { raw = await t.callback.call(fa, JSON.stringify(args)); } catch (e) { ex = String((e && e.message) || e); }
        R.execException = ex;
        const res = raw ? JSON.parse(raw) : null;
        R.exec = res ? { ok: res.ok, error: res.error || null, entities: res.entities || null, results: res.results || null, unavailable: res.unavailable || null, deckError: res.deckError || '' } : null;
        ck('工具執行回傳 ok', !!(res && res.ok), R.exec);
        if (res && res.ok && res.deck) {
            const ch = res.deck.chapters[res.deck.chapters.length - 1];
            R.slides = ch.slides.map((s) => ({ title: s.title, layout: s.layout, bullets: s.bullets || [], caption: s.caption || '' }));
            const last = R.slides[R.slides.length - 1];
            ck('最後一頁是免責聲明（非投資建議）', last.title === '免責聲明' && /不構成任何投資建議/.test(last.bullets[0] || ''), last);
            ck('每個內容頁都附來源', R.slides.slice(1, -1).every((s) => /來源：/.test(s.caption)), null);
        }
    } catch (e) { return fin(e); }
    return fin(null);
})();
