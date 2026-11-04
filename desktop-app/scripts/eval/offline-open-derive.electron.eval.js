// 真桌面版量「加小模型後」的命中率（用法：FA_DISABLE_MAIN_OVERLAY=1 FA_DEBUG_EVAL_FILE=<本檔> FA_BROWSER_CONTROL_PORT=17951 electron . --user-data-dir=<全新資料夾>；絕不用 17923）
// 每句走真的 _otGateApply → _otGateExplore（工具目錄用 this.tools 的真說明；沒有知識庫來源；小模型用已安裝的 qwen3-0.6b＋Thinking；問使用者那一步回 null＝不回答）
// 輸出：每句最後定案的種類與由誰決定（程式／小模型／沒決定），以及分段命中率。資料集來自 scripts/eval/offline-open-derive.data.js（由呼叫端用 window.__evalData 帶進來）。
const fa = window.fa; fa.advancedSettings.offlineMode = true;
const data = window.__evalData; const limit = window.__evalLimit || 999; const t0 = Date.now(); const budgetMs = window.__evalBudgetMs || 150000;
fa.requestUserForm = async () => null;
const rows = []; let n = 0;
for (const [text, exp] of data) {
    if (Date.now() - t0 > budgetMs || n++ >= limit) { rows.push({ text, exp, stage: 'skipped' }); continue; }
    const plan = { text, slots: {}, decision: { status: 'no_match', chosen: null } };
    const t1 = Date.now(); let kind = null, by = '', stage = '';
    try {
        const ga = fa._otGateApply(plan, text); const g = ga.plan.gate;
        if (g.kind) { kind = g.kind; stage = 'table'; by = g.kindBy; }
        else { const ok = await fa._otGateExplore(ga.plan, text); if (ok) { kind = ga.plan.gate.kind; by = ga.plan.gate.explored.by; stage = /工具目錄/.test(by) ? 'derive' : (/小模型/.test(by) ? 'model' : 'other'); } else stage = g.explicit ? 'undecided' : 'not-explicit'; }
    } catch (e) { stage = 'error'; by = String((e && e.message) || e).slice(0, 80); }
    rows.push({ text, exp, kind, stage, by, ms: Date.now() - t1 });
}
const seg = {}; let right = 0, total = 0, progRight = 0;
for (const r of rows) { if (r.stage === 'skipped') continue; total++; seg[r.stage] = (seg[r.stage] || 0) + 1; if (r.kind === r.exp) { right++; if (r.stage === 'table' || r.stage === 'derive') progRight++; } }
return { total, right, progRight, seg, rows: rows.map((r) => [r.text, r.exp, r.kind, r.stage, r.by, r.ms].join(' | ')) };
