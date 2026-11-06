/* 矩陣 VM 原型（評估用，不進產品）：把「矩陣運算＋控制」當成一個小虛擬機器。對應 DESIGN.matrix-algorithms.md 第 11 節。
 *
 *   程式 = { sr: {name:'count'|'minplus'|'bool'|'maxplus', mod?}, code: [指令…] }，每個指令是一個封閉的 JSON 物件（op 只有下面這幾種），
 *   所以能一行一個序列化成 JSONL、還原後行為相同；程式端知道每個 op 的運算元型別（reg｜數字），能在執行前驗證每個運算元。
 *   暫存器：名稱 → 矩陣（純量＝1×1）。堆疊：存矩陣。
 *   矩陣運算用程式選的半環（count 可取模、bool、min-plus、max-plus）；控制用的標量運算（iarith）與比較跳轉用普通整數。
 *
 *   const dst V | read dst [eof] | mov dst src | zeros dst r c | id dst n | mul dst a b | add dst a b | pow dst a e | get dst a i j | set dst i j src
 *   iarith dst a f b（f: + - >>1）| jlt a b L | jeq a b L | jmp L | label name | push src | pop dst | print src | halt src
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_forms_core.js'));
    else root.FaMatrixVM = factory(root.FaMatrixForms);
})(typeof self !== 'undefined' ? self : this, function (MF) {
    'use strict';
    const INF = Infinity;
    const SRS = { count: (p) => MF.SR.count(p.mod || 0), bool: () => MF.SR.bool, minplus: () => MF.SR.minplus, maxplus: () => ({ name: 'max-plus', zero: -INF, one: 0, add: Math.max, mul: (a, b) => a + b }) };
    // 每個 op 的運算元型別：r＝暫存器名稱（寫入）、v＝暫存器名稱或數字（讀取）、m＝矩陣常數、l＝標籤、f＝算子
    const OPS = { const: 'rm', read: 'rl?', mov: 'rv', zeros: 'rvv', id: 'rv', mul: 'rvv', add: 'rvv', pow: 'rvv', get: 'rvvv', set: 'rvvv', iarith: 'rvfv', jlt: 'vvl', jeq: 'vvl', jmp: 'l', label: 'n', push: 'v', pop: 'r', print: 'v', halt: 'v', tr: 'rv', onehot: 'rvv', enq: 'v', deq: 'r', jqe: 'l' };
    const FIELDS = { const: ['dst', 'value'], read: ['dst', 'eof'], mov: ['dst', 'src'], zeros: ['dst', 'r', 'c'], id: ['dst', 'n'], mul: ['dst', 'a', 'b'], add: ['dst', 'a', 'b'], pow: ['dst', 'a', 'e'], get: ['dst', 'a', 'i', 'j'], set: ['dst', 'i', 'j', 'src'], iarith: ['dst', 'a', 'f', 'b'], jlt: ['a', 'b', 'to'], jeq: ['a', 'b', 'to'], jmp: ['to'], label: ['name'], push: ['src'], pop: ['dst'], print: ['src'], halt: ['src'], tr: ['dst', 'a'], onehot: ['dst', 'n', 'i'], enq: ['src'], deq: ['dst'], jqe: ['to'] };
    // 執行前的驗證：op 要認得、欄位要齊、標籤要存在；回傳錯誤清單（空＝合法）
    function validate(prog) {
        const errs = []; if (!SRS[prog.sr && prog.sr.name]) errs.push('半環不認得：' + JSON.stringify(prog.sr));
        const labels = new Set(prog.code.filter((i) => i.op === 'label').map((i) => i.name));
        prog.code.forEach((ins, k) => { if (!OPS[ins.op]) { errs.push(k + '：op 不認得 ' + ins.op); return; } for (const f of FIELDS[ins.op]) if (ins[f] === undefined && !(ins.op === 'read' && f === 'eof')) errs.push(k + '：' + ins.op + ' 缺 ' + f); if (ins.to !== undefined && !labels.has(ins.to)) errs.push(k + '：標籤不存在 ' + ins.to); if (ins.op === 'iarith' && !['+', '-', '>>1'].includes(ins.f)) errs.push(k + '：iarith 算子不認得 ' + ins.f); });
        return errs;
    }
    function run(prog, tokens, opts) {
        const errs = validate(prog); if (errs.length) throw new Error('VM 程式不合法：' + errs.join('；'));
        const sr = SRS[prog.sr.name](prog.sr), mod = prog.sr.mod || 0, max = (opts && opts.maxSteps) || 3000000; const code = prog.code;
        const pos = new Map(); code.forEach((i, k) => { if (i.op === 'label') pos.set(i.name, k); });
        const R = {}, stack = [], queue = [], out = []; let ip = 0, pc = 0, steps = 0; const st = { mul: 0, pow: 0, ops: {} };
        const mat = (x) => (typeof x === 'number' ? [[x]] : (R[x] || (() => { throw new Error('暫存器沒有值：' + x); })()));
        const sc = (x) => (typeof x === 'number' ? x : mat(x)[0][0]);
        while (pc < code.length && steps++ < max) {
            const i = code[pc++]; st.ops[i.op] = (st.ops[i.op] || 0) + 1;
            switch (i.op) {
                case 'label': break;
                case 'const': R[i.dst] = typeof i.value === 'number' ? [[i.value]] : i.value.map((r) => r.map((x) => (x === 'inf' ? INF : x === '-inf' ? -INF : x))); break;
                case 'read': if (ip < tokens.length) R[i.dst] = [[tokens[ip++]]]; else if (i.eof) pc = pos.get(i.eof); else throw new Error('輸入用完'); break;
                case 'mov': R[i.dst] = mat(i.src).map((r) => r.slice()); break;
                case 'zeros': R[i.dst] = MF.zeros(sc(i.r), sc(i.c), sr); break;
                case 'id': R[i.dst] = MF.identity(sc(i.n), sr); break;
                case 'mul': R[i.dst] = MF.matMul(mat(i.a), mat(i.b), sr); st.mul++; break;
                case 'add': R[i.dst] = MF.matAdd(mat(i.a), mat(i.b), sr); break;
                case 'pow': R[i.dst] = MF.matPow(mat(i.a), sc(i.e), sr); st.pow++; break;
                case 'get': R[i.dst] = [[mat(i.a)[sc(i.i)][sc(i.j)]]]; break;
                case 'set': { const M = mat(i.dst); M[sc(i.i)][sc(i.j)] = sc(i.src); break; }
                case 'iarith': { const a = sc(i.a); R[i.dst] = [[i.f === '+' ? a + sc(i.b) : i.f === '-' ? a - sc(i.b) : a >> 1]]; break; }
                case 'jlt': if (sc(i.a) < sc(i.b)) pc = pos.get(i.to); break;
                case 'jeq': if (sc(i.a) === sc(i.b)) pc = pos.get(i.to); break;
                case 'jmp': pc = pos.get(i.to); break;
                case 'push': stack.push(mat(i.src).map((r) => r.slice())); break;
                case 'pop': if (!stack.length) throw new Error('堆疊是空的'); R[i.dst] = stack.pop(); break;
                case 'tr': { const A = mat(i.a); R[i.dst] = A[0].map((_, c) => A.map((r) => r[c])); break; }
                case 'onehot': { const row = new Array(sc(i.n)).fill(sr.zero); row[sc(i.i)] = sr.one; R[i.dst] = [row]; break; }
                case 'enq': queue.push(mat(i.src).map((r) => r.slice())); break;
                case 'deq': if (!queue.length) throw new Error('佇列是空的'); R[i.dst] = queue.shift(); break;
                case 'jqe': if (!queue.length) pc = pos.get(i.to); break;
                case 'print': out.push(sc(i.src)); break;
                case 'halt': return { value: sc(i.src), out, steps, mul: st.mul, pow: st.pow, ops: st.ops, mod };
            }
        }
        return { value: undefined, out, steps, halted: false, ops: st.ops };
    }
    const toJsonl = (prog) => [JSON.stringify({ sr: prog.sr })].concat(prog.code.map((i) => JSON.stringify(i))).join('\n') + '\n';
    const fromJsonl = (text) => { const L = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); return { sr: L[0].sr, code: L.slice(1) }; };

    // ---------- 把題目「編譯」成 VM 程式（編譯器是 JS 函式；產物是封閉指令串）----------
    const C = (dst, value) => ({ op: 'const', dst, value }), J = (op, a, b, to) => ({ op, a, b, to }), L = (name) => ({ op: 'label', name }), JM = (to) => ({ op: 'jmp', to });
    const IA = (dst, a, f, b) => ({ op: 'iarith', dst, a, f, b });
    // 費氏取模：輸入 n；(F_n, F_{n+1}) = (0,1)·[[0,1],[1,1]]^n
    const fibVM = (p) => ({ sr: { name: 'count', mod: p }, code: [{ op: 'read', dst: 'n' }, C('M', [[0, 1], [1, 1]]), C('v', [[0, 1]]), { op: 'pow', dst: 'M', a: 'M', e: 'n' }, { op: 'mul', dst: 'v', a: 'v', b: 'M' }, { op: 'get', dst: 'r', a: 'v', i: 0, j: 0 }, { op: 'halt', src: 'r' }] });
    // DFA 計數：輸入是符號串（0..k-1）；回報「讀完每個符號後落在接受狀態」的次數。每個符號一個轉移矩陣；選哪個矩陣是跳轉
    function dfaCountVM(d) {
        const Ms = MF.dfaMatrices(d, MF.SR.count(0)); const code = [C('v', [d.accept.map((_, i) => (i === d.start ? 1 : 0))]), C('F', d.accept.map((x) => [x ? 1 : 0])), C('cnt', 0), C('one', 1)];
        Ms.forEach((M, a) => code.push(C('M' + a, M)));
        code.push(L('loop'), { op: 'read', dst: 'a', eof: 'end' });
        for (let a = 0; a < Ms.length - 1; a++) code.push(J('jeq', 'a', a, 'S' + a)); code.push({ op: 'mul', dst: 'v', a: 'v', b: 'M' + (Ms.length - 1) }, JM('acc'));
        for (let a = 0; a < Ms.length - 1; a++) code.push(L('S' + a), { op: 'mul', dst: 'v', a: 'v', b: 'M' + a }, JM('acc'));
        code.push(L('acc'), { op: 'mul', dst: 't', a: 'v', b: 'F' }, { op: 'get', dst: 'x', a: 't', i: 0, j: 0 }, IA('cnt', 'cnt', '+', 'x'), JM('loop'), L('end'), { op: 'halt', src: 'cnt' });
        return { sr: { name: 'count' }, code };
    }
    // 圖：輸入 n m、m 條邊 (u v [w])、查詢長度 K；半環決定問題。count：長度 K 的路徑數（取模）；minplus：邊權最短路（最多 n-1 步）。回報 [0][n-1]
    function graphVM(kind, mod) {
        const w = kind === 'minplus', code = [{ op: 'read', dst: 'n' }, { op: 'read', dst: 'm' }, C('zero', 0), C('one', 1), C('i', 0), { op: 'zeros', dst: 'A', r: 'n', c: 'n' }];
        if (w) code.push(C('k', 0), L('di'), J('jeq', 'k', 'n', 'ed'), { op: 'set', dst: 'A', i: 'k', j: 'k', src: 'zero' }, IA('k', 'k', '+', 'one'), JM('di'), L('ed'));
        code.push(L('el'), J('jeq', 'i', 'm', 'ee'), { op: 'read', dst: 'u' }, { op: 'read', dst: 'v' });
        if (w) code.push({ op: 'read', dst: 'wt' }, { op: 'get', dst: 'cur', a: 'A', i: 'u', j: 'v' }, { op: 'add', dst: 'nw', a: 'cur', b: 'wt' }, { op: 'set', dst: 'A', i: 'u', j: 'v', src: 'nw' });
        else code.push({ op: 'get', dst: 'cur', a: 'A', i: 'u', j: 'v' }, IA('cur', 'cur', '+', 'one'), { op: 'set', dst: 'A', i: 'u', j: 'v', src: 'cur' });
        code.push(IA('i', 'i', '+', 'one'), JM('el'), L('ee'));
        if (w) code.push(IA('K', 'n', '-', 'one')); else code.push({ op: 'read', dst: 'K' });
        code.push({ op: 'pow', dst: 'A', a: 'A', e: 'K' }, IA('last', 'n', '-', 'one'), { op: 'get', dst: 'r', a: 'A', i: 'zero', j: 'last' }, { op: 'halt', src: 'r' });
        return { sr: w ? { name: 'minplus' } : { name: 'count', mod }, code };
    }
    // 括號配對（三種括號，token 碼 ( [ { → 1 2 3，) ] } → 4 5 6）：需要堆疊。
    const bracketsVM = () => ({ sr: { name: 'count' }, code: [C('zero', 0), C('one', 1), C('four', 4), C('three', 3), C('d', 0), L('loop'), { op: 'read', dst: 'c', eof: 'fin' }, J('jlt', 'c', 'four', 'push'),
        J('jeq', 'd', 'zero', 'bad'), { op: 'pop', dst: 'x' }, IA('d', 'd', '-', 'one'), IA('c3', 'c', '-', 'three'), J('jeq', 'x', 'c3', 'loop'), JM('bad'),
        L('push'), { op: 'push', src: 'c' }, IA('d', 'd', '+', 'one'), JM('loop'), L('fin'), J('jeq', 'd', 'zero', 'ok'), L('bad'), { op: 'halt', src: 'zero' }, L('ok'), { op: 'halt', src: 'one' }] });
    // 輾轉相減
    const gcdVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'a' }, { op: 'read', dst: 'b' }, C('zero', 0), L('loop'), J('jeq', 'b', 'zero', 'end'), J('jlt', 'a', 'b', 'swp'), IA('a', 'a', '-', 'b'), JM('loop'),
        L('swp'), { op: 'mov', dst: 't', src: 'a' }, { op: 'mov', dst: 'a', src: 'b' }, { op: 'mov', dst: 'b', src: 't' }, JM('loop'), L('end'), { op: 'halt', src: 'a' }] });
    // 二分搜尋：輸入 n、n 個遞增的數、x；回傳第一個不小於 x 的位置（陣列放在 1×n 矩陣裡，get 以暫存器當索引）
    const lowerBoundVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'n' }, C('zero', 0), C('one', 1), { op: 'zeros', dst: 'arr', r: 1, c: 'n' }, C('i', 0), L('fill'), J('jeq', 'i', 'n', 'rx'), { op: 'read', dst: 'v' }, { op: 'set', dst: 'arr', i: 'zero', j: 'i', src: 'v' }, IA('i', 'i', '+', 'one'), JM('fill'),
        L('rx'), { op: 'read', dst: 'x' }, { op: 'mov', dst: 'lo', src: 'zero' }, { op: 'mov', dst: 'hi', src: 'n' }, L('loop'), J('jeq', 'lo', 'hi', 'end'), IA('mid', 'lo', '+', 'hi'), IA('mid', 'mid', '>>1', 0), { op: 'get', dst: 'v', a: 'arr', i: 'zero', j: 'mid' },
        J('jlt', 'v', 'x', 'less'), { op: 'mov', dst: 'hi', src: 'mid' }, JM('loop'), L('less'), IA('lo', 'mid', '+', 'one'), JM('loop'), L('end'), { op: 'halt', src: 'lo' }] });
    // 迴文（token 碼）：雙指標，陣列 get
    const palindromeVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'n' }, C('zero', 0), C('one', 1), { op: 'zeros', dst: 'arr', r: 1, c: 'n' }, C('i', 0), L('fill'), J('jeq', 'i', 'n', 'go'), { op: 'read', dst: 'v' }, { op: 'set', dst: 'arr', i: 'zero', j: 'i', src: 'v' }, IA('i', 'i', '+', 'one'), JM('fill'),
        L('go'), { op: 'mov', dst: 'i', src: 'zero' }, IA('j', 'n', '-', 'one'), L('loop'), J('jlt', 'i', 'j', 'cmp'), { op: 'halt', src: 'one' }, L('cmp'), { op: 'get', dst: 'a', a: 'arr', i: 'zero', j: 'i' }, { op: 'get', dst: 'b', a: 'arr', i: 'zero', j: 'j' }, J('jeq', 'a', 'b', 'nx'), { op: 'halt', src: 'zero' },
        L('nx'), IA('i', 'i', '+', 'one'), IA('j', 'j', '-', 'one'), JM('loop')] });


    // ---------- 記憶體元件（第 13 節）：佇列、one-hot 陣列、不經意排序網路、並查集、指標跳躍 ----------
    // BFS 最少步數（無向圖，0 → n−1；不可達 −1）：輸入 n m、m 條邊 (u v)。鄰接矩陣＋距離陣列＋佇列
    const bfsVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'n' }, { op: 'read', dst: 'm' }, C('zero', 0), C('one', 1), C('m1', -1), C('i', 0), { op: 'zeros', dst: 'A', r: 'n', c: 'n' }, L('el'), J('jeq', 'i', 'm', 'ee'), { op: 'read', dst: 'u' }, { op: 'read', dst: 'v' },
        { op: 'set', dst: 'A', i: 'u', j: 'v', src: 'one' }, { op: 'set', dst: 'A', i: 'v', j: 'u', src: 'one' }, IA('i', 'i', '+', 'one'), JM('el'),
        L('ee'), { op: 'zeros', dst: 'dist', r: 1, c: 'n' }, C('k', 0), L('fd'), J('jeq', 'k', 'n', 'go'), { op: 'set', dst: 'dist', i: 'zero', j: 'k', src: 'm1' }, IA('k', 'k', '+', 'one'), JM('fd'),
        L('go'), { op: 'set', dst: 'dist', i: 'zero', j: 'zero', src: 'zero' }, { op: 'enq', src: 'zero' },
        L('loop'), { op: 'jqe', to: 'end' }, { op: 'deq', dst: 'u' }, { op: 'get', dst: 'du', a: 'dist', i: 'zero', j: 'u' }, IA('d1', 'du', '+', 'one'), { op: 'mov', dst: 'k', src: 'zero' },
        L('inner'), J('jeq', 'k', 'n', 'loop'), { op: 'get', dst: 'e', a: 'A', i: 'u', j: 'k' }, J('jeq', 'e', 'zero', 'nxt'), { op: 'get', dst: 'dk', a: 'dist', i: 'zero', j: 'k' }, J('jeq', 'dk', 'm1', 'visit'), JM('nxt'),
        L('visit'), { op: 'set', dst: 'dist', i: 'zero', j: 'k', src: 'd1' }, { op: 'enq', src: 'k' }, L('nxt'), IA('k', 'k', '+', 'one'), JM('inner'),
        L('end'), IA('last', 'n', '-', 'one'), { op: 'get', dst: 'r', a: 'dist', i: 'zero', j: 'last' }, { op: 'halt', src: 'r' }] });
    // 「記憶體本身就是矩陣」：n×1 的陣列，位址是 one-hot 向量；讀 = onehot × arr（O(n)），寫 = arr + onehotᵀ·(新值−舊值)。輸入：n，然後 (0 i)＝讀並印出、(1 i v)＝寫
    const oneHotMemVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'n' }, C('zero', 0), { op: 'zeros', dst: 'arr', r: 'n', c: 1 },
        L('loop'), { op: 'read', dst: 'op', eof: 'end' }, { op: 'read', dst: 'i' }, { op: 'onehot', dst: 'oh', n: 'n', i: 'i' }, J('jeq', 'op', 'zero', 'rd'),
        { op: 'read', dst: 'v' }, { op: 'mul', dst: 'old', a: 'oh', b: 'arr' }, IA('diff', 'v', '-', 'old'), { op: 'tr', dst: 'ohT', a: 'oh' }, { op: 'mul', dst: 'delta', a: 'ohT', b: 'diff' }, { op: 'add', dst: 'arr', a: 'arr', b: 'delta' }, JM('loop'),
        L('rd'), { op: 'mul', dst: 't', a: 'oh', b: 'arr' }, { op: 'print', src: 't' }, JM('loop'), L('end'), { op: 'halt', src: 'zero' }] });
    // 雙調排序（不經意：比較序列只跟 n 有關，與資料無關）：展開成固定的 get／比較／set 序列；size 要是 2 的次方
    function bitonicSchedule(size) { const out = []; for (let k = 2; k <= size; k *= 2) for (let j = k / 2; j >= 1; j /= 2) for (let i = 0; i < size; i++) { const l = i ^ j; if (l > i) out.push([i, l, (i & k) === 0]); } return out; }
    function bitonicVM(size) {
        const code = [C('zero', 0), C('one', 1), { op: 'zeros', dst: 'arr', r: 1, c: size }]; for (let i = 0; i < size; i++) code.push({ op: 'read', dst: 'v' }, C('i' + i, i), { op: 'set', dst: 'arr', i: 'zero', j: 'i' + i, src: 'v' });
        bitonicSchedule(size).forEach(([i, l, asc], t) => { code.push({ op: 'get', dst: 'a', a: 'arr', i: 'zero', j: 'i' + i }, { op: 'get', dst: 'b', a: 'arr', i: 'zero', j: 'i' + l }, asc ? J('jlt', 'b', 'a', 'sw' + t) : J('jlt', 'a', 'b', 'sw' + t), JM('ok' + t), L('sw' + t), { op: 'set', dst: 'arr', i: 'zero', j: 'i' + i, src: 'b' }, { op: 'set', dst: 'arr', i: 'zero', j: 'i' + l, src: 'a' }, L('ok' + t)); });
        for (let i = 0; i < size; i++) code.push({ op: 'get', dst: 'x', a: 'arr', i: 'zero', j: 'i' + i }, { op: 'print', src: 'x' }); code.push({ op: 'halt', src: 'zero' }); return { sr: { name: 'count' }, code };
    }
    // 並查集（陣列＋find 迴圈＋合併計數）：輸入 n m、m 條邊；回報連通分量數
    const unionFindVM = () => ({ sr: { name: 'count' }, code: [{ op: 'read', dst: 'n' }, { op: 'read', dst: 'm' }, C('zero', 0), C('one', 1), { op: 'zeros', dst: 'p', r: 1, c: 'n' }, C('i', 0), L('init'), J('jeq', 'i', 'n', 'ed'), { op: 'set', dst: 'p', i: 'zero', j: 'i', src: 'i' }, IA('i', 'i', '+', 'one'), JM('init'),
        L('ed'), { op: 'mov', dst: 'comp', src: 'n' }, { op: 'mov', dst: 'i', src: 'zero' }, L('el'), J('jeq', 'i', 'm', 'end'), { op: 'read', dst: 'u' }, { op: 'read', dst: 'v' }, IA('i', 'i', '+', 'one'),
        L('fu'), { op: 'get', dst: 'pu', a: 'p', i: 'zero', j: 'u' }, J('jeq', 'pu', 'u', 'fv'), { op: 'mov', dst: 'u', src: 'pu' }, JM('fu'), L('fv'), { op: 'get', dst: 'pv', a: 'p', i: 'zero', j: 'v' }, J('jeq', 'pv', 'v', 'un'), { op: 'mov', dst: 'v', src: 'pv' }, JM('fv'),
        L('un'), J('jeq', 'u', 'v', 'el'), { op: 'set', dst: 'p', i: 'zero', j: 'u', src: 'v' }, IA('comp', 'comp', '-', 'one'), JM('el'), L('end'), { op: 'halt', src: 'comp' }] });
    // 指標跳躍：函數圖（i → parent[i]，根指向自己）的布林矩陣冪 F^n 的第 q 列只有根那一格是 1。輸入 n、parent[0..n−1]、q；回傳 q 的根
    const pointerJumpVM = () => ({ sr: { name: 'bool' }, code: [{ op: 'read', dst: 'n' }, C('zero', 0), C('one', 1), { op: 'zeros', dst: 'F', r: 'n', c: 'n' }, C('i', 0), L('fill'), J('jeq', 'i', 'n', 'go'), { op: 'read', dst: 'p' }, { op: 'set', dst: 'F', i: 'i', j: 'p', src: 'one' }, IA('i', 'i', '+', 'one'), JM('fill'),
        L('go'), { op: 'read', dst: 'q' }, { op: 'pow', dst: 'F', a: 'F', e: 'n' }, C('k', 0), L('scan'), { op: 'get', dst: 'e', a: 'F', i: 'q', j: 'k' }, J('jeq', 'e', 'one', 'found'), IA('k', 'k', '+', 'one'), JM('scan'), L('found'), { op: 'halt', src: 'k' }] });
    // 種子 20 題「最少需要的記憶體」：none＝有限控制＋矩陣／標量；counter＝一個計數器；stack＝堆疊；array＝佇列／隨機存取陣列／≥2 個計數器（圖靈完備那一級）
    const SEED_MEM = {
        'a-plus-b': { min: 'none' }, 'max-of-array': { min: 'none' }, 'fibonacci': { min: 'none', vm: true }, 'lower-bound': { min: 'counter', natural: 'array', vm: true, note: '線性掃描＋計數器即可；二分才要陣列' },
        'valid-brackets': { min: 'stack', vm: true }, 'reverse-words': { min: 'stack' }, 'is-palindrome': { min: 'array', vm: true, note: '決定性機器要陣列；非決定性下推自動機可以（有中點猜測）' },
        'gcd-lcm': { min: 'array', vm: true, note: '≥2 個計數器（形式上圖靈完備那一級，實際只要 2 個標量暫存器）' }, 'count-primes': { min: 'array', note: '同上，要 ≥2 個計數器' },
        'two-sum': { min: 'array' }, 'word-frequency': { min: 'array' }, 'range-sum': { min: 'array' }, 'coin-change': { min: 'array', note: '矩陣維度由輸入決定＝輸入要存起來' }, 'lis': { min: 'array' },
        'grid-bfs': { min: 'array', vm: true, note: '佇列＋陣列（圖用邊表的同類題已編成 VM）' }, 'components': { min: 'array', vm: true, note: '並查集（陣列）或指標跳躍（函數圖矩陣冪）' }, 'merge-intervals': { min: 'array' },
        'kth-largest': { min: 'array', vm: true, note: '固定 n 時不需要記憶體（排序網路，不經意）；VM 版用雙調排序網路' }, 'anagram': { min: 'array' }, 'knapsack': { min: 'array' },
    };
    // 種子 20 題的 VM 分類：matrix＝矩陣指令是主角（半環矩陣由輸入建出、pow／mul）；general＝只靠標量暫存器、跳轉、陣列 get／set、堆疊（矩陣沒幫上忙）。
    // direct＝本檔測試已經把這題（或其核心部分）編成 VM 程式並對照參考解
    const SEED_VM = {
        'a-plus-b': { cls: 'general' }, 'max-of-array': { cls: 'general' }, 'reverse-words': { cls: 'general' }, 'is-palindrome': { cls: 'general', direct: '整數 token 版（雙指標＋陣列 get）' },
        'two-sum': { cls: 'general' }, 'word-frequency': { cls: 'general' }, 'lower-bound': { cls: 'general', direct: '單一查詢版（二分＋陣列 get）' }, 'range-sum': { cls: 'matrix' },
        'fibonacci': { cls: 'matrix', direct: 'pow＋mul，7 條指令' }, 'coin-change': { cls: 'matrix' }, 'lis': { cls: 'general' }, 'valid-brackets': { cls: 'general', direct: '三種括號，用堆疊' },
        'gcd-lcm': { cls: 'general', direct: '只做 gcd（lcm 要再接乘法迴圈）' }, 'count-primes': { cls: 'general' }, 'grid-bfs': { cls: 'matrix', direct: '同類：min-plus 圖最短路（輸入格式是邊表，不是格子）' }, 'components': { cls: 'matrix', direct: '同類：count 半環路徑計數（輸入格式是邊表）' },
        'merge-intervals': { cls: 'general' }, 'kth-largest': { cls: 'general' }, 'anagram': { cls: 'general' }, 'knapsack': { cls: 'matrix' },
    };
    return { SEED_MEM, bfsVM, oneHotMemVM, bitonicVM, bitonicSchedule, unionFindVM, pointerJumpVM, SEED_VM, OPS, validate, run, toJsonl, fromJsonl, fibVM, dfaCountVM, graphVM, bracketsVM, gcdVM, lowerBoundVM, palindromeVM };
});
