// 反編譯與可讀性：node renderer/src/algo/matrix_decompile.test.js（量到的數字會印出來，DESIGN.matrix-algorithms.md 第 14 節引用）
const M = require('./matrix_forms_core.js'), D = require('./matrix_decompile_core.js'), RL = require('./relu_core.js'), RC = require('./relu_compile_core.js'), VM = require('./matrix_vm_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600))); } }
const note = (s) => console.log('  · ' + s);
let seed = 141106; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

// ① 矩陣 → 遞推式
{
    const fib = D.matrixToRecurrence([[0, 1], [1, 1]]); check('反編譯：費氏轉移矩陣 [[0,1],[1,1]] → "' + fib.text + '"（對照 Berlekamp–Massey 學到的係數 [1,1]）', fib.text === 'a(n) = a(n−1) + a(n−2)' && JSON.stringify(fib.coefs) === JSON.stringify(M.berlekampMassey([0, 1, 1, 2, 3, 5, 8, 13], M.P).slice(1)));
    let all = true; for (let t = 0; t < 30; t++) { const k = ri(2, 4); const A = Array.from({ length: k }, () => Array.from({ length: k }, () => ri(-2, 3))); const { coefs } = D.matrixToRecurrence(A); const seq = []; for (let n = 0; n <= 12; n++) seq.push(M.matPow(A, n, M.SR.count(0))[0][0]); for (let n = k; n <= 12; n++) { let s = 0; for (let i = 1; i <= k; i++) s += coefs[i - 1] * seq[n - i]; if (s !== seq[n]) all = false; } }
    check('反編譯：任意整數方陣（k=2..4，30 個隨機）的 (M^n)[0][0] 都滿足特徵多項式讀出的遞推式（Cayley–Hamilton）', all);
    const trib = D.matrixToRecurrence([[0, 1, 0], [0, 0, 1], [1, 1, 1]]); note('三項遞推矩陣 → ' + trib.text);
}
// ② DFA 矩陣 → 狀態圖／正規表示式
const dfas = { div3: M.DFAS.div3, no11: M.DFAS.no11, evenA: M.DFAS.evenA }; for (let t = 0; t < 10; t++) dfas['random' + t] = M.randomDfa(rnd, ri(2, 5), 2);
{
    let rt = true, txt = true, dot = true, re = true; const lens = {};
    for (const [name, d] of Object.entries(dfas)) {
        const Ms = M.dfaMatrices(d, M.SR.bool), back = D.matricesToDfa(Ms, d.alphabet, d.accept.map((_, i) => (i === d.start ? 1 : 0)), d.accept.map((x) => (x ? 1 : 0))); if (!back || JSON.stringify(back) !== JSON.stringify(Object.assign({}, d))) rt = false;
        if (D.dfaToText(d).length !== 1 + d.n * d.alphabet.length) txt = false; const g = D.dfaToDot(d); if (!/^digraph/.test(g) || !g.trim().endsWith('}') || (g.match(/->/g) || []).length < d.n) dot = false;
        const rx = D.dfaToRegex(d); lens[name] = rx === null ? 0 : rx.length; const R = rx === null ? null : new RegExp('^(?:' + rx + ')$');
        for (let t = 0; t < 120; t++) { const w = Array.from({ length: ri(0, 14) }, () => d.alphabet[ri(0, d.alphabet.length - 1)]).join(''); if ((R ? R.test(w) : false) !== M.dfaRun(d, w)) re = false; }
    }
    check('反編譯：one-hot 轉移矩陣 → DFA 結構，與原 DFA 完全相同（13 台）', rt); check('反編譯：狀態圖文字＝1 行摘要＋每個（狀態,符號）一行；Graphviz dot 結構合法', txt && dot);
    check('反編譯：DFA → 正規表示式（狀態消去法），用 JS RegExp 對 13 台×120 隨機串＝DFA', re); note('正規表示式長度：no11=' + lens.no11 + '（' + D.dfaToRegex(dfas.no11) + '）、evenA=' + lens.evenA + '、div3=' + lens.div3 + ' 字元');
    check('反編譯：不是 one-hot 的矩陣（費氏轉移矩陣、計數半環的 ΣMₐ）不能當 DFA，回傳 null', D.matricesToDfa([[[0, 1], [1, 1]]], ['x'], [1, 0], [0, 1]) === null && D.matricesToDfa([[[1, 1], [0, 1]]], ['x'], [1, 0], [0, 1]) === null);
    const growth = [3, 4, 5, 6, 7].map((n) => { const L = []; for (let t = 0; t < 15; t++) { const d = M.randomDfa(rnd, n, 2); const rx = D.dfaToRegex(d); if (rx !== null) L.push(rx.length); } return median(L); });
    check('可讀性門檻：隨機 DFA 的正規表示式長度隨狀態數快速成長（中位數 n=3..7）', growth[4] > 2 * growth[0] && growth.every((x, i) => i === 0 || x >= growth[i - 1] * 0.8), growth); note('隨機 2 符號 DFA 的正規表示式長度（中位數，n=3,4,5,6,7）：' + growth.join('、') + '；狀態圖文字只是 2n+1 行');
}
// ③ ReLU 決策樹 → if／else
{
    const nets = [['max（跳接）', RL.maxNet(true), [[-6, 6], [-6, 6]], 'Math.max(a,b)', 1], ['max（3 閘）', RL.maxNet(false), [[-6, 6], [-6, 6]], 'Math.max(a,b)', 1], ['abs', RL.absNet(), [[-12, 12]], 'Math.abs(x)', 1], ['clamp(x,-3,7)', RL.clampNet(-3, 7), [[-12, 12]], 'Math.min(7, Math.max(-3, x))', 1], ['排序 3 個數', RL.sortNet(3), [[0, 2], [0, 2], [0, 2]], 'sorted(a)', 1], ['x mod 3（N=30）', RL.modNet(3, 30), [[0, 29]], 'x % 3', 1]];
    let all = true; const rows = [];
    for (const [name, net, ranges, human, hl] of nets) {
        const pts = RC.boxPoints(ranges), tree = RC.compile(net, pts), names = ranges.map((_, i) => 'xyzwuv'[i]); const chain = D.treeToIfChain(tree, names);
        for (const p of pts) { const got = chain.fn(...p); const want = net.eval(p); const a = Array.isArray(got) ? got : [got]; if (a.length !== want.length || a.some((v, i) => v !== want[i])) all = false; }
        rows.push(name + '：' + chain.js.length + ' 行 if/else（人寫 ' + hl + ' 行：' + human + '）');
    }
    check('反編譯：ReLU 決策樹 → 可執行的 if／else 原始碼，6 個網路在有界整數域上逐點＝網路', all); note(rows.join('；'));
    const t = RC.compile(RL.maxNet(true), RC.boxPoints([[-6, 6], [-6, 6]])), c = D.treeToIfChain(t, ['a', 'b']); note('max 的中文：' + c.cnl.join(' ／ ').replace(/\s+/g, ' ')); check('反編譯：max 的 if／else 讀起來是「如果 a − b > 0：結果是 a；否則：結果是 b」', c.cnl.map((s) => s.trim()).join('|') === '如果 a - b > 0：|結果是 a|否則：|結果是 b', c.cnl);
}
// ④ VM → 中文受控自然語言，與人寫的參考解比行數
{
    const fs = require('fs'), path = require('path'); const refLines = {}; for (const l of fs.readFileSync(path.join(__dirname, '../recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean)) { const d = JSON.parse(l); refLines[d.id] = d.ref.python.split('\n').filter((x) => x.trim()).length; }
    const progs = [['fibonacci', VM.fibVM(M.P)], ['valid-brackets', VM.bracketsVM()], ['gcd-lcm', VM.gcdVM()], ['lower-bound', VM.lowerBoundVM()], ['is-palindrome', VM.palindromeVM()], ['grid-bfs', VM.bfsVM()]];
    let allKnown = true, rows = []; for (const [id, p] of progs) { const lines = D.vmToCnl(p); if (lines.some((x) => /未知指令/.test(x)) || lines.length !== p.code.length + 1) allKnown = false; rows.push(id + '：VM ' + p.code.length + ' 條指令／人寫 Python ' + refLines[id] + ' 行'); }
    check('反編譯：VM 程式 → 中文 CNL，每條指令一行、沒有未知指令（6 個程式）', allKnown); note(rows.join('；'));
    const fibCnl = D.vmToCnl(VM.fibVM(M.P)); check('反編譯：費氏 VM 讀起來像「讀入 n、M 的 n 次方、向量×M、取第一格」', fibCnl.some((x) => /矩陣快速冪/.test(x)) && fibCnl.some((x) => /矩陣乘法/.test(x)) && fibCnl[fibCnl.length - 1].includes('停機'), fibCnl); note('費氏 VM 的中文：\n    ' + fibCnl.join('\n    '));
}
// ⑤ 可讀的結構式 vs 不可讀的稠密／學出來的矩陣
{
    const nnz = (A) => A.reduce((s, r) => s + r.filter((x) => x !== 0).length, 0);
    const dense = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ri(1, 9))); const sparse = M.randomDfa(rnd, 8, 1); const Ms = M.dfaMatrices(sparse, M.SR.count(0));
    check('對照：隨機 8×8 稠密矩陣 64 個非零，沒有 one-hot 結構，不能轉成狀態圖；8 狀態 DFA 的轉移矩陣只有 8 個非零（每列一個 1），讀回 8 條邊', nnz(dense) === 64 && D.matricesToDfa([dense], ['x'], [1, 0, 0, 0, 0, 0, 0, 0], new Array(8).fill(0)) === null && nnz(Ms[0]) === 8 && D.dfaToText(sparse).length === 9);
    const cp = D.charPoly(dense); const digits = cp.map((c) => String(Math.abs(c)).length); note('稠密 8×8 的遞推式讀出來是 8 階、係數最多 ' + Math.max(...digits) + ' 位數（' + D.matrixToRecurrence(dense).text.slice(0, 70) + '…）：形式上是遞推式，但沒有「意義」可讀；結構式矩陣（費氏）係數是 1、1');
    // 學出來的 WFA（模質數的 Ho–Kalman）vs 狀態合併學出的 DFA
    const f3 = (w) => { let v = 0; for (const c of w) v = v * 2 + (c === '1' ? 1 : 0); return (w === '' || v % 3 === 0) ? 1 : 0; };
    const wfa = M.learnWFA(f3, ['0', '1'], 5, M.P); const entries = [].concat(...Object.values(wfa.A).map((A) => [].concat(...A)), wfa.alpha[0], [].concat(...wfa.beta)); const big = entries.filter((x) => x > 1000 && x < M.P - 1000).length;
    const dfa = M.learnDFA(f3, ['0', '1'], 5); const g = D.dfaToText(dfa.dfa);
    const isBig = (x) => x > 1000 && x < M.P - 1000;
    check('學出來的矩陣（有結構的目標）：DFA 語言的 Ho–Kalman WFA（維度 ' + wfa.dim + '）元素全是 0／1（基底＝代表前綴＝狀態），其實讀得懂；同一個函數用狀態合併學到 ' + dfa.states + ' 狀態 ' + g.length + ' 行的狀態圖', wfa.ok && big === 0 && entries.every((x) => x === 0 || x === 1) && dfa.states === 3, { big, n: entries.length });
    // 目標本身是隨機稠密矩陣（沒有結構）：學出來的是它的相似變換，元素變成模質數的大數
    const rm = () => Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ri(0, 4))); const R = { '0': rm(), '1': rm() }, al = [[1, 2, 3]], be = [[1], [0], [2]];
    const mm = (X, Y) => X.map((r) => Y[0].map((_, j) => r.reduce((t, x, k) => (t + M.mulmod(x, Y[k][j], M.P)) % M.P, 0)));
    const fr = (w) => { let v = al; for (const c of w) v = mm(v, R[c]); return mm(v, be)[0][0]; };
    const w2 = M.learnWFA(fr, ['0', '1'], 4, M.P); const e2 = w2.ok ? [].concat(...Object.values(w2.A).map((A) => [].concat(...A)), w2.alpha[0], [].concat(...w2.beta)) : []; const big2 = e2.filter(isBig).length;
    let eq = w2.ok; for (let t = 0; t < 40 && eq; t++) { const w = Array.from({ length: ri(0, 25) }, () => ri(0, 1)).join(''); if (w2.eval(w) !== fr(w)) eq = false; }
    check('學出來的矩陣（隨機稠密目標）：3×3 稠密 WFA 被 Ho–Kalman 學回後函數相同，但元素有 ' + big2 + '／' + e2.length + ' 個是看不出意義的大數（相似變換後的基底不唯一）', w2.ok && w2.dim === 3 && eq && big2 > 0, { dim: w2.dim, big2 });
    note('隨機稠密目標學出的元素樣本：' + e2.slice(0, 8).join(', ') + '…（要先換成 DFA／遞推式或加註解才讀得懂）；有結構的目標（DFA 語言）學出的是 0／1');
    // 乘積 vs 直和的可讀性（行數）
    const cnt = (ch) => (w) => w.split('').filter((c) => c === ch).length; const mods = [['a', 2], ['b', 3], ['c', 5]]; const joint = (w) => mods.every(([ch, m]) => cnt(ch)(w) % m === 0);
    const jd = M.learnDFA(joint, ['a', 'b', 'c'], 7, 80); const jl = D.dfaToText(jd.dfa).length; const sep = mods.map(([, m]) => 1 + m * 3).reduce((a, b) => a + b, 0);
    check('可讀性：三個獨立計數器合成的單一 DFA（' + jd.states + ' 狀態）狀態圖 ' + jl + ' 行；分成三個小機器是 ' + sep + ' 行', jd.states === 30 && jl === 1 + 30 * 3 && sep === 33 && jl > 2 * sep); note('聯合 ' + jl + ' 行 vs 三個小機器 ' + sep + ' 行（小的比較容易讀）');
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
