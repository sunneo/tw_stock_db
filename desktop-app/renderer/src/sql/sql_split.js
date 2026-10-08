/* SQL 語句切分與完整性判斷（純函式，UMD）。
 * sqlite3 命令列用 sqlite3_complete() 判斷一段輸入「語句結束了沒」、並把一長串 SQL 切成一句一句送進引擎；
 * node:sqlite／sql.js 沒有這個函式，所以自己寫：分號只在「字串、引號識別字、註解、CREATE TRIGGER 的 BEGIN…END」之外才算語句結尾。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaSqlSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // 掃描器：回傳 { stmts:[{sql, start, end}], rest, complete }；rest＝最後沒有以分號結尾的殘餘文字
    function scan(text) {
        text = String(text); const stmts = []; let start = 0, i = 0; const n = text.length;
        let depth = 0;         // CREATE TRIGGER ... BEGIN ... END; 裡的分號不算結尾
        let caseDepth = 0;     // CASE ... END 的 END 不是觸發器的 END
        let inTrigger = false, seenBeginInTrigger = false, firstWord = '', secondWord = '', words = 0, lastWord = '';
        const flush = (endIdx) => { const sql = text.slice(start, endIdx); if (sql.trim() && !/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*$/.test(sql)) stmts.push({ sql, start, end: endIdx }); start = endIdx; firstWord = secondWord = lastWord = ''; words = 0; inTrigger = false; seenBeginInTrigger = false; depth = 0; caseDepth = 0; };
        while (i < n) {
            const c = text[i];
            if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < n) { if (text[i] === q) { if (text[i + 1] === q) { i += 2; continue; } break; } i++; } if (i >= n) return { stmts, rest: text.slice(start), complete: false, open: 'quote' }; i++; lastWord = ''; continue; }
            if (c === '[') { const j = text.indexOf(']', i + 1); if (j < 0) return { stmts, rest: text.slice(start), complete: false, open: 'bracket' }; i = j + 1; lastWord = ''; continue; }
            if (c === '-' && text[i + 1] === '-') { const j = text.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
            if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) return { stmts, rest: text.slice(start), complete: false, open: 'comment' }; i = j + 2; continue; }
            if (/[A-Za-z_]/.test(c)) {
                let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++; const w = text.slice(i, j).toUpperCase(); words++;
                if (words === 1) firstWord = w; else if (words === 2) secondWord = w;
                // CREATE [TEMP|TEMPORARY] TRIGGER：看前三個字
                if (words <= 3 && firstWord === 'CREATE' && (w === 'TRIGGER')) inTrigger = true;
                if (inTrigger) { if (w === 'BEGIN') { seenBeginInTrigger = true; depth = 1; } else if (seenBeginInTrigger) { if (w === 'CASE') caseDepth++; else if (w === 'END') { if (caseDepth > 0) caseDepth--; else depth = 0; } } }
                lastWord = w; i = j; continue;
            }
            if (c === ';') {
                if (inTrigger && seenBeginInTrigger && depth > 0) { i++; continue; }
                i++; flush(i); continue;
            }
            i++;
        }
        const rest = text.slice(start); const trimmed = rest.replace(/(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/g, '');
        return { stmts, rest, complete: trimmed === '' && !(inTrigger && seenBeginInTrigger && depth > 0), open: inTrigger && seenBeginInTrigger && depth > 0 ? 'trigger' : null };
    }
    const split = (text) => { const r = scan(text); const out = r.stmts.map((s) => s.sql.trim()); if (r.rest.trim() && !/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*$/.test(r.rest)) out.push(r.rest.trim()); return out; };
    // 沒有「還在等下文」的東西：每句都以分號收尾（空白與註解不算），而且不在字串／觸發器中間（空白或只有註解也算完整＝沒東西要送）
    const isComplete = (text) => scan(text).complete;
    return { scan, split, isComplete };
});
