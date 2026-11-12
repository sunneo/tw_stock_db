'use strict';
/* 「下一次訓練該加強什麼」建議（純函式，不碰檔案與網路）。設計見 DESIGN.TODO.offline-training-studio.md §18.2。
 *   adviceFromEval(input) → { ok, suggestions:[…], insufficient:[…], thresholds }
 *   input：{ groups（eval_run.py --json_out 的 groups：{ 組名: {n, base, tuned} }）, rows（同檔的 rows，可省）,
 *            trainRows（{ "task/kind": 訓練列數 }，由呼叫端從資料檔數出）, source（證據來源檔名，寫進建議）, thresholds（可覆寫） }
 * 規則寫在 RULES 資料表（scope＋條件＋動作＋文字樣板），畫面程式只負責顯示；條件缺欄位時不猜，記進 insufficient 並寫出缺什麼。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioAdvice = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const DEFAULT_THRESHOLDS = {
        gate: 0.6,              // 微調正確率的門檻（低於就列為仍不足）
        minGroupN: 5,           // 組別至少幾題才判斷門檻（少於這個數字太吵）
        minDomainRows: 200,     // 領域訓練列數的下限
        minFailures: 3,         // 失敗題數至少幾題才看失敗型態
        formatShare: 0.5,       // 格式錯誤占失敗的比例達此值即判為格式問題
        contentShare: 0.5,      // 內容錯誤占失敗的比例達此值即判為內容問題
        minBiasN: 8,            // 位置偏誤判斷至少幾題
        biasShare: 0.5          // 某一選項被預測的比例達此值即判為偏誤
    };
    // 動作（畫面用來連到對應按鈕）：補資料、調比重、換超參數、先確認
    const ACTIONS = {
        add_data: { label: '補資料', hint: '到匯入／產生頁補這類題型的訓練資料（先驗證再收錄）' },
        reweight: { label: '調比重', hint: '調整各領域或選項位置的訓練比重，不增加資料' },
        hparam: { label: '換超參數', hint: '調學習率、輪數或 rank，建議只在資料已經足夠時做' },
        check: { label: '先確認', hint: '證據不足，先補上缺的欄位再判斷' }
    };
    // 規則表。when 的每一條是 [欄位, 運算子, 值或門檻名]；門檻名會換成 thresholds 裡的數字。
    // text 用 {欄位} 代入；evidence 只列這條規則實際用到的數字。
    const RULES = [
        { id: 'regression', scope: 'group', severity: 'high', action: 'reweight', when: [['delta', '<', 0]],
          text: '{name} 退步：基底 {base}/{n}，微調 {tuned}/{n}。這組的資料或比重可能擠掉了原有能力。', fields: ['base', 'tuned', 'n', 'delta'] },
        { id: 'below-gate', scope: 'group', severity: 'medium', action: 'add_data', when: [['n', '>=', 'minGroupN'], ['tunedRate', '<', 'gate']],
          text: '{name} 仍低於門檻：微調 {tunedPct}％（{tuned}/{n}），門檻 {gatePct}％。', fields: ['tuned', 'n', 'tunedRate'] },
        { id: 'few-rows', scope: 'domain', severity: 'medium', action: 'add_data', when: [['trainRows', '<', 'minDomainRows']],
          text: '{name} 訓練資料只有 {trainRows} 列，低於 {minDomainRows} 列。', fields: ['trainRows'] },
        { id: 'format-errors', scope: 'domain', severity: 'medium', action: 'add_data', when: [['failTuned', '>=', 'minFailures'], ['formatShare', '>=', 'formatShare']],
          text: '{name} 的失敗以格式錯誤為主（{formatCount}/{failTuned}）：補格式範例，不是補內容。', fields: ['formatCount', 'failTuned', 'formatShare'] },
        { id: 'content-errors', scope: 'domain', severity: 'medium', action: 'add_data', when: [['failTuned', '>=', 'minFailures'], ['contentShare', '>=', 'contentShare']],
          text: '{name} 的失敗以內容錯誤為主（{contentCount}/{failTuned}）：補這類題型的範例。', fields: ['contentCount', 'failTuned', 'contentShare'] },
        { id: 'position-bias', scope: 'global', severity: 'medium', action: 'reweight', when: [['biasN', '>=', 'minBiasN'], ['biasShare', '>=', 'biasShare']],
          text: '答案位置偏誤：微調輸出的 {biasLetter} 佔 {biasPct}％（標準答案中 {goldPct}％）。調整選項位置的比重。', fields: ['biasLetter', 'biasPct', 'goldPct', 'biasN'] }
    ];
    const NEED = {
        'position-bias': '評量輸出的 rows 沒有 gold（標準答案）與 pred（預測）欄位；eval_run.py 目前沒寫這兩欄，需要補上才能判斷位置偏誤'
    };

    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
    const pct = (x) => Math.round(x * 1000) / 10;
    function cmp(a, op, b) {
        switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; case '==': return a === b; default: return false; }
    }
    function resolveThreshold(v, th) { return typeof v === 'string' && Object.prototype.hasOwnProperty.call(th, v) ? th[v] : v; }

    // 把一條規則套到一個項目（group 或 domain 或 global）。回 { hit, missing, values }
    function evalRule(rule, item, th) {
        const missing = [];
        for (const [field, op, rhs] of rule.when) {
            const v = item[field];
            if (v === undefined || v === null || (typeof v === 'number' && !isNum(v))) { missing.push(field); continue; }
            if (!cmp(v, op, resolveThreshold(rhs, th))) return { hit: false, missing: [] };
        }
        if (missing.length) return { hit: false, missing };
        return { hit: true, missing: [] };
    }

    function fmtText(tpl, vals) { return tpl.replace(/\{(\w+)\}/g, (_, k) => (vals[k] === undefined || vals[k] === null ? '？' : String(vals[k]))); }

    // 從 rows 算每個領域的失敗型態（只看 tuned_ok 為假的題）。note 以 eval_run.py 的寫法：format… 或 wrong…
    function categorizeNote(note) {
        const s = String(note || '');
        if (/^format/.test(s)) return 'format';
        if (/^wrong/.test(s)) return 'content';
        return 'other';
    }
    function domainStats(rows) {
        const out = {};
        for (const r of Array.isArray(rows) ? rows : []) {
            if (!r || typeof r !== 'object' || !r.key) continue;
            const d = out[r.key] || (out[r.key] = { failTuned: 0, formatCount: 0, contentCount: 0, otherCount: 0 });
            if (r.tuned_ok === false) { d.failTuned++; const c = categorizeNote(r.note); if (c === 'format') d.formatCount++; else if (c === 'content') d.contentCount++; else d.otherCount++; }
        }
        for (const k of Object.keys(out)) { const d = out[k]; d.formatShare = d.failTuned ? d.formatCount / d.failTuned : 0; d.contentShare = d.failTuned ? d.contentCount / d.failTuned : 0; }
        return out;
    }
    // 位置偏誤：需要每列的 gold 與 pred（都是 A–Z 或 1–9 之類的單一字元）。缺欄位回 null
    function positionBias(rows) {
        const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.gold === 'string' && typeof r.pred === 'string');
        if (!list.length) return null;
        const pc = {}, gc = {};
        for (const r of list) { pc[r.pred] = (pc[r.pred] || 0) + 1; gc[r.gold] = (gc[r.gold] || 0) + 1; }
        let best = null; for (const k of Object.keys(pc)) if (!best || pc[k] > pc[best]) best = k;
        return { biasN: list.length, biasLetter: best, biasShare: pc[best] / list.length, biasPct: pct(pc[best] / list.length), goldPct: pct((gc[best] || 0) / list.length) };
    }

    function adviceFromEval(input) {
        const inp = input || {}, th = Object.assign({}, DEFAULT_THRESHOLDS, inp.thresholds || {});
        const src = inp.source ? String(inp.source) : '（未指定來源檔）';
        const suggestions = [], insufficient = [];
        const emit = (rule, scope, name, item, source) => {
            const r = evalRule(rule, item, th);
            if (r.missing.length) { insufficient.push({ rule: rule.id, name, missing: r.missing, reason: NEED[rule.id] || ('缺欄位：' + r.missing.join('、')) }); return; }
            if (!r.hit) return;
            const vals = Object.assign({}, item, { name, minGroupN: th.minGroupN, gatePct: pct(th.gate), minDomainRows: th.minDomainRows });
            suggestions.push({
                id: rule.id + ':' + name, rule: rule.id, scope, name, severity: rule.severity, action: rule.action,
                actionLabel: ACTIONS[rule.action].label, actionHint: ACTIONS[rule.action].hint,
                text: fmtText(rule.text, vals),
                evidence: { source: source, numbers: Object.fromEntries(rule.fields.map((f) => [f, item[f]])) }
            });
        };

        // 組別（scope group）
        const groups = inp.groups && typeof inp.groups === 'object' ? inp.groups : {};
        for (const name of Object.keys(groups).sort()) {
            const g = groups[name] || {}; const n = g.n, base = g.base, tuned = g.tuned;
            if (!isNum(n) || n <= 0 || !isNum(base) || !isNum(tuned)) { insufficient.push({ rule: 'group', name, missing: ['n／base／tuned'], reason: '組別沒有完整的數字' }); continue; }
            const item = { n, base, tuned, delta: tuned - base, baseRate: base / n, tunedRate: tuned / n, tunedPct: pct(tuned / n), basePct: pct(base / n) };
            const source = src + ' groups["' + name + '"]';
            for (const rule of RULES.filter((x) => x.scope === 'group')) emit(rule, 'group', name, item, source);
        }

        // 領域（scope domain）：列數來自 trainRows；失敗型態來自 rows
        const stats = domainStats(inp.rows), trainRows = inp.trainRows && typeof inp.trainRows === 'object' ? inp.trainRows : {};
        const domains = Array.from(new Set(Object.keys(trainRows).concat(Object.keys(stats)))).sort();
        for (const name of domains) {
            const st = stats[name] || { failTuned: 0, formatCount: 0, contentCount: 0, formatShare: 0, contentShare: 0 };
            const item = { trainRows: isNum(trainRows[name]) ? trainRows[name] : undefined, failTuned: st.failTuned, formatCount: st.formatCount, contentCount: st.contentCount, formatShare: st.formatShare, contentShare: st.contentShare };
            if (item.trainRows === undefined && !stats[name]) { insufficient.push({ rule: 'domain', name, missing: ['trainRows'], reason: '沒有這個領域的訓練列數' }); continue; }
            const source = src + ' rows[key=' + name + '] 與 trainRows';
            for (const rule of RULES.filter((x) => x.scope === 'domain')) emit(rule, 'domain', name, item, source);
        }

        // 全域（scope global）：位置偏誤
        const pb = positionBias(inp.rows);
        if (!pb) insufficient.push({ rule: 'position-bias', name: '全體', missing: ['rows[].gold', 'rows[].pred'], reason: NEED['position-bias'] });
        else for (const rule of RULES.filter((x) => x.scope === 'global')) emit(rule, 'global', '全體', pb, src + ' rows（gold／pred）');

        return { ok: true, suggestions, insufficient, thresholds: th, actions: ACTIONS };
    }

    return { DEFAULT_THRESHOLDS, ACTIONS, RULES, categorizeNote, domainStats, positionBias, evalRule, adviceFromEval };
}));
