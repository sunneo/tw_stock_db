/* 矩陣層 L0 補強模組（純函式 UMD，不問模型）：藉 FaMatrixSynth.register 接進去。
 *   'predicate'（order 92）：k 個整數進、兩種標籤出（是／否）。枚舉「原子條件」（x%c==0、x 與常數比大小、兩變數比大小、a+b 與 c 比大小，含否定）
 *        的 1～3 個組合（and／or），常數必須在敘述裡出現過（敘述當先驗，避免兩個範例湊出巧合）。例：閏年、三角形成立、區間內、倍數判斷。
 *   'multi'（order 93）：k 個整數進、m 個整數出（以空白、冒號或逗號隔開）：每個輸出欄位各自交給 synthFormula 找公式，再接起來。例：秒數→時分秒、商與餘數。
 *   'real'（order 94）：k 個整數進、一個小數出（小數位數從範例看）：枚舉含真除法的公式。例：平均、BMI。
 * 這些都是「有預算的枚舉＋範例驗證」，不是證明；範例太少時可能有多個候選全對，最後仍由 synth() 的 judge（含隱藏測資）把關。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixL0 = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    const norm = (s) => String(s).trim().split(/\s+/).join(' ');
    function parseIns(exs) { const rows = exs.map((e) => e.in.trim().split(/\s+/)); if (!rows.length || rows.some((r) => r.length !== rows[0].length || !r.every(isInt))) return null; const k = rows[0].length; if (k < 1 || k > 5) return null; return { k, pts: rows.map((r) => r.map(Number)) }; }
    function probes(k, n) { let sd = 7; const rn = (a, b) => { sd = (Math.imul(sd, 1103515245) + 12345) & 0x7fffffff; return a + ((sd >>> 8) % (b - a + 1)); }; return Array.from({ length: n }, () => Array.from({ length: k }, () => rn(-3, 450))); }
    const CN = { 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    // 常數先驗：敘述的數字（括號註解先拿掉）、「三個」這種中文數量詞、敘述領域的常用常數（時間→60／3600／24、公分→100／10000…）；呼叫端再加輸入個數 k
    const KWC = [[/秒|分鐘|小時|時間|時分/, [60, 3600, 24, 86400]], [/星期|週|周/, [7]], [/公分|公尺|百分|%|百分比/, [100, 10000]], [/月份|幾月/, [12, 30, 31]], [/年份|閏年|世紀/, [100, 365, 400]], [/各位|位數|十進位/, [10]]];
    const stmtNums = (st) => { const t = String(st).replace(/[（(][^）)]*[）)]/g, ''); const a = (t.match(/\d+/g) || []).map(Number); for (const m of t.matchAll(/([兩二三四五六七八九十])\s*(?:個|位|數|人|科|項|次|門|邊)/g)) a.push(CN[m[1]]); for (const [re, cs] of KWC) if (re.test(String(st))) a.push(...cs); return [...new Set(a)].filter((x) => x >= 1 && x <= 100000).slice(0, 14); };
    // ---- predicate ----
    function synthPredicate(o) {
        const st = String(o.statement), exs = o.examples || []; const P = parseIns(exs); if (!P) return { ok: false, reason: '不是「k 個整數進」' };
        const outs = exs.map((e) => norm(e.out)); const labs = [...new Set(outs)]; if (labs.some((x) => /^-?\d+(\.\d+)?$/.test(x))) return { ok: false, reason: '輸出是數字，不是標籤' }; if (labs.length > 2 || outs.some((x) => x.split(' ').length !== 1)) return { ok: false, reason: '輸出不是單一標籤（至多兩種）' };
        const caps = [...new Set([...st.matchAll(/(?:輸出|印出|印)\s*([A-Za-z_]+)|[，,、]\s*([A-Za-z_]{2,})/g)].map((m) => m[1] || m[2]).filter(Boolean))];
        const ls = labs.concat(caps.filter((x) => !labs.includes(x))).slice(0, 2); if (ls.length < 2) return { ok: false, reason: '只看到一種標籤，另一種標籤敘述裡也沒有' };
        const K = P.k; const cmpWord = /大於|小於|超過|不超過|至少|至多|以上|以下|>|<|≥|≤|介於|範圍|最多|最少|不到|未滿|滿|等於|相等|大|小/.test(st); const stp = st.replace(/[（(][^）)]*[）)]/g, ''); const parityWord = /奇|偶|even|odd/i.test(stp); const C = stmtNums(st).concat(/(?:^|[^\d])0(?!\d)/.test(stp) ? [0] : [], /(?:^|[^\d])1(?!\d)/.test(stp) ? [1] : []).filter((x, i, a) => a.indexOf(x) === i); const pts = P.pts.concat(probes(K, 24)); const nE = P.pts.length;
        const atoms = []; const seen = new Set(); const put = (src, f) => { const v = pts.map((p) => !!f(p)); const key = v.join(''); if (seen.has(key)) return; seen.add(key); atoms.push({ src, fam: src.replace(/ (?:==|!=|<=|>=|<|>) .*$/, '').replace(/ % (\d+)$/, ' % $1'), v, nc: (src.match(/\b\d+\b/g) || []).filter((x) => C.includes(Number(x)) && Number(x) > 2).length }); };
        const X = (i) => 'x' + i;
        for (let i = 0; i < K; i++) { for (const c of C) { if (c >= 2) { put(X(i) + ' % ' + c + ' == 0', (p) => p[i] % c === 0); put(X(i) + ' % ' + c + ' != 0', (p) => p[i] % c !== 0); if (parityWord && c === 2) { put(X(i) + ' % 2 == 0', (p) => p[i] % 2 === 0); put(X(i) + ' % 2 == 1', (p) => p[i] % 2 === 1); } } if (cmpWord) for (const [op, f] of [['<', (a, b) => a < b], ['<=', (a, b) => a <= b], ['>', (a, b) => a > b], ['>=', (a, b) => a >= b], ['==', (a, b) => a === b], ['!=', (a, b) => a !== b]]) put(X(i) + ' ' + op + ' ' + c, (p) => f(p[i], c)); } }
        for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) if (i !== j) { put(X(i) + ' < ' + X(j), (p) => p[i] < p[j]); put(X(i) + ' <= ' + X(j), (p) => p[i] <= p[j]); put(X(i) + ' == ' + X(j), (p) => p[i] === p[j]); put(X(i) + ' != ' + X(j), (p) => p[i] !== p[j]); }
        if (K >= 3) for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) for (let t = 0; t < K; t++) if (t !== i && t !== j) { put('(' + X(i) + ' + ' + X(j) + ') > ' + X(t), (p) => p[i] + p[j] > p[t]); put('(' + X(i) + ' + ' + X(j) + ') <= ' + X(t), (p) => p[i] + p[j] <= p[t]); }
        const want = (y) => outs.map((x) => x === y);
        const cands = []; const tryAdd = (src, v, na, nc) => { for (const y of [ls[0], ls[1]]) { const w = want(y); if (v.slice(0, nE).every((b, j) => b === w[j])) cands.push({ src, y, n: na, nc, v }); } };
        if (atoms.length > 400) atoms.length = 400;
        for (const a of atoms) tryAdd(a.src, a.v, 1, a.nc);
        for (const a of atoms) for (const b of atoms) { if (a === b || a.fam === b.fam) continue; tryAdd('(' + a.src + ') and (' + b.src + ')', a.v.map((x, i) => x && b.v[i]), 2, a.nc + b.nc); tryAdd('(' + a.src + ') or (' + b.src + ')', a.v.map((x, i) => x || b.v[i]), 2, a.nc + b.nc); }
        { const al3 = atoms.slice().sort((p, q) => q.nc - p.nc).slice(0, 60); for (const a of al3) for (const b of al3) { if (b === a || a.fam === b.fam) continue; for (const c of al3) { if (c === b || c === a || c.fam === a.fam || c.fam === b.fam) continue; tryAdd('(' + a.src + ') and (' + b.src + ') and (' + c.src + ')', a.v.map((x, i) => x && b.v[i] && c.v[i]), 3, a.nc + b.nc + c.nc); tryAdd('(' + a.src + ') or (' + b.src + ') or (' + c.src + ')', a.v.map((x, i) => x || b.v[i] || c.v[i]), 3, a.nc + b.nc + c.nc); } } }
        { const al = atoms.slice().sort((p, q) => q.nc - p.nc).slice(0, 70); for (const a of al) for (const b of al) for (const c of al) { if (a === b || b === c || a === c || a.fam === b.fam || b.fam === c.fam || a.fam === c.fam) continue; tryAdd('((' + a.src + ') and (' + b.src + ')) or (' + c.src + ')', a.v.map((x, i) => (x && b.v[i]) || c.v[i]), 3, a.nc + b.nc + c.nc); } }
        if (!cands.length) return { ok: false, reason: '條件公式（至多 3 個原子條件，常數取自敘述）裡沒有符合所有範例的' };
        // 偏好：敘述裡出現的常數越多越好、原子越少越好；標籤：敘述先出現的當「是」（兩種都對時）
        const andW = /任意|每個|每兩|都|所有|全部|且|同時|並且/.test(st), orW = /或|任一|至少|其中一|或者/.test(st); const kindOf = (c) => (/\) or \(/.test(c.src) ? 'or' : /\) and \(/.test(c.src) ? 'and' : 'one'); const butW = /但|不能|除非|除了|而且|並且/.test(st); const pref = (c) => { const kd = kindOf(c); const mixed = kd === 'or' && /\) and \(/.test(c.src); if (mixed) return butW && orW ? -1 : 1; return (andW && !orW ? (kd === 'and' ? 0 : 2) : orW && !andW ? (kd === 'or' ? 0 : 2) : 1); };
        const cover = (c) => new Set(c.src.match(/x\d/g) || []).size; cands.sort((p, q) => (Math.min(cover(q), K) - Math.min(cover(p), K)) || (q.nc - p.nc) || (pref(p) - pref(q)) || (q.n - p.n) * (andW || orW ? 1 : -1) || (st.indexOf(p.y) < 0 ? 1 : 0) - (st.indexOf(q.y) < 0 ? 1 : 0));
        const vars = Array.from({ length: K }, (_, i) => 'x' + i).join(', ');
        const mk = (h) => { const other = h.y === ls[0] ? ls[1] : ls[0]; return { ok: true, source: 'def main():\n    ' + vars + (K === 1 ? ', ' : '') + ' = map(int, input().split())\n    print(' + JSON.stringify(h.y) + ' if ' + h.src + ' else ' + JSON.stringify(other) + ')\n', kind: 'predicate', level: 'L0', size: h.src.length, tried: cands.length, ambiguous: false, desc: '條件 ' + h.src + ' → ' + h.y, matrixForm: { kind: 'predicate', expr: h.src } }; };
        const top = []; const sv = new Set(); for (const c of cands) { const key = c.v.join('') + c.y; if (sv.has(key)) continue; sv.add(key); top.push(c); if (top.length >= 40) break; }
        const h = cands[0]; const dist = new Set(cands.filter((c) => c.n === h.n && c.nc === h.nc).map((c) => c.v.join('') + c.y)).size;
        const r0 = mk(h); r0.ambiguous = dist > 1; r0.alternatives = top.slice(1).map((c) => { const r = mk(c); r.ambiguous = true; return r; });
        // 主動要更多範例（資料面）：挑幾個「前幾名候選答案不一致」的輸入，請使用者（或卡片）補這幾筆的輸出，下一輪就能分出誰對
        if (r0.ambiguous || top.length > 1) { const sug = []; for (let j = nE; j < pts.length && sug.length < 4; j++) { const vals = new Set(top.slice(0, 8).map((c) => c.v[j])); if (vals.size > 1) sug.push(pts[j].join(' ')); } r0.suggest = sug; }
        return r0;
    }
    // ---- multi：每個輸出欄位各自找公式 ----
    function makeMulti(M) {
        return function synthMulti(o) {
            const exs = o.examples || []; const P = parseIns(exs); if (!P) return { ok: false, reason: '不是「k 個整數進」' };
            let sep = null; for (const s of [/\s+/, /:/, /,/]) { const rows = exs.map((e) => e.out.trim().split(s)); if (rows.every((r) => r.length === rows[0].length && r.length >= 2 && r.length <= 4 && r.every((x) => isInt(x.trim())))) { sep = s; break; } }
            if (!sep) return { ok: false, reason: '輸出不是 2～4 個以空白／冒號／逗號隔開的整數' };
            const m = exs[0].out.trim().split(sep).length; const cols = []; let tried = 0;
            for (let c = 0; c < m; c++) { const r = M.synthFormula({ statement: o.statement, examples: exs.map((e) => ({ in: e.in, out: e.out.trim().split(sep)[c].trim() })), budget: o.budget }); tried += r.tried || 0; if (!r.ok) return { ok: false, reason: '第 ' + (c + 1) + ' 個輸出欄位找不到公式：' + r.reason, tried }; cols.push([r].concat(r.alternatives || []).slice(0, 4).map((x) => x.matrixForm.expr)); }
            const sp = sep.source === ':' ? ':' : sep.source === ',' ? ',' : ' '; const vars = Array.from({ length: P.k }, (_, i) => 'x' + i).join(', ');
            const mk = (exprs, amb) => ({ ok: true, source: 'def main():\n    ' + vars + (P.k === 1 ? ', ' : '') + ' = map(int, input().split())\n    print(' + (sp === ' ' ? exprs.join(', ') : exprs.map((e) => 'str(' + e + ')').join(' + ' + JSON.stringify(sp) + ' + ')) + ')\n', kind: 'multi', level: 'L0', size: exprs.join('').length, tried, ambiguous: amb, desc: '多輸出公式 ' + exprs.join(' ｜ '), matrixForm: { kind: 'multi', exprs } });
            const combos = [[]]; for (const col of cols) { const nx = []; for (const c of combos) for (const e of col) nx.push(c.concat([e])); combos.splice(0, combos.length, ...nx.slice(0, 64)); }
            const r0 = mk(combos[0], cols.some((c) => c.length > 1)); r0.alternatives = combos.slice(1, 40).map((c) => mk(c, true)); return r0;
        };
    }
    // ---- real：含真除法的小數公式 ----
    function synthReal(o) {
        const st = String(o.statement), exs = o.examples || []; const P = parseIns(exs.map((e) => ({ in: e.in }))); if (!P) return { ok: false, reason: '不是「k 個整數進」' };
        const os = exs.map((e) => e.out.trim()); if (os.some((x) => !/^-?\d+\.\d+$/.test(x))) return { ok: false, reason: '輸出不是小數' }; const dec = os[0].split('.')[1].length; if (os.some((x) => x.split('.')[1].length !== dec)) return { ok: false, reason: '小數位數不一致' };
        const K = P.k; const pts = P.pts.concat(probes(K, 10)); const nE = P.pts.length; const want = os.map(Number); const eps = 0.5 * Math.pow(10, -dec) + 1e-9; const C = stmtNums(st).concat([K, 1, 2, 10, 100]).filter((x, i, a) => x >= 1 && a.indexOf(x) === i).slice(0, 12);
        const seen = new Map(); const by = []; let tried = 0; const hits = []; const budget = (o.budget && o.budget.candidates) || 250000;
        const add = (n, e, v) => { if (!v.every((x) => Number.isFinite(x) && Math.abs(x) < 1e12)) return; const key = v.map((x) => x.toFixed(6)).join(','); if (seen.has(key)) return; seen.set(key, e); (by[n] = by[n] || []).push({ e, v }); tried++; if (v.slice(0, nE).every((x, j) => Math.abs(x - want[j]) < eps)) hits.push({ e, v }); };
        for (let i = 0; i < K; i++) add(1, 'x' + i, pts.map((p) => p[i])); for (const c of C) add(1, String(c), pts.map(() => c));
        const OPS = [['+', (a, b) => a + b, 1], ['-', (a, b) => a - b, 0], ['*', (a, b) => a * b, 1], ['/', (a, b) => (b === 0 ? NaN : a / b), 0]];
        let firstN = 0; for (let n = 3; n <= 9 && (!hits.length || (n <= firstN + 2 && hits.length < 12)); n++) { if (hits.length && !firstN) firstN = n - 1; for (let i = 1; i <= n - 2; i++) { const j = n - 1 - i; for (const a of by[i] || []) for (const b of by[j] || []) for (const [op, f, comm] of OPS) { if (tried > budget) return { ok: false, reason: '枚舉預算用盡（大小 ' + n + '）', tried }; if (comm && i > j) continue; add(n, '(' + a.e + ' ' + op + ' ' + b.e + ')', a.v.map((x, t) => f(x, b.v[t]))); } } }
        if (!hits.length) return { ok: false, reason: '大小≤9 的小數公式裡沒有符合所有範例的', tried };
        const vars = Array.from({ length: K }, (_, i) => 'x' + i).join(', '); const mk = (h) => ({ ok: true, source: 'def main():\n    ' + vars + (K === 1 ? ', ' : '') + ' = map(int, input().split())\n    print("%.' + dec + 'f" % ' + h.e + ')\n', kind: 'real', level: 'L0', size: h.e.length, tried, ambiguous: hits.length > 1 && new Set(hits.map((x) => x.v.map((y) => y.toFixed(6)).join(','))).size > 1, desc: '小數公式 ' + h.e + '（' + dec + ' 位）', matrixForm: { kind: 'real', expr: h.e, decimals: dec } });
        const r0 = mk(hits[0]); r0.alternatives = hits.slice(1, 10).map(mk); return r0;
    }
    function install(M) { if (!M || !M.register) return false; M.register('predicate', synthPredicate, { order: 92, level: 'L0', note: '條件判斷（原子條件 and／or，常數取自敘述）' }); M.register('multi', makeMulti(M), { order: 93, level: 'L0', note: '多個整數輸出（每欄各自找公式）' }); M.register('real', synthReal, { order: 94, level: 'L0', note: '小數公式（含真除法）' }); return true; }
    return { install, synthPredicate, synthReal, stmtNums };
});
