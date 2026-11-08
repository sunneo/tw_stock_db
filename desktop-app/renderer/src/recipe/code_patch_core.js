/* merge diff patcher：把「修復或最佳化產生的修改」（unified diff）合併進使用者「目前」的程式碼（純函式，UMD；檢查器與判題器是注入的）。
 *   parseDiff(text)                     → { ok, files:[{oldName,newName,hunks[]}], warnings[], error? }   容忍 CRLF、行號錯、計數錯、沒有檔頭、程式碼圍欄；二進位／超大輸入直接拒絕
 *   applyPatch({source, diff, lang, fileName?, check?, judge?, opts?}) → Promise<結果>
 *   merge3(base, ours, theirs, {style, key})  純 JS 三方合併（diff3），測試用 `git merge-file` 對照
 *   makeDiff(a, b, {context, oldName, newName}) → unified diff 字串（測試與回報用）
 * 策略鏈（每個 hunk 獨立，結果不靜默：applied｜relocated｜fuzzy｜unit｜merged｜already｜conflict｜ambiguous｜failed）：
 *   ① 原位置精確 → ② 全檔唯一精確（行號位移）→ ③ 忽略空白（python 另要求相對縮排一致，整段縮排位移會重新對齊）→ ④ 去掉兩端 1～2 行脈絡（使用者改過脈絡）
 *   → ⑤ 函式邊界（splitUnits 找到那個函式，只在函式內找唯一錨點行）＋三方合併（base＝hunk 舊側、theirs＝hunk 新側、ours＝目前那一區）→ ⑥ 衝突
 * 全部或全不：任何一個 hunk 衝突／失敗／有歧義，整份不動（回滾）；合併後一定過 check（語法）與 judge（判題，沙盒），不過就回滾並寫原因。
 * 候選有歧義（重複片段）時，只有「驗證恰好一個通過」才採用，否則拒絕並列出位置——不猜。
 * 每個語言各自一份設定（PROFILES）：縮排是否有意義、函式標頭怎麼認、比對用的正規化；不跨語言共用。
 * 誠實限制：函式邊界用的是 code_edit_core 的詞法切分（不是 tree-sitter 語法樹）；合併成功只代表「過語法＋過給的測試」，不是證明語意正確；
 *   hunk 必須依序（檔案由上到下）。 */
