/* blockly 與 matrix 混用的接點（DESIGN.matrix-fallback.md §13.6）。
 * 位置：blockly（UML→骨架→區塊）整條管線失敗之後，才交給矩陣層（FaMatrixSynth）再試一次。
 * 規則：矩陣層的答案只有「用隱藏測資（獨立判題）判過、而且不是多候選」才採用；否則回傳原因，讓上層往下一層（弱模型或 LoRA）。
 * 純函式（UMD）：synth 與 judge 由呼叫端注入，所以這裡不依賴產品頁面，可以用真的 FaMatrixSynth 測。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixHybrid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // tryMatrix({statement, examples, judge, synth, budget}) → Promise<{ok, source?, by?, level?, desc?, reason}>
    //   examples：可見測資 [{in,out}]，只拿來合成；judge(src)：必須用隱藏測資判題，回 {verdict}。
    async function tryMatrix(o) {
        const synth = o && o.synth; const examples = (o && o.examples) || [];
        if (typeof synth !== 'function') return { ok: false, reason: '沒有矩陣層（synth 未注入）' };
        if (!examples.length) return { ok: false, reason: '沒有可見測資可以合成' };
        if (typeof o.judge !== 'function') return { ok: false, reason: '沒有獨立判題器，不採用矩陣層答案' };
        let r;
        try { r = await synth({ statement: String(o.statement || ''), examples, judge: o.judge, budget: o.budget || { candidates: 20000 } }); }
        catch (e) { return { ok: false, reason: '矩陣層出錯：' + String((e && e.message) || e) }; }
        if (!r || !r.ok) return { ok: false, reason: '矩陣層沒有合成：' + String((r && r.reason) || '').slice(0, 160) };
        if (r.verdict !== 'AC') return { ok: false, reason: '矩陣層答案未通過獨立判題（' + (r.verdict || '無判題') + '）' };
        if (r.ambiguous) return { ok: false, reason: '矩陣層答案有多個候選，範例不足以唯一決定，不採用' };
        if (!r.verified) return { ok: false, reason: '矩陣層答案沒有標記為已驗證' };
        return { ok: true, by: 'matrix', source: r.source, kind: r.kind || null, level: r.level || null, desc: r.desc || null, reason: '' };
    }

    return { tryMatrix };
});
