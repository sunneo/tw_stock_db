/* 矩陣層 L4：草圖（sketch）合成——比「逐條指令窮舉」更好的方法。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §3「骨架優先、洞窮舉」。
 *
 * 做法：不枚舉 VM 指令（候選數 ~ |指令集|^長度，十餘條就爆炸），而是把「整數進、整數／標籤出」的迴圈題拆成幾個固定骨架，每個骨架只有幾個「洞」要填，
 * 洞的選項都是小集合；用範例剪枝，並且骨架的昂貴部分（因數表、質因數分解、數字展開、質數篩）對每個範例只算一次、所有候選共用：
 *   divisor-fold   對 n 的因數（全部／真因數）篩選（質數／奇／偶／平方）→ 映射（1、d、d²、n/d）→ 歸約（和／個數／最大／最小）→ 後處理（原值／與 n 比較／奇偶）
 *   prime-fold     對 n 的質因數（含重複／相異）映射（p、p-1、1）→ 歸約；另有歐拉函數 φ
 *   iterate        n ← 步驟（考拉茲、偶減半奇減一、數位和、數位平方和、扣最大平方…），直到停止條件；輸出步數／最終值／最大值／是否到 1
 *   digit-fold     n 在 b 進位（10、2、16、敘述裡的）的數字 → 映射 → 歸約
 *   range-fold     對 1..n（含或不含 n）篩選（質數、平方、a 的倍數、a 或 b 的倍數、奇偶…）→ 映射 → 歸約
 *   series         Σ 或 Π（i=1..n）f(i)（i、i²、i³、i!、2^i、費氏、因數個數），可選取模
 *   base           (n, k) → n 的 k 進位字串／數字和／位數
 *   two-int        gcd、lcm、冪、冪取模、組合數、位元運算、漢明距離…
 * 每個候選有 JS 版（驗證範例用）與 Python 版（輸出），測試要求兩版在隨機輸入上一致。保證會停：候選數固定，迭代有步數上限。
 * 排序：敘述關鍵字命中的先；其次成本低的。多個候選在探測輸入上輸出不同＝ambiguous（附 suggest）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixSketch = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    const isPrime = (x) => { if (x < 2) return false; for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; };
    const isqrt = (x) => { let r = Math.floor(Math.sqrt(x)); while (r * r > x) r--; while ((r + 1) * (r + 1) <= x) r++; return r; };
    const isSq = (x) => x >= 0 && isqrt(x) ** 2 === x;
    const gcd = (a, b) => { while (b) { [a, b] = [b, a % b]; } return Math.abs(a); };
    const digs = (x, b) => { const o = []; if (x === 0) return [0]; while (x > 0) { o.push(x % b); x = Math.floor(x / b); } return o.reverse(); };
    const dsum = (x) => digs(x, 10).reduce((a, b) => a + b, 0);
    const SAFE = 9007199254740991;
    // ---- 每個範例只算一次的共用資料 ----
    function context(n) {
        const c = { n, div: null, pf: null, pfd: null };
        c.divisors = () => { if (!c.div) { const a = [], b = []; for (let d = 1; d * d <= n; d++) if (n % d === 0) { a.push(d); if (d * d !== n) b.push(n / d); } c.div = a.concat(b.reverse()); } return c.div; };
        c.factors = () => { if (!c.pf) { const f = []; let m = n, p = 2; while (m > 1 && p * p <= m) { while (m % p === 0) { f.push(p); m /= p; } p++; } if (m > 1) f.push(m); c.pf = f; c.pfd = [...new Set(f)]; } return c.pf; };
        c.distinct = () => { c.factors(); return c.pfd; };
        return c;
    }
    const RED = {
        sum: { js: (v) => v.reduce((a, b) => a + b, 0), py: (e) => 'sum(' + e + ')' }, count: { js: (v) => v.length, py: (e) => 'len(' + e + ')' },
        max: { js: (v) => (v.length ? Math.max(...v) : 0), py: (e) => 'max(' + e + ', default=0)' }, min: { js: (v) => (v.length ? Math.min(...v) : 0), py: (e) => 'min(' + e + ', default=0)' },
        prod: { js: (v) => (v.length && typeof v[0] === 'bigint' ? v.reduce((a, b) => a * BigInt(b), 1n) : v.reduce((a, b) => a * b, 1)), py: (e) => 'prod(' + e + ')' },
    };
    const POSTS = { id: { js: (r) => r, py: (r) => r, label: false }, eqn: { js: (r, n) => r === n, py: (r) => r + ' == n', label: true }, gtn: { js: (r, n) => r > n, py: (r) => r + ' > n', label: true }, ltn: { js: (r, n) => r < n, py: (r) => r + ' < n', label: true }, eq2: { js: (r) => r === 2, py: (r) => r + ' == 2', label: true }, eq1: { js: (r) => r === 1, py: (r) => r + ' == 1', label: true }, even: { js: (r) => r % 2 === 0, py: (r) => r + ' % 2 == 0', label: true }, odd: { js: (r) => r % 2 === 1, py: (r) => r + ' % 2 == 1', label: true } };
    const HELP = {
        is_prime: ['def is_prime(x):', '    if x < 2:', '        return False', '    d = 2', '    while d * d <= x:', '        if x % d == 0:', '            return False', '        d += 1', '    return True'],
        prod: ['def prod(v):', '    r = 1', '    for x in v:', '        r *= x', '    return r'],
        digits: ['def digits(x, b):', '    o = []', '    while x > 0:', '        o.append(x % b)', '        x //= b', '    return o[::-1] or [0]'],
        is_square: ['def is_square(x):', '    r = int(x ** 0.5)', '    return any(k * k == x for k in (r - 1, r, r + 1))'],
        isqrt: ['def isqrt(x):', '    r = int(x ** 0.5)', '    while r * r > x:', '        r -= 1', '    while (r + 1) * (r + 1) <= x:', '        r += 1', '    return r'],
        factors: ['def factors(m):', '    f = []', '    p = 2', '    while m > 1:', '        while m % p == 0:', '            f.append(p)', '            m //= p', '        p += 1', '    return f'],
        dsum: ['def dsum(x):', '    return sum(int(c) for c in str(x))'],
        fib: ['def fib(i):', '    a, b = 0, 1', '    for _ in range(i):', '        a, b = b, a + b', '    return a'],
        tau: ['def tau(i):', '    return sum(1 for d in range(1, i + 1) if i % d == 0)'],
        binom: ['def binom(n, k):', '    r = 1', '    for i in range(1, k + 1):', '        r = r * (n - k + i) // i', '    return r'],
    };
    const cands = []; // 每個候選：{fam, id, kw, cost, vars, arity, f(ctxOrArgs)→值, py: [行…], help: [名稱…], label: bool}
    // ---- divisor-fold ----
    const DF = { all: { js: () => true, py: 'True', h: [] }, prime: { js: isPrime, py: 'is_prime(d)', h: ['is_prime'] }, odd: { js: (d) => d % 2 === 1, py: 'd % 2 == 1', h: [] }, even: { js: (d) => d % 2 === 0, py: 'd % 2 == 0', h: [] }, sq: { js: isSq, py: 'is_square(d)', h: ['is_square'] } };
    const DM = { one: { js: () => 1, py: '1' }, d: { js: (d) => d, py: 'd' }, d2: { js: (d) => d * d, py: 'd * d' }, nd: { js: (d, n) => n / d, py: 'n // d' } };
    for (const rg of ['all', 'proper']) for (const [fk, F] of Object.entries(DF)) for (const [mk, Mp] of Object.entries(DM)) for (const [rk, Rd] of Object.entries(RED)) {
        if (rk === 'prod' && mk === 'one') continue; const names = { sum: '和', count: '個數', max: '最大', min: '最小', prod: '乘積' };
        for (const [pk, P] of Object.entries(POSTS)) {
            cands.push({ fam: 'divisor-fold', id: ['因數', rg === 'proper' ? '真' : '全', fk, mk, rk, pk].join('/'), kw: /因數|約數|divisor|盈|虧|完全數|perfect/i, cost: 3 + (fk === 'all' ? 0 : 1) + (pk === 'id' ? 0 : 1), arity: 1, label: P.label, help: F.h.concat(rk === 'prod' ? ['prod'] : []),
                f: (c) => { const ds = c.divisors().filter((d) => (rg === 'all' || d !== c.n) && F.js(d)); return P.js(Rd.js(ds.map((d) => Mp.js(d, c.n))), c.n); },
                py: ['vals = [' + Mp.py + ' for d in range(1, n' + (rg === 'all' ? ' + 1' : '') + ') if n % d == 0' + (F.py === 'True' ? '' : ' and ' + F.py) + ']', 'r = ' + P.py(Rd.py('vals'))], names: names[rk] });
        }
    }
    // ---- prime-fold ----
    const PM = { p: { js: (p) => p, py: 'p' }, pm1: { js: (p) => p - 1, py: 'p - 1' }, one: { js: () => 1, py: '1' } };
    for (const lk of ['multi', 'distinct']) for (const [mk, Mp] of Object.entries(PM)) for (const [rk, Rd] of Object.entries(RED)) {
        if (rk === 'count' && mk !== 'one') continue; if (rk !== 'count' && mk === 'one') continue;
        for (const pk of ['id', 'eq1', 'eq2', 'even']) { const P = POSTS[pk];
            cands.push({ fam: 'prime-fold', id: ['質因數', lk, mk, rk, pk].join('/'), kw: /質因數|質因子|prime factor|分解/i, cost: 3 + (pk === 'id' ? 0 : 1), arity: 1, label: P.label, help: ['factors'].concat(rk === 'prod' ? ['prod'] : []),
                f: (c) => P.js(Rd.js((lk === 'multi' ? c.factors() : c.distinct()).map(Mp.js)), c.n),
                py: ['fs = factors(n)' + (lk === 'distinct' ? '' : ''), lk === 'distinct' ? 'fs = sorted(set(fs))' : 'fs = sorted(fs)', 'r = ' + P.py(Rd.py('[' + Mp.py + ' for p in fs]'))].filter((l, i) => !(i === 1 && false)) });
        }
    }
    cands.push({ fam: 'prime-fold', id: '歐拉函數 φ', kw: /歐拉|φ|phi|互質/i, cost: 3, arity: 1, label: false, help: ['factors'], f: (c) => { let r = c.n; for (const p of c.distinct()) r -= r / p; return r; }, py: ['r = n', 'for p in sorted(set(factors(n))):', '    r -= r // p'] });
    cands.push({ fam: 'prime-fold', id: '無平方因子', kw: /平方因子|squarefree|無平方/i, cost: 3, arity: 1, label: true, help: ['factors'], f: (c) => c.factors().length === c.distinct().length, py: ['fs = factors(n)', 'r = len(fs) == len(set(fs))'] });
    // ---- iterate ----
    const STEPS = {
        collatz: { js: (x) => (x % 2 === 0 ? x / 2 : 3 * x + 1), py: 'x // 2 if x % 2 == 0 else 3 * x + 1', kw: /3n\s*\+\s*1|考拉茲|collatz|3\s*倍加\s*1/i },
        'halve-or-dec': { js: (x) => (x % 2 === 0 ? x / 2 : x - 1), py: 'x // 2 if x % 2 == 0 else x - 1', kw: /偶數.*除以\s*2.*奇數.*減\s*1|減半/ },
        halve: { js: (x) => Math.floor(x / 2), py: 'x // 2', kw: /除以\s*2|減半|二分/ }, 'digit-sum': { js: dsum, py: 'dsum(x)', kw: /各位.*和|數位和|位數和/, h: ['dsum'] },
        'digit-sq': { js: (x) => digs(x, 10).reduce((a, d) => a + d * d, 0), py: 'sum(int(c) ** 2 for c in str(x))', kw: /平方.*和|平方的和/ }, 'drop-last': { js: (x) => Math.floor(x / 10), py: 'x // 10', kw: /去掉.*個位|除以\s*10/ },
        'sub-sq': { js: (x) => x - isqrt(x) ** 2, py: 'x - isqrt(x) ** 2', kw: /最大.*平方|完全平方/, h: ['isqrt'] }, 'sub-pow2': { js: (x) => x - 2 ** Math.floor(Math.log2(x)), py: 'x - 2 ** (x.bit_length() - 1)', kw: /2\s*的冪|二的冪/ },
        'sub-digitsum': { js: (x) => x - dsum(x), py: 'x - dsum(x)', kw: /減去.*各位/, h: ['dsum'] }, 'sub-1': { js: (x) => x - 1, py: 'x - 1', kw: /^$/ },
    };
    const STOPS = { eq1: { js: (x) => x === 1, cont: 'x != 1' }, eq0: { js: (x) => x === 0, cont: 'x != 0' }, lt10: { js: (x) => x < 10, cont: 'x >= 10' }, le1: { js: (x) => x <= 1, cont: 'x > 1' }, odd: { js: (x) => x % 2 === 1, cont: 'x % 2 == 0' }, even: { js: (x) => x % 2 === 0, cont: 'x % 2 == 1' } };
    const OUTS = { steps: { js: (s) => s.c, py: 'c' }, final: { js: (s) => s.x, py: 'x' }, max: { js: (s) => s.m, py: 'm' } };
    function iterate(stepf, stop, n, cycle) { let x = n, c = 0, m = x; const seen = new Set(); while (!(cycle ? (x === 1 || seen.has(x)) : stop.js(x))) { if (cycle) seen.add(x); x = stepf(x); c++; m = Math.max(m, x); if (c > 20000 || !(x >= 0) || x > SAFE) return null; } return { x, c, m }; }
    for (const [sk, St] of Object.entries(STEPS)) {
        for (const [tk, Sp] of Object.entries(STOPS)) for (const [ok, Ou] of Object.entries(OUTS)) {
            cands.push({ fam: 'iterate', id: ['迭代', sk, tk, ok].join('/'), kw: St.kw, cost: 4 + (ok === 'final' ? 0 : 0), arity: 1, label: false, help: (St.h || []), f: (c) => { const s = iterate(St.js, Sp, c.n, false); return s ? Ou.js(s) : null; },
                py: ['x = n', 'c = 0', 'm = x', 'while ' + Sp.cont + ' and c < 20000:', '    x = ' + St.py, '    c += 1', '    m = max(m, x)', 'r = ' + Ou.py] });
        }
        cands.push({ fam: 'iterate', id: ['迭代', sk, '循環前到1'].join('/'), kw: St.kw, cost: 5, arity: 1, label: true, help: (St.h || []), f: (c) => { const s = iterate(St.js, null, c.n, true); return s ? s.x === 1 : null; },
            py: ['x = n', 'seen = set()', 'while x != 1 and x not in seen:', '    seen.add(x)', '    x = ' + St.py, 'r = x == 1'] });
    }
    // ---- accumulate-until：k 從 1 起，s += f(k)，直到 s 達到 n；輸出 k（或最後的 s）----
    const ACCF = { k: { js: (k) => k, py: 'k' }, k2: { js: (k) => k * k, py: 'k * k' }, k3: { js: (k) => k * k * k, py: 'k ** 3' }, pow2: { js: (k) => Math.pow(2, k), py: '2 ** k' }, fact: { js: (k) => { let r = 1; for (let i = 2; i <= k; i++) r *= i; return r; }, py: 'fact(k)', h: 'fact' } };
    for (const [fk, F] of Object.entries(ACCF)) for (const cmp of ['ge', 'gt']) for (const ok of ['k', 's']) cands.push({ fam: 'accumulate', id: ['累加', fk, cmp, ok].join('/'), kw: /累加|加到|依序加|總和.*(大於|超過|達到)/, cost: 5, arity: 1, label: false, help: F.h ? [F.h] : [],
        f: (c) => { let s = 0, k = 0; while (cmp === 'ge' ? s < c.n : s <= c.n) { k++; s += F.js(k); if (k > 100000 || s > SAFE) return null; } return ok === 'k' ? k : s; }, py: ['s = 0', 'k = 0', 'while s ' + (cmp === 'ge' ? '<' : '<=') + ' n and k < 100000:', '    k += 1', '    s += ' + F.py, 'r = ' + ok] });
    // ---- digit-fold ----
    const DGM = { d: { js: (d) => d, py: 'd' }, d2: { js: (d) => d * d, py: 'd * d' }, ev: { js: (d) => (d % 2 === 0 ? 1 : 0), py: '1 if d % 2 == 0 else 0' }, od: { js: (d) => d % 2, py: 'd % 2' }, nz: { js: (d) => (d ? 1 : 0), py: '1 if d else 0' }, one: { js: () => 1, py: '1' } };
    for (const b of [10, 2, 16, 3, 8]) for (const [mk, Mp] of Object.entries(DGM)) for (const [rk, Rd] of Object.entries(RED)) {
        if ((rk === 'count') !== (mk === 'one') && rk === 'count') continue; if (mk === 'one' && rk !== 'count') continue;
        for (const pk of ['id', 'even', 'odd']) { const P = POSTS[pk];
            cands.push({ fam: 'digit-fold', id: ['數字', b + '進位', mk, rk, pk].join('/'), kw: b === 2 ? /二進位|binary|位元/i : b === 10 ? /數字|位數|各位/ : /進位/, cost: 3 + (b === 10 ? 0 : 1) + (pk === 'id' ? 0 : 1), arity: 1, label: P.label, base: b, help: ['digits'].concat(rk === 'prod' ? ['prod'] : []),
                f: (c) => P.js(Rd.js(digs(c.n, b).map(Mp.js)), c.n), py: ['r = ' + P.py(Rd.py('[' + Mp.py + ' for d in digits(n, ' + b + ')]'))] });
        }
    }
    // ---- range-fold ----
    function rangeCands(C) {
        const preds = [['prime', isPrime, 'is_prime(x)', ['is_prime'], /質數|prime/i], ['sq', isSq, 'is_square(x)', ['is_square'], /平方/], ['odd', (x) => x % 2 === 1, 'x % 2 == 1', [], /奇數/], ['even', (x) => x % 2 === 0, 'x % 2 == 0', [], /偶數/], ['all', () => true, 'True', [], /^$/],
            ['dsum-even', (x) => dsum(x) % 2 === 0, 'dsum(x) % 2 == 0', ['dsum'], /數字和.*偶/], ['pal', (x) => String(x) === [...String(x)].reverse().join(''), 'str(x) == str(x)[::-1]', [], /回文/]];
        for (const a of C) { preds.push(['mult' + a, (x) => x % a === 0, 'x % ' + a + ' == 0', [], new RegExp(a + '\\s*的倍數')]); for (const b of C) if (a < b) { preds.push(['mult' + a + 'or' + b, (x) => x % a === 0 || x % b === 0, 'x % ' + a + ' == 0 or x % ' + b + ' == 0', [], new RegExp(a + '.*(或|還是|or).*' + b + '|' + b + '.*(或|or).*' + a)]); preds.push(['mult' + a + 'and' + b, (x) => x % a === 0 && x % b === 0, 'x % ' + a + ' == 0 and x % ' + b + ' == 0', [], new RegExp(a + '.*(且|和|與|and).*' + b)]); } }
        const out = [];
        for (const incl of [true, false]) for (const [pk, pf, pp, ph, pkw] of preds) for (const [mk, mf, mp] of [['one', () => 1, '1'], ['x', (x) => x, 'x'], ['x2', (x) => x * x, 'x * x']]) for (const rk of ['sum', 'count', 'max']) {
            if ((mk === 'one') !== (rk === 'count') && (mk === 'one' || rk === 'count')) continue; const Rd = RED[rk];
            for (const pk2 of ['id']) out.push({ fam: 'range-fold', id: ['範圍', incl ? '1..n' : '1..n-1', pk, mk, rk, pk2].join('/'), kw: pkw, cost: 4 + (incl ? 0 : 1), arity: 1, label: false, help: ph.concat(rk === 'sum' ? [] : []), n: incl,
                f: (c) => { if (c.n > 100000) return null; const v = []; for (let x = 1; incl ? x <= c.n : x < c.n; x++) if (pf(x)) v.push(mf(x)); return Rd.js(v); }, py: ['r = ' + Rd.py('[' + mp + ' for x in range(1, n' + (incl ? ' + 1' : '') + ') if ' + pp + ']')] });
        }
        return out;
    }
    // ---- series（BigInt）----
    const SERF = { i: { js: (i) => BigInt(i), py: 'i' }, i2: { js: (i) => BigInt(i) ** 2n, py: 'i * i' }, i3: { js: (i) => BigInt(i) ** 3n, py: 'i ** 3' }, pow2: { js: (i) => 2n ** BigInt(i), py: '2 ** i' }, fact: { js: (i) => { let r = 1n; for (let k = 2; k <= i; k++) r *= BigInt(k); return r; }, py: 'fact(i)', h: 'fact' }, fib: { js: (i) => { let a = 0n, b = 1n; for (let k = 0; k < i; k++) [a, b] = [b, a + b]; return a; }, py: 'fib(i)', h: 'fib' }, tri: { js: (i) => BigInt(i * (i + 1) / 2), py: 'i * (i + 1) // 2' } };
    HELP.fact = ['def fact(i):', '    r = 1', '    for k in range(2, i + 1):', '        r *= k', '    return r'];
    function seriesCands(M) {
        const out = [];
        for (const [fk, F] of Object.entries(SERF)) for (const rk of ['sum', 'prod']) for (const m of (M.length ? [null].concat(M) : [null])) for (const post of ['id', 'len', 'dsum']) {
            if (post !== 'id' && m) continue;
            if (rk === 'prod' && (fk === 'i2' || fk === 'i3' || fk === 'tri' || fk === 'pow2' || fk === 'fib')) continue;
            out.push({ fam: 'series', id: ['級數', fk, rk, m ? 'mod' + m : '', post === 'id' ? '' : post].join('/'), kw: rk === 'sum' ? /總和|和|加總|sum|累加/i : /乘積|階乘|product|factorial/i, cost: 3 + (m ? 1 : 0), arity: 1, label: false, help: (F.h ? [F.h] : []),
                f: (c) => { if (c.n > 400) return null; const mm = m ? BigInt(m) : null; let acc = rk === 'sum' ? 0n : 1n; for (let i = 1; i <= c.n; i++) { acc = rk === 'sum' ? acc + F.js(i) : acc * F.js(i); if (mm) acc %= mm; } return post === 'id' ? acc : post === 'len' ? BigInt(String(acc).length) : [...String(acc)].reduce((a, ch) => a + BigInt(ch), 0n); },
                py: ['r = ' + (rk === 'sum' ? '0' : '1'), 'for i in range(1, n + 1):', '    r ' + (rk === 'sum' ? '+' : '*') + '= ' + F.py + (m ? '' : ''), ...(m ? ['    r %= ' + m] : []), ...(post === 'len' ? ['r = len(str(r))'] : post === 'dsum' ? ['r = sum(int(c) for c in str(r))'] : [])] });
        }
        return out;
    }
    // ---- 兩個以上整數 ----
    const BIG = (v) => BigInt(v);
    const modpow = (a, b, m) => { let r = 1n, x = BIG(a) % m; let e = BIG(b); while (e > 0n) { if (e & 1n) r = r * x % m; x = x * x % m; e >>= 1n; } return r; };
    const popc = (x) => { let c = 0; while (x) { c += x & 1; x = Math.floor(x / 2); } return c; };
    const BINF = [
        ['gcd', 2, (a, b) => gcd(a, b), 'import math\nr = math.gcd(a, b)', /最大公因數|gcd|公約數/i], ['lcm', 2, (a, b) => a / gcd(a, b) * b, 'import math\nr = a * b // math.gcd(a, b)', /最小公倍數|lcm/i],
        ['a**b', 2, (a, b) => (b <= 60 && Math.pow(a, b) <= SAFE ? Math.pow(a, b) : null), 'r = a ** b', /次方|冪|power|\^/i], ['xor', 2, (a, b) => (a ^ b) >>> 0, 'r = a ^ b', /互斥或|xor|異或/i], ['and', 2, (a, b) => (a & b) >>> 0, 'r = a & b', /位元.*且|\band\b|&/i], ['or', 2, (a, b) => (a | b) >>> 0, 'r = a | b', /位元.*或|\bor\b/i],
        ['hamming', 2, (a, b) => popc((a ^ b) >>> 0), "r = bin(a ^ b).count('1')", /漢明|hamming|不同的位元|位元.*不同/i], ['binom', 2, (n, k) => { if (k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) { r = r * (n - k + i) / i; if (r > SAFE) return null; } return Math.round(r); }, 'r = binom(a, b)', /組合|binom|choose|取\s*k/i],
        ['perm', 2, (n, k) => { let r = 1; for (let i = 0; i < k; i++) { r *= (n - i); if (r > SAFE) return null; } return r; }, 'r = 1\nfor i in range(b):\n    r *= a - i', /排列/], ['absdiff', 2, (a, b) => Math.abs(a - b), 'r = abs(a - b)', /差的絕對值|絕對差/],
        ['gcd3', 3, (a, b, c) => gcd(gcd(a, b), c), 'import math\nr = math.gcd(math.gcd(a, b), c)', /最大公因數|gcd/i], ['powmod3', 3, (a, b, m) => Number(modpow(a, b, BIG(m))), 'r = pow(a, b, c)', /餘數|取模|mod|除以/i],
    ];
    function twoIntCands(M) {
        const out = [];
        for (const [id, ar, f, py, kw] of BINF) out.push({ fam: 'two-int', id, kw, cost: 2, arity: ar, label: false, help: id === 'binom' ? ['binom'] : [], f: (c) => f(...c.args), py: py.split('\n'), vars: ['a', 'b', 'c'].slice(0, ar) });
        for (const m of M) out.push({ fam: 'two-int', id: 'a**b % ' + m, kw: /餘數|取模|mod|除以/i, cost: 3, arity: 2, label: false, help: [], f: (c) => Number(modpow(c.args[0], c.args[1], BIG(m))), py: ['r = pow(a, b, ' + m + ')'], vars: ['a', 'b'] });
        return out;
    }
    // ---- base（n, k）----
    const DIG = '0123456789abcdef';
    const baseCands = [
        { fam: 'base', id: 'n 的 k 進位字串', kw: /進位|base/i, cost: 3, arity: 2, label: false, str: true, help: [], f: (c) => { const [n, k] = c.args; if (k < 2 || k > 16 || n < 0) return null; return digs(n, k).map((d) => DIG[d]).join(''); }, py: ['ds = []', 'x = n', 'while x:', '    ds.append("0123456789abcdef"[x % k])', '    x //= k', 'r = "".join(reversed(ds)) or "0"'], vars: ['n', 'k'] },
        { fam: 'base', id: 'n 的 k 進位字串（大寫）', kw: /大寫/, cost: 4, arity: 2, label: false, str: true, help: [], f: (c) => { const [n, k] = c.args; if (k < 2 || k > 16 || n < 0) return null; return digs(n, k).map((d) => DIG[d]).join('').toUpperCase(); }, py: ['ds = []', 'x = n', 'while x:', '    ds.append("0123456789ABCDEF"[x % k])', '    x //= k', 'r = "".join(reversed(ds)) or "0"'], vars: ['n', 'k'] },
        { fam: 'base', id: 'n 在 k 進位的數字和', kw: /進位.*(和|總和)/, cost: 3, arity: 2, label: false, help: [], f: (c) => { const [n, k] = c.args; return k < 2 ? null : digs(n, k).reduce((a, b) => a + b, 0); }, py: ['r = 0', 'x = n', 'while x:', '    r += x % k', '    x //= k'], vars: ['n', 'k'] },
        { fam: 'base', id: 'n 在 k 進位的位數', kw: /進位.*位數|幾位/, cost: 3, arity: 2, label: false, help: [], f: (c) => { const [n, k] = c.args; return k < 2 ? null : digs(n, k).length; }, py: ['r = 0', 'x = n', 'while x:', '    r += 1', '    x //= k', 'r = max(r, 1)'], vars: ['n', 'k'] },
        { fam: 'base', id: 'n 的 k 進位表示是否回文', kw: /回文/, cost: 4, arity: 2, label: true, help: [], f: (c) => { const [n, k] = c.args; if (k < 2) return null; const d = digs(n, k); return d.join(',') === d.slice().reverse().join(','); }, py: ['ds = []', 'x = n', 'while x:', '    ds.append(x % k)', '    x //= k', 'r = ds == ds[::-1]'], vars: ['n', 'k'] },
    ];
    const stNums = (st) => [...new Set((String(st).match(/\d+/g) || []).map(Number).filter((x) => x >= 2 && x <= 1000))];
    const stMods = (st) => { const o = []; if (/10\s*\^\s*9\s*\+\s*7|1000000007|1e9\s*\+\s*7/i.test(st)) o.push(1000000007); if (/998244353/.test(st)) o.push(998244353); for (const x of (String(st).match(/\d{3,10}/g) || [])) { const v = Number(x); if (v > 1 && v < 2 ** 31 && !o.includes(v) && o.length < 4) o.push(v); } return o; };
    // ---- 入口 ----
    function parseExamples(exs) {
        const I = [], O = []; let ar = null;
        for (const e of exs) { const il = String(e.in).replace(/\n$/, '').split('\n'); if (il.length !== 1) return null; const t = il[0].trim().split(/\s+/); if (!t.every(isInt) || t.length < 1 || t.length > 3) return null; if (ar === null) ar = t.length; else if (ar !== t.length) return null; const ol = String(e.out).replace(/\s+$/, '').split('\n'); if (ol.length !== 1 || /\s/.test(ol[0].trim()) || !ol[0].trim()) return null; I.push(t.map(Number)); O.push(ol[0].trim()); }
        if (I.some((a) => a.some((x) => Math.abs(x) > SAFE))) return null;
        return { I, O, ar };
    }
    function pyProgram(c, label, yes, no) {
        const helpers = []; const need = new Set(c.help || []); const addH = (h) => { if (!HELP[h]) return; if (!helpers.includes(h)) helpers.push(h); }; need.forEach(addH);
        const body = c.py.filter((l) => !/^import /.test(l)); const imps = c.py.filter((l) => /^import /.test(l));
        const vars = c.vars || (c.arity === 1 ? ['n'] : ['a', 'b', 'c'].slice(0, c.arity));
        const L = []; for (const h of ['prod', 'is_prime', 'is_square', 'isqrt', 'dsum', 'digits', 'factors', 'fact', 'fib', 'tau', 'binom']) if (helpers.includes(h)) { L.push(...HELP[h], ''); }
        L.push('def main():'); for (const l of imps) L.push('    ' + l);
        L.push(c.arity === 1 ? '    n = int(input())' : '    ' + vars.join(', ') + ' = map(int, input().split())');
        for (const l of body) L.push('    ' + l);
        L.push(label ? '    print(' + JSON.stringify(yes) + ' if r else ' + JSON.stringify(no) + ')' : '    print(r)');
        return L.join('\n') + '\n';
    }
    function synthSketch(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const P = parseExamples(exs); if (!P) return { ok: false, reason: '不是「1～3 個整數進、一個詞出」' };
        const labelsEx = [...new Set(P.O)]; const outInt = P.O.every(isInt);
        const nums = stNums(st).slice(0, 8); const mods = stMods(st);
        let pool = cands.filter((c) => c.arity === P.ar);
        if (P.ar === 1) pool = pool.concat(rangeCands([2, 3, 4, 5, 6, 7, 9, 10].concat(nums.filter((x) => x <= 100)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 10)), seriesCands(mods));
        if (P.ar >= 2) pool = pool.concat(twoIntCands(mods).filter((c) => c.arity === P.ar), baseCands.filter((c) => c.arity === P.ar));
        const ctxs = P.I.map((a) => { const c = context(a[0]); c.args = a; return c; });
        const stLabels = [...st.matchAll(/(?:輸出|印出|印|print)\s*([A-Za-z]+)/g)].map((m) => m[1]); const lbls = labelsEx.filter((x) => !isInt(x)).concat(stLabels.filter((x) => !labelsEx.includes(x)));
        const hits = []; let tried = 0;
        for (const c of pool) {
            tried++; let vals; try { vals = ctxs.map((cx) => c.f(cx)); } catch (e) { continue; } if (vals.some((v) => v === null || v === undefined)) continue;
            if (c.label) {
                if (outInt || labelsEx.length > 2 || lbls.length < 2 || lbls.length > 3) continue; const ls = labelsEx.length === 2 ? labelsEx : lbls.slice(0, 2); if (ls.length < 2) continue;
                const first = st.indexOf(ls[0]) <= st.indexOf(ls[1]) || st.indexOf(ls[1]) < 0 ? [ls[0], ls[1]] : [ls[1], ls[0]]; const orders = [first, [first[1], first[0]]]; const inSt = ls.some((l) => st.indexOf(l) >= 0);
                for (const [y, nn] of (inSt ? orders.slice(0, 1) : orders)) if (vals.every((v, i) => P.O[i] === (v ? y : nn))) { hits.push({ c, yes: y, no: nn, score: (c.kw && c.kw.test(st) ? 3 : 0) - c.cost }); break; }
            } else if (c.str) { if (vals.every((v, i) => String(v) === P.O[i])) hits.push({ c, score: (c.kw && c.kw.test(st) ? 3 : 0) - c.cost }); }
            else if (outInt && vals.every((v, i) => String(typeof v === 'bigint' ? v : v) === P.O[i] || (typeof v === 'number' && Number.isInteger(v) && String(v) === P.O[i]))) hits.push({ c, score: (c.kw && c.kw.test(st) ? 3 : 0) - c.cost });
        }
        if (!hits.length) return { ok: false, reason: '草圖庫（因數／質因數／迭代／數字／範圍／級數／雙整數／進位，候選 ' + tried + ' 個）裡沒有符合所有範例的', tried };
        hits.sort((a, b) => b.score - a.score);
        // 以探測輸入去掉等價候選；不同的＝ambiguous
        const probes = []; for (let k = 0; k < 14; k++) probes.push(Array.from({ length: P.ar }, (_, j) => (k * 7 + j * 5 + 3) % 40 + (j === 0 ? 2 : 1)));
        const sig = (h) => probes.map((a) => { try { const cx = context(a[0]); cx.args = a; const v = h.c.f(cx); return h.c.label ? (v ? 1 : 0) : String(v); } catch (e) { return 'e'; } }).join('|');
        const s0 = sig(hits[0]); const seen = new Set([s0]); const alts = []; for (const h of hits.slice(1)) { const s = sig(h); if (!seen.has(s)) { seen.add(s); alts.push(h); } }
        const mk = (h) => ({ ok: true, source: pyProgram(h.c, h.c.label, h.yes, h.no), kind: 'sketch', level: 'L4', size: h.c.py.length, tried, ambiguous: false, desc: '草圖（' + h.c.fam + '）：' + h.c.id, matrixForm: { kind: 'sketch', family: h.c.fam, id: h.c.id } });
        const r0 = mk(hits[0]); r0.ambiguous = alts.length > 0 && !(alts.every((a) => a.score < hits[0].score - 1.5)); r0.alternatives = alts.slice(0, 30).map(mk);
        if (alts.length) { const sg = []; for (const a of probes) { const cx = context(a[0]); cx.args = a; let x; try { x = hits[0].c.f(cx); } catch (e) { continue; } const other = new Set(); for (const h of alts.slice(0, 12)) { try { const v = h.c.f(cx); if (String(v) !== String(x) && v !== null) other.add(h.c.label ? (v ? h.yes : h.no) : String(v)); } catch (e) { /* 略過 */ } } if (other.size) sg.push({ in: a.join(' ') + '\n', candidates: [hits[0].c.label ? (x ? hits[0].yes : hits[0].no) : String(x)].concat([...other]).slice(0, 4) }); if (sg.length >= 3) break; } r0.suggest = sg; }
        return r0;
    }
    function install(M) { if (!M || !M.register) return false; M.register('sketch', synthSketch, { order: 41, level: 'L4', note: '草圖合成：因數／質因數／迭代／數字／範圍／級數／雙整數／進位（骨架＋小洞窮舉）' }); return true; }
    return { install, synthSketch, cands, context, rangeCands, seriesCands, twoIntCands, baseCands, pyProgram, HELP, isPrime, digs };
});
