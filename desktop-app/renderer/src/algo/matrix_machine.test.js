// 「多個小矩陣＋狀態機」「ReLU 與 CoLU」「矩陣 VM」的驗證測試：node renderer/src/algo/matrix_machine.test.js（量到的數字會印出來，DESIGN.matrix-algorithms.md 第 9～11 節引用）
const M = require('./matrix_forms_core.js'), MM = require('./matrix_machine_core.js'), RL = require('./relu_core.js'), VM = require('./matrix_vm_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 700))); } }
const note = (s) => console.log('  · ' + s);
let seed = 7061106; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)); const P = M.P;
const nth = (n) => M.nthTerm([0, 1, 1, 2], [0, 1, 1], n, P);

// ===== 9. 狀態機＋小矩陣 =====
{
    const fm = MM.fibProgram(P); let all = true; for (const n of [0, 1, 2, 10, 90, 500, 3000, ri(1000, 4000)]) if (MM.run(fm, [n]).value !== nth(n)) all = false;
    check('機器：讀入→初始化→迴圈（小矩陣）→取模輸出＝費氏（n 到 4000）', all); const sz = MM.size(fm); note('費氏機器：' + sz.states + ' 個控制狀態、' + sz.matrices + ' 個小矩陣、最大 ' + sz.maxDim + '×' + sz.maxDim + '、' + sz.guards + ' 個守衛（O(n) 步；matPow 版 O(log n)）');
    // 數字 token 能被 3 整除的個數：控制＝DFA，計數＝2×2 小矩陣
    let dOk = true; for (let t = 0; t < 80; t++) { const toks = []; const k = ri(1, 6); const vals = []; for (let q = 0; q < k; q++) { const len = ri(1, 8); let v = 0; for (let b = 0; b < len; b++) { const bit = ri(0, 1); toks.push(bit); v = v * 2 + bit; } vals.push(v); if (q + 1 < k) toks.push(2); } if (MM.run(MM.divCountProgram(), toks).value !== vals.filter((v) => v % 3 === 0).length) dOk = false; }
    check('機器：DFA（控制）＋計數器（小矩陣）＝「能被 3 整除的數有幾個」（80 組隨機）', dOk); note('DFA＋計數機器：' + JSON.stringify(MM.size(MM.divCountProgram())) + '；不用控制狀態、全放進一個矩陣時，計數到 K 就要 3·(K+1) 維');
    // 三種括號（堆疊放在整數暫存器）
    const refBr = (t) => { const st = []; for (const c of t) { if (c < 4) st.push(c); else { if (!st.length || st.pop() !== c - 3) return false; } } return st.length === 0; };
    const genBr = () => { const out = [], st = []; const len = ri(0, 14); for (let i = 0; i < len; i++) { if (st.length && rnd() < 0.5) out.push(st.pop() + 3); else { const o = ri(1, 3); st.push(o); out.push(o); } } while (st.length) out.push(st.pop() + 3); if (rnd() < 0.5 && out.length) out[ri(0, out.length - 1)] = ri(1, 6); return out; };
    let bOk = true, acc = 0, rej = 0; for (let t = 0; t < 300; t++) { const w = genBr(); const r = refBr(w); if ((MM.run(MM.bracketsProgram(), w).halted === 'accept') !== r) { bOk = false; console.log(w, r); } r ? acc++ : rej++; }
    check('機器：三種括號，堆疊編進一個整數暫存器（push＝仿射矩陣、pop＝比較守衛迴圈）＝標準堆疊（300 串：' + acc + ' 接受、' + rej + ' 拒絕）', bOk && acc > 40 && rej > 40);
    let gOk = true; for (let t = 0; t < 60; t++) { const a = ri(1, 400), b = ri(1, 400); const g = (x, y) => (y ? g(y, x % y) : x); if (MM.run(MM.gcdProgram(), [a, b]).value !== g(a, b)) gOk = false; }
    check('機器：輾轉相減（置換矩陣交換＋守衛）＝gcd（60 組）', gOk);
    const sieve = (n) => { let c = 0; for (let k = 2; k <= n; k++) { let p = true; for (let d = 2; d * d <= k; d++) if (k % d === 0) p = false; if (p) c++; } return c; };
    check('機器：試除質數個數（餘數用連續減）＝參考（n=0..80 全部）', Array.from({ length: 81 }, (_, n) => n).every((n) => MM.run(MM.primeCountProgram(), [n]).value === sieve(n)));
    let sOk = true, kOk = true; for (let n = 1; n <= 6; n++) for (let t = 0; t < 20; t++) { const a = Array.from({ length: n }, () => ri(-20, 20)); if (JSON.stringify(MM.run(MM.bubbleProgram(n), a).regs) !== JSON.stringify(a.slice().sort((x, y) => x - y))) sOk = false; const k = ri(1, n); if (MM.run(MM.bubbleProgram(n, { k: true }), [k].concat(a)).value !== a.slice().sort((x, y) => y - x)[k - 1]) kOk = false; }
    check('機器：固定 n（1..6）的氣泡排序＝sort；控制狀態＝比較位置、交換＝置換矩陣', sOk); check('機器：固定 n 的第 k 大（排序後依暫存器 k 分支）＝參考', kOk);
    const bs = [3, 5, 6].map((n) => MM.size(MM.bubbleProgram(n)).states); note('氣泡排序機器的控制狀態數（n=3,5,6）：' + bs.join('、') + '（讀入 n＋比較 n(n−1)/2＋交換 n(n−1)/2＋1）；每個矩陣只有 ' + 7 + '×' + 7 + ' 以內');
    let lOk = true; for (let n = 1; n <= 8; n++) for (let t = 0; t < 25; t++) { const a = Array.from({ length: n }, () => ri(0, 12)).sort((x, y) => x - y); const x = ri(0, 13); let ref = a.findIndex((v) => v >= x); if (ref < 0) ref = n; if (MM.run(MM.lowerBoundProgram(n), a.concat([x])).value !== ref) lOk = false; }
    check('機器：固定 n（1..8）的二分搜尋＝線性找第一個 ≥x（控制＝區間決策樹，守衛比較 a[mid] 與 x）', lOk); note('二分搜尋機器的控制狀態數（n=4,8,16）：' + [4, 8, 16].map((n) => MM.size(MM.lowerBoundProgram(n)).states).join('、'));
    // 直和 vs 乘積：獨立的小機器並行，維度相加；聯合成一個 DFA，維度相乘
    // 三個獨立的計數器：a 的個數 mod 2、b 的個數 mod 3、c 的個數 mod 5 都是 0
    const cnt = (ch) => (w) => w.split('').filter((c) => c === ch).length; const mods = [['a', 2], ['b', 3], ['c', 5]];
    const joint = (k) => (w) => mods.slice(0, k).every(([ch, m]) => cnt(ch)(w) % m === 0);
    const prodStates = [1, 2, 3].map((k) => M.learnDFA(joint(k), ['a', 'b', 'c'], 7, 80).states);
    check('乘積構造：k 個獨立計數器合成一個 DFA，最小狀態數＝2、6、30（相乘）', JSON.stringify(prodStates) === '[2,6,30]', prodStates); note('聯合成一個 DFA：' + prodStates.join('、') + ' 個狀態；各自獨立的小 DFA（直和／分塊對角）：2、5（2+3）、10（2+3+5）維');
    const mk = (ch, m) => ({ n: m, alphabet: ['a', 'b', 'c'], start: 0, accept: Array.from({ length: m }, (_, i) => i === 0), delta: Array.from({ length: m }, (_, r) => ['a', 'b', 'c'].map((x) => (x === ch ? (r + 1) % m : r))) });
    let dsOk = true; for (let t = 0; t < 100; t++) { const w = Array.from({ length: ri(0, 30) }, () => 'abc'[ri(0, 2)]).join(''); const parts = mods.map(([ch, m]) => M.dfaRunMatrix(mk(ch, m), w)); if (parts.every(Boolean) !== joint(3)(w)) dsOk = false; }
    check('直和：三個獨立小矩陣機器各跑各的、最後由控制邏輯做 AND＝聯合 DFA（100 串）', dsOk);
}

