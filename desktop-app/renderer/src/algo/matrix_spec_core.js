/* 矩陣層：使用者只有「需求」沒有測資時的流程（設計 §5），與「待補教學」佇列（設計 §10 (c)）。純函式 UMD，不問模型，不做檔案 I/O（檔案讀寫交給宿主）。
 *
 * 規則（設計 §5、使用者原話「規格不足時明說並標 verified 狀態，不可湊出範例對」）：
 *   1. 沒有範例時矩陣層沒有東西可擬合 —— 回 needExamples:true（待補規格 ≠ 解不出）、verified:false，不產生程式、不編造答案。
 *   2. 從敘述讀出輸入形狀，隨機生成小輸入（proposeInputs），交給：
 *        a. 預言機（參考解／使用者貼的程式／舊版程式）→ 答案由預言機算，才有範例；verified 以預言機一致為準；
 *        b. 使用者（卡片：問最有鑑別力的 3～5 個輸入）→ 使用者答了才算範例；
 *        c. 都沒有 → 候選程式（若有）只能 verified:false 並明說「從敘述推的，沒有被任何範例驗證」。
 *   3. 合成出多個候選時，在生成輸入上比對輸出，不一致的輸入就是最有價值的提問（pickDiscriminating）。
 *
 *   proposeInputs(statement, {count, seed}) → {ok, shape, inputs:[字串], reason}
 *   specFlow({statement, examples, oracle, answers, synth, count, seed}) → 見函式註解
 *   teachEntry / queueLine / parseQueue / mergeQueue / fallbackInfo：待補教學佇列（JSONL，一題一行）與 buildFromUML 失敗時的 fallback 欄位 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixSpec = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // ---- 可重現的亂數 ----
    function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
    const ri = (r, a, b) => a + Math.floor(r() * (b - a + 1));
    const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
    const num = (t) => { t = String(t).replace(/[,，\s]/g, ''); let m = /^10\^(\d+)$/.exec(t); if (m) return Math.pow(10, Number(m[1])); m = /^(\d+)\*10\^(\d+)$/.exec(t); if (m) return Number(m[1]) * Math.pow(10, Number(m[2])); return /^-?\d+$/.test(t) ? Number(t) : null; };
    const NUMPAT = '-?\\d+(?:\\s*[\\^×*]\\s*\\d+)*';
    // 範圍片段：「1 到 3000」「-50 到 50」「0 ≤ k ≤ n ≤ 20」
    function parseRange(txt) { const m = new RegExp('(' + NUMPAT + ')\\s*(?:到|~|～|至|-)\\s*(' + NUMPAT + ')').exec(txt.replace(/\s*[×*]\s*/g, '*')); if (m) { const a = num(m[1].replace(/\s/g, '')), b = num(m[2].replace(/\s/g, '')); if (a !== null && b !== null && a <= b) return [a, b]; } const ms = /(?:≤|<=)\s*(\d+(?:\^\d+)?)/.exec(txt); if (ms) { const b = num(ms[1]); if (b !== null) return [0, b]; } return null; }
    const clampRange = (rg, cap) => [Math.max(rg[0], -cap), Math.min(rg[1], cap)];
    // ---- 讀輸入形狀：只看「輸出」之前的輸入描述；回傳 {kind, ...} ----
    const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const NUM = '(?:10\\s*\\^\\s*\\d+|\\d+)';
    const val = (t) => { t = String(t).replace(/\s/g, ''); const m = /^10\^(\d+)$/.exec(t); return m ? Math.pow(10, Number(m[1])) : Number(t); };
    // 取得變數 name 的範圍：1≤n≤10^5 ／ n≤1000 ／ n（0 到 70）／ n 為 1 到 50；找不到回 null
    function boundsOf(txt, name) {
        const nm = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); let m;
        m = new RegExp('(' + NUM + ')\\s*(?:≤|<=)\\s*' + nm + '\\s*(?:≤|<=)\\s*(' + NUM + ')').exec(txt); if (m) return [val(m[1]), val(m[2])];
        m = new RegExp('\\b' + nm + '\\s*(?:為|是|在)?\\s*(-?' + NUM + ')\\s*(?:到|～|~|至)\\s*(-?' + NUM + ')').exec(txt); if (m) return [val(m[1]), val(m[2])];
        m = new RegExp('\\b' + nm + '[^，。；]{0,6}?[（(]\\s*(-?' + NUM + ')\\s*(?:到|～|~|至)\\s*(-?' + NUM + ')').exec(txt); if (m) return [val(m[1]), val(m[2])];
        m = new RegExp('\\b' + nm + '\\s*(?:≤|<=)\\s*(' + NUM + ')').exec(txt); if (m) return [/正|1/.test(txt.slice(0, 40)) ? 1 : 0, val(m[1])];
        return null;
    }
    const commonRange = (txt) => { let m = new RegExp('(?:每個|各|皆為?|都是)\\s*(-?' + NUM + ')\\s*(?:到|～|~|至)\\s*(-?' + NUM + ')').exec(txt) || new RegExp('[（(]\\s*(-?' + NUM + ')\\s*(?:到|～|~|至)\\s*(-?' + NUM + ')\\s*[)）]').exec(txt) || new RegExp('(?:絕對值|\\|[a-z]\\|)\\s*(?:≤|<=)\\s*(' + NUM + ')').exec(txt); if (!m) return null; if (m.length === 2) return [-val(m[1]), val(m[1])]; return [val(m[1]), val(m[2])]; };
    function readShape(st) {
        const s0 = String(st); const cut = s0.search(/輸出|印出|印\s*[A-Za-z]|是否|有沒有|有幾種|有幾個|幾種|多少/); const s = cut > 0 ? s0.slice(0, cut) : s0; let m;
        // 圖：第一行 n m …，接著 m 行 a b [w]
        if ((m = /第一行\s*n\s*m(?:\s*k)?[^，。]*[，,]\s*接著\s*m\s*行[^，。]*?\b([a-z])\s+([a-z])(?:\s+([a-z]))?/.exec(s0)) || (m = /首行\s*n\s*m[^，。]*[，,]\s*之後\s*m\s*行[^，。]*?\b([a-z])\s+([a-z])(?:\s+([a-z]))?/.exec(s0))) {
            const nb = boundsOf(s0, 'n'); return { kind: 'GRAPH', weighted: !!m[3], acyclic: /無環|a\s*<\s*b|u\s*<\s*v|x\s*<\s*y/.test(s0), zero: /0\s*(?:到|～|\.\.)\s*n\s*-\s*1/.test(s0), walks: /第一行\s*n\s*m\s*k/.test(s0), nr: nb || [2, 7], st: /最後一行\s*s\s*t|最後一行是\s*s/.test(s0) };
        }
        // 格子／矩陣：第一行 r c，接著 r 行 …
        if (/第一行\s*r\s*c[，,]\s*接著\s*r\s*行/.test(s0)) { const chars = /(c\s*個字元|\. 或 #|\.\s*或\s*#)/.test(s0); return { kind: 'GRID', chars, alpha: /\.\s*或\s*#|# 是|\. 是/.test(s0) ? '.#' : 'abc' }; }
        if (/第一行\s*n\s*k[，,]\s*接著\s*n\s*行[^，。]*方陣|第一行\s*n\s*n[，,]\s*接著\s*n\s*行/.test(s0)) return { kind: 'SQUARE', withK: /第一行\s*n\s*k/.test(s0), range: (() => { const mm = /元素[^，。]*?(\d+)\s*(?:到|～|~)\s*(\d+)/.exec(s0); return mm ? [Number(mm[1]), Number(mm[2])] : [0, 3]; })() };
        // 逐行文字
        if (/第一行是\s*n[，,]\s*接著\s*n\s*行/.test(s0)) return { kind: 'NL' };
        if (/第一行是(?:搜尋)?字串\s*pat[，,]\s*第二行是\s*n[，,]\s*接著\s*n\s*行|第一行是\s*pat[，,]\s*第二行是\s*n/.test(s0)) return { kind: 'PNL' };
        // 區間：第一行 n，接著 n 行每行兩個整數 l r
        if ((m = /第一行\s*n[，,]\s*接著\s*n\s*行每行兩個整數\s*([a-z])\s+([a-z])/.exec(s0))) return { kind: 'PAIRS', range: commonRange(s0) || [0, 20] };
        // n（與 k…）＋ n 個整數
        if ((m = /第一行(?:是)?(?:奇數\s*)?([a-z])((?:\s*(?:與|和)?\s*[a-z]){0,2})[，,]\s*第二行(?:是)?\s*\1\s*個(?:非負|遞增|正)?整數/.exec(s0))) {
            const hdr = [m[1]].concat((m[2].match(/[a-z]/g) || [])); const rg = commonRange(s0.slice(m.index + m[0].length)) || (/正整數/.test(m[0]) ? [1, 20] : [-9, 30]); return { kind: 'HDR-LIST', header: hdr, range: rg, odd: /奇數/.test(m[0]), sortedList: /遞增/.test(m[0]), nr: boundsOf(s0, 'n') || [1, 9], positive: /正整數/.test(m[0]) };
        }
        if (/第一行\s*n[，,]\s*第二行\s*n\s*個整數[^；]*；\s*第三行\s*m/.test(s0) || /第一行是\s*n[，,]\s*第二行是\s*n\s*個遞增整數[^；]*；第三行是\s*m/.test(s0)) return { kind: 'TWO-LISTS' };
        // 兩行小寫字串
        if (/兩行小寫字串/.test(s0)) return { kind: 'TWO-STR', alpha: ALPHA['小寫'] };
        // 以空格分隔的單字
        if (/一行以空格分隔的小寫單字/.test(s0)) return { kind: 'WORDS' };
        // 單行字串：由 a、b 組成／只含 ()[]{}／小寫字串
        const lm = /長度\s*(\d+)\s*(?:到|～|~|至)\s*(\d+)/.exec(s0); const len = lm ? [Number(lm[1]), Number(lm[2])] : [1, 8];
        if ((m = /(?:由|只含)\s*((?:[A-Za-z0-9])(?:\s*[、,，]\s*[A-Za-z0-9])*)\s*(?:組成|\s*的)/.exec(s))) { const ch = m[1].split(/[、,，\s]+/).filter(Boolean).join(''); return { kind: 'STR', chars: ch, len }; }
        if ((m = /只含\s*((?:[()\[\]{}]\s*)+)/.exec(s))) { const ch = m[1].replace(/\s/g, ''); return { kind: 'STR', chars: ch, len, balanced: /配對正確|合法/.test(s0) }; }
        if (/(?:一行|輸入)(?:只含)?(?:一個)?(小寫|大寫|英數字)/.test(s) && /字串|文字|字母/.test(s)) { const k = /(小寫|大寫|英數字)/.exec(s)[1]; return { kind: 'STR', chars: ALPHA[k], len }; }
        // 一行整數：k 個（名字可有可無）
        let names = null, cnt = null;
        if ((m = new RegExp('輸入[^，。（(]*?([一二兩三四五六])個[^，。（(]*?整數\\s*((?:[a-zA-Z]\\w*\\s*){0,6})').exec(s))) { cnt = CN[m[1]]; names = (m[2] || '').trim().split(/\s+/).filter((x) => /^[a-zA-Z]\w*$/.test(x)); }
        else if ((m = /輸入[^，。（(]*?整數\s*((?:[a-zA-Z]\w*\s*){1,6})/.exec(s))) names = m[1].trim().split(/\s+/).filter((x) => /^[a-zA-Z]\w*$/.test(x));
        else if ((m = /輸入\s*((?:[a-zA-Z]\w*\s*){1,4})(?=[（(，。]|\s*$)/.exec(s)) && !/字串/.test(s)) names = m[1].trim().split(/\s+/).filter((x) => /^[a-zA-Z]\w*$/.test(x));
        else if ((m = /^\s*(?:輸入)?[^。]*?\b([a-zA-Z])\s*[（(]\s*(?:\d|-)/.exec(s)) && /整數|正整數|n/.test(s) === false) names = [m[1]];
        if (!names && !cnt) { const q = /^[^，。]*?(?:輸入|給定)?\s*(?:一個|兩個)?(?:正)?整數\s*([a-z])/.exec(s); if (q) names = [q[1]]; }
        if (names && names.length === 0) names = null;
        if (names || cnt) { const k = cnt || names.length; const nm = names && names.length === k ? names : Array.from({ length: k }, (_, i) => 'x' + i); return { kind: 'INTS', names: nm, ranges: Object.fromEntries(nm.map((x) => [x, boundsOf(s0, x)]).filter((p) => p[1])), dflt: commonRange(s), strict: /保證\s*l\s*<=\s*r|k\s*≤\s*n/.test(s0) ? 'le' : null }; }
        return null;
    }
    const ALPHA = { 小寫: 'abcdefghijklmnopqrstuvwxyz', 大寫: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 英數字: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 數字: '0123456789', 括號: '()' };
    function proposeInputs(statement, opt) {
        opt = opt || {}; const count = opt.count || 8; const r = rng(opt.seed || 20261111); const sh = readShape(statement);
        if (!sh) return { ok: false, reason: '敘述的輸入格式讀不出來（沒有看到「輸入…整數」「一行…字串」「第一行 n m…」這類說法）', inputs: [] };
        const out = []; const seen = new Set(); let guard = 0; const small = (lo, hi, bias) => { lo = Math.max(lo, -1e9); hi = Math.min(hi, 1e9); const top = r() < (bias || 0.6) ? Math.min(hi, lo + 30) : hi; return ri(r, lo, Math.max(lo, top)); };
        const strOf = (chars, len) => { const L = ri(r, len[0], Math.min(len[1], len[0] + 8)); return Array.from({ length: L }, () => chars[Math.floor(r() * chars.length)]).join(''); };
        const balancedOf = (chars, len) => { const pairs = []; for (const [o, c] of ['()', '[]', '{}']) if (chars.includes(o) && chars.includes(c)) pairs.push([o, c]); if (!pairs.length) return strOf(chars, len); const st = []; let s = ''; const L = Math.max(2, ri(r, len[0], Math.min(len[1], len[0] + 8))); while (s.length + st.length < L - 1 || (st.length && s.length < L)) { if (st.length && (r() < 0.5 || s.length + st.length >= L - 1)) { s += st.pop(); } else if (s.length + st.length < L - 1) { const p = pick(r, pairs); s += p[0]; st.push(p[1]); } else break; } while (st.length) s += st.pop(); return s; };
        while (out.length < count && guard++ < count * 40) {
            let t;
            if (sh.kind === 'STR') t = (sh.balanced ? (r() < 0.6 ? balancedOf(sh.chars, sh.len) : strOf(sh.chars, sh.len)) : strOf(sh.chars, sh.len)) + '\n';
            else if (sh.kind === 'TWO-STR') { const a = strOf(sh.alpha.slice(0, 4), [2, 6]); const b = r() < 0.5 ? a.split('').sort(() => r() - 0.5).join('') : strOf(sh.alpha.slice(0, 4), [2, 6]); t = a + '\n' + b + '\n'; }
            else if (sh.kind === 'WORDS') t = Array.from({ length: ri(r, 3, 8) }, () => strOf('abc', [1, 2])).join(' ') + '\n';
            else if (sh.kind === 'INTS') { const vals = sh.names.map((nm) => { const rg = sh.ranges[nm] || sh.dflt || [1, 20]; return small(rg[0], rg[1]); }); if (sh.strict === 'le' && vals.length === 3) vals.splice(1, 2, ...[vals[1], vals[2]].sort((a, b) => a - b)); t = vals.join(' ') + '\n'; }
            else if (sh.kind === 'NL') { const n = ri(r, 1, 5); t = n + '\n' + Array.from({ length: n }, () => Array.from({ length: ri(r, 2, 6) }, () => 'abcdxyz '[Math.floor(r() * 8)]).join('').trim() || 'a').join('\n') + '\n'; }
            else if (sh.kind === 'PNL') { const n = ri(r, 2, 6); t = pick(r, ['a', 'ab', 'x']) + '\n' + n + '\n' + Array.from({ length: n }, () => strOf('abcdx', [2, 6])).join('\n') + '\n'; }
            else if (sh.kind === 'HDR-LIST') {
                let n = ri(r, sh.nr[0], Math.min(sh.nr[1], 8)); if (sh.odd && n % 2 === 0) n = Math.max(1, n - 1); const rg = [Math.max(sh.range[0], sh.positive ? 1 : -50), Math.min(sh.range[1], 50)];
                let a = Array.from({ length: n }, () => ri(r, rg[0], Math.max(rg[0], rg[1]))); if (sh.sortedList) a = [...new Set(a)].sort((x, y) => x - y); n = a.length;
                const extra = sh.header.slice(1).map(() => ri(r, 0, 10)); const hdr = sh.header.length > 1 && sh.header[1] !== 'n' && sh.header[0] !== 'n' ? null : null; void hdr;
                const vals = sh.header.map((h, i) => (h === 'n' ? n : extra[i - 1] !== undefined ? extra[i - 1] : 1)); t = vals.join(' ') + '\n' + a.join(' ') + '\n';
            }
            else if (sh.kind === 'TWO-LISTS') { const mk = () => { const k = ri(r, 2, 6); return [...new Set(Array.from({ length: k }, () => ri(r, 0, 14)))].sort((x, y) => x - y); }; const a = mk(), b = mk(); t = a.length + '\n' + a.join(' ') + '\n' + b.length + '\n' + b.join(' ') + '\n'; }
            else if (sh.kind === 'PAIRS') { const n = ri(r, 2, 6); const rg = [Math.max(sh.range[0], 0), Math.min(sh.range[1], 20)]; t = n + '\n' + Array.from({ length: n }, () => { const x = ri(r, rg[0], rg[1]), y = ri(r, rg[0], rg[1]); return Math.min(x, y) + ' ' + Math.max(x, y); }).join('\n') + '\n'; }
            else if (sh.kind === 'GRID') { const rr = ri(r, 2, 5), cc = ri(r, 2, 5); t = rr + ' ' + cc + '\n' + Array.from({ length: rr }, () => (sh.chars ? Array.from({ length: cc }, () => sh.alpha[Math.floor(r() * sh.alpha.length)]).join('') : Array.from({ length: cc }, () => ri(r, -9, 20)).join(' '))).join('\n') + '\n'; }
            else if (sh.kind === 'SQUARE') { const n = ri(r, 2, 4); const k = ri(r, 1, 5); t = (sh.withK ? n + ' ' + k : n + ' ' + n) + '\n' + Array.from({ length: n }, () => Array.from({ length: n }, () => ri(r, sh.range[0], sh.range[1])).join(' ')).join('\n') + '\n'; }
            else if (sh.kind === 'GRAPH') {
                const n = ri(r, Math.max(2, sh.nr[0]), Math.min(sh.nr[1], 7)); const off = sh.zero ? 0 : 1; const maxM = Math.min(8, n * (n - 1) / 2); const m = ri(r, 1, Math.max(1, maxM)); const es = new Set(); const E = [];
                let g2 = 0; while (E.length < m && g2++ < 50) { let a = ri(r, 0, n - 1), b = ri(r, 0, n - 1); if (a === b) continue; if (sh.acyclic && a > b) [a, b] = [b, a]; const key = a + ',' + b; if (es.has(key)) continue; es.add(key); E.push([a + off, b + off, ri(r, 1, 9)]); }
                t = n + ' ' + E.length + (sh.walks ? ' ' + ri(r, 1, 4) : '') + '\n' + E.map((e) => (sh.weighted ? e.join(' ') : e[0] + ' ' + e[1])).join('\n') + '\n' + (sh.st ? ri(r, off, n - 1 + off) + ' ' + ri(r, off, n - 1 + off) + '\n' : '');
            }
            if (t && !seen.has(t)) { seen.add(t); out.push(t); }
        }
        return { ok: out.length > 0, shape: sh.kind, inputs: out, reason: out.length ? '' : '生成不出不重複的輸入' };
    }
    // ---- 鑑別力：在輸入上讓候選答案最不一致的先問 ----
    function pickDiscriminating(cands, inputs, k) { // cands: [{id, run:(in)=>string}]；回傳前 k 個輸入與各候選答案
        const scored = []; for (const inp of inputs) { const outs = new Map(); for (const c of cands) { let v; try { v = String(c.run(inp)); } catch (e) { v = '\u0000err'; } (outs.get(v) || outs.set(v, []).get(v)).push(c.id); } if (outs.size > 1) scored.push({ in: inp, groups: [...outs.entries()].map(([out, ids]) => ({ out, ids })), score: outs.size - 1 + 1 / (1 + Math.max(...[...outs.values()].map((x) => x.length))) }); }
        scored.sort((a, b) => b.score - a.score); return scored.slice(0, k || 4);
    }
    /* specFlow：
     *   input : {statement, examples?, oracle?: async (in)=>string, answers?: [{in,out}]（使用者在卡片上補的）, synth: async ({statement, examples})=>結果, count, seed}
     *   output: {status, verified, dataSource, examples, inputs, result?, card?, reason}
     *     status: 'solved'（有範例且合成成功）｜'need-examples'（待補規格，不是解不出）｜'unsolved'（有範例但合成不出）｜'cannot-read'（敘述讀不出輸入格式）
     *     dataSource: 'given'｜'oracle'｜'user-answers'｜'none' —— 每個結果都標資料來源（設計 §5）。 */
    async function specFlow(o) {
        const st = String(o.statement || ''); let examples = (o.examples || []).filter((e) => e && typeof e.in === 'string' && typeof e.out === 'string'); let dataSource = examples.length ? 'given' : 'none';
        const gen = proposeInputs(st, { count: o.count || 8, seed: o.seed });
        if (!examples.length && o.answers && o.answers.length) { examples = o.answers.filter((e) => e && typeof e.in === 'string' && typeof e.out === 'string' && e.out.trim() !== ''); if (examples.length) dataSource = 'user-answers'; }
        if (!examples.length && o.oracle) {
            if (!gen.ok) return { status: 'cannot-read', verified: false, dataSource: 'none', examples: [], inputs: [], reason: gen.reason };
            const ex = []; for (const inp of gen.inputs.slice(0, o.nExamples || 4)) { let out; try { out = await o.oracle(inp); } catch (e) { continue; } if (out !== undefined && out !== null) ex.push({ in: inp, out: String(out) }); }
            if (ex.length) { examples = ex; dataSource = 'oracle'; }
        }
        if (!examples.length) {
            // 規格不足：不啟動合成，不編造答案；把生成的輸入做成卡片請使用者補輸出
            if (!gen.ok) return { status: 'cannot-read', verified: false, dataSource: 'none', examples: [], inputs: [], reason: gen.reason, card: null };
            return { status: 'need-examples', verified: false, dataSource: 'none', examples: [], inputs: gen.inputs, reason: '只有敘述、沒有範例：沒有東西可擬合。已生成 ' + gen.inputs.length + ' 個輸入，請補上期望輸出（補 3 個以上最好）；在補上之前，任何程式都只能標「從敘述推的，沒有被任何範例驗證」。', card: askCard(st, gen.inputs.slice(0, 5), null) };
        }
        const r = await o.synth({ statement: st, examples });
        if (!r || !r.ok) return { status: 'unsolved', verified: false, dataSource, examples, inputs: gen.inputs, result: r || null, reason: (r && r.reason) || '合成不出' };
        // 驗證狀態：用預言機在「沒用來學的」生成輸入上比對（最強）；否則看合成器自己的 verified（隱藏測資／holdout）
        let verified = !!r.verified, check = null;
        if (o.oracle && r.source && o.runSource && gen.ok) {
            const fresh = gen.inputs.filter((i) => !examples.some((e) => e.in === i)); let pass = 0, n = 0; for (const inp of fresh) { let want, got; try { want = String(await o.oracle(inp)); got = String(await o.runSource(r.source, inp)); } catch (e) { continue; } n++; if (want.trim().split(/\s+/).join(' ') === got.trim().split(/\s+/).join(' ')) pass++; }
            check = { n, pass }; verified = n > 0 && pass === n && !r.ambiguous;
        } else if (dataSource === 'user-answers' || dataSource === 'none') verified = false;
        const note = verified ? '' : dataSource === 'oracle' ? '預言機一致性不足或有多個候選' : '沒有獨立資料驗證（只對著範例）：從敘述與少量範例推的';
        return { status: 'solved', verified, dataSource, examples, inputs: gen.inputs, result: r, check, reason: note, card: r.ambiguous && r.suggest && r.suggest.length ? askCard(st, r.suggest.map((s) => s.in), r.suggest) : null };
    }
    function askCard(st, inputs, suggest) {
        return { title: suggest ? '再確認幾個輸入的答案' : '請補上期望輸出', question: suggest ? '目前有多個程式都符合你給的範例，下面這些輸入它們的答案不一樣，請選或填正確的輸出。' : '你只給了需求，沒有範例。請替下面的輸入填上期望輸出（可以只填幾個）。', items: inputs.map((inp, i) => ({ in: inp, candidates: suggest && suggest[i] ? suggest[i].candidates : null, out: '' })), honesty: '沒有填之前，產生的程式只標「從敘述推的，沒有被任何範例驗證」，不會標成已通過。' };
    }
    // ---- 待補教學佇列（設計 §10 (c)）----
    function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    function fallbackInfo(res, o) { // 失敗時掛在 buildFromUML 回傳上的 fallback 欄位（設計 §10.1）
        res = res || {}; o = o || {}; const rs = { reader: o.readerReason || '', paradigm: (res.rounds || []).filter((x) => /paradigm|lesson|recipe/.test(String(x.by))).map((x) => x.by + ':' + (x.verdict || x.ok)).join(','), matrix: res.matrixReason || res.reason || '' };
        const stage = o.readOk === false ? 'reader' : /矩陣|matrix/i.test(rs.matrix) && !res.ok ? 'matrix' : 'paradigm'; const next = ['online', 'colu', 'teach'];
        return { stage, reasons: rs, next, teach: { statement: String(o.statement || ''), examples: (o.examples || []).slice(0, 4), stuckAt: stage, missing: o.missing || '' } };
    }
    // 這題該走哪一層（§13.6）：成本由低到高＝blockly 教學（最快）→ 編成矩陣（要額外寫範本）→ 留給 LoRA（訓練最久）。
    //   讀取器讀得懂（stage 不是 reader）→ blockly 教學：缺的是骨架或課，補一課最便宜；
    //   讀不懂但有可見範例 → 編成矩陣：範例能驅動合成，但要寫範本；
    //   讀不懂也沒有範例 → 留給 LoRA（或先請使用者補範例，見 needExamples）。
    function routeOf(o) {
        const stage = o && o.stage; const n = Number((o && o.examples) || 0);
        if (stage !== 'reader') return { route: 'blockly-teach', cost: 1, why: '讀取器讀得懂，缺骨架或課：先補 blockly 教學' };
        if (n > 0) return { route: 'matrix', cost: 2, why: '讀不懂但有可見範例：編成矩陣範本（要額外寫範本）' };
        return { route: 'lora', cost: 3, why: '讀不懂且沒有範例：先請使用者補範例，否則留給 LoRA（訓練最久）' };
    }
    function teachEntry(o) {
        const st = String(o.statement || ''); const f = o.fallback || fallbackInfo(o.result, o);
        return { id: hash(norm(st)), ts: o.ts || new Date().toISOString(), needTeaching: true, statement: st, examples: (o.examples || []).slice(0, 4).map((e) => ({ in: e.in, out: e.out })), stuckAt: f.stage, route: routeOf({ stage: f.stage, examples: (o.examples || []).length }).route, reasons: f.reasons, missing: (f.teach && f.teach.missing) || o.missing || '', dataSource: o.dataSource || 'none', count: 1 };
    }
    const queueLine = (e) => JSON.stringify(e) + '\n';
    function parseQueue(text) { const out = []; for (const l of String(text || '').split('\n')) { const t = l.trim(); if (!t) continue; try { const e = JSON.parse(t); if (e && e.statement) out.push(e); } catch (err) { /* 壞行略過，不丟掉其他行 */ } } return out; }
    function mergeQueue(entries, add) { // 同一題（敘述正規化後相同）不重複記，更新次數與最新卡點
        const map = new Map(entries.map((e) => [e.id || hash(norm(e.statement)), e])); const id = add.id || hash(norm(add.statement)); const old = map.get(id);
        if (old) { old.count = (old.count || 1) + 1; old.ts = add.ts || old.ts; old.stuckAt = add.stuckAt || old.stuckAt; old.reasons = add.reasons || old.reasons; if ((add.examples || []).length > (old.examples || []).length) old.examples = add.examples; } else map.set(id, Object.assign({ id }, add));
        return [...map.values()];
    }
    const queueText = (entries) => entries.map(queueLine).join('');
    return { proposeInputs, readShape, pickDiscriminating, specFlow, askCard, fallbackInfo, teachEntry, routeOf, queueLine, parseQueue, mergeQueue, queueText, hash };
});
