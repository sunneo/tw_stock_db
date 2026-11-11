'use strict';
// G7 增量動態霍夫曼 FGK（matrix_fgk_core）：① 每一步檢查不變量（兄弟性質、父子權重和、位置序）且往返一致；② 獨立 Python 參照（以物件樹實作同一演算法，資料結構與 JS 不同）產生的位元串逐位元相同；③ 成本與「每符號後重建」的版本比較（迴歸界線）。
const assert = require('assert'), cp = require('child_process');
const F = require('./matrix_fgk_core.js'), A = require('./matrix_adaptive_huffman_core.js');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 77; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 65536) % n; };
const skewed = (n) => { const r = rnd(100); return r < 60 ? 0 : r < 85 ? 1 + rnd(Math.min(3, n - 1)) : rnd(n); };

const seqs = [];
for (let t = 0; t < 120; t++) {
    const n = 2 + rnd(30); const len = 1 + rnd(t < 100 ? 200 : 1500);
    seqs.push({ n, s: Array.from({ length: len }, () => (t % 3 === 0 ? rnd(n) : skewed(n))) });
}

// ① 不變量＋往返（每一步都檢查）
let bad = 0;
for (const q of seqs) {
    const bits = F.encode(q.n, q.s, { check: true });
    const dec = F.decode(q.n, bits, q.s.length, { check: true });
    if (JSON.stringify(dec.symbols) !== JSON.stringify(q.s) || dec.consumed !== bits.length) bad++;
}
ok(bad === 0, '往返失敗 ' + bad + ' 組');
console.log('① 120 組隨機序列（最長 1500，字母表 2～31）每一步檢查不變量，往返一致');

// ② 獨立 Python 參照：逐位元比對
const PYREF = `
import sys, json
def run(n, syms):
    W = max(1, (n - 1).bit_length())
    class N:
        def __init__(s, w, p, sym):
            s.w = w; s.p = p; s.kids = []; s.sym = sym
    root = N(0, None, -2)
    order = [root]; st = {'nyt': root, 'root': root}
    leaf = {}; out = []
    def path(v):
        bits = []
        while v.p is not None:
            bits.append(0 if v.p.kids[0] is v else 1)
            v = v.p
        return bits[::-1]
    def ancestor(a, v):
        u = v.p
        while u is not None:
            if u is a:
                return True
            u = u.p
        return False
    def swap(a, b):
        ia = next(i for i, x in enumerate(order) if x is a)
        ib = next(i for i, x in enumerate(order) if x is b)
        order[ia], order[ib] = b, a
        pa, pb = a.p, b.p
        if pa is pb:
            pa.kids.reverse()
            return
        pa.kids[0 if pa.kids[0] is a else 1] = b
        pb.kids[0 if pb.kids[0] is b else 1] = a
        a.p, b.p = pb, pa
    def update(v):
        while v is not None:
            lead = None
            for x in reversed(order):
                if x.w == v.w:
                    lead = x
                    break
            if lead is not v and not ancestor(lead, v):
                swap(v, lead)
            v.w += 1
            v = v.p
    def addnew(s):
        old = st['nyt']; p = old.p
        q = N(1, p, -1); newnyt = N(0, q, -2); lf = N(1, q, s)
        q.kids = [newnyt, lf]
        if p is not None:
            p.kids[0 if p.kids[0] is old else 1] = q
        idx = next(i for i, x in enumerate(order) if x is old)
        order[idx:idx + 1] = [newnyt, lf, q]
        leaf[s] = lf; st['nyt'] = newnyt
        if p is not None:
            update(p)
    seen = set()
    for s in syms:
        if s not in seen:
            out += path(st['nyt']) + [(s >> i) & 1 for i in range(W - 1, -1, -1)]
            addnew(s); seen.add(s)
        else:
            out += path(leaf[s]); update(leaf[s])
    return ''.join(map(str, out))
req = json.loads(sys.stdin.read())
print(json.dumps([run(n, s) for n, s in req]))
`;
const r = cp.spawnSync(PY, ['-I', '-c', PYREF], { input: JSON.stringify(seqs.map((q) => [q.n, q.s])), encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
assert.strictEqual(r.status, 0, r.stderr);
const pyBits = JSON.parse(r.stdout);
let same = 0;
seqs.forEach((q, i) => { const js = F.encode(q.n, q.s).join(''); if (js === pyBits[i]) same++; else console.log('不一致：第 ' + i + ' 組'); });
ok(same === seqs.length, 'Python 參照逐位元一致 ' + same + '/' + seqs.length);
console.log('② 獨立 Python 參照（物件樹）產生的位元串與 JS 逐位元相同：' + same + '/' + seqs.length + ' 組');

// ③ 成本：與每符號後重建的版本比較。界線是迴歸界線（不是規格）：偏態資料 ≤105%，均勻隨機 ≤115%。
//    FGK 對均勻隨機明顯較差（增量樹的形狀不如整張重建的表），這是實測結果，不是 bug；見接手節。
const cost = { uni: [0, 0], skew: [0, 0] };
seqs.forEach((q, i) => { const k = i % 3 === 0 ? 'uni' : 'skew'; cost[k][0] += F.encode(q.n, q.s).length; cost[k][1] += A.encode(q.n, q.s).length; });
ok(cost.skew[0] <= cost.skew[1] * 1.05, '偏態 FGK 成本過高');
ok(cost.uni[0] <= cost.uni[1] * 1.15, '均勻 FGK 成本過高');
console.log('③ 成本（FGK／重建）：偏態 ' + cost.skew[0] + '／' + cost.skew[1] + '＝' + (cost.skew[0] / cost.skew[1]).toFixed(4) + '；均勻 ' + cost.uni[0] + '／' + cost.uni[1] + '＝' + (cost.uni[0] / cost.uni[1]).toFixed(4));

// ④ 偏態資料要真的比定長編碼省
const skew = Array.from({ length: 3000 }, () => skewed(16));
const sb = F.encode(16, skew).length;
ok(sb < 3000 * 4, '偏態資料未壓縮：' + sb);
console.log('④ 偏態 3000 符號（字母表 16，定長 12000 位元）FGK 用 ' + sb + ' 位元');

// ⑤ 錯誤輸入要報錯
assert.throws(() => F.decode(4, [], 1), /提早結束/); passed++;
console.log('⑤ 串流提早結束會報錯');

console.log(passed + ' passed, 0 failed');
