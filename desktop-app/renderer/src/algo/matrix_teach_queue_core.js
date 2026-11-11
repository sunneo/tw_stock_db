/* 待補教學佇列的寫檔與摘要（DESIGN.matrix-fallback.md §13 teach_queue 接線）。
 * 建在 matrix_spec_core 的 teachEntry／parseQueue／mergeQueue／queueText 之上，這裡只加：
 *   ① 寫檔：透過注入的 io（read(path)→字串或 null、write(path,text)）讀寫整份 JSONL；寫入先寫暫存檔再換名，避免寫到一半斷電留下半個檔；
 *   ② add／remove／list／clear：同一題重複加入只計次數（mergeQueue 的規則）；壞行略過，不丟掉其他行；
 *   ③ summary：各卡點數量與最常出現的題目，給介面顯示用的文字行（繁體中文）。
 * 不做：視窗、按鈕與產品端呼叫（那是宿主的事，這台沒有 Electron 視窗，驗不了）；不做「補完輸出後自動重跑」。
 * 純函式（UMD）。Node 版 io 見 nodeFsIO。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_spec_core.js'));
    else root.FaMatrixTeachQueue = factory(root.FaMatrixSpec);
})(typeof self !== 'undefined' ? self : this, function (S) {
    'use strict';

    const STAGE_LABEL = { reader: '讀取器讀不出輸入形狀', matrix: '矩陣層沒有符合的範本', paradigm: '範式骨架沒有符合的課' };

    function create(io, path) {
        const load = () => S.parseQueue(io.read(path) || '');
        const save = (entries) => io.write(path, S.queueText(entries));
        return {
            path,
            list: load,
            add(e) { const entries = load(); const merged = S.mergeQueue(entries, e); save(merged); return merged; },
            remove(id) { const entries = load(); const kept = entries.filter((e) => (e.id || S.hash(e.statement)) !== id); save(kept); return entries.length - kept.length; },
            clear() { save([]); },
            summary() { return summarize(load()); },
        };
    }

    function summarize(entries) {
        const byStage = {}; let needEx = 0;
        for (const e of entries) {
            const k = e.stuckAt || 'unknown'; byStage[k] = (byStage[k] || 0) + 1;
            if (!(e.examples || []).length) needEx++;
        }
        const top = entries.slice().sort((a, b) => (b.count || 1) - (a.count || 1)).slice(0, 5).map((e) => ({ id: e.id, statement: e.statement, count: e.count || 1 }));
        const lines = [];
        lines.push('待補教學：' + entries.length + ' 題' + (needEx ? '（其中 ' + needEx + ' 題還沒有範例）' : ''));
        for (const [k, n] of Object.entries(byStage)) lines.push('  ' + (STAGE_LABEL[k] || k) + '：' + n + ' 題');
        for (const t of top) lines.push('  出現 ' + t.count + ' 次：' + t.statement.slice(0, 60));
        return { total: entries.length, byStage, needExamples: needEx, top, lines };
    }

    // Node 版 io：暫存檔＋換名（同一目錄 rename 在同一檔案系統上是原子的）
    function nodeFsIO(fs, pathMod) {
        return {
            read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
            write(p, text) { const tmp = p + '.tmp-' + process.pid; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, p); },
        };
    }

    // 純函式版（給宿主的同步或非同步 io 用）：整份 JSONL 文字＋一筆新紀錄 → 合併後的文字、筆數與摘要。
    // 產品端 floating-assistant 的 _teachQueueRecord 用這個：讀與寫都由宿主負責（rawfs 是非同步的），這裡只做合併規則。
    function mergeText(text, entry) {
        const merged = S.mergeQueue(S.parseQueue(text || ''), entry);
        return { text: S.queueText(merged), entries: merged, count: merged.length, summary: summarize(merged) };
    }

    return { create, summarize, mergeText, nodeFsIO, STAGE_LABEL };
});