// ===== 10. ReLU 電路 =====
{
    let mx = true, mx3 = true, mn = true, ab = true, cl = true; for (let t = 0; t < 400; t++) { const a = ri(-50, 50) / 2, b = ri(-50, 50) / 2; mx &&= RL.maxNet(true).eval([a, b])[0] === Math.max(a, b); mx3 &&= RL.maxNet(false).eval([a, b])[0] === Math.max(a, b); mn &&= RL.minNet().eval([a, b])[0] === Math.min(a, b); ab &&= RL.absNet().eval([a])[0] === Math.abs(a); cl &&= RL.clampNet(-3, 7).eval([a])[0] === Math.min(7, Math.max(-3, a)); }
    check('ReLU：max(a,b) 精確（跳接版 1 閘、純單隱藏層 3 閘）、min、abs（2 閘）、clamp（2 閘）', mx && mx3 && mn && ab && cl && RL.maxNet(true).gates === 1 && RL.maxNet(false).gates === 3 && RL.absNet().gates === 2 && RL.clampNet(0, 1).gates === 2 && RL.minNet().gates === 1);
    let mp = true; for (let t = 0; t < 40; t++) { const k = ri(2, 5), m = ri(2, 5); const Mx = Array.from({ length: k }, () => Array.from({ length: m }, () => (rnd() < 0.3 ? Infinity : ri(0, 9)))); for (let j = 0; j < m; j++) if (Mx.every((r) => r[j] === Infinity)) Mx[0][j] = ri(0, 9); const v = Array.from({ length: k }, () => ri(0, 9)); const net = RL.minPlusStepNet(Mx); const ref = M.matMul([v], Mx, M.SR.minplus)[0]; if (JSON.stringify(net.eval(v)) !== JSON.stringify(ref)) mp = false; }
    check('ReLU：min-plus 矩陣乘一步（k×m）＝ReLU 電路（每個輸出 有限項數−1 個 min 閘；40 組隨機）', mp);
    let sn = true; for (let n = 2; n <= 8; n++) { const net = RL.sortNet(n); if (net.gates !== n * (n - 1) / 2) sn = false; for (let t = 0; t < 30; t++) { const a = Array.from({ length: n }, () => ri(-30, 30)); if (JSON.stringify(net.eval(a)) !== JSON.stringify(a.slice().sort((x, y) => x - y))) sn = false; } }
    check('ReLU：排序網路（n=2..8）＝sort，閘數＝n(n−1)/2（每個比較交換 1 閘），固定 n 才有', sn);
    const ma = [4, 8, 16].map((n) => RL.maxArrayNet(n)); check('ReLU：n 個數取最大＝n−1 閘、深度 n−1（鏈）；n 變了電路就要重建', ma.every((net, i) => net.gates === [3, 7, 15][i]) && ma[0].eval([3, 9, 2, 5])[0] === 9);
    let dv = true; for (const [m, N] of [[2, 20], [3, 31], [7, 100], [10, 100]]) { const q = RL.floorDivNet(m, N), r = RL.modNet(m, N); if (q.gates !== 2 * Math.floor((N - 1) / m)) dv = false; for (let x = 0; x < N; x++) if (q.eval([x])[0] !== Math.floor(x / m) || r.eval([x])[0] !== x % m) dv = false; }
    check('ReLU：整數除法與取餘（x∈[0,N)）在整數上精確，閘數＝2·⌊(N−1)/m⌋（隨範圍線性成長）', dv);
    check('ReLU：除法對非整數輸入只是折線插值（8.5÷3：電路給 2.5，不是 2）', Math.abs(RL.floorDivNet(3, 20).eval([8.5])[0] - 2.5) < 1e-12);
    const tab = [10, 100, 1000].map((N) => RL.floorDivNet(3, N).gates); note('floor(x/3) 的 ReLU 閘數（N=10,100,1000）：' + tab.join('、') + '；max／abs／clamp：1～3 閘；排序 n=8：28 閘');
}