(function (root, factory) {
    const E = (typeof FaCodeEdit !== 'undefined' && FaCodeEdit) || (root && root.FaCodeEdit) || (typeof require === 'function' ? (function () { try { return require('./code_edit_core.js'); } catch (_) { return null; } })() : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(E); else root.FaCodePatch = factory(E);
})(typeof self !== 'undefined' ? self : this, function (Edit) {
    'use strict';
    const LIMITS = { maxChars: 2 * 1024 * 1024, maxLines: 60000, maxDiffEdits: 6000, maxVerify: 12, maxCands: 6 };

    // ---------- 每個語言各自一份 ----------
    const CKW = /^(?:if|for|while|switch|return|catch|else|do|sizeof|foreach|using|lock|synchronized|throw|new)$/;
    function cDef(line) { const m = /(\w+)\s*\([^;{}]*\)?\s*(?:const\s*)?(?:noexcept\s*)?(?:throws\s+[\w., ]+)?\s*\{?\s*$/.exec(line); if (!m || CKW.test(m[1])) return null; if (!/^\s*[\w:<>\[\]*&~ ,]+[\s*&]\w+\s*\(/.test(line) && !/^\s*\w+\s*\(/.test(line)) return null; if (/;\s*$/.test(line)) return null; return m[1]; }
    const PROFILES = {
        python: { name: 'Python', indentSensitive: true, def: (l) => { const m = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/.exec(l); return m ? m[1] : null; } },
        nodejs: { name: 'JavaScript', indentSensitive: false, def: (l) => { let m = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(l) || /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/.exec(l) || /^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$/.exec(l); return m && !CKW.test(m[1]) ? m[1] : null; } },
        c: { name: 'C', indentSensitive: false, def: cDef },
        cpp: { name: 'C++', indentSensitive: false, def: cDef },
        java: { name: 'Java', indentSensitive: false, def: cDef },
        csharp: { name: 'C#', indentSensitive: false, def: cDef },
        ruby: { name: 'Ruby', indentSensitive: false, def: (l) => { const m = /^\s*def\s+(?:self\.)?(\w+[?!=]?)/.exec(l); return m ? m[1] : null; } },
        perl: { name: 'Perl', indentSensitive: false, def: (l) => { const m = /^\s*sub\s+(\w+)/.exec(l); return m ? m[1] : null; } },
        bash: { name: 'Bash', indentSensitive: false, def: (l) => { const m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\s*\))?\s*\{/.exec(l); return m && !CKW.test(m[1]) ? m[1] : null; } },
    };
    const profileOf = (lang) => PROFILES[lang] || { name: String(lang || '未知'), indentSensitive: false, def: () => null, generic: true };

    // ---------- 基本工具 ----------
    const strip = (s) => s.replace(/\r$/, '');
    const norm = (s) => strip(s).replace(/\s+/g, ' ').trim().replace(/\s*([{}()\[\];,=+\-*\/<>!&|:.])\s*/g, '$1');
    const hasAlnum = (s) => /[0-9A-Za-zÀ-￿]/.test(s);
    const indentOf = (s) => /^[ \t]*/.exec(strip(s))[0];
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };
    function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

    // ---------- diff（Myers）：回傳相符的 [i, j] 對 ----------
    function diffMatches(a, b) {
        const n = a.length, m = b.length; let pre = 0; while (pre < n && pre < m && a[pre] === b[pre]) pre++;
        let suf = 0; while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
        const out = []; for (let i = 0; i < pre; i++) out.push([i, i]);
        const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf); const N = A.length, M = B.length;
        if (N && M) {
            const max = Math.min(N + M, LIMITS.maxDiffEdits); const trace = []; let v = new Int32Array(2 * max + 2); const off = max + 1; let found = -1;
            outer: for (let d = 0; d <= max; d++) {
                trace.push(v.slice());
                for (let k = -d; k <= d; k += 2) {
                    let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1; let y = x - k;
                    while (x < N && y < M && A[x] === B[y]) { x++; y++; }
                    v[off + k] = x; if (x >= N && y >= M) { found = d; break outer; }
                }
            }
            if (found >= 0) {
                const rev = []; let x = N, y = M;
                for (let d = found; d > 0; d--) {
                    const vv = trace[d]; const k = x - y; const pk = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1; const px = vv[off + pk], py = px - pk;
                    while (x > px && y > py && x > 0 && y > 0 && A[x - 1] === B[y - 1]) { x--; y--; rev.push([x, y]); }
                    x = px; y = py;
                }
                while (x > 0 && y > 0 && A[x - 1] === B[y - 1]) { x--; y--; rev.push([x, y]); }
                rev.reverse(); for (const [i, j] of rev) out.push([i + pre, j + pre]);
            } // 差異太大放棄細配：中間整段視為替換（保守）
        }
        for (let i = suf; i > 0; i--) out.push([n - i, m - i]);
        return out;
    }
    function changesOf(matches, n, m) { // 相符對 → 變更區段 [{a0,a1,b0,b1}]
        const ch = []; let pi = 0, pj = 0;
        for (const [i, j] of matches) { if (i > pi || j > pj) ch.push({ a0: pi, a1: i, b0: pj, b1: j }); pi = i + 1; pj = j + 1; }
        if (n > pi || m > pj) ch.push({ a0: pi, a1: n, b0: pj, b1: m });
        return ch;
    }

    // ---------- 三方合併（diff3），行為對照 git merge-file ----------
    // base/ours/theirs：行陣列。style：'merge'（預設，含 git 的 zealous 精修＋相鄰衝突合併）或 'diff3'（含 base 區段，不精修）。key：比對用的鍵（預設原樣）。
    function merge3(base, ours, theirs, o) {
        o = o || {}; const style = o.style || 'merge'; const key = o.key || ((x) => x);
        const bk = base.map(key), ok = ours.map(key), tk = theirs.map(key);
        const oc = changesOf(diffMatches(bk, ok), base.length, ours.length), tc = changesOf(diffMatches(bk, tk), base.length, theirs.length);
        const items = []; // {k:'same'|'resolved', lines} | {k:'conf', base, ours, theirs}
        const text = (side, arr, lo, hi, list) => { const out = []; let pos = lo; for (const c of list) { for (let i = pos; i < c.a0; i++) out.push(base[i]); for (let j = c.b0; j < c.b1; j++) out.push(arr[j]); pos = c.a1; } for (let i = pos; i < hi; i++) out.push(base[i]); return out; };
        let oi = 0, ti = 0, bp = 0;
        const eq = (x, y) => x.length === y.length && x.every((l, i) => key(l) === key(y[i]));
        while (oi < oc.length || ti < tc.length) {
            const first = (ti >= tc.length || (oi < oc.length && oc[oi].a0 <= tc[ti].a0)) ? oc[oi] : tc[ti];
            const lo = first.a0; let hi = first.a1; const O = [], T = [];
            for (let moved = true; moved;) {
                moved = false;
                while (oi < oc.length && oc[oi].a0 <= hi) { O.push(oc[oi]); hi = Math.max(hi, oc[oi].a1); oi++; moved = true; }
                while (ti < tc.length && tc[ti].a0 <= hi) { T.push(tc[ti]); hi = Math.max(hi, tc[ti].a1); ti++; moved = true; }
            }
            if (lo > bp) items.push({ k: 'same', lines: base.slice(bp, lo) });
            const bseg = base.slice(lo, hi); const ot = O.length ? text('o', ours, lo, hi, O) : bseg, tt = T.length ? text('t', theirs, lo, hi, T) : bseg;
            if (!T.length) items.push({ k: 'resolved', lines: ot });
            else if (!O.length) items.push({ k: 'resolved', lines: tt });
            else if (eq(ot, tt)) items.push({ k: 'resolved', lines: ot });
            else items.push({ k: 'conf', base: bseg, ours: ot, theirs: tt });
            bp = hi;
        }
        if (bp < base.length) items.push({ k: 'same', lines: base.slice(bp) });
        let list = items;
        if (style === 'merge') { // zealous：衝突兩側再做一次 diff，共同的行放出來；再把相隔 ≤3 行（或無英數）的衝突併在一起
            const re = [];
            for (const it of list) {
                if (it.k !== 'conf' || !it.ours.length || !it.theirs.length) { re.push(it); continue; }
                const mt = diffMatches(it.ours.map(key), it.theirs.map(key)); let pi = 0, pj = 0; const sub = [];
                for (const [i, j] of mt) { if (i > pi || j > pj) sub.push({ k: 'conf', ours: it.ours.slice(pi, i), theirs: it.theirs.slice(pj, j), base: [] }); sub.push({ k: 'cm', lines: [it.ours[i]] }); pi = i + 1; pj = j + 1; }
                if (it.ours.length > pi || it.theirs.length > pj) sub.push({ k: 'conf', ours: it.ours.slice(pi), theirs: it.theirs.slice(pj), base: [] });
                // 沒有任何共同行：保留原本的衝突（含 base）
                if (!sub.some((s) => s.k === 'cm')) { re.push(it); continue; }
                // 連續共同行合成一段
                let acc = null; for (const s of sub) { if (s.k === 'cm') { if (acc) acc.lines.push(s.lines[0]); else { acc = { k: 'cm', lines: [s.lines[0]] }; re.push(acc); } } else { acc = null; re.push(s); } }
            }
            list = re;
            // 相鄰衝突（中間只隔著「相同」文字，不隔著已解決的區塊）：間隔 ≤3 行，或間隔都沒有英數 → 併成一個
            const mergedList = [];
            for (let i = 0; i < list.length; i++) {
                const it = list[i];
                if (it.k === 'conf' && mergedList.length >= 2) {
                    const gap = mergedList[mergedList.length - 1], prev = mergedList[mergedList.length - 2];
                    if ((gap.k === 'same' || gap.k === 'cm') && prev.k === 'conf' && (gap.lines.length <= 3 || !gap.lines.some(hasAlnum))) {
                        mergedList.pop(); mergedList.pop();
                        mergedList.push({ k: 'conf', base: prev.base.concat(gap.lines, it.base), ours: prev.ours.concat(gap.lines, it.ours), theirs: prev.theirs.concat(gap.lines, it.theirs) }); continue;
                    }
                }
                mergedList.push(it);
            }
            list = mergedList;
        }
        const lines = []; const conflicts = []; const L = o.labels || { ours: 'ours', base: 'base', theirs: 'theirs' };
        for (const it of list) {
            if (it.k === 'conf') {
                conflicts.push({ at: lines.length, base: it.base, ours: it.ours, theirs: it.theirs });
                lines.push('<<<<<<< ' + L.ours); for (const x of it.ours) lines.push(x);
                if (style === 'diff3') { lines.push('||||||| ' + L.base); for (const x of it.base) lines.push(x); }
                lines.push('======='); for (const x of it.theirs) lines.push(x); lines.push('>>>>>>> ' + L.theirs);
            } else for (const x of it.lines) lines.push(x);
        }
        return { clean: conflicts.length === 0, lines, conflicts };
    }

    // ---------- unified diff 產生 ----------
    function makeDiff(a, b, o) {
        o = o || {}; const ctx = o.context == null ? 3 : o.context; const A = Array.isArray(a) ? a : String(a).split('\n'), B = Array.isArray(b) ? b : String(b).split('\n');
        if (!Array.isArray(a) && A.length && A[A.length - 1] === '') A.pop(); if (!Array.isArray(b) && B.length && B[B.length - 1] === '') B.pop();
        const ch = changesOf(diffMatches(A.map(strip), B.map(strip)), A.length, B.length); if (!ch.length) return '';
        const groups = []; for (const c of ch) { const g = groups[groups.length - 1]; if (g && c.a0 - g[g.length - 1].a1 <= 2 * ctx) g.push(c); else groups.push([c]); }
        const out = ['--- ' + (o.oldName || 'a'), '+++ ' + (o.newName || 'b')];
        for (const g of groups) {
            const a0 = Math.max(0, g[0].a0 - ctx), a1 = Math.min(A.length, g[g.length - 1].a1 + ctx); const b0 = g[0].b0 - (g[0].a0 - a0); const body = []; let pos = a0;
            for (const c of g) { for (let i = pos; i < c.a0; i++) body.push(' ' + A[i]); for (let i = c.a0; i < c.a1; i++) body.push('-' + A[i]); for (let j = c.b0; j < c.b1; j++) body.push('+' + B[j]); pos = c.a1; }
            for (let i = pos; i < a1; i++) body.push(' ' + A[i]);
            const oc = a1 - a0, nc = body.filter((l) => l[0] !== '-').length;
            out.push('@@ -' + (oc ? a0 + 1 : a0) + (oc === 1 ? '' : ',' + oc) + ' +' + (nc ? b0 + 1 : b0) + (nc === 1 ? '' : ',' + nc) + ' @@'); for (const l of body) out.push(l);
        }
        return out.join('\n') + '\n';
    }

    // ---------- unified diff 解析 ----------
    function parseDiff(text) {
        const warnings = [];
        if (typeof text !== 'string') return { ok: false, files: [], warnings, error: '修補不是文字' };
        if (text.length > LIMITS.maxChars) return { ok: false, files: [], warnings, error: '修補太大（超過 ' + (LIMITS.maxChars >> 10) + ' KB），不處理', tooLarge: true };
        if (/\0/.test(text) || /^GIT binary patch/m.test(text) || /^Binary files .* differ/m.test(text)) return { ok: false, files: [], warnings, error: '修補含二進位內容，只處理文字修補', binary: true };
        let ls = text.split('\n').map(strip);
        if (ls.length > LIMITS.maxLines) return { ok: false, files: [], warnings, error: '修補行數太多（超過 ' + LIMITS.maxLines + '），不處理', tooLarge: true };
        // 程式碼圍欄（AI 常把 diff 包在 ``` 裡）
        const fi = ls.findIndex((l) => /\S/.test(l)); if (fi >= 0 && /^```/.test(ls[fi])) { ls = ls.slice(fi + 1); const last = ls.map((l) => /^```\s*$/.test(l)).lastIndexOf(true); if (last >= 0) ls = ls.slice(0, last); warnings.push('拿掉了程式碼圍欄'); }
        const files = []; let cur = null; let i = 0;
        const isHeaderPair = (k) => /^--- /.test(ls[k] || '') && /^\+\+\+ /.test(ls[k + 1] || '');
        const nameOf = (s) => { s = s.replace(/^(?:---|\+\+\+) /, '').replace(/\t.*$/, '').trim(); if (s === '/dev/null') return null; return s.replace(/^"|"$/g, '').replace(/^[ab]\//, ''); };
        const newFile = (o, n) => { cur = { oldName: o, newName: n, hunks: [] }; files.push(cur); };
        while (i < ls.length) {
            const l = ls[i];
            if (/^diff --git /.test(l)) { const m = /^diff --git (?:a\/)?(\S+) (?:b\/)?(\S+)/.exec(l); newFile(m ? m[1] : null, m ? m[2] : null); i++; continue; }
            if (isHeaderPair(i)) { const o = nameOf(ls[i]), n = nameOf(ls[i + 1]); if (cur && !cur.hunks.length && !cur.named) { cur.oldName = o; cur.newName = n; cur.named = true; } else { newFile(o, n); cur.named = true; } i += 2; continue; }
            const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l) || (/^@@(?: .*)?$/.test(l) ? [l, null, null, null, null, l.replace(/^@@\s*/, '').replace(/\s*@@\s*$/, '')] : null);
            if (hm) {
                if (!cur) newFile(null, null);
                const h = { oldStart: hm[1] == null ? null : +hm[1], oldCount: hm[2] == null ? (hm[1] == null ? null : 1) : +hm[2], newStart: hm[3] == null ? null : +hm[3], newCount: hm[4] == null ? (hm[3] == null ? null : 1) : +hm[4], heading: (hm[5] || '').trim(), ops: [], oldNoNl: false, newNoNl: false };
                i++; let oRem = h.oldCount == null ? 0 : h.oldCount, nRem = h.newCount == null ? 0 : h.newCount; let counted = h.oldCount != null;
                while (i < ls.length) {
                    const b = ls[i]; const need = counted && (oRem > 0 || nRem > 0);
                    if (!need && (/^@@/.test(b) || /^diff --git /.test(b) || isHeaderPair(i))) break;
                    if (need && /^diff --git /.test(b)) break;
                    if (b.startsWith('\\')) { const last = h.ops[h.ops.length - 1]; if (last) { if (last.t === '-') h.oldNoNl = true; else if (last.t === '+') h.newNoNl = true; else { h.oldNoNl = true; h.newNoNl = true; } } i++; continue; }
                    let t;
                    if (b === '') { if (!need) break; t = ' '; } else t = b[0];
                    if (t !== ' ' && t !== '+' && t !== '-') { if (need) { warnings.push('第 ' + (i + 1) + ' 行不像 diff 內容，hunk 提早結束'); } break; }
                    const s = b === '' ? '' : b.slice(1);
                    if (!need && counted && t !== ' ' && false) break;
                    h.ops.push({ t, s }); if (t !== '+') oRem--; if (t !== '-') nRem--; i++;
                }
                const oc = h.ops.filter((x) => x.t !== '+').length, nc = h.ops.filter((x) => x.t !== '-').length;
                if (h.oldCount != null && (h.oldCount !== oc || h.newCount !== nc)) warnings.push('hunk（-' + h.oldStart + '）的行數與標頭不符，改用實際內容重算');
                h.oldCount = oc; h.newCount = nc; cur.hunks.push(h); continue;
            }
            i++; // 其他（index、mode、說明文字）略過
        }
        const hunkFiles = files.filter((f) => f.hunks.length);
        return { ok: true, files: hunkFiles, warnings, empty: hunkFiles.length === 0 };
    }

    // ---------- 單一 hunk 的定位策略 ----------
    const sameExact = (a, b) => strip(a) === b;
    function matchAt(old, cur, p, cmp) { if (p < 0 || p + old.length > cur.length) return false; for (let k = 0; k < old.length; k++) if (!cmp(cur[p + k], old[k])) return false; return true; }
    function findAll(old, cur, from, cmp) { const r = []; if (!old.length) return r; for (let p = Math.max(0, from); p + old.length <= cur.length; p++) if (matchAt(old, cur, p, cmp)) r.push(p); return r; }
    function relIndentOk(old, cur, p) { // python：相對縮排必須一致（整段位移可以，結構不同不行）
        let b0 = null, c0 = null;
        for (let k = 0; k < old.length; k++) { if (!/\S/.test(old[k])) continue; const a = indentOf(old[k]).length, c = indentOf(cur[p + k]).length; if (b0 === null) { b0 = a; c0 = c; } else if (a - b0 !== c - c0) return false; }
        return true;
    }
    function reindentLine(line, oldFirst, oursFirst) { // 依「舊側第一行 → 目前那行」的縮排差，調整新增的行
        if (oldFirst === oursFirst || !/\S/.test(line)) return line; const ind = /^[ \t]*/.exec(line)[0];
        if (ind.startsWith(oldFirst)) return oursFirst + line.slice(oldFirst.length);
        if (oldFirst.startsWith(ind)) { const cut = oldFirst.length - ind.length; return oursFirst.length >= cut ? oursFirst.slice(0, oursFirst.length - cut) + line.slice(ind.length) : line; }
        return line;
    }

    function planHunk(h, st, prof, o) {
        // st: {cur, from, delta, carry, lang, crlf}
        const cur = st.cur; const old = h.ops.filter((x) => x.t !== '+').map((x) => x.s), nw = h.ops.filter((x) => x.t !== '-').map((x) => x.s);
        const baseExp = h.oldStart == null ? null : (old.length ? h.oldStart - 1 : h.oldStart) + st.delta; const exp = baseExp == null ? null : Math.max(0, Math.min(cur.length, baseExp + st.carry));
        const allBlank = !old.some((s) => /\S/.test(s));
        if (!h.ops.some((x) => x.t !== ' ')) return { kind: 'noop', reason: 'hunk 沒有任何增減' };
        const choose = (ps, why) => { // 回傳 {pos} 或 ambiguous
            if (!ps.length) return null; if (exp != null && ps.includes(exp)) return { pos: exp }; if (exp != null && baseExp !== exp && ps.includes(baseExp)) return { pos: baseExp };
            if (ps.length === 1) return { pos: ps[0] };
            const sorted = ps.slice().sort((a, b) => (exp == null ? a - b : Math.abs(a - exp) - Math.abs(b - exp) || a - b)); return { ambiguous: sorted.slice(0, LIMITS.maxCands + 2), total: ps.length, why };
        };
        const stageHit = (res, status, extra) => Object.assign({ kind: 'ok', status, delta: 0 }, extra, res);
        const mkOk = (pos, status, ops, fuzz) => ({ kind: 'ok', status, pos, ops, fuzz: fuzz || 0, old: ops.filter((x) => x.t !== '+').map((x) => x.s) });
        // ① 精確
        const exact = (a, b) => sameExact(a, b);
        if (old.length && !allBlank) {
            const ps1 = findAll(old, cur, st.from, exact); const c1 = choose(ps1, 'exact');
            if (c1 && c1.pos != null) return mkOk(c1.pos, c1.pos === baseExp ? 'applied' : 'relocated', h.ops);
            if (c1 && c1.ambiguous) return { kind: 'ambiguous', cands: c1.ambiguous, total: c1.total, stage: 'exact', ops: h.ops };
        } else if (!old.length) { // 純新增、沒有脈絡：只能用行號
            if (exp != null && exp >= st.from) return mkOk(exp, 'applied', h.ops); return { kind: 'fail', reason: '純新增的修補沒有脈絡，也沒有可用的行號，無法定位' };
        }
        // ③ 忽略空白
        const wsCmp = (a, b) => norm(a) === norm(b);
        if (old.length && !allBlank) {
            let ps3 = findAll(old, cur, st.from, wsCmp); if (prof.indentSensitive) ps3 = ps3.filter((p) => relIndentOk(old, cur, p));
            const c3 = choose(ps3, 'ws'); if (c3 && c3.pos != null) return mkOk(c3.pos, 'fuzzy', h.ops, 0); if (c3 && c3.ambiguous) return { kind: 'ambiguous', cands: c3.ambiguous, total: c3.total, stage: 'ws', ops: h.ops, loose: true };
        }
        // 已經套用過？（新側精確出現、舊側找不到）
        if (nw.length && nw.some((s) => /\S/.test(s))) { const ps = findAll(nw, cur, st.from, wsCmp); const okp = prof.indentSensitive ? ps.filter((p) => relIndentOk(nw, cur, p)) : ps; if (okp.length === 1 || (okp.length > 1 && exp != null && okp.includes(exp))) return { kind: 'already', pos: okp.length === 1 ? okp[0] : exp, len: nw.length }; }
        // ④ 去掉兩端 1～2 行脈絡（使用者改過脈絡）
        for (let fz = 1; fz <= 2; fz++) {
            const ops = h.ops.slice(); let lead = 0, tail = 0;
            for (let k = 0; k < fz && ops.length && ops[0].t === ' '; k++) { ops.shift(); lead++; }
            for (let k = 0; k < fz && ops.length && ops[ops.length - 1].t === ' '; k++) { ops.pop(); tail++; }
            if (!lead && !tail) break; const o2 = ops.filter((x) => x.t !== '+').map((x) => x.s); if (!o2.some((s) => /\S/.test(s))) continue;
            const hasCtx = ops.some((x) => x.t === ' '); const hasRem = ops.some((x) => x.t === '-'); if (!hasCtx && !hasRem) continue;
            let ps = findAll(o2, cur, st.from, wsCmp); if (prof.indentSensitive) ps = ps.filter((p) => relIndentOk(o2, cur, p));
            const adj = (pp) => pp - lead; const e2 = baseExp == null ? null : baseExp + lead + st.carry;
            const pick = ps.length === 1 ? { pos: ps[0] } : (e2 != null && ps.includes(e2) ? { pos: e2 } : (ps.length ? { ambiguous: ps.slice(0, LIMITS.maxCands + 2), total: ps.length } : null));
            if (pick && pick.pos != null) { const r = mkOk(pick.pos, 'fuzzy', ops, fz); r.fuzzNote = '去掉 ' + lead + '+' + tail + ' 行脈絡'; return r; }
            if (pick && pick.ambiguous) return { kind: 'ambiguous', cands: pick.ambiguous.map(adj), total: pick.total, stage: 'fuzz', ops, loose: true };
        }
        // ⑤ 函式邊界＋三方合併
        return { kind: 'region', old, nw };
    }

    function leadAnchors(base, cur, lo, hi) { // 在 cur[lo,hi) 內找「base 與視窗各只出現一次」的行（patience 錨點），回傳依序的 [bi, ci]
        const bn = base.map(norm); const cn = []; for (let k = lo; k < hi; k++) cn.push(norm(cur[k]));
        const cb = new Map(), cc = new Map(); for (const x of bn) cb.set(x, (cb.get(x) || 0) + 1); for (const x of cn) cc.set(x, (cc.get(x) || 0) + 1);
        const pairs = []; const pos = new Map(); cn.forEach((x, i) => { if (cc.get(x) === 1) pos.set(x, i); });
        bn.forEach((x, bi) => { if (cb.get(x) === 1 && pos.has(x) && hasAlnum(x) && x.length >= 3) pairs.push([bi, pos.get(x) + lo]); });
        // 最長遞增子序列（以 ci 為準）
        const n = pairs.length; if (!n) return []; const tails = [], prev = new Array(n).fill(-1), idx = [];
        for (let i = 0; i < n; i++) { let l = 0, r = tails.length; while (l < r) { const mid = (l + r) >> 1; if (pairs[tails[mid]][1] < pairs[i][1]) l = mid + 1; else r = mid; } if (l > 0) prev[i] = tails[l - 1]; tails[l] = i; idx[l] = i; }
        const seq = []; for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) seq.push(pairs[k]); return seq.reverse();
    }
    function planRegion(h, plan, st, prof, o) {
        const cur = st.cur; const base = plan.old, nw = plan.nw;
        // 找函式單元
        let name = prof.def(h.heading || '') || null; if (!name) for (const s of base) { name = prof.def(s); if (name) break; }
        let window = null, unit = null;
        const baseExp = h.oldStart == null ? null : h.oldStart - 1 + st.delta + st.carry;
        if (Edit && Edit.splitUnits && !prof.generic) {
            let units = []; try { units = Edit.splitUnits(o.lang, cur.map(strip).join('\n')); } catch (_) { units = []; }
            if (!name && baseExp != null) { for (let k = Math.min(cur.length - 1, baseExp); k >= 0 && k > baseExp - 400; k--) { const d = prof.def(cur[k]); if (d) { name = d; break; } } }
            if (name) { const c = units.filter((u) => u.name === name); const pick = c.length === 1 ? c[0] : (c.length > 1 && baseExp != null ? c.find((u) => u.startLine - 1 <= baseExp && baseExp <= u.endLine) : null); if (pick) { unit = pick; window = [Math.max(st.from, pick.startLine - 1), pick.endLine]; } }
        }
        const tries = []; if (window) tries.push({ w: window, how: 'unit' }); tries.push({ w: [st.from, cur.length], how: 'file' });
        const meaningful = base.filter((s) => hasAlnum(s) && norm(s).length >= 3).length; if (!meaningful) return { kind: 'fail', reason: '舊側全是空白或符號，沒有可用的錨點行' };
        for (const t of tries) {
            const anc = leadAnchors(base, cur, t.w[0], t.w[1]); if (!anc.length || anc.length < Math.max(1, Math.ceil(meaningful * 0.5))) continue;
            const [b0, c0] = anc[0], [b1, c1] = anc[anc.length - 1];
            const lo = Math.max(t.w[0], c0 - b0), hi = Math.min(t.w[1], c1 + (base.length - 1 - b1) + 1);
            if (hi - lo > base.length * 3 + 12) continue; // 錨點散太開，不是同一段
            return { kind: 'merge', lo, hi, how: t.how, unitName: unit ? unit.name : null, anchors: anc.length, meaningful, base, nw, ref: [base[b0], cur[c0]] };
        }
        return { kind: 'fail', reason: '找不到可靠的位置（舊側 ' + base.length + ' 行，唯一錨點不足' + (name ? '；函式 ' + name : '') + '）' };
    }

    // ---------- 把 hunk 套到目前的行 ----------
    function applyOps(plan, st) {
        const cur = st.cur; const ops = plan.ops; const out = []; let k = plan.pos; let first = null;
        { let q = plan.pos; for (const op of ops) if (op.t !== '+') { if (first === null && /\S/.test(op.s)) first = { o: indentOf(op.s), c: indentOf(cur[q]) }; q++; } }
        const cr = st.crlf ? '\r' : '';
        for (const op of ops) {
            if (op.t === ' ') { out.push(cur[k]); k++; } else if (op.t === '-') { k++; } else { out.push((first ? reindentLine(op.s, first.o, first.c) : op.s) + cr); }
        }
        return { lo: plan.pos, hi: k, lines: out };
    }

    function runHunks(file, source, lang, choices, o) {
        const prof = profileOf(lang);
        let text = source; const crlfCount = (text.match(/\r\n/g) || []).length, lfCount = (text.match(/\n/g) || []).length - crlfCount; const crlf = crlfCount > lfCount;
        let cur = text.split('\n'); let finalNl = false; if (cur.length && cur[cur.length - 1] === '') { cur.pop(); finalNl = true; }
        const st = { cur, from: 0, delta: 0, carry: 0, crlf, lang };
        const results = []; let ambiguous = null;
        for (let hi = 0; hi < file.hunks.length; hi++) {
            const h = file.hunks[hi]; const res = { index: hi + 1, header: h.oldStart == null ? '@@' : '@@ -' + h.oldStart + ' @@', status: 'failed' };
            let plan = planHunk(h, st, prof, { lang });
            if (plan.kind === 'region') plan = planRegion(h, plan, st, prof, { lang });
            if (plan.kind === 'noop') { res.status = 'already'; res.reason = plan.reason; results.push(res); continue; }
            if (plan.kind === 'already') { res.status = 'already'; res.line = plan.pos + 1; res.reason = '新內容已經在那裡（修補先前已套用）'; results.push(res); st.from = plan.pos + plan.len; continue; }
            if (plan.kind === 'fail') { res.reason = plan.reason; results.push(res); return { ok: false, results, failedAt: hi }; }
            if (plan.kind === 'ambiguous') {
                const ch = choices && choices[hi]; if (ch == null) { res.status = 'ambiguous'; res.reason = '有 ' + plan.total + ' 個位置都符合（第 ' + plan.cands.map((p) => p + 1).join('、') + ' 行…），無法確定該改哪一處'; res.candidates = plan.cands.map((p) => p + 1); results.push(res); return { ok: false, results, failedAt: hi, ambiguous: { hunk: hi, cands: plan.cands.slice(0, LIMITS.maxCands), plan } }; }
                const ops = plan.ops; plan = { kind: 'ok', pos: ch, ops, status: plan.loose ? 'fuzzy' : 'relocated', fuzz: 0, ambiguousResolved: true };
            }
            let lo, hiIdx, lines, status = plan.status, extra = {};
            if (plan.kind === 'ok') {
                const r = applyOps(plan, st); lo = r.lo; hiIdx = r.hi; lines = r.lines; extra.fuzz = plan.fuzz; if (plan.fuzzNote) extra.note = plan.fuzzNote; if (plan.ambiguousResolved) extra.note = '重複片段，經驗證只有這一處可行';
            } else if (plan.kind === 'merge') {
                // theirs：新側，依基準行調整縮排
                const refO = indentOf(plan.ref[0]), refC = indentOf(plan.ref[1]); const cr = crlf ? '\r' : '';
                const theirs = plan.nw.map((s) => reindentLine(s, refO, refC) + cr); const ours = cur.slice(plan.lo, plan.hi); const baseL = plan.base.map((s) => s + cr);
                const m = merge3(baseL, ours, theirs, { key: norm, labels: { ours: '目前的程式', base: '修補的舊側', theirs: '修補的新側' }, style: 'diff3' });
                if (!m.clean) { res.status = 'conflict'; res.line = plan.lo + 1; res.reason = '你的程式與修補在同一處都改了（' + m.conflicts.length + ' 處衝突）'; res.conflictText = m.lines.map(strip).join('\n'); res.conflicts = m.conflicts.map((c) => ({ ours: c.ours.map(strip), base: c.base.map(strip), theirs: c.theirs.map(strip) })); results.push(res); return { ok: false, results, failedAt: hi }; }
                lo = plan.lo; hiIdx = plan.hi; lines = m.lines; status = plan.how === 'unit' ? 'unit' : 'merged'; extra.note = '保留你的修改並合入修補（' + (plan.unitName ? '函式 ' + plan.unitName + ' 內，' : '') + '錨點 ' + plan.anchors + '/' + plan.meaningful + ' 行）';
                if (lines.length === hiIdx - lo && lines.every((x, i) => cur[lo + i] === x)) { status = 'already'; extra.note = '合併後與目前相同（修補的內容你已經改好了）'; }
            }
            const before = cur.slice(lo, hiIdx); const sameAsBefore = lines.length === before.length && lines.every((x, i) => x === before[i]);
            if (!sameAsBefore) { cur.splice(lo, hiIdx - lo, ...lines); }
            const oldLen = h.ops.filter((x) => x.t !== '+').length, newLen = h.ops.filter((x) => x.t !== '-').length;
            const baseExp = h.oldStart == null ? null : (oldLen ? h.oldStart - 1 : h.oldStart) + st.delta;
            if (baseExp != null && status !== 'already') st.carry = lo - baseExp; // 使用者改動造成的位移，帶給下一個 hunk
            st.delta += newLen - oldLen; st.from = lo + lines.length;
            if (hiIdx >= cur.length - (lines.length - (hiIdx - lo)) && (h.newNoNl || h.oldNoNl)) { if (h.newNoNl) finalNl = false; else if (h.oldNoNl) finalNl = true; }
            Object.assign(res, { status, line: lo + 1, offset: baseExp == null ? null : lo - baseExp }, extra); results.push(res);
        }
        return { ok: true, results, source: cur.join('\n') + (finalNl ? '\n' : '') };
    }

    // ---------- 主流程 ----------
    const LABEL = { applied: '原位置', relocated: '行號位移後找到', fuzzy: '忽略空白／脈絡差異', unit: '函式內錨點＋三方合併', merged: '三方合併', already: '已套用', conflict: '衝突', ambiguous: '位置有歧義', failed: '失敗' };
    async function applyPatch(a) {
        a = a || {}; const o = Object.assign({ requireVerify: false, judgeMode: 'ac' }, a.opts || {});
        const lang = a.lang || a.language || null; const out = (r) => Object.assign({ ok: false, source: a.source, changed: false, hunks: [], verified: { syntax: null, tests: null }, gaps: [] }, r);
        if (typeof a.source !== 'string') return out({ status: 'bad_input', reason: '缺少 source（目前的程式碼）' });
        if (a.source.length > LIMITS.maxChars || a.source.split('\n').length > LIMITS.maxLines) return out({ status: 'too_large', reason: '程式太大（超過 ' + (LIMITS.maxChars >> 10) + ' KB），不處理' });
        if (/\0/.test(a.source)) return out({ status: 'binary', reason: '目前的內容含二進位資料，不處理' });
        const pd = parseDiff(a.diff); if (!pd.ok) return out({ status: pd.binary ? 'binary' : pd.tooLarge ? 'too_large' : 'bad_diff', reason: pd.error });
        if (pd.empty) return out({ status: 'empty', reason: '修補是空的（沒有任何 hunk）', warnings: pd.warnings });
        let file = pd.files[0];
        if (pd.files.length > 1) { const fn = a.fileName; file = fn ? pd.files.find((f) => f.newName === fn || f.oldName === fn || (f.newName || '').endsWith('/' + fn) || (f.oldName || '').endsWith('/' + fn)) : null; if (!file) return out({ status: 'multi_file', reason: '修補含 ' + pd.files.length + ' 個檔案（' + pd.files.map((f) => f.newName || f.oldName).join('、') + '），請用 fileName 指定要合併哪一個', warnings: pd.warnings }); }
        if (!(o.requireVerify === false) && !a.check && !a.judge) return out({ status: 'no_verifier', reason: '沒有語法檢查器也沒有判題器，不合併（requireVerify）' });
        const gaps = []; if (pd.warnings.length) gaps.push(...pd.warnings);
        // 基準：合併前的檢查結果
        let baseSyntax = null; if (a.check) { try { const r = await a.check(a.source); baseSyntax = r && r.ok !== false && r.verdict !== 'CE'; } catch (e) { baseSyntax = null; gaps.push('檢查器出錯：' + clip(e && e.message, 80)); } }
        let baseJudge = null; if (a.judge) { try { baseJudge = await a.judge(a.source); } catch (e) { gaps.push('判題器出錯：' + clip(e && e.message, 80)); } }
        let verifies = 0; const attempts = [];
        const verify = async (src) => {
            verifies++; const v = { syntax: null, tests: null };
            if (a.check) { let r; try { r = await a.check(src); } catch (e) { return { pass: false, v, why: '檢查器出錯：' + clip(e && e.message, 80) }; } const ok = r && r.ok !== false && r.verdict !== 'CE'; v.syntax = !!ok; if (!ok) return { pass: false, v, why: '合併後語法檢查沒過：' + clip((r && (r.detail || r.compileLog || r.message)) || 'CE', 200) }; }
            if (a.judge) {
                let r; try { r = await a.judge(src); } catch (e) { return { pass: false, v, why: '判題器出錯：' + clip(e && e.message, 80) }; }
                if (r && r.verdict === 'UNAVAILABLE') return { pass: false, v, why: '判題器不能用：' + clip(r.detail, 100), unavailable: true };
                v.tests = r && r.verdict; const good = o.judgeMode === 'noworse' && baseJudge && r && r.total ? (r.passed >= (baseJudge.passed || 0)) : (r && r.verdict === 'AC');
                if (!good) return { pass: false, v, why: '合併後判題沒過：' + (r && r.verdict) + (r && r.detail ? '（' + clip(r.detail, 160) + '）' : '') + (baseJudge && baseJudge.verdict ? '；合併前是 ' + baseJudge.verdict : '') };
            }
            return { pass: true, v };
        };
        const canVerify = !!(a.check || a.judge);
        const passes = []; let lastFail = null; let lastRun = null;
        const search = async (choices) => {
            const r = runHunks(file, a.source, lang, choices, o); lastRun = r;
            if (!r.ok) {
                if (r.ambiguous && canVerify) { for (const c of r.ambiguous.cands) { if (verifies >= LIMITS.maxVerify) { gaps.push('驗證次數用完（' + LIMITS.maxVerify + '），不再試其他候選位置'); break; } await search(Object.assign({}, choices, { [r.ambiguous.hunk]: c })); } return; }
                lastFail = { why: '第 ' + (r.failedAt + 1) + ' 個 hunk：' + (r.results[r.failedAt].reason || ''), run: r }; return;
            }
            if (r.source === a.source) { passes.push({ r, noop: true }); return; }
            const ver = await verify(r.source);
            if (ver.pass) passes.push({ r, v: ver.v }); else lastFail = { why: ver.why, run: r, unavailable: ver.unavailable };
        };
        await search({});
        if (passes.length === 1) {
            const p = passes[0]; const r = p.r; const noop = r.results.every((x) => x.status === 'already') || r.source === a.source;
            const verified = { syntax: p.v ? p.v.syntax : baseSyntax, tests: p.v ? p.v.tests : (baseJudge && baseJudge.verdict) || null };
            if (!canVerify) gaps.push('沒有檢查器也沒有判題器：只是文字層面合併，沒有驗證（verified:false）'); else if (!a.judge) gaps.push('沒有判題器：只確認語法，沒有驗證行為');
            return out({ ok: true, status: noop ? 'already_applied' : 'merged', source: r.source, changed: r.source !== a.source, noop, hunks: r.results, verified, verifiedAny: canVerify, gaps, diff: r.source !== a.source ? makeDiff(a.source.replace(/\r\n/g, '\n'), r.source.replace(/\r\n/g, '\n'), { oldName: 'a/' + (file.oldName || 'source'), newName: 'b/' + (file.newName || 'source') }) : '', baseHash: hash(a.source), baseSyntax, warnings: pd.warnings });
        }
        if (passes.length > 1) {
            const ls = passes.map((p) => p.r.results.filter((x) => x.candidates || x.note).map((x) => x.line)).flat();
            return out({ status: 'ambiguous', reason: '重複的片段：有 ' + passes.length + ' 種合併位置都能通過驗證，無法確定該改哪一處，沒有合併', hunks: passes[0].r.results, candidates: passes.map((p) => p.r.results.map((x) => x.line)), gaps });
        }
        // 沒有任何可行的合併 → 回滾，並說原因
        const why = lastFail ? lastFail.why : '沒有可行的合併';
        const run = lastFail && lastFail.run ? lastFail.run : lastRun; const hunks = run ? run.results : [];
        const bad = hunks.find((x) => x.status === 'conflict' || x.status === 'ambiguous' || x.status === 'failed');
        const status = lastFail && lastFail.unavailable ? 'verify_unavailable' : bad ? (bad.status === 'failed' ? 'locate_failed' : bad.status) : 'verify_failed';
        return out({ status, reason: why + '。已回滾，你的程式沒有被改動。', hunks, gaps, rolledBack: true });
    }

    // 多檔：全部或全不（每個檔各自驗證，任一失敗整批回滾）
    async function applyPatchFiles(a) {
        a = a || {}; const pd = parseDiff(a.diff); if (!pd.ok) return { ok: false, status: 'bad_diff', reason: pd.error, files: [] }; if (pd.empty) return { ok: false, status: 'empty', reason: '修補是空的', files: [] };
        const res = []; let allOk = true;
        for (const f of pd.files) {
            const nm = f.newName || f.oldName; const src = a.files && a.files[nm]; const rec = { name: nm };
            if (!src || typeof src.source !== 'string') { rec.r = { ok: false, status: 'missing', reason: '沒有提供 ' + nm + ' 的目前內容' }; allOk = false; res.push(rec); continue; }
            const one = await applyPatch({ source: src.source, lang: src.lang, diff: a.diff, fileName: nm, check: a.check && ((s) => a.check(s, nm, src.lang)), judge: a.judge && ((s) => a.judge(s, nm, src.lang)), opts: a.opts });
            rec.r = one; if (!one.ok) allOk = false; res.push(rec);
        }
        return { ok: allOk, status: allOk ? 'merged' : 'rejected', files: res.map((x) => ({ name: x.name, ok: x.r.ok, status: x.r.status, source: allOk ? x.r.source : undefined, reason: x.r.reason, hunks: x.r.hunks })), reason: allOk ? undefined : '有檔案沒合併成功，整批回滾（沒有任何檔被改）' };
    }

    function report(r) {
        if (!r) return '';
        const L = []; L.push(r.ok ? (r.noop ? '修補早就套用過，沒有需要改的。' : '已合併：' + r.hunks.length + ' 個 hunk。') : '沒有合併：' + (r.reason || r.status));
        for (const h of (r.hunks || [])) L.push('  #' + h.index + ' ' + (LABEL[h.status] || h.status) + (h.line ? '（第 ' + h.line + ' 行' + (h.offset ? '，位移 ' + (h.offset > 0 ? '+' : '') + h.offset : '') + '）' : '') + (h.note ? '：' + h.note : '') + (!r.ok && h.reason ? '：' + h.reason : ''));
        if (r.ok) L.push('驗證：語法 ' + (r.verified.syntax == null ? '未檢查' : r.verified.syntax ? '通過' : '沒過') + '；判題 ' + (r.verified.tests || '未跑'));
        for (const g of (r.gaps || [])) L.push('注意：' + g);
        return L.join('\n');
    }

    return { PROFILES, LIMITS, parseDiff, applyPatch, applyPatchFiles, merge3, makeDiff, diffMatches, report, norm };
});
