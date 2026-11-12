'use strict';
/* 流程總覽：訓練進行中的即時狀態（純函式，不碰檔案、程序或時鐘；時間與記憶體取樣由呼叫端傳入）。設計見 DESIGN.TODO.offline-training-studio.md §18。
 *   liveProgress(events, opts)  events＝backend_cpu_py.parseProgressLine 逐行解析出的事件（type：progress｜log｜eval｜paused｜done｜error）
 *                               opts：{ nowMs, startedMs, running, memSamples:[{ t, rssBytes }] }
 *   progressToFacts(live)       → pipeline_core.deriveStageStates 用的 facts 片段（running、failed、logDone、progress）
 * 原則：只把日誌與取樣轉成數字，不宣稱完成；「完成」仍以產物與 done 標記為準（logDone 只代表日誌寫了 [done]）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioLive = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const finite = (x) => typeof x === 'number' && Number.isFinite(x);

    function liveProgress(events, opts) {
        const o = opts || {}, list = Array.isArray(events) ? events.filter((e) => e && typeof e.type === 'string') : [];
        const lastOf = (t) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].type === t) return list[i]; return null; };
        const prog = lastOf('progress'), logLast = lastOf('log'), evalLast = lastOf('eval');
        const lastIdx = (t) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].type === t) return i; return -1; };
        const term = [['error', lastIdx('error')], ['done', lastIdx('done')], ['paused', lastIdx('paused')]].sort((a, b) => b[1] - a[1])[0];
        const ended = term && term[1] >= 0 ? term[0] : null;
        // 狀態只看日誌的終止事件（最後一個）；沒有終止事件時，有事件或呼叫端說在跑 → 進行中
        let logState;
        if (ended === 'error') logState = '失敗';
        else if (ended === 'done') logState = '完成';
        else if (ended === 'paused') logState = '暫停';
        else if (list.length || o.running) logState = '進行中';
        else logState = '待做';
        const step = prog && finite(prog.step) ? prog.step : null, total = prog && finite(prog.total) ? prog.total : null;
        const pct = step !== null && total ? Math.min(100, Math.round((step / total) * 1000) / 10) : null;
        // 每步秒數：優先用日誌裡 tqdm 印的 s/it；沒有才用起始時間與目前步數推算（需要呼叫端給時間）
        let secPerStep = null, secSource = '';
        if (prog && finite(prog.secPerIt)) { secPerStep = prog.secPerIt; secSource = '日誌 tqdm 的 s/it'; }
        else if (finite(o.startedMs) && finite(o.nowMs) && step) { secPerStep = (o.nowMs - o.startedMs) / 1000 / step; secSource = '起始時間推算'; }
        const eta = secPerStep !== null && step !== null && total !== null && total >= step ? Math.round((total - step) * secPerStep) : null;
        const elapsedSec = finite(o.startedMs) && finite(o.nowMs) ? Math.round((o.nowMs - o.startedMs) / 1000) : null;
        // 記憶體：只用呼叫端的真實取樣；沒有取樣就說沒有
        const ms = Array.isArray(o.memSamples) ? o.memSamples.filter((m) => m && finite(m.rssBytes)) : [];
        const memory = ms.length ? { lastBytes: ms[ms.length - 1].rssBytes, peakBytes: Math.max.apply(null, ms.map((m) => m.rssBytes)), samples: ms.length } : null;
        const losses = list.filter((e) => e.type === 'log' && finite(e.loss)).map((e) => e.loss);
        return {
            logState, step, total, pct, secPerStep, secSource: secSource || null, etaSec: eta, elapsedSec,
            loss: logLast && finite(logLast.loss) ? logLast.loss : null, lossFirst: losses.length ? losses[0] : null, lossSamples: losses.length,
            evalLoss: evalLast && finite(evalLast.evalLoss) ? evalLast.evalLoss : null,
            memory, memoryReason: memory ? '' : '沒有記憶體取樣（呼叫端未提供）',
            errorText: ended === 'error' ? String(list[term[1]].text || '') : null,
            doneDir: ended === 'done' ? String(list[term[1]].dir || '') : null,
            events: list.length
        };
    }

    // 轉成 pipeline_core 的 facts 片段：進行中→running；錯誤→failed；暫停→running=false 並附原因（不算完成）
    function progressToFacts(live) {
        const L = live || {};
        const f = { running: L.logState === '進行中', logDone: L.logState === '完成', progress: L };
        if (L.logState === '失敗') f.failed = L.errorText || '日誌有錯誤，沒有寫明原因';
        if (L.logState === '暫停') f.pausedReason = '訓練暫停中（日誌最後一步：' + (L.step === null ? '未知' : L.step) + '）';
        return f;
    }

    return { liveProgress, progressToFacts };
}));
