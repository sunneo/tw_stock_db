/* 離線 harness 的主機轉接層(通用,不是哪一個編輯器的):把一句需求 → 細切成意圖 → 推導參數 → UML 使用案例 → 交給 CoLU 單元目錄接線 → 回傳工具呼叫。
 * 核心是 renderer/src/harness/intent_harness.js(FaHarness);領域(例如 /edit-video)用 FaHarness.registerDomain 掛進來,NLP 意圖推理之類的新讀法用 FaHarness.registerReasoner 掛在領域前面。設計見 DESIGN.offline-harness.md。
 *   const r = await this._harnessRun('video', 一句話, 狀態, { onStep })  ->  { ok, calls:[{op, tool, args, by, wired}], gaps[], derived[], via[], wired, total, uml, semantic }
 * 接線 = 單元目錄的 catalog_bind(0 次模型呼叫):UML 操作名稱 + 領域給單元的白話說明(unitIntents)做檢索(有設嵌入就加語意檢索),再用型別合約打分;沒接上的步驟退回領域自己指定的工具(by:'fallback',接線品質可以量)。 */
(function () {
    'use strict';
    const M = {};
    // 領域給單元的白話說明(中英都放)併進目錄的意圖表(只在記憶體裡,每次接線前補一次,因為 _unitCatalogIntentsLoad 會重讀存檔的)
    M._harnessUnitIntents = function (domain) {
        const u = this._unitCatalogUserIntents = this._unitCatalogUserIntents || {};
        Object.keys(domain.unitIntents || {}).forEach((n) => { u['tool:' + n] = domain.unitIntents[n]; });
    };
    M._harnessRun = async function (domainId, text, state, opts) {
        opts = opts || {}; const FH = window.FaHarness, d = FH && FH.getDomain(domainId); if (!d) return { ok: false, error: 'no such harness domain: ' + domainId, calls: [], gaps: [], derived: [], via: [] };
        const say = typeof opts.onStep === 'function' ? opts.onStep : () => {};
        const res = FH.decompose(domainId, text, state); if (!res.ok) return { ok: false, calls: [], gaps: res.gaps, derived: res.derived, via: res.via };
        const uml = FH.toUml(d, res.intents); let bind = null, cat = null, semantic = '';
        try {
            await this._unitCatalogStoreLoad(); if (this._unitCatalogIntentsLoad) await this._unitCatalogIntentsLoad(); this._harnessUnitIntents(d); cat = this._unitCatalogBuild();
            let dense = null; try { const p = FaUml.parseDsl(uml); if (!p.errors.length && p.model.usecases.length && this._unitCatalogDenseFor) { dense = await this._unitCatalogDenseFor(FaCatalogBind.queriesOf(p.model)); } } catch (_) { dense = null; }
            bind = this._unitCatalogBind(uml, { dense }); if (bind && bind.ok === false) { say('CoLU: ' + String(bind.error || '').slice(0, 100)); bind = null; } else if (bind) { semantic = dense ? 'dense' : 'bm25'; }
        } catch (e) { say('CoLU: ' + String((e && e.message) || e).slice(0, 100)); bind = null; }
        const cs = FH.callsOf(d, res.intents, bind, cat);
        return { ok: cs.calls.length > 0, calls: cs.calls, gaps: res.gaps.concat(cs.gaps), derived: res.derived, via: res.via, wired: cs.wired, total: cs.total, uml, semantic };
    };
    // ---------- harness 經驗 → 離線訓練器（訓練器是 harness 的學習層）----------
    // 輸入是 skills/weak-model-harness 的 learn 產生的 trainer-patterns.json。只收 FaHarnessExp 認得的 pattern（來源 harness、id 前綴 hx_、範例沒有路徑／金鑰），
    // 進獨立領域 harness_experience（可停用、可刪、在領域清單看得到來源）。預設「停用」：這些 pattern 沒有可執行的工具，只是路由經驗的參考，由使用者決定要不要打開。
    M._hxDomain = async function (create) {
        const st = await this._otLoad(); let d = st.domains.get('harness_experience');
        if (!d && create) d = { name: 'harness_experience', description: '來自弱模型 harness 的經驗（程式驗證過的成功才會進來；來源 harness，可停用、可刪）。離線訓練器是 harness 的學習層。', enabled: false, source: 'harness', patterns: [], tools: [], states: { initial: null, states: {} } };
        return d || null;
    };
    M._hxImport = async function (text) {
        const X = window.FaHarnessExp; if (!X) return { ok: false, error: '經驗模組沒載入' };
        let data; try { data = JSON.parse(String(text || '')); } catch (_) { return { ok: false, error: '不是合法的 JSON' }; }
        const list = data && Array.isArray(data.patterns) ? data.patterns : null; if (!list) return { ok: false, error: '找不到 patterns 陣列（要用 harness 的 learn 產生的 trainer-patterns.json）' };
        const d = await this._hxDomain(true); let added = 0, updated = 0; const rejected = [];
        for (const p of list.slice(0, X.LIM.entries)) {
            const why = !X.isHarnessPattern(p) ? '不是 harness 的 pattern' : p.type !== 'semantic' || !Array.isArray(p.examples) || !p.examples.length ? '格式不對' : p.examples.some((e) => typeof e !== 'string' || X.leaks(e)) ? '範例含路徑或金鑰' : '';
            if (why) { rejected.push({ id: p && p.id, why }); continue; }
            const q = { id: p.id, type: 'semantic', examples: p.examples.map((e) => String(e).slice(0, 300)), intent: String(p.intent || '').slice(0, 120), description: String(p.description || '').slice(0, 300), tool: '', args: {}, risk: 'safe', confidence: Math.min(0.95, Number(p.confidence) || 0.6), source: 'harness', enabled: true, stats: Object.assign({}, p.stats, { harnessTemplate: p.args && p.args.template }) };
            const i = d.patterns.findIndex((x) => x.id === q.id); if (i >= 0) { q.hits = d.patterns[i].hits || 0; d.patterns[i] = q; updated++; } else { d.patterns.push(q); added++; }
        }
        await this._otSaveDomain(d); for (const p of d.patterns) await this._otSyncPatternExamples(d, p);
        return { ok: true, added, updated, rejected, enabled: d.enabled !== false };
    };
    window.FaHarnessHost = { methods: M };
})();
