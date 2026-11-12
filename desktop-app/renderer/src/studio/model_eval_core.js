/* 模型評測（純函式，UMD，node 可測）：單顆模型（LoRA 或完整模型）與基底在同一批留出題上並排比較。
 * 不碰 DOM／網路／檔案；執行（載入、生成、判題）由呼叫端注入。設計：DESIGN.offline-training-studio.md §30。
 *   run（一次評測的結果）＝ { target: { kind: 'lora'|'full', id }, ranAt, groups: [{ group, heldout, n, pass, rate, formatN?, formatPass?, latencyMs? , detail? }] }
 *   留出組（heldout）只給組別層級的數字；compare 與 publicView 都不把 detail（題目、答案、輸出）放出來。
 * 判定（沿用 EVAL_CRITERIA_v2 的口徑）：
 *   n ≥ MIN_N（20）的組才作判斷；比基底低超過 TOL（0.02）＝退步；n < 20 只報告，不算退步也不算通過。
 *   把關（gate）：至少一組有判斷、所有有判斷的組都不輸基底，才算通過。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioModelEval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MIN_N = 20, TOL = 0.02;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    // 目標種類：LoRA 已能評測（桌面版走原生路徑）；完整模型的載入評測待 fp32 轉 ONNX 補上（現在只寫介面與原因）
    const TARGETS = {
        lora: { kind: 'lora', label: 'LoRA 小檔（疊在基底上）', ok: true },
        full: { kind: 'full', label: '完整模型（合併匯出）', ok: false, reason: '完整模型的載入評測待 fp32 轉 ONNX 補上。目前只有量化後的 ONNX q8 檔，沒有可以逐層比對的 fp32 版本，所以還不能在這裡載入評測。補上後，這裡會跑同一批留出題，結果格式與 LoRA 相同。' },
    };
    // 呼叫端先問：這個目標現在能不能評測？不能就回原因（不假裝）
    function planTarget(target) {
        const t = target && TARGETS[target.kind];
        if (!t) return { ok: false, reason: '不認得的模型種類：' + (target && target.kind) };
        if (!target.id) return { ok: false, reason: '沒有選模型' };
        return t.ok ? { ok: true, kind: t.kind, label: t.label } : { ok: false, kind: t.kind, label: t.label, reason: t.reason };
    }
    // 留出組只留數字：不回傳題目、答案、輸出
    function publicView(run) {
        return { target: run.target, ranAt: run.ranAt, groups: (run.groups || []).map((g) => ({ group: g.group, heldout: !!g.heldout, n: g.n, pass: g.pass, rate: g.rate, formatN: g.formatN, formatPass: g.formatPass, latencyMs: g.latencyMs, judged: g.n >= MIN_N, unavailable: g.unavailable || null, ...(g.heldout ? {} : { detail: g.detail }) })) };
    }
    function rateOf(g) { return g && g.n ? (g.rate != null ? g.rate : r4(g.pass / g.n)) : null; }
    function median(xs) { const v = xs.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); }
    // 並排比較：base 與 cand 是兩次 run（同一批題）。回傳表格列、退步名單、格式率、答對率、延遲、把關結果
    function compare(base, cand, opts) {
        opts = opts || {}; const tol = opts.tolerance == null ? TOL : opts.tolerance, minN = opts.minN == null ? MIN_N : opts.minN;
        const bm = new Map((base.groups || []).map((g) => [g.group, g])), cm = new Map((cand.groups || []).map((g) => [g.group, g]));
        const names = [...new Set([...bm.keys(), ...cm.keys()])];
        const rows = names.map((name) => {
            const b = bm.get(name), c = cm.get(name), heldout = !!((c && c.heldout) || (b && b.heldout));
            const n = Math.max((b && b.n) || 0, (c && c.n) || 0);
            const br = rateOf(b), cr = rateOf(c);
            const delta = br != null && cr != null ? r4(cr - br) : null;
            const judged = n >= minN && delta != null;
            const regressed = judged && delta < -tol;
            const status = !c || cr == null ? '沒跑' : !judged ? '只報告（題數不足 ' + minN + '）' : regressed ? '退步' : delta > tol ? '進步' : '持平';
            return { group: name, heldout, n, base: br, cand: cr, delta, judged, regressed, status, unavailable: (c && c.unavailable) || (b && b.unavailable) || null };
        });
        const judgedRows = rows.filter((r) => r.judged);
        const regressedList = rows.filter((r) => r.regressed).map((r) => ({ group: r.group, delta: r.delta, base: r.base, cand: r.cand }));
        const fmt = (g) => g && g.formatN ? { pass: g.formatPass, n: g.formatN, rate: r4(g.formatPass / g.formatN) } : null;
        const formatOf = (run) => { const xs = (run.groups || []).map(fmt).filter(Boolean); const n = xs.reduce((a, x) => a + x.n, 0), p = xs.reduce((a, x) => a + x.pass, 0); return n ? { pass: p, n, rate: r4(p / n) } : null; };
        const acc = (run) => { const gs = (run.groups || []).filter((g) => g.n && !g.unavailable); const n = gs.reduce((a, g) => a + g.n, 0), p = gs.reduce((a, g) => a + g.pass, 0); return n ? { pass: p, n, rate: r4(p / n) } : null; };
        const latency = (run) => ({ medianMs: median((run.groups || []).map((g) => g.latencyMs)) });
        const gateOk = judgedRows.length > 0 && regressedList.length === 0;
        const notes = [];
        if (!judgedRows.length) notes.push('沒有任何一組題數達到 ' + minN + '，無法判定，只能報告數字。');
        const unrun = rows.filter((r) => r.status === '沒跑');
        if (unrun.length) notes.push('有 ' + unrun.length + ' 組沒跑成，不算通過也不算退步。');
        return {
            target: cand.target, baseTarget: base.target, rows,
            regressed: regressedList, format: { base: formatOf(base), cand: formatOf(cand) }, accuracy: { base: acc(base), cand: acc(cand) },
            latency: { base: latency(base), cand: latency(cand) },
            gate: { ok: gateOk, reason: gateOk ? '所有有判斷的組都不輸基底' : (regressedList.length ? '退步：' + regressedList.map((r) => r.group + '（' + (r.delta >= 0 ? '+' : '') + Math.round(r.delta * 1000) / 10 + ' 個百分點）').join('、') : '沒有任何一組題數達到 ' + minN + ' 題，無法判定') },
            notes,
        };
    }
    return { TARGETS, MIN_N, TOL, planTarget, publicView, compare };
});
