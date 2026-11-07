/* 程式優化：從程式看出「慢的寫法」（題型）→ 對照優化表換成同功能、更有效率的寫法 → 沙盒驗證輸出一致且不變慢才替換。純函式 UMD，Python 專屬，不問模型。
 *   RULES：優化對照表。每條 {id, name, before, after, memory, detect(src) → 參數|null, rewrite(src, 參數) → 新程式|null}。
 *   detect 只看「這個程式裡有沒有那個慢寫法、而且換掉是安全的」（例如 list 只被拿來 in／append／len，才能換成 set）；認不出就不動。
 *   optimize({source, run, inputs, bigInput?}) → { ok, source, applied:[{id,name,before,after,memory,speedup?}], skipped:[{id,reason}], notes }
 *       run(src, input) → Promise<{out, ms, ok}>：呼叫端提供的執行器（沙盒）。每條規則套完後，要在 inputs（範例＋隨機輸入）上輸出與「目前版本」相同才收；
 *       有 bigInput 時量時間，比原本慢超過 20% 就退回（只換對照表上「應該更快」的，實際沒更快就不留）。
 * 誠實限制：「輸出一致」只是在給的輸入上一致，不是證明等價；回報裡一定寫出驗證了幾組輸入、有沒有量時間。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaCodeOptimize = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lines = (s) => String(s).replace(/\n+$/, '').split('\n');
    const ind = (l) => /^ */.exec(l)[0].length;
    const addImport = (src, imp) => (new RegExp('^' + esc(imp) + '$', 'm').test(src) ? src : imp + '\n' + src);
    const uses = (src, name) => [...src.matchAll(new RegExp('(?<![\\w.])' + esc(name) + '(?!\\w)', 'g'))].length;
    // ---- 1. list 當集合用（in＋append）→ set ----
    const listAsSet = {
        id: 'list-as-set', name: '用 list 做「出現過沒」→ 改用 set', before: 'O(n²)（每次 in 掃整個 list）', after: 'O(n)（set 查詢 O(1)）', memory: '多一份雜湊表，同階',
        detect(src) { const out = []; for (const m of src.matchAll(/^([ \t]*)([A-Za-z_]\w*)\s*=\s*\[\s*\]\s*$/gm)) { const v = m[2]; const body = src.slice(m.index + m[0].length); const tot = uses(src, v); const ok = uses(src.replace(new RegExp('(?<![\\w.])' + esc(v) + '\\s*=\\s*\\[\\s*\\]', 'g'), ''), v); const a = (body.match(new RegExp('(?<![\\w.])' + esc(v) + '\\.append\\(', 'g')) || []).length, i = (body.match(new RegExp('\\bin\\s+' + esc(v) + '(?!\\w)', 'g')) || []).length, l = (body.match(new RegExp('len\\(' + esc(v) + '\\)', 'g')) || []).length; if (a && i && a + i + l === ok && tot >= 1) out.push(v); } return out.length ? { vars: out } : null; },
        rewrite(src, p) { let s = src; for (const v of p.vars) s = s.replace(new RegExp('^([ \\t]*)' + esc(v) + '\\s*=\\s*\\[\\s*\\]\\s*$', 'm'), '$1' + v + ' = set()').replace(new RegExp('(?<![\\w.])' + esc(v) + '\\.append\\(', 'g'), v + '.add('); return s; },
    };
    // ---- 2. list.pop(0) 當佇列 → deque ----
    const queuePop = {
        id: 'queue-popleft', name: 'list.pop(0) 當佇列 → deque.popleft()', before: 'O(n²)（pop(0) 每次搬整個 list）', after: 'O(n)', memory: '同階',
        detect(src) { const out = []; for (const m of src.matchAll(/(?<![\w.])([A-Za-z_]\w*)\.pop\(\s*0\s*\)/g)) { const v = m[1]; if (out.includes(v)) continue; if (new RegExp('(?<![\\w.])' + esc(v) + '\\[').test(src)) continue; if (new RegExp('(?<![\\w.])' + esc(v) + '\\.(?:sort|reverse|insert|remove|index|extend\\b)').test(src)) continue; if (!new RegExp('^[ \\t]*' + esc(v) + '\\s*=\\s*(?:\\[.*\\]|list\\(.*\\))\\s*$', 'm').test(src)) continue; out.push(v); } return out.length ? { vars: out } : null; },
        rewrite(src, p) { let s = addImport(src, 'from collections import deque'); for (const v of p.vars) s = s.replace(new RegExp('^([ \\t]*' + esc(v) + '\\s*=\\s*)(\\[.*\\]|list\\(.*\\))\\s*$', 'm'), '$1deque($2)').replace(new RegExp('(?<![\\w.])' + esc(v) + '\\.pop\\(\\s*0\\s*\\)', 'g'), v + '.popleft()'); return s; },
    };
    // ---- 3. 重複算的遞迴 → lru_cache ----
    const memoRec = {
        id: 'recursion-memo', name: '重複計算的遞迴（同一函式遞迴呼叫兩次以上）→ 加 lru_cache', before: '指數時間', after: '每個引數只算一次（線性或多項式）', memory: '多存一張快取表',
        detect(src) { const out = []; for (const m of src.matchAll(/^def (\w+)\(([^)]*)\):\s*\n((?:[ \t]+.*\n?|\n)*)/gm)) { const [, name, params, body] = m; if (/^\s*@/m.test(src.slice(Math.max(0, m.index - 40), m.index))) continue; const ps = params.split(',').map((x) => x.trim()).filter(Boolean); if (!ps.length || ps.some((x) => !/^\w+$/.test(x))) continue; const calls = (body.match(new RegExp('(?<![\\w.])' + esc(name) + '\\(', 'g')) || []).length; if (calls < 2) continue; if (/\b(global|nonlocal|print|input)\b|\.append\(|\.add\(|\[[^\]]*\]\s*=[^=]/.test(body)) continue; out.push(name); } return out.length ? { names: out } : null; },
        rewrite(src, p) { let s = addImport(src, 'from functools import lru_cache'); for (const n of p.names) s = s.replace(new RegExp('^def ' + esc(n) + '\\(', 'm'), '@lru_cache(maxsize=None)\ndef ' + n + '('); return s; },
    };
    // ---- 4. 字串用 += 一直接 → list＋join ----
    const strConcat = {
        id: 'str-join', name: '迴圈裡用 += 一直接字串 → 收進 list 最後 join', before: 'O(n²)（每次複製整個字串；CPython 有時會自動優化）', after: 'O(n)', memory: '同階',
        detect(src) { const out = []; for (const m of src.matchAll(/^([ \t]*)([A-Za-z_]\w*)\s*=\s*(?:""|'')\s*$/gm)) { const v = m[2]; const rest = src.slice(m.index + m[0].length); const adds = (rest.match(new RegExp('^[ \\t]+' + esc(v) + '\\s*\\+=\\s*.+$', 'gm')) || []).length; if (!adds) continue; const stripped = rest.replace(new RegExp('^[ \\t]+' + esc(v) + '\\s*\\+=\\s*.+$', 'gm'), ''); const left = [...stripped.matchAll(new RegExp('(?<![\\w.])' + esc(v) + '(?!\\w)', 'g'))]; const okUse = left.every((x) => { const pre = stripped.slice(Math.max(0, x.index - 7), x.index); return /print\($|return $/.test(pre); }); if (okUse && left.length >= 1) out.push(v); } return out.length ? { vars: out } : null; },
        rewrite(src, p) { let s = src; for (const v of p.vars) s = s.replace(new RegExp('^([ \\t]*)' + esc(v) + '\\s*=\\s*(?:""|\'\')\\s*$', 'm'), '$1' + v + '_parts = []').replace(new RegExp('^([ \\t]+)' + esc(v) + '\\s*\\+=\\s*(.+)$', 'gm'), '$1' + v + '_parts.append($2)').replace(new RegExp('(print\\(|return )' + esc(v) + '(?!\\w)', 'g'), '$1"".join(' + v + '_parts)'); return s; },
    };
    // ---- 5. sorted 只為了取最大／最小 → max／min ----
    const sortedExtreme = {
        id: 'sorted-extreme', name: 'sorted(...)[-1]／[0] 只為了取極值 → max／min', before: 'O(n log n)，且多一份排序後的 list', after: 'O(n)，不建新 list', memory: '省一份 list',
        detect(src) { return /sorted\(([^()]|\([^()]*\))*\)\[(?:-1|0)\]/.test(src) ? {} : null; },
        rewrite(src) { return src.replace(/sorted\(((?:[^()]|\([^()]*\))*?)(,\s*reverse\s*=\s*(True|False))?\)\[(-1|0)\]/g, (m, a, rv, flag, idx) => { const rev = flag === 'True'; const last = idx === '-1'; return ((rev ? !last : last) ? 'max(' : 'min(') + a.trim() + ')'; }); },
    };
    // ---- 6. 迴圈裡對「沒被改過的 list」做 in → 先轉 set ----
    const readonlyIn = {
        id: 'readonly-in-set', name: '迴圈裡對不會被改的 list 做 in → 先 set()', before: 'O(n·m)', after: 'O(n+m)', memory: '多一份雜湊表',
        detect(src) { const out = []; for (const m of src.matchAll(/^([ \t]+)(?:if|elif|while)\b[^\n]*?\bin\s+([A-Za-z_]\w*)\s*(?::|\band\b|\bor\b|\))/gm)) { const v = m[2]; if (out.includes(v)) continue; const asg = [...src.matchAll(new RegExp('^([ \\t]*)' + esc(v) + '\\s*=\\s*(.+)$', 'gm'))]; if (asg.length !== 1 || !/(?:list\(|\[|split\(|map\()/.test(asg[0][2]) || /\[\s*\]\s*$|\bset\(|\{/.test(asg[0][2])) continue; if (new RegExp('(?<![\\w.])' + esc(v) + '(?:\\.(?:append|insert|pop|remove|extend|sort|reverse|clear)\\b|\\[[^\\]]*\\]\\s*(?:=|\\+=)[^=])').test(src)) continue; const after = src.slice(asg[0].index); if (!new RegExp('^[ \\t]+(?:for|while)\\b[\\s\\S]*?\\bin\\s+' + esc(v) + '\\b', 'm').test(after) && !/^[ \t]*(?:for|while)\b/m.test(after)) continue; out.push(v); } return out.length ? { vars: out } : null; },
        rewrite(src, p) { let s = src; for (const v of p.vars) { s = s.replace(new RegExp('^([ \\t]*)' + esc(v) + '\\s*=\\s*(.+)$', 'm'), (m, i, rhs) => i + v + ' = ' + rhs + '\n' + i + v + '_set = set(' + v + ')'); s = s.replace(new RegExp('(\\bin\\s+)' + esc(v) + '(\\s*(?::|\\band\\b|\\bor\\b|\\)))', 'g'), '$1' + v + '_set$2'); } return s; },
    };
    // ---- 7. for x in a: ... a.count(x) → Counter ----
    const countLoop = {
        id: 'count-counter', name: '迴圈裡反覆 list.count(x) → 先 Counter 一次', before: 'O(n²)', after: 'O(n)', memory: '多一份計數表',
        detect(src) { const m = /^([ \t]*)for\s+(\w+)\s+in\s+(\w+)\s*:[\s\S]*?(?<![\w.])\3\.count\(\s*\2\s*\)/m.exec(src); return m ? { it: m[2], lst: m[3] } : null; },
        rewrite(src, p) { let s = addImport(src, 'from collections import Counter'); s = s.replace(new RegExp('^([ \\t]*)for\\s+' + esc(p.it) + '\\s+in\\s+' + esc(p.lst) + '\\s*:', 'm'), (m, i) => i + p.lst + '_cnt = Counter(' + p.lst + ')\n' + m); return s.replace(new RegExp('(?<![\\w.])' + esc(p.lst) + '\\.count\\(\\s*' + esc(p.it) + '\\s*\\)', 'g'), p.lst + '_cnt[' + p.it + ']'); },
    };
    // ---- 8. res = res + [x] → append ----
    const listConcat = {
        id: 'list-append', name: 'lst = lst + [x] → lst.append(x)', before: 'O(n²)（每次複製整個 list）', after: 'O(n)', memory: '不再每次產生新 list',
        detect(src) { return /^[ \t]+(\w+)\s*=\s*\1\s*\+\s*\[[^\]\n]*\]\s*$/m.test(src) ? {} : null; },
        rewrite(src) { return src.replace(/^([ \t]+)(\w+)\s*=\s*\2\s*\+\s*\[([^\]\n]*)\]\s*$/gm, '$1$2.append($3)'); },
    };
    // ---- 9. 迴圈裡反覆 sum(a[l:r]) → 前綴和 ----
    const rangeSum = {
        id: 'prefix-sum', name: '迴圈裡反覆 sum(a[l:r]) → 先做前綴和', before: 'O(n·q)', after: 'O(n+q)', memory: '多一個前綴和陣列',
        detect(src) { const m = /^([ \t]+)[^\n]*\bsum\(\s*(\w+)\[([^\]:\n]+):([^\]:\n]+)\]\s*\)/m.exec(src); return m && !/^\s*$/.test(m[2]) ? { arr: m[2] } : null; },
        rewrite(src, p) { const a = p.arr; let s = src.replace(new RegExp('\\bsum\\(\\s*' + esc(a) + '\\[([^\\]:\\n]+):([^\\]:\\n]+)\\]\\s*\\)', 'g'), '(' + a + '_pre[$2] - ' + a + '_pre[$1])'); const asg = new RegExp('^([ \\t]*)' + esc(a) + '\\s*=\\s*.+$', 'm').exec(s); if (!asg) return null; return s.replace(asg[0], asg[0] + '\n' + asg[1] + a + '_pre = [0]\n' + asg[1] + 'for _v in ' + a + ':\n' + asg[1] + '    ' + a + '_pre.append(' + a + '_pre[-1] + _v)'); },
    };
    // ---- 10. lst.insert(0, x) → deque.appendleft ----
    const insertFront = {
        id: 'insert-front', name: 'list.insert(0, x) 往前插 → deque.appendleft(x)', before: 'O(n²)（每次搬整個 list）', after: 'O(n)', memory: '同階',
        detect(src) { const out = []; for (const m of src.matchAll(/(?<![\w.])([A-Za-z_]\w*)\.insert\(\s*0\s*,/g)) { const v = m[1]; if (out.includes(v)) continue; if (new RegExp('(?<![\\w.])' + esc(v) + '\\[').test(src)) continue; if (new RegExp('(?<![\\w.])' + esc(v) + '\\.(?:sort|reverse|index|remove|extend|count)\\b').test(src)) continue; if (!new RegExp('^[ \\t]*' + esc(v) + '\\s*=\\s*(?:\\[.*\\]|list\\(.*\\))\\s*$', 'm').test(src)) continue; out.push(v); } return out.length ? { vars: out } : null; },
        rewrite(src, p) { let s = addImport(src, 'from collections import deque'); for (const v of p.vars) s = s.replace(new RegExp('^([ \\t]*' + esc(v) + '\\s*=\\s*)(\\[.*\\]|list\\(.*\\))\\s*$', 'm'), '$1deque($2)').replace(new RegExp('(?<![\\w.])' + esc(v) + '\\.insert\\(\\s*0\\s*,\\s*', 'g'), v + '.appendleft('); return s; },
    };
    // ---- 11. sum([...])／max([...])… → 產生器（不建中間 list；any／all 還能提早停） ----
    const genexp = {
        id: 'listcomp-genexp', name: 'sum／min／max／any／all 吃 list 推導式 → 改成產生器運算式', before: '時間同階（any／all 可提早停）', after: '同上', memory: 'O(n) → O(1)（不建中間 list）',
        detect(src) { return /\b(?:sum|min|max|any|all)\(\[[^\[\]\n]*\bfor\b[^\[\]\n]*\]\)/.test(src) ? {} : null; },
        rewrite(src) { return src.replace(/\b(sum|min|max|any|all)\(\[([^\[\]\n]*\bfor\b[^\[\]\n]*)\]\)/g, '$1($2)'); },
    };
    // ---- 12. k in d.keys() → k in d ----
    const keysIn = {
        id: 'keys-in', name: 'k in d.keys() → k in d', before: '（py3 已 O(1)，少一層呼叫；舊寫法 list(d.keys()) 才是 O(n)）', after: 'O(1)', memory: '不建 keys 視圖／list',
        detect(src) { return /\bin\s+(?:list\(\s*)?\w+\.keys\(\)\s*\)?\s*(?::|\band\b|\bor\b|\))/.test(src) ? {} : null; },
        rewrite(src) { return src.replace(/\bin\s+(?:list\(\s*)?(\w+)\.keys\(\)\s*\)?(?=\s*(?::|\band\b|\bor\b|\)))/g, 'in $1'); },
    };
    // ---- 13. 雙層迴圈數「和為 T 的配對」→ 一趟 Counter（題型：two-sum 計數） ----
    const PAIR_RE = /^([ \t]*)for\s+(\w+)\s+in\s+range\(\s*([^)\n]+?)\s*\)\s*:\s*\n\1[ \t]+for\s+(\w+)\s+in\s+range\(\s*\2\s*\+\s*1\s*,\s*\3\s*\)\s*:\s*\n\1[ \t]+[ \t]+if\s+(\w+)\[\2\]\s*\+\s*\5\[\4\]\s*==\s*([^:\n]+?)\s*:\s*\n\1[ \t]+[ \t]+[ \t]+(\w+)\s*\+=\s*1[ \t]*$/m;
    const pairCount = {
        id: 'pair-sum-count', name: '雙層迴圈數「和為 T 的配對」→ 一趟掃描＋Counter（two-sum 計數題型）', before: 'O(n²)', after: 'O(n)', memory: '多一份計數表',
        detect(src) { const m = PAIR_RE.exec(src); return m && m[3] ? { arr: m[5], t: m[6].trim(), c: m[7] } : null; },
        rewrite(src, p) { let s = addImport(src, 'from collections import Counter'); const m = PAIR_RE.exec(s); if (!m) return null; const ind = m[1]; const rep = ind + '_seen = Counter()\n' + ind + 'for _x in ' + p.arr + ':\n' + ind + '    ' + p.c + ' += _seen[' + p.t + ' - _x]\n' + ind + '    _seen[_x] += 1'; return s.replace(m[0], rep); },
    };
    const RULES = [listAsSet, queuePop, memoRec, strConcat, sortedExtreme, readonlyIn, countLoop, listConcat, rangeSum, insertFront, genexp, keysIn, pairCount];
    const detectAll = (src) => RULES.map((r) => { let p = null; try { p = r.detect(src); } catch (e) { p = null; } return p ? { id: r.id, name: r.name, before: r.before, after: r.after, memory: r.memory, params: p } : null; }).filter(Boolean);
    async function optimize(o) {
        let cur = String(o.source); const applied = [], skipped = []; const inputs = (o.inputs || []).slice(0, 12); const run = o.run; const note = [];
        if (typeof run !== 'function' || !inputs.length) return { ok: false, source: cur, applied, skipped, notes: ['沒有執行器或沒有輸入，無法驗證輸出一致，所以不改程式'], detected: detectAll(cur) };
        const base = []; for (const i of inputs) { const r = await run(cur, i); if (!r || r.ok === false) return { ok: false, source: cur, applied, skipped, notes: ['原程式在給的輸入上就跑不過（' + String((r && r.err) || '') .slice(0, 80) + '），不動'], detected: detectAll(cur) }; base.push(String(r.out).trim()); }
        const tm = async (src) => { if (o.bigInput == null) return null; const t = []; let mem = null; for (let k = 0; k < 2; k++) { const r = await run(src, o.bigInput); if (!r || r.ok === false) return { ms: Infinity, mem: null }; t.push(r.ms); if (r.mem != null) mem = mem == null ? r.mem : Math.min(mem, r.mem); } return { ms: Math.min(...t), mem }; };
        let m0 = await tm(cur); let t0 = m0 ? m0.ms : null;
        for (const r of RULES) {
            let p = null; try { p = r.detect(cur); } catch (e) { p = null; } if (!p) continue;
            let next = null; try { next = r.rewrite(cur, p); } catch (e) { next = null; } if (!next || next === cur) { skipped.push({ id: r.id, reason: '認得但改寫失敗' }); continue; }
            let same = true; for (let k = 0; k < inputs.length && same; k++) { const x = await run(next, inputs[k]); if (!x || x.ok === false || String(x.out).trim() !== base[k]) same = false; }
            if (!same) { skipped.push({ id: r.id, reason: '改完輸出和原本不同或跑不過，退回' }); continue; }
            const m1 = await tm(next); let t1 = m1 ? m1.ms : null; if (m0 && m1 && m0.mem != null && m1.mem != null && m1.mem > m0.mem * 1.5 + 5000) { skipped.push({ id: r.id, reason: '量記憶體：改完峰值變大（' + Math.round(m0.mem / 1024) + 'MB → ' + Math.round(m1.mem / 1024) + 'MB），退回' }); continue; }
            if (t0 != null && t1 != null && t1 > t0 * 1.2 + 15) { skipped.push({ id: r.id, reason: '量時間：改完比原本慢（' + Math.round(t0) + 'ms → ' + Math.round(t1) + 'ms），退回' }); continue; }
            applied.push({ id: r.id, name: r.name, before: r.before, after: r.after, memory: r.memory, ms: t0 != null ? [Math.round(t0), Math.round(t1)] : null, mem: m0 && m1 && m0.mem != null && m1.mem != null ? [m0.mem, m1.mem] : null, speedup: t0 != null && t1 ? Math.round((t0 / Math.max(t1, 1)) * 10) / 10 : null }); cur = next; if (m1) { m0 = m1; t0 = t1; }
        }
        note.push('輸出一致只在 ' + inputs.length + ' 組輸入上驗證（不是等價證明）；' + (o.bigInput != null ? '有量時間（大輸入）' : '沒有量時間'));
        return { ok: true, changed: applied.length > 0, source: cur, applied, skipped, notes: note, detected: detectAll(String(o.source)) };
    }
    function report(r) {
        if (!r) return '沒有結果'; const L = [];
        if (!r.ok) return '沒有優化：' + (r.notes || []).join('；');
        if (!r.applied.length) L.push('沒有找到可以安全換掉的慢寫法' + (r.detected && r.detected.length ? '（認得 ' + r.detected.map((d) => d.name).join('、') + '，但改完驗證沒過）' : ''));
        for (const a of r.applied) L.push('✔ ' + a.name + '：' + a.before + ' → ' + a.after + '；記憶體：' + a.memory + (a.ms ? '；實測 ' + a.ms[0] + 'ms → ' + a.ms[1] + 'ms（約 ' + a.speedup + ' 倍）' : '') + (a.mem ? '；峰值記憶體 ' + Math.round(a.mem[0] / 1024) + 'MB → ' + Math.round(a.mem[1] / 1024) + 'MB' : ''));
        for (const s of r.skipped) L.push('✘ ' + s.id + '：' + s.reason);
        L.push((r.notes || []).join('；')); return L.join('\n');
    }
    return { RULES, detectAll, optimize, report };
});