// ===== 11. 矩陣 VM =====
{
    const fv = VM.fibVM(P); let fOk = true; for (const n of [0, 1, 2, 90, 1000, 123456789, 1e12, ri(1, 1e9)]) if (VM.run(fv, [n]).value !== nth(n)) fOk = false;
    const r1 = VM.run(fv, [90]); check('VM：費氏取模（7 條指令：read、const×2、pow、mul、get、halt）＝獨立實作（n 到 10^12）', fOk && fv.code.length === 7 && r1.mul === 1 && r1.pow === 1, r1); note('費氏 VM：' + fv.code.length + ' 條指令，執行 ' + r1.steps + ' 步，其中矩陣冪 ' + r1.pow + ' 次（機器版要 O(n) 步）');
    // 驗證器
    check('VM 驗證：不認得的 op、缺欄位、不存在的標籤、不認得的半環都會被擋', VM.validate({ sr: { name: 'count' }, code: [{ op: 'frob' }] }).length === 1 && VM.validate({ sr: { name: 'count' }, code: [{ op: 'mul', dst: 'a' }] }).length >= 2 && VM.validate({ sr: { name: 'count' }, code: [{ op: 'jmp', to: 'nope' }] }).length === 1 && VM.validate({ sr: { name: 'x' }, code: [] }).length === 1 && VM.validate(fv).length === 0);
    let thrown = false; try { VM.run({ sr: { name: 'count' }, code: [{ op: 'halt', src: 'ghost' }] }, []); } catch (e) { thrown = true; } check('VM：讀沒有值的暫存器會丟錯，不會默默給 0', thrown);
    // DFA 計數
    const dfas = [M.DFAS.div3, M.DFAS.no11, M.DFAS.evenA]; for (let t = 0; t < 6; t++) dfas.push(M.randomDfa(rnd, ri(2, 5), ri(2, 3)));
    let dOk = true; for (const d of dfas) { const prog = VM.dfaCountVM(d); for (let t = 0; t < 25; t++) { const w = Array.from({ length: ri(0, 20) }, () => ri(0, d.alphabet.length - 1)); let ref = 0; for (let l = 1; l <= w.length; l++) if (M.dfaRun(d, w.slice(0, l).map((x) => d.alphabet[x]).join(''))) ref++; if (VM.run(prog, w).value !== ref) dOk = false; } }
    check('VM：DFA 計數（轉移矩陣常數＋向量×矩陣＋跳轉選矩陣）＝直接跑 DFA（9 台、225 組隨機）', dOk);
    // 圖：路徑計數（count 取模）與最短路（min-plus）
    const gen = (weighted) => { const n = ri(2, 7), m = ri(0, 14); const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1), ri(1, 9)]); return { n, edges }; };
    let pc = true, sp = true; for (let t = 0; t < 40; t++) {
        const { n, edges } = gen(); const K = ri(0, 12); const toks = [n, edges.length]; for (const [u, v] of edges) toks.push(u, v); toks.push(K);
        const A = Array.from({ length: n }, () => new Array(n).fill(0)); for (const [u, v] of edges) A[u][v]++; let vec = new Array(n).fill(0); vec[0] = 1; for (let s = 0; s < K; s++) { const nv = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nv[j] = (nv[j] + M.mulmod(vec[i], A[i][j], P)) % P; vec = nv; }
        if (VM.run(VM.graphVM('count', P), toks).value !== vec[n - 1]) pc = false;
        const t2 = [n, edges.length]; for (const [u, v, w] of edges) t2.push(u, v, w); const d = M.dijkstra(n, edges, 0, true)[n - 1]; if (VM.run(VM.graphVM('minplus'), t2).value !== d) sp = false;
    }
    check('VM：圖路徑計數（count 半環、取模）＝向量迭代 DP（40 張隨機圖，含重邊、自環）', pc); check('VM：最短路（min-plus 半環、矩陣冪 n−1 次）＝Dijkstra（40 張隨機有向圖，含不可達＝Infinity）', sp);
    // 需要堆疊 / 陣列的
    const refBr = (t) => { const st = []; for (const c of t) { if (c < 4) st.push(c); else { if (!st.length || st.pop() !== c - 3) return false; } } return st.length === 0; };
    const genBr = () => { const out = [], st = []; const len = ri(0, 14); for (let i = 0; i < len; i++) { if (st.length && rnd() < 0.5) out.push(st.pop() + 3); else { const o = ri(1, 3); st.push(o); out.push(o); } } while (st.length) out.push(st.pop() + 3); if (rnd() < 0.5 && out.length) out[ri(0, out.length - 1)] = ri(1, 6); return out; };
    let bOk = true, acc = 0; for (let t = 0; t < 300; t++) { const w = genBr(); const r = refBr(w); if ((VM.run(VM.bracketsVM(), w).value === 1) !== r) bOk = false; if (r) acc++; }
    check('VM：括號配對（push／pop 指令＝堆疊）＝標準解（300 串，' + acc + ' 接受）', bOk && acc > 40);
    const g = (x, y) => (y ? g(y, x % y) : x); check('VM：gcd（跳轉＋標量減法）＝參考（60 組）', Array.from({ length: 60 }, () => [ri(1, 500), ri(1, 500)]).every(([a, b]) => VM.run(VM.gcdVM(), [a, b]).value === g(a, b)));
    let lb = true, pal = true; for (let t = 0; t < 120; t++) { const n = ri(1, 12); const a = Array.from({ length: n }, () => ri(0, 10)).sort((x, y) => x - y); const x = ri(0, 11); let ref = a.findIndex((v) => v >= x); if (ref < 0) ref = n; if (VM.run(VM.lowerBoundVM(), [n].concat(a, [x])).value !== ref) lb = false;
        const w = Array.from({ length: ri(1, 8) }, () => ri(1, 3)); const w2 = rnd() < 0.5 ? w.concat(w.slice().reverse()) : w.concat(w.slice(0, -1).reverse()); const rr = w2.join() === w2.slice().reverse().join(); if ((VM.run(VM.palindromeVM(), [w2.length].concat(w2)).value === 1) !== rr) pal = false; }
    check('VM：二分搜尋（任意 n，陣列 set／get＋索引暫存器）＝線性找（120 組）', lb); check('VM：迴文（任意 n，雙指標）＝參考（120 組）', pal);
    // JSONL
    const progs = { fib: [fv, [50]], br: [VM.bracketsVM(), [1, 2, 5, 4]], gcd: [VM.gcdVM(), [12, 18]], lb: [VM.lowerBoundVM(), [3, 1, 4, 9, 4]], pal: [VM.palindromeVM(), [3, 1, 2, 1]], dfa: [VM.dfaCountVM(M.DFAS.div3), [1, 1, 0, 0, 1]] };
    let js = true; for (const [k, [p, inp]] of Object.entries(progs)) { const text = VM.toJsonl(p); const back = VM.fromJsonl(text); if (JSON.stringify(back) !== JSON.stringify(p) || VM.run(back, inp).value !== VM.run(p, inp).value || !text.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch (e) { return false; } })) js = false; }
    check('VM：每條指令一行 JSONL，序列化→還原後內容與執行結果相同（6 個程式）', js);
    const sizes = Object.entries(progs).map(([k, [p]]) => k + '=' + p.code.length); note('VM 程式指令數：' + sizes.join('、'));
    // 種子分類
    const fs = require('fs'), path = require('path'); const ids = fs.readFileSync(path.join(__dirname, '../recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
    check('VM 分類表涵蓋種子 20 題', ids.length === 20 && ids.every((i) => VM.SEED_VM[i]) && Object.keys(VM.SEED_VM).length === 20);
    const cm = ids.filter((i) => VM.SEED_VM[i].cls === 'matrix').length, cg = 20 - cm, dr = ids.filter((i) => VM.SEED_VM[i].direct).length; note('種子 20 題：矩陣指令是主角 ' + cm + '、只靠標量／跳轉／陣列／堆疊 ' + cg + '；本檔已編成 VM 程式並對照的 ' + dr + ' 題（含同類）');
}

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
