'use strict';
// 領域包「平行運算：迴圈排程原語」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const PK = require('./domain_par_core.js');
const np = (b, withK) => { const n = rnd(1, b ? 40 : 12), p = rnd(2, 5); return n + ' ' + p + (withK ? ' ' + rnd(1, 4) : '') + '\n'; };
const costs = (b, withK, tail) => { const n = rnd(1, b ? 40 : 12), p = rnd(2, 5); const c = Array.from({ length: n }, (_, i) => tail ? (i >= n - 2 ? rnd(30, 60) : rnd(1, 3)) : rnd(1, 20)); return n + ' ' + p + (withK ? ' ' + rnd(1, 4) : '') + '\n' + c.join(' ') + '\n'; };
const OWN = { block: 'i // (q + 1) if i < r * (q + 1) else r + (i - r * (q + 1)) // q', cyc: 'i % p', ck: '(i // k) % p' };
const ASG = (kind, k) => 'v = input().split()\nn = int(v[0])\np = int(v[1])\n' + (k ? 'k = int(v[2])\n' : '') + 'q, r = divmod(n, p)\na = [[] for _ in range(p)]\nfor i in range(n):\n    a[' + OWN[kind] + '].append(i)\nfor x in a:\n    print(*x)\n';
const LOAD = (kind, k, out) => 'v = input().split()\nn = int(v[0])\np = int(v[1])\n' + (k ? 'k = int(v[2])\n' : '') + 'c = list(map(int, input().split()))\nq, r = divmod(n, p)\nl = [0] * p\nfor i in range(n):\n    l[' + OWN[kind] + '] += c[i]\n' + out + '\n';
const DYN = (guided, out) => 'v = input().split()\nn = int(v[0])\np = int(v[1])\nk = int(v[2])\nc = list(map(int, input().split()))\nf = [0] * p\na = [[] for _ in range(p)]\ns = 0\nm = 0\nwhile s < n:\n    z = max(k, -(-(n - s) // p)) if ' + (guided ? 'True' : 'False') + ' else k\n    e = min(n, s + z)\n    t = min(range(p), key=lambda j: (f[j], j))\n    for i in range(s, e):\n        a[t].append(i)\n        f[t] += c[i]\n    m += 1\n    s = e\n' + out + '\n';
const PICK = (kinds, last, out) => 'v = input().split()\nn = int(v[0])\np = int(v[1])\nc = list(map(int, input().split()))\ndef sp(kd):\n    f = [0] * p\n    if kd == "static":\n        q, r = divmod(n, p)\n        s = 0\n        for t in range(p):\n            z = q + (t < r)\n            f[t] = sum(c[s:s + z])\n            s += z\n    elif kd == "cyclic":\n        for i in range(n):\n            f[i % p] += c[i]\n    else:\n        s = 0\n        while s < n:\n            z = 1 if kd == "dynamic" else max(1, -(-(n - s) // p))\n            e = min(n, s + z)\n            t = f.index(min(f))\n            f[t] += sum(c[s:e])\n            s = e\n    return max(f)\nbest = None\nfor kd in ' + JSON.stringify(kinds) + ':\n    if best is None or sp(kd) ' + (last ? '<=' : '<') + ' sp(best):\n        best = kd\n' + out + '\n';
const rw = (s) => s.replace(/\bn\b/g, 'm');
const ALL4 = ['static', 'cyclic', 'dynamic', 'guided'], NG = ['static', 'cyclic', 'dynamic'];
const SEEDS = [
    { id: 'asg-block', want: 'par.sched-assign', st: '第一行 n p：有 n 個迭代（編號從 0 到 n-1）要分給 p 個執行緒。使用靜態區塊排程（schedule(static)）：把編號連續切成 p 塊，n 除不盡時前面的執行緒各多拿一個。輸出每個執行緒分到的索引，每個執行緒一行，索引以空白隔開。', rw, ref: ASG('block'), gen: (b) => np(b) },
    { id: 'asg-cyclic', want: 'par.sched-assign', st: '第一行 n p：有 n 個迭代（編號從 0 起）分給 p 個執行緒。使用循環排程（schedule(static,1)）：迭代 i 由執行緒 i mod p 執行。輸出每個執行緒分到的索引，每個執行緒一行，索引以空白隔開。', rw, ref: ASG('cyc'), gen: (b) => np(b) },
    { id: 'asg-chunk', want: 'par.sched-assign', st: '第一行 n p k：有 n 個迭代（編號從 0 起）分給 p 個執行緒。使用分塊循環排程（schedule(static,k)）：每 k 個連續迭代為一塊，第 j 塊由執行緒 j mod p 執行。輸出每個執行緒分到的索引，每個執行緒一行，索引以空白隔開。', rw, ref: ASG('ck', true), gen: (b) => np(b, true) },
    { id: 'load-span', want: 'par.sched-load', st: '第一行 n p，第二行 n 個迭代各自的工作量。用靜態區塊排程（連續切成 p 塊，除不盡時前面的執行緒多拿一個）分給 p 個執行緒。輸出最忙的那個執行緒的負載（span）。', rw, ref: LOAD('block', false, 'print(max(l))'), gen: (b) => costs(b) },
    { id: 'load-cyc-speed', want: 'par.sched-load', st: '第一行 n p，第二行 n 個迭代的工作量。用循環排程（迭代 i 給執行緒 i mod p），輸出理論加速比＝總工作量／最忙執行緒的負載，取小數點後三位。', rw, ref: LOAD('cyc', false, 'print("%.3f" % (sum(l) / max(l)))'), gen: (b) => costs(b) },
    { id: 'load-cyc-loads', want: 'par.sched-load', st: '第一行 n p，第二行 n 個迭代的工作量。用循環排程把迭代 i 分給執行緒 i mod p，輸出每個執行緒的負載，依執行緒編號以空白隔開。', rw, ref: LOAD('cyc', false, 'print(*l)'), gen: (b) => costs(b) },
    { id: 'load-imb', want: 'par.sched-load', st: '第一行 n p k，第二行 n 個迭代的工作量。用分塊循環排程（schedule(static,k)，每 k 個連續迭代一塊，第 j 塊給執行緒 j mod p）。輸出負載不均衡度＝最忙負載乘 p 除以總工作量再減一，取小數點後三位。', rw, ref: LOAD('ck', true, 'print("%.3f" % (max(l) * p / sum(l) - 1))'), gen: (b) => costs(b, true) },
    { id: 'dyn-makespan', want: 'par.sched-dynamic', st: '第一行 n p k，第二行 n 個迭代的工作量。動態排程（schedule(dynamic,k)）：迭代依編號每 k 個一塊，最早閒下來的執行緒（同時閒取編號最小）領下一塊。輸出全部完成的時間（最忙執行緒的總工作量）。', rw, ref: DYN(false, 'print(max(f))'), gen: (b) => costs(b, true) },
    { id: 'guided-assign', want: 'par.sched-dynamic', st: '第一行 n p k，第二行 n 個迭代的工作量。引導式排程（schedule(guided,k)）：每次領取的塊大小是 max(k, ceil(剩餘迭代數/p))，最早閒下來的執行緒（同時閒取編號最小）領下一塊。輸出每個執行緒領到的索引，每個執行緒一行。', rw, ref: DYN(true, 'for x in a:\n    print(*x)'), gen: (b) => costs(b, true) },
    { id: 'pick-name', want: 'par.sched-pick', st: '第一行 n p，第二行 n 個迭代的工作量。比較 static、cyclic、dynamic（每塊 1 個）、guided（最小塊 1）四種排程，推薦最忙執行緒負載最小的排程；平手時取列表中較前面的。輸出推薦的排程名稱。', rw, ref: PICK(ALL4, false, 'print(best)'), gen: (b) => costs(b, false, true) },
    { id: 'pick-span', want: 'par.sched-pick', st: '第一行 n p，第二行 n 個迭代的工作量。比較 static、cyclic、dynamic（每塊 1 個）三種排程，推薦最忙執行緒負載最小的排程。輸出該排程的最大負載。', rw, ref: PICK(NG, false, 'print(sp(best))'), gen: (b) => costs(b) },
    { id: 'load-busy', want: 'par.sched-load', st: '第一行 n p，第二行 n 個迭代的耗時。用循環排程（迭代 i 給執行緒 i mod p），輸出各執行緒的總耗時，以空白隔開，依執行緒編號。', rw, ref: LOAD('cyc', false, 'print(*l)'), gen: (b) => costs(b) },
    { id: 'dyn-chunks', want: 'par.sched-dynamic', st: '第一行 n p k，第二行 n 個迭代的耗時。dynamic 排程每次領 k 個連續迭代，誰先做完誰領下一塊。輸出總共領取了幾塊。', rw, ref: DYN(false, 'print(m)'), gen: (b) => costs(b, true) },
    { id: 'ho-asg-block', split: 'holdout', st: '第一行 n p。n 個迴圈迭代（0 到 n-1）交給 p 個執行緒，OpenMP 的 static 排程不指定區塊大小：每個執行緒得到連續一段，前 n%p 個執行緒比其他多一個迭代。每個執行緒輸出一行它負責的迭代編號。', ref: ASG('block'), gen: (b) => np(b) },
    { id: 'ho-asg-cyc', split: 'holdout', st: '第一行 n p。n 個迭代編號 0 到 n-1，p 個執行緒輪流領取，一次一個（round-robin，等同 schedule(static,1)）。每個執行緒一行，列出它做的迭代編號。', ref: ASG('cyc'), gen: (b) => np(b) },
    { id: 'ho-load-block', split: 'holdout', st: '第一行 n p，第二行是 n 個迭代的耗時。靜態區塊排程把迭代切成 p 段連續區間（前 n%p 段多一個）。輸出各執行緒的總耗時，以空白隔開，依執行緒編號。', ref: LOAD('block', false, 'print(*l)'), gen: (b) => costs(b) },
    { id: 'ho-dyn-chunks', split: 'holdout', st: '第一行 n p k，第二行 n 個迭代的耗時。dynamic 排程每次領 k 個連續迭代，誰先做完誰領下一塊（同時完成取編號小的執行緒）。輸出總共被領取了幾塊。', ref: DYN(false, 'print(m)'), gen: (b) => costs(b, true) },
    { id: 'ho-pick-tail', split: 'holdout', st: '第一行 n p，第二行 n 個迭代的耗時（尾端的迭代特別重）。請在 static（區塊）、cyclic（循環）、dynamic（塊大小 1）、guided（最小塊 1）之間挑出最佳排程：最忙執行緒的負載最小者，平手選較前面的。輸出該排程名稱。', ref: PICK(ALL4, false, 'print(best)'), gen: (b) => costs(b, false, true) },
];
H.main({ name: '領域包 par', packs: [PK], seeds: SEEDS, minSkeletons: 4 });
