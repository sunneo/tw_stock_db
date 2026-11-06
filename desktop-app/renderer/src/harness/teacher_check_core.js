/* 老師迴圈的「客觀驗證」：/offline-trainer-by-ai（別名 /teacher-loop）的項目可以帶一個 check，離線做出來的結果要通過它才算「離線自己做對」。
 * 純函式 UMD，領域中立。
 *   normalize(raw) → {ok, check?, error?}      檢查規格的整理與限制（種類、大小）
 *   checkSync(check, text) → {ok, detail}       不需要執行環境的檢查：contains／notcontains／regex／equals
 *   isJudge(check) → boolean                    需要判題器的檢查（寫程式的任務：把程式碼交給判題器跑測資）
 *   extractCode(text) → string                  從離線結果（工具的 JSON、```圍欄```、或純程式碼）抽出程式碼
 *   judgeProblem(check, id) → problem           判題器的 problem 形狀
 *   summary(check) → 字串                        給進度卡片看
 * check 的形狀：{kind:'contains'|'notcontains'|'regex'|'equals', value} 或 {kind:'judge', lang?, tests:[{in,out}], hidden?:[{in,out}], checker?, entry?:'main'} */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaTeacherCheck = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const KINDS = ['contains', 'notcontains', 'regex', 'equals', 'judge']; const CHECKERS = ['lines', 'tokens', 'float', 'unordered-lines', 'unordered-tokens'];
    const LANGS = ['python', 'nodejs', 'c', 'cpp', 'java', 'ruby', 'perl', 'bash', 'asm-x64', 'asm-x86', 'csharp'];
    const cleanTests = (list) => { if (!Array.isArray(list)) return []; return list.filter((t) => t && typeof t.in === 'string' && typeof t.out === 'string' && t.in.length <= 262144 && t.out.length <= 262144).slice(0, 60).map((t) => ({ in: t.in, out: t.out })); };
    function normalize(raw) {
        if (raw == null) return { ok: true, check: null };
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { return { ok: false, error: 'check 要是 JSON 物件' }; } }
        if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return { ok: false, error: 'check.kind 要是：' + KINDS.join('、') };
        if (raw.kind === 'judge') {
            const tests = cleanTests(raw.tests); if (!tests.length) return { ok: false, error: 'judge 檢查至少要一筆 tests（{in,out}）' };
            const lang = LANGS.includes(raw.lang) ? raw.lang : 'python'; return { ok: true, check: { kind: 'judge', lang, tests, hidden: cleanTests(raw.hidden), checker: CHECKERS.includes(raw.checker) ? raw.checker : 'tokens', entry: raw.entry === 'main' ? 'main' : undefined } };
        }
        const value = String(raw.value == null ? '' : raw.value).slice(0, 4000); if (raw.kind === 'regex') { try { new RegExp(value); } catch (_) { return { ok: false, error: 'regex 不合法' }; } }
        if (!value && raw.kind !== 'equals') return { ok: false, error: raw.kind + ' 要有 value' }; return { ok: true, check: { kind: raw.kind, value } };
    }
    const isJudge = (c) => !!c && c.kind === 'judge';
    function checkSync(check, text) {
        const t = String(text == null ? '' : text); if (!check) return { ok: true, detail: '沒有檢查' };
        switch (check.kind) {
            case 'contains': return t.includes(check.value) ? { ok: true } : { ok: false, detail: '結果裡沒有「' + check.value.slice(0, 40) + '」' };
            case 'notcontains': return !t.includes(check.value) ? { ok: true } : { ok: false, detail: '結果裡不該出現「' + check.value.slice(0, 40) + '」' };
            case 'regex': return new RegExp(check.value).test(t) ? { ok: true } : { ok: false, detail: '結果不符合 /' + check.value.slice(0, 40) + '/' };
            case 'equals': return t.trim() === String(check.value).trim() ? { ok: true } : { ok: false, detail: '結果跟期望的不一樣（期望「' + String(check.value).slice(0, 40) + '」）' };
            default: return { ok: false, detail: '這種檢查需要執行環境（' + check.kind + '）' };
        }
    }
    function extractCode(text) {
        const t = String(text == null ? '' : text);
        try { const j = JSON.parse(t); const v = j && (j.source || j.code || j.python || (j.result && (j.result.source || j.result.code))); if (typeof v === 'string' && v.trim()) return v; } catch (_) { /* 不是 JSON */ }
        const fences = [...t.matchAll(/```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)```/g)]; if (fences.length) return fences[fences.length - 1][1];
        return t;
    }
    const judgeProblem = (check, id) => ({ id: String(id || 'task').replace(/[^\w.-]/g, '_').slice(0, 60) || 'task', tests: check.tests, hidden: check.hidden || [], checker: check.checker || 'tokens' });
    const summary = (c) => (!c ? '' : c.kind === 'judge' ? '判題器 ' + c.lang + '（' + c.tests.length + ' 筆' + (c.hidden && c.hidden.length ? '＋隱藏 ' + c.hidden.length + ' 筆' : '') + '）' : c.kind + ' ' + String(c.value).slice(0, 30));
    return { normalize, checkSync, isJudge, extractCode, judgeProblem, summary, KINDS };
});
