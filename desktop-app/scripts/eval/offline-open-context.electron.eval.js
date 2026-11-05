// 真桌面版量「帶上下文」的打開判斷（前：沒有對話上下文；後：帶對話與最近開過的種類）。走真的 _otGateApply → _otGateExplore；問使用者那步回 null＝沒決定。
// 用法同 offline-open-embed.electron.eval.js（前面接 window.__ctx=評測集;）。小模型沒載入時每句未決定約等 5 秒（檢查模型逾時），所以整組約 1～2 分鐘。
const fa = window.fa; fa.advancedSettings.offlineMode = true; localStorage.setItem('fa_gate_embed_consent', '1');
fa.requestUserForm = async () => null; fa._otGateNoProgress = true;
await fa._otLoad(); fa._ot.gateMemory = {};
const out = { before: [], after: [] }; const t0 = Date.now();
for (const mode of ['before', 'after']) {
    for (const [grp, hist, rec, text, exp] of window.__ctx) {
        fa.messages = mode === 'after' ? hist.concat([{ role: 'user', content: text }]) : [{ role: 'user', content: text }];
        fa._ot.recentKinds = mode === 'after' ? rec.slice() : [];
        const plan = { text, slots: {}, decision: { status: 'no_match', chosen: null } };
        let kind = null, by = '', ms = 0; const a = Date.now();
        try { const ga = fa._otGateApply(plan, text); const g = ga.plan.gate; if (g.kind) { kind = g.kind; by = 'table'; } else { const ok = await fa._otGateExplore(ga.plan, text); if (ok) { kind = ga.plan.gate.kind; by = ga.plan.gate.explored.by; } } } catch (e) { by = 'error:' + String((e && e.message) || e).slice(0, 60); }
        ms = Date.now() - a;
        const right = exp === 'ask' ? kind === null : kind === exp;
        out[mode].push({ grp, text, exp, kind, by: String(by).slice(0, 40), ms, right, wrong: kind !== null && !right });
    }
}
const sum = (rows) => ({ total: rows.length, right: rows.filter((r) => r.right).length, wrong: rows.filter((r) => r.wrong).length, byGroup: rows.reduce((o, r) => { const g = o[r.grp] = o[r.grp] || { n: 0, right: 0, wrong: 0 }; g.n++; if (r.right) g.right++; if (r.wrong) g.wrong++; return o; }, {}) });
return { before: sum(out.before), after: sum(out.after), elapsedMs: Date.now() - t0, afterRows: out.after.filter((r) => !r.right).map((r) => [r.grp, r.text, r.exp, r.kind, r.by].join(' | ')), beforeWrong: out.before.filter((r) => r.wrong).map((r) => [r.grp, r.text, r.exp, r.kind, r.by].join(' | ')) };
