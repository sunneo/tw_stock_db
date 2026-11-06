/* 反編譯器（評估用，不進產品）：把矩陣／機器／ReLU 決策樹／VM 程式「讀回」人看得懂的形式。對應 DESIGN.matrix-algorithms.md 第 14 節。
 *   矩陣 → 遞推式（特徵多項式，Cayley–Hamilton；伴隨矩陣直接讀最後一列）
 *   one-hot 轉移矩陣 → DFA → 狀態圖（文字、Graphviz dot）→ 正規表示式（狀態消去法）
 *   ReLU 決策樹 → if／else（可執行的 JS 原始碼＋中文受控自然語言）
 *   VM 程式 → 中文受控自然語言（一條指令一行）
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixDecompile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // ---------- 矩陣 → 遞推式 ----------
    // Faddeev–LeVerrier：整數矩陣的特徵多項式 x^n + c[n-1]x^(n-1) + … + c[0]；回傳 [c0 … c(n-1)]
    function charPoly(A) {
        const n = A.length; const I = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))); const c = new Array(n + 1).fill(0); c[n] = 1; let Mk = A.map((r) => r.map(() => 0));
        const mul = (X, Y) => X.map((r) => Y[0].map((_, j) => r.reduce((s, x, k) => s + x * Y[k][j], 0)));
        for (let k = 1; k <= n; k++) { const AM = mul(A, Mk); Mk = AM.map((r, i) => r.map((x, j) => x + c[n - k + 1] * I[i][j])); const AMk = mul(A, Mk); const tr = AMk.reduce((s, r, i) => s + r[i], 0); c[n - k] = -tr / k; }
        return c.slice(0, n);
    }
    // 回傳 { coefs:[c1…cL]（a(n)=Σ ci·a(n−i)）, text }；M 的任何元素序列 (M^n)[i][j] 都滿足它
    function matrixToRecurrence(A, name) {
        name = name || 'a'; const cp = charPoly(A), L = cp.length; const coefs = []; for (let i = 1; i <= L; i++) coefs.push(-cp[L - i]);
        const term = (c, i) => (c === 0 ? null : (c === 1 ? '' : c === -1 ? '−' : c + '×') + name + '(n−' + i + ')');
        const parts = coefs.map((c, i) => term(c, i + 1)).filter(Boolean); const text = name + '(n) = ' + (parts.length ? parts.join(' + ').replace(/\+ −/g, '− ') : '0');
        return { coefs, text };
    }
    // ---------- one-hot 轉移矩陣 → DFA → 圖／正規表示式 ----------
    // Ms：每個符號一個矩陣（每列恰一個 1）；start、accept 是向量。不是 one-hot 就回 null（不是 DFA）
    function matricesToDfa(Ms, alphabet, startVec, acceptVec) {
        const n = Ms[0].length; const delta = Array.from({ length: n }, () => []);
        for (let a = 0; a < Ms.length; a++) for (let i = 0; i < n; i++) { const ones = Ms[a][i].map((x, j) => (x === 1 ? j : -1)).filter((j) => j >= 0); if (ones.length !== 1 || Ms[a][i].some((x) => x !== 0 && x !== 1)) return null; delta[i][a] = ones[0]; }
        return { n, alphabet: alphabet.slice(), start: startVec.indexOf(1), accept: acceptVec.map((x) => !!x), delta };
    }
    const sname = (d, i, names) => (names && names[i]) || 's' + i;
    function dfaToText(d, names) {
        const L = ['狀態 ' + d.n + ' 個，起始：' + sname(d, d.start, names) + '，接受：' + (d.accept.map((x, i) => (x ? sname(d, i, names) : null)).filter(Boolean).join('、') || '（無）')];
        for (let i = 0; i < d.n; i++) for (let a = 0; a < d.alphabet.length; a++) L.push(sname(d, i, names) + ' 讀到 ' + d.alphabet[a] + ' → ' + sname(d, d.delta[i][a], names)); return L;
    }
    function dfaToDot(d, names) {
        const L = ['digraph dfa {', '  rankdir=LR;', '  node [shape=circle];', '  __start [shape=point];']; for (let i = 0; i < d.n; i++) L.push('  "' + sname(d, i, names) + '"' + (d.accept[i] ? ' [shape=doublecircle]' : '') + ';');
        L.push('  __start -> "' + sname(d, d.start, names) + '";'); for (let i = 0; i < d.n; i++) { const by = new Map(); d.alphabet.forEach((ch, a) => { const j = d.delta[i][a]; by.set(j, (by.get(j) || []).concat(ch)); }); for (const [j, chs] of by) L.push('  "' + sname(d, i, names) + '" -> "' + sname(d, j, names) + '" [label="' + chs.join(',') + '"];'); }
        L.push('}'); return L.join('\n');
    }
    // 正規表示式（狀態消去法）。AST：null＝空集、{t:'eps'}、{t:'a',c}、{t:'cat',xs}、{t:'alt',xs}、{t:'star',x}
    const EPS = { t: 'eps' };
    const cat = (a, b) => { if (!a || !b) return null; if (a.t === 'eps') return b; if (b.t === 'eps') return a; return { t: 'cat', xs: [].concat(a.t === 'cat' ? a.xs : [a], b.t === 'cat' ? b.xs : [b]) }; };
    const str = (x) => JSON.stringify(x);
    const alt = (a, b) => { if (!a) return b; if (!b) return a; if (str(a) === str(b)) return a; return { t: 'alt', xs: [].concat(a.t === 'alt' ? a.xs : [a], b.t === 'alt' ? b.xs : [b]) }; };
    const star = (a) => (!a || a.t === 'eps' ? EPS : a.t === 'star' ? a : { t: 'star', x: a });
    function re2s(x, prec) { // prec: 0 在最外、1 在連接裡、2 在星號下
        if (x.t === 'a') return x.c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if (x.t === 'eps') return '';
        if (x.t === 'star') return wrap(re2s(x.x, 2), x.x, 2) + '*';
        if (x.t === 'cat') return x.xs.map((y) => wrap(re2s(y, 1), y, 1)).join('');
        const hasEps = x.xs.some((y) => y.t === 'eps'); const rest = x.xs.filter((y) => y.t !== 'eps'); const body = rest.map((y) => re2s(y, 0)).join('|'); return hasEps ? (rest.length > 1 || rest[0].t === 'cat' ? '(?:' + body + ')?' : wrap(body, rest[0], 2) + '?') : body;
    }
    const wrap = (s, x, need) => { const lvl = x.t === 'alt' ? 0 : x.t === 'cat' ? 1 : 2; return lvl < need && s !== '' ? '(?:' + s + ')' : s; };
    function dfaToRegex(d) {
        const N = d.n + 2, S = d.n, F = d.n + 1; const R = Array.from({ length: N }, () => new Array(N).fill(null)); R[S][d.start] = EPS;
        for (let i = 0; i < d.n; i++) { for (let a = 0; a < d.alphabet.length; a++) R[i][d.delta[i][a]] = alt(R[i][d.delta[i][a]], { t: 'a', c: d.alphabet[a] }); if (d.accept[i]) R[i][F] = EPS; }
        for (let k = 0; k < d.n; k++) { const loop = star(R[k][k]); for (let i = 0; i < N; i++) { if (i === k || !R[i][k]) continue; for (let j = 0; j < N; j++) { if (j === k || !R[k][j]) continue; R[i][j] = alt(R[i][j], cat(cat(R[i][k], loop), R[k][j])); } } for (let i = 0; i < N; i++) { R[i][k] = null; R[k][i] = null; } }
        return R[S][F] ? re2s(R[S][F], 0) : null;
    }
    // ---------- ReLU 決策樹 → if／else ----------
    function affStr(a, names) { const parts = []; a.w.forEach((c, i) => { if (!c) return; const v = names[i]; const t = c === 1 ? v : c === -1 ? '-' + v : c + '*' + v; parts.push(t); }); let s = parts.join(' + ').replace(/\+ -/g, '- '); if (a.c) s += (s ? (a.c > 0 ? ' + ' : ' - ') + Math.abs(a.c) : String(a.c)); return s || '0'; }
    function treeToIfChain(tree, names) {
        names = names || Array.from({ length: tree.nIn }, (_, i) => 'x' + i); const js = [], cnl = [];
        const go = (n, d) => { const pad = '  '.repeat(d);
            if (n.guard) { const g = affStr(n.guard, names); js.push(pad + 'if (' + g + ' > 0) {'); cnl.push(pad + '如果 ' + g + ' > 0：'); go(n.pos, d + 1); js.push(pad + '} else {'); cnl.push(pad + '否則：'); go(n.neg, d + 1); js.push(pad + '}'); }
            else { const outs = n.leaf.map((a) => affStr(a, names)); js.push(pad + 'return ' + (outs.length === 1 ? outs[0] : '[' + outs.join(', ') + ']') + ';'); cnl.push(pad + '結果是 ' + (outs.length === 1 ? outs[0] : outs.join('、'))); } };
        go(tree.root, 0); const code = 'return (function(){\n' + js.join('\n') + '\n})();'; return { js, cnl, fn: new Function(...names, code) };
    }
    // ---------- VM 程式 → 中文受控自然語言 ----------
    const srName = { count: '計數（＋、×）', bool: '布林（或、且）', minplus: '最短路（取小、＋）', maxplus: '取大（取大、＋）' };
    function vmToCnl(prog) {
        const sr = prog.sr.name + (prog.sr.mod ? ' 取模 ' + prog.sr.mod : ''); const out = ['使用半環：' + (srName[prog.sr.name] || prog.sr.name) + (prog.sr.mod ? '，取模 ' + prog.sr.mod : '')];
        const dims = (v) => (typeof v === 'number' ? String(v) : Array.isArray(v) ? v.length + '×' + v[0].length + ' 矩陣' : JSON.stringify(v));
        for (const i of prog.code) {
            const f = (k) => i[k];
            switch (i.op) {
                case 'label': out.push('標籤 ' + i.name + '：'); break;
                case 'const': out.push('  把 ' + i.dst + ' 設成常數（' + dims(i.value) + '）'); break;
                case 'read': out.push('  從輸入讀一個數放進 ' + i.dst + (i.eof ? '；沒有輸入就跳到 ' + i.eof : '')); break;
                case 'mov': out.push('  ' + i.dst + ' ← ' + i.src); break;
                case 'zeros': out.push('  ' + i.dst + ' ← ' + f('r') + '×' + f('c') + ' 的零矩陣'); break;
                case 'id': out.push('  ' + i.dst + ' ← ' + i.n + ' 階單位矩陣'); break;
                case 'mul': out.push('  ' + i.dst + ' ← ' + i.a + ' × ' + i.b + '（矩陣乘法）'); break;
                case 'add': out.push('  ' + i.dst + ' ← ' + i.a + ' ⊕ ' + i.b + '（逐格相加／取小）'); break;
                case 'pow': out.push('  ' + i.dst + ' ← ' + i.a + ' 的 ' + i.e + ' 次方（矩陣快速冪）'); break;
                case 'get': out.push('  ' + i.dst + ' ← ' + i.a + '[' + i.i + '][' + i.j + ']'); break;
                case 'set': out.push('  ' + i.dst + '[' + i.i + '][' + i.j + '] ← ' + i.src); break;
                case 'iarith': out.push('  ' + i.dst + ' ← ' + (i.f === '>>1' ? i.a + ' 除以 2（向下取整）' : i.a + ' ' + (i.f === '+' ? '＋' : '－') + ' ' + i.b)); break;
                case 'jlt': out.push('  如果 ' + i.a + ' < ' + i.b + ' 跳到 ' + i.to); break;
                case 'jeq': out.push('  如果 ' + i.a + ' = ' + i.b + ' 跳到 ' + i.to); break;
                case 'jmp': out.push('  跳到 ' + i.to); break;
                case 'push': out.push('  把 ' + i.src + ' 推進堆疊'); break;
                case 'pop': out.push('  從堆疊取出一個放進 ' + i.dst); break;
                case 'enq': out.push('  把 ' + i.src + ' 排進佇列'); break;
                case 'deq': out.push('  從佇列取出一個放進 ' + i.dst); break;
                case 'jqe': out.push('  如果佇列是空的跳到 ' + i.to); break;
                case 'tr': out.push('  ' + i.dst + ' ← ' + i.a + ' 的轉置'); break;
                case 'onehot': out.push('  ' + i.dst + ' ← 長度 ' + i.n + '、第 ' + i.i + ' 格是 1 的 one-hot 向量'); break;
                case 'print': out.push('  輸出 ' + i.src); break;
                case 'halt': out.push('  停機，答案是 ' + i.src); break;
                default: out.push('  （未知指令 ' + i.op + '）');
            }
        }
        return out;
    }
    return { charPoly, matrixToRecurrence, matricesToDfa, dfaToText, dfaToDot, dfaToRegex, treeToIfChain, vmToCnl, affStr };
});
