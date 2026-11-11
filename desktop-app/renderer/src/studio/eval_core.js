/* 訓練工作室「評量」核心（UMD，純函式＋依賴注入，不碰 DOM／網路／檔案系統）。設計 §8、§15.1。
 * 每個 kind 有一組「評量組」(suite)：{ group, heldout?, recorded?, run: async () => {n, pass, detail?} | unavailable: '具體原因＋解除條件' }。
 *   runEval(kind, suites, { baseline, gate, now }) → { kind, ranAt, groups[], summary }
 *   每組都列：筆數、通過、通過率、上次通過率、變化、是否退步（紅）、上線門檻、是否過門檻、是否留出（heldout）、不可用原因。
 *   退步＝通過率比基準低超過 tolerance（預設 0.02）；上線門檻＝gate.groups[組名] ?? gate.default（預設 0.8）；沒跑成的組不算通過也不算退步，另列「沒跑」。
 *   summary.releaseOk＝所有「有跑」的組都過門檻且沒有退步，並且至少有一組有跑。
 * 基準（baseline）＝{ 組名: 通過率 }，由呼叫端存（偏好或資產 manifest.eval）；saveBaseline(result) 回新的基準。
 * heldout 的組只給組別層級的數字（不給逐題內容），老師（teacher_core）看不到逐題答案。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DEFAULT_GATE = { default: 0.8, groups: {} };
    const TOL = 0.02;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    async function runEval(kind, suites, o) {
        o = o || {}; const base = o.baseline || {}; const gate = Object.assign({}, DEFAULT_GATE, o.gate || {}); const tol = o.tolerance == null ? TOL : o.tolerance; const now = o.now ? o.now() : Date.now();
        const groups = [];
        for (const s of suites || []) {
            const g = { group: s.group, heldout: !!s.heldout, recorded: !!s.recorded, note: s.note || '' };
            const th = gate.groups && gate.groups[s.group] != null ? gate.groups[s.group] : gate.default; g.gate = th;
            if (s.unavailable) { Object.assign(g, { ran: false, unavailable: String(s.unavailable) }); groups.push(g); continue; }
            let r; try { r = await s.run(); } catch (e) { Object.assign(g, { ran: false, unavailable: '評量執行出錯：' + String((e && e.message) || e) }); groups.push(g); continue; }
            if (!r || r.unavailable) { Object.assign(g, { ran: false, unavailable: String((r && r.unavailable) || '評量沒有回傳結果') }); groups.push(g); continue; }
            const n = Math.max(0, Math.floor(r.n || 0)), pass = Math.max(0, Math.min(n, Number(r.pass) || 0)); const rate = n ? r4(pass / n) : null;
            const prev = base[s.group] != null ? base[s.group] : null; const delta = rate != null && prev != null ? r4(rate - prev) : null;
            Object.assign(g, { ran: true, n, pass, rate, prev, delta, regressed: delta != null && delta < -tol, passedGate: rate != null && rate >= th, detail: s.heldout ? undefined : r.detail });
            groups.push(g);
        }
        const ran = groups.filter((g) => g.ran);
        const summary = { groups: groups.length, ran: ran.length, notRun: groups.length - ran.length, regressed: ran.filter((g) => g.regressed).length, belowGate: ran.filter((g) => !g.passedGate).length };
        summary.releaseOk = ran.length > 0 && summary.regressed === 0 && summary.belowGate === 0;
        return { kind, ranAt: now, groups, summary, gate };
    }
    function saveBaseline(result, old) { const b = Object.assign({}, old || {}); (result.groups || []).forEach((g) => { if (g.ran && g.rate != null) b[g.group] = g.rate; }); return b; }
    // 老師看到的版本：留出組只剩數字，不含逐題內容
    function teacherView(result) { return Object.assign({}, result, { groups: (result.groups || []).map((g) => g.heldout ? { group: g.group, heldout: true, ran: g.ran, n: g.n, rate: g.rate, passedGate: g.passedGate, unavailable: g.unavailable, note: '留出組：只給通過率，題目與答案不可見' } : g) }); }
    // 兩次評量的比較（老師迴圈用：補資料前後有沒有改善）
    function improvement(before, after) {
        const bm = new Map((before.groups || []).filter((g) => g.ran).map((g) => [g.group, g.rate])); const out = []; let better = 0, worse = 0;
        (after.groups || []).forEach((g) => { if (!g.ran || !bm.has(g.group)) return; const d = r4(g.rate - bm.get(g.group)); out.push({ group: g.group, before: bm.get(g.group), after: g.rate, delta: d }); if (d > 0.0001) better++; else if (d < -0.0001) worse++; });
        return { groups: out, better, worse, improved: better > 0 && worse === 0 };
    }
    return { runEval, saveBaseline, teacherView, improvement, DEFAULT_GATE, TOL };
});
