// 自動產生：由 build-assistant.js 從 renderer/src/recipe/judge_core.js 複製，請改原檔。
/* 判題核心（純函式，UMD，不碰 I/O）：題目格式驗證、輸出比對、多筆測試彙整成一個判決。設計見 DESIGN.fn-template.md。
 * 實際編譯／執行各語言在 desktop-app/judge-runner.js（需要 child_process，只能在 Node／Electron 主程序）。
 *   validateProblem(p)            → {ok, errors[]}；測試是 stdin→stdout（ACM 風格），每筆 {in, out}；hidden 是不給模型看的驗收用測試
 *   compare(actual, expected, checker, opts) → {ok, reason?}
 *       checker：lines（逐行去行尾空白、忽略結尾空行）／tokens（空白不敏感，預設）／float（數字容許誤差 opts.eps，其餘字串須相等）
 *               ／unordered-lines／unordered-tokens（順序不拘，多重集合相等）
 *   summarize(results, opts)      → {verdict, passed, total, visible:{passed,total}, hidden:{passed,total}, failedIndex, detail, maxMs}
 * 判決：AC 全過；WA 答案錯；TLE 逾時；RE 執行錯誤（非 0 結束碼或被訊號終止）；OLE 輸出超過上限；CE 編譯失敗；UNAVAILABLE 這台機器沒有該語言的工具鏈（不算失敗，也不算通過）。
 * 多筆測試有不同錯誤時，取最先出錯的那一筆的判決。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaJudgeCore = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const CHECKERS = ['lines', 'tokens', 'float', 'unordered-lines', 'unordered-tokens'];
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…(+' + (s.length - n) + ')' : s; };

    function validateProblem(p) {
        const errors = [];
        if (!p || typeof p !== 'object') return { ok: false, errors: ['題目不是物件'] };
        if (typeof p.id !== 'string' || !/^[\w.-]+$/.test(p.id)) errors.push('id 要是英數、底線、點、連字號的字串');
        if (p.checker != null && CHECKERS.indexOf(p.checker) < 0) errors.push('checker 不認得：' + p.checker);
        const chk = (list, name, required) => {
            if (list == null) { if (required) errors.push(name + ' 至少要一筆'); return; }
            if (!Array.isArray(list) || (required && !list.length)) { errors.push(name + ' 要是陣列' + (required ? '且至少一筆' : '')); return; }
            list.forEach((t, i) => { if (!t || typeof t.in !== 'string' || typeof t.out !== 'string') errors.push(name + '[' + i + '] 要有字串 in 與 out'); });
        };
        chk(p.tests, 'tests', true); chk(p.hidden, 'hidden', false);
        return { ok: !errors.length, errors };
    }

    const lines = (s) => { const a = String(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')); while (a.length && a[a.length - 1] === '') a.pop(); return a; };
    const tokens = (s) => String(s).split(/\s+/).filter(Boolean);
    const multisetEq = (a, b) => { if (a.length !== b.length) return false; const x = a.slice().sort(), y = b.slice().sort(); return x.every((v, i) => v === y[i]); };
    const isNum = (s) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s);

    function compare(actual, expected, checker, opts) {
        const kind = checker || 'tokens'; const eps = opts && opts.eps != null ? opts.eps : 1e-6;
        let a, b;
        if (kind === 'lines') {
            a = lines(actual); b = lines(expected);
            if (a.length !== b.length) return { ok: false, reason: '行數不同：' + a.length + ' vs 期望 ' + b.length };
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { ok: false, reason: '第 ' + (i + 1) + ' 行不同：' + clip(a[i], 60) + ' vs 期望 ' + clip(b[i], 60) };
            return { ok: true };
        }
        if (kind === 'unordered-lines') { a = lines(actual); b = lines(expected); return multisetEq(a, b) ? { ok: true } : { ok: false, reason: '行的集合不同（順序不拘）' }; }
        a = tokens(actual); b = tokens(expected);
        if (kind === 'unordered-tokens') return multisetEq(a, b) ? { ok: true } : { ok: false, reason: '詞的集合不同（順序不拘）' };
        if (a.length !== b.length) return { ok: false, reason: '詞數不同：' + a.length + ' vs 期望 ' + b.length };
        for (let i = 0; i < a.length; i++) {
            if (a[i] === b[i]) continue;
            if (kind === 'float' && isNum(a[i]) && isNum(b[i])) { const x = Number(a[i]), y = Number(b[i]); if (Math.abs(x - y) <= eps * Math.max(1, Math.abs(y))) continue; }
            return { ok: false, reason: '第 ' + (i + 1) + ' 個詞不同：' + clip(a[i], 40) + ' vs 期望 ' + clip(b[i], 40) };
        }
        return { ok: true };
    }

    // results：[{hidden?:bool, verdict:'AC'|'WA'|'TLE'|'RE'|'OLE'|'CE'|'UNAVAILABLE', ms?, detail?}]，順序＝測試順序（先 tests 後 hidden）
    function summarize(results, opts) {
        const list = Array.isArray(results) ? results : [];
        const vis = { passed: 0, total: 0 }, hid = { passed: 0, total: 0 };
        let first = -1, maxMs = 0;
        list.forEach((r, i) => {
            const g = r.hidden ? hid : vis; g.total++;
            if (r.verdict === 'AC') g.passed++; else if (first < 0) first = i;
            if (r.ms > maxMs) maxMs = r.ms;
        });
        const total = list.length, passed = vis.passed + hid.passed;
        const verdict = !total ? 'UNAVAILABLE' : first < 0 ? 'AC' : list[first].verdict;
        const detail = first < 0 ? '' : clip((list[first].hidden ? '[hidden] ' : '') + '#' + (first + 1) + ' ' + (list[first].detail || ''), (opts && opts.maxDetail) || 300);
        return { verdict, passed, total, visible: vis, hidden: hid, failedIndex: first, detail, maxMs };
    }

    return { CHECKERS, validateProblem, compare, summarize };
});
