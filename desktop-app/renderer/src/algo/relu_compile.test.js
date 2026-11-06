// ReLU 網路 → CoLU 決策樹／機器的編譯測試：node renderer/src/algo/relu_compile.test.js（量到的數字會印出來，DESIGN.matrix-algorithms.md 第 12 節引用）
const RL = require('./relu_core.js'), RC = require('./relu_compile_core.js'), M = require('./matrix_forms_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 600))); } }
const note = (s) => console.log('  · ' + s);
let seed = 61106; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 「x>=y 則 a 否則 b」：a、b ∈ [0,B]、x、y 整數。s = step(x−y) = relu(x−y+1) − relu(x−y)（整數上恰為 [x≥y]）；輸出 relu(a−B(1−s)) + relu(b−B·s)
function iteNet(B) {
    const n = new RL.Net(4); const d = n.lin([[0, 1], [1, -1]]); const r1 = n.relu(n.lin([[d, 1]], 1)), r2 = n.relu(d); const s = n.lin([[r1, 1], [r2, -1]]);
    const ta = n.relu(n.lin([[2, 1], [s, B]], -B)), tb = n.relu(n.lin([[3, 1], [s, -B]])); n.out = [n.lin([[ta, 1], [tb, 1]])]; return n;
}
const iteSpec = ([x, y, a, b]) => [x >= y ? a : b];
const cases = [
    ['max(a,b)（1 閘）', RL.maxNet(true), [[-8, 8], [-8, 8]], ([a, b]) => [Math.max(a, b)]],
    ['max(a,b)（3 閘）', RL.maxNet(false), [[-8, 8], [-8, 8]], ([a, b]) => [Math.max(a, b)]],
    ['abs(x)', RL.absNet(), [[-20, 20]], ([x]) => [Math.abs(x)]],
    ['clamp(x,-3,7)', RL.clampNet(-3, 7), [[-20, 20]], ([x]) => [Math.min(7, Math.max(-3, x))]],
    ['min-plus 一步（2×2）', RL.minPlusStepNet([[0, 3], [1, 0]]), [[0, 9], [0, 9]], ([a, b]) => [Math.min(a + 0, b + 1), Math.min(a + 3, b + 0)]],
    ['x>=y ? a : b（B=3）', iteNet(3), [[0, 3], [0, 3], [0, 3], [0, 3]], iteSpec],
];
const stat = {};
for (const [name, net, ranges, spec] of cases) {
    const pts = RC.boxPoints(ranges); const verified = pts.every((p) => same(net.eval(p), spec(p)));            // 1) 網路 ＝ 規格（窮舉整個有界整數域）
    const tree = RC.compile(net, pts), st = RC.stats(tree); stat[name] = st;
    const eqTree = pts.every((p) => same(RC.evalTree(tree, p), net.eval(p)));                                   // 2) 編譯後的樹 ＝ 網路（逐點）
    const prog = RC.toMachine(tree); const eqMach = pts.every((p) => same(RC.runMachine(prog, tree.nIn, p), net.eval(p)));   // 3) 轉成 CoLU 風格機器 ＝ 網路
    const back = RC.fromJsonl(RC.toJsonl(tree)); const eqJson = pts.slice(0, 200).every((p) => same(RC.evalTree(back, p), net.eval(p))) && JSON.stringify(back) === JSON.stringify(tree);
    check('編譯：' + name + '：網路＝規格（' + pts.length + ' 點窮舉）、樹＝網路、機器＝網路、JSONL 往返', verified && eqTree && eqMach && eqJson, { verified, eqTree, eqMach, eqJson });
    note(name + '：' + net.gates + ' 閘 → ' + st.leaves + ' 個葉子、' + st.internal + ' 個分支、深度 ' + st.depth + '；機器 ' + Object.keys(prog.states).length + ' 個狀態');
}
// exact 模式：不靠定義域，對實數輸入也相同；domain 模式只保證整數點
{
    let allExact = true; for (const [name, net, ranges] of cases) { const t = RC.compile(net, null); for (let k = 0; k < 300; k++) { const x = ranges.map(([lo, hi]) => lo + rnd() * (hi - lo)); const a = RC.evalTree(t, x), b = net.eval(x); if (!a.every((v, i) => Math.abs(v - b[i]) < 1e-9)) allExact = false; } }
    check('exact 模式（不剪枝）：6 個網路在實數輸入上樹＝網路（每個 300 點）', allExact);
    const q = new RL.Net(1); const r1 = q.relu(q.lin([[0, 10]], -3)), r2 = q.relu(q.lin([[0, 10]], -6)); q.out = [q.lin([[r1, 1], [r2, -1]])];   // relu(10x−3) − relu(10x−6)：x∈(0.3,0.6] 的斜坡區間沒有整數點
    const dom = RC.boxPoints([[0, 5]]); const td = RC.compile(q, dom), te = RC.compile(q, null);
    check('domain 模式只保證整數點：relu(10x−3)−relu(10x−6) 的樹在 x=0.45 給 3、網路給 1.5（斜坡區間沒有整數點被剪掉）；exact 模式相同', RC.evalTree(td, [0.45])[0] === 3 && Math.abs(q.eval([0.45])[0] - 1.5) < 1e-12 && Math.abs(RC.evalTree(te, [0.45])[0] - 1.5) < 1e-12 && dom.every((p) => RC.evalTree(td, p)[0] === q.eval(p)[0]), [RC.evalTree(td, [0.45]), RC.evalTree(te, [0.45]), q.eval([0.45])]);
    note('該例：domain 模式 ' + RC.stats(td).leaves + ' 葉（整數點上全對）；exact 模式 ' + RC.stats(te).leaves + ' 葉');
    const f3 = RL.floorDivNet(3, 20); note('floor(x/3)，N=20：' + f3.gates + ' 閘；exact 模式 ' + RC.stats(RC.compile(f3, null)).leaves + ' 葉（沒剪枝：2^閘數 的量級）、domain 模式 ' + RC.stats(RC.compile(f3, RC.boxPoints([[0, 19]]))).leaves + ' 葉');
}
// 區域數 vs 神經元數
{
    const rows = []; let boundOk = true;
    for (let k = 1; k <= 8; k++) { let mx = 0; for (let t = 0; t < 6; t++) { const n = new RL.Net(2); const hs = Array.from({ length: k }, () => n.relu(n.lin([[0, ri(-3, 3) || 1], [1, ri(-3, 3) || 1]], ri(-4, 4)))); n.out = [n.lin(hs.map((h) => [h, 1]))]; const L = RC.stats(RC.compile(n, RC.boxPoints([[-8, 8], [-8, 8]]))).leaves; mx = Math.max(mx, L); if (L > 1 + k + k * (k - 1) / 2) boundOk = false; } rows.push(k + ':' + mx); }
    check('區域數：2 維輸入、單隱藏層 k 個神經元，葉子數 ≤ 1+k+C(k,2)（平面上 k 條線最多切出的區域數；每個 k 隨機 6 個網路）', boundOk); note('2 維、k 個神經元（隨機網路中最大的葉子數）：' + rows.join('、'));
    const dims = []; let dimOk = true; for (let d = 1; d <= 5; d++) { const k = 5; const n = new RL.Net(d); const hs = Array.from({ length: k }, () => n.relu(n.lin(Array.from({ length: d }, (_, i) => [i, ri(-2, 2) || 1]), ri(-3, 3)))); n.out = [n.lin(hs.map((h) => [h, 1]))]; const L = RC.stats(RC.compile(n, RC.boxPoints(Array.from({ length: d }, () => [-3, 3])))).leaves; let bound = 0, c = 1; for (let i = 0; i <= Math.min(d, k); i++) { bound += c; c = c * (k - i) / (i + 1); } if (L > bound) dimOk = false; dims.push('d=' + d + ':' + L + '（上界 ' + bound + '）'); }
    check('區域數：k=5 個神經元、輸入維度 d=1..5，葉子數 ≤ Σ_{i≤d} C(5,i)', dimOk); note('k=5：' + dims.join('、'));
    const srt = []; let sOk = true; for (let n = 2; n <= 6; n++) { const net = RL.sortNet(n); const pts = RC.boxPoints(Array.from({ length: n }, () => [0, n - 1])); const t = RC.compile(net, pts); const st = RC.stats(t); if (!pts.every((p) => same(RC.evalTree(t, p), p.slice().sort((a, b) => a - b)))) sOk = false; srt.push('n=' + n + '：' + net.gates + ' 閘→' + st.leaves + ' 葉'); }
    check('排序網路（n=2..6，域 [0,n−1]^n 窮舉）：樹＝sort', sOk); note(srt.join('、') + '（葉子數增長遠快於閘數：n! 的排列）');
    const mo = [10, 100, 1000].map((N) => { const net = RL.modNet(3, N); const pts = RC.boxPoints([[0, N - 1]]); const t = RC.compile(net, pts); return { N, gates: net.gates, leaves: RC.stats(t).leaves, ok: pts.every((p) => RC.evalTree(t, p)[0] === p[0] % 3) }; });
    check('「驗證通過但編譯出的樹很大」：x mod 3（N=10,100,1000）樹＝x%3 窮舉成立，葉子數隨 N 線性成長', mo.every((r) => r.ok) && mo[2].leaves > 300, mo); note('x mod 3：' + mo.map((r) => 'N=' + r.N + '：' + r.gates + ' 閘→' + r.leaves + ' 葉').join('、') + '；原生寫法是一個 `x % 3`（1 個矩陣、0 個分支）');
}
// 域外會錯、編譯忠實保留錯誤
{
    const net = iteNet(3); const bad1 = RC.boxPoints([[0, 5], [0, 5], [0, 5], [0, 5]]).find((p) => !same(net.eval(p), iteSpec(p)));   // 第一個域外的反例（a 或 b 超過 B=3）
    const specV = iteSpec(bad1), netV = net.eval(bad1); const t = RC.compile(net, RC.boxPoints([[0, 3], [0, 3], [0, 3], [0, 3]])); const te = RC.compile(net, null);
    check('域外：ite 網路在 ' + JSON.stringify(bad1) + '（超出宣告域 [0,3]）給 ' + netV[0] + '，規格要 ' + specV[0] + '；exact 樹與網路相同（編譯忠實保留錯誤），不是「驗證通過就對」', netV[0] !== specV[0] && same(RC.evalTree(te, bad1), netV), { specV, netV });
    check('域外：domain 模式的樹在域外與網路不同（區域被剪掉，行為未定義）——適用範圍要隨樹一起宣告', (() => { const o = [9, 9, 9, 9]; return !same(RC.evalTree(t, [5, 0, 3, 1]), net.eval([5, 0, 3, 1])) || !same(RC.evalTree(t, [-3, 4, 2, 2]), net.eval([-3, 4, 2, 2])) || !same(RC.evalTree(t, o), net.eval(o)); })());
    const fl = RL.maxNet(true), f1 = fl.eval([0.1 + 0.2, 0.3]); check('浮點：0.1+0.2 與 0.3 的 max 結果在分支上依賴誤差（0.30000000000000004>0.3）→ 要用整數／有理數語意', f1[0] === 0.1 + 0.2 && 0.1 + 0.2 > 0.3);
}
// 命題：有網路＝規格（驗證）＋編譯＝網路（等價） ⇒ CoLU 節點＝規格；缺任一個就不成立 — 用「網路不等於規格」的反例檢查驗證器真的會擋
{
    const net = iteNet(3), pts = RC.boxPoints([[0, 5], [0, 5], [0, 5], [0, 5]]); const failing = pts.filter((p) => !same(net.eval(p), iteSpec(p)));
    check('驗證器會擋：把域放寬到 [0,5]（超過 B=3）窮舉就找得到反例', failing.length > 0, failing.length); note('B=3 的 ite 網路在 [0,5]^4 共 ' + pts.length + ' 點中有 ' + failing.length + ' 點不符規格（編譯不會幫你發現）');
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
