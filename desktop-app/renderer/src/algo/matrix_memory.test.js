// 「矩陣接不起來的地方，程式化的銜接」驗證：node renderer/src/algo/matrix_memory.test.js（量到的數字會印出來，DESIGN.matrix-algorithms.md 第 13 節引用）
const M = require('./matrix_forms_core.js'), MM = require('./matrix_machine_core.js'), RL = require('./relu_core.js'), VM = require('./matrix_vm_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600))); } }
const note = (s) => console.log('  · ' + s);
let seed = 131106; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// 佇列：BFS 最少步數
{
    let all = true, reach = 0, unreach = 0; for (let t = 0; t < 80; t++) {
        const n = ri(2, 9), m = ri(0, 14); const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1)]); const toks = [n, m]; for (const [u, v] of edges) toks.push(u, v);
        const adj = Array.from({ length: n }, () => []); for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); } const dist = new Array(n).fill(-1); dist[0] = 0; const q = [0]; while (q.length) { const u = q.shift(); for (const v of adj[u]) if (dist[v] < 0) { dist[v] = dist[u] + 1; q.push(v); } }
        if (VM.run(VM.bfsVM(), toks).value !== dist[n - 1]) all = false; dist[n - 1] < 0 ? unreach++ : reach++;
    }
    check('佇列：BFS 最少步數（enq／deq／jqe＋距離陣列）＝標準 BFS（80 張隨機圖：' + reach + ' 可達、' + unreach + ' 不可達＝−1）', all && reach > 15 && unreach > 5); note('BFS VM 程式 ' + VM.bfsVM().code.length + ' 條指令');
}
// 記憶體本身就是矩陣：one-hot 位址讀寫
{
    let all = true, ops = 0; for (let t = 0; t < 60; t++) {
        const n = ri(1, 8); const arr = new Array(n).fill(0); const toks = [n], ref = []; for (let k = 0; k < ri(1, 25); k++) { const i = ri(0, n - 1); if (rnd() < 0.5) { toks.push(0, i); ref.push(arr[i]); } else { const v = ri(-50, 50); toks.push(1, i, v); arr[i] = v; } ops++; }
        const out = VM.run(VM.oneHotMemVM(), toks).out; if (JSON.stringify(out) !== JSON.stringify(ref)) { all = false; console.log(toks, out, ref); }
    }
    check('記憶體＝矩陣：n×1 陣列、one-hot 位址向量；讀＝onehot×arr、寫＝arr＋onehotᵀ·(新−舊)，對 ' + ops + ' 個隨機讀寫＝普通陣列（60 組）', all);
    const big = VM.run(VM.oneHotMemVM(), [64, 1, 63, 9, 0, 63]); note('讀寫一格要做 O(n) 的矩陣乘法（n=64：一次寫入＋一次讀取共 ' + big.steps + ' 步，其中 ' + big.ops.mul + ' 次矩陣乘、每次 64 維）；普通陣列是 O(1)');
}
// 不經意（oblivious）：雙調排序
{
    let vmOk = true, nets = true; const rows = []; for (const size of [2, 4, 8, 16]) {
        const prog = VM.bitonicVM(size), net = RL.bitonicNet(size), sched = VM.bitonicSchedule(size).length;
        for (let t = 0; t < 40; t++) { const a = Array.from({ length: size }, () => ri(-30, 30)); const want = a.slice().sort((x, y) => x - y); if (JSON.stringify(VM.run(prog, a).out) !== JSON.stringify(want)) vmOk = false; if (JSON.stringify(net.eval(a)) !== JSON.stringify(want)) nets = false; }
        if (net.gates !== sched || sched !== (size / 4) * Math.log2(size) * (Math.log2(size) + 1)) nets = false; if (size === 2 && sched !== 1) nets = false; rows.push('n=' + size + '：雙調 ' + sched + '／氣泡 ' + size * (size - 1) / 2);
    }
    check('不經意排序：雙調排序網路展開成 VM 程式（固定的 get／比較／set 序列）＝sort（n=2,4,8,16，各 40 組）', vmOk);
    check('不經意排序：同一個比較序列做成 ReLU 電路（每個比較交換 1 閘）＝sort，閘數＝(n/4)·log₂n·(log₂n+1)', nets); note('比較交換數（雙調／氣泡）：' + rows.join('、') + '；雙調是 O(n log²n)，且資料流與輸入無關，不需要任何記憶體以外的控制');
    const sched4 = VM.bitonicSchedule(8); const dataIndep = JSON.stringify(sched4) === JSON.stringify(VM.bitonicSchedule(8)); check('不經意：比較序列只由 n 決定（兩次產生完全相同）', dataIndep);
}
// 並查集：陣列版 vs 指標跳躍（函數圖矩陣冪）
{
    let uf = true, pj = true, pjRoots = 0; for (let t = 0; t < 80; t++) {
        const n = ri(1, 10), m = ri(0, 12); const edges = Array.from({ length: m }, () => [ri(0, n - 1), ri(0, n - 1)]); const toks = [n, m]; for (const [u, v] of edges) toks.push(u, v);
        if (VM.run(VM.unionFindVM(), toks).value !== M.componentsUnionFind(n, edges)) uf = false;
        const par = Array.from({ length: n }, (_, i) => (rnd() < 0.35 ? i : ri(0, i))); const q = ri(0, n - 1); let r = q; while (par[r] !== r) r = par[r]; if (par[r] === r && r === q) pjRoots++;
        if (VM.run(VM.pointerJumpVM(), [n].concat(par, [q])).value !== r) pj = false;
    }
    check('並查集（陣列＋find 迴圈）＝並查集參考（連通分量數，80 張圖）', uf); check('指標跳躍：函數圖的布林矩陣冪 F^n 的第 q 列＝q 的根（80 個隨機森林）', pj);
    note('指標跳躍用 1 次 pow（O(n³ log n) 維度 n 的矩陣），並查集用 O(α(n)) 的陣列存取：用矩陣代替記憶體的代價');
}
// 有界堆疊展開成置換（移位）矩陣
{
    const ref = (t) => { const st = []; let maxD = 0; for (const c of t) { if (c < 4) { st.push(c); maxD = Math.max(maxD, st.length); } else { if (!st.length || st.pop() !== c - 3) return { ok: false, maxD }; } } return { ok: st.length === 0, maxD }; };
    const gen = () => { const out = [], st = []; const len = ri(0, 16); for (let i = 0; i < len; i++) { if (st.length && rnd() < 0.5) out.push(st.pop() + 3); else { const o = ri(1, 3); st.push(o); out.push(o); } } while (st.length) out.push(st.pop() + 3); if (rnd() < 0.4 && out.length) out[ri(0, out.length - 1)] = ri(1, 6); return out; };
    const K = 5, prog = MM.boundedBracketsProgram(K); let all = true, over = 0, fits = 0; for (let t = 0; t < 400; t++) { const w = gen(), r = ref(w), h = MM.run(prog, w).halted; if (r.maxD <= K) { fits++; if ((h === 'accept') !== r.ok) all = false; } else { over++; if (r.ok === false && h === 'accept') all = false; } }
    check('有界堆疊：K=5 個暫存器＋移位矩陣（push／pop），深度 ≤5 的 ' + fits + ' 串＝標準堆疊；其餘 ' + over + ' 串不會被誤接受', all && fits > 100 && over > 5);
    const sz = [2, 5, 10].map((k) => MM.size(MM.boundedBracketsProgram(k)).states); note('有界堆疊機器的控制狀態數（K=2,5,10）：' + sz.join('、') + '（隨 K 線性成長；矩陣維度 K+1）；深度超過 K 就 overflow，而 VM 的 push／pop 沒有上限');
    check('有界堆疊：深度 K+1 的輸入在 K 時停在 overflow', MM.run(MM.boundedBracketsProgram(3), [1, 1, 1, 1, 4, 4, 4, 4]).halted === 'overflow');
}
// 種子 20 題：最少需要的記憶體；加記憶體前後 VM 能直接表達（且本檔驗證過）的題數
{
    const fs = require('fs'), path = require('path'); const ids = fs.readFileSync(path.join(__dirname, '../recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
    check('記憶體分類表涵蓋種子 20 題', ids.length === 20 && ids.every((i) => VM.SEED_MEM[i]) && Object.keys(VM.SEED_MEM).length === 20);
    const cnt = {}; for (const i of ids) cnt[VM.SEED_MEM[i].min] = (cnt[VM.SEED_MEM[i].min] || 0) + 1; const ver = ids.filter((i) => VM.SEED_MEM[i].vm);
    note('種子 20 題最少需要的記憶體：' + JSON.stringify(cnt) + '；已編成 VM／機器並對照過：' + ver.join('、') + '（' + ver.length + ' 題）');
    check('分類數：無記憶體 3、計數器 1、堆疊 2、陣列／佇列／≥2 計數器 14', cnt.none === 3 && cnt.counter === 1 && cnt.stack === 2 && cnt.array === 14, cnt);
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
