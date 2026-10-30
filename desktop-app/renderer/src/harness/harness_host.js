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
    window.FaHarnessHost = { methods: M };
})();
