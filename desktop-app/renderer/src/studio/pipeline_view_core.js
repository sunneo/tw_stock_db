'use strict';
/* 流程總覽的畫面產生器（純函式，回 HTML 字串；所有外部字串都先跳脫）。設計見 DESIGN.TODO.offline-training-studio.md §19。
 *   renderPipelineHTML(view, advice)  view＝GET /api/pipeline 的回傳；advice＝GET /api/advice 的回傳（可省）
 * 規則：資料沒有就寫「無資料」（附缺什麼）；功能沒做就寫「尚未實作」（附阻礙），不假裝可用。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioPipelineView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const NA = (why) => '<span class="na">無資料' + (why ? '（' + esc(why) + '）' : '') + '</span>';
    const NOT_IMPL = (why) => '<span class="unimpl">尚未實作' + (why ? '：' + esc(why) : '') + '</span>';
    const STATE_CLASS = { '待做': 'todo', '進行中': 'run', '完成': 'done', '失敗': 'fail', '略過': 'skip' };

    function fmtSec(sec) {
        if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
        const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        const pad = (x) => (x < 10 ? '0' + x : String(x));
        return h ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r);
    }
    function fmtBytes(b) {
        if (b === null || b === undefined || !Number.isFinite(b)) return null;
        const units = ['位元組', 'KB', 'MB', 'GB']; let x = b, i = 0;
        while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
        return (i === 0 ? String(Math.round(x)) : x.toFixed(1)) + ' ' + units[i];
    }
    const num = (x) => (Number.isFinite(x) ? String(x) : null);

    function stageCard(s) {
        const cls = STATE_CLASS[s.state] || 'todo';
        const parts = [];
        if (s.unimplemented) parts.push(NOT_IMPL(s.reason));
        else if (s.reason) parts.push('<div class="why">' + esc(s.reason) + '</div>');
        if (s.products && s.products.length) {
            const p = s.products[0];
            parts.push('<div class="prod">產物：' + esc(p.count) + ' 筆・' + esc(p.files) + ' 個檔案・sha256 ' + esc(p.sha256 || '') + '</div>');
        }
        const el = fmtSec(s.elapsedMs === null || s.elapsedMs === undefined ? null : s.elapsedMs / 1000);
        if (el) parts.push('<div class="el">耗時 ' + esc(el) + '</div>');
        if (s.lookup && s.state === '略過') parts.push('<div class="why">' + esc(s.note || '') + '</div>');
        return '<div class="stg st-' + cls + (s.unimplemented ? ' unimpl' : '') + '" data-stage="' + esc(s.id) + '">' +
            '<div class="hd"><span class="nm">' + esc(s.label) + '</span><span class="badge b-' + cls + '">' + esc(s.state) + '</span></div>' + parts.join('') + '</div>';
    }

    function liveBlock(view) {
        const L = view.live, memTxt = fmtBytes(view.memory && view.memory.lastBytes);
        if (!L) return '<div class="live">' + NA('沒有訓練紀錄：請指定訓練資料夾（run）') + '</div>';
        const pct = L.pct;
        const bar = pct === null || pct === undefined ? '' : '<div class="bar"><span style="width:' + Math.max(0, Math.min(100, pct)) + '%"></span></div>';
        const row = (k, v) => '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + (v === null || v === undefined || v === '' ? NA() : v) + '</span></div>';
        const stepTxt = L.step !== null && L.total !== null ? esc(L.step) + ' / ' + esc(L.total) + '（' + esc(pct) + '%）' : null;
        const lossTxt = L.loss !== null ? esc(L.loss) + (L.lossFirst !== null ? '（第一次 ' + esc(L.lossFirst) + '）' : '') : null;
        const secTxt = L.secPerStep !== null ? esc(Number(L.secPerStep).toFixed(2)) + ' 秒／步（' + esc(L.secSource) + '）' : null;
        const etaTxt = fmtSec(L.etaSec) ? fmtSec(L.etaSec) + '（估）' : null;
        const memRow = memTxt ? row('記憶體（子行程 RSS）', esc(memTxt) + '，峰值 ' + esc(fmtBytes(view.memory.peakBytes))) : row('記憶體', NA(view.memoryReason || '沒有取樣'));
        const errTxt = L.logState === '失敗' && L.errorText ? '<div class="err">' + esc(L.errorText) + '</div>' : '';
        return '<div class="live"><div class="ls">日誌狀態：' + esc(L.logState) + '</div>' + bar +
            row('步數', stepTxt) + row('loss', lossTxt) + row('每步耗時', secTxt) + row('預估剩餘', etaTxt) + row('已經過', fmtSec(L.elapsedSec)) + memRow + errTxt + '</div>';
    }

    function exportBlock(view) {
        const x = view.export; if (!x) return '';
        const opts = (x.options || []).map((o) => '<tr><td>' + esc(o.format.toUpperCase()) + '</td><td>' + esc(o.quant) + '</td><td>' +
            (o.available ? '可用' : NOT_IMPL(o.reason)) + '</td></tr>').join('');
        const head = x.default ? '預設格式：' + esc(x.default.toUpperCase()) + '（' + esc(x.quant) + '，' + (x.env === 'web' ? '網頁' : '桌面本機') + '）' : NOT_IMPL(x.reason);
        return '<div class="export"><div class="ls">匯出格式</div><div>' + head + '</div><table><tr><th>格式</th><th>量化</th><th>狀態</th></tr>' + opts + '</table></div>';
    }

    function adviceBlock(advice) {
        if (!advice) return '<div class="advice">' + NA('還沒有評量輸出；在「評量」跑完後再來看') + '</div>';
        if (advice.ok === false) return '<div class="advice">' + '<span class="err">' + esc(advice.error || '建議失敗') + '</span></div>';
        const sug = advice.suggestions || [], ins = advice.insufficient || [];
        const items = sug.map((s) => '<li class="sg sev-' + esc(s.severity) + '"><div class="tx">' + esc(s.text) + '</div>' +
            '<div class="ev">依據：' + esc(s.evidence && s.evidence.source) + '</div>' +
            '<button class="act" data-action="' + esc(s.action) + '" data-target="' + esc(s.name) + '" title="' + esc(s.actionHint) + '">' + esc(s.actionLabel) + '</button></li>').join('');
        const missing = ins.map((i) => '<li class="na">' + esc(i.name) + '：' + (i.rule === 'position-bias' ? '無資料（' + esc(i.reason) + '）' : esc(i.reason)) + '</li>').join('');
        return '<div class="advice">' + (sug.length ? '<ul>' + items + '</ul>' : '<div class="ok">目前沒有需要加強的項目（依現有的評量門檻）。</div>') +
            (ins.length ? '<div class="ls">證據不足，暫不建議</div><ul>' + missing + '</ul>' : '') + '</div>';
    }

    function renderPipelineHTML(view, advice) {
        if (!view || view.ok === false) return '<div class="err">' + esc((view && view.error) || '流程總覽讀取失敗') + '</div>';
        const stages = (view.stages || []).map(stageCard).join('<div class="arrow">→</div>');
        const src = view.source || {};
        const srcTxt = '資料來源：' + (src.manifest ? '資產 ' + esc(src.asset) : NA('沒有資產')) + '・訓練紀錄 ' + (src.log ? '已讀取 ' + esc(src.runDir) : NA('沒有 train.log'));
        return '<div class="pipe"><div class="ttl">' + esc(view.label) + ' 流程</div><div class="src">' + srcTxt + '</div>' +
            '<div class="flow">' + stages + '</div>' +
            '<h4>即時狀態</h4>' + liveBlock(view) +
            exportBlock(view) +
            '<h4>下一次該加強什麼</h4>' + adviceBlock(advice) + '</div>';
    }

    return { esc, fmtSec, fmtBytes, renderPipelineHTML, stageCard, liveBlock, adviceBlock, exportBlock };
}));
