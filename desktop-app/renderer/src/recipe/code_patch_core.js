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
        o = o || {}; const style = o.style || 'merge'; const key = o.key || ((x) => x); const touch = o.touch !== false;
        const bk = base.map(key), ok = ours.map(key), tk = theirs.map(key);
        const oc = changesOf(diffMatches(bk, ok), base.length, ours.length), tc = changesOf(diffMatches(bk, tk), base.length, theirs.length);
        const items = []; // {k:'same'|'resolved', lines} | {k:'conf', base, ours, theirs}
        const text = (side, arr, lo, hi, list) => { const out = []; let pos = lo; for (const c of list) { for (let i = pos; i < c.a0; i++) out.push(base[i]); for (let j = c.b0; j < c.b1; j++) out.push(arr[j]); pos = c.a1; } for (let i = pos; i < hi; i++) out.push(base[i]); return out; };
        let oi = 0, ti = 0, bp = 0;
        const eq = (x, y) => x.length === y.length && x.every((l, i) => key(l) === key(y[i]));
        while (oi < oc.length || ti < tc.length) {
            const first = (ti >= tc.length || (oi < oc.length && oc[oi].a0 <= tc[ti].a0)) ? oc[oi] : tc[ti];
            const lo = first.a0; let hi = first.a1; const O = [], T = [];
            // 相連（touch，預設，同 git）：相鄰的改動算重疊。touch:false（4.2 縮小衝突用）：只有真的重疊，或同一點的兩個插入，才算重疊
            const ov = (x) => x.a0 < hi || (touch ? x.a0 === hi : (lo === hi && x.a0 === hi && x.a1 === x.a0));
            for (let moved = true; moved;) {
                moved = false;
                while (oi < oc.length && ov(oc[oi])) { O.push(oc[oi]); hi = Math.max(hi, oc[oi].a1); oi++; moved = true; }
                while (ti < tc.length && ov(tc[ti])) { T.push(tc[ti]); hi = Math.max(hi, tc[ti].a1); ti++; moved = true; }
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
                if (it.k === 'conf' && mergedList.length >= 2 && o.joinNear !== false) {
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
        let ci = 0;
        for (const it of list) {
            if (it.k === 'conf') {
                const rs = typeof o.resolve === 'function' ? o.resolve({ base: it.base, ours: it.ours, theirs: it.theirs }, ci) : null; ci++; // 4.2：由呼叫端決定這個衝突怎麼解（回 null＝留標記）
                if (rs) { for (const x of rs) lines.push(x); continue; }
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
    function findAll(old, cur, from, cmp, st) { const r = []; if (!old.length) return r; for (let p = Math.max(0, from); p + old.length <= cur.length; p++) if (matchAt(old, cur, p, cmp) && !(st && st.useBlocked && !st.free(p, old.length))) r.push(p); return r; }
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
            const ps1 = findAll(old, cur, st.from, exact, st); const c1 = choose(ps1, 'exact');
            if (c1 && c1.pos != null) return mkOk(c1.pos, c1.pos === baseExp ? 'applied' : 'relocated', h.ops);
            if (c1 && c1.ambiguous) return { kind: 'ambiguous', cands: c1.ambiguous, total: c1.total, stage: 'exact', ops: h.ops };
        } else if (!old.length) { // 純新增、沒有脈絡：只能用行號
            if (exp != null && exp >= st.from) return mkOk(exp, 'applied', h.ops); return { kind: 'fail', reason: '純新增的修補沒有脈絡，也沒有可用的行號，無法定位' };
        }
        // ③ 忽略空白
        const wsCmp = (a, b) => norm(a) === norm(b);
        if (old.length && !allBlank) {
            let ps3 = findAll(old, cur, st.from, wsCmp, st); if (prof.indentSensitive) ps3 = ps3.filter((p) => relIndentOk(old, cur, p));
            const c3 = choose(ps3, 'ws'); if (c3 && c3.pos != null) return mkOk(c3.pos, 'fuzzy', h.ops, 0); if (c3 && c3.ambiguous) return { kind: 'ambiguous', cands: c3.ambiguous, total: c3.total, stage: 'ws', ops: h.ops, loose: true };
        }
        // 已經套用過？（新側精確出現、舊側找不到）
        for (let fz = 0; fz <= 2; fz++) { // 使用者改過脈絡時，去掉兩端 1～2 行脈絡再比（要求剩下的裡面有新增的行，否則不算證據）
            const ops = h.ops.filter((x) => x.t !== '-'); let a0 = 0, a1 = ops.length; for (let k = 0; k < fz && a0 < a1 && ops[a0].t === ' '; k++) a0++; for (let k = 0; k < fz && a1 > a0 && ops[a1 - 1].t === ' '; k++) a1--;
            const seg = ops.slice(a0, a1); if (!seg.some((x) => x.t === '+' && /\S/.test(x.s))) continue; const sl = seg.map((x) => x.s); if (sl.filter((s) => /\S/.test(s)).length < 2) continue; // 只有一行證據太薄（可能剛好別處有同樣的行）
            const ps = findAll(sl, cur, st.from, wsCmp); const okp = prof.indentSensitive ? ps.filter((p) => relIndentOk(sl, cur, p)) : ps;
            if (okp.length === 1 || (okp.length > 1 && exp != null && okp.includes(exp + a0))) return { kind: 'already', pos: okp.length === 1 ? okp[0] : exp + a0, len: sl.length };
        }
        // ④ 去掉兩端 1～2 行脈絡（使用者改過脈絡）
        for (let fz = 1; fz <= 2; fz++) {
            const ops = h.ops.slice(); let lead = 0, tail = 0;
            for (let k = 0; k < fz && ops.length && ops[0].t === ' '; k++) { ops.shift(); lead++; }
            for (let k = 0; k < fz && ops.length && ops[ops.length - 1].t === ' '; k++) { ops.pop(); tail++; }
            if (!lead && !tail) break; const o2 = ops.filter((x) => x.t !== '+').map((x) => x.s); if (!o2.some((s) => /\S/.test(s))) continue;
            const hasCtx = ops.some((x) => x.t === ' '); const hasRem = ops.some((x) => x.t === '-'); if (!hasCtx && !hasRem) continue;
            let ps = findAll(o2, cur, st.from, wsCmp, st); if (prof.indentSensitive) ps = ps.filter((p) => relIndentOk(o2, cur, p));
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
        // 找函式單元（有語法樹就用語法樹；沒有就用詞法切分）
        let name = prof.def(h.heading || '') || null; if (!name) for (const s of base) { name = prof.def(s); if (name) break; }
        const baseExp = h.oldStart == null ? null : h.oldStart - 1 + st.delta + st.carry;
        let units = []; const src = cur.map(strip).join('\n');
        try { units = o.unitsFn ? o.unitsFn(src) : ((Edit && Edit.splitUnits && !prof.generic) ? Edit.splitUnits(o.lang, src) : []); } catch (_) { units = []; }
        const contains = (u) => baseExp != null && u.startLine - 1 <= baseExp && baseExp <= u.endLine; const sizeOf = (u) => u.endLine - u.startLine;
        let unitCands = [];
        if (units.length) {
            if (!name && baseExp != null) { for (let k = Math.min(cur.length - 1, baseExp); k >= 0 && k > baseExp - 400; k--) { const d = prof.def(cur[k]); if (d) { name = d; break; } } }
            if (name) unitCands = units.filter((u) => u.name === name);
            else if (o.unitsFn && baseExp != null) { const c = units.filter(contains).sort((a, b) => sizeOf(a) - sizeOf(b)); if (c.length) unitCands = [c[0]]; }
        }
        const from0 = st.from;
        const meaningful = base.filter((s) => hasAlnum(s) && norm(s).length >= 3).length; if (!meaningful) return { kind: 'fail', reason: '舊側全是空白或符號，沒有可用的錨點行' };
        const attempt = (w, how, unit) => {
            const anc = leadAnchors(base, cur, w[0], w[1]); if (!anc.length || anc.length < Math.max(1, Math.ceil(meaningful * 0.5))) return null;
            const [b0, c0] = anc[0], [b1, c1] = anc[anc.length - 1];
            const lo = Math.max(w[0], c0 - b0), hi = Math.min(w[1], c1 + (base.length - 1 - b1) + 1);
            if (hi - lo > base.length * 3 + 12) return null; // 錨點散太開，不是同一段
            if (st.useBlocked && !st.free(lo, hi - lo)) return null; // 亂序模式：不能蓋到已經套用的區域
            return { kind: 'merge', lo, hi, how, unitName: unit ? unit.name : null, unitQual: unit ? unit.qual : null, anchors: anc.length, meaningful, base, nw, ref: [base[b0], cur[c0]] };
        };
        if (unitCands.length) {
            const ok = []; for (const u of unitCands) { const r = attempt([Math.max(from0, u.startLine - 1), u.endLine], 'unit', u); if (r) ok.push(r); }
            if (ok.length === 1) return ok[0];
            if (ok.length > 1) { // 同名函式不只一個（巢狀函式、不同類別的同名方法）：用位置挑最近的；位置分不出來就不猜
                const near = baseExp == null ? [] : ok.filter((r) => r.lo <= baseExp && baseExp <= r.hi + 1); if (near.length === 1) return near[0];
                return { kind: 'fail', reason: '有 ' + ok.length + ' 個同名的函式 ' + name + ' 都符合（' + ok.map((r) => '第 ' + (r.lo + 1) + ' 行').join('、') + '），無法確定該改哪一個' };
            }
        }
        const fr = attempt([from0, cur.length], 'file', null); if (fr) return fr;
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

    // ---------- 語法樹的函式單元（web-tree-sitter；目前只有 Python 文法在本機）----------
    // parser：已 setLanguage 的 web-tree-sitter Parser。回傳 [{name, qual, kind, startLine, endLine, depth}]（行號 1 起算、含裝飾器），巢狀函式、類別方法都有，qual 是 外層.內層 的完整路徑。
    // 字串或註解裡長得像 def 的文字不會被當成函式（詞法切分會）。
    function treeUnits(parser, src) {
        const tree = parser.parse(String(src)); const out = [];
        try {
            const walk = (node, path) => {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const c = node.namedChild(i); let def = c;
                    if (c.type === 'decorated_definition') def = c.childForFieldName('definition') || c.namedChild(c.namedChildCount - 1);
                    if (def && (def.type === 'function_definition' || def.type === 'class_definition')) {
                        const nm = def.childForFieldName('name'); const name = nm ? nm.text : '?';
                        if (def.type === 'function_definition') out.push({ name, qual: path.concat(name).join('.'), kind: 'function', startLine: c.startPosition.row + 1, endLine: c.endPosition.column === 0 ? c.endPosition.row : c.endPosition.row + 1, depth: path.length });
                        walk(def.childForFieldName('body') || def, path.concat(name));
                    } else walk(c, path);
                }
            };
            walk(tree.rootNode, []); const he = tree.rootNode.hasError; out.hasError = typeof he === 'function' ? !!he.call(tree.rootNode) : !!he; // 有語法錯誤時樹不可靠（沒收的括號會吞掉後面的函式）
        } finally { if (tree && typeof tree.delete === 'function') tree.delete(); }
        return out;
    }

    // ---------- 4.2 衝突處理階梯 ----------
    // 由便宜到貴，每個候選之後都要過真的檢查器／判題器（applyPatch 負責驗證），不過就丟掉；解不開就留標準衝突標記，不假裝解決。
    //   ① 縮小衝突（行層級，相鄰但不重疊的改動分開合併）  ② 詞元層級合併（同一行裡兩邊改不同的詞）
    //   ③ 兩邊都插入同一個位置：兩種順序都當候選（要有判題器才收）
    // 刻意不做的：「兩邊改同一行同一處」不會自動取一邊（那會悄悄丟掉使用者的改動或修補的內容），也不把兩個版本都留下（會留下死碼卻騙過測試）。
    function tokenMerge(c, cr) {
        const tk = (ls) => ls.map(strip).join('\n').match(/\w+|[ \t]+|\n|[^\w\s]/g) || [];
        const b = tk(c.base), o = tk(c.ours), t = tk(c.theirs); if (b.length + o.length + t.length > 1500 || !b.length) return null;
        const m = merge3(b, o, t, { style: 'diff3' }); if (!m.clean) return null;
        return m.lines.join('').split('\n').map((l) => l + cr);
    }
    function conflictCandidates(baseL, ours, theirs, o) {
        const cr = o.cr || ''; const cands = []; const seen = new Set(); const sig = (ls) => ls.join('\n');
        const push = (id, label, cost, lines, needsTests) => { const s = sig(lines); if (seen.has(s)) return; seen.add(s); cands.push({ id, label, cost, lines, needsTests }); };
        const run = (resolve) => merge3(baseL, ours, theirs, { key: norm, style: 'merge', touch: false, joinNear: false, resolve });
        const sh = run(null); if (sh.clean) push('shrink', '縮小衝突：兩邊改的地方其實不重疊，分別合併', 1, sh.lines, false);
        const tok = run((c) => tokenMerge(c, cr)); if (tok.clean) push('token', '詞元層級合併：同一行裡兩邊改的是不同的詞', 2, tok.lines, false);
        if (o.canJudge) {
            const cat = (first) => (c) => { if (c.base.length === 0 && c.ours.length && c.theirs.length) { const a = first === 'ours' ? c.ours : c.theirs, b = first === 'ours' ? c.theirs : c.ours; return a.concat(b.filter((l) => !a.some((x) => norm(x) === norm(l)))); } return tokenMerge(c, cr); };
            const c1 = run(cat('ours')); if (c1.clean) push('ours+theirs', '兩邊都插在同一處：先你的、再修補的', 3, c1.lines, true);
            const c2 = run(cat('theirs')); if (c2.clean) push('theirs+ours', '兩邊都插在同一處：先修補的、再你的', 3, c2.lines, true);
        }
        return cands.sort((x, y) => x.cost - y.cost);
    }

    function runHunks(file, source, lang, choices, o) { // 亂序時是「有脈絡的先、純插入的後」處理，這裡把結果依 hunk 順序排好
        const r = runHunks0(file, source, lang, choices, o); r.results.sort((x, y) => x.index - y.index); if (r.failedAt != null) r.failedRes = r.results.find((x) => x.index === r.failedAt + 1) || r.results[r.results.length - 1]; return r;
    }
    function runHunks0(file, source, lang, choices, o) {
        const prof = profileOf(lang);
        let text = source; const crlfCount = (text.match(/\r\n/g) || []).length, lfCount = (text.match(/\n/g) || []).length - crlfCount; const crlf = crlfCount > lfCount;
        let cur = text.split('\n'); let finalNl = false; if (cur.length && cur[cur.length - 1] === '') { cur.pop(); finalNl = true; }
        // 片段順序：由上而下（行號不遞減）走原本的「接著上一個往後找」；亂序時改成「全檔找、不能蓋到已套用的區域」，位移依原始行號位置累計（不依處理順序）
        const starts = file.hunks.map((x) => x.oldStart).filter((x) => x != null); const monotone = starts.every((x, i) => i === 0 || x >= starts[i - 1]);
        const st = { cur, from: 0, delta: 0, carry: 0, crlf, lang, useBlocked: !monotone, blocked: [], applied: [] };
        st.free = (p, len) => !st.blocked.some((b) => p < b[1] && b[0] < p + Math.max(1, len));
        const unitsFn = o && o.unitsFn; const resolveOn = !!(o && o.resolve); const CH = choices || {}; const CONF = CH.conf || {};
        const results = []; let ambiguous = null;
        const anchored = (x) => x.ops.some((p) => p.t !== '+' && /\S/.test(p.s)); const order = file.hunks.map((_, i) => i); if (!monotone) order.sort((x, y) => (anchored(file.hunks[y]) ? 1 : 0) - (anchored(file.hunks[x]) ? 1 : 0) || x - y); // 沒有脈絡的純插入最後處理：先靠有脈絡的 hunk 校準使用者造成的位移
        for (const hi of order) {
            const h = file.hunks[hi]; const res = { index: hi + 1, header: h.oldStart == null ? '@@' : '@@ -' + h.oldStart + ' @@', status: 'failed' };
            if (!monotone && h.oldStart != null) { let d = 0, bs = -1, c = 0; for (const ap of st.applied) if (ap.s < h.oldStart) { d += ap.d; if (ap.s > bs) { bs = ap.s; c = ap.carry; } } st.delta = d; st.carry = c; }
            const stv = st.useBlocked ? Object.assign({}, st, { from: 0 }) : st; // 亂序：不用「從上一個之後」的限制
            let plan = planHunk(h, stv, prof, { lang });
            if (plan.kind === 'region') plan = planRegion(h, plan, stv, prof, { lang, unitsFn });
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
                let picked = null;
                if (!m.clean) { // 4.2 衝突階梯：縮小衝突 → 候選解法（兩邊都保留）；每個候選都要過檢查器／判題器才算數
                    const cands = resolveOn ? conflictCandidates(baseL, ours, theirs, { cr, canJudge: !!(o && o.canJudge) }) : [];
                    if (cands.length) {
                        const pick = CONF[hi];
                        if (pick == null) { res.status = 'conflict'; res.line = plan.lo + 1; res.reason = '你的程式與修補在同一處都改了（' + m.conflicts.length + ' 處衝突）；有 ' + cands.length + ' 個候選解法待驗證'; results.push(res); return { ok: false, results, failedAt: hi, conflict: { hunk: hi, cands: cands.map((c) => ({ id: c.id, label: c.label, cost: c.cost })), all: cands } }; }
                        picked = cands.find((c) => c.id === pick) || null;
                    }
                    if (!picked) { res.status = 'conflict'; res.line = plan.lo + 1; res.reason = '你的程式與修補在同一處都改了（' + m.conflicts.length + ' 處衝突）' + (resolveOn ? '；縮小衝突與候選解法都不適用' : ''); res.conflictText = m.lines.map(strip).join('\n'); res.conflicts = m.conflicts.map((c) => ({ ours: c.ours.map(strip), base: c.base.map(strip), theirs: c.theirs.map(strip) })); results.push(res); return { ok: false, results, failedAt: hi }; }
                }
                lo = plan.lo; hiIdx = plan.hi; lines = picked ? picked.lines : m.lines; status = plan.how === 'unit' ? 'unit' : 'merged'; extra.note = '保留你的修改並合入修補（' + (plan.unitName ? '函式 ' + (plan.unitQual || plan.unitName) + ' 內，' : '') + '錨點 ' + plan.anchors + '/' + plan.meaningful + ' 行）';
                if (picked) { status = 'resolved'; extra.resolvedBy = picked.id; extra.note = '衝突已解決：' + picked.label + '（候選驗證通過）；' + extra.note; }
                if (lines.length === hiIdx - lo && lines.every((x, i) => cur[lo + i] === x)) { status = 'already'; extra.note = '合併後與目前相同（修補的內容你已經改好了）'; }
            }
            const before = cur.slice(lo, hiIdx); const sameAsBefore = lines.length === before.length && lines.every((x, i) => x === before[i]);
            if (!sameAsBefore) { cur.splice(lo, hiIdx - lo, ...lines); }
            const oldLen = h.ops.filter((x) => x.t !== '+').length, newLen = h.ops.filter((x) => x.t !== '-').length;
            const baseExp = h.oldStart == null ? null : (oldLen ? h.oldStart - 1 : h.oldStart) + st.delta;
            if (baseExp != null && status !== 'already') st.carry = lo - baseExp; // 使用者改動造成的位移，帶給下一個 hunk
            { const dl = lines.length - (hiIdx - lo); if (st.useBlocked) { for (const b of st.blocked) if (b[0] >= hiIdx) { b[0] += dl; b[1] += dl; } if (!sameAsBefore) st.blocked.push([lo, lo + lines.length]); if (h.oldStart != null) st.applied.push({ s: h.oldStart, d: newLen - oldLen, carry: st.carry }); } } // 亂序模式：記下已套用的區域
            st.delta += newLen - oldLen; st.from = lo + lines.length;
            if (hiIdx >= cur.length - (lines.length - (hiIdx - lo)) && (h.newNoNl || h.oldNoNl)) { if (h.newNoNl) finalNl = false; else if (h.oldNoNl) finalNl = true; }
            Object.assign(res, { status, line: lo + 1, offset: baseExp == null ? null : lo - baseExp }, extra); results.push(res);
        }
        return { ok: true, results, source: cur.join('\n') + (finalNl ? '\n' : '') };
    }

    // ---------- 主流程 ----------
    const LABEL = { applied: '原位置', relocated: '行號位移後找到', fuzzy: '忽略空白／脈絡差異', unit: '函式內錨點＋三方合併', merged: '三方合併', already: '已套用', conflict: '衝突', resolved: '衝突已解決（候選驗證通過）', ambiguous: '位置有歧義', failed: '失敗' };
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
        let verifies = 0;
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
        o.resolve = o.resolve !== false && canVerify; o.canJudge = !!a.judge; // 4.2 衝突階梯要有裁判才開
        if (a.parser && lang === 'python' && o.unitsFn === undefined) o.unitsFn = (src) => { const u = treeUnits(a.parser, src); return u.hasError && Edit && Edit.splitUnits ? Edit.splitUnits(lang, src) : u; }; // 有語法錯誤時語法樹不可靠，改用詞法切分 // 有語法樹就用語法樹找函式邊界
        const attempts = [];
        const passes = []; let lastFail = null; let lastRun = null;
        const search = async (choices) => {
            const r = runHunks(file, a.source, lang, choices, o); lastRun = r;
            if (!r.ok) {
                if (r.ambiguous && canVerify) { for (const c of r.ambiguous.cands) { if (verifies >= LIMITS.maxVerify) { gaps.push('驗證次數用完（' + LIMITS.maxVerify + '），不再試其他候選位置'); break; } await search(Object.assign({}, choices, { [r.ambiguous.hunk]: c })); } return; }
                if (r.conflict) { // 4.2：逐一驗證候選解法，由便宜到貴
                    for (const c of r.conflict.all) {
                        if (verifies >= LIMITS.maxVerify) { gaps.push('驗證次數用完（' + LIMITS.maxVerify + '），不再試其他衝突解法'); break; }
                        const next = Object.assign({}, choices, { conf: Object.assign({}, choices.conf || {}, { [r.conflict.hunk]: c.id }) });
                        const before = passes.length; await search(next);
                        const passed = passes.length > before; attempts.push({ hunk: r.conflict.hunk + 1, id: c.id, label: c.label, passed, why: passed ? null : (lastFail && lastFail.why) || null });
                    }
                    return;
                }
                lastFail = { why: '第 ' + (r.failedAt + 1) + ' 個 hunk：' + ((r.failedRes && r.failedRes.reason) || ''), run: r }; return;
            }
            if (r.source === a.source) { passes.push({ r, noop: true, choices }); return; }
            const ver = await verify(r.source);
            if (ver.pass) passes.push({ r, v: ver.v, choices }); else lastFail = { why: ver.why, run: r, unavailable: ver.unavailable };
        };
        await search({});
        if (passes.length > 1 && !passes.some((p) => Object.keys(p.choices).some((k) => k !== 'conf'))) { // 只有「衝突解法」不同的多個通過者：選成本最低的（沒辦法分高下時問模型一次，沒有模型就用程式預設並標明）
            const RANK = { shrink: 1, token: 2, 'ours+theirs': 3, 'theirs+ours': 3 }; const costOf = (p) => p.r.results.reduce((n, x) => n + (x.resolvedBy ? RANK[x.resolvedBy] || 9 : 0), 0);
            passes.sort((x, y) => costOf(x) - costOf(y)); const tied = passes.filter((p) => costOf(p) === costOf(passes[0])); let best = passes[0]; let by = 'program';
            if (tied.length > 1 && typeof a.ask === 'function') { try { const letters = tied.map((_, i) => String.fromCharCode(65 + i)); const msgs = [{ role: 'system', content: '有多個衝突解法都通過驗證。只輸出 JSON：{"pick":"字母"}，選最能保留雙方意圖的一個。' }, { role: 'user', content: tied.map((p, i) => letters[i] + '. ' + p.r.results.filter((x) => x.resolvedBy).map((x) => x.note).join('；')).join('\n') }]; const v = await a.ask(msgs, (x) => (x && letters.indexOf(String(x.pick || '').toUpperCase()) >= 0 ? [] : ['「pick」必須是 ' + letters.join('、') + ' 其中一個'])); if (v) { best = tied[letters.indexOf(String(v.pick).toUpperCase())]; by = 'model'; } } catch (e) { gaps.push('選擇題出錯：' + clip(e && e.message, 80)); } }
            gaps.push('衝突有 ' + passes.length + ' 種解法都通過驗證，由' + (by === 'model' ? '模型' : '程式（成本最低）') + '選定；其餘：' + passes.filter((p) => p !== best).map((p) => p.r.results.filter((x) => x.resolvedBy).map((x) => x.resolvedBy).join('+')).join('、'));
            best.chosenBy = by; passes.splice(0, passes.length, best);
        }
        if (passes.length === 1) {
            const p = passes[0]; const r = p.r; const noop = r.results.every((x) => x.status === 'already') || r.source === a.source;
            const verified = { syntax: p.v ? p.v.syntax : baseSyntax, tests: p.v ? p.v.tests : (baseJudge && baseJudge.verdict) || null };
            if (!canVerify) gaps.push('沒有檢查器也沒有判題器：只是文字層面合併，沒有驗證（verified:false）'); else if (!a.judge) gaps.push('沒有判題器：只確認語法，沒有驗證行為');
            return out({ ok: true, status: noop ? 'already_applied' : 'merged', source: r.source, changed: r.source !== a.source, noop, hunks: r.results, verified, verifiedAny: canVerify, gaps, diff: r.source !== a.source ? makeDiff(a.source.replace(/\r\n/g, '\n'), r.source.replace(/\r\n/g, '\n'), { oldName: 'a/' + (file.oldName || 'source'), newName: 'b/' + (file.newName || 'source') }) : '', baseHash: hash(a.source), baseSyntax, warnings: pd.warnings, attempts, chosenBy: p.chosenBy || null, resolved: r.results.some((x) => x.status === 'resolved') });
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
        return out({ status, reason: why + '。已回滾，你的程式沒有被改動。', hunks, gaps, rolledBack: true, attempts, conflictText: (bad && bad.conflictText) || undefined });
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

    return { PROFILES, LIMITS, treeUnits, conflictCandidates, parseDiff, applyPatch, applyPatchFiles, merge3, makeDiff, diffMatches, report, norm };
});
