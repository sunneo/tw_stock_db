/* 「多個小矩陣＋狀態機串起來」的驗證程式（評估用，不進產品）。對應 DESIGN.matrix-algorithms.md 第 9 節。
 *
 * 機器 = 有限個控制狀態；每個狀態做下列其中一件事：
 *   { mat: M, next }                  對暫存器向量 v（最後一格固定 1，所以是仿射）套一個小矩陣：v ← M·v
 *   { read: i, next, eof }            從輸入讀下一個整數放進暫存器 i；沒有輸入就跳到 eof
 *   { if: {op:'eq'|'lt', a, b|c}, then, else }   守衛：暫存器 a 與暫存器 b（或常數 c）比較，決定下一個狀態
 *   { halt: 名稱, reg?, value? }       停機；回報名稱與（可選）某暫存器／常數的值
 * 沒有守衛、也沒有 read 以外的資料相依 ⇒ 就是加權自動機（區塊矩陣）；有「暫存器 vs 暫存器／常數」的守衛 ⇒ 暫存器機。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_forms_core.js'));
    else root.FaMatrixMachine = factory(root.FaMatrixForms);
})(typeof self !== 'undefined' ? self : this, function (MF) {
    'use strict';

    // 仿射矩陣：assigns = [[i, {j: 係數, …, c: 常數}], …]；沒列到的暫存器保持不變
    function aff(R, assigns) {
        const M = Array.from({ length: R + 1 }, (_, i) => Array.from({ length: R + 1 }, (_, j) => (i === j ? 1 : 0)));
        for (const [i, spec] of assigns) { M[i] = new Array(R + 1).fill(0); for (const [k, v] of Object.entries(spec)) M[i][k === 'c' ? R : +k] = v; }
        return M;
    }
    function run(prog, tokens, opts) {
        opts = opts || {}; const R = prog.R, mod = prog.mod || 0, max = opts.maxSteps || 5000000;
        const v = new Array(R + 1).fill(0); v[R] = 1; let st = prog.start, ip = 0, steps = 0, matSteps = 0;
        const val = (x) => (x.c !== undefined ? x.c : v[x.b]);
        while (steps++ < max) {
            const s = prog.states[st]; if (!s) throw new Error('沒有這個狀態：' + st);
            if (s.halt !== undefined) return { halted: s.halt, value: s.value !== undefined ? s.value : (s.reg !== undefined ? v[s.reg] : undefined), regs: v.slice(0, R), steps, matSteps };
            if (s.mat) {
                const out = new Array(R + 1); for (let i = 0; i <= R; i++) { let a = 0; for (let j = 0; j <= R; j++) { const m = s.mat[i][j]; if (m) a = mod ? (a + MF.mulmod(m, v[j], mod)) % mod : a + m * v[j]; } out[i] = a; }
                for (let i = 0; i <= R; i++) v[i] = out[i]; matSteps++; st = s.next;
            } else if (s.read !== undefined) { if (ip < tokens.length) { v[s.read] = tokens[ip++]; st = s.next; } else st = s.eof; }
            else if (s.if) { const g = s.if; const l = v[g.a], r = g.c !== undefined ? g.c : v[g.b]; st = (g.op === 'eq' ? l === r : l < r) ? s.then : s.else; }
            else throw new Error('不認得的狀態內容：' + JSON.stringify(s));
        }
        return { halted: '超過最大步數', steps, regs: v.slice(0, R) };
    }
    // 規模：控制狀態數、矩陣數、最大矩陣維度、守衛數
    function size(prog) {
        const S = Object.values(prog.states); const mats = S.filter((s) => s.mat); return { states: S.length, matrices: mats.length, guards: S.filter((s) => s.if).length, maxDim: prog.R + 1 };
    }

    // ---------- 程式：每個都是「小矩陣＋控制」 ----------
    // 讀入 n → 初始化 (a,b)=(0,1) → 迴圈（n==0 就出口，否則 (a,b)←(b,a+b)、n←n−1）→ 輸出 a（取模：半環用 count%p）
    function fibProgram(p) {
        const R = 3; return { R, mod: p, start: 'read', states: {
            read: { read: 0, next: 'init', eof: 'out' }, init: { mat: aff(R, [[1, { c: 0 }], [2, { c: 1 }]]), next: 'loop' },
            loop: { if: { op: 'eq', a: 0, c: 0 }, then: 'out', else: 'step' },
            step: { mat: aff(R, [[1, { 2: 1 }], [2, { 1: 1, 2: 1 }], [0, { 0: 1, c: p ? p - 1 : -1 }]]), next: 'loop' }, out: { halt: 'done', reg: 1 } } };
    }
    // 輸入是 0／1 組成的數字、用 2 隔開（每個數字至少一位）；數有幾個能被 3 整除。控制狀態＝餘數（DFA），計數器是一個 2×2 的小矩陣。
    function divCountProgram() {
        const R = 2, S = {}; // 暫存器 0 = 目前 token，1 = 計數
        for (let k = 0; k < 3; k++) {
            S['R' + k] = { read: 0, next: 'D' + k, eof: 'E' + k };
            S['D' + k] = { if: { op: 'eq', a: 0, c: 0 }, then: 'R' + ((2 * k) % 3), else: 'F' + k };
            S['F' + k] = { if: { op: 'eq', a: 0, c: 1 }, then: 'R' + ((2 * k + 1) % 3), else: k === 0 ? 'inc' : 'R0' };
            S['E' + k] = k === 0 ? { mat: aff(R, [[1, { 1: 1, c: 1 }]]), next: 'fin' } : { halt: 'done', reg: 1 };
        }
        S.inc = { mat: aff(R, [[1, { 1: 1, c: 1 }]]), next: 'R0' }; S.fin = { halt: 'done', reg: 1 };
        return { R, start: 'R0', states: S };
    }
    // 三種括號：堆疊放在一個整數暫存器裡（底數 4：1／2／3 ＝ ( [ {）。push：s←4s+c（一個仿射矩陣）；pop：用「減 4、商加 1」的迴圈取出 s mod 4 與 s div 4，只用比較守衛。
    // 暫存器：0=s、1=t（商）、2=token。token 碼：( [ { → 1 2 3；) ] } → 4 5 6。
    function bracketsProgram() {
        const R = 3; return { R, start: 'read', states: {
            read: { read: 2, next: 'kind', eof: 'fin' }, kind: { if: { op: 'lt', a: 2, c: 4 }, then: 'push', else: 'popchk' },
            push: { mat: aff(R, [[0, { 0: 4, 2: 1 }]]), next: 'read' },
            popchk: { if: { op: 'eq', a: 0, c: 0 }, then: 'bad', else: 'pop0' },
            pop0: { mat: aff(R, [[1, { c: 0 }], [2, { 2: 1, c: -3 }]]), next: 'popl' },
            popl: { if: { op: 'lt', a: 0, c: 4 }, then: 'match', else: 'popstep' },
            popstep: { mat: aff(R, [[0, { 0: 1, c: -4 }], [1, { 1: 1, c: 1 }]]), next: 'popl' },
            match: { if: { op: 'eq', a: 0, b: 2 }, then: 'popset', else: 'bad' },
            popset: { mat: aff(R, [[0, { 1: 1 }]]), next: 'read' },
            fin: { if: { op: 'eq', a: 0, c: 0 }, then: 'ok', else: 'bad' }, ok: { halt: 'accept' }, bad: { halt: 'reject' } } };
    }
    // 輾轉相減求最大公因數（暫存器 0=a、1=b；交換是置換矩陣）
    function gcdProgram() {
        const R = 2; return { R, start: 'ra', states: {
            ra: { read: 0, next: 'rb', eof: 'out' }, rb: { read: 1, next: 'loop', eof: 'out' }, loop: { if: { op: 'eq', a: 1, c: 0 }, then: 'out', else: 'cmp' },
            cmp: { if: { op: 'lt', a: 0, b: 1 }, then: 'swap', else: 'sub' }, swap: { mat: aff(R, [[0, { 1: 1 }], [1, { 0: 1 }]]), next: 'loop' },
            sub: { mat: aff(R, [[0, { 0: 1, 1: -1 }]]), next: 'loop' }, out: { halt: 'done', reg: 0 } } };
    }
    // 質數個數：試除（餘數用「連續減 d」算，只用暫存器比較）。暫存器：0=n 1=k 2=d 3=r 4=cnt
    function primeCountProgram() {
        const R = 5; return { R, start: 'read', states: {
            read: { read: 0, next: 'init', eof: 'init' }, init: { mat: aff(R, [[1, { c: 2 }], [4, { c: 0 }]]), next: 'outer' },
            outer: { if: { op: 'lt', a: 0, b: 1 }, then: 'out', else: 'dinit' }, dinit: { mat: aff(R, [[2, { c: 2 }]]), next: 'inner' },
            inner: { if: { op: 'lt', a: 2, b: 1 }, then: 'rinit', else: 'prime' }, rinit: { mat: aff(R, [[3, { 1: 1 }]]), next: 'rl' },
            rl: { if: { op: 'lt', a: 3, b: 2 }, then: 'chk', else: 'rstep' }, rstep: { mat: aff(R, [[3, { 3: 1, 2: -1 }]]), next: 'rl' },
            chk: { if: { op: 'eq', a: 3, c: 0 }, then: 'nextk', else: 'dinc' }, dinc: { mat: aff(R, [[2, { 2: 1, c: 1 }]]), next: 'inner' },
            prime: { mat: aff(R, [[4, { 4: 1, c: 1 }]]), next: 'nextk' }, nextk: { mat: aff(R, [[1, { 1: 1, c: 1 }]]), next: 'outer' }, out: { halt: 'done', reg: 4 } } };
    }
    // 固定長度 n 的氣泡排序：控制狀態＝(趟, 位置)，每個交換是一個置換矩陣；輸出是排序後的暫存器（讀回 regs）。
    // opts.k：先讀 k（放在暫存器 n），排序後依 k 分支輸出第 k 大（k 是暫存器、分支在控制狀態）
    function bubbleProgram(n, opts) {
        const withK = !!(opts && opts.k), R = n + (withK ? 1 : 0), S = {}; const fin = withK ? 'sel1' : 'done';
        for (let i = 0; i < n; i++) S['r' + i] = { read: i, next: i + 1 < n ? 'r' + (i + 1) : (n >= 2 ? 'c0_0' : fin), eof: fin };
        S.done = { halt: 'done' }; const nxt = (p, j) => (j + 1 <= n - 2 - p ? 'c' + p + '_' + (j + 1) : (p + 1 <= n - 2 ? 'c' + (p + 1) + '_0' : fin));
        for (let p = 0; p <= n - 2; p++) for (let j = 0; j <= n - 2 - p; j++) {
            S['c' + p + '_' + j] = { if: { op: 'lt', a: j + 1, b: j }, then: 's' + p + '_' + j, else: nxt(p, j) };
            S['s' + p + '_' + j] = { mat: aff(R, [[j, { [j + 1]: 1 }], [j + 1, { [j]: 1 }]]), next: nxt(p, j) };
        }
        if (withK) { S.rk = { read: n, next: 'r0', eof: 'done' }; for (let m = 1; m <= n; m++) S['sel' + m] = { if: { op: 'eq', a: n, c: m }, then: 'out' + m, else: m < n ? 'sel' + (m + 1) : 'done' }, S['out' + m] = { halt: 'out', reg: n - m }; }
        return { R, start: withK ? 'rk' : 'r0', states: S };
    }
    // 固定長度 n 的二分搜尋（第一個不小於 x 的位置）：控制狀態＝還沒決定的區間 (lo,hi)，守衛比較 a[mid] 與 x。暫存器 0..n-1 = 陣列、n = x。
    function lowerBoundProgram(n) {
        const R = n + 1, S = {}; for (let i = 0; i <= n; i++) S['r' + i] = { read: i, next: i < n ? 'r' + (i + 1) : 'n0_' + n, eof: 'n0_' + n };
        const seen = new Set(); const node = (lo, hi) => { const name = 'n' + lo + '_' + hi; if (seen.has(name)) return name; seen.add(name);
            if (lo === hi) { S[name] = { halt: 'lb', value: lo }; return name; } const mid = (lo + hi) >> 1; S[name] = { if: { op: 'lt', a: mid, b: n }, then: node(mid + 1, hi), else: node(lo, mid) }; return name; };
        node(0, n); return { R, start: 'r0', states: S };
    }
    // 有界堆疊的括號配對：堆疊 = K 個暫存器（頂端在 0），push／pop 是移位矩陣（置換）；深度由控制狀態記（K+1 個）；超過 K 停在 overflow
    function boundedBracketsProgram(K) {
        const R = K + 1, S = {}; const T = K; // 暫存器 K = token
        const shiftDown = aff(R, [[0, { [T]: 1 }]].concat(Array.from({ length: K - 1 }, (_, i) => [i + 1, { [i]: 1 }])));   // push：新頂端＝token，其餘下移
        const shiftUp = aff(R, Array.from({ length: K - 1 }, (_, i) => [i, { [i + 1]: 1 }]).concat([[K - 1, { c: 0 }]]));  // pop：上移
        const tokMinus3 = aff(R, [[T, { [T]: 1, c: -3 }]]);
        for (let d = 0; d <= K; d++) {
            S['D' + d] = { read: T, next: 'K' + d, eof: d === 0 ? 'ok' : 'bad' };
            S['K' + d] = { if: { op: 'lt', a: T, c: 4 }, then: d === K ? 'overflow' : 'P' + d, else: d === 0 ? 'bad' : 'C' + d };
            if (d < K) S['P' + d] = { mat: shiftDown, next: 'D' + (d + 1) };
            if (d > 0) { S['C' + d] = { mat: tokMinus3, next: 'M' + d }; S['M' + d] = { if: { op: 'eq', a: 0, b: T }, then: 'U' + d, else: 'bad' }; S['U' + d] = { mat: shiftUp, next: 'D' + (d - 1) }; }
        }
        S.ok = { halt: 'accept' }; S.bad = { halt: 'reject' }; S.overflow = { halt: 'overflow' }; return { R, start: 'D0', states: S };
    }
    return { boundedBracketsProgram, aff, run, size, fibProgram, divCountProgram, bracketsProgram, gcdProgram, primeCountProgram, bubbleProgram, lowerBoundProgram };
});
