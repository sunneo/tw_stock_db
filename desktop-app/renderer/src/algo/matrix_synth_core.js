/* 矩陣層後備（Blockly writer 評估不出來時用）：只靠「題目敘述＋範例」合成 Python 程式。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md。
 *
 *   synth({statement, examples, judge?, budget?}) → Promise<{ok, source, kind, level, size, tried, ambiguous, verified, holdout, reason}>
 *     examples: [{in, out}]（題目的 tests；隱藏測資不可放進來學）。judge(source) → Promise<{verdict}>，有給就在回報前再驗證一次（含隱藏測資）。
 *
 *   第一版涵蓋：
 *     L1 線性遞推：輸入一個整數 n、輸出一個整數；在「小階數＋小係數＋小初值」的有限空間枚舉遞推式（階數≤4、係數0..2、初值0..3、索引從 0 或 1），
 *        對所有範例用矩陣冪精確驗證（BigInt），第一個全對的就用；輸出是「伴隨矩陣快速冪」的 Python。這是有預算的枚舉，不是證明。
 *     L2 有限狀態（字串→是／否／整數）：枚舉自動機家族（某字元個數取模、數字串值取模、含／不含／開頭／結尾某子字串、子字串出現次數），
 *        參數必須在敘述裡出現過（敘述當先驗，避免兩個範例就湊出巧合的自動機），對所有範例驗證；輸出是轉移表＋迴圈的 Python。
 *   範例太少時會有多個候選全對：回報 ambiguous:true、verified:false（沒有被範例以外的資料驗證）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixSynth = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    // ---- 輸入／輸出形狀（從範例推，不靠讀取器）----
    function inferShape(examples) {
        if (!examples || !examples.length) return null;
        const lines = (s) => String(s).replace(/\s+$/, '').split('\n');
        let inKind = null, outKind = null; const labels = new Set();
        for (const e of examples) {
            const il = lines(e.in), ol = lines(e.out); if (il.length !== 1 || ol.length !== 1) return null;
            const itok = il[0].trim().split(/\s+/), otok = ol[0].trim().split(/\s+/); if (itok.length !== 1 || otok.length !== 1 || !itok[0] || !otok[0]) return null;
            const ik = isInt(itok[0]) ? 'int' : 'str'; if (inKind && inKind !== ik) { inKind = 'str'; } else inKind = ik;
            const ok = isInt(otok[0]) ? 'int' : 'label'; if (outKind && outKind !== ok) return null; outKind = ok; if (ok === 'label') labels.add(otok[0]);
        }
        if (outKind === 'label' && labels.size > 2) return null;
        return { in: inKind, out: outKind, labels: [...labels] };
    }
    // ---- L1：遞推枚舉 ----
    const P_MOD = 1000000007n;
    const matMul = (A, B, M) => { const n = A.length; const C = Array.from({ length: n }, () => Array(n).fill(0n)); for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const a = A[i][k]; if (a === 0n) continue; for (let j = 0; j < n; j++) C[i][j] += a * B[k][j]; } if (M) for (const r of C) for (let j = 0; j < n; j++) r[j] %= M; return C; };
    function matPow(A, e, M) { const n = A.length; let R = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1n : 0n))); let B = A; while (e > 0n) { if (e & 1n) R = matMul(R, B, M); B = matMul(B, B, M); e >>= 1n; } return R; }
    function modOf(statement) { if (/10\s*\^\s*9\s*\+\s*7|1000000007|1e9\s*\+\s*7/i.test(statement)) return 1000000007n; if (/998244353/.test(statement)) return 998244353n; return null; }
    // 前 24 項的簽名：初值不同但數列相同（例如多一個前導 0）不算兩個候選
    function seqSig(h, M) { const f = []; const init = h.iv.slice(); for (let k = 0; k < 24 + h.s; k++) { let v; if (k < h.d) v = BigInt(init[k]); else { v = 0n; for (let j = 0; j < h.d; j++) v += BigInt(h.cf[j]) * f[k - 1 - j]; if (M) v %= M; } f.push(v); } return f.slice(h.s).join(','); }
    function synthRecurrence(o) {
        const sh = inferShape(o.examples); if (!sh || sh.in !== 'int' || sh.out !== 'int') return { ok: false, reason: '不是「一個整數進、一個整數出」' };
        const M = modOf(o.statement); const ex = o.examples.map((e) => ({ n: BigInt(e.in.trim()), y: BigInt(e.out.trim()) }));
        if (!M && ex.some((e) => e.n > 5000n || e.n < 0n)) return { ok: false, reason: '沒有取模、n 太大，精確值放不下' };
        if (ex.some((e) => e.n < 0n)) return { ok: false, reason: 'n 為負' };
        let tried = 0; const hits = []; const budget = (o.budget && o.budget.candidates) || 200000;
        const coefs = (d) => { const out = []; const rec = (i, cur) => { if (i === d) { if (cur[d - 1] > 0) out.push(cur.slice()); return; } for (let c = 0; c <= 2; c++) { cur.push(c); rec(i + 1, cur); cur.pop(); } }; rec(0, []); return out.sort((a, b) => a.reduce((s, x) => s + x, 0) - b.reduce((s, x) => s + x, 0)); };
        const inits = (d) => { const out = []; const rec = (i, cur) => { if (i === d) { out.push(cur.slice()); return; } for (let v = 0; v <= 3; v++) { cur.push(v); rec(i + 1, cur); cur.pop(); } }; rec(0, []); return out.sort((a, b) => a.reduce((s, x) => s + x, 0) - b.reduce((s, x) => s + x, 0)); };
        for (let d = 1; d <= 4 && hits.length < 2; d++) for (const cf of coefs(d)) {
            if (hits.length >= 2) break;
            // 狀態向量 (f(k+d-1) … f(k))；伴隨矩陣第一列是係數，其餘是移位
            const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === 0 ? BigInt(cf[j]) : (j === i - 1 ? 1n : 0n))));
            for (const s of [0, 1]) {
                const rows = []; let ok = true; for (const e of ex) { const nn = e.n - BigInt(s); if (nn < 0n) { ok = false; break; } rows.push(matPow(A, nn, M)[0]); } if (!ok) continue;
                for (const iv of inits(d)) {
                    if (++tried > budget) return { ok: false, reason: '枚舉預算用盡', tried };
                    const st = iv.slice().reverse(); // (f(d-1)…f(0))
                    let all = true; for (let k = 0; k < ex.length; k++) { let v = 0n; for (let j = 0; j < d; j++) v += rows[k][j] * BigInt(st[j]); if (M) v %= M; if (v !== (M ? ex[k].y % M : ex[k].y)) { all = false; break; } }
                    if (all) { const h2 = { d, cf, iv, s }; const sig = seqSig(h2, M); if (!hits.some((x) => x.sig === sig)) { h2.sig = sig; hits.push(h2); } if (hits.length >= 2) break; }
                }
            }
        }
        if (!hits.length) return { ok: false, reason: '階數≤4、係數0..2、初值0..3 的遞推式裡沒有符合所有範例的', tried };
        const h = hits[0]; const d = h.d; const modPy = M ? M.toString() : 'None';
        const src = ['def main():', '    n = int(input()) - ' + h.s, '    M = ' + modPy, '    d = ' + d, '    coef = ' + JSON.stringify(h.cf), '    init = ' + JSON.stringify(h.iv),
            '    def mul(A, B):', '        C = [[sum(A[i][k] * B[k][j] for k in range(d)) for j in range(d)] for i in range(d)]', '        return [[x % M for x in r] for r in C] if M else C',
            '    A = [coef[:]] + [[1 if j == i - 1 else 0 for j in range(d)] for i in range(1, d)]', '    R = [[1 if i == j else 0 for j in range(d)] for i in range(d)]',
            '    while n > 0:', '        if n & 1: R = mul(R, A)', '        A = mul(A, A); n >>= 1', '    st = init[::-1]', '    v = sum(R[0][j] * st[j] for j in range(d))', '    print(v % M if M else v)', ''].join('\n');
        return { ok: true, source: src, kind: 'recurrence', level: 'L1', size: d, tried, ambiguous: hits.length > 1, matrixForm: { kind: 'recurrence', coef: h.cf, init: h.iv, offset: h.s, mod: M ? Number(M) : null }, desc: '階 ' + d + ' 遞推 係數 ' + h.cf.join(',') + ' 初值 ' + h.iv.join(',') + (h.s ? '（從 1 起）' : '') + (M ? ' 取模 ' + M : '') };
    }
    // ---- L2：自動機家族 ----
    function kmpDFA(pat, alpha) {
        const m = pat.length; const fail = [0]; for (let i = 1, k = 0; i < m; i++) { while (k && pat[i] !== pat[k]) k = fail[k - 1]; if (pat[i] === pat[k]) k++; fail[i] = k; }
        const delta = []; for (let q = 0; q <= m; q++) { delta[q] = {}; for (const c of alpha) { if (q < m && pat[q] === c) delta[q][c] = q + 1; else if (q === 0) delta[q][c] = 0; else delta[q][c] = delta[fail[q - 1]][c]; } } return delta;
    }
    // 敘述裡說的字母表：「由 a、b 組成」「只含 0、1」「引號內的字串」；範例沒出現的字元也要能轉移，否則隱藏測資會 KeyError
    function stmtAlphabet(st) { const out = []; const m = st.match(/(?:由|只含|只有|僅含)\s*([A-Za-z0-9、,，\s]+?)\s*(?:組成|構成|的字串|，|。|$)/); if (m) for (const c of m[1]) if (/[A-Za-z0-9]/.test(c)) out.push(c); for (const q of st.matchAll(/["「]([A-Za-z0-9]+)["」]/g)) for (const c of q[1]) out.push(c); return out; }
    function families(statement0, alpha, shape) {
        const statement = statement0.replace(/由[^，。,.]*?組成/g, '').replace(/只含[^，。,.]*/g, '').replace(/[（(][^）)]*[）)]/g, '');
        const F = []; const nums = (statement.match(/\d+/g) || []).map(Number);
        const mentions = (s) => statement.indexOf(s) >= 0;
        // 某字元個數取模
        for (const c of alpha) if (mentions(c)) for (const m of [2, 3, 4, 5].filter((x) => x === 2 ? /偶數|奇數|奇偶/.test(statement) || nums.includes(2) : nums.includes(x) || (x === 2))) for (let r = 0; r < m; r++) {
            const delta = []; for (let q = 0; q < m; q++) { delta[q] = {}; for (const a of alpha) delta[q][a] = a === c ? (q + 1) % m : q; }
            F.push({ name: '「' + c + '」的個數 mod ' + m + (shape.out === 'label' ? ' ＝ ' + r : ''), n: m, start: 0, delta, accept: (q) => q === r, value: (q) => q, hint: 2 + (/個數|次數|出現/.test(statement) ? 1 : 0) });
        }
        // 數字串當 base 進位的值取模（二進位／十進位）
        for (const base of [2, 10]) { if (!alpha.every((a) => /\d/.test(a) && Number(a) < base)) continue; const bh = base === 2 ? /二進位|binary/i.test(statement) : /十進位|整數|數字/.test(statement);
            for (const m of nums.filter((x) => x >= 2 && x <= 12)) { const delta = []; for (let q = 0; q < m; q++) { delta[q] = {}; for (const a of alpha) delta[q][a] = (q * base + Number(a)) % m; } F.push({ name: base + ' 進位值 mod ' + m, n: m, start: 0, delta, accept: (q) => q === 0, value: (q) => q, hint: 2 + (bh ? 1 : 0) + (/整除|餘數/.test(statement) ? 1 : 0) }); } }
        // 子字串：含／不含／開頭／結尾／出現次數；子字串必須在敘述裡出現（引號、或敘述裡的連續字元，例如「兩個 1」→ 11）
        const subs = new Set(); for (let len = 1; len <= 3; len++) { const rec = (cur) => { if (cur.length === len) { subs.add(cur); return; } for (const a of alpha) rec(cur + a); }; rec(''); }
        const repOf = (s) => { const r = new RegExp('(?:連續)?([兩二三四2-4])個\\s*' + s[0]).exec(statement); return r ? ({ '兩': 2, '二': 2, '2': 2, '三': 3, '3': 3, '四': 4, '4': 4 })[r[1]] : 0; };
        const stmtSubs = [...subs].filter((s) => mentions(s) || (repOf(s) && s === s[0].repeat(repOf(s))));
        for (const s of stmtSubs) { const delta = kmpDFA(s, alpha); const m = s.length; const repN = repOf(s[0]); const base = (statement.indexOf(s) >= 0 ? 1 + s.length : 0) + 1 + (repN && s === s[0].repeat(repN) ? 3 : 0) - (repN && s.length !== repN && s === s[0].repeat(s.length) ? 2 : 0);
            F.push({ name: '含 ' + s, n: m + 1, start: 0, delta: (() => { const d2 = delta.map((r) => Object.assign({}, r)); for (const a of alpha) d2[m][a] = m; return d2; })(), accept: (q) => q === m, hint: base + (/含|包含|連續|出現/.test(statement) ? 1 : 0) });
            F.push({ name: '不含 ' + s, n: m + 1, start: 0, delta: (() => { const d2 = delta.map((r) => Object.assign({}, r)); for (const a of alpha) d2[m][a] = m; return d2; })(), accept: (q) => q !== m, hint: base + (/不含|沒有|不包含|不出現|不連續/.test(statement) ? 2 : 0) });
            F.push({ name: '結尾是 ' + s, n: m + 1, start: 0, delta: delta, accept: (q) => q === m, hint: base + (/結尾|尾/.test(statement) ? 2 : 0) });
            F.push({ name: '開頭是 ' + s, n: m + 2, start: 0, delta: (() => { const d2 = []; for (let q = 0; q <= m + 1; q++) { d2[q] = {}; for (const a of alpha) d2[q][a] = q === m ? m : q === m + 1 ? m + 1 : (s[q] === a ? q + 1 : m + 1); } return d2; })(), accept: (q) => q === m, hint: base + (/開頭|頭/.test(statement) ? 2 : 0) });
            F.push({ name: '出現 ' + s + ' 的次數（可重疊）', n: m + 1, start: 0, delta: delta, accept: null, count: (q) => (q === m ? 1 : 0), hint: base + (/次數|幾次|出現/.test(statement) ? 1 : 0) });
        }
        return F.sort((a, b) => b.hint - a.hint);
    }
    function runDFA(f, s) { let q = f.start; let cnt = 0; for (const ch of s) { const nx = f.delta[q] && f.delta[q][ch]; if (nx === undefined) return null; q = nx; if (f.count) cnt += f.count(q); } return { q, cnt }; }
    function synthDFA(o) {
        const sh = inferShape(o.examples); if (!sh) return { ok: false, reason: '輸入輸出形狀不是單行單詞' };
        const stLabels = [...new Set([...String(o.statement).matchAll(/印\s*([A-Za-z]+)/g)].map((m) => m[1]))].slice(0, 2);
        const alpha = [...new Set(o.examples.flatMap((e) => [...e.in.trim()]).concat(stmtAlphabet(String(o.statement))))].sort(); const labels = sh.out === 'label' ? (stLabels.length === 2 && sh.labels.every((l) => stLabels.includes(l)) ? stLabels : sh.labels.length === 2 ? sh.labels : sh.labels.concat(stLabels.filter((l) => !sh.labels.includes(l))).slice(0, 2)) : sh.labels;
        const fams = families(String(o.statement), alpha, sh); let tried = 0; const hits = [];
        for (const f of fams) {
            if (sh.out === 'int') {
                if (!(f.count || f.value)) continue; tried++;
                if (o.examples.every((e) => { const r = runDFA(f, e.in.trim()); if (!r) return false; return (f.count ? r.cnt : f.value(r.q)) === Number(e.out.trim()); })) hits.push({ f, labelTrue: null });
            } else {
                if (!f.accept || labels.length > 2) continue;
                // 敘述裡先出現的標籤當「是」；沒出現在敘述就兩種指派都試
                const order = labels.length === 2 ? (String(o.statement).indexOf(labels[0]) <= String(o.statement).indexOf(labels[1]) ? [[labels[0], labels[1]], [labels[1], labels[0]]] : [[labels[1], labels[0]], [labels[0], labels[1]]]) : [[labels[0], null], [null, labels[0]]];
                const inStmt = labels.some((l) => String(o.statement).indexOf(l) >= 0);
                for (const [yes, no] of (inStmt && labels.length === 2 ? order.slice(0, 1) : order)) { tried++;
                    if (o.examples.every((e) => { const r = runDFA(f, e.in.trim()); if (!r) return false; return (f.accept(r.q) ? yes : no) === e.out.trim(); })) { hits.push({ f, yes, no }); break; } }
            }
            if (hits.length >= 2) break;
        }
        if (!hits.length) return { ok: false, reason: '自動機家族（個數取模／值取模／含不含開頭結尾子字串）裡沒有符合所有範例且參數出現在敘述中的', tried };
        const h = hits[0], f = h.f; const tbl = f.delta.map((r) => '{' + Object.keys(r).map((c) => JSON.stringify(c) + ': ' + r[c]).join(', ') + '}');
        const L = ['def main():', '    s = input().strip()', '    T = [' + tbl.join(', ') + ']', '    q = ' + f.start, '    cnt = 0'];
        if (f.count) { const cs = []; for (let q = 0; q < f.n; q++) if (f.count(q)) cs.push(q); L.push('    for ch in s:', '        q = T[q][ch]', '        if q in ' + JSON.stringify(cs) + ': cnt += 1', '    print(cnt)'); }
        else { L.push('    for ch in s:', '        q = T[q][ch]'); if (sh.out === 'int') L.push('    print(q)'); else { const acc = []; for (let q = 0; q < f.n; q++) if (f.accept(q)) acc.push(q); L.push('    print(' + JSON.stringify(h.yes) + ' if q in ' + JSON.stringify(acc) + ' else ' + JSON.stringify(h.no) + ')'); } }
        return { ok: true, source: L.join('\n') + '\n', kind: 'dfa', level: 'L2', size: f.n, tried, ambiguous: hits.length > 1, matrixForm: { kind: 'dfa', start: f.start, delta: f.delta, accept: f.accept ? f.delta.map((_, q) => q).filter((q) => f.accept(q)) : null }, desc: f.name };
    }
    // ---- L0：公式枚舉（k 個整數進、1 個整數出）：由小到大枚舉運算式，用「觀察等價」剪枝（範例＋隨機探針上輸出相同的只留最小的）----
    function synthFormula(o) {
        const exs = o.examples.map((e) => ({ i: e.in.trim().split(/\s+/), o: e.out.trim() })); if (!exs.length || exs.some((e) => e.i.length !== exs[0].i.length || !e.i.every(isInt) || !isInt(e.o))) return { ok: false, reason: '不是「k 個整數進、一個整數出」' };
        const k = exs[0].i.length; if (k < 1 || k > 6) return { ok: false, reason: '輸入整數個數不在 1..6' };
        const stmt = String(o.statement).replace(/[（(][^）)]*[）)]/g, ''); const consts = [...new Set([1, 2].concat((stmt.match(/\d+/g) || []).map(Number).filter((x) => x <= 1000)))].slice(0, 8);
        // 輸入：範例＋探針（固定的偽隨機小整數；只用來剪枝，不當正確性依據）
        let sd = 99; const rn = (a, b) => { sd = (Math.imul(sd, 1103515245) + 12345) & 0x7fffffff; return a + ((sd >>> 8) % (b - a + 1)); };
        const pts = exs.map((e) => e.i.map(Number)); const nEx = pts.length; for (let t = 0; t < 12; t++) pts.push(Array.from({ length: k }, () => rn(-9, 20)));
        const want = exs.map((e) => Number(e.o)); const LIM = 2 ** 50; const ok = (v) => Number.isFinite(v) && Math.abs(v) < LIM;
        const seen = new Map(); const bySize = []; let tried = 0; const budget = (o.budget && o.budget.candidates) || 300000; const hits = [];
        const add = (size, expr, vals) => { if (!vals.every(ok)) return; const key = vals.join(','); if (seen.has(key)) return; seen.set(key, expr); (bySize[size] = bySize[size] || []).push({ expr, vals }); tried++; if (vals.slice(0, nEx).every((v, j) => v === want[j])) hits.push({ expr, vals }); };
        for (let v = 0; v < k; v++) add(1, 'x' + v, pts.map((p) => p[v])); for (const c of consts) add(1, String(c), pts.map(() => c));
        if (k >= 3) for (let r = 0; r < k; r++) add(2, 'sorted([' + Array.from({ length: k }, (_, i) => 'x' + i).join(', ') + '])[' + r + ']', pts.map((p) => p.slice().sort((a, b) => a - b)[r]));
        const OPS = [['+', (a, b) => a + b, 1], ['-', (a, b) => a - b, 0], ['*', (a, b) => a * b, 1], ['//', (a, b) => (b === 0 ? NaN : Math.floor(a / b)), 0], ['%', (a, b) => (b === 0 ? NaN : ((a % b) + b) % b), 0], ['min', (a, b) => Math.min(a, b), 1], ['max', (a, b) => Math.max(a, b), 1]];
        for (let n = 2; n <= 9 && !hits.length; n++) {
            if (n >= 2) for (const a of bySize[n - 1] || []) { add(n, 'abs(' + a.expr + ')', a.vals.map(Math.abs)); }
            for (let i = 1; i <= n - 2; i++) { const j = n - 1 - i; for (const a of bySize[i] || []) for (const b of bySize[j] || []) for (const [op, f, comm] of OPS) {
                if (tried > budget) return { ok: false, reason: '枚舉預算用盡（大小 ' + n + '）', tried };
                if (comm && i > j) continue; const vals = a.vals.map((x, t) => f(x, b.vals[t])); const m = op === 'min' || op === 'max'; add(n, m ? op + '(' + a.expr + ', ' + b.expr + ')' : '(' + a.expr + ' ' + op + ' ' + b.expr + ')', vals); } }
        }
        if (!hits.length) return { ok: false, reason: '大小≤9 的整數公式裡沒有符合所有範例的', tried };
        const h = hits[0]; const vars = Array.from({ length: k }, (_, i) => 'x' + i).join(', ');
        return { ok: true, source: 'def main():\n    ' + vars + (k === 1 ? ', ' : '') + ' = map(int, input().split())\n    print(' + h.expr + ')\n', kind: 'formula', level: 'L0', size: h.expr.length, tried, ambiguous: hits.length > 1 && new Set(hits.map((x) => x.vals.join(','))).size > 1, desc: '公式 ' + h.expr, matrixForm: { kind: 'formula', expr: h.expr } };
    }
    // ---- L3～L6：範本庫（計數器／堆疊／字串／清單的小範本；每個範本＝JS 預言機＋Python 程式，敘述關鍵字當先驗，對所有範例驗證）----
    // 這不是證明涵蓋：只是把「Blockly 範式骨架沒有、但常見」的小題型放進去，輸入形狀固定四種（int／str／k＋str／n＋清單）。
    const isqrtB = (n) => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x; };
    const digitsOf = (n) => [...String(n)].map(Number);
    const popc = (n, bit) => { let c = 0; for (const ch of n.toString(2)) if (ch === bit) c++; return c; };
    const smallN = (n) => n <= 10000000n;
    const divisorsOf = (n) => { const N = Number(n); const ds = []; for (let i = 1; i * i <= N; i++) if (N % i === 0) { ds.push(i); if (i * i !== N) ds.push(N / i); } return ds; };
    const isPrimeB = (n) => { if (n < 2n) return false; const N = Number(n); if (N > 1e12) return null; if (N < 4) return true; if (N % 2 === 0 || N % 3 === 0) return false; for (let i = 5; i * i <= N; i += 6) if (N % i === 0 || N % (i + 2) === 0) return false; return true; };
    const romanOf = (n) => { const T = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let r = ''; let x = Number(n); for (const [v, t] of T) while (x >= v) { r += t; x -= v; } return r; };
    const ngRight = (a) => { const out = a.map(() => 0); const st = []; for (let i = a.length - 1; i >= 0; i--) { while (st.length && st[st.length - 1] <= a[i]) st.pop(); out[i] = st.length ? st[st.length - 1] : 0; st.push(a[i]); } return out; };
    const PYPRIME = ['def isp(n):', '    if n < 2: return False', '    if n < 4: return True', '    if n % 2 == 0 or n % 3 == 0: return False', '    i = 5', '    while i * i <= n:', '        if n % i == 0 or n % (i + 2) == 0: return False', '        i += 6', '    return True'];
    const PYDIV = ['ds = []', 'i = 1', 'while i * i <= n:', '    if n % i == 0:', '        ds.append(i)', '        if i * i != n: ds.append(n // i)', '    i += 1'];
    // shape: int／str／ks（k 一行、字串一行）／nl（n 一行、清單一行）；out: int／bool／str／list
    const TEMPLATES = [
        { name: '各位數字和', shape: 'int', out: 'int', kw: /各位.*和|數字和|digit\s*sum/i, js: (n) => digitsOf(n).reduce((a, b) => a + b, 0), py: ['r = sum(int(c) for c in str(n))'] },
        { name: '各位數字積', shape: 'int', out: 'int', kw: /各位.*積|數字.*積|digit\s*prod/i, js: (n) => digitsOf(n).reduce((a, b) => a * b, 1), py: ['r = 1', 'for c in str(n): r *= int(c)'] },
        { name: '位數', shape: 'int', out: 'int', kw: /幾位|位數|有幾個數字/, js: (n) => String(n).length, py: ['r = len(str(n))'] },
        { name: '二進位 1 的個數', shape: 'int', out: 'int', kw: /二進位.*(1|一).*個數|popcount|1 的個數/i, js: (n) => popc(n, '1'), py: ['r = bin(n).count("1")'] },
        { name: '二進位 0 的個數', shape: 'int', out: 'int', kw: /二進位.*0 的個數|0 的個數/, js: (n) => (n === 0n ? 1 : popc(n, '0')), py: ['r = bin(n)[2:].count("0")'] },
        { name: '二進位位數', shape: 'int', out: 'int', kw: /二進位.*(位數|長度)|bit.?length/i, js: (n) => n.toString(2).length, py: ['r = n.bit_length()'] },
        { name: '因數個數', shape: 'int', out: 'int', kw: /因數.*(個數|幾個)|幾個因數|約數.*(個數|幾個)/, js: (n) => (smallN(n) && n > 0n ? divisorsOf(n).length : null), py: PYDIV.concat(['r = len(ds)']) },
        { name: '因數和', shape: 'int', out: 'int', kw: /因數.*和|約數.*和/, js: (n) => (smallN(n) && n > 0n ? divisorsOf(n).reduce((a, b) => a + b, 0) : null), py: PYDIV.concat(['r = sum(ds)']) },
        { name: '反轉數字', shape: 'int', out: 'int', kw: /反轉|倒過來|reverse/i, js: (n) => BigInt([...String(n)].reverse().join('')), py: ['r = int(str(n)[::-1])'] },
        { name: '整數平方根', shape: 'int', out: 'int', kw: /平方根|sqrt/i, js: (n) => isqrtB(n), py: ['import math', 'r = math.isqrt(n)'] },
        { name: '尾端 0 的個數（n!）', shape: 'int', out: 'int', kw: /階乘.*(尾|末).*0|n!.*0/, js: (n) => { let c = 0n, x = n; while (x >= 5n) { x /= 5n; c += x; } return c; }, py: ['r = 0', 'x = n', 'while x >= 5:', '    x //= 5', '    r += x'] },
        { name: '是質數', shape: 'int', out: 'bool', kw: /質數|素數|prime/i, js: (n) => isPrimeB(n), py: PYPRIME.concat(['r = isp(n)']) },
        { name: '是偶數', shape: 'int', out: 'bool', kw: /偶數|even/i, js: (n) => n % 2n === 0n, py: ['r = n % 2 == 0'] },
        { name: '是 2 的冪', shape: 'int', out: 'bool', kw: /2\s*的(冪|次方)|power of two/i, js: (n) => n > 0n && (n & (n - 1n)) === 0n, py: ['r = n > 0 and (n & (n - 1)) == 0'] },
        { name: '是完全平方數', shape: 'int', out: 'bool', kw: /完全平方/, js: (n) => { const q = isqrtB(n); return q * q === n; }, py: ['import math', 'r = math.isqrt(n) ** 2 == n'] },
        { name: '是回文數', shape: 'int', out: 'bool', kw: /回文/, js: (n) => { const t = String(n); return t === [...t].reverse().join(''); }, py: ['r = str(n) == str(n)[::-1]'] },
        { name: '羅馬數字', shape: 'int', out: 'str', kw: /羅馬/, js: (n) => (n >= 1n && n <= 3999n ? romanOf(n) : null), py: ['T = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]', 'r = ""', 'x = n', 'for v, t in T:', '    while x >= v:', '        r += t', '        x -= v'] },
        { name: '母音個數', shape: 'str', out: 'int', kw: /母音|vowel/i, js: (s) => [...s].filter((c) => 'aeiouAEIOU'.includes(c)).length, py: ['r = sum(1 for c in s if c in "aeiouAEIOU")'] },
        { name: '大寫字母個數', shape: 'str', out: 'int', kw: /大寫/, js: (s) => [...s].filter((c) => /[A-Z]/.test(c)).length, py: ['r = sum(1 for c in s if c.isupper())'] },
        { name: '數字字元個數', shape: 'str', out: 'int', kw: /數字(字元|個數)/, js: (s) => [...s].filter((c) => /\d/.test(c)).length, py: ['r = sum(1 for c in s if c.isdigit())'] },
        { name: '不同字元個數', shape: 'str', out: 'int', kw: /不同.*(字元|字母)|相異|distinct|unique/i, js: (s) => new Set(s).size, py: ['r = len(set(s))'] },
        { name: '字串長度', shape: 'str', out: 'int', kw: /長度|length/i, js: (s) => s.length, py: ['r = len(s)'] },
        { name: '是回文字串', shape: 'str', out: 'bool', kw: /回文|palindrome/i, js: (s) => s === [...s].reverse().join(''), py: ['r = s == s[::-1]'] },
        { name: '反轉字串', shape: 'str', out: 'str', kw: /反轉|倒過來|reverse/i, js: (s) => [...s].reverse().join(''), py: ['r = s[::-1]'] },
        { name: '轉大寫', shape: 'str', out: 'str', kw: /大寫|upper/i, js: (s) => s.toUpperCase(), py: ['r = s.upper()'] },
        { name: '轉小寫', shape: 'str', out: 'str', kw: /小寫|lower/i, js: (s) => s.toLowerCase(), py: ['r = s.lower()'] },
        { name: '去掉母音', shape: 'str', out: 'str', kw: /(去掉|刪除|移除).*母音/, js: (s) => [...s].filter((c) => !'aeiouAEIOU'.includes(c)).join(''), py: ['r = "".join(c for c in s if c not in "aeiouAEIOU")'] },
        { name: '字元排序', shape: 'str', out: 'str', kw: /排序|sort/i, js: (s) => [...s].sort().join(''), py: ['r = "".join(sorted(s))'] },
        { name: '凱薩加密（往後移 k）', shape: 'ks', out: 'str', kw: /往後|後移|向後|加密|shift/i, js: (k, s) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCharCode(97 + ((c.charCodeAt(0) - 97 + k) % 26 + 26) % 26) : c)).join(''), py: ['r = "".join(chr(97 + (ord(c) - 97 + k) % 26) if "a" <= c <= "z" else c for c in s)'] },
        { name: '凱薩解密（往前移 k）', shape: 'ks', out: 'str', kw: /往前|前移|向前|解密/, js: (k, s) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCharCode(97 + ((c.charCodeAt(0) - 97 - k) % 26 + 26) % 26) : c)).join(''), py: ['r = "".join(chr(97 + (ord(c) - 97 - k) % 26) if "a" <= c <= "z" else c for c in s)'] },
        { name: '右邊第一個更大的數', shape: 'nl', out: 'list', kw: /右邊第一個.*大|next greater|下一個更大/i, js: (n, a) => ngRight(a), py: ['r = [0] * n', 'st = []', 'for i in range(n - 1, -1, -1):', '    while st and st[-1] <= a[i]: st.pop()', '    r[i] = st[-1] if st else 0', '    st.append(a[i])'] },
        { name: '右邊第一個更小的數', shape: 'nl', out: 'list', kw: /右邊第一個.*小|next smaller|下一個更小/i, js: (n, a) => ngRight(a.map((x) => -x)).map((v, i) => (v === 0 ? 0 : -v)), py: ['r = [0] * n', 'st = []', 'for i in range(n - 1, -1, -1):', '    while st and st[-1] >= a[i]: st.pop()', '    r[i] = st[-1] if st else 0', '    st.append(a[i])'] },
        { name: '前綴和', shape: 'nl', out: 'list', kw: /前綴|prefix/i, js: (n, a) => { let t = 0; return a.map((x) => (t += x)); }, py: ['r = []', 't = 0', 'for x in a:', '    t += x', '    r.append(t)'] },
        { name: '到目前為止的最大值', shape: 'nl', out: 'list', kw: /目前為止|prefix max|running max|累積最大/i, js: (n, a) => { let m = -Infinity; return a.map((x) => (m = Math.max(m, x))); }, py: ['r = []', 'm = a[0]', 'for x in a:', '    m = max(m, x)', '    r.append(m)'] },
        { name: '最大值', shape: 'nl', out: 'int', kw: /最大/, js: (n, a) => Math.max(...a), py: ['r = max(a)'] },
        { name: '總和', shape: 'nl', out: 'int', kw: /總和|加總|和/, js: (n, a) => a.reduce((x, y) => x + y, 0), py: ['r = sum(a)'] },
        { name: '不同數字個數', shape: 'nl', out: 'int', kw: /不同|相異|distinct/i, js: (n, a) => new Set(a).size, py: ['r = len(set(a))'] },
    ];
    function parseShape(shape, raw) {
        const ls = String(raw).replace(/\s+$/, '').split('\n'); const T = (x) => x.trim();
        if (shape === 'int') { if (ls.length !== 1 || !isInt(T(ls[0]))) return null; return [BigInt(T(ls[0]))]; }
        if (shape === 'str') { if (ls.length !== 1) return null; return [T(ls[0])]; }
        if (shape === 'ks') { if (ls.length !== 2 || !isInt(T(ls[0]))) return null; return [Number(T(ls[0])), T(ls[1])]; }
        if (shape === 'nl') { if (ls.length !== 2 || !isInt(T(ls[0]))) return null; const a = T(ls[1]) ? T(ls[1]).split(/\s+/) : []; if (!a.every(isInt) || a.length !== Number(T(ls[0]))) return null; return [Number(T(ls[0])), a.map(Number)]; }
        return null;
    }
    function synthTemplate(o) {
        const st = String(o.statement); const exs = o.examples; if (!exs || !exs.length) return { ok: false, reason: '沒有範例' };
        const labels = [...new Set(exs.map((e) => e.out.trim()))]; const stLabels = [...new Set([...st.matchAll(/印\s*([A-Za-z]+)/g)].map((m) => m[1]))];
        const hits = []; let tried = 0;
        for (const t of TEMPLATES) {
            const ins = exs.map((e) => parseShape(t.shape, e.in)); if (ins.some((x) => !x)) continue; tried++;
            let outs; try { outs = ins.map((a) => t.js(...a)); } catch (e) { continue; } if (outs.some((v) => v === null || v === undefined)) continue;
            let yes = null, no = null;
            if (t.out === 'bool') {
                const ls = labels.concat(stLabels.filter((x) => !labels.includes(x))); if (ls.length > 2 || labels.length > 2 || ls.some(isInt)) continue; if (ls.length < 2) continue;
                const order = st.indexOf(ls[0]) <= st.indexOf(ls[1]) || st.indexOf(ls[1]) < 0 ? [[ls[0], ls[1]], [ls[1], ls[0]]] : [[ls[1], ls[0]], [ls[0], ls[1]]];
                const inSt = ls.some((l) => st.indexOf(l) >= 0); let found = false;
                for (const [y, n] of (inSt ? order.slice(0, 1) : order)) { if (exs.every((e, i) => e.out.trim() === (outs[i] ? y : n))) { yes = y; no = n; found = true; break; } } if (!found) continue;
            } else if (t.out === 'list') { if (!exs.every((e, i) => e.out.trim().split(/\s+/).join(' ') === outs[i].join(' '))) continue; }
            else if (!exs.every((e, i) => e.out.trim() === String(outs[i]))) continue;
            hits.push({ t, yes, no, score: (t.kw.test(st) ? 2 : 0) });
        }
        if (!hits.length) return { ok: false, reason: '範本庫（' + TEMPLATES.length + ' 個）裡沒有符合所有範例的', tried };
        hits.sort((a, b) => b.score - a.score); const h = hits[0]; const t = h.t;
        const unique = hits.length === 1 || hits[0].score > hits[1].score;
        const rd = { int: ['n = int(input())'], str: ['s = input().strip()'], ks: ['k = int(input())', 's = input().strip()'], nl: ['n = int(input())', 'a = list(map(int, input().split()))'] }[t.shape];
        const pr = { int: 'print(r)', str: 'print(r)', bool: 'print(' + JSON.stringify(h.yes) + ' if r else ' + JSON.stringify(h.no) + ')', list: "print(' '.join(map(str, r)))" }[t.out];
        const src = ['def main():'].concat(rd, t.py, [pr]).map((l, i) => (i === 0 ? l : '    ' + l)).join('\n') + '\n';
        return { ok: true, source: src, kind: 'template', level: t.shape === 'nl' ? 'L5' : 'L4', size: t.py.length, tried, ambiguous: !unique, desc: '範本：' + t.name, matrixForm: { kind: 'template', name: t.name } };
    }
    // ---- 註冊表：矩陣層「認多少補多少」——補一種範本／一種形狀＝註冊一個模組（FaMatrixSynth.register），不必改 synth() ----
    // 模組合約：fn({statement, examples, budget}) → 同步或 Promise 的 {ok, source, kind, level, size, tried, ambiguous, desc, matrixForm, reason}。
    // order 小的先試（便宜、保證會停的先；容易過度擬合的公式枚舉放最後）；模組丟例外只算它自己失敗，不影響其他模組。
    const REGISTRY = [];
    function register(name, fn, opts) { const i = REGISTRY.findIndex((x) => x.name === name); const ent = { name, fn, order: (opts && opts.order != null) ? opts.order : 50, level: (opts && opts.level) || null, note: (opts && opts.note) || '' }; if (i >= 0) REGISTRY[i] = ent; else REGISTRY.push(ent); REGISTRY.sort((a, b) => a.order - b.order); return ent; }
    function unregister(name) { const i = REGISTRY.findIndex((x) => x.name === name); if (i >= 0) REGISTRY.splice(i, 1); return i >= 0; }
    const list = () => REGISTRY.map((x) => ({ name: x.name, order: x.order, level: x.level, note: x.note }));
    register('recurrence', synthRecurrence, { order: 10, level: 'L1', note: '線性遞推（矩陣冪）' }); register('dfa', synthDFA, { order: 20, level: 'L2', note: '有限狀態自動機家族' });
    register('template', synthTemplate, { order: 40, level: 'L4/L5', note: '小範本庫（數字／字串／清單）' }); register('formula', synthFormula, { order: 90, level: 'L0', note: '整數公式枚舉（最後才試，容易過度擬合）' });
    // ---- 入口：依註冊表的順序試；每個候選交 judge（若有）驗證 ----
    async function synth(o) {
        const t0 = Date.now(); const ex = o.examples || []; const steps = []; let best = null;
        for (const { name, fn } of REGISTRY.slice()) {
            let r; try { r = await fn({ statement: String(o.statement || ''), examples: ex, budget: o.budget }); } catch (e) { r = { ok: false, reason: '例外：' + String((e && e.message) || e) }; }
            steps.push({ by: name, ok: r.ok, reason: r.reason, tried: r.tried }); if (!r.ok) continue;
            let v = { verdict: 'UNCHECKED' }; if (o.judge) v = await o.judge(r.source); steps[steps.length - 1].verdict = v.verdict;
            if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') { best = Object.assign(r, { explain: r.desc, blocks: null, matrixForm: r.matrixForm || null, verdict: v.verdict, verified: v.verdict === 'AC' && !r.ambiguous, holdout: ex.length, steps, ms: Date.now() - t0 }); break; }
        }
        if (best) return best;
        return { ok: false, reason: steps.map((s) => s.by + '：' + (s.reason || s.verdict)).join('；'), steps, ms: Date.now() - t0 };
    }
    return { synth, register, unregister, list, synthRecurrence, synthDFA, synthFormula, synthTemplate, inferShape, kmpDFA };
});
