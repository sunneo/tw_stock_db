/* 排名模型的訓練（UMD，純函式）：邏輯迴歸（L2 正則、類別不平衡加權、特徵標準化），加上『留一組』交叉驗證。
 * 資料是 [{ group, x: {特徵名: 數值}, y: 0|1 }]；group 是需求（同一個需求的所有候選一組）。訓練結果是一個小 JSON
 * { names, use, mean, std, w, b }，discover_core.predict 直接用。資料很少時（幾十筆）交叉驗證的數字會抖，要看樣本數。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogRankTrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const sigmoid = (z) => 1 / (1 + Math.exp(-z));
    // rows：[{ x, y }]；opts：{ use（特徵名稱清單）, l2, lr, iters, balance }
    function fit(rows, opts) {
        opts = Object.assign({ l2: 0.05, lr: 0.3, iters: 1500, balance: true }, opts || {}); const use = opts.use || Object.keys(rows[0].x); const n = rows.length, d = use.length;
        const mean = use.map((nm) => rows.reduce((a, r) => a + (r.x[nm] || 0), 0) / n); const std = use.map((nm, j) => Math.sqrt(rows.reduce((a, r) => a + ((r.x[nm] || 0) - mean[j]) ** 2, 0) / n) || 1);
        const X = rows.map((r) => use.map((nm, j) => ((r.x[nm] || 0) - mean[j]) / std[j])); const pos = rows.filter((r) => r.y === 1).length, neg = n - pos; const wp = opts.balance && pos ? n / (2 * pos) : 1, wn = opts.balance && neg ? n / (2 * neg) : 1;
        const w = new Array(d).fill(0); let b = 0;
        for (let it = 0; it < opts.iters; it++) {
            const gw = new Array(d).fill(0); let gb = 0;
            for (let i = 0; i < n; i++) { let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j]; const e = (sigmoid(z) - rows[i].y) * (rows[i].y === 1 ? wp : wn) * (rows[i].w == null ? 1 : rows[i].w); for (let j = 0; j < d; j++) gw[j] += e * X[i][j]; gb += e; }
            for (let j = 0; j < d; j++) w[j] -= opts.lr * (gw[j] / n + opts.l2 * w[j]); b -= opts.lr * gb / n;
        }
        return { names: use.slice(), use, mean, std, w, b };
    }
    const predictOne = (m, x) => { let z = m.b; m.use.forEach((nm, i) => { z += m.w[i] * (((x[nm] || 0) - m.mean[i]) / (m.std[i] || 1)); }); return sigmoid(z); };
    // 留一組交叉驗證：每次拿掉一個 group 訓練，預測被拿掉的那組；回傳全部預測與彙整
    function crossValidate(data, opts, threshold) {
        threshold = threshold == null ? 0.5 : threshold; const groups = Array.from(new Set(data.map((r) => r.group))); const preds = [];
        for (const g of groups) { const train = data.filter((r) => r.group !== g); const test = data.filter((r) => r.group === g); const m = fit(train, opts); for (const r of test) preds.push({ group: g, id: r.id, y: r.y, p: predictOne(m, r.x) }); }
        return Object.assign({ preds }, evaluate(preds, threshold));
    }
    function evaluate(preds, threshold) {
        threshold = threshold == null ? 0.5 : threshold; let tp = 0, fp = 0, fn = 0, tn = 0; for (const r of preds) { const v = r.p >= threshold; if (v && r.y) tp++; else if (v && !r.y) fp++; else if (!v && r.y) fn++; else tn++; }
        const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null); const P = tp / (tp + fp || 1), R = tp / (tp + fn || 1); const groups = Array.from(new Set(preds.map((r) => r.group)));
        const top = (k) => groups.filter((g) => preds.filter((r) => r.group === g).sort((a, b) => b.p - a.p).slice(0, k).some((r) => r.y)).length;
        return { precision: pct(tp, tp + fp), recall: pct(tp, tp + fn), f1: Math.round((2 * P * R / ((P + R) || 1)) * 1000) / 10, top1: top(1) + '/' + groups.length, top3: top(3) + '/' + groups.length, n: preds.length, positives: preds.filter((r) => r.y).length };
    }
    // 一次做完：留一組交叉驗證（用不同強度的正則化各試一次、挑 F1 最好的）＋用全部資料訓練最後的模型
    function trainReport(rows, opts) {
        opts = Object.assign({ l2s: [0.05, 0.5, 2], threshold: 0.5 }, opts || {}); const tries = opts.l2s.map((l2) => { const cv = crossValidate(rows, Object.assign({}, opts, { l2 }), opts.threshold); return { l2, precision: cv.precision, recall: cv.recall, f1: cv.f1, top1: cv.top1, top3: cv.top3 }; }); const best = tries.slice().sort((a, b) => b.f1 - a.f1)[0];
        return { n: rows.length, positives: rows.filter((r) => r.y === 1).length, groups: new Set(rows.map((r) => r.group)).size, tries, best, model: fit(rows, Object.assign({}, opts, { l2: best.l2 })) };
    }
    return { fit, predict: predictOne, crossValidate, evaluate, trainReport };
});
