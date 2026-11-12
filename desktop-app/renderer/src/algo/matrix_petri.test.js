'use strict';
// G9 Petri 網（matrix_petri_core）：① 隨機小網的可達標記數、死結數、各庫所最大權杖數與獨立 Python BFS 一致；② 狀態方程 M0 + C·x 與實際發火序列的結果一致；③ 已知網：互斥鎖、生產者－消費者、兩行程互搶兩把鎖的死結。
const assert = require('assert'), cp = require('child_process');
const N = require('./matrix_petri_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 2024; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const LIMIT = 3000;

// ① 獨立 Python BFS 參照
const PYREF = `
import sys, json
from collections import deque
req = json.loads(sys.stdin.read()); out = []
for q in req:
    pre, post, M0, lim = q['pre'], q['post'], tuple(q['M0']), q['limit']
    T, P = len(pre), len(M0)
    seen = {M0}; dq = deque([M0]); dead = 0; mx = [0]*P; trunc = False
    while dq:
        M = dq.popleft()
        for p in range(P): mx[p] = max(mx[p], M[p])
        any_ = False
        for t in range(T):
            if all(M[p] >= pre[t][p] for p in range(P)):
                any_ = True
                N = tuple(M[p] - pre[t][p] + post[t][p] for p in range(P))
                if N not in seen:
                    if len(seen) >= lim: trunc = True; continue
                    seen.add(N); dq.append(N)
        if not any_: dead += 1
    out.append({'reachable': len(seen), 'deadlocks': dead, 'maxTokens': mx, 'truncated': trunc})
print(json.dumps(out))
`;
const nets = [];
for (let t = 0; t < 150; t++) {
    const P = 2 + rnd(3), T = 2 + rnd(3);
    const pre = Array.from({ length: T }, () => Array.from({ length: P }, () => (rnd(3) === 0 ? 1 + rnd(2) : 0)));
    const post = Array.from({ length: T }, () => Array.from({ length: P }, () => (rnd(3) === 0 ? 1 + rnd(2) : 0)));
    const M0 = Array.from({ length: P }, () => rnd(3));
    nets.push({ pre, post, M0 });
}
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(nets.map((n) => ({ ...n, limit: LIMIT }))), encoding: 'utf8', timeout: 300000 });
assert.strictEqual(r.status, 0, r.stderr);
const ref = JSON.parse(r.stdout); let cmp = 0, trunc = 0;
nets.forEach((n, i) => {
    const js = N.reach({ pre: n.pre, post: n.post }, n.M0, LIMIT); const py = ref[i];
    if (py.truncated) { trunc++; return; }
    cmp++;
    assert.strictEqual(js.reachable, py.reachable, '第 ' + i + ' 網可達數'); assert.strictEqual(js.deadlocks, py.deadlocks, '第 ' + i + ' 網死結數');
    assert.deepStrictEqual(js.maxTokens, py.maxTokens, '第 ' + i + ' 網最大權杖');
});
ok(cmp >= 60, '未被截斷的網數 ' + cmp);
console.log('① 150 個隨機網（' + cmp + ' 個未截斷）的可達數、死結數、最大權杖與 Python BFS 一致；截斷 ' + trunc + ' 個未比對');

// ② 狀態方程：隨機發火序列
for (let t = 0; t < 200; t++) {
    const n = nets[t % nets.length]; const net = { pre: n.pre, post: n.post }; let M = n.M0.slice(); const x = new Array(n.pre.length).fill(0);
    for (let s = 0; s < 30; s++) { const ts = rnd(n.pre.length); const next = N.fire(net, M, ts); if (next) { M = next; x[ts]++; } }
    assert.deepStrictEqual(N.stateEquation(net, n.M0, x), M, '狀態方程第 ' + t);
    passed++;
}
console.log('② 200 段隨機發火序列：M0 + C·x 與實際標記一致');

// ③ 已知網（places 與 transitions 的順序寫在註解裡，用獨立 BFS 收集所有可達標記）
function allMarkings(net, M0) { const seen = new Set([M0.join(',')]); const q = [M0.slice()]; const out = []; for (let h = 0; h < q.length; h++) { const M = q[h]; out.push(M); for (let t = 0; t < net.pre.length; t++) { const Nm = N.fire(net, M, t); if (Nm && !seen.has(Nm.join(','))) { seen.add(Nm.join(',')); q.push(Nm); } } } return out; }
// 互斥鎖：0 閒置A、1 臨界A、2 鎖、3 閒置B、4 臨界B；t0 進A(0+2→1)、t1 出A(1→0+2)、t2 進B(3+2→4)、t3 出B(4→3+2)
const mtx = { pre: [[1, 0, 1, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 1, 0], [0, 0, 0, 0, 1]], post: [[0, 1, 0, 0, 0], [1, 0, 1, 0, 0], [0, 0, 0, 0, 1], [0, 0, 1, 1, 0]] };
const mM = allMarkings(mtx, [1, 0, 1, 1, 0]);
ok(mM.every((M) => M[1] + M[4] <= 1 && M[2] + M[1] + M[4] === 1), '互斥鎖：任何可達標記都不會兩人同時在臨界區，且鎖恆為 1（不變量）');
ok(N.reach(mtx, [1, 0, 1, 1, 0], 1000).deadlocks === 0, '互斥鎖：無死結');
// 兩行程互搶兩把鎖（P1 先 A 後 B；P2 先 B 後 A）→ 必有循環等待的死結
// 庫所：0 P1 待辦、1 P1 持 A、2 P1 持 A 與 B、3 P2 待辦、4 P2 持 B、5 P2 持 B 與 A、6 鎖 A 空、7 鎖 B 空
// t0 P1 取 A(0+6→1)、t1 P1 取 B(1+7→2)、t2 P2 取 B(3+7→4)、t3 P2 取 A(4+6→5)
const dl = { pre: [[1, 0, 0, 0, 0, 0, 1, 0], [0, 1, 0, 0, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 0, 1, 0, 1, 0]],
    post: [[0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 0, 1, 0, 0]] };
const dlR = N.reach(dl, [1, 0, 0, 1, 0, 0, 1, 1], 1000);
ok(dlR.deadlockMarkings.some((M) => M[1] === 1 && M[4] === 1 && M[6] === 0 && M[7] === 0), '兩行程互搶鎖：標記 P1 持 A、P2 持 B 是死結（循環等待）');
console.log('③ 互斥鎖（無死結、鎖恆為 1）與互搶鎖的死結（回報 ' + dlR.deadlocks + ' 個死結標記）符合預期');
// 生產者－消費者，緩衝容量 2：0 空格、1 已放入、2 生產者待辦、3 消費者待辦；t0 放入(0+2→1+2)、t1 取出(1+3→0+3)
const pc = { pre: [[1, 0, 1, 0], [0, 1, 0, 1]], post: [[0, 1, 1, 0], [1, 0, 0, 1]] };
const pcR = N.reach(pc, [2, 0, 1, 1], 1000);
ok(pcR.reachable === 3 && pcR.deadlocks === 0 && pcR.maxTokens[1] === 2, '生產者－消費者（容量 2）：可達 3 個標記、無死結、緩衝最多 2（實際 ' + pcR.reachable + '）');
console.log('   生產者－消費者（容量 2）：可達 ' + pcR.reachable + '、死結 ' + pcR.deadlocks + '、緩衝最多 ' + pcR.maxTokens[1]);
console.log(passed + ' passed, 0 failed');
